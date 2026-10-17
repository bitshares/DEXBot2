#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeHtml, serializeJsonForScript, toEpochSeconds, UPLOT_SHARED_SCRIPT, uplotInlineTags } from '../chart_utils.js';
import { getStorage } from '../../modules/storage/index.js';
const { ensureDir, readJSON } = getStorage();
import { fixedTo } from '../../modules/order/utils/math.js';
import { bindHoverStateFn, zoomResetScript } from '../chart_ui.js';
import { PATHS } from '../../modules/paths.js';
function parseArgs(argv = process.argv.slice(2)) {
    const cfg: { inputFile: string | null; outputFile: string; title: string; quiet: boolean } = {
        inputFile: null,
        outputFile: path.join(PATHS.ANALYSIS.CHARTS_DIR, 'derivative_chart.html'),
        title: 'Derivative Trend Analysis',
        quiet: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--input') cfg.inputFile = argv[++i] ?? null;
        else if (arg === '--output') cfg.outputFile = argv[++i] ?? null;
        else if (arg === '--title') cfg.title = argv[++i] ?? null;
        else if (arg === '--quiet') cfg.quiet = true;
        else if (arg === '--help' || arg === '-h') {
            showHelp();
            process.exit(0);
        }
    }
    if (!cfg.inputFile) {
        console.error('Error: --input required');
        showHelp();
        process.exit(1);
    }
    return cfg;
}
function showHelp() {
    console.log(`
Derivative Chart Generator (uPlot)
Usage:
  node dist/analysis/legacy/derivative_chart_generator.js --input <file.json> [options]
Options:
  --output FILE   Output HTML (default: <analysis charts dir>/derivative_chart.html)
  --title TEXT    Chart title
  --quiet         Suppress output
    `);
}
function trendToNum(trend: string) {
    if (trend === 'UP') return 1;
    if (trend === 'DOWN') return -1;
    return 0;
}
function countTrend(arr: number[]) {
    return arr.reduce((acc: {total:number, up:number, down:number, neutral:number}, v: number) => {
        acc.total += 1;
        if (v > 0) acc.up += 1;
        else if (v < 0) acc.down += 1;
        else acc.neutral += 1;
        return acc;
    }, { total: 0, up: 0, down: 0, neutral: 0 });
}
interface AnalysisRow {
    timestamp?: unknown;
    price: number;
    slowSma?: number | null;
    fastSmaValue?: number | null;
    smaRawTrend?: string;
    smaConfidence?: number;
    fastSmaRawTrend?: string;
    fastSmaConfidence?: number;
    macdHistogram?: number | null;
    macdLine?: number | null;
    macdSignal?: number | null;
    rsi?: number | null;
    interpretation?: string;
    interpretationBars?: number;
    entryBias?: string;
    isBullWeakEntry?: boolean;
    isBullConfirmation?: boolean;
    isLateBullWithoutWeak?: boolean;
    isBearWeakEntry?: boolean;
    isBearConfirmation?: boolean;
    isLateBearWithoutWeak?: boolean;
    macdTrend?: string;
    rsiZone?: string;
}

interface DerivativeChartData {
    allResults?: AnalysisRow[];
    config?: {
        source?: string;
        slowSmaPeriod?: number | string;
        fastSmaPeriod?: number | string | null;
        macdFastPeriod?: number;
        macdSlowPeriod?: number;
        macdSignalPeriod?: number;
        rsiPeriod?: number;
        rsiExtreme?: number;
    };
}

function countStates(arr: string[], positive: string, negative: string) {
    return arr.reduce((acc: {total:number, positive:number, negative:number, neutral:number}, v: string) => {
        acc.total += 1;
        if (v === positive) acc.positive += 1;
        else if (v === negative) acc.negative += 1;
        else acc.neutral += 1;
        return acc;
    }, { total: 0, positive: 0, negative: 0, neutral: 0 });
}
function generateHTML(data: DerivativeChartData, title: string): string {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');
    const source = data.config?.source || 'Unknown';
    const smaPeriod = data.config?.slowSmaPeriod || 'N/A';
    const fastSmaPeriod = data.config?.fastSmaPeriod || null;
    const hasFastSma = fastSmaPeriod !== null && results.some((r) => r.fastSmaValue !== null && r.fastSmaValue !== undefined);
    const macdFast = data.config?.macdFastPeriod ?? 12;
    const macdSlow = data.config?.macdSlowPeriod ?? 26;
    const macdSig = data.config?.macdSignalPeriod ?? 9;
    const rsiPeriod = data.config?.rsiPeriod ?? 14;
    const rsiOB = data.config?.rsiExtreme ?? 90;
    const rsiOS = 100 - rsiOB;
    const dates = results.map((r, idx: number) => toEpochSeconds(r.timestamp || Date.now(), idx));
    const prices = results.map((r) => r.price);
    const smaValues = results.map((r) => r.slowSma);
    const fastSmaValues = results.map((r) => r.fastSmaValue);
    const smaNum = results.map((r) => trendToNum(r.smaRawTrend ?? ''));
    const smaUp = smaNum.map((v) => (v > 0 ? 1 : 0));
    const smaDown = smaNum.map((v) => (v < 0 ? -1 : 0));
    const smaConf = results.map((r) => r.smaConfidence ?? 0);
    const fastSmaNum = results.map((r) => trendToNum(r.fastSmaRawTrend ?? ''));
    const fastSmaUp = fastSmaNum.map((v) => (v > 0 ? 1 : 0));
    const fastSmaDown = fastSmaNum.map((v) => (v < 0 ? -1 : 0));
    const fastSmaConf = results.map((r) => r.fastSmaConfidence || 0);
    const macdHistogram = results.map((r) => r.macdHistogram ?? null);
    const macdLine = results.map((r) => r.macdLine ?? null);
    const macdSignal = results.map((r) => r.macdSignal ?? null);
    const macdHistUp = macdHistogram.map((v) => (v !== null && v > 0 ? v : null));
    const macdHistDown = macdHistogram.map((v) => (v !== null && v < 0 ? v : null));
    const rsiValues = results.map((r) => r.rsi ?? null);
    const interpState = results.map((r) => r.interpretation || 'NEUTRAL');
    const interpBars = results.map((r) => r.interpretationBars ?? 0);
    const interpValues = interpState.map((s: string) => (
        s === 'BULL' ? 0.75
            : s === 'BULL_WEAK' ? 0.35
            : s === 'OVERBOUGHT' ? 0.95
            : s === 'BEAR' ? -0.75
            : s === 'BEAR_WEAK' ? -0.35
            : s === 'OVERSOLD' ? -0.95
            : 0
    ));
    const interpBull = interpState.map((s: string) => (s === 'BULL' ? 1 : 0));
    const interpBullWeak = interpState.map((s: string) => (s === 'BULL_WEAK' ? 0.5 : 0));
    const interpOB = interpState.map((s: string) => (s === 'OVERBOUGHT' ? 0.75 : 0));
    const interpBear = interpState.map((s: string) => (s === 'BEAR' ? -1 : 0));
    const interpBearWeak = interpState.map((s: string) => (s === 'BEAR_WEAK' ? -0.5 : 0));
    const interpOS = interpState.map((s: string) => (s === 'OVERSOLD' ? -0.75 : 0));
    const interpBullBlock = interpState.map((s: string) => (s === 'BULL' ? 1 : 0));
    const interpBullWeakBlock = interpState.map((s: string) => (s === 'BULL_WEAK' ? 1 : 0));
    const interpOBBlock = interpState.map((s: string) => (s === 'OVERBOUGHT' ? 1 : 0));
    const interpBearBlock = interpState.map((s: string) => (s === 'BEAR' ? -1 : 0));
    const interpBearWeakBlock = interpState.map((s: string) => (s === 'BEAR_WEAK' ? -1 : 0));
    const interpOSBlock = interpState.map((s: string) => (s === 'OVERSOLD' ? -1 : 0));
    const entryBias = results.map((r) => r.entryBias || 'NONE');
    const entryLabelMap = {
        NONE: 'No fresh entry',
        EARLY_LONG: 'Early long entry',
        CONFIRM_LONG: 'Confirmed long entry',
        LATE_LONG: 'Late long entry',
        EARLY_SHORT: 'Early short entry',
        CONFIRM_SHORT: 'Confirmed short entry',
        LATE_SHORT: 'Late short entry',
    };
    const entryBiasLabel = entryBias.map((v) => (entryLabelMap as Record<string, string>)[v] || v);
    const signalPhase = results.map((_r, i: number) => {
        if (entryBias[i] !== 'NONE') return (entryLabelMap as Record<string, string>)[entryBias[i]] || entryBias[i];
        switch (interpState[i]) {
        case 'BULL':
            return 'Bull trend active';
        case 'BULL_WEAK':
            return 'Bull setup active';
        case 'BEAR':
            return 'Bear trend active';
        case 'BEAR_WEAK':
            return 'Bear setup active';
        case 'OVERBOUGHT':
            return 'Overbought exit pressure';
        case 'OVERSOLD':
            return 'Oversold exit pressure';
        default:
            return 'No active setup';
        }
    });
    const bullWeakEntryMarkers = results.map((r) => (r.isBullWeakEntry ? 0.38 : null));
    const bullConfirmationMarkers = results.map((r) => (r.isBullConfirmation ? 0.88 : null));
    const lateBullMarkers = results.map((r) => (r.isLateBullWithoutWeak ? 0.88 : null));
    const bearWeakEntryMarkers = results.map((r) => (r.isBearWeakEntry ? -0.38 : null));
    const bearConfirmationMarkers = results.map((r) => (r.isBearConfirmation ? -0.88 : null));
    const lateBearMarkers = results.map((r) => (r.isLateBearWithoutWeak ? -0.88 : null));
    const priceSeries = prices.filter((v) => Number.isFinite(v));
    const priceStart = priceSeries.length ? priceSeries[0] : null;
    const priceEnd = priceSeries.length ? priceSeries[priceSeries.length - 1] : null;
    const priceHigh = priceSeries.length ? Math.max(...priceSeries) : null;
    const priceLow = priceSeries.length ? Math.min(...priceSeries) : null;
    const priceChange = priceStart !== null && priceEnd !== null ? priceEnd - priceStart : null;
    const priceChangePct = priceStart !== null && priceEnd !== null && priceStart !== 0
        ? ((priceEnd - priceStart) / priceStart) * 100
        : null;
    const smaTotals = countTrend(smaNum);
    const fastSmaTotals = countTrend(fastSmaNum);
    const macdTotals = countTrend(results.map((r) => (r.macdTrend === 'BULL' ? 1 : r.macdTrend === 'BEAR' ? -1 : 0)));
    const rsiTotals = countStates(results.map((r) => r.rsiZone || 'NEUTRAL'), 'OVERBOUGHT', 'OVERSOLD');
    const signalTotals = (() => {
        let up = 0, down = 0, prev = null;
        for (const state of interpState) {
            const isBull = state === 'BULL' || state === 'BULL_WEAK';
            const isBear = state === 'BEAR' || state === 'BEAR_WEAK';
            if (isBull) {
                if (state !== prev) up += 1;
            } else if (isBear) {
                if (state !== prev) down += 1;
            }
            prev = state;
        }
        return { up, down };
    })();
    const candleCount = results.length;
    const fmtPrice = (v: number | null) => (v === null ? 'n/a' : fixedTo(v, 6));
    const fmtSignedPrice = (v: number | null) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(Number(v))}`);
    const fmtPct = (v: number | null) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(Number(v))}%`);
    const fmtShare = (count: number) => (candleCount > 0 ? `${Math.round((count / candleCount) * 100)}%` : 'n/a');
    const headerParts: string[] = [];
    if (smaPeriod !== 'N/A') headerParts.push(`SMA(${smaPeriod})`);
    if (hasFastSma) headerParts.push(`fastSMA(${fastSmaPeriod})`);
    headerParts.push(`MACD(${macdFast},${macdSlow},${macdSig})`);
    headerParts.push(`RSI(${rsiPeriod})`);
    const headerSub = headerParts.join(' &middot; ');
    const statsPanel = `
    <div><span class="label">Candles</span> <span class="val">${results.length}</span></div>
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; Price summary &#x2500;&#x2500;</span></div>
    <div><span class="label">Start</span> <span class="val">${fmtPrice(priceStart)}</span></div>
    <div><span class="label">End</span> <span class="val">${fmtPrice(priceEnd)}</span></div>
    <div style="margin-top:4px"></div>
    <div><span class="label">High</span> <span class="val">${fmtPrice(priceHigh)}</span></div>
    <div><span class="label">Low</span> <span class="val">${fmtPrice(priceLow)}</span></div>
    <div style="margin-top:4px"></div>
    <div><span class="label">Abs change</span> <span class="val">${fmtSignedPrice(priceChange)}</span></div>
    <div><span class="label">Rel change</span> <span class="val">${fmtPct(priceChangePct)}</span></div>
    <div style="margin-top:6px"><span class="label">&#x2500;&#x2500; Totals &#x2500;&#x2500;</span></div>
    <div><span class="label">SMA(${smaPeriod})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(smaTotals.up)} <span class="neg">&#x25BC;</span>${fmtShare(smaTotals.down)} <span class="muted">&#x25CF;</span>${fmtShare(smaTotals.neutral)}</span></div>
    ${hasFastSma ? `<div><span class="label">fastSMA(${fastSmaPeriod})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(fastSmaTotals.up)} <span class="neg">&#x25BC;</span>${fmtShare(fastSmaTotals.down)} <span class="muted">&#x25CF;</span>${fmtShare(fastSmaTotals.neutral)}</span></div>` : ''}
    <div style="margin-top:4px"></div>
    <div><span class="label">MACD(${macdFast},${macdSlow},${macdSig})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(macdTotals.up)} <span class="neg">&#x25BC;</span>${fmtShare(macdTotals.down)} <span class="muted">&#x25CF;</span>${fmtShare(macdTotals.neutral)}</span></div>
    <div><span class="label">RSI(${rsiPeriod})</span> <span class="val"><span class="pos">&#x25B2;</span>${fmtShare(rsiTotals.positive)} <span class="neg">&#x25BC;</span>${fmtShare(rsiTotals.negative)} <span class="muted">&#x25CF;</span>${fmtShare(rsiTotals.neutral)}</span></div>
    <div style="margin-top:4px"></div>
    <div><span class="label">Signals</span> <span class="val"><span class="pos">&#x25B2;</span>${signalTotals.up} <span class="neg">&#x25BC;</span>${signalTotals.down}</span></div>
`;
    const chartId = `deriv-uplot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>${escapeHtml(title)}</title>
    ${uplotInlineTags()}
    <style>
        :root { color-scheme: dark; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #0e1117;
            color: #e0e0e0;
            font-family: 'Segoe UI', sans-serif;
            overflow: hidden;
        }
        #header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100;
            background: rgba(14,17,23,0.92);
            backdrop-filter: blur(4px);
            border-bottom: 1px solid #2a2e3e;
            padding: 8px 20px;
            display: flex;
            align-items: center;
            gap: 18px;
        }
        #header h1 { font-size: 16px; font-weight: 600; color: #fff; white-space: nowrap; }
        #header .sub { font-size: 11px; color: #888; white-space: nowrap; }
        #stats {
            position: fixed;
            top: 160px;
            right: 10px;
            z-index: 100;
            background: rgba(20,24,32,0.92);
            backdrop-filter: blur(4px);
            border: 1px solid #2a2e3e;
            border-radius: 6px;
            padding: 10px 14px;
            font-size: 12px;
            line-height: 1.85;
            min-width: 230px;
        }
        #stats .label { color: #888; }
        #stats .val { color: #e0e0e0; font-weight: 600; font-variant-numeric: tabular-nums; }
        #stats .pos { color: #26a69a; }
        #stats .neg { color: #ef5350; }
        #stats .muted { color: #9ca3b8; }
        #charts {
            position: fixed;
            top: 44px;
            left: 0;
            right: 276px;
            bottom: 0;
            padding-top: 0;
            display: flex;
            flex-direction: column;
            gap: 0;
            border-right: 1px solid #2a2e3e;
        }
        .chart {
            width: 100%;
            min-height: 0;
            position: relative;
            padding-top: 18px;
        }
        .chart::before {
            content: attr(data-panel-title);
            position: absolute;
            top: 4px;
            left: 10px;
            z-index: 2;
            pointer-events: none;
            font-size: 10px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #8ea3be;
            background: rgba(14,17,23,0.84);
            border: 1px solid #263042;
            border-radius: 999px;
            padding: 2px 8px;
        }
        #price-chart { flex: 2.35; }
        #deriv-chart { flex: 0.78; }
        #interp-chart { flex: 1.22; }
        #macd-chart { flex: 1.05; }
        #rsi-chart { flex: 1.28; min-height: 0; }
        .uplot { background: #0e1117; }
        .u-cursor-y { display: none !important; border-top: 1px dashed rgba(255,255,255,0.35) !important; background: transparent !important; }
        .uplot.is-hovered .u-cursor-y { display: block !important; }
        .u-cursor-x { border-left: 1px dashed rgba(255,255,255,0.35) !important; background: transparent !important; }
        .u-legend { display: none !important; }
        #global-tooltip {
            position: fixed;
            z-index: 200;
            pointer-events: none;
            background: rgba(14,17,23,0.96);
            border: 1px solid #2a2e3e;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 11px;
            line-height: 1.6;
            color: #e0e0e0;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            display: none;
            max-width: 260px;
            white-space: nowrap;
        }
        #global-tooltip .tt-row { display: flex; justify-content: space-between; gap: 16px; }
        #global-tooltip .tt-label { color: #888; }
        #global-tooltip .tt-val { font-weight: 600; font-variant-numeric: tabular-nums; }
        #global-tooltip .tt-sep { border-top: 1px solid #263042; margin: 4px 0; }
        #global-tooltip .tt-head { color: #fff; font-weight: 700; margin-bottom: 4px; }
    </style>
</head>
<body>
<div id="global-tooltip"></div>
<div id="header">
    <h1>&#x1F4CA; ${escapeHtml(title)}</h1>
    <span class="sub">Source: ${escapeHtml(source)}</span>
    <span class="sub">${headerSub}</span>
    <button id="reset-zoom-btn" onclick="resetZoom()" title="Reset x-axis zoom on all panels" style="background:#1e2330;color:#ccc;border:1px solid #2a2e3e;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;white-space:nowrap;">&#x21BA; Reset Zoom</button>
    <span class="sub" style="margin-left:auto">Generated: ${new Date().toLocaleString()}</span>
</div>
<div id="stats">${statsPanel}</div>
<div id="charts">
    <div id="price-chart" class="chart" data-panel-title="Price / AMA"></div>
    <div id="deriv-chart" class="chart" data-panel-title="Trend Blocks"></div>
    <div id="interp-chart" class="chart" data-panel-title="Signal State"></div>
    <div id="macd-chart" class="chart" data-panel-title="MACD"></div>
    <div id="rsi-chart" class="chart" data-panel-title="RSI"></div>
</div>
<script type="application/json" id="deriv-payload">${serializeJsonForScript({
    dates,
    prices,
    smaValues,
    fastSmaValues: hasFastSma ? fastSmaValues : null,
    macdHistogram,
    macdLine,
    macdSignal,
    macdHistUp,
    macdHistDown,
    rsiValues,
    interpBull,
    interpBullWeak,
    interpOB,
    interpBear,
    interpBearWeak,
    interpOS,
    interpBullBlock,
    interpBullWeakBlock,
    interpOBBlock,
    interpBearBlock,
    interpBearWeakBlock,
    interpOSBlock,
    interpValues,
    interpState,
    interpBars,
    entryBias,
    entryBiasLabel,
    signalPhase,
    bullWeakEntryMarkers,
    bullConfirmationMarkers,
    lateBullMarkers,
    bearWeakEntryMarkers,
    bearConfirmationMarkers,
    lateBearMarkers,
    smaUp,
    smaDown,
    smaConf,
    smaNum,
    fastSmaUp: hasFastSma ? fastSmaUp : null,
    fastSmaDown: hasFastSma ? fastSmaDown : null,
    fastSmaConf: hasFastSma ? fastSmaConf : null,
    fastSmaNum: hasFastSma ? fastSmaNum : null,
    rsiOB,
    rsiOS,
})}</script>
<script>
const payload = JSON.parse(document.getElementById('deriv-payload').textContent);
const dates = payload.dates;
const prices = payload.prices;
const smaValues = payload.smaValues;
const fastSmaValues = payload.fastSmaValues || [];
const macdHistogram = payload.macdHistogram;
const macdLine = payload.macdLine;
const macdSignal = payload.macdSignal;
const macdHistUp = payload.macdHistUp;
const macdHistDown = payload.macdHistDown;
const rsiValues = payload.rsiValues;
const interpBull = payload.interpBull;
const interpBullWeak = payload.interpBullWeak;
const interpOB = payload.interpOB;
const interpBear = payload.interpBear;
const interpBearWeak = payload.interpBearWeak;
const interpOS = payload.interpOS;
const interpBullBlock = payload.interpBullBlock;
const interpBullWeakBlock = payload.interpBullWeakBlock;
const interpOBBlock = payload.interpOBBlock;
const interpBearBlock = payload.interpBearBlock;
const interpBearWeakBlock = payload.interpBearWeakBlock;
const interpOSBlock = payload.interpOSBlock;
const interpValues = payload.interpValues;
const interpState = payload.interpState;
const interpBars = payload.interpBars;
const entryBias = payload.entryBias;
const entryBiasLabel = payload.entryBiasLabel;
const signalPhase = payload.signalPhase;
const bullWeakEntryMarkers = payload.bullWeakEntryMarkers;
const bullConfirmationMarkers = payload.bullConfirmationMarkers;
const lateBullMarkers = payload.lateBullMarkers;
const bearWeakEntryMarkers = payload.bearWeakEntryMarkers;
const bearConfirmationMarkers = payload.bearConfirmationMarkers;
const lateBearMarkers = payload.lateBearMarkers;
const smaUp = payload.smaUp;
const smaDown = payload.smaDown;
const smaConf = payload.smaConf;
const smaNum = payload.smaNum;
const hasFastSma = Array.isArray(payload.fastSmaValues) && payload.fastSmaValues.length > 0;
const fastSmaUp = payload.fastSmaUp || [];
const fastSmaDown = payload.fastSmaDown || [];
const fastSmaConf = payload.fastSmaConf || [];
const fastSmaNum = payload.fastSmaNum || [];
const rsiOB = payload.rsiOB;
const rsiOS = payload.rsiOS;
const chartGroupId = ${JSON.stringify(chartId)};
const THEME = {
    text: '#ccc',
    muted: '#888',
    background: '#0e1117',
    grid: '#1e2330',
    axis: '#ffffff',
};
const SIGNAL_GREEN = 'rgba(38,166,154,0.45)';
const SIGNAL_GREEN_WEAK = 'rgba(38,166,154,0.22)';
const SIGNAL_GREEN_LIGHT = 'rgba(38,166,154,0.18)';
const SIGNAL_RED = 'rgba(239,83,80,0.45)';
const SIGNAL_RED_WEAK = 'rgba(239,83,80,0.22)';
const SIGNAL_RED_LIGHT = 'rgba(239,83,80,0.18)';
function initChart(domId, opts, data) {
    if (typeof uPlot === 'undefined') throw new Error('uPlot library did not load');
    const el = document.getElementById(domId);
    const rect = el.getBoundingClientRect();
    const chart = new uPlot({
        ...opts,
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(110, Math.floor(rect.height)),
    }, data, el);
    chart.root.style.background = THEME.background;
    return chart;
}
function fmtShortDate(sec) {
    const d = new Date(sec * 1000);
    return d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
}
function fixedTo(value, decimals) {
    return Number(value).toFixed(decimals);
}
function padRange(min, max, lower = 0.04, upper = 0.04) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min === max) {
        const delta = Math.abs(min) * 0.03 || 1;
        return [min - delta, max + delta];
    }
    const span = max - min;
    return [min - span * lower, max + span * upper];
}
function makeAxis(show, type) {
    return {
        show,
        scale: type,
        stroke: THEME.axis,
        grid: { show: false },
        ticks: { show: true, stroke: THEME.axis, width: 1 },
        size: show ? 34 : 0,
        space: 50,
        font: '10px Segoe UI, sans-serif',
        label: '',
        values: show ? (u, splits) => splits.map((v) => fmtShortDate(v)) : () => [],
    };
}
function makeYAxis(show, formatter, size = 58, label = '') {
    return {
        show,
        scale: 'y',
        stroke: THEME.axis,
        grid: { show: true, stroke: THEME.grid },
        ticks: { show: true, stroke: THEME.axis, width: 1 },
        size,
        space: 60,
        font: '10px Segoe UI, sans-serif',
        values: formatter,
        label,
        labelSize: label ? 14 : 0,
        labelGap: 4,
        labelFont: '10px Segoe UI, sans-serif',
    };
}
function makeCursor() {
    return {
        show: true,
        x: true,
        y: true,
        points: { show: false },
        drag: { x: false, y: false, setScale: false },
        sync: { key: chartGroupId, setSeries: false, scales: ['x', null] },
        focus: { prox: -1 },
    };
}
function makePlotBase(showX, yFormatter, yScale) {
    return {
        width: 0,
        height: 0,
        title: null,
        legend: { show: false },
        cursor: makeCursor(),
        select: { show: false },
        scales: {
            x: { time: true },
            y: yScale,
        },
        axes: [
            makeAxis(showX, 'x'),
            makeYAxis(true, yFormatter),
        ],
        series: [
            { label: 'Time' },
        ],
        padding: [10, 16, 0, 0],
        hooks: {
            ready: [
                (u) => {
                    u.root.style.background = THEME.background;
                },
            ],
        },
    };
}
function lineSeries(name, color, width, extra = {}) {
    return {
        label: name,
        stroke: color,
        width,
        points: { show: false },
        fill: null,
        ...extra,
    };
}
function barSeries(name, color, fill) {
    return {
        label: name,
        stroke: color,
        fill,
        width: 1,
        points: { show: false },
        paths: uPlot.paths.bars({ align: 0, gap: 1, size: [0.72, 14, 1] }),
    };
}
function blockSeries(name, color, fill) {
    return {
        label: name,
        stroke: color,
        fill,
        width: 1,
        points: { show: false },
        paths: uPlot.paths.bars({ align: 0, gap: 0, size: [0.96, 18, 1] }),
    };
}
function markerSeries(name, color, size = 7) {
    return {
        label: name,
        stroke: 'transparent',
        width: 0,
        points: { show: true, size, space: 0, fill: color, stroke: color },
    };
}
function tooltipPlugin() {
    const tooltip = document.getElementById('global-tooltip');
    let lastIdx = -1;
    function updateTooltip(u) {
        const idx = u.cursor.idx;
        if (idx == null || idx === lastIdx) return;
        lastIdx = idx;
        const d = new Date(dates[idx] * 1000);
        const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const priceVal = prices[idx];
        const smaVal = smaValues[idx];
        const fsVal = hasFastSma ? fastSmaValues[idx] : null;
        const macdL = macdLine[idx];
        const macdS = macdSignal[idx];
        const macdH = macdHistogram[idx];
        const rsiVal = rsiValues[idx];
        const state = interpState[idx];
        const entry = entryBiasLabel[idx];
        const bars = interpBars[idx];
        const rows = [
            '<div class="tt-head">' + dateStr + '</div>',
        ];
        if (Number.isFinite(priceVal)) {
            rows.push('<div class="tt-row"><span class="tt-label">Price</span><span class="tt-val">' + priceVal.toFixed(6) + '</span></div>');
        }
        if (Number.isFinite(smaVal)) {
            rows.push('<div class="tt-row"><span class="tt-label">SMA(' + ${JSON.stringify(smaPeriod)} + ')</span><span class="tt-val">' + smaVal.toFixed(6) + '</span></div>');
        }
        if (hasFastSma && Number.isFinite(fsVal)) {
            rows.push('<div class="tt-row"><span class="tt-label">fastSMA</span><span class="tt-val">' + fsVal.toFixed(6) + '</span></div>');
        }
        rows.push('<div class="tt-sep"></div>');
        if (entry && entry !== 'No fresh entry') {
            const entryColor = entry.includes('Long') ? '#26a69a' : entry.includes('Short') ? '#ef5350' : '#ccc';
            rows.push('<div class="tt-row"><span class="tt-label">Entry</span><span class="tt-val" style="color:' + entryColor + '">' + entry + '</span></div>');
        }
        if (state && state !== 'NEUTRAL') {
            const stateColor = state.startsWith('BULL') || state === 'OVERBOUGHT' ? '#26a69a' : state.startsWith('BEAR') || state === 'OVERSOLD' ? '#ef5350' : '#ccc';
            rows.push('<div class="tt-row"><span class="tt-label">State</span><span class="tt-val" style="color:' + stateColor + '">' + state + (bars > 0 ? ' (' + bars + ' bars)' : '') + '</span></div>');
        }
        rows.push('<div class="tt-sep"></div>');
        if (Number.isFinite(macdL) && Number.isFinite(macdS)) {
            rows.push('<div class="tt-row"><span class="tt-label">MACD</span><span class="tt-val">' + macdL.toFixed(4) + '</span></div>');
            rows.push('<div class="tt-row"><span class="tt-label">Signal</span><span class="tt-val">' + macdS.toFixed(4) + '</span></div>');
            rows.push('<div class="tt-row"><span class="tt-label">Hist</span><span class="tt-val">' + (macdH >= 0 ? '+' : '') + macdH.toFixed(4) + '</span></div>');
        }
        if (Number.isFinite(rsiVal)) {
            rows.push('<div class="tt-row"><span class="tt-label">RSI</span><span class="tt-val">' + rsiVal.toFixed(1) + '</span></div>');
        }
        tooltip.innerHTML = rows.join('');
    }
    return {
        hooks: {
            init: [(u) => {
                u.over.addEventListener('mouseenter', () => { tooltip.style.display = 'block'; });
                u.over.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; lastIdx = -1; });
            }],
            setCursor: [(u) => {
                updateTooltip(u);
                const { left, top } = u.cursor;
                const rect = u.root.getBoundingClientRect();
                const ttWidth = tooltip.offsetWidth || 220;
                const ttHeight = tooltip.offsetHeight || 180;
                let x = rect.left + left + 16;
                let y = rect.top + top + 16;
                if (x + ttWidth > window.innerWidth - 12) x = rect.left + left - ttWidth - 16;
                if (y + ttHeight > window.innerHeight - 12) y = rect.top + top - ttHeight - 16;
                tooltip.style.left = x + 'px';
                tooltip.style.top = y + 'px';
            }],
        },
    };
}
function applyChartHeights() {
    const available = Math.max(window.innerHeight - 44, 300);
    const specs = [
        ['price-chart', 2.35],
        ['deriv-chart', 0.78],
        ['interp-chart', 1.22],
        ['macd-chart', 1.05],
        ['rsi-chart', 1.28],
    ];
    const minHeight = 60;
    const extraAvailable = Math.max(0, available - (minHeight * specs.length));
    const totalWeight = specs.reduce((sum, [, weight]) => sum + weight, 0);
    let assignedExtra = 0;
    specs.forEach(([id, weight], idx) => {
        const extra = idx === specs.length - 1
            ? extraAvailable - assignedExtra
            : Math.floor((extraAvailable * weight) / totalWeight);
        assignedExtra += extra;
        document.getElementById(id).style.height = (minHeight + extra) + 'px';
    });
}
let priceChart;
let derivChart;
let interpChart;
let macdChart;
let rsiChart;
let charts = [];
let pendingRange = null;
let pendingRangeRaf = 0;
const [xMin, xMax] = [dates[0], dates[dates.length - 1]];
try {
priceChart = initChart('price-chart', {
    ...makePlotBase(false, (u, vals) => vals.map((v) => fixedTo(v, 6)), {
        auto: true,
        distr: 3,
        log: 10,
        range: (u, min, max) => {
            if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
                return [min, max];
            }
            return [min * 0.98, max * 1.03];
        },
    }),
    axes: [
        makeAxis(false, 'x'),
        { ...makeYAxis(true, (u, vals) => vals.map((v) => fixedTo(v, 6)), 62, 'Price'), splits: logAxisSplits },
    ],
    plugins: [tooltipPlugin()],
    series: [
        { label: 'Time' },
        lineSeries('Price', '#67a8ff', 2.35, { fill: 'rgba(103,168,255,0.08)' }),
        lineSeries('SMA(${smaPeriod})', '#f2b94d', 2),
        ${hasFastSma ? `lineSeries('fastSMA(${fastSmaPeriod})', '#ff9d4d', 1.9),` : ''}
    ],
}, [dates, prices, smaValues${hasFastSma ? ', fastSmaValues' : ''}]);
derivChart = initChart('deriv-chart', {
    ...makePlotBase(false, (u, vals) => vals.map((v) => (v === 1 ? 'UP' : v === -1 ? 'DOWN' : '—')), {
        auto: true,
        range: (u, min, max) => [-1.15, 1.15],
    }),
    axes: [
        makeAxis(false, 'x'),
        makeYAxis(true, (u, vals) => vals.map((v) => (v === 1 ? 'UP' : v === -1 ? 'DOWN' : '—')), 56, 'Trend'),
    ],
    series: [
        { label: 'Time' },
        blockSeries('SMA Up', 'rgba(83,214,184,0.88)', 'rgba(83,214,184,0.88)'),
        blockSeries('SMA Down', 'rgba(255,114,105,0.88)', 'rgba(255,114,105,0.88)'),
        ${hasFastSma ? `blockSeries('fastSMA Up', 'rgba(251,146,60,0.35)', 'rgba(251,146,60,0.35)'),
        blockSeries('fastSMA Down', 'rgba(251,146,60,0.35)', 'rgba(251,146,60,0.35)'),` : ''}
        lineSeries('Zero', 'rgba(255,255,255,0.20)', 1),
    ],
}, [dates, smaUp, smaDown, ${hasFastSma ? 'fastSmaUp, fastSmaDown, ' : ''}dates.map(() => 0)]);
interpChart = initChart('interp-chart', {
    ...makePlotBase(false, (u, vals) => vals.map((v) => {
        if (v === 1) return 'BULL';
        if (v === 0.75) return 'OS';
        if (v === 0.5) return 'WEAK';
        if (v === 0.35) return 'WEAK';
        if (v === -0.35) return 'WEAK';
        if (v === -0.5) return 'WEAK';
        if (v === -0.75) return 'OB';
        if (v === -1) return 'BEAR';
        return '—';
    }), {
        auto: true,
        range: (u, min, max) => [-1.15, 1.15],
    }),
    axes: [
        makeAxis(false, 'x'),
        makeYAxis(true, (u, vals) => vals.map((v) => {
            if (v === 1) return 'BULL';
            if (v === 0.75) return 'OS';
            if (v === 0.5 || v === -0.5) return 'WEAK';
            if (v === -0.75) return 'OB';
            if (v === -1) return 'BEAR';
            return '—';
        }), 56, 'Signal'),
    ],
    series: [
        { label: 'Time' },
        blockSeries('Bull', SIGNAL_GREEN, SIGNAL_GREEN),
        blockSeries('Bull Weak', SIGNAL_GREEN_WEAK, SIGNAL_GREEN_WEAK),
        blockSeries('Overbought', SIGNAL_GREEN_LIGHT, SIGNAL_GREEN_LIGHT),
        blockSeries('Bear', SIGNAL_RED, SIGNAL_RED),
        blockSeries('Bear Weak', SIGNAL_RED_WEAK, SIGNAL_RED_WEAK),
        blockSeries('Oversold', SIGNAL_RED_LIGHT, SIGNAL_RED_LIGHT),
        lineSeries('Interp', 'rgba(255,255,255,0.35)', 1, { dash: [4, 4] }),
        markerSeries('Early Long', '#67e8f9', 7),
        markerSeries('Confirm Long', '#34d399', 8),
        markerSeries('Late Long', '#f59e0b', 8),
        markerSeries('Early Short', '#fca5a5', 7),
        markerSeries('Confirm Short', '#ef4444', 8),
        markerSeries('Late Short', '#fb7185', 8),
    ],
}, [dates, interpBullBlock, interpBullWeakBlock, interpOBBlock, interpBearBlock, interpBearWeakBlock, interpOSBlock, interpValues, bullWeakEntryMarkers, bullConfirmationMarkers, lateBullMarkers, bearWeakEntryMarkers, bearConfirmationMarkers, lateBearMarkers]);
macdChart = initChart('macd-chart', {
    ...makePlotBase(false, (u, vals) => vals.map((v) => fixedTo(v, 4)), {
        auto: true,
        range: (u, min, max) => {
            const base = padRange(min, max, 0.12, 0.12);
            return base || [min, max];
        },
    }),
    axes: [
        makeAxis(false, 'x'),
        makeYAxis(true, (u, vals) => vals.map((v) => fixedTo(v, 4)), 62, 'MACD %'),
    ],
    series: [
        { label: 'Time' },
        barSeries('Hist+', 'rgba(83,214,184,0.40)', 'rgba(83,214,184,0.40)'),
        barSeries('Hist-', 'rgba(255,114,105,0.40)', 'rgba(255,114,105,0.40)'),
        lineSeries('MACD', '#67a8ff', 1.5),
        lineSeries('Signal', '#ff9d4d', 1.5),
        lineSeries('Zero', 'rgba(255,255,255,0.22)', 1),
    ],
}, [dates, macdHistUp, macdHistDown, macdLine, macdSignal, dates.map(() => 0)]);
rsiChart = initChart('rsi-chart', {
    ...makePlotBase(true, (u, vals) => vals.map((v) => fixedTo(v, 1)), {
        range: (u, min, max) => [0, 100],
    }),
    axes: [
        makeAxis(true, 'x'),
        makeYAxis(true, (u, vals) => vals.map((v) => fixedTo(v, 1)), 56, 'RSI'),
    ],
    series: [
        { label: 'Time' },
        lineSeries('OB', 'rgba(255,114,105,0.35)', 1),
        lineSeries('OS', 'rgba(83,214,184,0.35)', 1),
        lineSeries('Mid', 'rgba(255,255,255,0.18)', 1),
        lineSeries('RSI(${rsiPeriod})', '#c4a5ff', 1.55),
    ],
}, [dates, dates.map(() => rsiOB), dates.map(() => rsiOS), dates.map(() => 50), rsiValues]);
} catch (err) {
    console.error(err);
    document.getElementById('charts').innerHTML = '<div style="padding:20px;color:#ef5350;white-space:pre-wrap;">' + String(err && err.message ? err.message : err) + '</div>';
    throw err;
}
charts = [priceChart, derivChart, interpChart, macdChart, rsiChart];
${UPLOT_SHARED_SCRIPT}
        ${bindHoverStateFn()}
function resetZoom() {
    syncXRange(xMin, xMax);
}
function sizeCharts() {
    applyChartHeights();
    for (const chart of charts) {
        const rect = chart.root.parentElement.getBoundingClientRect();
        chart.setSize({ width: Math.max(320, Math.floor(rect.width)), height: Math.max(100, Math.floor(rect.height)) });
    }
}
window.addEventListener('resize', sizeCharts);
        ${zoomResetScript()}
charts.forEach((chart) => {
    bindWheelZoom(chart);
    bindPan(chart);
    bindHoverState(chart);
});
const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 0);
raf(() => sizeCharts());
</script>
</body>
</html>`;
}
async function main() {
    const cfg = parseArgs();
    const data = readJSON(cfg.inputFile!);
    const html = generateHTML(data, cfg.title);
    ensureDir(path.dirname(cfg.outputFile));
    fs.writeFileSync(cfg.outputFile, html, 'utf8');
    if (!cfg.quiet) console.log(`Chart written to ${cfg.outputFile}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
export { generateHTML };
export type { AnalysisRow };

