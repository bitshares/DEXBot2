'use strict';

import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import type { FileStat } from '../../modules/storage/types.js';
import { PATHS } from '../../modules/paths.js';
import { mergeCandles, higherVolumeWins } from '../candle_utils.js';
import { shardKeyFromName, shardStemFromName } from './month_shards.js';

const storage = getStorage();

interface FindLatestLpDataOptions {
    dataDir?: string;
}

/** A whole-history export (or one shard file) with its mtime. */
interface ScannedFile {
    path: string;
    mtime: number;
}

/** All shards of one `lp_pool_<id>_<interval>` family, across its months. */
interface ShardFamily {
    stem: string;
    files: ScannedFile[];
    maxMtime: number;
}

/**
 * Result of auto-discovering the newest LP series. `candles` is always the
 * complete series, whether it came from one whole-history export
 * (`assembled: false`) or was merged across month shards (`assembled: true`).
 */
interface LpSeriesResult {
    path: string;
    meta: Record<string, unknown> | null;
    candles: unknown[];
    assembled: boolean;
}

function isLpJsonName(name: string): boolean {
    return name.startsWith('lp_pool_') && name.endsWith('.json');
}

/**
 * All shard files for one base path (`<base>.shard_YYYY-MM.json`), read from
 * disk. Empty when the base is not a shard-addressed series.
 */
function readShardFamily(basePath: string): ScannedFile[] {
    const resolved = path.resolve(basePath);
    const parsed = path.parse(resolved);
    if (!storage.exists(parsed.dir)) return [];
    const out: ScannedFile[] = [];
    for (const name of storage.readdir(parsed.dir)) {
        if (!shardKeyFromName(name, parsed.name, parsed.ext)) continue;
        const full = path.join(parsed.dir, name);
        try {
            const info = storage.stat(full);
            if (info.isFile()) out.push({ path: full, mtime: info.mtimeMs });
        } catch (_) { /* unreadable sibling: skip it, keep the rest */ }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Merge an ordered shard family into one series. `sourcePath` is the file the
 * caller should report (the newest shard, or the explicitly requested one).
 */
function assembleLpShards(files: ScannedFile[], sourcePath: string): LpSeriesResult | null {
    let merged: number[][] = [];
    let meta: Record<string, unknown> | null = null;
    for (const file of files) {
        const raw = storage.readJSON(file.path);
        if (!meta) meta = metaOf(raw);
        merged = mergeCandles(merged, rawCandlesOf(raw), { onCollision: higherVolumeWins }) as number[][];
    }
    if (merged.length === 0) return null;

    const firstTs = Number(merged[0][0]);
    const lastTs = Number(merged[merged.length - 1][0]);
    // A shard's meta describes one month; publish the assembled extent instead
    // and drop per-shard bookkeeping that would misrepresent a whole series.
    const mergedMeta: Record<string, unknown> = {
        ...(meta || {}),
        candleCount: merged.length,
        firstTs: new Date(firstTs).toISOString(),
        lastTs: new Date(lastTs).toISOString(),
        timeRange: { gte: new Date(firstTs).toISOString(), lte: new Date(lastTs).toISOString() },
        assembledFrom: 'month-shards',
    };
    delete mergedMeta.shard;
    delete mergedMeta.queriedRanges;
    return { path: sourcePath, meta: mergedMeta, candles: merged, assembled: true };
}

/**
 * Scan the LP data dir for whole-history exports and month-shard families.
 *
 * The on-disk layout is fixed at two levels (`<dataDir>/<pair>/<file>`), so the
 * scan is deliberately NOT recursive: it stats each direct child once and only
 * descends one level into pair folders. Legacy run-relative `.chunk_*` files
 * are ignored — nothing reads them and they are not a series.
 */
function scanLpDataDir(dataDir: string): { whole: ScannedFile[]; shardFamilies: Map<string, ShardFamily> } {
    const whole: ScannedFile[] = [];
    const shardFamilies = new Map<string, ShardFamily>();
    if (!storage.exists(dataDir)) return { whole, shardFamilies };

    const consider = (full: string, stat?: FileStat): void => {
        const name = path.basename(full);
        if (!isLpJsonName(name) || name.includes('.chunk_')) return;
        let info = stat;
        if (!info) {
            try { info = storage.stat(full); } catch (_) { return; }
        }
        if (!info.isFile()) return;
        const stem = shardStemFromName(name, path.extname(name));
        if (!stem) {
            whole.push({ path: full, mtime: info.mtimeMs });
            return;
        }
        const key = path.join(path.dirname(full), stem);
        let family = shardFamilies.get(key);
        if (!family) {
            family = { stem, files: [], maxMtime: 0 };
            shardFamilies.set(key, family);
        }
        family.files.push({ path: full, mtime: info.mtimeMs });
        if (info.mtimeMs > family.maxMtime) family.maxMtime = info.mtimeMs;
    };

    for (const name of storage.readdir(dataDir)) {
        const full = path.join(dataDir, name);
        let stat: FileStat | null = null;
        try { stat = storage.stat(full); } catch (_) { continue; }
        if (stat.isDirectory()) {
            let names: string[] = [];
            try { names = storage.readdir(full); } catch (_) { continue; }
            for (const inner of names) consider(path.join(full, inner));
        } else if (stat.isFile()) {
            consider(full, stat);
        }
    }
    return { whole, shardFamilies };
}

function newestOf(files: ScannedFile[]): ScannedFile | null {
    let best: ScannedFile | null = null;
    for (const f of files) if (!best || f.mtime > best.mtime) best = f;
    return best;
}

function newestFamily(families: Map<string, ShardFamily>): ShardFamily | null {
    let best: ShardFamily | null = null;
    for (const fam of families.values()) if (!best || fam.maxMtime > best.maxMtime) best = fam;
    return best;
}

function rawCandlesOf(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    const r = raw as { candles?: unknown; data?: unknown } | null;
    if (r && Array.isArray(r.candles)) return r.candles as unknown[];
    if (r && Array.isArray(r.data)) return r.data as unknown[];
    return [];
}

function metaOf(raw: unknown): Record<string, unknown> | null {
    if (Array.isArray(raw)) return null;
    const meta = (raw as { meta?: unknown } | null)?.meta;
    return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
}

/**
 * Whole-history-export discovery only: returns the newest `lp_pool_*.json` that
 * is a complete series, or null. Month shards and legacy `.chunk_*` files are
 * excluded — a single shard is a slice, and (because the active shard is
 * rewritten every run) by mtime it would otherwise always win. Use
 * `loadLatestLpSeries` when a shard-only cache should still yield a series.
 */
function findLatestLpData(options: FindLatestLpDataOptions = {}): string | null {
    const dataDir = options.dataDir ? path.resolve(options.dataDir) : PATHS.MARKET_ADAPTER.LP_DATA_DIR;
    const { whole } = scanLpDataDir(dataDir);
    return newestOf(whole)?.path ?? null;
}

/**
 * Auto-discover and load the newest LP series.
 *
 * Month shards are the cache and a whole-history export is a derived snapshot
 * of the same shard family (both writers, `fetch_lp_data` and
 * `fetch_lp_candles`, regenerate the export from the assembled shards after
 * fetching). The two therefore agree in extent, and the ordinary mtime race
 * decides — an export produced by an external tool can still be newer and win.
 * A shard-only directory is assembled; an export-only directory is read as-is.
 */
function loadLatestLpSeries(options: FindLatestLpDataOptions = {}): LpSeriesResult | null {
    const dataDir = options.dataDir ? path.resolve(options.dataDir) : PATHS.MARKET_ADAPTER.LP_DATA_DIR;
    const { whole, shardFamilies } = scanLpDataDir(dataDir);
    const newestWhole = newestOf(whole);
    const family = newestFamily(shardFamilies);

    // Whole-history export wins ties/races; only a strictly newer shard family
    // forces the merge path.
    if (newestWhole && (!family || newestWhole.mtime >= family.maxMtime)) {
        const raw = storage.readJSON(newestWhole.path);
        const candles = rawCandlesOf(raw);
        if (candles.length === 0) return null;
        return { path: newestWhole.path, meta: metaOf(raw), candles, assembled: false };
    }
    if (!family) return null;

    const ordered = [...family.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    return assembleLpShards(ordered, ordered[ordered.length - 1].path);
}

/**
 * Assemble the whole series for a base path directly from its month shards,
 * regardless of any sibling whole-history export. Writers use this to derive
 * the export from the cache, so the monolithic file can never become a
 * narrower or staler snapshot than the shards beside it.
 */
function loadLpSeriesFromBasePath(basePath: string): LpSeriesResult | null {
    const resolved = path.resolve(basePath);
    const family = readShardFamily(resolved);
    if (family.length === 0) return null;
    return assembleLpShards(family, family[family.length - 1].path);
}

/**
 * Load one explicit LP path. A month shard is transparently upgraded to its
 * whole family: pointing `--data` at `.shard_2026-10.json` charts the full
 * cached history, never a silent one-month slice. A whole-history export (or
 * a lone shard whose siblings are missing) is read as-is.
 */
function loadLpSeriesFromPath(filePath: string): LpSeriesResult | null {
    const resolved = path.resolve(filePath);
    const parsed = path.parse(resolved);
    const stem = shardStemFromName(parsed.base, parsed.ext);
    if (stem) {
        const family = readShardFamily(path.join(parsed.dir, `${stem}${parsed.ext}`));
        const assembled = assembleLpShards(family, resolved);
        if (assembled) return assembled;
    }

    const raw = storage.readJSON(resolved);
    const candles = rawCandlesOf(raw);
    if (candles.length === 0) return null;
    return { path: resolved, meta: metaOf(raw), candles, assembled: false };
}

export { findLatestLpData, loadLatestLpSeries, loadLpSeriesFromPath, loadLpSeriesFromBasePath }
export type { LpSeriesResult, FindLatestLpDataOptions }
