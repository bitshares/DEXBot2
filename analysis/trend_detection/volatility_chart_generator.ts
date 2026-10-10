'use strict';

import { MARKET_ADAPTER } from '../../modules/constants.js';
import { computeATRSeries } from '../../market_adapter/core/strategies/atr/calculator.js';
import { computeVolatilityShift } from '../../market_adapter/core/strategies/volatility_shift.js';
import { embedFunctionSources, escapeHtml, serializeJsonForScript, toEpochSeconds, UPLOT_SHARED_SCRIPT, uplotInlineTags } from '../chart_utils.js';
import { sharedChartCSS } from '../chart_css.js';
import { Y_AXIS_SIZE, makeCursorConfig, bindHoverStateFn, wireChartEvents, zoomResetScript, sizeChartsFn, refreshChartsPreservingZoomFn } from '../chart_ui.js';

const EMBEDDED_SHARED_FUNCS = embedFunctionSources([computeATRSeries, computeVolatilityShift]);


interface VolatilityRow {
    timestamp: string | number;
    price: number;
    ama3Price?: number | null;
    atr?: number;
    weightVariance?: number | null;
    rawSymmetricDelta?: number;
    symmetricDelta?: number;
    effectiveWeight?: number;
    sellW?: number;
    buyW?: number;
}

interface VolatilityChartInput {
    allResults?: VolatilityRow[];
    volatilityConfig?: { volatilityThreshold?: number; atrPeriod?: number; volatilityExponent?: number; volatilityScaleX?: number; volatilityClamp?: number };
    volatilityThreshold?: number;
    atrPeriod?: number;
    volatilityExponent?: number;
    volatilityScaleX?: number;
    volatilityClamp?: number;
    minWeight?: number;
    maxWeight?: number;
    candles?: unknown[];
    [key: string]: unknown;
}

function generateHTML(data: VolatilityChartInput, title = 'ATR Volatility Research') {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const volatilityCfg = data.volatilityConfig || {};
    const defaultThreshold = data.volatilityThreshold ?? volatilityCfg.volatilityThreshold
        ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD;
    const defaultAtrPeriod = data.atrPeriod ?? volatilityCfg.atrPeriod ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT;
    const defaultExponent = data.volatilityExponent ?? volatilityCfg.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const defaultScaleX = data.volatilityScaleX ?? volatilityCfg.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;
    const defaultClamp = data.volatilityClamp ?? volatilityCfg.volatilityClamp ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP;
    const defaultMinWeight = data.minWeight ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
    const defaultMaxWeight = data.maxWeight ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
    const interval = results.length > 1
        ? (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000
        : 3600;

    const dates = results.map((r: VolatilityRow, i: number) => toEpochSeconds(r.timestamp || Date.now(), i));
    const prices: (number | null)[] = results.map((r: VolatilityRow) => r.price);
    const ama3Prices = results.map((r: VolatilityRow) => r.ama3Price ?? null);
    const baseVarianceSeries = results.map((r: VolatilityRow) => r.weightVariance ?? null);
    const candleRows = Array.isArray(data.candles) ? data.candles : [];

    const realBarCount = results.length;
    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 120; i++) {
        dates.push(lastDate + (i * interval));
        prices.push(null);
        ama3Prices.push(null);
        baseVarianceSeries.push(null);
    }

    const payload = {
        dates,
        prices,
        ama3Prices,
        candles: candleRows,
        atrPeriod: defaultAtrPeriod,
        varianceSeries: baseVarianceSeries,
        realBarCount,
        volatilityThreshold: defaultThreshold,
        volatilityExponent: defaultExponent,
        volatilityScaleX: defaultScaleX,
        volatilityClamp: defaultClamp,
        minWeight: defaultMinWeight,
        maxWeight: defaultMaxWeight,
        marketAdapter: MARKET_ADAPTER,
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <title>${escapeHtml(title)}</title>
    ${uplotInlineTags()}
    <style>
        ${sharedChartCSS()}
        :root { color-scheme: dark; }
        #header-left { font-weight: bold; color: #fff; }
        #hint { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.4px; white-space: nowrap; }
        #price-panel { flex: 0 0 33%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #variance-panel { flex: 0 0 27%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #variance-panel .legend { top: 10px; }
        #variance-chart { margin-top: 0; height: 100%; }
        #shift-panel { flex: 0 0 40%; min-height: 0; position: relative; }
        #shift-panel .legend { top: 18px; }
        #shift-chart { margin-top: 0; height: calc(100% - 30px); }
        .legend { position: absolute; top: 8px; left: 12px; right: 12px; font-size: 11px; pointer-events: none; z-index: 10; display: flex; gap: 12px; color: #adbac7; white-space: nowrap; align-items: center; flex-wrap: wrap; }
        .legend-val { font-family: monospace; font-weight: bold; }
        .ctrl { pointer-events: auto; display: inline-flex; align-items: center; gap: 3px; margin-left: 0; }
        .ctrl label { color: #8b949e; font-size: 11px; min-width: 34px; text-align: right; }
        .ctrl input[type="range"] { width: 138px; height: 3px; margin-right: 0; }
        .ctrl .val { font-weight: bold; font-size: 11px; min-width: 36px; display: inline-block; text-align: right; margin-left: 0; }
        .ctrl.thr label { min-width: 26px; }
        .ctrl.atr label { min-width: 28px; }
        .ctrl.exp label { min-width: 24px; }
        .ctrl.scale label { min-width: 38px; }
        .ctrl.clamp label { min-width: 36px; }
        .ctrl.thr input[type="range"] { accent-color: #8b949e; }
        .ctrl.thr .val { color: #8b949e; }
        .ctrl.atr input[type="range"] { accent-color: #3fb950; }
        .ctrl.atr .val { color: #3fb950; }
        .ctrl.atr input[type="range"] { margin-right: -6px; }
        .ctrl.exp input[type="range"] { accent-color: #58a6ff; }
        .ctrl.exp .val { color: #58a6ff; }
        .ctrl.thr input[type="range"],
        .ctrl.atr input[type="range"],
        .ctrl.exp input[type="range"],
        .ctrl.scale input[type="range"],
        .ctrl.clamp input[type="range"] { width: 138px; }
        .ctrl.scale input[type="range"] { accent-color: #f0883e; }
        .ctrl.scale input[type="range"] { margin-right: 8px; }
        .ctrl.scale .val { color: #f0883e; }
        .ctrl.clamp input[type="range"] { accent-color: #a371f7; }
        .ctrl.clamp .val { color: #a371f7; }
        .group-sep { border-left: 1px solid #30363d; margin-left: 2px; padding-left: 2px; display: inline-flex; align-items: center; height: 18px; }
        .signal-summary { margin-left: 8px; min-width: 313px; max-width: 450px; flex: 0 0 338px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; justify-content: center; }
        .signal-bar { display: flex; width: 100%; height: 15px; overflow: hidden; border-radius: 999px; background: #10151d; border: 1px solid #30363d; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03), 0 0 10px rgba(88,166,255,0.08); }
        .signal-seg { position: relative; height: 100%; min-width: 1px; transition: width 0.18s ease; box-shadow: inset 0 0 8px rgba(255,255,255,0.14), 0 0 8px currentColor; }
        .signal-seg:not(:last-child) { border-right: 1px solid rgba(255,255,255,0.34); }
        .signal-seg.below { color: #58a6ff; background: linear-gradient(90deg, #3b82f6 0%, #7dd3fc 100%); box-shadow: inset 0 0 4px rgba(255,255,255,0.14); }
        .signal-seg.mid { color: #ffd24a; background: linear-gradient(90deg, #ffe066 0%, #fff3a0 100%); box-shadow: inset 0 0 4px rgba(255,255,255,0.18); }
        .signal-seg.over { color: #f85149; background: linear-gradient(90deg, #ff4d4d 0%, #ff8a8a 100%); box-shadow: inset 0 0 4px rgba(255,255,255,0.12); }
        .signal-labels { position: relative; width: 100%; height: 12px; font-size: 10px; color: #8b949e; white-space: nowrap; }
        .signal-labels span { position: absolute; top: 0; transform: translateY(0); pointer-events: none; }
        .signal-labels span:nth-child(1) { left: 2px; color: #58a6ff; }
        .signal-labels span:nth-child(2) { left: 50%; transform: translate(-50%, 0); color: #ffd24a; }
        .signal-labels span:nth-child(3) { right: 2px; color: #f85149; }
    </style>
</head>
<body>
    <div id="header">
        <div id="header-left">${escapeHtml(title)}</div>
        <div id="hint">Log price only · weight variance · symmetric shift · wheel zoom · drag pan · Ctrl+0 reset</div>
    </div>

    <div id="panels">
        <div id="price-panel">
            <div class="section-label">PRICE (LOG)</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#58a6ff;"></div>Price: <span id="l-price" class="legend-val" style="color:#58a6ff;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#e3b341;"></div>AMA3: <span id="l-ama3" class="legend-val" style="color:#e3b341;">-</span></div>
            </div>
            <div id="price-chart"></div>
        </div>
        <div id="variance-panel">
            <div class="section-label">WEIGHT VARIANCE</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>Weight variance: <span id="l-var" class="legend-val" style="color:#d2a8ff;">-</span></div>
            </div>
            <div id="variance-chart"></div>
        </div>
            <div id="shift-panel">
            <div class="section-label">SYMMETRIC SHIFT</div>
            <div class="legend" style="gap: 10px;">
                <div class="legend-item"><div class="dot" style="background:#f85149;"></div>Δ: <span id="l-delta" class="legend-val" style="color:#f85149;">-</span></div>
                <div class="legend-item">Weff: <span id="l-weff" class="legend-val" style="color:#3fb950;">-</span></div>
                <div class="group-sep"></div>
                <div class="ctrl thr"><label for="threshold-slider">thr</label><input type="range" id="threshold-slider" min="0" max="500" step="1" value="${Math.round(defaultThreshold * 1000)}"><span class="val" id="threshold-value">${defaultThreshold.toFixed(3)}</span></div>
                <div class="ctrl atr"><label for="atr-slider">atr</label><input type="range" id="atr-slider" min="${MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MIN}" max="${MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MAX}" step="1" value="${Math.round(defaultAtrPeriod)}"><span class="val" id="atr-value">${Math.round(defaultAtrPeriod)}</span></div>
                <div class="ctrl clamp"><label for="clamp-slider">clamp</label><input type="range" id="clamp-slider" min="100" max="1000" step="1" value="${Math.round(defaultClamp * 1000)}"><span class="val" id="clamp-value">${defaultClamp.toFixed(3)}</span></div>
                <div class="ctrl exp"><label for="exponent-slider">exp</label><input type="range" id="exponent-slider" min="500" max="1000" step="1" value="${Math.round(defaultExponent * 1000)}"><span class="val" id="exponent-value">${defaultExponent.toFixed(3)}</span></div>
                <div class="ctrl scale"><label for="scale-slider">scaleX</label><input type="range" id="scale-slider" min="100" max="10000" step="1" value="${Math.round(defaultScaleX * 100)}"><span class="val" id="scale-value">${defaultScaleX.toFixed(2)}x</span></div>
                <div class="signal-summary">
                    <div class="signal-bar" id="signal-bar" title="Signal distribution">
                        <div id="signal-below" class="signal-seg below" style="width:0%"></div>
                        <div id="signal-mid" class="signal-seg mid" style="width:0%"></div>
                        <div id="signal-over" class="signal-seg over" style="width:0%"></div>
                    </div>
                    <div class="signal-labels">
                        <span id="signal-below-label">below 0%</span>
                        <span id="signal-mid-label">in 0%</span>
                        <span id="signal-over-label">over 0%</span>
                    </div>
                </div>
            </div>
            <div id="shift-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript(payload)}</script>
    <script>
    (function () {
        const data = JSON.parse(document.getElementById('payload').textContent);

        ${EMBEDDED_SHARED_FUNCS}

        const SYNC_KEY = 'volatility-det-v1';
        const Y_AXIS_SIZE = ${Y_AXIS_SIZE};
        const MARKET_ADAPTER = data.marketAdapter || {};
        const MIN_WEIGHT = data.minWeight ?? ${JSON.stringify(defaultMinWeight)};
        const MAX_WEIGHT = data.maxWeight ?? ${JSON.stringify(defaultMaxWeight)};
        const BASELINE_WEIGHT = 0.5;
        const EXP_LOG_MIN = Math.log(0.5);
        const EXP_LOG_MAX = Math.log(1.0);
        const SCALE_LOG_MIN = Math.log(1.0);
        const SCALE_LOG_MAX = Math.log(100.0);
        const candleRows = Array.isArray(data.candles) ? data.candles : [];
        const baseVarianceSeries = Array.isArray(data.varianceSeries) ? data.varianceSeries : [];

        let currentAtrPeriod = Math.max(${MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MIN}, Math.min(${MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MAX}, Math.round(data.atrPeriod ?? ${JSON.stringify(defaultAtrPeriod)})));
        let currentThreshold = data.volatilityThreshold;
        let currentExponent = data.volatilityExponent;
        let currentScaleX = data.volatilityScaleX;
        let currentClamp = Math.max(0.1, data.volatilityClamp ?? ${JSON.stringify(defaultClamp)});

        const xMin = data.dates[0];
        const xMax = data.dates[data.dates.length - 1];
        let pendingRange = null;
        let pendingRangeRaf = 0;
        let priceChart, varianceChart, shiftChart;
        let charts;

        ${UPLOT_SHARED_SCRIPT}

        function fmtNum(v, digits = 4) {
            if (v == null || !Number.isFinite(v)) return '-';
            const abs = Math.abs(v);
            if (abs >= 1000) return v.toFixed(2);
            if (abs >= 1) return v.toFixed(Math.min(4, digits));
            return v.toPrecision(Math.min(6, digits + 2));
        }

        function fmtSigned(v, digits = 3) {
            if (v == null || !Number.isFinite(v)) return '-';
            const s = v >= 0 ? '+' : '';
            return s + v.toFixed(digits);
        }

        function expSliderToVal(pos) {
            return Math.exp(EXP_LOG_MIN + (pos / 1000) * (EXP_LOG_MAX - EXP_LOG_MIN));
        }

        function expValToSlider(val) {
            const clamped = Math.max(Math.exp(EXP_LOG_MIN), Math.min(Math.exp(EXP_LOG_MAX), val));
            return Math.round((Math.log(clamped) - EXP_LOG_MIN) / (EXP_LOG_MAX - EXP_LOG_MIN) * 1000);
        }

        function scaleSliderToVal(pos) {
            return Math.exp(SCALE_LOG_MIN + (pos / 1000) * (SCALE_LOG_MAX - SCALE_LOG_MIN));
        }

        function scaleValToSlider(val) {
            const clamped = Math.max(Math.exp(SCALE_LOG_MIN), Math.min(Math.exp(SCALE_LOG_MAX), val));
            return Math.round((Math.log(clamped) - SCALE_LOG_MIN) / (SCALE_LOG_MAX - SCALE_LOG_MIN) * 1000);
        }

        function clampValToSlider(val) {
            const clamped = Math.max(0.1, Math.min(1.0, val));
            return Math.round(clamped * 1000);
        }

        function clampSliderToVal(pos) {
            return Math.max(0.1, Math.min(1.0, pos / 1000));
        }

        /* Sync with market_adapter/core/strategies/atr/calculator.ts computeATRSeries() — injected above */
        function rebuildVarianceSeries() {
            if (!candleRows.length) return baseVarianceSeries.slice();

            const atrSeries = computeATRSeries(candleRows, currentAtrPeriod);
            const next = new Array(data.dates.length).fill(null);
            for (let i = 0; i < data.realBarCount; i++) {
                const amaPrice = data.ama3Prices[i];
                const atr = atrSeries[i] ?? 0;
                next[i] = amaPrice > 0 ? atr / amaPrice : 0;
            }
            return next;
        }

        function toPlotLog(values) {
            return values.map((v) => (v != null && v > 0 ? v : null));
        }

        let varianceSeries = rebuildVarianceSeries();
        const variancePlot = toPlotLog(varianceSeries);

        let rawDeltaArr = new Array(data.dates.length).fill(null);
        let deltaArr = new Array(data.dates.length).fill(null);
        let weffArr = new Array(data.dates.length).fill(null);
        let signalSummary = { below: 0, mid: 0, over: 0, total: 0 };

        function calcShift(weightVariance) {
            const r = computeVolatilityShift(weightVariance, {
                exponent: currentExponent,
                scaleX: currentScaleX,
                threshold: currentThreshold,
                clampValue: currentClamp,
                minWeight: MIN_WEIGHT,
                maxWeight: MAX_WEIGHT,
                baselineWeight: BASELINE_WEIGHT,
            });
            return { raw: r.rawSymmetricDelta, rawAbs: Math.abs(r.rawSymmetricDelta), delta: r.symmetricDelta, weff: r.effectiveWeight, sellW: r.sellW, buyW: r.buyW };
        }

        function recalcShift() {
            varianceSeries = rebuildVarianceSeries();
            const effectiveClamp = Number.isFinite(currentClamp) && currentClamp >= 0.1 ? currentClamp : ${JSON.stringify(defaultClamp)};
            let below = 0;
            let mid = 0;
            let over = 0;
            let total = 0;
            for (let i = 0; i < data.dates.length; i++) {
                if (i >= data.realBarCount) {
                    rawDeltaArr[i] = null;
                    deltaArr[i] = null;
                    weffArr[i] = null;
                    continue;
                }
                const r = calcShift(varianceSeries[i]);
                rawDeltaArr[i] = r.raw;
                deltaArr[i] = r.delta;
                weffArr[i] = r.weff;
                if (Number.isFinite(r.rawAbs)) {
                    total++;
                    if (r.rawAbs >= effectiveClamp) over++;
                    else if (r.rawAbs < currentThreshold) below++;
                    else mid++;
                }
            }
            signalSummary = { below, mid, over, total };
        }

        function updateSignalSummary() {
            const total = signalSummary.total || 0;
            const belowPct = total > 0 ? (signalSummary.below / total) * 100 : 0;
            const midPct = total > 0 ? (signalSummary.mid / total) * 100 : 0;
            const overPct = total > 0 ? (signalSummary.over / total) * 100 : 0;

            const belowEl = document.getElementById('signal-below');
            const midEl = document.getElementById('signal-mid');
            const overEl = document.getElementById('signal-over');
            belowEl.style.width = belowPct + '%';
            midEl.style.width = midPct + '%';
            overEl.style.width = overPct + '%';
            belowEl.title = 'below: ' + signalSummary.below + '/' + total + ' (' + belowPct.toFixed(1) + '%)';
            midEl.title = 'in: ' + signalSummary.mid + '/' + total + ' (' + midPct.toFixed(1) + '%)';
            overEl.title = 'over: ' + signalSummary.over + '/' + total + ' (' + overPct.toFixed(1) + '%)';

            const title = 'below: ' + signalSummary.below + '/' + total + ' (' + belowPct.toFixed(1) + '%) | in: ' + signalSummary.mid + '/' + total + ' (' + midPct.toFixed(1) + '%) | over: ' + signalSummary.over + '/' + total + ' (' + overPct.toFixed(1) + '%)';
            document.getElementById('signal-bar').title = title;
            document.getElementById('signal-below-label').textContent = 'below ' + belowPct.toFixed(1) + '%';
            document.getElementById('signal-mid-label').textContent = 'in ' + midPct.toFixed(1) + '%';
            document.getElementById('signal-over-label').textContent = 'over ' + overPct.toFixed(1) + '%';
        }

        function rangeFrom(values, fallbackMin, fallbackMax, padFrac = 0.12) {
            let min = Infinity;
            let max = -Infinity;
            for (let i = 0; i < values.length; i++) {
                const v = values[i];
                if (v == null || !Number.isFinite(v)) continue;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            if (!Number.isFinite(min) || !Number.isFinite(max)) return [fallbackMin, fallbackMax];
            if (min === max) {
                const pad = Math.max(Math.abs(min) * padFrac, 0.02);
                return [min - pad, max + pad];
            }
            const span = max - min;
            const pad = span * padFrac;
            return [min - pad, max + pad];
        }

        function buildRawDeltaSplits(u) {
            const scale = u.scales.d || {};
            const r = rangeFrom(rawDeltaArr, -0.5, 0.04);
            const min = Number.isFinite(scale.min) ? scale.min : r[0];
            const max = Number.isFinite(scale.max) ? scale.max : r[1];
            const lo = Math.min(min, max);
            const hi = Math.max(min, max);
            const step = 0.05;
            const start = Math.floor(lo / step) * step;
            const end = Math.ceil(hi / step) * step;
            const splits = [];
            for (let v = start; v <= end + 1e-9; v += step) {
                const rounded = Math.round(v * 100) / 100;
                if (!splits.includes(rounded)) splits.push(rounded);
            }
            if (!splits.includes(0)) splits.push(0);
            if (!splits.includes(-currentThreshold)) splits.push(-currentThreshold);
            return splits.sort((a, b) => a - b);
        }

        function makeDeltaHook(values, scaleKey, thresholdGetter) {
            return (u) => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath();
                ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
                ctx.clip();

                const zeroY = u.valToPos(0, scaleKey, true);
                const thresholdY = u.valToPos(-thresholdGetter(), scaleKey, true);

                ctx.strokeStyle = '#ffd24a';
                ctx.shadowColor = 'rgba(255,210,74,0.85)';
                ctx.shadowBlur = 6;
                ctx.lineWidth = 2.5;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(bbox.left, thresholdY);
                ctx.lineTo(bbox.left + bbox.width, thresholdY);
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
                ctx.font = 'bold 10px Segoe UI, sans-serif';
                ctx.textBaseline = 'middle';
                const label = 'threshold';
                const labelX = Math.max(bbox.left + 4, bbox.left + bbox.width - 60);
                const labelY = thresholdY - 8;
                const labelW = ctx.measureText(label).width + 8;
                ctx.fillStyle = 'rgba(11,14,20,0.82)';
                ctx.fillRect(labelX - 4, labelY - 7, labelW, 14);
                ctx.fillStyle = '#ffd24a';
                ctx.fillText(label, labelX, labelY);

                const clampY = u.valToPos(-currentClamp, scaleKey, true);
                ctx.strokeStyle = '#a371f7';
                ctx.shadowColor = 'rgba(163,113,247,0.85)';
                ctx.shadowBlur = 6;
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 3]);
                ctx.beginPath();
                ctx.moveTo(bbox.left, clampY);
                ctx.lineTo(bbox.left + bbox.width, clampY);
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
                ctx.font = 'bold 10px Segoe UI, sans-serif';
                ctx.textBaseline = 'middle';
                const clampLabel = 'clamp';
                const clampLabelX = Math.max(bbox.left + 4, bbox.left + bbox.width - 52);
                const clampLabelY = clampY - 8;
                const clampLabelW = ctx.measureText(clampLabel).width + 8;
                ctx.fillStyle = 'rgba(11,14,20,0.82)';
                ctx.fillRect(clampLabelX - 4, clampLabelY - 7, clampLabelW, 14);
                ctx.fillStyle = '#a371f7';
                ctx.fillText(clampLabel, clampLabelX, clampLabelY);

                ctx.strokeStyle = 'rgba(139,148,158,0.4)';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(bbox.left, zeroY);
                ctx.lineTo(bbox.left + bbox.width, zeroY);
                ctx.stroke();
                ctx.setLineDash([]);

                const path = new Path2D();
                let started = false;
                let lastX = 0;
                for (let i = 0; i < values.length; i++) {
                    const v = values[i];
                    if (v == null) { if (started) { path.lineTo(lastX, zeroY); started = false; } continue; }
                    const x = u.valToPos(data.dates[i], 'x', true);
                    const y = u.valToPos(v, scaleKey, true);
                    if (!started) {
                        path.moveTo(x, zeroY);
                        path.lineTo(x, y);
                        started = true;
                    } else {
                        path.lineTo(x, y);
                    }
                    lastX = x;
                }
                if (started) path.lineTo(lastX, zeroY);

                ctx.save();
                ctx.beginPath();
                ctx.rect(bbox.left, zeroY, bbox.width, bbox.top + bbox.height - zeroY);
                ctx.clip();
                ctx.fillStyle = 'rgba(248,81,73,0.16)';
                ctx.fill(path);
                ctx.restore();

                ctx.strokeStyle = 'rgba(248,81,73,0.9)';
                ctx.lineWidth = 1.7;
                ctx.stroke(path);
                ctx.restore();
            };
        }

        const cursorCfg = ${makeCursorConfig()};

        function updateLegend(idx) {
            if (idx == null || idx >= data.realBarCount) return;
            document.getElementById('l-price').textContent = fmtNum(data.prices[idx], 6);
            document.getElementById('l-ama3').textContent = fmtNum(data.ama3Prices[idx], 6);
            const variance = varianceSeries[idx];
            document.getElementById('l-var').textContent = variance == null ? '-' : fmtNum(variance, 6) + ' (' + fmtNum(variance * 100, 4) + '%)';
            document.getElementById('l-delta').textContent = fmtSigned(deltaArr[idx], 3);
            document.getElementById('l-weff').textContent = fmtNum(weffArr[idx], 3);
        }

        function init() {
            currentAtrPeriod = Math.max(${MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MIN}, Math.min(${MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_MAX}, Math.round(currentAtrPeriod)));
            currentExponent = Math.max(Math.exp(EXP_LOG_MIN), Math.min(Math.exp(EXP_LOG_MAX), currentExponent));
            currentScaleX = Math.max(Math.exp(SCALE_LOG_MIN), Math.min(Math.exp(SCALE_LOG_MAX), currentScaleX));
            currentClamp = Math.max(0.1, Math.min(1.0, currentClamp));
            document.getElementById('atr-slider').value = currentAtrPeriod;
            document.getElementById('atr-value').textContent = String(currentAtrPeriod);
            document.getElementById('threshold-slider').value = Math.round(currentThreshold * 1000);
            document.getElementById('exponent-slider').value = expValToSlider(currentExponent);
            document.getElementById('scale-slider').value = scaleValToSlider(currentScaleX);
            document.getElementById('clamp-slider').value = clampValToSlider(currentClamp);
            document.getElementById('exponent-value').textContent = currentExponent.toFixed(3);
            document.getElementById('scale-value').textContent = currentScaleX.toFixed(2) + 'x';
            document.getElementById('clamp-value').textContent = currentClamp.toFixed(3);

            const priceEl = document.getElementById('price-panel');
            const varianceEl = document.getElementById('variance-panel');
            const shiftEl = document.getElementById('shift-panel');

            recalcShift();
            updateSignalSummary();

            priceChart = new uPlot({
                width: priceEl.offsetWidth,
                height: priceEl.offsetHeight,
                padding: [4, 8, 2, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    y: { auto: true, distr: 3, log: 10, range: (u, min, max) => [min * 0.95, max * 1.05] },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Price', stroke: '#58a6ff', width: 1.5, scale: 'y', points: { show: false } },
                    { label: 'AMA3', stroke: '#e3b341', width: 1.5, scale: 'y', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' },
                    { scale: 'y', stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? fmtNum(x, 6) : '') },
                ],
                cursor: cursorCfg,
            }, [data.dates, data.prices, data.ama3Prices], document.getElementById('price-chart'));

            varianceChart = new uPlot({
                width: varianceEl.offsetWidth,
                height: varianceEl.offsetHeight,
                padding: [14, 8, 2, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    v: { auto: true, range: (u, min, max) => [min * 0.95, max * 1.05] },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Weight variance', stroke: '#d2a8ff', width: 1.5, scale: 'v', points: { show: false } },
                ],
                axes: [
                    { show: false, stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' },
                    { scale: 'v', stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? fmtNum(x, 6) : '') },
                ],
                cursor: cursorCfg,
            }, [data.dates, variancePlot], document.getElementById('variance-chart'));

            shiftChart = new uPlot({
                width: shiftEl.offsetWidth,
                height: shiftEl.offsetHeight,
                padding: [26, 8, 4, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    d: { auto: true, range: () => rangeFrom(rawDeltaArr, -0.5, 0.04) },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Raw Δ', stroke: '#8b949e', width: 1.2, dash: [5, 4], scale: 'd', points: { show: false } },
                    { label: 'Δ', stroke: '#f85149', width: 1.7, scale: 'd', points: { show: false } },
                ],
                axes: [
                    { show: true, stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' },
                    { scale: 'd', stroke: '#ffffff', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif',
                      values: (u, v) => v.map(x => x != null ? fmtSigned(x, 3) : ''),
                      splits: buildRawDeltaSplits },
                ],
                cursor: cursorCfg,
                hooks: {
                    draw: [makeDeltaHook(deltaArr, 'd', () => currentThreshold)],
                },
            }, [data.dates, rawDeltaArr, deltaArr], document.getElementById('shift-chart'));

            ${bindHoverStateFn()}

            charts = [priceChart, varianceChart, shiftChart];
            ${wireChartEvents('charts', 'updateLegend', 'shiftChart.cursor.idx ?? data.realBarCount - 1')}

            ${refreshChartsPreservingZoomFn({
                anchor: 'shiftChart.scales.x',
                reload: [
                    'varianceChart.setData([data.dates, toPlotLog(varianceSeries)], false);',
                    'shiftChart.setData([data.dates, rawDeltaArr, deltaArr], false);',
                ],
                charts: '[varianceChart, shiftChart]',
            })}

            function applyShiftFromSliders() {
                recalcShift();
                updateSignalSummary();
                refreshChartsPreservingZoom();
                updateLegend(shiftChart.cursor.idx ?? data.realBarCount - 1);
            }

            document.getElementById('atr-slider').addEventListener('input', (e) => {
                currentAtrPeriod = parseInt(e.target.value, 10);
                document.getElementById('atr-value').textContent = String(currentAtrPeriod);
                applyShiftFromSliders();
            });

            document.getElementById('threshold-slider').addEventListener('input', (e) => {
                currentThreshold = parseInt(e.target.value, 10) / 1000;
                document.getElementById('threshold-value').textContent = currentThreshold.toFixed(3);
                applyShiftFromSliders();
            });

            document.getElementById('exponent-slider').addEventListener('input', (e) => {
                currentExponent = expSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('exponent-value').textContent = currentExponent.toFixed(3);
                applyShiftFromSliders();
            });

            document.getElementById('scale-slider').addEventListener('input', (e) => {
                currentScaleX = scaleSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('scale-value').textContent = currentScaleX.toFixed(2) + 'x';
                applyShiftFromSliders();
            });

            document.getElementById('clamp-slider').addEventListener('input', (e) => {
                currentClamp = clampSliderToVal(parseInt(e.target.value, 10));
                document.getElementById('clamp-value').textContent = currentClamp.toFixed(3);
                applyShiftFromSliders();
            });
        }

        ${sizeChartsFn([['priceChart', 'price-panel'], ['varianceChart', 'variance-panel'], ['shiftChart', 'shift-panel']])}

        window.addEventListener('resize', sizeCharts);
        ${zoomResetScript()}

        init();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            sizeCharts();
            updateLegend(data.realBarCount - 1);
        }));
    })();
    </script>
</body>
</html>`;
}

export { generateHTML };
export type { VolatilityRow };

