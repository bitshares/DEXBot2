'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { getStorage } from '../../modules/storage/index.js';
const { readJSON } = getStorage();
import { normalizeCandle, fmtNum, loadCandleFile } from '../math_utils.js';
import { GRID_LIMITS, MARKET_ADAPTER } from '../../modules/constants.js';

/**
 * Shared utilities for bot-fitting scripts.
 *
 * Also owns the backtest defaults/fee model shared by backtest_ama_sweep and
 * backtest_bot_fitting, which previously declared byte-identical local copies.
 */

// Transaction / fee model shared by the two bot-fitting backtests.
const DEFAULT_FEE_ROUNDTRIP_PCT = 0.20;
const DEFAULT_MIN_SPREAD_FACTOR = GRID_LIMITS.MIN_SPREAD_FACTOR;
const DEFAULT_BTS_CREATE_FEE = 0.48260;
const DEFAULT_BTS_CANCEL_FEE = 0.00482;
const DEFAULT_BTS_MAKER_CREATE_FACTOR = 0.10;
const DEFAULT_TX_FEE_PRICE = 1.0;

// AMA reset trigger shared by both backtests.
const DEFAULT_REPOSITION_PCT = MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT;
const SLOPE_TRIGGER_FACTOR = MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT;
const SLOPE_MAX_PCT = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
const SLOPE_LOOKBACK_BARS = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;

/** Slope-reset threshold in percent: (trigger factor/100) * max slope pct. */
function slopeResetThresholdPct(): number {
    return (SLOPE_TRIGGER_FACTOR / 100) * SLOPE_MAX_PCT;
}

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
    // Shape detection (flat / {candles} / {data}) lives in math_utils.loadCandleFile.
    // loadCandleFile returns an empty list for a missing file; keep the historical
    // readJSON hard failure so a typo'd --data path is not silently treated as empty.
    //
    // Two intentional deltas vs the old inline readJSON+toCandles version:
    //  (a) a `{candles:[...]}` file without `meta` now yields the whole file object
    //      as `meta` (loadCandleFile's fallback). Both backtest consumers ignore
    //      `meta`, so this is inert today.
    //  (b) `{data:[...]}` files now load instead of crashing in toCandles (which
    //      called `.map` on the non-array object).
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`Data file not found: ${filePath}`);
    const { candles, meta } = loadCandleFile(filePath);
    return { candles: toCandles(candles), meta };
}

// Strict (no Number() coercion) and padded fallback, matching the historical
// shared_utils output contract; formatting itself lives in math_utils.fmtNum.
const fmt = (x: number, d = 2): string => fmtNum(x, d, { fallback: '  n/a', strict: true });

interface BacktestArgTarget {
    dataPath?: string | null;
    resultsPath?: string | null;
    spreadValues?: number[];
    incrementValues?: number[];
    ratioValues?: number[];
    feeRoundtripPct?: number;
    minSpreadFactor?: number;
    repositionPct?: number;
    btsCreateFee?: number;
    btsCancelFee?: number;
    makerCreateFactor?: number;
    txFeePrice?: number;
}

interface BacktestListDefaults {
    spreadValues: number[];
    incrementValues: number[];
    ratioValues: number[];
}

/**
 * Consume one flag shared by backtest_ama_sweep and backtest_bot_fitting.
 * Returns true when `arg` was handled, so the caller advances past its value.
 * Both `--reposition` and `--reposition-pct` spellings are accepted so the two
 * tools converge without breaking either CLI.
 */
function consumeBacktestArg(
    arg: string,
    val: string,
    out: BacktestArgTarget,
    defaults: BacktestListDefaults,
): boolean {
    switch (arg) {
        case '--data': out.dataPath = path.resolve(val); return true;
        case '--results': out.resultsPath = path.resolve(val); return true;
        case '--spread': out.spreadValues = parseListOrRange(val, defaults.spreadValues); return true;
        case '--increment': out.incrementValues = parseListOrRange(val, defaults.incrementValues); return true;
        case '--ratio': out.ratioValues = parseListOrRange(val, defaults.ratioValues); return true;
        case '--fee': out.feeRoundtripPct = Number(val); return true;
        case '--min-spread-factor': out.minSpreadFactor = Number(val); return true;
        case '--reposition':
        case '--reposition-pct': out.repositionPct = Number(val); return true;
        case '--bts-create-fee': out.btsCreateFee = Number(val); return true;
        case '--bts-cancel-fee': out.btsCancelFee = Number(val); return true;
        case '--maker-create-factor': out.makerCreateFactor = Number(val); return true;
        case '--tx-fee-price': out.txFeePrice = Number(val); return true;
        default: return false;
    }
}

export {
    parseListOrRange,
    loadLpData,
    fmt,
    loadAmaStrategies,
    consumeBacktestArg,
    slopeResetThresholdPct,
    DEFAULT_FEE_ROUNDTRIP_PCT,
    DEFAULT_MIN_SPREAD_FACTOR,
    DEFAULT_BTS_CREATE_FEE,
    DEFAULT_BTS_CANCEL_FEE,
    DEFAULT_BTS_MAKER_CREATE_FACTOR,
    DEFAULT_TX_FEE_PRICE,
    DEFAULT_REPOSITION_PCT,
    SLOPE_TRIGGER_FACTOR,
    SLOPE_MAX_PCT,
    SLOPE_LOOKBACK_BARS,
}

