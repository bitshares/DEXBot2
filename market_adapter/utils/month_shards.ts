'use strict';
/**
 * MONTH-SHARD GEOMETRY & COVERAGE — the one place that defines how calendar-
 * month cache shards are named, located, and how recorded query coverage is
 * merged and compared.
 *
 * Two independent caches store one `{ meta, ... }` file per UTC month named
 * `<base>.shard_YYYY-MM.json`:
 *   - the candle cache   (`market_adapter/inputs/window_cache.ts`)
 *   - the fills cache    (`analysis/fills_cache.ts`)
 *
 * They previously carried private, near-identical copies of every helper
 * below. The geometry in particular must never drift: two caches that disagree
 * on a month boundary silently double-fetch or drop a bucket. Keeping it here
 * makes the layout a single contract.
 *
 * Pure and I/O-free (only path arithmetic) so it is safe to import from any
 * runtime, including browser-safe code that merely checks a filename.
 */

import { path } from '../../modules/path_api.js';

/** A span that was actually queried, with the time the query ran. */
type QueriedRange = { gte: number; lte: number; at: number | null };
/** A plain inclusive ms range. */
type Span = { gte: number; lte: number };

const SHARD_MARKER = '.shard_';
const SHARD_KEY_RE = /^\d{4}-\d{2}$/;

// ─── Month-shard naming ───────────────────────────────────────────────────────
// Shard key is the UTC calendar month; bounds are half-open [start, end) so
// every timestamp maps to exactly one shard (a value exactly at a month
// boundary belongs to the new month).

function shardKeyForTimestamp(tsMs: unknown): string {
    const d = new Date(Number(tsMs));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shardBoundsForKey(key: unknown): { start: number; end: number } {
    const parts = String(key).split('-').map(Number);
    const start = Date.UTC(parts[0], parts[1] - 1, 1);
    const end = parts[1] === 12 ? Date.UTC(parts[0] + 1, 0, 1) : Date.UTC(parts[0], parts[1], 1);
    return { start, end };
}

function shardKeysForRange(gteMs: unknown, lteMs: unknown): string[] {
    const keys: string[] = [];
    const cursor = new Date(Date.UTC(
        new Date(Number(gteMs)).getUTCFullYear(),
        new Date(Number(gteMs)).getUTCMonth(), 1));
    const last = new Date(Number(lteMs));
    while (cursor <= last) {
        keys.push(shardKeyForTimestamp(cursor.getTime()));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return keys;
}

function shardPathFor(basePath: string, shardKey: string): string {
    const parsed = path.parse(basePath);
    return path.join(parsed.dir, `${parsed.name}${SHARD_MARKER}${shardKey}${parsed.ext}`);
}

/**
 * If `name` is a shard file for `baseName`, return its `YYYY-MM` key;
 * otherwise null. Guards the `sibling`/family scans against stray files.
 */
function shardKeyFromName(name: string, baseName: string, ext = '.json'): string | null {
    const prefix = `${baseName}${SHARD_MARKER}`;
    if (ext && !name.endsWith(ext)) return null;
    if (!name.startsWith(prefix)) return null;
    const key = name.slice(prefix.length, name.length - ext.length);
    return SHARD_KEY_RE.test(key) ? key : null;
}

/**
 * The base stem of a shard filename, or null when `name` is not a shard.
 * `lp_pool_133_1h.shard_2026-10.json` → `lp_pool_133_1h`. Callers that must
 * group or upgrade a family use this instead of re-deriving the marker regex.
 */
function shardStemFromName(name: string, ext = '.json'): string | null {
    if (ext && !name.endsWith(ext)) return null;
    const body = ext ? name.slice(0, name.length - ext.length) : name;
    const idx = body.lastIndexOf(SHARD_MARKER);
    if (idx < 0) return null;
    const key = body.slice(idx + SHARD_MARKER.length);
    return SHARD_KEY_RE.test(key) ? body.slice(0, idx) : null;
}

// ─── Coverage spans ───────────────────────────────────────────────────────────

/** Parse a verification timestamp: epoch ms or ISO. Anything else is unknown. */
function timestampMs(raw: unknown): number | null {
    // `null`/`undefined`/`''` mean "not recorded". They must NOT fall through
    // to Number(): Number(null) === 0 is finite, which would read an unknown
    // verification time as "verified at the epoch" — i.e. as maximally stale.
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
}

function verifiedAt(range: unknown): number | null {
    return timestampMs((range as { at?: unknown } | null)?.at);
}

/**
 * Normalize recorded spans: sort, then merge overlapping / bucket-adjacent
 * ones — but ONLY when they assert the same verification time. Merging spans
 * with different `at` would have to pick one verdict for the whole union, and
 * either pick loses (min → the merged span vouches for buckets the older
 * query never saw; max → buckets verified long ago look freshly verified).
 * Keeping them separate preserves exact per-bucket freshness. The same-`at`
 * case (bulk fetches, and every pre-`at` shard) collapses to one span.
 *
 * `bucketMs` widens adjacency: `0` merges only overlaps, `1` merges adjacent
 * integer-ms spans (fills), a bucket size merges spans a bucket apart (candles).
 */
function unionQueriedRanges(ranges: { gte: number; lte: number; at?: number | null }[], bucketMs = 0): QueriedRange[] {
    const clean = (ranges || [])
        .filter((q) => q && Number.isFinite(Number(q.gte)) && Number.isFinite(Number(q.lte)) && Number(q.lte) >= Number(q.gte))
        .map((q) => ({ gte: Number(q.gte), lte: Number(q.lte), at: verifiedAt(q) }))
        .sort((a, b) => a.gte - b.gte || a.lte - b.lte);
    const merged: QueriedRange[] = [];
    const gap = Number.isFinite(Number(bucketMs)) && Number(bucketMs) > 0 ? Number(bucketMs) : 0;
    for (const q of clean) {
        const top = merged[merged.length - 1];
        if (top && q.gte <= top.lte + gap && top.at === q.at) {
            if (q.lte > top.lte) top.lte = q.lte;
        } else {
            merged.push({ gte: q.gte, lte: q.lte, at: q.at });
        }
    }
    return merged;
}

/**
 * Bound the persisted span list. Because spans merge only when they assert the
 * same `at`, a shard that is re-verified on every run gains one span per run
 * and would otherwise grow without limit. Dropping the OLDEST spans never
 * invents emptiness. The input is already sorted by extent, so the tail is
 * newest.
 */
function compactCoverage(spans: QueriedRange[], maxSpans: number): QueriedRange[] {
    const list = spans || [];
    const max = Number.isFinite(Number(maxSpans)) && Number(maxSpans) >= 1 ? Math.floor(Number(maxSpans)) : list.length;
    return list.length <= max ? list : list.slice(list.length - max);
}

function rangesCoveredBy(have: { gte: number; lte: number }[], want: { gte: number; lte: number }[]): boolean {
    for (const w of want || []) {
        let covered = false;
        for (const h of have || []) {
            if (h.gte <= w.gte && h.lte >= w.lte) { covered = true; break; }
        }
        if (!covered) return false;
    }
    return true;
}

/**
 * Change detection for shard writes: `have` already accounts for every span in
 * `want`, in extent AND in verification time. Without the `at` half, a run
 * whose only news is "these buckets were re-verified 1h later" would skip the
 * write and the next run would fall back to the wide fixed refresh window.
 * An unknown `at` on either side is never treated as fresh.
 */
function coverageSatisfied(have: QueriedRange[], want: QueriedRange[]): boolean {
    if (!rangesCoveredBy(have, want)) return false;
    for (const w of want || []) {
        const wAt = verifiedAt(w);
        if (wAt == null) continue;
        let fresh = false;
        for (const h of have || []) {
            if (h.gte > w.gte || h.lte < w.lte) continue;
            const hAt = verifiedAt(h);
            if (hAt != null && hAt >= wAt) { fresh = true; break; }
        }
        if (!fresh) return false;
    }
    return true;
}

/** Every recorded span across the loaded files, newest verification included. */
function allQueriedRanges(fileCover: { queried?: QueriedRange[] | null }[]): QueriedRange[] {
    const out: QueriedRange[] = [];
    for (const f of fileCover || []) {
        for (const q of f?.queried || []) {
            if (q && Number.isFinite(Number(q.gte)) && Number.isFinite(Number(q.lte))) out.push(q);
        }
    }
    return out;
}

function clipRangeTo(q: QueriedRange, gteMs: number, lteMs: number): QueriedRange | null {
    const gte = Math.max(q.gte, gteMs);
    const lte = Math.min(q.lte, lteMs);
    return lte >= gte ? { gte, lte, at: verifiedAt(q) } : null;
}

/** Sort and merge overlapping / adjacent (integer-ms) spans. */
function mergeSpans(spans: Span[]): Span[] {
    const sorted = [...spans].sort((a, b) => a.gte - b.gte || a.lte - b.lte);
    const merged: Span[] = [];
    for (const s of sorted) {
        const top = merged[merged.length - 1];
        if (top && s.gte <= top.lte + 1) {
            if (s.lte > top.lte) top.lte = s.lte;
        } else {
            merged.push({ ...s });
        }
    }
    return merged;
}

/** `span` minus the union of `covered` (both as inclusive ms ranges). */
function subtractRanges(span: Span, covered: Span[]): Span[] {
    let parts: Span[] = [{ ...span }];
    for (const c of mergeSpans(covered)) {
        const next: Span[] = [];
        for (const p of parts) {
            if (c.lte < p.gte || c.gte > p.lte) { next.push(p); continue; }
            if (c.gte > p.gte) next.push({ gte: p.gte, lte: Math.min(p.lte, c.gte - 1) });
            if (c.lte < p.lte) next.push({ gte: Math.max(p.gte, c.lte + 1), lte: p.lte });
        }
        parts = next.filter((p) => p.lte >= p.gte);
        if (parts.length === 0) break;
    }
    return parts;
}

export {
    SHARD_MARKER,
    SHARD_KEY_RE,
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    shardPathFor,
    shardKeyFromName,
    shardStemFromName,
    timestampMs,
    verifiedAt,
    unionQueriedRanges,
    compactCoverage,
    rangesCoveredBy,
    coverageSatisfied,
    allQueriedRanges,
    clipRangeTo,
    mergeSpans,
    subtractRanges,
};
export type { QueriedRange, Span };
