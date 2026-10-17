'use strict';

import { MARKET_ADAPTER } from '../../modules/constants.js';
import { escapeHtml, serializeJsonForScript, toEpochSeconds, UPLOT_SHARED_SCRIPT, uplotInlineTags } from '../chart_utils.js';
import { sharedChartCSS } from '../chart_css.js';
import { Y_AXIS_SIZE, makeCursorConfig, bindHoverStateFn, wireChartEvents, zoomResetScript, sizeChartsFn, fmtDateFn } from '../chart_ui.js';

// Zone boundaries sourced from MARKET_ADAPTER (single source of truth shared
// with the live adapter) instead of hardcoded copies. Hurst classification
// uses inclusive >=/<= bounds matching market_adapter/core/signals/hurst_analyzer.ts.
const HURST_WINDOW_DEFAULT = MARKET_ADAPTER.HURST_CONFIG.window;
const HURST_SCALES_DEFAULT = MARKET_ADAPTER.HURST_CONFIG.scales;
const PE_M_DEFAULT = MARKET_ADAPTER.PE_CONFIG.m;
const PE_WINDOW_DEFAULT = MARKET_ADAPTER.PE_CONFIG.window;
const H_UPPER = 0.5 + MARKET_ADAPTER.HURST_ZONE_BAND;
const H_LOWER = 0.5 - MARKET_ADAPTER.HURST_ZONE_BAND;
const PE_STRUCTURED = MARKET_ADAPTER.PE_NODES[0];
const PE_NOISE = MARKET_ADAPTER.PE_NODES[MARKET_ADAPTER.PE_NODES.length - 1];


/**
 * Build background-shading segments for a value array.
 * greenFn/redFn return true when the value falls in that zone.
 * Returns an array of { from, to, color } objects (null-color segments omitted).
 */
function buildSegments(values: Array<number | null>, greenFn: (v: number) => boolean, redFn: (v: number) => boolean) {
    const segments: { from: number; to: number; color: string }[] = [];
    let start = 0, color: string | null = null;

    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        let next: string | null = null;
        if (v != null) {
            if (greenFn(v))     next = 'rgba(46,160,67,0.13)';
            else if (redFn(v))  next = 'rgba(248,81,73,0.13)';
        }
        if (next !== color) {
            if (color !== null) segments.push({ from: start, to: i - 1, color });
            color = next;
            start = i;
        }
    }
    if (color !== null) segments.push({ from: start, to: values.length - 1, color });
    return segments;
}

interface RegimeRow {
    [key: string]: unknown;
    timestamp: string | number;
    price: number;
    ama3Price?: number | null;
    hurstReady?: boolean;
    hurst?: number | null;
    peReady?: boolean;
    normalizedEntropy?: number | null;
}

interface RegimeChartInput {
    allResults?: RegimeRow[];
    hurstConfig?: { window?: number; scales?: number[] };
    peConfig?: { m?: number; window?: number };
    dates?: number[];
    prices?: (number | null)[];
    hurstArr?: (number | null)[];
    peArr?: (number | null)[];
    hurstSegments?: unknown[];
    peSegments?: unknown[];
    realBarCount?: number;
    [key: string]: unknown;
}

function generateRegimeHTML(data: RegimeChartInput, title = 'Regime Analysis') {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const hurstConfig = data.hurstConfig || {};
    const peConfig    = data.peConfig    || {};

    const interval = results.length > 1
        ? (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000
        : 3600;

    const dates      = results.map((r: RegimeRow, i: number) => toEpochSeconds(r.timestamp, i));
    const prices: (number | null)[] = results.map((r: RegimeRow) => r.price);
    const ama3Prices = results.map((r: RegimeRow) => r.ama3Price ?? null);
    const hurstArr: (number | null)[] = results.map((r: RegimeRow) => r.hurstReady ? (r.hurst ?? null) : null);
    const peArr: (number | null)[]    = results.map((r: RegimeRow) => r.peReady ? (r.normalizedEntropy ?? null) : null);

    const realBarCount = results.length;

    // Extend arrays with null padding so the last real bar is not glued to chart right edge
    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 80; i++) {
        dates.push(lastDate + i * interval);
        prices.push(null);
        ama3Prices.push(null);
        hurstArr.push(null);
        peArr.push(null);
    }

    // Background shading segments (server-side, passed to browser via JSON payload)
    const hurstSegments = buildSegments(hurstArr.slice(0, realBarCount), (v: number) => v >= H_UPPER, (v: number) => v <= H_LOWER);
    const peSegments    = buildSegments(peArr.slice(0, realBarCount),    (v: number) => v < PE_STRUCTURED, (v: number) => v > PE_NOISE);

    const payload = {
        dates, prices, ama3Prices, hurstArr, peArr,
        hurstSegments, peSegments,
        realBarCount,
        hurstWindow: hurstConfig.window ?? HURST_WINDOW_DEFAULT,
        peM:         peConfig.m         ?? PE_M_DEFAULT,
        peWindow:    peConfig.window    ?? PE_WINDOW_DEFAULT,
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    ${uplotInlineTags()}
    <style>
        ${sharedChartCSS()}
        #price-panel  { flex: 0 0 34%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #hurst-panel  { flex: 0 0 28%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #pe-panel     { flex: 1 1 0;   min-height: 0; position: relative; }
        .badge { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 10px; font-weight: bold; }
        .badge-green  { background: rgba(46,160,67,0.25); color: #3fb950; }
        .badge-red    { background: rgba(248,81,73,0.25); color: #ff7b72; }
        .badge-grey   { background: rgba(110,118,129,0.2); color: #adbac7; }
    </style>
</head>
<body>
    <div id="header">
        <div style="font-weight:bold;color:#fff;">${escapeHtml(title)}</div>
        <div style="display:flex;align-items:center;gap:16px;">
            <span style="font-size:10px;color:#8b949e;font-family:monospace;">
                Hurst: window=${escapeHtml(String(hurstConfig.window ?? HURST_WINDOW_DEFAULT))}&thinsp;bars &middot; scales=[${escapeHtml((hurstConfig.scales ?? HURST_SCALES_DEFAULT).join(','))}]
                &nbsp;&nbsp;|&nbsp;&nbsp;
                PE: m=${escapeHtml(String(peConfig.m ?? PE_M_DEFAULT))} &middot; window=${escapeHtml(String(peConfig.window ?? PE_WINDOW_DEFAULT))}&thinsp;bars
            </span>
            <span style="font-size:11px;color:#adbac7;text-transform:uppercase;">
                H&ge;${H_UPPER.toFixed(2)}=trend &middot; H&le;${H_LOWER.toFixed(2)}=revert &middot; PE&lt;${PE_STRUCTURED.toFixed(2)}=structured &middot; PE&gt;${PE_NOISE.toFixed(2)}=noise
                &nbsp;&nbsp;|&nbsp;&nbsp; Scroll &middot; Drag &middot; Ctrl+0
            </span>
        </div>
    </div>

    <div id="panels">
        <div id="price-panel">
            <div class="section-label">PRICE (LOG)</div>
            <div class="legend">
                <div class="legend-item" style="color:#555;"><span id="l-date">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#58a6ff;"></div>Price: <span id="l-price" style="font-weight:bold;color:#58a6ff;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#e3b341;"></div>AMA3: <span id="l-ama3" style="color:#e3b341;">-</span></div>
            </div>
            <div id="price-chart"></div>
        </div>
        <div id="hurst-panel">
            <div class="section-label">HURST EXPONENT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#4dc3ff;"></div>H: <span id="l-hurst" style="font-weight:bold;color:#4dc3ff;">-</span></div>
                <div class="legend-item">Regime: <span id="l-hurst-regime" style="font-weight:bold;">-</span></div>
                <div class="legend-item" style="color:#555;font-size:10px;">window=${escapeHtml(String(hurstConfig.window ?? HURST_WINDOW_DEFAULT))} bars</div>
            </div>
            <div id="hurst-chart"></div>
        </div>
        <div id="pe-panel">
            <div class="section-label">PERMUTATION ENTROPY (NORM.)</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>PE: <span id="l-pe" style="font-weight:bold;color:#d2a8ff;">-</span></div>
                <div class="legend-item">Regime: <span id="l-pe-regime" style="font-weight:bold;">-</span></div>
                <div class="legend-item" style="color:#555;font-size:10px;">m=${escapeHtml(String(peConfig.m ?? PE_M_DEFAULT))}, window=${escapeHtml(String(peConfig.window ?? PE_WINDOW_DEFAULT))} bars</div>
            </div>
            <div id="pe-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript(payload)}</script>

    <script>
    (function () {
        const data = JSON.parse(document.getElementById('payload').textContent);
        const SYNC_KEY = 'regime-v1';
        const X_AXIS_CFG = { show: false, stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' };
        const cursorCfg = ${makeCursorConfig()};

        // ── helpers ──────────────────────────────────────────────────────────
        function fmtPrice(v) {
            if (v == null) return '-';
            return v < 0.01 ? v.toPrecision(4) : v < 100 ? v.toFixed(4) : v.toFixed(2);
        }
        function fmtH(v)  { return v == null ? '-' : v.toFixed(3); }
        function fmtPE(v) { return v == null ? '-' : v.toFixed(3); }
        ${fmtDateFn()}
        ${bindHoverStateFn()}

        // Inclusive zone boundaries — same semantics as the live classifier
        // (market_adapter/core/signals/hurst_analyzer.ts classifyHurst).
        const H_UPPER = ${JSON.stringify(H_UPPER)};
        const H_LOWER = ${JSON.stringify(H_LOWER)};
        const PE_STRUCTURED = ${JSON.stringify(PE_STRUCTURED)};
        const PE_NOISE = ${JSON.stringify(PE_NOISE)};

        function hurstRegimeLabel(v) {
            if (v == null) return '<span class="badge badge-grey">-</span>';
            if (v >= H_UPPER) return '<span class="badge badge-green">TRENDING</span>';
            if (v <= H_LOWER) return '<span class="badge badge-red">MEAN REV</span>';
            return '<span class="badge badge-grey">RANDOM</span>';
        }
        function peRegimeLabel(v) {
            if (v == null) return '<span class="badge badge-grey">-</span>';
            if (v < PE_STRUCTURED) return '<span class="badge badge-green">STRUCTURED</span>';
            if (v > PE_NOISE) return '<span class="badge badge-red">NOISE</span>';
            return '<span class="badge badge-grey">MIXED</span>';
        }

        // ── background-shading + reference-lines draw hook ───────────────────
        // Uses valToPos(..., true) = CSS pixels, matching how u.bbox works in draw hooks.
        function makeBgHook(segments, refLines, yScaleKey) {
            return (u) => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();

                for (const seg of segments) {
                    if (!seg.color) continue;
                    const x0 = u.valToPos(data.dates[seg.from], 'x', true);
                    const toIdx = Math.min(seg.to + 1, data.dates.length - 1);
                    const x1 = u.valToPos(data.dates[toIdx], 'x', true);
                    ctx.fillStyle = seg.color;
                    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
                }

                for (const rl of refLines) {
                    const yPos = u.valToPos(rl.y, yScaleKey, true);
                    ctx.strokeStyle = rl.color;
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.moveTo(bbox.left, yPos);
                    ctx.lineTo(bbox.left + bbox.width, yPos);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                ctx.restore();
            };
        }

        function yAxis(scaleKey) {
            return { side: 1, scale: scaleKey, stroke: '#ffffff', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30363d', width: 1 }, size: ${Y_AXIS_SIZE}, font: '11px Segoe UI, sans-serif' };
        }

        // ── x-range sync (shared across all panels) ─────────────────────────
        const xMin = data.dates[0];
        const xMax = data.dates[data.dates.length - 1];
        let pendingRange = null, pendingRangeRaf = 0;
        let priceChart, hurstChart, peChart;
        let charts;

        ${UPLOT_SHARED_SCRIPT}

        // ── chart instances ──────────────────────────────────────────────────

        const hurstRefLines = [
            { y: H_UPPER, color: 'rgba(46,160,67,0.5)'   },
            { y: 0.50, color: 'rgba(110,118,129,0.3)'  },
            { y: H_LOWER, color: 'rgba(248,81,73,0.5)'    },
        ];
        const peRefLines = [
            { y: PE_NOISE, color: 'rgba(248,81,73,0.5)'  },
            { y: PE_STRUCTURED, color: 'rgba(46,160,67,0.5)'  },
        ];

        const hurstBgFn = makeBgHook(data.hurstSegments, hurstRefLines, 'h');
        const peBgFn    = makeBgHook(data.peSegments,    peRefLines,    'p');

        function init() {
            const priceEl = document.getElementById('price-panel');
            const hurstEl = document.getElementById('hurst-panel');
            const peEl    = document.getElementById('pe-panel');

            priceChart = new uPlot({
                width: priceEl.offsetWidth, height: priceEl.offsetHeight,
                padding: [4, 4, 2, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, y: { auto: true, distr: 3, log: 10, range: (u, min, max) => [min * 0.95, max * 1.05] } },
                series: [
                    { label: 'Time' },
                    { label: 'Price', stroke: '#58a6ff', width: 1.5, scale: 'y', points: { show: false } },
                    { label: 'AMA3',  stroke: '#e3b341', width: 1,   scale: 'y', points: { show: false } },
                ],
                axes: [
                    X_AXIS_CFG,
                    { ...yAxis('y'), splits: logAxisSplits, values: (u, v) => v.map(x => x != null ? fmtPrice(x) : '') },
                ],
                cursor: cursorCfg,
                hooks: { draw: [(u) => { updateLegend(u.cursor.idx); }] },
            }, [data.dates, data.prices, data.ama3Prices], document.getElementById('price-chart'));

            hurstChart = new uPlot({
                width: hurstEl.offsetWidth, height: hurstEl.offsetHeight,
                padding: [4, 4, 2, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, h: { auto: true } },
                series: [
                    { label: 'Time' },
                    { label: 'Hurst', stroke: '#4dc3ff', width: 1.5, scale: 'h', points: { show: false } },
                ],
                axes: [
                    X_AXIS_CFG,
                    { ...yAxis('h'), values: (u, v) => v.map(x => x != null ? x.toFixed(2) : '') },
                ],
                cursor: cursorCfg,
                hooks: { draw: [hurstBgFn] },
            }, [data.dates, data.hurstArr], document.getElementById('hurst-chart'));

            peChart = new uPlot({
                width: peEl.offsetWidth, height: peEl.offsetHeight,
                padding: [4, 4, 4, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, p: { range: [0, 1] } },
                series: [
                    { label: 'Time' },
                    { label: 'PE', stroke: '#d2a8ff', width: 1.5, scale: 'p', points: { show: false } },
                ],
                axes: [
                    { ...X_AXIS_CFG, show: true },
                    { ...yAxis('p'), values: (u, v) => v.map(x => x != null ? x.toFixed(2) : '') },
                ],
                cursor: cursorCfg,
                hooks: { draw: [peBgFn] },
            }, [data.dates, data.peArr], document.getElementById('pe-chart'));

            charts = [priceChart, hurstChart, peChart];
            ${wireChartEvents('charts', 'updateLegend', 'null')}
        }

        // ── cursor legend update ─────────────────────────────────────────────
        function updateLegend(idx) {
            if (idx == null || idx >= data.realBarCount) return;
            document.getElementById('l-date').textContent  = fmtDate(data.dates[idx]);
            document.getElementById('l-price').textContent = fmtPrice(data.prices[idx]);
            document.getElementById('l-ama3').textContent  = fmtPrice(data.ama3Prices[idx]);
            document.getElementById('l-hurst').textContent = fmtH(data.hurstArr[idx]);
            document.getElementById('l-pe').textContent    = fmtPE(data.peArr[idx]);
            document.getElementById('l-hurst-regime').innerHTML = hurstRegimeLabel(data.hurstArr[idx]);
            document.getElementById('l-pe-regime').innerHTML    = peRegimeLabel(data.peArr[idx]);
        }

        // ── resize ───────────────────────────────────────────────────────────
        ${sizeChartsFn([['priceChart', 'price-panel'], ['hurstChart', 'hurst-panel'], ['peChart', 'pe-panel']])}

        window.addEventListener('resize', sizeCharts);
        ${zoomResetScript()}

        init();
        requestAnimationFrame(() => requestAnimationFrame(() => sizeCharts()));

    })();
    </script>
</body>
</html>`;
}

export { generateRegimeHTML };
export type { RegimeRow };

