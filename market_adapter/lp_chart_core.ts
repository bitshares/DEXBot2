'use strict';

import { toIntervalLabel } from './interval_utils.js';
import { escapeHtml, serializeJsonForScript, UPLOT_SHARED_SCRIPT, uplotInlineTags } from '../analysis/chart_utils.js';
import { makeCursorConfig, bindHoverStateFn, zoomResetScript } from '../analysis/chart_ui.js';
import { fixedTo, roundTo, roundToDecimals } from '../modules/order/utils/math.js';


function formatPct(v: unknown): string {
    const num = Number(v);
    if (!Number.isFinite(num)) return 'n/a';
    return `${num >= 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function padRange(min: unknown, max: unknown, lower = 0.04, upper = 0.04): [number, number] | null {
    const lo = Number(min);
    const hi = Number(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (lo === hi) {
        const delta = Math.abs(lo) * 0.03 || 1;
        return [lo - delta, hi + delta];
    }
    const span = hi - lo;
    return [lo - span * lower, hi + span * upper];
}

interface ChartMeta {
    assetA?: unknown;
    assetB?: unknown;
    intervalSeconds?: unknown;
    fetchedAt?: unknown;
    pool?: unknown;
    thresholds?: Array<{ quantile: number; multiplier: unknown }>;
    sigmaAmaDelta?: unknown;
}

interface AmaResult {
    values?: unknown[];
    erPeriod?: unknown;
    name?: unknown;
    color?: unknown;
    lineWidth?: number;
    fastPeriod?: unknown;
    slowPeriod?: unknown;
}

function generateHTML(meta: ChartMeta | null, candles: unknown, amaResults: AmaResult[]): string {
    const { assetA = {}, assetB = {}, intervalSeconds, fetchedAt, pool, thresholds = [], sigmaAmaDelta } = (meta || {}) as ChartMeta & { assetA?: { symbol?: unknown }; assetB?: { symbol?: unknown } };
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('No candles supplied to LP uPlot renderer');
    }
    if (!Array.isArray(amaResults) || amaResults.length === 0) {
        throw new Error('No AMA results supplied to LP uPlot renderer');
    }

    const poolLabel = pool
        ? `Pool ${String(pool).replace('1.19.', '')}`
        : `${assetA.symbol || '?'} / ${assetB.symbol || '?'}`;
    const intervalLabel = toIntervalLabel(Number(intervalSeconds));

    const candleRows = candles as unknown[][];
    const ts = candleRows.map((c) => Math.round(Number(c[0]) / 1000));
    const closes = candleRows.map((c) => roundToDecimals(Number(c[4]), 6));
    const volumes = candleRows.map((c) => roundToDecimals(Number(c[5] ?? 0), 4));

    const primary = amaResults[0];
    const primaryValues = Array.isArray(primary.values) ? primary.values : [];
    const primarySkip = Number(primary.erPeriod) || 0;
    const validCloses = closes.slice(primarySkip);
    const validPrimary = primaryValues.slice(primarySkip);
    const maxDev = validCloses.length && validPrimary.length
        ? Math.max(...validCloses.map((p, i) => { const vp = Number(validPrimary[i]); return vp === 0 ? 0 : Math.abs((p - vp) / vp) * 100; }))
        : 0;

    const lastPrice = closes[closes.length - 1];
    const amaStats = amaResults.map((a) => {
        const values = Array.isArray(a.values) ? a.values : [];
        const lastVal = Number(values[values.length - 1]);
        const dev = Number.isFinite(lastVal) && lastVal !== 0
            ? ((lastPrice - lastVal) / lastVal) * 100
            : 0;
        return { name: a.name, color: a.color, lastVal, dev };
    });

    const chartId = `lp-uplot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const amaMeta = amaResults.map((a) => ({
        name: a.name,
        color: a.color,
        lineWidth: a.lineWidth,
        erPeriod: a.erPeriod,
        fastPeriod: a.fastPeriod,
        slowPeriod: a.slowPeriod,
    }));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>${escapeHtml(poolLabel)} LP Price · ${escapeHtml(intervalLabel)}</title>
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
            padding: 10px 20px;
            display: flex;
            align-items: baseline;
            gap: 20px;
        }
        #header h1 {
            font-size: 18px;
            font-weight: 600;
            color: #fff;
        }
        #header .sub {
            font-size: 12px;
            color: #b8c0d0;
        }
        #stats, #params, #live {
            position: absolute;
            right: 12px;
            z-index: 100;
            background: rgba(20,24,32,0.88);
            backdrop-filter: blur(4px);
            border: 1px solid #2a2e3e;
            border-radius: 6px;
            padding: 10px 14px;
            font-size: 12px;
            line-height: 1.8;
            min-width: 240px;
        }
        #right-panel {
            position: fixed;
            top: 50px;
            right: 0;
            width: 276px;
            bottom: 0;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        #stats, #params, #live {
            position: relative;
            right: 0;
            width: 100%;
        }
        #stats .label, #params .label, #live .label { color: #c0c8d8; }
        #stats .val, #params .val, #live .val { color: #f1f5ff; font-weight: 600; }
        #stats .pos { color: #26a69a; }
        #stats .neg { color: #ef5350; }
        #params table { border-collapse: collapse; width: 100%; margin-top: 4px; }
        #live table { border-collapse: collapse; width: 100%; margin-top: 4px; }
        #params td { padding: 1px 6px 1px 0; font-size: 11px; color: #edf2ff; white-space: nowrap; }
        #live td { padding: 1px 6px 1px 0; font-size: 11px; color: #edf2ff; white-space: nowrap; }
        #params td:first-child { padding-left: 0; }
        #params th { font-size: 10px; color: #d3daea; font-weight: 400; text-align: left; padding: 0 6px 3px 0; }
        #live td:first-child { padding-left: 0; }
        #live th { font-size: 10px; color: #d3daea; font-weight: 400; text-align: left; padding: 0 6px 3px 0; }
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
            min-height: 120px;
            position: relative;
        }
        #price-chart { flex: 3.1; }
        #dev-chart { flex: 1.1; }
        #vol-chart { flex: 0.9; }
        .uplot {
            background: #0e1117;
        }
        .u-cursor-y {
            display: none !important;
            border-top: 1px dashed rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
        }
        .uplot.is-hovered .u-cursor-y {
            display: block !important;
        }
        .u-cursor-x {
            border-left: 1px dashed rgba(255, 255, 255, 0.35) !important;
            background: transparent !important;
        }
        .u-legend {
            display: none !important;
        }
    </style>
</head>
<body>

<div id="header">
    <h1><span style="color:#fb8c00">${escapeHtml(poolLabel)}</span> &nbsp; LP Swap Price</h1>
    <span class="sub">BitShares DEX · ${escapeHtml(intervalLabel)} buckets · ${amaResults.length} AMAs</span>
    <span class="sub" style="margin-left:auto">Fetched: ${fetchedAt ? escapeHtml(new Date(String(fetchedAt)).toLocaleString()) : 'n/a'}</span>
</div>

<div id="right-panel">
    <div id="stats">
        <div><span class="label">Last Price  </span><span class="val">${Number.isFinite(lastPrice) ? lastPrice.toFixed(6) : 'n/a'}</span></div>
        <div style="margin-top:4px; margin-bottom:2px"><span class="label" style="font-size:10px">── Deviations ──</span></div>
        ${amaStats.map((s) => `<div><span style="color:${s.color}">● </span><span class="label" style="font-size:11px">${escapeHtml(String(s.name || '').padEnd(22))}</span><span class="${s.dev >= 0 ? 'pos' : 'neg'}">${formatPct(s.dev)}</span></div>`).join('\n    ')}
        <div style="margin-top:6px"><span class="label">Max |dev|   </span><span class="val">${maxDev.toFixed(3)}% (primary)</span></div>
        ${thresholds.length ? `<div style="margin-top:4px; margin-bottom:2px"><span class="label" style="font-size:10px">── Clamping Thresholds ──</span></div>
        ${thresholds.map((t) => `<div><span class="label" style="font-size:11px">${(t.quantile * 100).toFixed(3)}%</span><span class="val" style="margin-left:8px">${t.multiplier}x</span></div>`).join('')}` : ''}
        ${sigmaAmaDelta !== null && sigmaAmaDelta !== undefined ? `<div><span class="label">σ_ama_delta </span><span class="val">${sigmaAmaDelta}% (hourly)</span></div>` : ''}
        <div style="margin-top:6px"><span class="label">Candles     </span><span class="val">${candles.length}</span></div>
        <div><span class="label">Source      </span><span class="label" style="font-size:10px">Kibana LP (op_type 63)</span></div>
    </div>

    <div id="params">
        <div style="margin-bottom:2px"><span class="label" style="font-size:10px">── AMA Parameters ──</span></div>
        <table id="params-table"></table>
    </div>

    <div id="live">
        <div style="margin-bottom:2px"><span class="label" style="font-size:10px">── Live Values ──</span></div>
        <table id="live-table"></table>
    </div>
</div>
<div id="charts">
    <div id="price-chart" class="chart"></div>
    <div id="dev-chart" class="chart"></div>
    <div id="vol-chart" class="chart"></div>
</div>

<script type="application/json" id="lp-payload">${serializeJsonForScript({
    ts,
    closes,
    volumes,
    amaMeta,
    amaArrays: amaResults.map((a) => (Array.isArray(a.values) ? a.values.map((v) => roundToDecimals(Number(v), 6)) : [])),
})}</script>

<script>
const payload = JSON.parse(document.getElementById('lp-payload').textContent);
const ts = payload.ts;
const closes = payload.closes;
const volumes = payload.volumes;
const amaMeta = payload.amaMeta;
const amaArrays = payload.amaArrays;
const chartGroupId = ${JSON.stringify(chartId)};

const THEME = {
    text: '#f1f5ff',
    muted: '#c0c8d8',
    background: '#0e1117',
    grid: '#1e2330',
    axis: '#8d96ad',
};

function initChart(domId, opts, data) {
    if (typeof uPlot === 'undefined') {
        throw new Error('uPlot library did not load');
    }
    const el = document.getElementById(domId);
    const rect = el.getBoundingClientRect();
    const chart = new uPlot({
        ...opts,
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(120, Math.floor(rect.height)),
    }, data, el);
    chart.root.style.background = THEME.background;
    return chart;
}

function fmtDateTime(sec) {
    const d = new Date(sec * 1000);
    return d.toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function fmtShortDate(sec) {
    const d = new Date(sec * 1000);
    return d.toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit',
    });
}

${escapeHtml.toString()}

${formatPct.toString()}

${padRange.toString()}

${roundTo.toString()}

${fixedTo.toString()}

${roundToDecimals.toString()}

function formatCompactNumber(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return 'n/a';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(abs >= 1e10 ? 0 : 2) + 'b';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(abs >= 1e7 ? 0 : 2) + 'm';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(abs >= 1e4 ? 0 : 2) + 'k';
    if (abs >= 100) return sign + abs.toFixed(0);
    if (abs >= 10) return sign + abs.toFixed(1);
    return sign + abs.toFixed(2);
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
        font: '11px Segoe UI, sans-serif',
        label: '',
        values: show ? (u, splits) => splits.map((v) => fmtShortDate(v)) : () => [],
    };
}

function makeYAxis(show, formatter, size = 58) {
    return {
        show,
        scale: 'y',
        stroke: THEME.axis,
        grid: { show: true, stroke: THEME.grid },
        ticks: { show: true, stroke: THEME.axis, width: 1 },
        size,
        space: 72,
        font: '11px Segoe UI, sans-serif',
        values: formatter || undefined,
    };
}

function makeCursor() {
    return ${makeCursorConfig('chartGroupId')};
}

function makePlotBase(showX, yFormatter, yScale, yRange, extraHooks = {}) {
    return {
        width: 0,
        height: 0,
        title: null,
        legend: { show: false },
        cursor: makeCursor(),
        select: { show: false },
        scales: {
            x: {
                time: true,
            },
            y: yScale,
        },
        axes: [
            makeAxis(showX, 'x'),
            makeYAxis(true, yFormatter),
        ],
        series: [
            { label: 'Time' },
        ],
        padding: [8, 8, 0, 8],
        hooks: {
            ready: [
                (u) => {
                    u.root.style.background = THEME.background;
                },
            ],
            ...extraHooks,
        },
    };
}

function lineSeries(name, color, width, dash, extra = {}) {
    return {
        label: name,
        stroke: color,
        width,
        points: { show: false },
        fill: null,
        ...extra,
    };
}

function makeDevSplits(scaleMin, scaleMax, foundIncr, foundSpace) {
    if (!Number.isFinite(scaleMin) || !Number.isFinite(scaleMax)) return [];

    const span = scaleMax - scaleMin;
    const step = span <= 75 || foundSpace >= 60 ? 12.5 : 25;
    const start = Math.ceil(scaleMin / step) * step;
    const end = Math.floor(scaleMax / step) * step;
    const splits = [];

    for (let v = start; v <= end + 1e-9; v += step) {
        const rounded = roundTo(v, 100);
        if (!splits.length || splits[splits.length - 1] !== rounded) splits.push(rounded);
    }

    if (scaleMin <= 0 && scaleMax >= 0 && !splits.includes(0)) {
        splits.push(0);
        splits.sort((a, b) => a - b);
    }

    return splits;
}

function makeVolumeSplits(scaleMin, scaleMax, foundIncr, foundSpace) {
    if (!Number.isFinite(scaleMin) || !Number.isFinite(scaleMax)) return [];

    if (scaleMax <= scaleMin) return [];

    const start = roundTo(scaleMin, 100);
    const mid = roundToDecimals((scaleMin + scaleMax) / 2, 2);
    const end = roundTo(scaleMax, 100);
    const splits = [start];

    if (mid > start && mid < end) splits.push(mid);
    if (end > start) splits.push(end);

    return splits;
}

const liveCells = {
    time: null,
    price: null,
    amas: [],
    devs: [],
    volume: null,
};

function setLiveCell(td, value, className = null) {
    if (!td) return;
    td.textContent = value;
    if (className != null) td.className = className;
}

function renderLiveTable() {
    const tbl = document.getElementById('live-table');
    const rows = [
        ['Time', null],
        ['Price', null],
    ];

    amaMeta.forEach((a) => rows.push([a.name.split(' - ')[0], a.color]));
    amaMeta.forEach((a) => rows.push([a.name.split(' - ')[0] + ' Dev', a.color]));
    rows.push(['Volume', '#5c9ee6']);

    rows.forEach(([label, color], i) => {
        const tr = tbl.insertRow();
        const labelCell = tr.insertCell();
        labelCell.innerHTML = color ? '<span style="color:' + color + '">● </span>' + escapeHtml(label) : escapeHtml(label);
        const valueCell = tr.insertCell();
        valueCell.className = 'val';
        valueCell.textContent = '--';

        if (i === 0) liveCells.time = valueCell;
        else if (i === 1) liveCells.price = valueCell;
        else if (i > 1 && i <= 1 + amaMeta.length) liveCells.amas.push(valueCell);
        else if (i > 1 + amaMeta.length && i <= 1 + amaMeta.length * 2) liveCells.devs.push(valueCell);
        else liveCells.volume = valueCell;
    });
}

function updateLivePanelAtIndex(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= ts.length) return;

    setLiveCell(liveCells.time, fmtDateTime(ts[idx]));
    setLiveCell(liveCells.price, Number.isFinite(closes[idx]) ? closes[idx].toFixed(6) : 'n/a');

    amaArrays.forEach((arr, i) => {
        const val = arr[idx];
        setLiveCell(liveCells.amas[i], Number.isFinite(val) ? val.toFixed(6) : 'n/a');
    });

    amaDevArrays.forEach((arr, i) => {
        const val = arr[idx];
        setLiveCell(liveCells.devs[i], Number.isFinite(val) ? formatPct(val) : 'n/a');
    });

    setLiveCell(liveCells.volume, Number.isFinite(volumes[idx]) ? formatCompactNumber(volumes[idx]) : 'n/a');
}

let lastLiveIdx = -1;

function applyChartHeights() {
    const available = Math.max(window.innerHeight - 44, 600);
    const priceH = Math.max(320, Math.floor(available * 0.60));
    const devH = Math.max(150, Math.floor(available * 0.22));
    const volH = Math.max(120, Math.max(available - priceH - devH, Math.floor(available * 0.18)));
    document.getElementById('price-chart').style.height = priceH + 'px';
    document.getElementById('dev-chart').style.height = devH + 'px';
    document.getElementById('vol-chart').style.height = volH + 'px';
}

function showFatal(message) {
    const charts = document.getElementById('charts');
    charts.innerHTML = '<div style="padding:20px;color:#ef5350;font-size:14px;white-space:pre-wrap;">' + String(message) + '</div>';
}

(function renderParamsTable() {
    const tbl = document.getElementById('params-table');
    const hdr = tbl.insertRow();
    ['', 'ER', 'Fast', 'Slow'].forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        hdr.appendChild(th);
    });
    amaMeta.forEach((a) => {
        const row = tbl.insertRow();
        const dot = document.createElement('td');
        dot.innerHTML = \`<span style="color:\${a.color}">●</span> \${a.name.split(' - ')[0]}\`;
        row.appendChild(dot);
        [a.erPeriod, a.fastPeriod, a.slowPeriod].forEach((v) => {
            const td = row.insertCell();
            td.textContent = v ?? '—';
        });
    });
})();

const amaDevArrays = amaArrays.map((values, i) =>
    closes.map((p, idx) => {
        const v = values[idx];
        if (!Number.isFinite(v) || v === 0) return null;
        return roundToDecimals(((p - v) / v) * 100, 2);
    })
);

renderLiveTable();
applyChartHeights();

const priceData = [ts, closes, ...amaArrays];
const devData = [ts, ...amaDevArrays];
const volData = [ts, volumes];

let priceChart;
let devChart;
let volChart;
let charts = [];

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
        {
            ...makeYAxis(true, null, 80),
            border: { show: true, stroke: THEME.axis, width: 2 },
            grid: { show: true, stroke: THEME.grid, width: 2 },
        },
    ],
    padding: [8, 8, 12, 8],
    series: [
        { label: 'Time' },
        lineSeries('${escapeHtml(String(assetA.symbol || '?'))}/${escapeHtml(String(assetB.symbol || '?'))} VWAP', '#5c9ee6', 1.5),
        ...amaMeta.map((cfg) => lineSeries(cfg.name, cfg.color, cfg.lineWidth || 1.5)),
    ],
}, priceData);

devChart = initChart('dev-chart', {
    ...makePlotBase(false, (u, vals) => vals.map((v) => fixedTo(v, 2) + '%'), {
        auto: true,
        range: (u, min, max) => {
            if (!Number.isFinite(min) || !Number.isFinite(max)) return [min, max];
            const maxAbs = Math.max(Math.abs(min), Math.abs(max));
            const limit = Math.max(maxAbs * 1.15, 25);
            return [-limit, limit];
        },
    }),
    axes: [
        makeAxis(false, 'x'),
        {
            ...makeYAxis(true, (u, vals) => vals.map((v) => fixedTo(v, 2) + '%'), 82),
            border: { show: true, stroke: THEME.axis, width: 2 },
            grid: { show: true, stroke: THEME.grid, width: 2 },
            splits: (u, axisIdx, scaleMin, scaleMax) => makeDevSplits(scaleMin, scaleMax),
        },
    ],
    series: [
        { label: 'Time' },
        ...amaMeta.map((cfg) => lineSeries(cfg.name, cfg.color, 1.25)),
    ],
    padding: [8, 8, 12, 8],
}, devData);

volChart = initChart('vol-chart', {
    ...makePlotBase(true, (u, vals) => vals.map((v) => Number(v).toLocaleString()), {
        auto: true,
        range: (u, min, max) => padRange(min, max, 0.04, 0.04) || [min, max],
    }),
    axes: [
        makeAxis(true, 'x'),
        {
            ...makeYAxis(true, (u, vals) => vals.map((v) => Number(v).toLocaleString()), 82),
            border: { show: true, stroke: THEME.axis, width: 2 },
            grid: { show: true, stroke: THEME.grid, width: 2 },
            ticks: { show: true, stroke: THEME.axis, width: 2 },
            splits: (u, axisIdx, scaleMin, scaleMax, foundIncr, foundSpace) => makeVolumeSplits(scaleMin, scaleMax, foundIncr, foundSpace),
        },
    ],
    series: [
        { label: 'Time' },
        {
            label: 'Volume (' + ${JSON.stringify(escapeHtml(String(assetA.symbol || '?')))} + ')',
            stroke: 'rgba(92,158,230,1)',
            fill: 'rgba(92,158,230,1)',
            width: 1,
            points: { show: false },
            paths: uPlot.paths.bars({ align: 0, gap: 1, size: [0.72, 14, 1] }),
        },
    ],
}, volData);
} catch (err) {
    console.error(err);
    showFatal(err && err.message ? err.message : String(err));
    throw err;
}

charts = [priceChart, devChart, volChart];
const [xMin, xMax] = [ts[0], ts[ts.length - 1]];
let pendingRange = null;
let pendingRangeRaf = 0;

${UPLOT_SHARED_SCRIPT}

${bindHoverStateFn()}

function sizeCharts() {
    applyChartHeights();
    for (const chart of charts) {
        const rect = chart.root.parentElement.getBoundingClientRect();
        const width = Math.max(320, Math.floor(rect.width));
        const height = Math.max(120, Math.floor(rect.height));
        chart.setSize({ width, height });
    }
}

window.addEventListener('resize', sizeCharts);
${zoomResetScript()}

charts.forEach((chart) => {
    bindWheelZoom(chart);
    bindPan(chart);
});
bindHoverState(priceChart);
bindHoverState(devChart);
bindHoverState(volChart);

// Wire live panel to all chart plot areas. All charts share the same x-data,
// so cursor.idx is identical across them. Track lastLiveIdx so mouseleave
// restores the most-recently-hovered candle (not just the last data point).
lastLiveIdx = ts.length - 1;

let leavePending = null;

charts.forEach((chart) => {
    chart.over.addEventListener('mousemove', () => {
        if (leavePending !== null) { clearTimeout(leavePending); leavePending = null; }
        const idx = chart.cursor.idx;
        if (idx != null) {
            lastLiveIdx = idx;
            updateLivePanelAtIndex(idx);
        }
    });
    chart.over.addEventListener('mouseleave', () => {
        // Small delay so moving between charts doesn't flash the last-candle values
        leavePending = setTimeout(() => {
            leavePending = null;
            updateLivePanelAtIndex(lastLiveIdx);
        }, 60);
    });
});

const raf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 0);

raf(() => {
    sizeCharts();
    // Set panel to last candle after all init-time setCursor events have settled
    updateLivePanelAtIndex(lastLiveIdx);
});
</script>
</body>
</html>`;
}

export { generateHTML }

