'use strict';

import fs from 'node:fs';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import {
    getCandleClose,
    getCandleTimestamp,
    normalizeCandle,
} from '../market_adapter/candle_utils.js';


/**
 * Math utilities for analysis scripts.
 *
 * Candle accessors are centralized in market_adapter (candle_utils.ts) and
 * re-exported here so analysis tooling shares one logic path with the
 * live adapter and the browser-embedded chart scripts.
 */

function range(min: number, max: number, step: number, decimals: number = 4) {
    const out: number[] = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(decimals)));
    return [...new Set(out)];
}

function calcStdDev(arr: number[]) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sqDiffs = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0);
    return Math.sqrt(sqDiffs / arr.length);
}

/**
 * Median of a numeric array (average of the two middle values for even
 * lengths). Returns `null` for an empty array. Shared by the analysis
 * backtests instead of each keeping a local copy.
 */
function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantize(value: number, quantum: number | null | undefined): number {
    if (quantum == null || !Number.isFinite(quantum) || quantum <= 0) return value;
    return Math.round(value / quantum) * quantum;
}

/**
 * Evenly spaced geometric progression from `min` to `max` (endpoints forced).
 * Values are optionally snapped to `quantum` and clamped back into the range,
 * rounded to `decimals`, deduped and sorted ascending. Single home for the
 * helper previously copied into analyze_lambda_vs_slow and
 * optimizer_high_resolution (which used different rounding precision).
 */
function geometricRange(
    min: number,
    max: number,
    count: number,
    { decimals = 10, quantum = null as number | null } = {},
) {
    const out: number[] = [];
    const ratio = Math.pow(max / min, 1 / (count - 1));
    for (let i = 0; i < count; i++) {
        let v = min * Math.pow(ratio, i);
        if (i === 0) v = min;
        if (i === count - 1) v = max;
        v = quantize(v, quantum);
        v = Math.max(min, Math.min(max, v));
        out.push(parseFloat(v.toFixed(decimals)));
    }
    return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Parse a candle JSON file with format detection:
 * flat array → {candles: [...]} → {data: [...]}
 */
export interface CandleFile {
    candles: Record<string, unknown>[];
    meta: Record<string, unknown> | null;
}

function loadCandleFile(filePath: string): CandleFile {
    if (!filePath || !fs.existsSync(filePath)) return { candles: [], meta: null };
    const raw = readJSON(filePath);
    if (Array.isArray(raw)) return { candles: raw as Record<string, unknown>[], meta: null };
    const r = raw as { candles?: Record<string, unknown>[]; data?: Record<string, unknown>[]; meta?: Record<string, unknown> } | null;
    if (r && Array.isArray(r.candles)) return { candles: r.candles, meta: r.meta || (r as Record<string, unknown>) };
    if (r && Array.isArray(r.data)) return { candles: r.data, meta: r as Record<string, unknown> };
    return { candles: [], meta: null };
}

export {
    range,
    calcStdDev,
    geometricRange,
    median,
    getCandleClose,
    getCandleTimestamp,
    normalizeCandle,
    loadCandleFile,
}
