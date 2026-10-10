'use strict';

/**
 * AMA-SLOPE-HUBER LOOKBACK BACKTEST
 *
 * Sweeps the Huber slope lookback window (MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
 * exposed as `lb` in the dynamic-weight research chart) from a low bound to a
 * high bound and reports the metrics that actually differ between windows:
 *
 *   LAG      — how late the causal slope signal confirms a regime change,
 *              measured two ways:
 *                priceLag  cross-correlation peak vs a centred slope of close
 *                          (total pipeline lag: AMA smoothing + slope window)
 *                amaLag    cross-correlation peak vs a centred slope of AMA
 *                          (slope-window group delay only)
 *                revLag    median bars from a sign flip in the centred AMA
 *                          slope until the causal slope confirms the new sign
 *   RESETS   — the market adapter's two grid-recentering triggers (drift ratchet
 *              + slope-delta, whitelist-gated), replayed bar-by-bar through the
 *              canonical `simulateGridResetSeries`: count, reason split, rate,
 *              gap distribution and whipsaw (back-to-back) resets
 *   NOISE    — slope standard deviation, bar-to-bar wobble (mean |Δslope|),
 *              second-difference energy, zero-crossing rate, saturation and
 *              neutral-zone occupancy, average absolute range tilt
 *
 * The reset replay uses the UNCLIPPED slope (clip only feeds the range tilt, it
 * never moves reset timing — see grid_reset_sim.ts), so `clipPercentile` is
 * passed as 0 for speed and the tilt metric is derived from the batch clip
 * threshold instead. Everything else is the production decision path.
 *
 * Data may be a single LP candle JSON or a directory of month shards
 * (market_adapter/data/lp/<pair>/) — shards are concatenated and de-duplicated
 * by timestamp, so overlapping chunk files are harmless.
 *
 * Usage:
 *   node dist/analysis/trend_detection/backtest_ama_slope_huber.js \
 *     --data market_adapter/data/lp/<market-pair> [--lookback 8:28:2]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateAMA, getAmaWarmupBars } from '../../market_adapter/core/strategies/ama.js';
import { computeAmaSlopeClipThreshold } from '../../market_adapter/core/strategies/dynamic_weight_series.js';
import { createHuberEstimator, type HuberScaleMode, type HuberEstimator } from './huber_scale_variants.js';
import { simulateGridResetSeries, GRID_RESET_BOOTSTRAP } from '../tradingview/grid_reset_sim.js';
import { normalizeCandle, range, median } from '../math_utils.js';
import { parseListOrRange } from '../bot_fitting/shared_utils.js';
import { getStorage } from '../../modules/storage/index.js';
import { PATHS } from '../../modules/paths.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';

const { readJSON, writeJSON } = getStorage();
const MA = MARKET_ADAPTER;

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type AmaDef = { name: string; er: number; fast: number; slow: number };

// ─── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Parse a lookback spec. Accepts the shared `a:b:s` / comma syntax but also
 * tolerates a DESCENDING range like `28:8:2` (which parseListOrRange rejects),
 * so both "8h..28h" and "28h..8h" phrasings work.
 */
function parseLookbacks(spec: string, fallback: number[]): number[] {
    const m = spec.match(/^(\d+):(\d+):([\d.]+)$/);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const step = Number(m[3]);
        if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(step) && step > 0 && a > b) {
            spec = `${b}:${a}:${step}`;
        }
    }
    return parseListOrRange(spec, fallback).map((v: number) => Math.round(v));
}

function parseArgs() {
    const args = process.argv.slice(2);
    const out = {
        dataPath: '' as string,
        amaName: MA.DEFAULT_AMA_KEY as string,
        er: null as number | null,
        fast: null as number | null,
        slow: null as number | null,
        lookbacks: [...range(8, 28, 2, 0)].map((v) => Math.round(v)).reverse(),
        priceThresholdPct: MA.AMA_DELTA_THRESHOLD_PERCENT,
        slopeThresholdFactor: MA.AMA_SLOPE_DELTA_THRESHOLD_PERCENT,
        slopeEnabled: true,
        slopePersistBars: MA.AMA_SLOPE_PERSIST_BARS,
        confirmFraction: 0.25,
        whipsawBars: 3,
        scaleMode: 'none' as HuberScaleMode,
        truthWindowBars: null as number | null,
        forwardWindowBars: null as number | null,
        outPath: null as string | null,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
        if (arg === '--no-slope') { out.slopeEnabled = false; continue; }
        const val = args[i + 1];
        if (!val) continue;
        switch (arg) {
            case '--data': out.dataPath = val; i++; break;
            case '--ama': out.amaName = val; i++; break;
            case '--er': out.er = Number(val); i++; break;
            case '--fast': out.fast = Number(val); i++; break;
            case '--slow': out.slow = Number(val); i++; break;
            case '--lookback': out.lookbacks = parseLookbacks(val, out.lookbacks); i++; break;
            case '--price-threshold': out.priceThresholdPct = Number(val); i++; break;
            case '--slope-threshold-factor': out.slopeThresholdFactor = Number(val); i++; break;
            case '--slope-persist': out.slopePersistBars = Math.max(1, Math.round(Number(val))); i++; break;
            case '--confirm': out.confirmFraction = Number(val); i++; break;
            case '--scale-mode':
                if (val !== 'none' && val !== 'df' && val !== 'mscale') throw new Error(`--scale-mode must be none|df|mscale (got '${val}')`);
                out.scaleMode = val; i++; break;
            case '--whipsaw': out.whipsawBars = Number(val); i++; break;
            case '--truth-window': out.truthWindowBars = Number(val); i++; break;
            case '--forward-window': out.forwardWindowBars = Number(val); i++; break;
            case '--out': out.outPath = path.resolve(val); i++; break;
        }
    }

    if (!out.dataPath) throw new Error('--data <path-to-lp-candles.json|dir> is required');
    if (!Array.isArray(out.lookbacks) || out.lookbacks.length === 0 || out.lookbacks.some((v) => !Number.isFinite(v) || v < 2)) {
        throw new Error('--lookback must resolve to a non-empty list of bars >= 2');
    }
    // De-duplicate and present high -> low so the table reads 28h..8h.
    out.lookbacks = [...new Set(out.lookbacks)].sort((a, b) => b - a);
    return out;
}

function printHelp() {
    console.log('AMA-Slope-Huber lookback backtest');
    console.log('');
    console.log('Usage: node dist/analysis/trend_detection/backtest_ama_slope_huber.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --data <path>                LP candle file or shard directory (required)');
    console.log(`  --ama <AMA1..AMA4>           Built-in AMA preset (default: ${MA.DEFAULT_AMA_KEY})`);
    console.log('  --er/--fast/--slow <n>       Override AMA periods (override --ama)');
    console.log('  --lookback <spec>            Lookback sweep in bars (default: 28h,26h,...,8h; also accepts 28:8:2 or 8:28:2)');
    console.log(`  --price-threshold <pct>      Drift reset threshold (default: ${MA.AMA_DELTA_THRESHOLD_PERCENT})`);
    console.log(`  --slope-threshold-factor <n> % of max slope for the slope reset (default: ${MA.AMA_SLOPE_DELTA_THRESHOLD_PERCENT})`);
    console.log(`  --slope-persist <bars>       Bars the slope delta must persist before resetting (default: ${MA.AMA_SLOPE_PERSIST_BARS})`);
    console.log('  --no-slope                   Disable the slope-delta reset (drift only)');
    console.log('  --confirm <frac>             Slope confirmation size as a fraction of max slope (default: 0.25)');
    console.log('  --scale-mode <mode>          Huber scale estimate: none (production) | df | mscale (default: none)');
    console.log('  --whipsaw <bars>             Back-to-back reset gap counted as a whipsaw (default: 3)');
    console.log('  --truth-window <bars>        Centred reference half-window (default: max lookback)');
    console.log('  --forward-window <bars>      Realized forward horizon for range tilt direction (default: lookback)');
    console.log('  --out <path>                 JSON output path');
}

function resolveAma(cfg: ReturnType<typeof parseArgs>): AmaDef {
    if (cfg.er != null || cfg.fast != null || cfg.slow != null) {
        const er = cfg.er ?? 781;
        const fast = cfg.fast ?? 5.2;
        const slow = cfg.slow ?? 83.6;
        return { name: `custom(er=${er},f=${fast},s=${slow})`, er, fast, slow };
    }
    const presets = MA.AMAS as Record<string, { erPeriod: number; fastPeriod: number; slowPeriod: number }>;
    const preset = presets[cfg.amaName];
    if (!preset) throw new Error(`Unknown AMA preset '${cfg.amaName}' (expected ${Object.keys(presets).join(', ')})`);
    return { name: cfg.amaName, er: preset.erPeriod, fast: preset.fastPeriod, slow: preset.slowPeriod };
}

// ─── Data loading ────────────────────────────────────────────────────────────

function loadCandles(input: string) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`Data path not found: ${resolved}`);
    const stat = fs.statSync(resolved);

    const files = stat.isDirectory()
        ? fs.readdirSync(resolved)
            .filter((name) => /\.json$/i.test(name) && !/manifest/i.test(name))
            .map((name) => path.join(resolved, name))
            .sort()
        : [resolved];

    const byTime = new Map<number, Candle>();
    let meta: Record<string, unknown> | null = null;
    for (const file of files) {
        let raw: { candles?: unknown; meta?: Record<string, unknown> } | null = null;
        try { raw = readJSON(file) as { candles?: unknown; meta?: Record<string, unknown> }; } catch { continue; }
        const arr = Array.isArray(raw?.candles) ? raw.candles : (Array.isArray(raw) ? raw : null);
        if (!arr || arr.length === 0) continue;
        if (!meta && raw?.meta) meta = raw.meta;
        for (const c of arr) {
            const n = normalizeCandle(c);
            if (n) byTime.set(n.time, { time: n.time, open: n.open, high: n.high, low: n.low, close: n.close, volume: n.volume });
        }
    }

    const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (candles.length === 0) throw new Error(`No candles found under ${resolved}`);
    return { candles, meta, files: files.length };
}

// ─── Small stats helpers ─────────────────────────────────────────────────────

function percentile(values: number[], pct: number): number | null {
    if (values.length === 0) return null;
    const s = values.slice().sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round((pct / 100) * (s.length - 1))));
    return s[idx];
}

function fmt(x: number | null | undefined, d = 2): string {
    return Number.isFinite(Number(x)) ? Number(x).toFixed(d) : 'n/a';
}

// ─── Lag estimators ──────────────────────────────────────────────────────────

/**
 * Cross-correlation peak lag between the causal signal and a reference.
 * Returns the smallest non-negative k maximising corr(sig[t], ref[t-k]).
 * A positive lag means `sig` trails `ref` by k bars (the smoother's group delay).
 */
function crossCorrelationLag(sig: (number | null)[], ref: (number | null)[], maxLag: number) {
    let bestLag = 0;
    let bestCorr = -Infinity;
    for (let k = 0; k <= maxLag; k++) {
        let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
        for (let t = k; t < sig.length; t++) {
            const x = sig[t];
            const y = ref[t - k];
            if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
            n++; sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
        }
        if (n < 100) continue;
        const mx = sx / n, my = sy / n;
        const vx = sxx / n - mx * mx;
        const vy = syy / n - my * my;
        const cov = sxy / n - mx * my;
        const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : -Infinity;
        if (corr > bestCorr) { bestCorr = corr; bestLag = k; }
    }
    return { lagBars: bestLag, corr: Number.isFinite(bestCorr) ? bestCorr : null };
}

/**
 * Median bars between a sign flip in the centred reference slope and the first
 * bar the causal slope confirms the new direction at or above `confirmPct`.
 * `misses` counts flips the causal slope never confirmed inside the window.
 */
function reversalLag(sig: (number | null)[], ref: (number | null)[], maxLag: number, confirmPct: number) {
    const lags: number[] = [];
    let flips = 0;
    let misses = 0;
    let prevSign = 0;
    for (let t = 1; t < ref.length; t++) {
        const v = ref[t];
        if (v == null || !Number.isFinite(v)) continue;
        const s = Math.sign(v);
        if (s !== 0 && prevSign !== 0 && s !== prevSign) {
            flips++;
            const end = Math.min(t + maxLag, sig.length - 1);
            let found = -1;
            for (let u = t + 1; u <= end; u++) {
                const x = sig[u];
                if (x != null && Number.isFinite(x) && Math.sign(x) === s && Math.abs(x) >= confirmPct) { found = u - t; break; }
            }
            if (found >= 0) lags.push(found); else misses++;
        }
        prevSign = s;
    }
    return { lagBars: median(lags), flips, misses, samples: lags.length };
}

// ─── Per-lookback computation ────────────────────────────────────────────────

function analyzeLookback(
    closes: number[],
    amaValues: number[],
    lookbackBars: number,
    amaDef: AmaDef,
    cfg: ReturnType<typeof parseArgs>,
    truthArr: (number | null)[],
    priceTruthArr: (number | null)[],
    truthHalf: number,
    estimator: HuberEstimator = createHuberEstimator('none'),
) {
    const n = closes.length;
    const warmupBars = getAmaWarmupBars(amaDef.er, amaDef.slow, 0, amaDef.fast);
    const maxSlopePct = MA.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
    const neutralZonePct = MA.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
    const maxSlopeOffset = MA.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
    const slopeDeltaThresholdPct = (cfg.slopeThresholdFactor / 100) * maxSlopePct;

    // Canonical production reset decision (clip-independent for timing).
    const sim = simulateGridResetSeries(amaValues, {
        priceDeltaThresholdPercent: cfg.priceThresholdPct,
        slopeDeltaThresholdPercent: slopeDeltaThresholdPct,
        slopeEnabled: cfg.slopeEnabled,
        erPeriod: amaDef.er,
        lookbackBars,
        warmupBars,
        maxSlopePct,
        neutralZonePct,
        maxSlopeOffset,
        clipPercentile: 0,
        slopePersistBars: cfg.slopePersistBars,
        slopeEstimator: estimator,
    });

    const slopeSeries = sim.slopePct as (number | null)[];
    const estStats = estimator.stats;
    const meanOutlierFraction = estStats.calls > 0 ? estStats.outlierFractionSum / estStats.calls : null;
    const meanHuberScale = estStats.calls > 0 ? estStats.scaleSum / estStats.calls : null;
    const liveBars = Math.max(1, n - warmupBars);

    // ── Noise / signal-quality metrics ──────────────────────────────────────
    let finite = 0, sumSigned = 0, sumAbs = 0, sumSq = 0;
    let prev: number | null = null;
    let deltaCount = 0, sumAbsDelta = 0;
    let prevDelta: number | null = null;
    let secondCount = 0, secondSq = 0;
    let zeroCross = 0, lastSign = 0;
    let saturated = 0, neutral = 0;
    for (let i = 0; i < n; i++) {
        const s = slopeSeries[i];
        if (s == null || !Number.isFinite(s)) { prev = null; prevDelta = null; continue; }
        finite++;
        sumSigned += s;
        sumAbs += Math.abs(s);
        sumSq += s * s;
        if (Math.abs(s) >= maxSlopePct) saturated++;
        if (Math.abs(s) <= neutralZonePct) neutral++;
        const sign = Math.sign(s);
        if (sign !== 0) {
            if (lastSign !== 0 && sign !== lastSign) zeroCross++;
            lastSign = sign;
        }
        if (prev != null) {
            const d = s - prev;
            sumAbsDelta += Math.abs(d);
            deltaCount++;
            if (prevDelta != null) { secondSq += (d - prevDelta) ** 2; secondCount++; }
            prevDelta = d;
        } else {
            prevDelta = null;
        }
        prev = s;
    }
    const meanAbsSlope = finite > 0 ? sumAbs / finite : 0;
    const meanSlope = finite > 0 ? sumSigned / finite : 0;
    const variance = finite > 0 ? Math.max(0, sumSq / finite - meanSlope * meanSlope) : 0;

    // ── Range tilt (batch clip threshold; only affects offset, not timing) ──
    const clipThreshold = computeAmaSlopeClipThreshold(amaValues, amaDef.er, lookbackBars, MA.DYNAMIC_WEIGHT_CLIP_PERCENTILE);
    let offsetCount = 0, offsetAbsSum = 0;
    for (let i = 0; i < n; i++) {
        const s = slopeSeries[i];
        if (s == null || !Number.isFinite(s)) continue;
        const clipped = Math.max(-clipThreshold, Math.min(clipThreshold, s));
        if (Math.abs(clipped) <= neutralZonePct) continue;
        offsetAbsSum += Math.abs(clipped / maxSlopePct) * maxSlopeOffset;
        offsetCount++;
    }

    // ── Lag metrics ─────────────────────────────────────────────────────────
    const maxLag = Math.max(1, lookbackBars * 2);
    const priceLag = crossCorrelationLag(slopeSeries, priceTruthArr, maxLag);
    const amaLag = crossCorrelationLag(slopeSeries, truthArr, maxLag);
    // The reversal search window is wider than the xcorr window: a slow AMA can
    // take well over one slope window to actually cross into a new regime.
    const revMaxLag = Math.max(maxLag, truthHalf * 3);
    const confirmPct = cfg.confirmFraction * meanAbsSlope;
    const rev = reversalLag(slopeSeries, truthArr, revMaxLag, confirmPct);

    // ── Reset metrics ───────────────────────────────────────────────────────
    const resetEvents = sim.events.filter((e: { reason?: unknown }) => e.reason !== GRID_RESET_BOOTSTRAP);
    const resetIdx = resetEvents.map((e: { index?: unknown }) => Number(e.index));
    const gaps: number[] = [];
    for (let k = 1; k < resetIdx.length; k++) gaps.push(resetIdx[k] - resetIdx[k - 1]);
    const whipsaws = gaps.filter((g) => g <= cfg.whipsawBars).length;
    const resetsPerDay = (sim.stats.resets / liveBars) * 24;
    const lastResetIndex = sim.stats.lastResetIndex;

    // ── Range-tilt wrong-way (applied tilt vs realized forward move) ────────
    // The band tilt only refreshes at resets, so the applied direction at bar t
    // is the sign of the slope sampled at the most recent reset. Wrong-way =
    // that applied direction points against the realized forward AMA move over
    // `forwardWindowBars`. Geometry-independent: the tilt sign is sign(slope).
    const forwardWindowCfg = Number(cfg.forwardWindowBars);
    const forwardWindowBars = Number.isFinite(forwardWindowCfg) && forwardWindowCfg > 0
        ? Math.round(forwardWindowCfg)
        : Math.max(1, lookbackBars);
    const eventIdx = new Set(sim.events.map((e: { index?: unknown }) => Number(e.index)));
    let curAppliedDir = 0;
    let evaluatedBars = 0, tiltActiveBars = 0, wrongWayBars = 0;
    let curWrongStreak = 0;
    const wrongStreaks: number[] = [];
    const adverseMoves: number[] = [];
    const closeStreak = () => { if (curWrongStreak > 0) { wrongStreaks.push(curWrongStreak); curWrongStreak = 0; } };
    for (let i = 0; i < n; i++) {
        if (eventIdx.has(i)) {
            const s = slopeSeries[i];
            curAppliedDir = (s != null && Number.isFinite(s) && Math.abs(s) > neutralZonePct) ? Math.sign(s) : 0;
        }
        const fwdEnd = i + forwardWindowBars;
        if (i < warmupBars || fwdEnd >= n) { closeStreak(); continue; }
        const a0 = amaValues[i], a1 = amaValues[fwdEnd];
        if (!Number.isFinite(a0) || a0 <= 0 || !Number.isFinite(a1)) { closeStreak(); continue; }
        const fwdPct = ((a1 - a0) / a0) * 100;
        const fwdDir = Math.sign(fwdPct);
        if (fwdDir === 0) { closeStreak(); continue; }
        evaluatedBars++;
        if (curAppliedDir !== 0) {
            tiltActiveBars++;
            if (fwdDir !== curAppliedDir) { wrongWayBars++; curWrongStreak++; adverseMoves.push(Math.abs(fwdPct)); }
            else closeStreak();
        } else {
            closeStreak();
        }
    }
    closeStreak();

    return {
        lookbackBars,
        huberScaleMode: cfg.scaleMode,
        meanOutlierFractionPct: meanOutlierFraction == null ? null : meanOutlierFraction * 100,
        meanHuberScale,
        // lag
        priceLagBars: priceLag.lagBars,
        priceLagCorr: priceLag.corr,
        amaLagBars: amaLag.lagBars,
        amaLagCorr: amaLag.corr,
        reversalLagBars: rev.lagBars,
        reversalFlips: rev.flips,
        reversalMisses: rev.misses,
        // resets
        resets: sim.stats.resets,
        resetsTotal: sim.stats.resetsTotal,
        priceResets: sim.stats.priceResets,
        slopeResets: sim.stats.slopeResets,
        resetsPerDay,
        avgBarsBetweenResets: gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
        medianBarsBetweenResets: median(gaps),
        p90BarsBetweenResets: percentile(gaps, 90),
        minBarsBetweenResets: gaps.length > 0 ? Math.min(...gaps) : null,
        whipsawResets: whipsaws,
        whipsawPct: gaps.length > 0 ? (whipsaws / gaps.length) * 100 : 0,
        gridAgeSinceLastResetBars: lastResetIndex == null ? null : n - 1 - lastResetIndex,
        // noise / quality
        meanAbsSlopePct: meanAbsSlope,
        slopeStdPct: Math.sqrt(variance),
        slopeWobblePct: deltaCount > 0 ? sumAbsDelta / deltaCount : 0,
        secondDiffEnergy: secondCount > 0 ? secondSq / secondCount : 0,
        zeroCrossPer1k: finite > 0 ? (zeroCross / finite) * 1000 : 0,
        saturationPct: finite > 0 ? (saturated / finite) * 100 : 0,
        neutralPct: finite > 0 ? (neutral / finite) * 100 : 0,
        avgAbsRangeOffset: offsetCount > 0 ? offsetAbsSum / offsetCount : 0,
        offsetActivePct: finite > 0 ? (offsetCount / finite) * 100 : 0,
        // range-tilt wrong-way
        forwardWindowBars,
        rangeWrongWayPct: tiltActiveBars > 0 ? (wrongWayBars / tiltActiveBars) * 100 : null,
        rangeTiltActivePct: evaluatedBars > 0 ? (tiltActiveBars / evaluatedBars) * 100 : null,
        meanWrongStreakBars: wrongStreaks.length > 0 ? wrongStreaks.reduce((a, b) => a + b, 0) / wrongStreaks.length : null,
        medianAdverseMoveWhileWrongPct: median(adverseMoves),
        p90AdverseMoveWhileWrongPct: percentile(adverseMoves, 90),
        // context
        warmupBars,
        finiteSlopeBars: finite,
    };
}

// ─── Composite recommendation ────────────────────────────────────────────────

function normalize(values: number[]): (v: number) => number {
    const finite = values.filter((v) => Number.isFinite(v));
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    return (v: number) => (hi > lo ? (v - lo) / (hi - lo) : 0);
}

type LookbackResult = ReturnType<typeof analyzeLookback> & { compositeScore?: number };

function addCompositeScore(results: LookbackResult[]) {
    const lagVals = results.map((r) => (r.reversalLagBars ?? r.amaLagBars) as number);
    const resetVals = results.map((r) => r.resetsPerDay as number);
    const wobbleVals = results.map((r) => r.slopeWobblePct as number);
    const nLag = normalize(lagVals);
    const nReset = normalize(resetVals);
    const nWobble = normalize(wobbleVals);
    for (const r of results) {
        const lag = (r.reversalLagBars ?? r.amaLagBars) as number;
        const freshness = 1 - nLag(lag);
        const stability = 1 - nReset(r.resetsPerDay);
        const smoothness = 1 - nWobble(r.slopeWobblePct);
        r.compositeScore = (freshness + stability + smoothness) / 3;
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function run() {
    const cfg = parseArgs();
    const amaDef = resolveAma(cfg);
    const { candles, meta, files } = loadCandles(cfg.dataPath);
    const closes = candles.map((c) => c.close);
    const n = closes.length;

    const amaValues = calculateAMA(closes, { erPeriod: amaDef.er, fastPeriod: amaDef.fast, slowPeriod: amaDef.slow });
    const warmupBars = getAmaWarmupBars(amaDef.er, amaDef.slow, 0, amaDef.fast);

    const maxLookback = Math.max(...cfg.lookbacks);
    const truthHalf = cfg.truthWindowBars ?? maxLookback;
    // Centred Huber slope (uses future bars) — the zero-lag reference the causal
    // slope is correlated against. Half-window is shared across lookbacks so
    // lag differences come from the causal window, not the reference.
    const amaTruth: (number | null)[] = new Array(n).fill(null);
    const priceTruth: (number | null)[] = new Array(n).fill(null);
    const truthEstimator = createHuberEstimator(cfg.scaleMode);
    for (let t = truthHalf; t <= n - 1 - truthHalf; t++) {
        const a = truthEstimator(amaValues, t + truthHalf, truthHalf * 2);
        if (a != null && Number.isFinite(a)) amaTruth[t] = a as number;
        const p = truthEstimator(closes, t + truthHalf, truthHalf * 2);
        if (p != null && Number.isFinite(p)) priceTruth[t] = p as number;
    }

    console.log('================================================================================');
    console.log(' AMA-SLOPE-HUBER LOOKBACK BACKTEST');
    console.log('================================================================================');
    console.log(`  Data:       ${path.resolve(cfg.dataPath)}`);
    console.log(`              ${files} file(s), ${n} candles, ${((n * Number(meta?.intervalSeconds ?? 3600)) / 86400).toFixed(0)} days`);
    console.log(`  AMA:        ${amaDef.name} (er=${amaDef.er}, fast=${amaDef.fast}, slow=${amaDef.slow}), warmup ${warmupBars} bars`);
    console.log(`  Lookbacks:  ${cfg.lookbacks.join(', ')} bars (${cfg.lookbacks.length} windows)`);
    console.log(`  Resets:     drift >= ${cfg.priceThresholdPct}% | slope delta >= ${fmt((cfg.slopeThresholdFactor / 100) * MA.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT, 4)}%/bar` +
        ` (${cfg.slopeThresholdFactor}% of max ${MA.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT})${cfg.slopeEnabled ? '' : ' [OFF]'} | persist K=${cfg.slopePersistBars}`);
    console.log(`  Reference:  centred Huber slope, half-window ${truthHalf} bars`);
    console.log(`  Huber:      scale mode = ${cfg.scaleMode}`);
    console.log(`  Confirm:    |slope| >= ${cfg.confirmFraction} x each window's mean |slope| (per-window gate)`);
    console.log('');

    const results: LookbackResult[] = [];
    for (const lb of cfg.lookbacks) {
        const estimator = createHuberEstimator(cfg.scaleMode);
        const r = analyzeLookback(closes, amaValues, lb, amaDef, cfg, amaTruth, priceTruth, truthHalf, estimator);
        results.push(r);
        process.stdout.write(`  lb=${String(lb).padStart(2)}  resets=${String(r.resets).padStart(4)}  ` +
            `lag(ama)=${fmt(r.amaLagBars, 0).padStart(3)}  rev=${fmt(r.reversalLagBars, 1).padStart(5)}  ` +
            `wobble=${fmt(r.slopeWobblePct, 4)}  zc/1k=${fmt(r.zeroCrossPer1k, 1)}\n`);
    }
    addCompositeScore(results);

    // ── Metric table ────────────────────────────────────────────────────────
    console.log('\n================================================================================');
    console.log(' PER-LOOKBACK METRICS');
    console.log('================================================================================');
    console.log(' lb | resets rs/day | price slope | medGap p90 | whip% | lagP lagA | revLag |  std   wobble  zc/1k | sat% | comp');
    console.log('----+--------------+-------------+------------+-------+---------+--------+-----------------------+------+-----');
    for (const r of results) {
        console.log(
            ` ${String(r.lookbackBars).padStart(2)} | ` +
            `${String(r.resets).padStart(6)} ${fmt(r.resetsPerDay, 1).padStart(6)} | ` +
            `${String(r.priceResets).padStart(5)} ${String(r.slopeResets).padStart(5)} | ` +
            `${fmt(r.medianBarsBetweenResets, 0).padStart(6)} ${fmt(r.p90BarsBetweenResets, 0).padStart(4)} | ` +
            `${fmt(r.whipsawPct, 0).padStart(5)} | ` +
            `${fmt(r.priceLagBars, 0).padStart(4)} ${fmt(r.amaLagBars, 0).padStart(4)} | ` +
            `${fmt(r.reversalLagBars, 1).padStart(6)} | ` +
            `${fmt(r.slopeStdPct, 4).padStart(6)} ${fmt(r.slopeWobblePct, 4).padStart(7)} ${fmt(r.zeroCrossPer1k, 1).padStart(6)} | ` +
            `${fmt(r.saturationPct, 0).padStart(4)} | ` +
            `${fmt(r.compositeScore, 3)}`
        );
    }

    console.log('\n  Correlation strength at the peak (higher = more reliable lag estimate):');
    console.log('  lb | priceCorr | amaCorr | reversalFlips | reversalMisses | offsetActive% | avg|offset|');
    console.log('  ---+-----------+---------+---------------+----------------+---------------+------------');
    for (const r of results) {
        console.log(
            `  ${String(r.lookbackBars).padStart(2)} | ` +
            `${fmt(r.priceLagCorr, 3).padStart(9)} | ` +
            `${fmt(r.amaLagCorr, 3).padStart(7)} | ` +
            `${String(r.reversalFlips).padStart(13)} | ` +
            `${String(r.reversalMisses).padStart(14)} | ` +
            `${fmt(r.offsetActivePct, 1).padStart(13)} | ` +
            `${fmt(r.avgAbsRangeOffset, 4).padStart(12)}`
        );
    }

    console.log(`\n  Huber scale mode: ${cfg.scaleMode}  (outlier = |residual| > C x scale)`);
    console.log('  lb | mean outlier% | mean scale (log units)');
    console.log('  ---+---------------+----------------------');
    for (const r of results) {
        console.log(
            `  ${String(r.lookbackBars).padStart(2)} | ` +
            `${fmt(r.meanOutlierFractionPct, 2).padStart(13)} | ` +
            `${fmt(r.meanHuberScale, 5).padStart(20)}`
        );
    }

    console.log('\n  Range-tilt wrong-way (applied tilt vs realized forward AMA move):');
    console.log('  var    | tiltActive% | wrongWay% | meanWrongRun | medAdverse | p90Adverse');
    console.log('  -------+-------------+-----------+--------------+------------+-----------');
    for (const r of results) {
        console.log(
            `  ${String(r.lookbackBars).padStart(5)} | ` +
            `${fmt(r.rangeTiltActivePct, 1).padStart(11)} | ` +
            `${fmt(r.rangeWrongWayPct, 1).padStart(9)} | ` +
            `${fmt(r.meanWrongStreakBars, 1).padStart(12)} | ` +
            `${fmt(r.medianAdverseMoveWhileWrongPct, 2).padStart(10)} | ` +
            `${fmt(r.p90AdverseMoveWhileWrongPct, 2).padStart(10)}`
        );
    }

    // ── Sweet spot (heuristic) ──────────────────────────────────────────────
    const ranked = results.slice().sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
    const winner = ranked[0];
    console.log('\n================================================================================');
    console.log(' HEURISTIC SWEET SPOT');
    console.log('================================================================================');
    console.log('  Composite = equal-weight mean of (low reversal lag, low reset rate, low wobble),');
    console.log('  each min-max normalised across the swept lookbacks. Not a P&L objective —');
    console.log('  use the per-metric table to trade lag against reset churn for your own fill model.');
    console.log(`\n  lb=${winner.lookbackBars}: lagA=${fmt(winner.amaLagBars, 0)} revLag=${fmt(winner.reversalLagBars, 1)} ` +
        `resets/day=${fmt(winner.resetsPerDay, 1)} wobble=${fmt(winner.slopeWobblePct, 4)} score=${fmt(winner.compositeScore, 3)}`);

    // ── Persist ─────────────────────────────────────────────────────────────
    const base = path.basename(path.resolve(cfg.dataPath)).replace(/\.json$/i, '');
    const outPath = cfg.outPath ?? path.join(PATHS.ANALYSIS.RESULTS_DIR, `ama_slope_huber_lookback_${base}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    writeJSON(outPath, {
        meta: {
            generatedAt: new Date().toISOString(),
            dataPath: path.relative(process.cwd(), path.resolve(cfg.dataPath)),
            files,
            candles: n,
            ama: amaDef,
            warmupBars,
            lookbacks: cfg.lookbacks,
            slopePersistBars: cfg.slopePersistBars,
            huberScaleMode: cfg.scaleMode,
            resetConfig: {
                priceDeltaThresholdPercent: cfg.priceThresholdPct,
                slopeDeltaThresholdPercent: (cfg.slopeThresholdFactor / 100) * MA.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
                slopeThresholdFactor: cfg.slopeThresholdFactor,
                slopeEnabled: cfg.slopeEnabled,
                maxSlopePct: MA.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
                neutralZonePct: MA.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
                clipPercentile: MA.DYNAMIC_WEIGHT_CLIP_PERCENTILE,
            },
            lagConfig: {
                reference: `centred Huber slope, half-window ${truthHalf} bars`,
                confirmPct: `${cfg.confirmFraction} x each window's mean |slope|`,
            },
            whipsawBars: cfg.whipsawBars,
            notes: 'Reset replay uses the canonical simulateGridResetSeries decision path (unclipped slope — clip only affects range tilt). Lag is a cross-correlation group-delay estimate; reversalLag is the median bars from a sign flip in the centred AMA slope to causal confirmation.',
        },
        results,
        sweetSpot: winner,
    });
    console.log(`\nSaved: ${path.relative(process.cwd(), outPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { run(); } catch (err) { console.error(err); process.exit(1); }
}

export { loadCandles }
