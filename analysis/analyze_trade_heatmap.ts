#!/usr/bin/env node
'use strict';
/**
 * TRADE HEATMAP ANALYZER
 *
 * Generates an HTML heatmap showing where trade volume concentrates relative
 * to AMA deviation. Produces a 2D grid (time slices × deviation buckets) and
 * a summed volume histogram with threshold annotations.
 *
 * Usage:
 *   node dist/analysis/analyze_trade_heatmap.js --source market_adapter --bot-key <key> [options]
 *   node dist/analysis/analyze_trade_heatmap.js --file <path> [options]
 *
 * Output:
 *   Self-contained HTML file with inline CSS (no JS dependencies).
 */
import { getErrorMessage } from '../modules/utils/errors.js';
import path from 'node:path';
import { calculateAMA } from '../market_adapter/core/strategies/ama.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { calcStdDev, getCandleClose } from './math_utils.js';
import { writeChartFile } from './chart_utils.js';
import { resolveSource, listAvailableBots, type SourceConfig } from './resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from './analyze_args.js';


function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: SourceConfig };
        ama: string;
        output: string;
        buckets: number | null;
        maxNeg: number | null;
        maxPos: number | null;
        warmup: number | null;
        binSize: number;
        sliceMonths: number;
        thresholds: number[];
        quiet: boolean;
        listBots: boolean;
    } = {
        ...baseAnalysisConfig(),
        ama: 'AMA3',
        output: 'analysis/charts/trade_heatmap.html',
        buckets: null,
        maxNeg: null,
        maxPos: null,
        warmup: null,
        binSize: 5,
        sliceMonths: 12,
        thresholds: [1, 2, 3, 5, 10, 20],
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if (arg === '--ama') config.ama = args[++i];
        else if (arg === '--output') config.output = args[++i];
        else if (arg === '--buckets') config.buckets = parseInt(args[++i], 10);
        else if (arg === '--max-neg') config.maxNeg = parseFloat(args[++i]);
        else if (arg === '--max-pos') config.maxPos = parseFloat(args[++i]);
        else if (arg === '--warmup') config.warmup = parseInt(args[++i], 10);
        else if (arg === '--bin-size') config.binSize = parseFloat(args[++i]);
        else if (arg === '--slice-months') config.sliceMonths = parseInt(args[++i], 10);
        else if (arg === '--thresholds') config.thresholds = args[++i].split(',').map(Number);
    }

    return config;
}

async function main() {
    try {
        const cfg = parseArgs();

        if (cfg.listBots) {
            listAvailableBots();
            return;
        }

        const { source } = resolveSource({ ...cfg.source.config, type: cfg.source.type }, { quiet: cfg.quiet });
        if (!cfg.quiet) console.log(`[TradeHeatmap] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const amaCfg = MARKET_ADAPTER.AMAS[cfg.ama as keyof typeof MARKET_ADAPTER.AMAS];
        if (!amaCfg) {
            throw new Error(`Unknown AMA preset: ${cfg.ama}. Choose: ${Object.keys(MARKET_ADAPTER.AMAS).join(', ')}`);
        }

        const closes = candles.map(c => getCandleClose(c) ?? Number(c?.close ?? c?.[4] ?? 0));
        const volumes = candles.map(c => Number(c?.volume ?? c?.[5] ?? 0) || 0);
        const timestamps = candles.map(c => Number(c?.timestamp ?? c?.[0] ?? 0));

        if (cfg.warmup === null) {
            cfg.warmup = Math.ceil(amaCfg.erPeriod);
        }
        if (!cfg.quiet) console.log(`[TradeHeatmap] Computing ${cfg.ama} on ${closes.length} candles (warmup=${cfg.warmup})...`);

        const amaValues = calculateAMA(closes, amaCfg);
        const records: Array<{ devPct: number; vol: number; ts: number }> = [];
        for (let i = cfg.warmup; i < closes.length; i++) {
            const ama = amaValues[i];
            if (!Number.isFinite(ama) || ama === 0) continue;
            const devPct = ((closes[i] - ama) / ama) * 100;
            const vol = volumes[i];
            if (vol <= 0) continue;
            records.push({ devPct, vol, ts: timestamps[i] });
        }
        if (records.length === 0) {
            throw new Error('No valid records after filtering');
        }
        if (!cfg.quiet) console.log(`[TradeHeatmap] ${records.length} volume-bearing candles after warmup`);

        const devs = records.map(r => r.devPct);
        const vols = records.map(r => r.vol);
        const totalVol = vols.reduce((a, b) => a + b, 0);
        const meanDev = devs.reduce((a, b) => a + b, 0) / devs.length;
        const stdDev = calcStdDev(devs);
        const sortedDevs = devs.slice().sort((a, b) => a - b);
        const medianDev = sortedDevs[Math.floor(sortedDevs.length / 2)];
        let weightedSum = 0;
        for (let i = 0; i < devs.length; i++) weightedSum += devs[i] * vols[i];
        const volWeightedMeanDev = weightedSum / totalVol;
        const binSize = cfg.binSize;
        let leftBins, rightBins;
        if (cfg.buckets !== null) {
            const half = Math.floor(cfg.buckets / 2);
            leftBins = half;
            rightBins = half;
        } else {
            leftBins = Math.ceil((cfg.maxNeg !== null ? cfg.maxNeg : binSize * 10) / binSize);
            rightBins = Math.ceil((cfg.maxPos !== null ? cfg.maxPos : binSize * 10) / binSize);
        }
        const maxNegDev = leftBins * binSize;
        const maxPosDev = rightBins * binSize;
        const binLabels: string[] = [];
        for (let i = -leftBins; i <= rightBins; i++) {
            binLabels.push((i * binSize).toFixed(1));
        }
        const nBins = binLabels.length;
        const binKey = (dev: number) => {
            const idx = Math.round(dev / binSize) + leftBins;
            return Math.max(0, Math.min(nBins - 1, idx));
        };
        const minTs = timestamps[cfg.warmup];
        const maxTs = timestamps[timestamps.length - 1];
        const minDate = new Date(minTs);
        const maxDate = new Date(maxTs);
        const sliceMonths = cfg.sliceMonths;
        const slices: Array<{ label: string; start: number; end: number }> = [];
        let sliceStart = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
        while (sliceStart <= maxDate) {
            const sliceEnd = new Date(sliceStart);
            sliceEnd.setMonth(sliceEnd.getMonth() + sliceMonths);
            slices.push({
                label: `${sliceStart.getFullYear()}-${String(sliceStart.getMonth() + 1).padStart(2, '0')}`,
                start: sliceStart.getTime(),
                end: sliceEnd.getTime(),
            });
            sliceStart = sliceEnd;
        }
        const sliceBuckets = slices.map(() => new Array(nBins).fill(0));
        const sliceTotals = new Array(slices.length).fill(0);
        for (const r of records) {
            const si = slices.findIndex(s => r.ts >= s.start && r.ts < s.end);
            if (si === -1) continue;
            const bi = binKey(r.devPct);
            sliceBuckets[si][bi] += r.vol;
            sliceTotals[si] += r.vol;
        }
        while (slices.length > 0 && sliceTotals[sliceTotals.length - 1] === 0) {
            slices.pop();
            sliceBuckets.pop();
            sliceTotals.pop();
        }
        const totalBins = new Array(nBins).fill(0);
        for (const r of records) {
            totalBins[binKey(r.devPct)] += r.vol;
        }
        const maxBinVol = Math.max(...totalBins);
        const pctWithin = cfg.thresholds.map(t => {
            const volIn = records.filter(r => Math.abs(r.devPct) <= t).reduce((s, r) => s + r.vol, 0);
            return (volIn / totalVol * 100).toFixed(2);
        });
        const peakBinIdx = totalBins.indexOf(maxBinVol);
        const peakDev = binLabels[peakBinIdx];
        const allCellPcts: number[] = [];
        for (let si = 0; si < slices.length; si++) {
            for (let bi = 0; bi < nBins; bi++) {
                if (sliceTotals[si] > 0) {
                    allCellPcts.push((sliceBuckets[si][bi] / sliceTotals[si]) * 100);
                }
            }
        }
        allCellPcts.sort((a, b) => a - b);
        const colorCap = allCellPcts.length > 0
            ? allCellPcts[Math.floor(allCellPcts.length * 0.95)]
            : 30;
        function heatColor(pct: number) {
            if (pct <= 0) return '#0d1117';
            const n = Math.min(pct / colorCap, 1);
            const r = Math.round(13 + n * (255 - 13));
            const g = Math.round(17 + n * (160 - 17));
            const b = Math.round(23 + n * (70 - 23));
            return `rgb(${r},${g},${b})`;
        }
        function histColor(pct: number, maxPct: number) {
            const n = maxPct > 0 ? pct / maxPct : 0;
            const r = Math.round(56 + n * (255 - 56));
            const g = Math.round(178 + n * (160 - 178));
            const b = Math.round(73 + n * (70 - 73));
            return `rgb(${r},${g},${b})`;
        }
        const heatRows = slices.map((sl, si) => {
            const rowPcts = sliceBuckets[si].map(v => sliceTotals[si] > 0 ? (v / sliceTotals[si]) * 100 : 0);
            const cells = rowPcts.map((p, bi) => {
                const pctStr = p > 0 ? p.toFixed(1) : '';
                return `<td class="hm-cell" style="background:${heatColor(p)}" title="dev=${binLabels[bi]}%  vol=${(sliceBuckets[si][bi]).toFixed(2)}  (${p.toFixed(1)}% of ${sl.label})">${pctStr}</td>`;
            }).join('');
            return `<tr><td class="yl">${sl.label}</td>${cells}</tr>`;
        }).join('\n');
        const maxBarPct = Math.max(...totalBins);
        const barRows = totalBins.map((v, i) => {
            const barPct = maxBarPct > 0 ? (v / maxBarPct) * 100 : 0;
            const color = histColor(v, maxBarPct);
            const barH = Math.max(barPct * 0.7, 0.5);
            return `<div class="bar" style="height:${barH}px;background:${color}" title="Deviation: ${binLabels[i]}%  Volume: ${v.toFixed(2)}"></div>`;
        }).join('');
        const xLabelInterval = Math.max(1, Math.floor(nBins / 11));
        const xLabelsHtml = binLabels.map((l, i) => {
            if (i === 0 || i === nBins - 1 || i % xLabelInterval === 0) {
                return `<span>${l}%</span>`;
            }
            return '<span></span>';
        }).join('');
        const threshHtml = cfg.thresholds.map(t => {
            const pct = ((leftBins + t / binSize) / nBins) * 100;
            return `<div class="thresh-line" style="left:${Math.min(Math.max(pct, 0), 100)}%"><span class="thresh-label">±${t}%</span></div>`;
        }).join('');
        const sourceLabel = cfg.source.config.botKey || path.basename(cfg.source.config.filePath || 'data');
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trade Heatmap — ${cfg.ama} Deviation</title>
<style>
* { box-sizing: border-box; }
body { background: #0b0e14; color: #d1d5db; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 24px; }
h1 { color: #fff; font-size: 18px; margin: 0 0 2px 0; }
.subtitle { color: #8b949e; font-size: 12px; margin: 0 0 16px 0; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 24px; }
.stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; }
.stat-card .lbl { color: #8b949e; font-size: 9px; text-transform: uppercase; letter-spacing: 0.8px; }
.stat-card .val { color: #f0f6fc; font-size: 16px; font-weight: bold; margin-top: 2px; }
.stat-card .val.green { color: #3fb950; }
.stat-card .val.orange { color: #f08c00; }
.stat-card .val.blue { color: #58a6ff; }
.hm-wrap { overflow-x: auto; margin-bottom: 28px; }
table.heatmap { border-collapse: collapse; font-size: 10px; }
table.heatmap th { color: #8b949e; font-size: 9px; font-weight: normal; padding: 2px 0; min-width: 32px; text-align: center; }
table.heatmap td.hm-cell { width: 30px; height: 22px; text-align: center; font-size: 8px; color: rgba(255,255,255,0.6); cursor: default; border: 1px solid #161b22; border-radius: 1px; }
table.heatmap td.yl { color: #8b949e; font-size: 10px; text-align: right; padding-right: 8px; white-space: nowrap; }
.legend-row { display: flex; align-items: center; gap: 12px; font-size: 10px; color: #8b949e; margin-bottom: 20px; }
.legend-bar { width: 160px; height: 8px; border-radius: 3px; background: linear-gradient(to right, #0d1117, #1f6f2f, #3fb950, #ffa03e, #f85149); }
.section-title { color: #8b949e; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0; border-bottom: 1px solid #30363d; padding-bottom: 4px; }
.hist-wrap { position: relative; margin-bottom: 36px; }
.hist-bar-container { display: flex; align-items: flex-end; gap: 1px; height: 180px; }
.hist-bar-container .bar { flex: 1; min-height: 1px; border-radius: 1px; cursor: pointer; transition: opacity 0.15s; }
.hist-bar-container .bar:hover { opacity: 0.8; }
.hist-overlay { position: absolute; top: 0; left: 0; right: 0; height: 180px; pointer-events: none; }
.thresh-line { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed rgba(248,81,73,0.5); }
.thresh-label { position: absolute; top: 2px; left: 50%; transform: translateX(-50%); font-size: 8px; color: #f85149; white-space: nowrap; background: rgba(11,14,20,0.8); padding: 0 3px; line-height: 12px; }
.x-labels { display: flex; font-size: 9px; color: #8b949e; margin-top: 4px; }
.x-labels span { flex: 1; text-align: center; white-space: nowrap; }
.pct-table { font-size: 11px; color: #8b949e; margin-bottom: 24px; }
.pct-table td { padding: 3px 12px 3px 0; }
.pct-table td:first-child { color: #d1d5db; }
.pct-table .val-col { text-align: right; font-weight: bold; color: #3fb950; font-family: monospace; }
.bottom { display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap; margin-top: 8px; }
.params-table { font-size: 11px; color: #8b949e; }
.params-table td { padding: 2px 16px 2px 0; }
.params-table td:first-child { color: #555; }
</style>
</head>
<body>
<h1>Trade Heatmap — ${cfg.ama} Deviation</h1>
<p class="subtitle">
    ${closes.length} candles &middot; ${records.length} with volume &middot;
    ${(totalVol).toFixed(1)} total volume units &middot;
    ${binSize}% bins &middot;
    ${slices.length} time slices &middot;
    ${sourceLabel}
</p>
<div class="stats-grid">
    <div class="stat-card"><div class="lbl">Mean Deviation</div><div class="val">${meanDev.toFixed(2)}%</div></div>
    <div class="stat-card"><div class="lbl">Median Deviation</div><div class="val">${medianDev.toFixed(2)}%</div></div>
    <div class="stat-card"><div class="lbl">Std Deviation</div><div class="val blue">${stdDev.toFixed(2)}%</div></div>
    <div class="stat-card"><div class="lbl">Vol-Weighted Mean</div><div class="val">${volWeightedMeanDev.toFixed(2)}%</div></div>
    <div class="stat-card"><div class="lbl">Peak Bucket</div><div class="val green">${peakDev}%</div></div>
    <div class="stat-card"><div class="lbl">Max |Dev|</div><div class="val orange">${Math.max(...devs.map(Math.abs)).toFixed(2)}%</div></div>
</div>
<div class="section-title">Volume Distribution by Time Slice &mdash; % of slice volume per deviation bucket</div>
<div class="hm-wrap">
    <table class="heatmap">
        <thead><tr><th></th>${binLabels.map(l => `<th>${l}</th>`).join('')}</tr></thead>
        <tbody>${heatRows}</tbody>
    </table>
</div>
<div class="legend-row">
    <span>0%</span>
    <div class="legend-bar"></div>
    <span>≥${colorCap.toFixed(0)}% of slice</span>
</div>
<div class="section-title">Summed Volume Distribution &mdash; total volume per deviation bucket</div>
<div class="hist-wrap">
    <div class="hist-bar-container">
        ${cfg.thresholds.length > 0 ? `<div class="hist-overlay">${threshHtml}</div>` : ''}
        ${barRows}
    </div>
    <div class="x-labels">${xLabelsHtml}</div>
</div>
<div class="section-title">Volume Concentration</div>
<table class="pct-table">
    ${cfg.thresholds.map((t, i) =>
        `<tr><td>Within ±${t}% of AMA</td><td class="val-col">${pctWithin[i]}%</td></tr>`
    ).join('')}
</table>
<div class="bottom">
    <table class="params-table">
        <tr><td>AMA Preset</td><td>${cfg.ama}</td></tr>
        <tr><td>ER Period</td><td>${amaCfg.erPeriod}</td></tr>
        <tr><td>Fast SC (period)</td><td>${amaCfg.fastPeriod}</td></tr>
        <tr><td>Slow SC (period)</td><td>${amaCfg.slowPeriod}</td></tr>
        <tr><td>Bin size</td><td>${binSize}%</td></tr>
        <tr><td>Total bins</td><td>${nBins} (${(-maxNegDev).toFixed(0)}% to +${maxPosDev.toFixed(0)}%)</td></tr>
        <tr><td>Warmup bars skipped</td><td>${cfg.warmup}</td></tr>
        <tr><td>Slice months</td><td>${cfg.sliceMonths}</td></tr>
        <tr><td>Data range</td><td>${minDate.toISOString().split('T')[0]} &ndash; ${maxDate.toISOString().split('T')[0]}</td></tr>
    </table>
</div>
</body>
</html>`;
        writeChartFile(cfg.output, html);
        if (!cfg.quiet) console.log(`[TradeHeatmap] ✓ Heatmap saved to ${cfg.output}`);
    } catch (err) {
        console.error(`[TradeHeatmap] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
