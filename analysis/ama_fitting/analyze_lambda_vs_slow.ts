#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateAMA } from '../../market_adapter/core/strategies/ama.js';
import { loadLpDataFile } from '../../market_adapter/lp_chart_runner.js';
import { ensureDir } from '../../modules/order/utils/system.js';
import { PATHS } from '../../modules/paths.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { uplotInlineTags } from '../chart_utils.js';
import { geometricRange } from '../math_utils.js';

/**
 * LAMBDA vs SLOW ANALYSIS
 *
 * Fixes ER and Fast, then scans lambda values over a linear range.
 * For each lambda, finds the optimal Slow period that minimizes
 * score = amaMovementTotal + lambda * distanceTotal.
 *
 * The start lambda is derived from --maxSlow: finds the lambda at
 * which the optimal slow first drops below maxSlow. Only --lambdaEnd
 * needs to be set as the upper bound.
 *
 * Output: console table + interactive HTML chart (uPlot).
 *
 * Defaults: ER/Fast from MARKET_ADAPTER.AMAS.AMA1 (constants.ts).
 *
 * Usage:
 *   node dist/analysis/ama_fitting/analyze_lambda_vs_slow.js \
 *     --data market_adapter/data/lp/1_3_5537_1_3_0/lp_pool_133_1h_3y.json \
 *     --maxSlow 1000 --lambdaEnd 0.0045 --lambdaSteps 50
 */



const DEFAULT_ER = MARKET_ADAPTER.AMAS.AMA1.erPeriod;
const DEFAULT_FAST = MARKET_ADAPTER.AMAS.AMA1.fastPeriod;

// ── CLI ────────────────────────────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
    const out: {
        dataFile: string | null;
        fixEr: number;
        fixFast: number;
        maxSlow: number;
        lambdaEnd: number;
        lambdaSteps: number;
        outFile: string | null;
    } = {
        dataFile: null,
        fixEr: DEFAULT_ER,
        fixFast: DEFAULT_FAST,
        maxSlow: 1000,
        lambdaEnd: 0.0045,
        lambdaSteps: 50,
        outFile: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i], v = argv[i + 1];
        switch (a) {
            case '--data': out.dataFile = v; i++; break;
            case '--fixEr': out.fixEr = Number(v); i++; break;
            case '--fixFast': out.fixFast = Number(v); i++; break;
            case '--maxSlow': out.maxSlow = Number(v); i++; break;
            case '--lambdaEnd': out.lambdaEnd = Number(v); i++; break;
            case '--lambdaSteps': out.lambdaSteps = Math.floor(Number(v)); i++; break;
            case '--out': case '--output': out.outFile = v; i++; break;
            case '--help': case '-h': showHelp(); process.exit(0);
        }
    }
    if (!out.dataFile) throw new Error('--data <file> is required');
    return out;
}

function showHelp() {
    console.log(`
Lambda vs Slow Analysis
  Fixes ER + Fast, varies lambda, finds optimal Slow per lambda.
  Start lambda derived from --maxSlow; only --lambdaEnd is the upper bound.

Usage:
  node dist/analysis/ama_fitting/analyze_lambda_vs_slow.js --data <lp-file.json> [options]

Options:
  --data FILE          LP candle JSON file (required)
  --fixEr N            Fixed ER period (default: ${DEFAULT_ER})
  --fixFast N          Fixed Fast period (default: ${DEFAULT_FAST})
  --maxSlow N          Max slow value; start lambda derived from it (default: 1000)
  --lambdaEnd N        End lambda / distanceWeight (default: 0.0045)
  --lambdaSteps N      Number of lambda steps (default: 50)
  --output FILE        Output HTML chart path (optional)
  --help               Show this help
`);
}

// ── Metrics ─────────────────────────────────────────────────────────────────────

interface MetricEntry {
    slow: number;
    movement: number;
    distance: number;
}

interface BestEntry extends MetricEntry {
    score: number;
    lambda: number;
}

function calcTotalAmaMovement(amaValues: number[], erPeriod: number): number {
    const skip = erPeriod + 1;
    let total = 0;
    for (let i = skip + 1; i < amaValues.length; i++) {
        total += Math.abs(amaValues[i] - amaValues[i - 1]) / amaValues[i - 1];
    }
    return total;
}

function calcTotalRelativeDistance(amaValues: number[], candles: Array<{ close: number }>, erPeriod: number): number {
    const skip = erPeriod + 1;
    let total = 0;
    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        total += Math.abs(candles[i].close - ama) / ama;
    }
    return total;
}

// ── Precompute (movement, distance) per slow ───────────────────────────────────

function precomputeMetrics(closes: number[], candles: Array<{ close: number }>, erPeriod: number, fastPeriod: number, slowValues: number[]): MetricEntry[] {
    const cache: MetricEntry[] = [];
    for (const slow of slowValues) {
        if (fastPeriod >= slow) continue;
        const ama = calculateAMA(closes, { erPeriod, fastPeriod, slowPeriod: slow });
        const movement = calcTotalAmaMovement(ama, erPeriod);
        const distance = calcTotalRelativeDistance(ama, candles, erPeriod);
        cache.push({ slow, movement, distance });
    }
    return cache;
}

function findBestForLambda(lambda: number, metricCache: MetricEntry[]): BestEntry | null {
    let best: BestEntry | null = null;
    for (const m of metricCache) {
        const score = m.movement + lambda * m.distance;
        if (!best || score < best.score) {
            best = { slow: m.slow, movement: m.movement, distance: m.distance, score, lambda };
        }
    }
    return best;
}

// ── Derive start lambda from maxSlow ───────────────────────────────────────────
// Binary search: find the smallest lambda where optimal slow < maxSlow.

function findStartLambda(metricCache: MetricEntry[], maxSlow: number, lambdaEnd: number): number | null {
    let lo = 0;
    let hi = 1;
    // Expand hi until the best slow drops below maxSlow
    while ((findBestForLambda(hi, metricCache)?.slow ?? Infinity) >= maxSlow && hi < 1e6) hi *= 2;
    if (hi >= 1e6) return null;

    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const best = findBestForLambda(mid, metricCache);
        if (best && best.slow < maxSlow) hi = mid;
        else lo = mid;
    }
    // When cache max equals maxSlow, hi converges near 0 — ensure a minimum gap
    if (hi < lambdaEnd / 1e6) hi = lambdaEnd / 1000;
    return hi;
}

// ── HTML Chart (λ → Slow) ──────────────────────────────────────────────────────

function generateChartHtml(results: BestEntry[], metricCache: MetricEntry[], fixEr: number, fixFast: number, dataLabel: string): string {
    const xs = results.map((r) => r.lambda);
    const ys = results.map((r) => r.slow);
    const dist = results.map((r) => r.distance);
    const move = results.map((r) => r.movement);
    const cacheSlow = metricCache.map((m) => m.slow);
    const cacheMove = metricCache.map((m) => m.movement);

    const amaAnnotations = [
        { label: 'AMA1', lambda: 0.0031, slow: 62.1, color: '#ef5350' },
        { label: 'AMA2', lambda: 0.0025, slow: 72.0, color: '#fb8c00' },
        { label: 'AMA3', lambda: 0.00185, slow: 83.6, color: '#5c9ee6' },
        { label: 'AMA4', lambda: 0.0013, slow: 96.9, color: '#26a69a' },
    ].filter(a => a.lambda >= xs[0] && a.lambda <= xs[xs.length - 1]);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>λ → Slow — ER=${fixEr} Fast=${fixFast}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 20px; background: #1e1e2e; color: #cdd6f4; }
  h1 { font-size: 16px; margin: 0 0 2px 0; }
  .subtitle { color: #a6adc8; font-size: 12px; margin-bottom: 12px; }
  .chart-wrap { background: #181825; padding: 20px; border-radius: 8px; display: inline-block; min-width: 1140px; }
  .chart-row { display: flex; gap: 8px; flex-direction: column; }
  .legend { display: flex; gap: 20px; margin: 10px 0; font-size: 12px; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .legend-line { width: 16px; height: 2px; display: inline-block; }
</style>
</head>
<body>
<div class="chart-wrap">
  <h1>λ (distanceWeight) Analysis</h1>
  <div class="subtitle">${dataLabel} · ER=${fixEr} · Fast=${fixFast} · ${results.length} λ steps</div>
  <div class="chart-row">
    <div id="chart-slow"></div>
    <div id="chart-dist"></div>
    <div id="chart-compare"></div>
  </div>
  <div class="legend">
    <span class="legend-item"><span class="legend-line" style="background:#26a69a"></span> Slow</span>
    <span class="legend-item"><span class="legend-line" style="background:#fb8c00"></span> Movement (λ)</span>
<span class="legend-item"><span class="legend-line" style="background:#5c9ee6"></span> Movement (Slow)</span>
${amaAnnotations.map(a => `<span class="legend-item"><span class="legend-dot" style="background:${a.color}"></span> ${a.label}</span>`).join('\n')}
  </div>
</div>
${uplotInlineTags()}
<script>
(function() {
  const xs = ${JSON.stringify(xs)};
  const slow = ${JSON.stringify(ys)};
  const dist = ${JSON.stringify(dist)};
  const move = ${JSON.stringify(move)};
  const cacheSlow = ${JSON.stringify(cacheSlow)};
  const cacheMove = ${JSON.stringify(cacheMove)};

  const slowOpts = {
    width: 1100, height: 440,
    cursor: { drag: { x: true, y: true } },
    select: { show: true },
    legend: { show: true },
    axes: [
      { label: "λ", stroke: "#cdd6f4", grid: { stroke: "rgba(205,214,244,0.06)" }, size: 50 },
      { label: "Slow Period", stroke: "#cdd6f4", grid: { stroke: "rgba(205,214,244,0.06)" }, size: 50 },
    ],
    series: [
      { label: "λ" },
      { label: "Slow", stroke: "#26a69a", width: 2, fill: "rgba(38,166,154,0.06)", points: { show: false } },
    ],
    scales: { x: { time: false }, y: { range: [10, null] } },
  };
  new uPlot(slowOpts, [xs, slow], document.getElementById('chart-slow'));

  const moveOpts = {
    width: 1100, height: 280,
    cursor: { drag: { x: true, y: true } },
    select: { show: true },
    legend: { show: true },
    axes: [
      { label: "λ", stroke: "#cdd6f4", grid: { stroke: "rgba(205,214,244,0.06)" }, size: 50 },
      { label: "AMA Movement (path length)", stroke: "#cdd6f4", grid: { stroke: "rgba(205,214,244,0.06)" }, size: 50 },
    ],
    series: [
      { label: "λ" },
      { label: "Movement", stroke: "#fb8c00", width: 2, points: { show: false } },
    ],
    scales: { x: { time: false }, y: { range: [0, null] } },
  };
  new uPlot(moveOpts, [xs, move], document.getElementById('chart-dist'));

  try {
    new uPlot({
      width: 1100, height: 300,
      cursor: { drag: { x: true, y: true } },
      select: { show: true },
      legend: { show: true },
      axes: [
        { label: "Slow Period", stroke: "#cdd6f4", grid: { stroke: "rgba(205,214,244,0.06)" }, size: 50 },
        { label: "AMA Movement (path length)", stroke: "#cdd6f4", grid: { stroke: "rgba(205,214,244,0.06)" }, size: 50 },
      ],
      series: [
        { label: "Slow" },
      { label: "Movement", stroke: "#5c9ee6", width: 2, points: { show: false } },
      ],
      scales: { x: { time: false }, y: { range: [0, null] } },
    }, [cacheSlow, cacheMove], document.getElementById('chart-compare'));
  } catch(e) {
    const el = document.getElementById('chart-compare');
    el.textContent = 'Chart error: ' + e.message;
    el.style.color = '#ef5350';
  }
})();
</script>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function run() {
    const cfg = parseArgs();

    // Load data
    const dataFile = cfg.dataFile!;
    const loaded = loadLpDataFile(path.resolve(dataFile));
    const candles = loaded.candleObjects;
    const meta = loaded.meta;
    const dataLabel = meta
        ? `LP Pool ${meta.pool} (${meta.assetA?.symbol || '?'}/${meta.assetB?.symbol || '?'})`
        : path.basename(dataFile);
    const closes = candles.map(c => c.close);

    console.log('══════════════════════════════════════════════════════════');
    console.log(' Lambda vs Slow Analysis');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  Data:        ${cfg.dataFile} (${candles.length} candles)`);
    console.log(`  Fixed:       ER=${cfg.fixEr}  Fast=${cfg.fixFast}`);
    console.log(`  MaxSlow:     ${cfg.maxSlow}`);
    console.log(`  Lambda end:  ${cfg.lambdaEnd}  (${cfg.lambdaSteps} steps)`);
    console.log('');

    // Build internal slow range (geometric, extends past maxSlow)
    const internalSlowMax = cfg.maxSlow;
    const internalSlowCount = Math.max(200, Math.ceil(internalSlowMax / 2.5));
    const slowValues = geometricRange(10, internalSlowMax, internalSlowCount);

    // Precompute movement + distance per slow (once)
    console.log('  Precomputing AMA metrics per slow value...');
    const metricCache = precomputeMetrics(closes, candles, cfg.fixEr, cfg.fixFast, slowValues);
    console.log(`  Cached ${metricCache.length} slow profiles`);

    // Derive start lambda from maxSlow
    const lambdaStart = findStartLambda(metricCache, cfg.maxSlow, cfg.lambdaEnd);
    if (lambdaStart === null) {
        console.log('  Could not determine start lambda — maxSlow too low.');
        process.exit(1);
    }
    if (lambdaStart >= cfg.lambdaEnd) {
        console.log(`  Start lambda (${lambdaStart.toFixed(6)}) >= end lambda (${cfg.lambdaEnd}) — increase --lambdaEnd or decrease --maxSlow.`);
        process.exit(1);
    }
    console.log(`  Derived start λ: ${lambdaStart.toFixed(6)}  (optimal slow first drops below ${cfg.maxSlow})`);

    // Verify start lambda produces slow ~= maxSlow
    const checkStart = findBestForLambda(lambdaStart, metricCache)!;
    console.log(`  At start λ:      slow=${checkStart.slow.toFixed(1)}  (should be near ${cfg.maxSlow})\n`);

    // Build geometric lambda range
    const lambdaValues = geometricRange(lambdaStart, cfg.lambdaEnd, cfg.lambdaSteps);

    // Score each lambda against the cache — no AMA recalculation
    const results: BestEntry[] = [];
    for (let idx = 0; idx < lambdaValues.length; idx++) {
        const lambda = lambdaValues[idx];
        const best = findBestForLambda(lambda, metricCache);

        if (!best) {
            console.log(`  λ=${lambda.toFixed(6)}  →  NO VALID`);
            continue;
        }

        results.push(best);

        const pct = ((idx + 1) / lambdaValues.length * 100).toFixed(0);
        console.log(`  [${pct}%] λ=${best.lambda.toFixed(6)}  →  slow=${best.slow.toFixed(1)}  move=${best.movement.toFixed(4)}  dist=${best.distance.toFixed(4)}  score=${best.score.toFixed(4)}`);
    }

    console.log('\n═══ Summary ═══');
    console.log('  λ (input)     | Slow (output) | Movement | Distance | Score');
    console.log('  ──────────────┼───────────────┼──────────┼──────────┼────────');
    for (const r of results) {
        console.log(`  ${r.lambda.toFixed(8).padStart(12)} | ${r.slow.toFixed(1).padStart(13)} | ${r.movement.toFixed(4).padStart(8)} | ${r.distance.toFixed(4).padStart(8)} | ${r.score.toFixed(4).padStart(8)}`);
    }

    // Generate chart
    const chartName = cfg.outFile || path.join(
        PATHS.ANALYSIS.CHARTS_DIR,
        `lambda_vs_slow_er${cfg.fixEr}_fast${cfg.fixFast}_${cfg.lambdaSteps}steps.html`
    );
    const chartPath = path.resolve(chartName);
    ensureDir(path.dirname(chartPath));
    const html = generateChartHtml(results, metricCache, cfg.fixEr, cfg.fixFast, dataLabel);
    fs.writeFileSync(chartPath, html, 'utf8');
    console.log(`\n  Chart: ${path.relative(process.cwd(), chartPath)}`);
    console.log('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch(err => {
        console.error('Fatal:', getErrorMessage(err));
        process.exit(1);
    });
}

export { parseArgs }

