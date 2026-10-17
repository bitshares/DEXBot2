'use strict';

import { MARKET_ADAPTER } from '../../modules/constants.js';
import { computeDynamicWeightSeries } from '../../market_adapter/core/strategies/dynamic_weight_series.js';
import { computeAbsolutePercentileThreshold } from '../../market_adapter/core/signals/kalman_velocity_smoothing.js';
import { escapeHtml, serializeJsonForScript, toEpochSeconds, UPLOT_SHARED_SCRIPT, uplotInlineTags } from '../chart_utils.js';
import { sharedChartCSS } from '../chart_css.js';
import { Y_AXIS_SIZE, makeCursorConfig, bindHoverStateFn, wireChartEvents, zoomResetScript, sizeChartsFn } from '../chart_ui.js';


interface KalmanRow {
    [key: string]: unknown;
    timestamp: string | number;
    price: number;
    kalmanPrice?: number | null;
    modalPrice?: number | null;
    signal?: string | null;
    velocity?: number | null;
    velocityFilteredPct?: number | null;
    velocityPct?: number | null;
    displacementRawPct?: number | null;
    displacementPct?: number | null;
    isReady?: boolean;
    amaWeightOffset?: number | null;
    beams?: Array<{ originX: number }>;
}

interface KalmanBeam { x: unknown; y: number; v: number; endX: unknown; endY: number; }

interface KalmanChartInput {
    allResults?: KalmanRow[];
    amaConfig?: { erPeriod?: number; fastPeriod?: number; slowPeriod?: number };
    clipPct?: number;
    [key: string]: unknown;
}

function generateHTML(data: KalmanChartInput, title = 'Kalman Trajectory Analysis') {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const interval = results.length > 1 ?
        (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000 : 3600;

    const dates          = results.map((r: KalmanRow, idx: number) => toEpochSeconds(r.timestamp || Date.now(), idx));
    const prices: (number | null)[] = results.map((r: KalmanRow) => r.price);
    const tacticalPrices = results.map((r: KalmanRow) => r.kalmanPrice);
    const modalPrices    = results.map((r: KalmanRow) => r.modalPrice);
    const signals        = results.map((r: KalmanRow) => r.signal);
    const trendUp        = results.map((r: KalmanRow) =>
        r.kalmanPrice != null && r.modalPrice != null ? r.kalmanPrice > r.modalPrice : null
    );

    // Kalman weight channel — canonical implementation shared with the live
    // market adapter (computeDynamicWeightSeries), including the percentile
    // clip threshold and the displacement-confidence/momentum-alignment
    // composite the previous hand-rolled copy omitted.
    const amaLb           = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const defaultAmaKey   = MARKET_ADAPTER.DEFAULT_AMA_KEY as keyof typeof MARKET_ADAPTER.AMAS;
    const amaErPeriod     = data.amaConfig?.erPeriod ?? MARKET_ADAPTER.AMAS[defaultAmaKey].erPeriod;
    const clipPct         = data.clipPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE;
    const velocityPct     = results.map((r: KalmanRow) => r.velocityFilteredPct ?? r.velocityPct ?? null);
    const displacementPct = results.map((r: KalmanRow) => r.displacementRawPct ?? r.displacementPct ?? null);
    const isReady         = results.map((r: KalmanRow) => !!r.isReady);
    const kalClipThreshold = clipPct > 0
        ? computeAbsolutePercentileThreshold(velocityPct, clipPct, Infinity)
        : Infinity;
    const dwSeries = computeDynamicWeightSeries({
        amaValues: prices, // AMA channel unused here; length driver only
        kalmanVelocityPct: velocityPct,
        kalmanDisplacementPct: displacementPct,
        kalmanIsReady: isReady,
        regimeMultipliers: undefined,
        lookbackBars: amaLb,
        amaErPeriod,
        amaClipThreshold: Infinity,
        kalClipThreshold,
        neutralZonePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
        amaMaxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        kalmanMaxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
        offsetClamp: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
        dispScaleMinPct: MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT,
        alpha: MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA,
        dw: MARKET_ADAPTER.DYNAMIC_WEIGHT_DW,
        gain: MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN,
        minOutputThreshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD,
        signalConfirmBars: MARKET_ADAPTER.DYNAMIC_WEIGHT_SIGNAL_CONFIRM_BARS_DEFAULT,
    });
    const kalmanWeights  = dwSeries.kalmanOffsets;
    const amaWeights     = results.map((r: KalmanRow) => r.amaWeightOffset ?? null);

    // Future Projection (150 bars)
    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 150; i++) {
        dates.push(lastDate + (i * interval));
        prices.push(null);
        tacticalPrices.push(null);
        modalPrices.push(null);
        signals.push(null);
        trendUp.push(null);
        kalmanWeights.push(null);
        amaWeights.push(null);
    }

    // Extract dense Beams
    const allBeams: KalmanBeam[] = [];
    results.forEach((r: KalmanRow, idx: number) => {
        if (idx % 15 === 0 || (r.beams && r.beams.length > 0 && r.beams[r.beams.length-1].originX === idx)) {
            allBeams.push({
                x: dates[idx],
                y: (r.kalmanPrice ?? 0) as number,
                v: (r.velocity ?? 0) as number,
                endX: dates[idx] + (150 * interval),
                endY: ((r.kalmanPrice ?? 0) as number) + ((r.velocity ?? 0) as number) * 150
            });
        }
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    ${uplotInlineTags()}
    <style>
        ${sharedChartCSS()}
        #price-panel  { flex: 0 0 55%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #kalman-panel { flex: 0 0 23%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #ama-panel    { flex: 1 1 0;   min-height: 0; position: relative; }
    </style>
</head>
<body>
    <div id="header">
        <div style="font-weight:bold;color:#fff;">${escapeHtml(title)}</div>
        <div style="font-size:11px;color:#8b949e;text-transform:uppercase;">Log-Kinetic Trajectory Overlay &nbsp;·&nbsp; Scroll to zoom &nbsp;·&nbsp; Drag to pan &nbsp;·&nbsp; Ctrl+0 reset</div>
    </div>

    <div id="panels">
        <div id="price-panel">
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#58a6ff;"></div>Price: <span id="l-price">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#ff7b72;"></div>Tactical: <span id="l-tactical">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>Modal: <span id="l-modal">-</span></div>
                <div class="legend-item" style="margin-left:8px;">Trend: <span id="l-trend" style="font-weight:bold;">-</span></div>
            </div>
            <div id="main-chart"></div>
        </div>
        <div id="kalman-panel">
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:linear-gradient(to bottom,#2ea043,#f85149);"></div>Kalman Weight: <span id="l-kalman-w" style="font-weight:bold;">-</span></div>
                <span style="color:#8b949e;font-size:10px;">sell bias ↑ &nbsp;/&nbsp; buy bias ↓ &nbsp;·&nbsp; neutral=0</span>
            </div>
            <div id="kalman-chart"></div>
        </div>
        <div id="ama-panel">
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:linear-gradient(to bottom,#f0a000,#4a90d9);"></div>AMA Weight: <span id="l-ama-w" style="font-weight:bold;">-</span></div>
                <span style="color:#8b949e;font-size:10px;">lookback ${amaLb} bars &nbsp;·&nbsp; er${escapeHtml(String(data.amaConfig?.erPeriod ?? amaErPeriod))}/${escapeHtml(String(data.amaConfig?.fastPeriod ?? MARKET_ADAPTER.AMAS[defaultAmaKey].fastPeriod))}/${escapeHtml(String(data.amaConfig?.slowPeriod ?? MARKET_ADAPTER.AMAS[defaultAmaKey].slowPeriod))}</span>
            </div>
            <div id="ama-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript({ dates, prices, tacticalPrices, modalPrices, signals, allBeams, trendUp, kalmanWeights, amaWeights })}</script>

    <script>
        const data = JSON.parse(document.getElementById('payload').textContent);
        const SYNC_KEY = "kalman";

        // ── Zoom / Pan ────────────────────────────────────────────────────────
        const xMin = data.dates[0];
        const xMax = data.dates[data.dates.length - 1];
        let pendingRange = null;
        let pendingRangeRaf = 0;
        let priceChart, kalmanChart, amaChart;
        let charts;

        ${UPLOT_SHARED_SCRIPT}

        // ── Legend ────────────────────────────────────────────────────────────
        let lastLiveIdx = data.prices.length - 151; // last real bar (before future nulls)

        function updateLegend(idx) {
            if (idx == null) return;
            lastLiveIdx = idx;

            document.getElementById('l-price').textContent    = data.prices[idx]?.toFixed(4)        ?? "-";
            document.getElementById('l-tactical').textContent = data.tacticalPrices[idx]?.toFixed(4) ?? "-";
            document.getElementById('l-modal').textContent    = data.modalPrices[idx]?.toFixed(4)    ?? "-";

            const trend = data.trendUp[idx];
            const tEl = document.getElementById('l-trend');
            if (trend === null || trend === undefined) { tEl.textContent = '-'; tEl.style.color = '#8b949e'; }
            else if (trend) { tEl.textContent = 'UP';   tEl.style.color = '#2ea043'; }
            else             { tEl.textContent = 'DOWN'; tEl.style.color = '#f85149'; }

            function setW(elId, v, posColor, negColor) {
                const el = document.getElementById(elId);
                if (v === null || v === undefined) { el.textContent = '-'; el.style.color = '#8b949e'; return; }
                el.textContent = (v >= 0 ? '+' : '') + v.toFixed(3);
                el.style.color = v > 0.01 ? posColor : v < -0.01 ? negColor : '#8b949e';
            }
            setW('l-kalman-w', data.kalmanWeights[idx], '#2ea043', '#f85149');
            setW('l-ama-w',    data.amaWeights[idx],    '#f0a000', '#4a90d9');
        }

        // ── Draw hooks ────────────────────────────────────────────────────────
        function makeTrendBgHook() {
            return u => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
                ctx.globalCompositeOperation = 'destination-over';
                let i = 0;
                while (i < data.trendUp.length) {
                    if (data.trendUp[i] === null) { i++; continue; }
                    const trend = data.trendUp[i];
                    let j = i + 1;
                    while (j < data.trendUp.length && data.trendUp[j] === trend) j++;
                    const x0 = u.valToPos(data.dates[i], 'x', true);
                    const x1 = j < data.trendUp.length ? u.valToPos(data.dates[j], 'x', true) : bbox.left + bbox.width;
                    ctx.fillStyle = trend ? 'rgba(46,160,67,0.08)' : 'rgba(248,81,73,0.08)';
                    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
                    i = j;
                }
                ctx.restore();
            };
        }

        function makeBeamHook() {
            return u => {
                const { ctx } = u;
                ctx.save();
                data.allBeams.forEach(b => {
                    const x0 = u.valToPos(b.x,    'x', true);
                    const y0 = u.valToPos(b.y,    'y', true);
                    const x1 = u.valToPos(b.endX, 'x', true);
                    const y1 = u.valToPos(b.endY, 'y', true);
                    if (x0 < u.bbox.left || x0 > u.bbox.left + u.bbox.width) return;
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = b.v > 0 ? "rgba(46,160,67,0.15)" : "rgba(248,81,73,0.15)";
                    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
                });
                data.signals.forEach((s, i) => {
                    if (!s || s === 'NEUTRAL' || s === 'EQUILIBRIUM') return;
                    const x = u.valToPos(data.dates[i], 'x', true);
                    if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
                    const price = data.prices[i];
                    if (price == null) return;
                    const yPos = u.valToPos(price, 'y', true);
                    ctx.fillStyle = s.includes('BULL') ? "#2ea043" : "#f85149";
                    ctx.beginPath(); ctx.arc(x, s.includes('BULL') ? yPos - 15 : yPos + 15, 3.5, 0, Math.PI * 2); ctx.fill();
                });
                ctx.restore();
            };
        }

        function makeWeightFillHook(values, scaleKey, posColor, negColor) {
            return u => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();

                const zeroY = u.valToPos(0, scaleKey, true);
                const path = new Path2D();
                let inSeg = false, lastX = 0;

                for (let i = 0; i < values.length; i++) {
                    const v = values[i];
                    if (v === null) { if (inSeg) { path.lineTo(lastX, zeroY); inSeg = false; } continue; }
                    const x = u.valToPos(data.dates[i], 'x', true);
                    const y = u.valToPos(v, scaleKey, true);
                    if (!inSeg) { path.moveTo(x, zeroY); path.lineTo(x, y); inSeg = true; }
                    else path.lineTo(x, y);
                    lastX = x;
                }
                if (inSeg) path.lineTo(lastX, zeroY);

                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, zeroY - bbox.top); ctx.clip();
                ctx.fillStyle = posColor; ctx.fill(path);
                ctx.restore();

                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, zeroY, bbox.width, bbox.top + bbox.height - zeroY); ctx.clip();
                ctx.fillStyle = negColor; ctx.fill(path);
                ctx.restore();

                ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.stroke(path);

                ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(bbox.left, zeroY); ctx.lineTo(bbox.left + bbox.width, zeroY); ctx.stroke();

                ctx.restore();
            };
        }

        // ── Shared cursor config ──────────────────────────────────────────────
        const cursorCfg = ${makeCursorConfig()};

        // ── Shared weight chart opts ──────────────────────────────────────────
        function makeWeightOpts(el, scaleKey, values, posColor, negColor, showXAxis) {
            return {
                width: el.offsetWidth,
                height: el.offsetHeight,
                padding: [4, 8, 0, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    [scaleKey]: { range: () => [-0.55, 0.55] }
                },
                series: [
                    { label: 'Time' },
                    { label: 'Weight', stroke: 'transparent', scale: scaleKey, points: { show: false } }
                ],
                axes: [
                    {
                        show: showXAxis,
                        stroke: '#ffffff',
                        grid: { stroke: '#1c2128' },
                        ticks: { stroke: '#30363d', width: 1 },
                        size: 34,
                        font: '11px Segoe UI, sans-serif',
                    },
                    {
                        scale: scaleKey,
                        stroke: '#ffffff',
                        grid: { stroke: '#1c2128', dash: [4, 4] },
                        ticks: { stroke: '#30363d', width: 1 },
                        size: ${Y_AXIS_SIZE},
                        font: '11px Segoe UI, sans-serif',
                        values: (u, v) => v.map(x => x != null ? (x >= 0 ? '+' : '') + x.toFixed(2) : ''),
                        splits: () => [-0.5, -0.25, 0, 0.25, 0.5],
                    }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makeWeightFillHook(values, scaleKey, posColor, negColor)] }
            };
        }

        // ── Chart init ────────────────────────────────────────────────────────
        function init() {
            const priceEl  = document.getElementById('price-panel');
            const kalmanEl = document.getElementById('kalman-panel');
            const amaEl    = document.getElementById('ama-panel');

            priceChart = new uPlot({
                width: priceEl.offsetWidth,
                height: priceEl.offsetHeight,
                padding: [4, 8, 0, 4],
                select: { show: false },
                legend: { show: false },
                scales: {
                    x: { time: true },
                    y: { auto: true, distr: 3, log: 10, range: (u, min, max) => [min * 0.9, max * 1.1] }
                },
                series: [
                    { label: 'Time' },
                    { label: 'Price',    stroke: '#58a6ff', width: 1.5, scale: 'y', points: { show: false } },
                    { label: 'Tactical', stroke: '#ff7b72', width: 2.5, scale: 'y', points: { show: false } },
                    { label: 'Modal',    stroke: '#d2a8ff', width: 2, dash: [8,4], scale: 'y', points: { show: false } }
                ],
                axes: [
                    {
                        show: false,
                        stroke: '#ffffff',
                        grid: { stroke: '#1c2128' },
                        ticks: { stroke: '#30363d', width: 1 },
                        size: 34,
                        font: '11px Segoe UI, sans-serif',
                    },
                    {
                        scale: 'y',
                        stroke: '#ffffff',
                        grid: { stroke: '#1c2128' },
                        ticks: { stroke: '#30363d', width: 1 },
                        size: ${Y_AXIS_SIZE},
                        font: '11px Segoe UI, sans-serif',
                        splits: logAxisSplits,
                        values: (u, v) => v.map(x => x != null ? x.toFixed(4) : ''),
                    }
                ],
                cursor: cursorCfg,
                hooks: { draw: [makeTrendBgHook(), makeBeamHook()] }
            }, [data.dates, data.prices, data.tacticalPrices, data.modalPrices], document.getElementById('main-chart'));

            kalmanChart = new uPlot(
                makeWeightOpts(kalmanEl, 'kw', data.kalmanWeights,
                    'rgba(46,160,67,0.30)', 'rgba(248,81,73,0.30)', false),
                [data.dates, data.kalmanWeights],
                document.getElementById('kalman-chart')
            );

            amaChart = new uPlot(
                makeWeightOpts(amaEl, 'aw', data.amaWeights,
                    'rgba(240,160,0,0.30)', 'rgba(74,144,217,0.30)', true),
                [data.dates, data.amaWeights],
                document.getElementById('ama-chart')
            );

            charts = [priceChart, kalmanChart, amaChart];

            ${bindHoverStateFn()}
            ${wireChartEvents('charts', 'updateLegend', 'lastLiveIdx')}
        }

        ${sizeChartsFn([['priceChart', 'price-panel'], ['kalmanChart', 'kalman-panel'], ['amaChart', 'ama-panel']])}

        window.addEventListener('resize', sizeCharts);
        ${zoomResetScript()}

        init();

        // After layout settles: size charts correctly and seed legend with last real bar
        requestAnimationFrame(() => {
            sizeCharts();
            updateLegend(lastLiveIdx);
        });
    </script>
</body>
</html>`;
}

export { generateHTML };
export type { KalmanRow };

