'use strict';

const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running ama_slope_model tests');

const { computeAmaSlopeWeights, computeAmaSlopeClipThreshold, createAmaSlopeClipTracker, computeAverageAmaSlopePct, computeHuberWindowSlopePct } = require('../market_adapter/core/strategies/ama_slope_model');
const { calculateAMA } = require('../market_adapter/core/strategies/ama');

// Generate a series of N values with a given pattern
// A constant per-bar ramp. The canonical slope is the Huber-robust regression
// of ln(AMA) (computeHuberWindowSlopePct), so a single-bar impulse (a flat
// series with only the last bar moved) is heavily discounted by the bounded
// influence function — it reads near 0%/bar but not exactly, because the fit is
// continuous rather than an order statistic. A geometric ramp yields the
// intended log-return per bar, so these fixtures exercise the neutral-zone and
// saturation logic with a slope the estimator reports exactly.
function rampSeries(n, base, perBarPct) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(base * Math.pow(1 + perBarPct / 100, i));
    return out;
}

function flatSeries(n, value) {
    return new Array(n).fill(value);
}

// Default opts use large AMA warmup periods — too large for unit tests.
// Keep the periods small, but derive the exact readiness threshold from the
// same helper the production model uses so the test stays aligned with the
// convergence contract.
const SMALL_OPTS = { erPeriod: 10, fastPeriod: 2, slowPeriod: 10, lookbackBars: 10 };
// Guard in computeAmaSlopeWeights requires erPeriod + lookbackBars + 1
const MIN_LEN = SMALL_OPTS.erPeriod + SMALL_OPTS.lookbackBars + 1;
const MODEL_NEUTRAL_WEIGHT = 0.5;
const HALF_POWER_VOL_OPTS = {
    ...SMALL_OPTS,
    volatilityExponent: 0.5,
    volatilityScaleX: 1.0,
};
const HALF_POWER_SLOPE_VOL_OPTS = {
    ...HALF_POWER_VOL_OPTS,
    maxSlopePct: 3.0,
    neutralZonePct: 0.15,
};

function derivedWeights(result) {
    return {
        sellW: Math.round((MODEL_NEUTRAL_WEIGHT - result.slopeOffset + result.symmetricDelta) * 100) / 100,
        buyW: Math.round((MODEL_NEUTRAL_WEIGHT + result.slopeOffset + result.symmetricDelta) * 100) / 100,
    };
}

function testAmaWarmupReturnsRollingSmaBeforeRecursiveSeed() {
    const values = calculateAMA([10, 20, 40, 80], { erPeriod: 3, fastPeriod: 2, slowPeriod: 30 });
    assert.deepStrictEqual(
        values.slice(0, 4),
        [10, 15, 70 / 3, 37.5],
        'AMA warmup should expose rolling SMA and seed recursion with the full-window SMA'
    );
}

// ─── isReady guard ──────────────────────────────────────────────────────────

function testNotReadyWhenTooFewValues() {
    const result = computeAmaSlopeWeights(flatSeries(20, 100), 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, false, 'should not be ready with fewer than the computed warmup length');
    assert.ok(!('sellW' in result), 'model should not return sellW');
    assert.ok(!('buyW' in result), 'model should not return buyW');
    assert.strictEqual(result.slopeOffset, 0);
    assert.strictEqual(result.symmetricDelta, 0);
    assert.strictEqual(result.slopePct, 0);
    assert.strictEqual(result.confidence, 0);
    assert.strictEqual(result.trend, 'NEUTRAL');
}

function testNotReadyOnEmptyArray() {
    const result = computeAmaSlopeWeights([], 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, false);
}

function testNotReadyOnExactMinusOne() {
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN - 1, 100), 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, false);
}

function testReadyOnExactMinimum() {
    // Flat series → neutral zone → isReady=true, slopeOffset=0
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, SMALL_OPTS);
    assert.strictEqual(result.isReady, true);
}

// ─── Neutral zone ────────────────────────────────────────────────────────────

function testNeutralZoneZeroSlope() {
    // Perfectly flat: last === past → slopePct=0
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.015, SMALL_OPTS);
    assert.strictEqual(result.isReady, true);
    assert.strictEqual(result.trend, 'NEUTRAL');
    assert.strictEqual(result.slopeOffset, 0);
    assert.strictEqual(result.confidence, 0);
}

function testNeutralZoneJustBelow() {
    // slopePct = 0.14%/bar < neutralZonePct=0.15% → still NEUTRAL
    const values = rampSeries(MIN_LEN, 100, 0.14);
    const result = computeAmaSlopeWeights(values, 0, { ...SMALL_OPTS, neutralZonePct: 0.15 });
    assert.strictEqual(result.trend, 'NEUTRAL');
    assert.strictEqual(result.slopeOffset, 0);
}

function testTrendJustAboveNeutralZone() {
    // slopePct = 0.16%/bar > neutralZonePct=0.15% → UP
    const values = rampSeries(MIN_LEN, 100, 0.16);
    const result = computeAmaSlopeWeights(values, 0, { ...SMALL_OPTS, neutralZonePct: 0.15 });
    assert.strictEqual(result.trend, 'UP');
    assert.ok(result.slopeOffset > 0, 'positive slopeOffset for UP trend');
}

// ─── Positive slope (up trend) ──────────────────────────────────────────────

function testPositiveSlopePartialSaturation() {
    // slopePct = 1.5%/bar, maxSlopePct = 3.0 → slopeOffset = (1.5/3.0)*0.5 = 0.25
    const values = rampSeries(MIN_LEN, 100, 1.5);
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.isReady, true);
    assert.strictEqual(result.trend, 'UP');
    assert.strictEqual(result.slopeOffset, 0.25);
    assert.strictEqual(result.confidence, 50);
}

function testPositiveSlopeFullSaturation() {
    // slopePct = 6%/bar > maxSlopePct=3.0 → clamped to 1 → slopeOffset=0.5
    const values = rampSeries(MIN_LEN, 100, 6);
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'UP');
    assert.strictEqual(result.slopeOffset, 0.5);
    assert.strictEqual(result.confidence, 100);
}

// ─── Negative slope (down trend) ────────────────────────────────────────────

function testNegativeSlopePartialSaturation() {
    // slopePct = -1.5%/bar, maxSlopePct=3.0 → slopeOffset = -0.25
    const values = rampSeries(MIN_LEN, 100, -1.5);
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'DOWN');
    assert.strictEqual(result.slopeOffset, -0.25);
    assert.strictEqual(result.confidence, 50);
}

function testNegativeSlopeFullSaturation() {
    const values = rampSeries(MIN_LEN, 100, -6);
    const opts = { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.strictEqual(result.trend, 'DOWN');
    assert.strictEqual(result.slopeOffset, -0.5);
    assert.strictEqual(result.confidence, 100);
}

// ─── Volatility penalty (symmetricDelta) ────────────────────────────────────
// New formula: symmetricDelta = -weightVariance^exponent * (scalePct / 100)
// Penalty is always ≤ 0: high ATR → lower weights (wider grid). Zero ATR → no effect.
// Threshold: |symmetricDelta| must be >= 0.1 (default) to apply, otherwise suppressed to 0.

function testZeroVolatilityNoPenalty() {
    // weightVariance=0 → pow(0, 0.5)=0 → symmetricDelta=0 (no penalty, no bonus)
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, opts);
    assert.strictEqual(result.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.5, buyW: 0.5 });
}

function testBelowVolatilityThresholdSuppressed() {
    // weightVariance=0.0025, exponent=0.5, scaleX=1.0 → sqrt(0.0025)=0.05 * 1.0 = 0.05 → delta=-0.05
    // |0.05| < 0.1 threshold → suppressed to 0
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.0025, opts);
    assert.strictEqual(result.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.5, buyW: 0.5 });
}

function testAtVolatilityThresholdPasses() {
    // weightVariance=0.01, exponent=0.5, scaleX=1.0 → sqrt(0.01)=0.1 * 1.0 = 0.1 → delta=-0.1
    // |0.1| >= 0.1 threshold → passes through
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.01, opts);
    assert.strictEqual(result.symmetricDelta, -0.10);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.40, buyW: 0.40 });
}

function testMidVolatilityPenalty() {
    // weightVariance=0.04, exponent=0.5, scaleX=1.0 → sqrt(0.04)=0.2 * 1.0 = 0.2 → delta=-0.2
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.04, opts);
    assert.strictEqual(result.symmetricDelta, -0.20);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.30, buyW: 0.30 });
}

function testHighVolatilityPenaltyMaxed() {
    // weightVariance=0.25, exponent=0.5, scaleX=1.0 → sqrt(0.25)=0.5 * 1.0 = 0.5 → delta=-0.5
    // Clamped to the configured symmetric shift bound.
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.25, opts);
    assert.strictEqual(result.symmetricDelta, -0.5);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.0, buyW: 0.0 });
}

function testVolatilityAboveMaxClamped() {
    // weightVariance=1.0 is already max (pow(1, 0.5) = 1), so same as testHighVolatilityPenaltyMaxed
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 1.0, opts);
    assert.strictEqual(result.symmetricDelta, -0.5);
}

function testVolatilityPenaltyNeverPositive() {
    // penalty is strictly ≤ 0 regardless of low ATR
    const opts = { ...HALF_POWER_VOL_OPTS };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, opts);
    assert.ok(result.symmetricDelta <= 0, 'volatility penalty must never be positive');
}

function testCustomVolatilityThreshold() {
    // Custom threshold=0.4: delta=-0.3 should be suppressed
    const opts = { ...HALF_POWER_VOL_OPTS, volatilityThreshold: 0.4 };
    // weightVariance=0.09 → sqrt(0.09)=0.3 * 1.0 = 0.3 → |0.3| < 0.4 → suppressed
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0.09, opts);
    assert.strictEqual(result.symmetricDelta, 0);
}

function testInvalidVolatilityThresholdFallsBackToDefaultThreshold() {
    const values = flatSeries(MIN_LEN, 100);

    const negative = computeAmaSlopeWeights(values, 0.0025, {
        ...HALF_POWER_VOL_OPTS,
        volatilityThreshold: -1,
    });
    assert.strictEqual(negative.symmetricDelta, 0, 'negative threshold should fall back to the default threshold');

    const nanValue = computeAmaSlopeWeights(values, 0.0025, {
        ...HALF_POWER_VOL_OPTS,
        volatilityThreshold: Number.NaN,
    });
    assert.strictEqual(nanValue.symmetricDelta, 0, 'NaN threshold should fall back to the default threshold');
}

function testInvalidWeightVarianceFallsBackToNoPenalty() {
    const opts = { ...SMALL_OPTS };

    const negative = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), -0.25, opts);
    assert.strictEqual(negative.symmetricDelta, 0, 'negative variance should be ignored');
    assert.deepStrictEqual(derivedWeights(negative), { sellW: 0.5, buyW: 0.5 });

    const nanValue = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), Number.NaN, opts);
    assert.strictEqual(nanValue.symmetricDelta, 0, 'NaN variance should be ignored');
    assert.deepStrictEqual(derivedWeights(nanValue), { sellW: 0.5, buyW: 0.5 });
}

function testInvalidMaxVolatilityOffsetFallsBackToDefaultClamp() {
    const opts = { ...SMALL_OPTS, maxVolatilityOffset: -0.25, volatilityThreshold: 0.01 };
    const result = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 1.0, opts);
    assert.strictEqual(result.symmetricDelta, -0.5, 'invalid clamp should fall back to the default symmetric cap');
    assert.ok(result.symmetricDelta <= 0, 'invalid clamp must not invert the volatility penalty');
}

// ─── Combined slope + volatility ─────────────────────────────────────────────

function testCombinedUptrendZeroVol() {
    // slopeOffset=+0.25 (partial UP), symmetricDelta=0 (no penalty at zero ATR)
    const values = rampSeries(MIN_LEN, 100, 1.5);
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const result = computeAmaSlopeWeights(values, 0, opts);
    assert.deepStrictEqual(derivedWeights(result), { sellW: 0.25, buyW: 0.75 });
}

function testCombinedUptrendHighVol() {
    // slopeOffset=+0.5 (full UP), weightVariance=0.04, exponent=0.5, scaleX=1.0 → delta=-0.2
    const values = rampSeries(MIN_LEN, 100, 6);
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const result = computeAmaSlopeWeights(values, 0.04, opts);
    assert.deepStrictEqual(derivedWeights(result), { sellW: -0.2, buyW: 0.8 });
}

function testClampAtMaxPenalty() {
    // Full UP slope (slopeOffset=0.5) + max penalty (symmetricDelta=-0.5)
    const values = rampSeries(MIN_LEN, 100, 6);
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const result = computeAmaSlopeWeights(values, 1.0, opts);
    assert.deepStrictEqual(derivedWeights(result), { sellW: -0.5, buyW: 0.5 });
}

// ─── Confidence derivation ────────────────────────────────────────────────────

function testConfidenceDerivation() {
    // slopeOffset=0 → confidence=0
    const r1 = computeAmaSlopeWeights(flatSeries(MIN_LEN, 100), 0, SMALL_OPTS);
    assert.strictEqual(r1.confidence, 0);

    // slopeOffset=0.5 (full) → confidence=100
    const values = rampSeries(MIN_LEN, 100, 6);
    const r2 = computeAmaSlopeWeights(values, 0.015, { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 });
    assert.strictEqual(r2.confidence, 100);

    // slopeOffset=0.25 (half) → confidence=50
    const values2 = rampSeries(MIN_LEN, 100, 1.5);
    const r3 = computeAmaSlopeWeights(values2, 0.015, { ...SMALL_OPTS, maxSlopePct: 3.0, neutralZonePct: 0.15 });
    assert.strictEqual(r3.confidence, 50);
}

function testZeroMaxSlopeOffsetKeepsConfidenceFinite() {
    const values = rampSeries(MIN_LEN, 100, 6);
    const result = computeAmaSlopeWeights(values, 0, {
        ...SMALL_OPTS,
        maxSlopePct: 3.0,
        neutralZonePct: 0.15,
        maxSlopeOffset: 0,
    });
    assert.strictEqual(result.slopeOffset, 0);
    assert.strictEqual(result.confidence, 0);
}

// ─── Volatility penalty table (exponent=0.5, scalePct=50) ───────────

function testNeutralSlopeVolatilityTable() {
    // exponent=0.5, scaleX=1.0: symmetricDelta = -weightVariance^0.5 * 1.0
    // threshold=0.1: penalty suppressed when |delta| < 0.1
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const flat = flatSeries(MIN_LEN, 100);

    // ATR/price = 0.00 → delta=0 → derived weights remain at neutral 0.50 / 0.50
    let r = computeAmaSlopeWeights(flat, 0.00, opts);
    assert.strictEqual(r.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.5, buyW: 0.5 });

    // ATR/price = 0.0025 → sqrt(0.0025)=0.05 * 1.0 = 0.05 → |0.05| < 0.1 → suppressed → neutral weights
    r = computeAmaSlopeWeights(flat, 0.0025, opts);
    assert.strictEqual(r.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.5, buyW: 0.5 });

    // ATR/price = 0.01 → sqrt(0.01)=0.1 * 1.0 = 0.1 → |0.1| >= 0.1 → delta=-0.10
    r = computeAmaSlopeWeights(flat, 0.01, opts);
    assert.strictEqual(r.symmetricDelta, -0.10);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.40, buyW: 0.40 });

    // ATR/price = 0.04 → sqrt(0.04)=0.2 * 1.0 = 0.2 → delta=-0.20
    r = computeAmaSlopeWeights(flat, 0.04, opts);
    assert.strictEqual(r.symmetricDelta, -0.20);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.30, buyW: 0.30 });

    // ATR/price = 0.25 → sqrt(0.25)=0.5 * 1.0 = 0.5 → delta=-0.5 (clamped)
    r = computeAmaSlopeWeights(flat, 0.25, opts);
    assert.strictEqual(r.symmetricDelta, -0.5);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.0, buyW: 0.0 });
}

function testUptrendSlopeOffsetTable() {
    // slopeOffset ≈ +0.33: slopePct = 2%/bar → slopeOffset = (2/3)*0.5 = 0.333... → 0.33 rounded
    const opts = { ...HALF_POWER_SLOPE_VOL_OPTS };
    const values = rampSeries(MIN_LEN, 100, 2);

    // ATR/price = 0.00 → delta=0 → derived weights reflect the 0.5 neutral center
    let r = computeAmaSlopeWeights(values, 0.00, opts);
    assert.strictEqual(r.slopeOffset, 0.33);
    // Huber reports the geometric per-bar rate: ln(1.02), not the arithmetic 2%.
    assert.ok(Math.abs(r.rawSlopeOffset - (Math.log(1.02) * 100 / 3) * 0.5) < 1e-12);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.17, buyW: 0.83 });

    // ATR/price = 0.0025 → suppressed → same as zero vol
    r = computeAmaSlopeWeights(values, 0.0025, opts);
    assert.strictEqual(r.symmetricDelta, 0);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.17, buyW: 0.83 });

    // ATR/price = 0.01 → delta=-0.10
    r = computeAmaSlopeWeights(values, 0.01, opts);
    assert.deepStrictEqual(derivedWeights(r), { sellW: 0.07, buyW: 0.73 });

    // ATR/price = 0.04 → delta=-0.20
    r = computeAmaSlopeWeights(values, 0.04, opts);
    assert.deepStrictEqual(derivedWeights(r), { sellW: -0.03, buyW: 0.63 });

    // ATR/price = 0.25 → delta=-0.5
    r = computeAmaSlopeWeights(values, 0.25, opts);
    assert.deepStrictEqual(derivedWeights(r), { sellW: -0.33, buyW: 0.33 });
}

// ─── AMA slope clip threshold (computeAmaSlopeClipThreshold / createAmaSlopeClipTracker) ──
// Regression coverage for the canonical clip logic consolidated into
// dynamic_weight_series.ts: batch/prefix parity, disabled + short-history edges,
// and the exact percentile semantics that bound rawSlopeOffset.

function seededSeries(n, seed = 12345) {
    // Deterministic LCG walk of positive prices (never 0, so the past===0 path
    // is exercised separately via the all-zero edge case).
    let s = seed;
    const out = [];
    for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        out.push(50 + (s % 3000) / 10);
    }
    return out;
}

function testClipThresholdDisabledOrShortHistoryReturnsInfinity() {
    const valid = [100, 110, 99, 121, 110, 132];
    assert.strictEqual(computeAmaSlopeClipThreshold(valid, 1, 1, 0), Infinity, 'clip=0 disables');
    assert.strictEqual(computeAmaSlopeClipThreshold(valid, 1, 1, -5), Infinity, 'negative clip disables');
    assert.strictEqual(computeAmaSlopeClipThreshold(valid, 1, 1, NaN), Infinity, 'NaN clip disables');
    assert.strictEqual(computeAmaSlopeClipThreshold(null, 1, 1, 10), Infinity, 'non-array input → Infinity');
    assert.strictEqual(computeAmaSlopeClipThreshold([100, 100, 100], 5, 5, 10), Infinity, 'below ER+lookback warmup → Infinity');
    assert.strictEqual(computeAmaSlopeClipThreshold([0, 0, 0, 0, 0, 0], 1, 1, 10), Infinity, 'empty slope pool (all zeros) → Infinity');
}

function testClipThresholdExactPercentile() {
    // erPeriod=1, lookbackBars=1 → a 2-point window, so the canonical Huber
    // slope is the geometric (log) per-bar change ln(cur/prev)*100.
    //   i=2: |ln(99/110)|*100  = 10.5360...
    //   i=3:  ln(121/99)*100   = 20.0671...
    //   i=4: |ln(110/121)|*100 = 9.5310...
    //   i=5:  ln(132/110)*100  = 18.2322...
    // sorted |slopes| = [9.5310..., 10.5360..., 18.2322..., 20.0671...]
    const values = [100, 110, 99, 121, 110, 132];

    const t90 = computeAmaSlopeClipThreshold(values, 1, 1, 90); // idx floor(0.1*4)=0
    assert.ok(Math.abs(t90 - Math.abs(Math.log(110 / 121) * 100)) < 1e-9, `90th pct expected ${Math.abs(Math.log(110 / 121) * 100)}%, got ${t90}`);

    const t40 = computeAmaSlopeClipThreshold(values, 1, 1, 40); // idx floor(0.6*4)=2
    assert.ok(Math.abs(t40 - Math.log(132 / 110) * 100) < 1e-9, `40th pct expected ${Math.log(132 / 110) * 100}%, got ${t40}`);

    const t20 = computeAmaSlopeClipThreshold(values, 1, 1, 20); // idx floor(0.8*4)=3
    assert.ok(Math.abs(t20 - Math.log(121 / 99) * 100) < 1e-9, `20th pct expected ${Math.log(121 / 99) * 100}%, got ${t20}`);
}

function testTrackerMatchesBatchAcrossPrefixes() {
    // Core parity: every incremental tracker threshold must equal the batch
    // function computed on the same prefix — including a NaN hole that
    // invalidates only its own pairs.
    const erPeriod = 10;
    const lb = 9;
    const series = seededSeries(200);
    series[137] = NaN;

    for (const pct of [0, 10, 25]) {
        const tracker = createAmaSlopeClipTracker(erPeriod, lb, pct);
        for (let k = 1; k <= series.length; k++) {
            const batch = computeAmaSlopeClipThreshold(series.slice(0, k), erPeriod, lb, pct);
            const track = tracker.push(series[k - 1]);
            assert.strictEqual(track, batch, `pct=${pct} bar=${k}: tracker ${track} != batch ${batch}`);
        }
    }
}

function testTrackerDisabledReturnsInfinity() {
    const tracker = createAmaSlopeClipTracker(5, 5, 0);
    assert.strictEqual(tracker.push(100), Infinity, 'disabled tracker always returns Infinity');
    assert.strictEqual(tracker.push(200), Infinity, 'disabled tracker always returns Infinity');
}

function testRollingWindowWeightsMatchFullPrefix() {
    // The research runners feed computeAmaSlopeWeights a rolling
    // ceil(erPeriod)+lookbackBars+1 window plus the prefix-only clip threshold.
    // Since the model reads only the last two bars and the clip is injected,
    // the rolling-window result must be identical to the full-prefix result.
    const erPeriod = 10;
    const lb = 9;
    const series = seededSeries(200);
    const windowBars = Math.ceil(erPeriod) + lb + 1;
    const opts = {
        erPeriod,
        lookbackBars: lb,
        maxSlopePct: 0.085,
        neutralZonePct: 0,
        volatilityExponent: 1,
        volatilityScaleX: 10,
        volatilityThreshold: 0.1,
        maxSlopeOffset: 0.5,
        maxVolatilityOffset: 0.5,
    };

    for (let k = 1; k <= series.length; k++) {
        const prefix = series.slice(0, k);
        const thresh = computeAmaSlopeClipThreshold(prefix, erPeriod, lb, 10);
        const full = computeAmaSlopeWeights(prefix, 0, { ...opts, clipThreshold: thresh });
        const slice = series.slice(Math.max(0, k - windowBars), k);
        const win = computeAmaSlopeWeights(slice, 0, { ...opts, clipThreshold: thresh });
        assert.strictEqual(win.isReady, full.isReady, `bar ${k}: readiness mismatch`);
        assert.strictEqual(win.rawSlopeOffset, full.rawSlopeOffset, `bar ${k}: rolling ${win.rawSlopeOffset} != full ${full.rawSlopeOffset}`);
    }
}

// ─── Huber-robust windowed slope (canonical estimator) ──────────────────────

function testHuberRampRecoversLogPerBarRate() {
    // A geometric ramp's log-return per bar is ln(1 + pct/100); the Huber
    // regression reports that x100, so it must match to machine precision.
    const up = rampSeries(60, 100, 0.5);
    const hu = computeHuberWindowSlopePct(up, up.length - 1, 20);
    assert.ok(hu != null && Math.abs(hu - Math.log(1.005) * 100) < 1e-6, `up ramp: ${hu}`);
    const down = rampSeries(60, 100, -0.5);
    const hd = computeHuberWindowSlopePct(down, down.length - 1, 20);
    assert.ok(hd != null && Math.abs(hd - Math.log(0.995) * 100) < 1e-6, `down ramp: ${hd}`);
}

function testHuberFlatSeriesZero() {
    const flat = computeHuberWindowSlopePct(flatSeries(60, 100), 59, 20);
    assert.ok(flat != null && Math.abs(flat) < 1e-9, `flat series slope must be ~0, got ${flat}`);
}

function testHuberSubduesSingleBarSpike() {
    // One +5% edge spike on an otherwise flat series: the two-point endpoint
    // reads ~0.25 %/bar, while Huber must stay far below it (bounded influence,
    // not full edge weight).
    const spike = flatSeries(60, 100);
    spike[59] = 105;
    const hu = computeHuberWindowSlopePct(spike, 59, 20);
    const endpoint = computeAverageAmaSlopePct(spike[59], spike[59 - 20], 20);
    assert.ok(hu != null, 'huber must return a value');
    assert.ok(hu >= 0, `spike up must not go negative: ${hu}`);
    assert.ok(Math.abs(hu) < Math.abs(endpoint) / 3, `huber ${hu} should be well below endpoint ${endpoint}`);
}

function testHuberTracksGeometricRateOnShallowRamp() {
    // A smooth ramp's log-return per bar is ln(1 + pct/100); the fit reports
    // that x100 once the whole window sits on the ramp.
    const ramp = rampSeries(60, 100, 0.3);
    const idx = ramp.length - 1;
    const hu = computeHuberWindowSlopePct(ramp, idx, 20);
    assert.ok(hu != null && Math.abs(hu - Math.log(1.003) * 100) < 1e-6, `huber ${hu}`);
}

function testHuberParamsAreCentralizedInConstants() {
    // The estimator defaults to MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER (injected
    // as AMA_SLOPE_HUBER in generated charts). Prove that block is the one in
    // use: the explicit constant matches the default, and an override is honored.
    const { MARKET_ADAPTER } = require('../modules/constants');
    const hub = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER;
    assert.ok(hub && Number.isFinite(hub.C) && Number.isFinite(hub.ITERATIONS)
        && Number.isFinite(hub.SCALE_FLOOR) && Number.isFinite(hub.ZERO_EPSILON),
        'DYNAMIC_WEIGHT_AMA_HUBER must expose C/ITERATIONS/SCALE_FLOOR/ZERO_EPSILON');

    const ramp = rampSeries(60, 100, 0.3);
    const withDefault = computeHuberWindowSlopePct(ramp, 59, 20);
    assert.strictEqual(computeHuberWindowSlopePct(ramp, 59, 20, hub), withDefault,
        'passing the centralized constant explicitly must match the default');
    assert.strictEqual(computeHuberWindowSlopePct(ramp, 59, 20, { C: hub.C }),
        withDefault, 'a partial hub must fill the missing fields from the constant');
    assert.strictEqual(computeHuberWindowSlopePct(ramp, 59, 20, { ...hub, ZERO_EPSILON: 1e9 }), 0,
        'overriding a centralized param must change the fit');
}

function testHuberRejectsUnusableWindow() {
    const hole = flatSeries(60, 100);
    hole[50] = 0; // non-positive inside the window
    assert.strictEqual(computeHuberWindowSlopePct(hole, 59, 20), null, 'non-positive value rejects');
    assert.strictEqual(computeHuberWindowSlopePct([], 0, 20), null, 'empty series rejects');
    assert.strictEqual(computeHuberWindowSlopePct(flatSeries(5, 100), 4, 20), null, 'index < bars rejects');
    assert.strictEqual(computeHuberWindowSlopePct(flatSeries(60, 100), 59, 0), null, 'bars < 1 rejects');
}

function testClipThresholdBindsSlopeOffset() {
    // slopePct ≈ 100% per bar; without a clip it saturates at maxSlopeOffset.
    const values = [100, 100, 100, 100, 100, 300];
    const base = { erPeriod: 2, lookbackBars: 2, maxSlopePct: 3.0, neutralZonePct: 0, maxSlopeOffset: 0.5 };

    const unclipped = computeAmaSlopeWeights(values, 0, base);
    assert.strictEqual(unclipped.rawSlopeOffset, 0.5, 'no clip → saturates at maxSlopeOffset');

    // clipThreshold=0.5 caps clippedSlopePct → slopeOffset = 0.5/3.0*0.5 = 1/12
    const clipped = computeAmaSlopeWeights(values, 0, { ...base, clipThreshold: 0.5 });
    assert.ok(Math.abs(clipped.rawSlopeOffset - (0.5 / 3.0 * 0.5)) < 1e-12, `got ${clipped.rawSlopeOffset}`);
    assert.strictEqual(clipped.slopeOffset, Math.round((0.5 / 3.0 * 0.5) * 100) / 100);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function run() {
    testNotReadyWhenTooFewValues();
    testAmaWarmupReturnsRollingSmaBeforeRecursiveSeed();
    testNotReadyOnEmptyArray();
    testNotReadyOnExactMinusOne();
    testReadyOnExactMinimum();
    testNeutralZoneZeroSlope();
    testNeutralZoneJustBelow();
    testTrendJustAboveNeutralZone();
    testPositiveSlopePartialSaturation();
    testPositiveSlopeFullSaturation();
    testNegativeSlopePartialSaturation();
    testNegativeSlopeFullSaturation();
    testZeroVolatilityNoPenalty();
    testBelowVolatilityThresholdSuppressed();
    testAtVolatilityThresholdPasses();
    testMidVolatilityPenalty();
    testHighVolatilityPenaltyMaxed();
    testVolatilityAboveMaxClamped();
        testVolatilityPenaltyNeverPositive();
        testCustomVolatilityThreshold();
        testInvalidVolatilityThresholdFallsBackToDefaultThreshold();
        testInvalidWeightVarianceFallsBackToNoPenalty();
        testInvalidMaxVolatilityOffsetFallsBackToDefaultClamp();
    testCombinedUptrendZeroVol();
    testCombinedUptrendHighVol();
    testClampAtMaxPenalty();
    testConfidenceDerivation();
    testZeroMaxSlopeOffsetKeepsConfidenceFinite();
    testNeutralSlopeVolatilityTable();
    testUptrendSlopeOffsetTable();
    testClipThresholdDisabledOrShortHistoryReturnsInfinity();
    testClipThresholdExactPercentile();
    testTrackerMatchesBatchAcrossPrefixes();
    testTrackerDisabledReturnsInfinity();
    testRollingWindowWeightsMatchFullPrefix();
    testClipThresholdBindsSlopeOffset();
    testHuberRampRecoversLogPerBarRate();
    testHuberFlatSeriesZero();
    testHuberSubduesSingleBarSpike();
    testHuberTracksGeometricRateOnShallowRamp();
    testHuberRejectsUnusableWindow();
    testHuberParamsAreCentralizedInConstants();
}

run()
    .then(() => console.log('ama_slope_model tests passed'))
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });
