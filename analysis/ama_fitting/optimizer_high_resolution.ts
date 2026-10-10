'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { calculateAMA, getAmaWarmupBars } from '../../market_adapter/core/strategies/ama.js';
import { toIntervalLabel } from '../../market_adapter/interval_utils.js';
import { generateHTML } from '../../market_adapter/lp_chart_core.js';
import { PATHS } from '../../modules/paths.js';
import { ensureDir } from '../../modules/order/utils/system.js';
import { range, geometricRange } from '../math_utils.js';
import { getStorage } from '../../modules/storage/index.js';
import { normalizeAssetSymbol } from '../../modules/utils/asset_symbols.js';
const { readJSON, writeJSON } = getStorage();

import {
    loadLpDataFile,
} from '../../market_adapter/lp_chart_runner.js';

const AMA_PROFILES_FILE = PATHS.PROFILES.MARKET_PROFILES_JSON;

/**
 * AMA GEOMETRIC OPTIMIZER
 *
 * Finds AMA parameters (ER, Fast, Slow) using geometric metrics only.
 *
 * Objective flow:
 *   1. Compute a per-AMA max-distance cap from the max candle deviation percentile.
 *   2. Keep only candidates at or below that cap.
 *   3. Select the candidate with the lowest additive linear score.
 *
 * Distance to price is still tracked for reporting.
 * Winner selection uses an additive tradeoff between AMA movement and
 * AMA-to-price distance, so candidates must stay close enough while also
 * being smooth.
 *
 * Usage (build first, then run compiled JS):
 *   npm run build && node dist/analysis/ama_fitting/optimizer_high_resolution.js --data <path-to-lp-candles.json>
 *   node dist/analysis/ama_fitting/optimizer_high_resolution.js --data <path-to-lp-candles.json> --write-profiles
 *   node dist/analysis/ama_fitting/optimizer_high_resolution.js --data <path-to-lp-candles.json> --erMax 400 --fastMax 20 --slowMax 200
 *
 */

const DEFAULT_SEARCH = {
    er: { min: 500, max: 1000, count: 15, step: null, quantum: 1 },
    fast: { min: 2, max: 8, count: 30, step: null, quantum: 0.01 },
    slow: { min: 35, max: 140, count: 30, step: null, quantum: 0.1 },
};

// ── Default per-AMA distance weights ────────────────────────────────────────
// Each AMA has its own λ that controls the movement-vs-distance tradeoff.
// Override individually via --ama1Weight, --ama2Weight, etc. CLI flags.

const AMA_OBJECTIVES = [
    { key: 'AMA1', name: 'AMA1', distanceCapQuantile: 0.25, distanceWeight: 0.0031 },
    { key: 'AMA2', name: 'AMA2', distanceCapQuantile: 0.30, distanceWeight: 0.0025 },
    { key: 'AMA3', name: 'AMA3', distanceCapQuantile: 0.35, distanceWeight: 0.00185 },
    { key: 'AMA4', name: 'AMA4', distanceCapQuantile: 0.40, distanceWeight: 0.0013 },
];

function cloneObjectives() {
    return AMA_OBJECTIVES.map((o) => ({ ...o }));
}

// ── Parameter ranges ──────────────────────────────────────────────────────────
interface DataMeta {
    intervalSeconds?: unknown;
    pool?: unknown;
    fetchedAt?: unknown;
    assetA?: { symbol?: unknown; id?: unknown };
    assetB?: { symbol?: unknown; id?: unknown };
    [key: string]: unknown;
}

interface SearchCandle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    [key: string]: unknown;
}

interface AmaArea {
    maxDist: number;
    total: number;
    above: number;
    below: number;
    [key: string]: unknown;
}

interface SearchEntry {
    er: number;
    fast: number;
    slow: number;
    area: AmaArea;
    amaMovementTotal: number;
    distanceTotal: number;
    bandFactorPct: number;
    [key: string]: unknown;
}

interface WeightedEntry extends SearchEntry {
    weightedScore: number;
    normDistance: number | null;
    normMovement: number | null;
    key: string;
    label: string;
}

interface ProgressMsg {
    workerId: number;
    checked: number;
    total: number;
    elapsedSec: number;
}

interface ShardPayload {
    workerId: number;
    erShard: number[];
    fastValues: number[];
    slowValues: number[];
    candles: SearchCandle[];
    closes: number[];
}

interface SearchResult {
    workerId: number;
    entries: SearchEntry[];
    totalCombos: number;
    validCombos: number;
}

function buildDimension(cfg: Record<string, unknown>) {
    const min = Number(cfg.min);
    const max = Number(cfg.max);
    const step = Number(cfg.step);
    const count = Number(cfg.count);
    const quantum = Number(cfg.quantum);

    if (Number.isFinite(step) && step > 0) {
        const values = range(min, max, step, 2);
        return {
            values,
            meta: {
                mode: 'linear',
                min: values[0],
                max: values[values.length - 1],
                step,
                quantum: Number.isFinite(quantum) && quantum > 0 ? quantum : null,
                count: values.length,
                ratio: null,
            },
        };
    }

    const ratio = Math.pow(max / min, 1 / (count - 1));
    const values = geometricRange(min, max, count, {
        decimals: 6,
        quantum: Number.isFinite(quantum) && quantum > 0 ? quantum : null,
    });
    return {
        values,
        meta: {
            mode: 'geometric',
            min: values[0],
            max: values[values.length - 1],
            step: null,
            quantum: Number.isFinite(quantum) && quantum > 0 ? quantum : null,
            count: values.length,
            ratio,
        },
    };
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = Array.isArray(argv) ? argv : [];
    const out: {
        dataFile: string | null;
        er: { min: number | null; max: number | null; step: number | null; count: number | null };
        fast: { min: number | null; max: number | null; step: number | null; count: number | null };
        slow: { min: number | null; max: number | null; step: number | null; count: number | null };
        workers: number | null;
        writeProfiles: boolean;
        fixedEr: number | null;
        fixedFast: number | null;
        ama1Cap: number | null;
        ama2Cap: number | null;
        ama3Cap: number | null;
        ama4Cap: number | null;
        ama1Weight: number | null;
        ama2Weight: number | null;
        ama3Weight: number | null;
        ama4Weight: number | null;
    } = {
        dataFile: null,
        er: { ...DEFAULT_SEARCH.er },
        fast: { ...DEFAULT_SEARCH.fast },
        slow: { ...DEFAULT_SEARCH.slow },
        workers: null,
        writeProfiles: false,
        fixedEr: null,
        fixedFast: null,
        ama1Cap: null,
        ama2Cap: null,
        ama3Cap: null,
        ama4Cap: null,
        ama1Weight: null,
        ama2Weight: null,
        ama3Weight: null,
        ama4Weight: null,
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[i + 1];
        switch (a) {
            case '--data': out.dataFile = v || null; i++; break;
            case '--fixEr': {
                const n = Number(v);
                if (!Number.isFinite(n)) throw new Error(`--fixEr requires a finite number, got "${v}"`);
                out.fixedEr = n; i++; break;
            }
            case '--fixFast': {
                const n = Number(v);
                if (!Number.isFinite(n)) throw new Error(`--fixFast requires a finite number, got "${v}"`);
                out.fixedFast = n; i++; break;
            }
            case '--erMin': out.er.min = Number(v); i++; break;
            case '--erMax': out.er.max = Number(v); i++; break;
            case '--erStep': out.er.step = Number(v); i++; break;
            case '--erCount': out.er.count = Number(v); i++; break;
            case '--fastMin': out.fast.min = Number(v); i++; break;
            case '--fastMax': out.fast.max = Number(v); i++; break;
            case '--fastStep': out.fast.step = Number(v); i++; break;
            case '--fastCount': out.fast.count = Number(v); i++; break;
            case '--slowMin': out.slow.min = Number(v); i++; break;
            case '--slowMax': out.slow.max = Number(v); i++; break;
            case '--slowStep': out.slow.step = Number(v); i++; break;
            case '--slowCount': out.slow.count = Number(v); i++; break;
            case '--ama1Cap': out.ama1Cap = Number(v); i++; break;
            case '--ama2Cap': out.ama2Cap = Number(v); i++; break;
            case '--ama3Cap': out.ama3Cap = Number(v); i++; break;
            case '--ama4Cap': out.ama4Cap = Number(v); i++; break;
            case '--ama1Weight': out.ama1Weight = Number(v); i++; break;
            case '--ama2Weight': out.ama2Weight = Number(v); i++; break;
            case '--ama3Weight': out.ama3Weight = Number(v); i++; break;
            case '--ama4Weight': out.ama4Weight = Number(v); i++; break;
            case '--workers': out.workers = Number(v); i++; break;
            case '--write-profiles': out.writeProfiles = true; break;
        }
    }

    return out;
}

function percentile(values: number[], q: number): number | null {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const qq = Math.max(0, Math.min(1, q));
    const pos = (sorted.length - 1) * qq;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    const t = pos - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function getAmaObjectivesFromArgs(args: Record<string, unknown>) {
    const objectives = cloneObjectives();
    for (const o of objectives) {
        const id = o.key.toLowerCase();
        const cap = Number(args[`${id}Cap`]);
        if (Number.isFinite(cap)) o.distanceCapQuantile = cap;
        if (!Number.isFinite(o.distanceCapQuantile) || o.distanceCapQuantile <= 0 || o.distanceCapQuantile > 1) {
            throw new Error(`Invalid cap for ${o.key}: ${o.distanceCapQuantile}. Use 0 < cap <= 1`);
        }
        const w = Number(args[`${id}Weight`]);
        if (Number.isFinite(w)) {
            if (w <= 0) throw new Error(`${o.key} distanceWeight must be positive, got ${w}`);
            o.distanceWeight = w;
        }
    }
    return objectives;
}

function ensureValidRange(label: string, cfg: Record<string, unknown>) {
    const min = Number(cfg.min);
    const max = Number(cfg.max);
    const step = Number(cfg.step);
    const count = Number(cfg.count);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
        throw new Error(`Invalid ${label} range: min=${min}, max=${max}`);
    }
    if (Number.isFinite(step) && step > 0) return;
    if (!Number.isFinite(count) || count < 2) {
        throw new Error(`Invalid ${label} geometric sampling count: ${count}`);
    }
}

function boundaryFlags(winner: WeightedEntry | null, erValues: number[], fastValues: number[], slowValues: number[], fixedEr: number | null = null, fixedFast: number | null = null) {
    if (!winner) return { er: null, fast: null, slow: null, onBoundary: false };
    const eps = 1e-9;
    const minEr = erValues[0], maxEr = erValues[erValues.length - 1];
    const minFast = fastValues[0], maxFast = fastValues[fastValues.length - 1];
    const minSlow = slowValues[0], maxSlow = slowValues[slowValues.length - 1];
    const er = Number.isFinite(fixedEr) ? null : (Math.abs(winner.er - minEr) < eps ? 'min' : (Math.abs(winner.er - maxEr) < eps ? 'max' : null));
    const fast = Number.isFinite(fixedFast) ? null : (Math.abs(winner.fast - minFast) < eps ? 'min' : (Math.abs(winner.fast - maxFast) < eps ? 'max' : null));
    const slow = Math.abs(winner.slow - minSlow) < eps ? 'min' : (Math.abs(winner.slow - maxSlow) < eps ? 'max' : null);
    return { er, fast, slow, onBoundary: !!(er || fast || slow) };
}


// ── Data loaders ──────────────────────────────────────────────────────────────

function normalizeSymbol(value: unknown): string {
    return normalizeAssetSymbol(value);
}

function inferIntervalLabel(dataFile: string | null, meta: DataMeta | null): string {
    const fromMeta = Number(meta?.intervalSeconds);
    if (Number.isFinite(fromMeta) && fromMeta > 0) {
        return toIntervalLabel(fromMeta);
    }

    const m = String(path.basename(dataFile || '')).match(/_(\d+)([mhd])\.json$/i);
    return m ? `${m[1]}${m[2].toLowerCase()}` : '1h';
}

function updateAmaProfilesFile({ dataFile, meta, winners, sourceResultsFile }: { dataFile: string | null; meta: DataMeta | null; winners: { ama1: WeightedEntry; ama2: WeightedEntry; ama3: WeightedEntry; ama4: WeightedEntry }; sourceResultsFile: string | null }) {
    const assetASymbol = normalizeSymbol(meta?.assetA?.symbol);
    const assetBSymbol = normalizeSymbol(meta?.assetB?.symbol);
    const assetAId = normalizeSymbol(meta?.assetA?.id);
    const assetBId = normalizeSymbol(meta?.assetB?.id);
    const assetA = assetASymbol || assetAId;
    const assetB = assetBSymbol || assetBId;
    if (!assetA || !assetB) return;

    const intervalSeconds = Number(meta?.intervalSeconds);
    const intervalLabel = inferIntervalLabel(dataFile, meta);
    const key = `${assetA}|${assetB}|${Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : intervalLabel}`;

    const payload: {
        version: number;
        updatedAt: string;
        profiles: unknown[];
    } = {
        version: 1,
        updatedAt: new Date().toISOString(),
        profiles: [],
    };

    if (fs.existsSync(AMA_PROFILES_FILE)) {
        try {
            const current = readJSON(AMA_PROFILES_FILE);
            if (current && typeof current === 'object') {
                payload.version = Number(current.version) || 1;
                payload.profiles = Array.isArray(current.profiles) ? current.profiles : [];
            }
        } catch (_) {}
    }

    const profile = {
        key,
        assetA,
        assetB,
        assetAId: assetAId || null,
        assetBId: assetBId || null,
        poolId: meta?.pool || null,
        intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : null,
        intervalLabel,
        defaultAma: 'AMA3',
        sourceResultsFile,
        updatedAt: payload.updatedAt,
        amas: {
            AMA1: {
                name: winners.ama1.label,
                erPeriod: winners.ama1.er,
                fastPeriod: winners.ama1.fast,
                slowPeriod: winners.ama1.slow,
            },
            AMA2: {
                name: winners.ama2.label,
                erPeriod: winners.ama2.er,
                fastPeriod: winners.ama2.fast,
                slowPeriod: winners.ama2.slow,
            },
            AMA3: {
                name: winners.ama3.label,
                erPeriod: winners.ama3.er,
                fastPeriod: winners.ama3.fast,
                slowPeriod: winners.ama3.slow,
            },
            AMA4: {
                name: winners.ama4.label,
                erPeriod: winners.ama4.er,
                fastPeriod: winners.ama4.fast,
                slowPeriod: winners.ama4.slow,
            },
        },
    };

    const idx = payload.profiles.findIndex((p) => String((p as { key?: unknown } | null)?.key || '') === key);
    if (idx >= 0) payload.profiles[idx] = profile;
    else payload.profiles.push(profile);

    ensureDir(path.dirname(AMA_PROFILES_FILE));
    writeJSON(AMA_PROFILES_FILE, payload);
}

// Warmup skips through the full production AMA seeding + convergence window
// (getAmaWarmupBars) rather than just the ER seed boundary (erPeriod + 1), so
// objective metrics are never measured on SMA-warmup or unconverged values.
function amaWarmupSkip(erPeriod: number, fastPeriod: number, slowPeriod: number): number {
    return getAmaWarmupBars(erPeriod, slowPeriod, 0, fastPeriod);
}

function calcTotalAmaMovement(amaValues: number[], erPeriod: number, fastPeriod: number, slowPeriod: number): number {
    const skip = amaWarmupSkip(erPeriod, fastPeriod, slowPeriod);
    let total = 0;
    for (let i = skip + 1; i < amaValues.length; i++) {
        total += Math.abs(amaValues[i] - amaValues[i - 1]) / amaValues[i - 1];
    }
    return total;
}

// ── Informational: area above/below AMA ──────────────────────────────────────

function calcArea(amaValues: number[], candles: SearchCandle[], erPeriod: number, fastPeriod: number, slowPeriod: number) {
    const skip = amaWarmupSkip(erPeriod, fastPeriod, slowPeriod);
    let above = 0, below = 0, maxUp = 0, maxDown = 0;
    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        if (candles[i].high > ama) {
            const d = (candles[i].high - ama) / ama;
            above += d;
            if (d > maxUp) maxUp = d;
        }
        if (candles[i].low < ama) {
            const d = (ama - candles[i].low) / ama;
            below += d;
            if (d > maxDown) maxDown = d;
        }
    }
    const total   = above + below;
    const maxDist = Math.max(maxUp, maxDown);
    return { above, below, total, maxUp, maxDown, maxDist };
}

function calcTotalRelativeDistance(amaValues: number[], candles: SearchCandle[], erPeriod: number, fastPeriod: number, slowPeriod: number): number {
    const skip = amaWarmupSkip(erPeriod, fastPeriod, slowPeriod);
    let total = 0;
    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const close = candles[i].close;
        total += Math.abs(close - ama) / ama;
    }
    return total;
}

function runSearchShard(payload: ShardPayload, onProgress: ((msg: ProgressMsg) => void) | null = null): SearchResult {
    const {
        workerId,
        erShard,
        fastValues,
        slowValues,
        candles,
        closes,
    } = payload;

    const totalCombos = erShard.length * fastValues.length * slowValues.length;
    const progressStep = Math.max(2000, Math.floor(totalCombos / 20));
    let checked = 0;
    let valid = 0;
    const entries: SearchEntry[] = [];
    const startMs = Date.now();

    for (const er of erShard) {
        for (const fast of fastValues) {
            for (const slow of slowValues) {
                checked++;
                if (fast >= slow) {
                    if (onProgress && (checked % progressStep === 0 || checked === totalCombos)) {
                        const elapsedSec = (Date.now() - startMs) / 1000;
                        onProgress({ workerId, checked, total: totalCombos, elapsedSec });
                    }
                    continue;
                }
                valid++;

                const ama = calculateAMA(closes, { erPeriod: er, fastPeriod: fast, slowPeriod: slow });
                const area = calcArea(ama, candles, er, fast, slow);
                const amaMovementTotal = calcTotalAmaMovement(ama, er, fast, slow);
                const distanceTotal = calcTotalRelativeDistance(ama, candles, er, fast, slow);
                const bandFactorPct = area.maxDist * 200;
                const entry = {
                    er, fast, slow,
                    area,
                    amaMovementTotal,
                    bandFactorPct,
                    distanceTotal,
                };
                entries.push(entry);

                if (onProgress && (checked % progressStep === 0 || checked === totalCombos)) {
                    const elapsedSec = (Date.now() - startMs) / 1000;
                    onProgress({ workerId, checked, total: totalCombos, elapsedSec });
                }
            }
        }
    }

    return { workerId, entries, totalCombos, validCombos: valid };
}

function spawnShardWorker(payload: ShardPayload, onProgress: ((msg: ProgressMsg) => void) | null): Promise<SearchResult> {
    return new Promise((resolve, reject) => {
        // ESM: resolve this module's path from import.meta.url
        // (__filename is undefined in ES modules).
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { type: 'search_shard', payload } });
        worker.on('message', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'progress') {
                if (onProgress) onProgress(msg);
                return;
            }
            if (msg.type === 'done') resolve(msg.result);
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}

function splitIntoShards(values: number[], shardCount: number): number[][] {
    const out: number[][] = [];
    const size = Math.ceil(values.length / shardCount);
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size));
    }
    return out.filter((s) => s.length > 0);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
    const args = parseArgs();
    let dataFile = args.dataFile;
    const objectives = getAmaObjectivesFromArgs(args);

    ensureValidRange('ER', args.er);
    ensureValidRange('Fast', args.fast);
    ensureValidRange('Slow', args.slow);

    const erDim = buildDimension(args.er);
    const fastDim = buildDimension(args.fast);
    const slowDim = buildDimension(args.slow);

    const ER_VALUES: number[] = Number.isFinite(args.fixedEr) ? [args.fixedEr!] : erDim.values;
    const FAST_VALUES: number[] = Number.isFinite(args.fixedFast) ? [args.fixedFast!] : fastDim.values;
    const SLOW_VALUES_AREA = slowDim.values;

    const totalCombos = ER_VALUES.length * FAST_VALUES.length * SLOW_VALUES_AREA.length;
    const startMs = Date.now();

    const erLabel = Number.isFinite(args.fixedEr) ? `fixed(${args.fixedEr})` : `${ER_VALUES[0]}–${ER_VALUES[ER_VALUES.length-1]}`;
    const fastLabel = Number.isFinite(args.fixedFast) ? `fixed(${args.fixedFast})` : `${FAST_VALUES[0]}–${FAST_VALUES[FAST_VALUES.length-1]}`;

    console.log('================================================================================');
    console.log(' AMA GEOMETRIC OPTIMIZER');
    console.log('================================================================================');
    console.log(`  4 AMAs — pure geometric, no grid or bot settings`);
    console.log('  Objective: minimise movement + λ·distance under per-AMA max distance caps');
    for (const o of objectives) {
        console.log(`  ${o.key}: distance cap q=${o.distanceCapQuantile.toFixed(2)}  λ=${o.distanceWeight.toFixed(6)}`);
    }
    console.log(`  Ranges:     ER ${erLabel}  Fast ${fastLabel}  Slow ${SLOW_VALUES_AREA[0]}–${SLOW_VALUES_AREA[SLOW_VALUES_AREA.length-1]}`);
    if (!Number.isFinite(args.fixedEr) && !Number.isFinite(args.fixedFast)) {
        console.log(`  Sampling:   ER ${erDim.meta.mode}(${erDim.meta.count}${erDim.meta.ratio ? `,x${erDim.meta.ratio.toFixed(3)}` : ''})  Fast ${fastDim.meta.mode}(${fastDim.meta.count}${fastDim.meta.ratio ? `,x${fastDim.meta.ratio.toFixed(3)}` : ''})  Slow ${slowDim.meta.mode}(${slowDim.meta.count}${slowDim.meta.ratio ? `,x${slowDim.meta.ratio.toFixed(3)}` : ''})`);
    }
    console.log(`  Combos:     ${totalCombos}\n`);

    // Load data
    let candles: SearchCandle[], dataLabel: string, dataMeta: DataMeta | null = null;
    if (!dataFile) {
        throw new Error('Optimizer requires --data <lp_pool_*.json>. Use --write-profiles to also update profiles/market_profiles.json.');
    }
    const loaded = loadLpDataFile(path.resolve(dataFile));
    candles   = loaded.candleObjects as SearchCandle[];
    const m   = loaded.meta as DataMeta | null;
    dataMeta = m;
    dataLabel = m ? `LP Pool ${m.pool} (${m.assetA?.symbol}/${m.assetB?.symbol})` : path.basename(dataFile);
    const closes = candles.map((c) => c.close);
    console.log(`  Data:       ${dataLabel}  (${candles.length} candles)\n`);

    // ── Run: core-parallel full-grid scan split by ER shards ──────────────────
    const cpuCount = Math.max(1, os.cpus().length);
    const requestedWorkers = Number.isFinite(args.workers) && args.workers! > 0 ? Math.floor(args.workers!) : cpuCount;
    const workerCount = Math.max(1, Math.min(requestedWorkers, ER_VALUES.length));
    const erShards = splitIntoShards(ER_VALUES, workerCount);
    const shardTotals = erShards.map((shard) => shard.length * FAST_VALUES.length * SLOW_VALUES_AREA.length);
    const shardProgress = new Map();

    console.log(`  Parallel workers: ${erShards.length} shard workers (CPU cores available: ${cpuCount})`);
    const shardResults = await Promise.all(erShards.map((erShard, idx) => {
        const workerPayload = {
            workerId: idx + 1,
            erShard,
            fastValues: FAST_VALUES,
            slowValues: SLOW_VALUES_AREA,
            candles,
            closes,
        };
        return spawnShardWorker(workerPayload, (msg) => {
            shardProgress.set(msg.workerId, msg.checked);
            const done = shardTotals.reduce((acc, total, i) => acc + Math.min(total, shardProgress.get(i + 1) || 0), 0);
            const pct = ((done / totalCombos) * 100).toFixed(1);
            console.log(`  [scan] ${pct}%  (${done}/${totalCombos})  w${msg.workerId} ${msg.elapsedSec.toFixed(1)}s`);
        });
    }));

    const entries = shardResults.flatMap((r) => r.entries);
    const validCombos = shardResults.reduce((acc, r) => acc + r.validCombos, 0);
    const maxDistVals = entries.map((e) => e.area.maxDist);
    // When both ER and Fast are fixed, the search is 1D over Slow only. Slow
    // variation rarely produces maxDist outliers, so the distance cap filter adds
    // no value here — λ alone cleanly separates the candidates.
    const skipCap = Number.isFinite(args.fixedEr) && Number.isFinite(args.fixedFast);

    const objectiveResults = objectives.map((objective) => {
        const distanceWeight = objective.distanceWeight;
        const computedCap = skipCap ? null : percentile(maxDistVals, objective.distanceCapQuantile);
        const cappedEntries = skipCap || computedCap == null ? entries : entries.filter((e) => e.area.maxDist <= computedCap!);

        let best: WeightedEntry | null = null;
        for (const e of cappedEntries) {
            const score = e.amaMovementTotal + (distanceWeight * e.distanceTotal);
            const bestScore: number = best ? best.weightedScore : Infinity;
            if (!best || score < bestScore || (score === bestScore && e.amaMovementTotal < best.amaMovementTotal) || (score === bestScore && e.amaMovementTotal === best.amaMovementTotal && e.distanceTotal < best.distanceTotal)) {
                best = {
                    ...e,
                    weightedScore: score,
                    normDistance: null,
                    normMovement: null,
                    key: objective.key,
                    label: objective.name,
                };
            }
        }

        return {
            objective,
            distanceWeight,
            best,
            totalCombos,
            validCombos,
            candidatesUnderCap: cappedEntries.length,
            maxDistanceCap: computedCap,
        };
    });
    const elapsedSec = (Date.now() - startMs) / 1000;
    console.log(`  Completed parallel search in ${elapsedSec.toFixed(1)}s  (valid combos: ${validCombos})\n`);

    const selected = objectiveResults.map((r) => r.best).filter(Boolean) as WeightedEntry[];
    const failed = objectiveResults.filter((r) => !r.best).map((r) => r.objective?.key || '?');
    if (failed.length > 0) {
        throw new Error(`No candidate under distance cap for: ${failed.join(', ')}. Increase corresponding cap (e.g. --ama4Cap 0.35).`);
    }

    const ama1 = selected.find((s) => s.key === 'AMA1') || null;
    const ama2 = selected.find((s) => s.key === 'AMA2') || null;
    const ama3 = selected.find((s) => s.key === 'AMA3') || null;
    const ama4 = selected.find((s) => s.key === 'AMA4') || null;

    function detail(label: string, r: WeightedEntry | null, optimisedFor: string) {
        if (!r) {
            console.log(`  ${label}`);
            console.log('  └─ No valid candidate under constraint\n');
            return;
        }
        const asymmetry = Math.abs(r.area.above - r.area.below);
        const bias      = r.area.above > r.area.below ? 'AMA below price' : 'AMA above price';
        console.log(`  ${label}`);
        console.log(`  ├─ Optimised for:  ${optimisedFor}`);
        console.log(`  ├─ Params:         ER=${r.er}  Fast=${r.fast}  Slow=${r.slow}`);
        console.log(`  ├─ Area total:     ${r.area.total.toFixed(2)}  (above ${r.area.above.toFixed(2)}  below ${r.area.below.toFixed(2)})`);
        console.log(`  ├─ Asymmetry:      ${asymmetry.toFixed(2)}  (${bias})`);
        console.log(`  └─ Movement:       ${r.amaMovementTotal.toFixed(4)}\n`);
    }

    console.log('================================================================================');
    console.log(` 4 AMAs  —  pure geometric  (${ER_VALUES.length}×${FAST_VALUES.length}×${SLOW_VALUES_AREA.length} combinations)`);
    console.log('================================================================================\n');

    for (const w of selected) {
        detail(w.label, w,
            `score=${w.weightedScore.toFixed(6)}  λ=${objectiveResults.find((r) => r.objective?.key === w.key)?.distanceWeight?.toFixed(4) || 'n/a'}  rawDist=${w.distanceTotal.toFixed(2)}  rawMove=${w.amaMovementTotal.toFixed(2)}`);
    }

    for (const r of objectiveResults) {
        const mdc = r.maxDistanceCap;
        if (mdc != null && Number.isFinite(mdc)) {
            console.log(`  ${r.objective.key} cap value: ${mdc.toFixed(4)}  (candidates under cap: ${r.candidatesUnderCap})`);
        }
    }
    console.log();

    // ── Side-by-side summary ───────────────────────────────────────────────────
    console.log('================================================================================');
    console.log(' SUMMARY');
    console.log('================================================================================\n');
    console.log('                |  ER  | Fast | Slow | Dist    | Move    | Area    | MaxDist');
    console.log('────────────────┼──────┼──────┼──────┼─────────┼─────────┼─────────┼─────────');
    for (const r of selected) {
        const name = r.key;
        if (!r) continue;
        console.log(
            `${name.padEnd(15)} | ` +
            `${r.er.toString().padStart(4)} | ` +
            `${r.fast.toFixed(1).padStart(4)} | ` +
            `${r.slow.toFixed(1).padStart(4)} | ` +
            `${r.distanceTotal.toFixed(2).padStart(7)} | ` +
            `${r.amaMovementTotal.toFixed(2).padStart(7)} | ` +
            `${r.area.total.toFixed(2).padStart(7)} | ` +
            `${(r.area.maxDist * 100).toFixed(1).padStart(7)}%`
        );
    }
    console.log();

    const boundarySummary = {
        AMA1: boundaryFlags(ama1, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA, args.fixedEr, args.fixedFast),
        AMA2: boundaryFlags(ama2, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA, args.fixedEr, args.fixedFast),
        AMA3: boundaryFlags(ama3, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA, args.fixedEr, args.fixedFast),
        AMA4: boundaryFlags(ama4, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA, args.fixedEr, args.fixedFast),
    };

    console.log(' Boundary Check');
    console.log('────────────────────────────────────────────────────────────────────────────────');
    for (const [name, b] of Object.entries(boundarySummary)) {
        const txt = b.onBoundary ? `ER:${b.er || '-'} Fast:${b.fast || '-'} Slow:${b.slow || '-'}` : 'none';
        console.log(`${name.padEnd(24)} ${txt}`);
    }
    console.log();

    // ── Chart ─────────────────────────────────────────────────────────────────
    const ws = (v: unknown) => String(v).replace('.', '_');
    const lambdaSuffix = `_w${objectives.map((o) => ws(String(o.distanceWeight))).join('_')}`;
    const COLOR_CYCLE = ['#26a69a', '#fb8c00', '#5c9ee6', '#ef5350'];
    const DASH_CYCLE = ['dot', 'solid', 'dash', 'dashdot'];
    const candleArrays = candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
    const chartMeta = {
        ...(dataMeta || {}),
        assetA: dataMeta?.assetA || { symbol: '?' },
        assetB: dataMeta?.assetB || { symbol: '?' },
        intervalSeconds: dataMeta?.intervalSeconds || 3600,
        fetchedAt: dataMeta?.fetchedAt || new Date().toISOString(),
    };
    const amaResults = selected.map((w, i) => {
        const ama = calculateAMA(closes, { erPeriod: w.er, fastPeriod: w.fast, slowPeriod: w.slow });
        return {
            name: w.label,
            erPeriod: w.er,
            fastPeriod: w.fast,
            slowPeriod: w.slow,
            color: COLOR_CYCLE[i % COLOR_CYCLE.length],
            dash: DASH_CYCLE[i % DASH_CYCLE.length],
            lineWidth: i === 0 ? 2 : 1.5,
            values: ama,
        };
    });
    const chartName = dataFile
        ? `optimization_chart_${path.basename(dataFile, '.json')}${lambdaSuffix}.html`
        : `optimization_chart_high_resolution${lambdaSuffix}.html`;
    const chartPath = path.join(PATHS.ANALYSIS.CHARTS_DIR, chartName);
    ensureDir(path.dirname(chartPath));
    const html = generateHTML(chartMeta, candleArrays, amaResults);
    fs.writeFileSync(chartPath, html, 'utf8');
    console.log(`  Chart:       ${path.relative(process.cwd(), chartPath)}\n`);

    // ── Save ──────────────────────────────────────────────────────────────────
    const outName = dataFile
        ? `optimization_results_${path.basename(dataFile, '.json')}${lambdaSuffix}.json`
        : `optimization_results_high_resolution${lambdaSuffix}.json`;
    const outPath = path.join(PATHS.ANALYSIS.RESULTS_DIR, outName);
    ensureDir(path.dirname(outPath));
    writeJSON(outPath, {
        meta: {
            dataLabel,
            candles: candles.length,
            totalCombos,
            ranges: {
                er: { ...erDim.meta },
                fast: { ...fastDim.meta },
                slow: { ...slowDim.meta },
                fixedEr: Number.isFinite(args.fixedEr) ? args.fixedEr : null,
                fixedFast: Number.isFinite(args.fixedFast) ? args.fixedFast : null,
            },
            boundaryFlags: boundarySummary,
            objective: {
                type: 'per_ama_distance_weights',
                distanceMetric: 'sum(abs(close-ama)/ama)',
                movementMetric: 'sum(abs(ama_t-ama_t-1)/ama_t-1)',
                distanceWeightByAma: Object.fromEntries(objectiveResults.map((r) => [r.objective.key, r.distanceWeight])),
                weights: objectives,
                maxDistanceCap: {
                    value: null,
                    quantileByAma: Object.fromEntries(objectives.map((o) => [o.key, o.distanceCapQuantile])),
                    appliedValueByAma: Object.fromEntries(objectiveResults.map((r) => [r.objective.key, r.maxDistanceCap])),
                },
            },
            amas: {
                AMA1: ama1,
                AMA2: ama2,
                AMA3: ama3,
                AMA4: ama4,
            },
        },
    });

    if (args.writeProfiles && dataFile && ama1 && ama2 && ama3 && ama4) {
        updateAmaProfilesFile({
            dataFile,
            meta: dataMeta,
            winners: { ama1, ama2, ama3, ama4 },
            sourceResultsFile: outName,
        });
    }

    console.log(`================================================================================`);
    console.log(`  Saved: ${outName}\n`);
    if (args.writeProfiles && dataFile) {
        console.log(`  Updated: ${path.relative(process.cwd(), AMA_PROFILES_FILE)}\n`);
    } else {
        console.log(`  Profiles unchanged. Add --write-profiles to update ${path.relative(process.cwd(), AMA_PROFILES_FILE)}.\n`);
    }
}

if (!isMainThread) {
    const workerMessage = workerData as { type?: string; payload: ShardPayload } | null;
    if (workerMessage?.type === 'search_shard') {
        const result = runSearchShard(workerMessage.payload, (p: ProgressMsg) => {
            parentPort!.postMessage({ type: 'progress', ...p });
        });
        parentPort!.postMessage({ type: 'done', result });
    } else {
        throw new Error('Unknown worker task type');
    }
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch((err) => {
        console.error('Fatal:', err);
        process.exit(1);
    });
}

export { parseArgs }

