'use strict';

import { getStorage } from '../../modules/storage/index.js';
const { readJSON } = getStorage();
import { normalizeCandle } from '../math_utils.js';

/**
 * Shared utilities for bot-fitting scripts.
 */

interface AmaStrategy {
    id: string;
    name: string;
    er: number;
    fast: number;
    slow: number;
}

interface LoadAmaStrategiesOptions {
    /** Require `fast` and `slow` to be finite too (default: only `er`). */
    requireAllFields?: boolean;
    /** Throw unless exactly this many strategies parse (default: no exact check). */
    exactCount?: number | null;
    /** Sort by `id` ascending. */
    sort?: boolean;
    /** Display-name lookup; when omitted use the entry's `label` field. */
    labels?: Record<string, string> | null;
}

/**
 * Read the `meta.amas` preset table from an optimization results file and map
 * it to strategy descriptors. Single home for the loader previously copied into
 * backtest_bot_fitting and backtest_ama_sweep; the options preserve each
 * caller's validation and naming rules.
 */
function loadAmaStrategies(resultsPath: string, options: LoadAmaStrategiesOptions = {}): AmaStrategy[] {
    const { requireAllFields = false, exactCount = null, sort = false, labels = null } = options;
    const json = readJSON<{ meta?: { amas?: Record<string, { er?: unknown; fast?: unknown; slow?: unknown; label?: unknown }> } }>(resultsPath);
    const amas = json.meta?.amas;
    if (!amas) throw new Error('No meta.amas found in results file.');

    const out: AmaStrategy[] = [];
    for (const [key, val] of Object.entries(amas)) {
        const v = val as { er?: unknown; fast?: unknown; slow?: unknown; label?: unknown } | null | undefined;
        if (!v || !Number.isFinite(Number(v.er))) continue;
        if (requireAllFields && (!Number.isFinite(Number(v.fast)) || !Number.isFinite(Number(v.slow)))) continue;
        out.push({
            id: key,
            name: labels ? (labels[key] ?? key) : String(v.label || key),
            er: Number(v.er),
            fast: Number(v.fast),
            slow: Number(v.slow),
        });
    }
    if (sort) out.sort((a, b) => a.id.localeCompare(b.id));
    if (exactCount != null && out.length !== exactCount) {
        throw new Error(`Expected ${exactCount} AMA strategies in results meta.amas, found ${out.length}`);
    }
    if (out.length === 0) throw new Error('No valid AMA strategies found');
    return out;
}

function toCandles(arr: unknown[]) {
    // Canonical accessor transform (market_adapter/candle_utils via math_utils)
    // instead of hand-rolled array indexing.
    return arr
        .map((c) => normalizeCandle(c))
        .filter((c) => c != null)
        .map((c) => ({
            timestamp: c!.time * 1000,
            open: c!.open,
            high: c!.high,
            low: c!.low,
            close: c!.close,
            volume: c!.volume,
        }));
}

function parseListOrRange(spec: string | null | undefined, fallback: number[]): number[] {
    if (!spec) return fallback;
    if (spec.includes(':')) {
        const [a, b, s] = spec.split(':').map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(s) || s <= 0) return fallback;
        const out: number[] = [];
        for (let v = a; v <= b + 1e-9; v += s) out.push(Number(v.toFixed(4)));
        return out;
    }
    const vals = spec.split(',').map((x: string) => Number(x.trim())).filter(Number.isFinite);
    return vals.length ? vals : fallback;
}

function loadLpData(filePath: string) {
    const json = readJSON<{ candles?: unknown[]; meta?: unknown }>(filePath);
    return { candles: toCandles((json.candles ?? json) as unknown[]), meta: json.meta ?? null };
}

function fmt(x: number, d = 2) {
    if (!Number.isFinite(x)) return '  n/a';
    return Number(x).toFixed(d);
}

export { parseListOrRange, loadLpData, fmt, loadAmaStrategies }

