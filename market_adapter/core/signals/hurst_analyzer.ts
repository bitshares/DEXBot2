'use strict';

import { MARKET_ADAPTER } from '../../../modules/constants.js';
import { roundTo } from '../../../modules/order/utils/math.js';


/**
 * Hurst Exponent Analyzer
 *
 * Estimates the Hurst exponent via Rescaled Range (R/S) analysis over a rolling
 * price window. H > (0.5 + HURST_ZONE_BAND) = trending (persistent),
 * H ≈ 0.5 = random walk, H < (0.5 - HURST_ZONE_BAND) = mean-reverting (anti-persistent).
 *
 * Zone boundaries are read from MARKET_ADAPTER.HURST_ZONE_BAND (default 0.05).
 * The RANDOM band between the two thresholds acts as natural hysteresis.
 *
 * Use as a regime gate: trust trend-following signals when trending, suppress or
 * invert them when mean-reverting, stay flat when random.
 *
 * Algorithm: for each scale τ in config.scales, partition the log-return window into
 * non-overlapping chunks of length τ, compute average R/S per chunk, then OLS-fit
 * log(avgRS) vs log(τ) — the slope is the Hurst exponent.
 *
 * PERFORMANCE (2026-09): like the permutation-entropy analyzer, this one is
 * re-created and re-fed the entire candle history for every bot on every hourly
 * cycle. The previous implementation allocated `returns.slice(c*tau, ...)` for
 * every R/S chunk (~30 arrays per bar, ~23k per bot per cycle) plus a fresh
 * log-return array per bar. The buffers are now preallocated typed arrays and
 * `computeRS` takes a [from, to) range instead of a slice, so `update()`
 * allocates nothing. Measured on an 782-bar series: ~5 ms -> ~3 ms per bot per
 * cycle with the same exponent (see tests/test_market_adapter_entropy_equivalence.ts).
 */

/**
 * OLS slope of ys ~ slope * xs + intercept.  Returns slope only.
 */
function olsSlope(xs: number[], ys: number[]): number {
    const n = xs.length;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
    for (let i = 0; i < n; i++) {
        sumX  += xs[i];
        sumY  += ys[i];
        sumXX += xs[i] * xs[i];
        sumXY += xs[i] * ys[i];
    }
    const denom = n * sumXX - sumX * sumX;
    return denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0.5;
}

/**
 * Compute R/S (rescaled range) over `returns[from..to)` (to exclusive).
 * Taking a range instead of a slice keeps the caller's buffer reusable.
 */
function computeRS(returns: ArrayLike<number>, from: number, to: number): number {
    const n = to - from;
    if (n < 2) return 0;

    let sum = 0;
    for (let i = from; i < to; i++) sum += returns[i];
    const mean = sum / n;

    let cumDev = 0, maxCum = -Infinity, minCum = Infinity, sumSq = 0;
    for (let i = from; i < to; i++) {
        const d = returns[i] - mean;
        cumDev += d;
        if (cumDev > maxCum) maxCum = cumDev;
        if (cumDev < minCum) minCum = cumDev;
        sumSq += d * d;
    }

    const R = maxCum - minCum;
    const S = Math.sqrt(sumSq / n);
    return S > 0 ? R / S : 0;
}

/**
 * Shared Hurst zone classification used by both HurstAnalyzer.getAnalysis()
 * and the regime gate, so the zone boundaries live in exactly one place.
 * Strength normalization uses MARKET_ADAPTER.HURST_STRENGTH_NORMALIZER.
 */
function classifyHurst(h: number, band = MARKET_ADAPTER.HURST_ZONE_BAND) {
    const H_UPPER = 0.5 + band;
    const H_LOWER = 0.5 - band;

    let regime, regimeStrength;
    if (h >= H_UPPER) {
        regime = 'TRENDING';
        regimeStrength = Math.min(1, (h - H_UPPER) / MARKET_ADAPTER.HURST_STRENGTH_NORMALIZER);
    } else if (h <= H_LOWER) {
        regime = 'MEAN_REVERTING';
        regimeStrength = Math.min(1, (H_LOWER - h) / MARKET_ADAPTER.HURST_STRENGTH_NORMALIZER);
    } else {
        regime = 'RANDOM';
        regimeStrength = 0;
    }
    return { regime, regimeStrength };
}

class HurstAnalyzer {
    private _w: number;
    window: number;
    /** Bars of history this analyzer's state depends on (see bufferBars use in the regime gate). */
    bufferBars: number;
    scales: number[];
    private _prices: Float64Array;
    private _returns: Float64Array;
    private _priceCount: number;
    private _updateCount: number;
    hurst: number;
    isReady: boolean;

    /**
     * @param {Object}   config
     * @param {number}   config.window - Rolling window in bars (default 128)
     * @param {number[]} config.scales - Sub-window scales for R/S (default [8, 16, 32, 64])
     */
    constructor(config: { window?: number; scales?: number[] } = {}) {
        this._w = Math.ceil(config.window ?? 128);
        this.window = this._w;
        this.bufferBars = this._w + 1;
        this.scales = config.scales ?? [8, 16, 32, 64];

        // Rolling price buffer holds window+1 prices so returns span [0..window]
        // and always include the newest bar (a window+2 cap would permanently
        // exclude it). Returns reuse one buffer across every update.
        this._prices = new Float64Array(this._w + 1);
        this._returns = new Float64Array(this._w);
        this._priceCount = 0;
        this._updateCount = 0;
        this.hurst = 0.5;
        this.isReady = false;
    }

    /**
     * Feed a new price and return analysis.
     * @param {number} price
     * @returns {Object} { isReady, hurst, regime, regimeStrength, updateCount }
     */
    update(price: number): { isReady: boolean; hurst: number; regime: string; regimeStrength: number; updateCount: number } {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }
        const capacity = this._w + 1;
        if (this._priceCount === capacity) {
            this._prices.copyWithin(0, 1);
            this._priceCount--;
        }
        this._prices[this._priceCount++] = price;
        this._updateCount++;

        if (this._priceCount < capacity) {
            this.isReady = false;
            return this.getAnalysis();
        }

        // Log returns over the rolling window
        const w = this._w;
        const returns = this._returns;
        for (let i = 0; i < w; i++) {
            returns[i] = Math.log(this._prices[i + 1] / this._prices[i]);
        }

        // R/S at each scale → OLS slope
        const logRS: number[] = [], logTau: number[] = [];
        for (const τ of this.scales) {
            if (τ >= w) continue;
            const nChunks = Math.floor(w / τ);
            if (nChunks < 1) continue;

            let sumRS = 0, count = 0;
            for (let c = 0; c < nChunks; c++) {
                const rs = computeRS(returns, c * τ, (c + 1) * τ);
                if (rs > 0) { sumRS += rs; count++; }
            }
            if (count > 0) {
                logRS.push(Math.log(sumRS / count));
                logTau.push(Math.log(τ));
            }
        }

        if (logTau.length >= 2) {
            this.hurst = Math.min(1, Math.max(0, olsSlope(logTau, logRS)));
        }

        this.isReady = true;
        return this.getAnalysis();
    }

    getAnalysis(): { isReady: boolean; hurst: number; regime: string; regimeStrength: number; updateCount: number } {
        const h = this.hurst;
        const { regime, regimeStrength } = classifyHurst(h);

        return {
            isReady: this.isReady,
            hurst: roundTo(this.hurst, 1000),
            regime,
            regimeStrength: roundTo(regimeStrength, 100),
            updateCount: this._updateCount,
        };
    }
}

export { HurstAnalyzer, classifyHurst }
