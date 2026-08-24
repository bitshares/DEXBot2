
import fs from 'node:fs';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { escapeHtml, serializeJsonForScript } from '../chart_utils.js';
import { normalizeCandle } from '../math_utils.js';
import { PATHS } from '../../modules/paths.js';
import { getStorage } from '../../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../../modules/utils/errors.js';
'use strict';


function inferBaseIntervalSeconds(candles: any[], fallback: any = 3600) {
    if (!Array.isArray(candles) || candles.length < 2) return fallback;
    const deltas: number[] = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = Number(candles[i - 1]?.time);
        const curr = Number(candles[i]?.time);
        if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
        const d = curr - prev;
        if (d > 0) deltas.push(d);
    }
    if (deltas.length === 0) return fallback;
    deltas.sort((a: any, b: any) => a - b);
    const mid = Math.floor(deltas.length / 2);
    const med = deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
    return Math.max(60, Math.round(med));
}

function loadMarketProfiles(filePath: any = PATHS.PROFILES.MARKET_PROFILES_JSON) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return readJSON(filePath);
    } catch (err: any) {
        console.warn(`[WARN] Failed to parse ${filePath}: ${getErrorMessage(err)}. Falling back to built-in AMA defaults.`);
        return null;
    }
}

function findMarketProfile(profiles: any, meta: any = {}) {
    const entries = Array.isArray(profiles?.profiles) ? profiles.profiles : [];
    if (!entries.length) return null;
    const assetA = meta.assetA?.symbol || meta.assetA?.id || meta.assetA;
    const assetB = meta.assetB?.symbol || meta.assetB?.id || meta.assetB;
    const intervalSeconds = Number(meta.intervalSeconds);
    return entries.find((entry: any) => {
        if (!entry || typeof entry !== 'object') return false;
        if (assetA && assetB) {
            const matchesPair = (String(entry.assetA) === String(assetA) || String(entry.assetAId) === String(assetA))
                && (String(entry.assetB) === String(assetB) || String(entry.assetBId) === String(assetB));
            if (!matchesPair) return false;
        } else {
            return false;
        }
        if (Number.isFinite(intervalSeconds) && intervalSeconds > 0 && Number(entry.intervalSeconds) !== intervalSeconds) {
            return false;
        }
        return true;
    }) || null;
}

function resolveAmaDefaults({ meta, data, marketProfiles }: any = {}) {
    const amaDefaultsSource = MARKET_ADAPTER.AMAS.AMA3;
    const profile = findMarketProfile(marketProfiles, meta);
    const profileAmaKey = profile?.defaultAma && profile.amas && profile.amas[profile.defaultAma]
        ? profile.defaultAma
        : null;
    const profileAma = profileAmaKey ? profile.amas[profileAmaKey] : null;
    const source = data?.amaDefaults || profileAma || amaDefaultsSource;
    return {
        erPeriod: Math.max(1, Math.round(Number(data?.amaErPeriod ?? source.erPeriod))),
        fastPeriod: Number.isFinite(Number(data?.amaFastPeriod))
            ? Number(data.amaFastPeriod)
            : Number(source.fastPeriod),
        slowPeriod: Number.isFinite(Number(data?.amaSlowPeriod))
            ? Number(data.amaSlowPeriod)
            : Number(source.slowPeriod),
    };
}

function generateHTML(data: any, title: any = 'TradingView Style Research') {
    const rawCandles = Array.isArray(data.candles) ? data.candles : [];
    const candles = rawCandles.map(normalizeCandle).filter(Boolean);
    if (candles.length === 0) throw new Error('No candle data in input');

    const meta = data.meta || {};
    const baseIntervalSeconds = Number(meta.intervalSeconds) > 0
        ? Number(meta.intervalSeconds)
        : inferBaseIntervalSeconds(candles, 3600);

    const timeframes = [
        { label: '1h', seconds: 3600 },
        { label: '4h', seconds: 14400 },
        { label: '1d', seconds: 86400 },
        { label: '1w', seconds: 604800 },
    ].map((item: any) => ({ ...item, enabled: item.seconds >= baseIntervalSeconds }));

    const defaultTimeframe = timeframes.find((item: any) => item.label === data.defaultTimeframe && item.enabled)
        || timeframes.find((item: any) => item.enabled)
        || timeframes[0];

    const marketProfiles = data.marketProfiles || loadMarketProfiles();
    const defaultAmaConfig = resolveAmaDefaults({ meta, data, marketProfiles });
    const defaults = {
        smaPeriod: Math.max(1, Math.round(data.smaPeriod ?? 500)),
        amaDefaults: defaultAmaConfig,
        smaEnabled: data.smaEnabled === true,
        amaEnabled: data.amaEnabled === true,
        vwapEnabled: data.vwapEnabled === true,
        vwapBars: Math.max(5, Math.round(data.vwapBars ?? 500)),
        priceScale: data.priceScale === 'linear' ? 'linear' : 'log',
    };

    const assetLabelA = meta.assetA?.symbol || meta.assetA?.id || 'Asset A';
    const assetLabelB = meta.assetB?.symbol || meta.assetB?.id || 'Asset B';
    const pairLabelNormal = `${assetLabelA}/${assetLabelB}`;
    const pairLabelInverse = `${assetLabelB}/${assetLabelA}`;
    const poolLabel = meta.pool ? `Pool ${String(meta.pool).replace(/^1\.19\./, '')}` : 'Pair';
    const intervalLabel = baseIntervalSeconds >= 86400
        ? `${Math.round(baseIntervalSeconds / 86400)}d`
        : `${Math.round(baseIntervalSeconds / 3600)}h`;
    const defaultPairMode = data.defaultPairMode === 'inverse' ? 'inverse' : 'normal';

    const payload = {
        candles,
        timeframes,
        defaultTimeframe: defaultTimeframe.label,
        smaPeriod: defaults.smaPeriod,
        amaDefaults: defaultAmaConfig,
        smaEnabled: defaults.smaEnabled,
        amaEnabled: defaults.amaEnabled,
        vwapEnabled: defaults.vwapEnabled,
        vwapBars: defaults.vwapBars,
        priceScale: defaults.priceScale,
        defaultPairMode,
        assetLabelA,
        assetLabelB,
        pairLabelNormal,
        pairLabelInverse,
        poolLabel,
        intervalLabel,
        amaDefaultsSource: marketProfiles ? 'market_profiles' : 'constants',
    };

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="dark">
    <meta name="darkreader-lock">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="../uplot/uPlot.min.css">
    <script src="../uplot/uPlot.iife.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        :root { color-scheme: dark; }
        body {
            margin: 0;
            overflow: hidden;
            background: linear-gradient(180deg, #090d12 0%, #0b0f14 40%, #0a0c11 100%);
            color: #d7e0ea;
            font-family: Inter, "Segoe UI", system-ui, sans-serif;
        }
        #app { height: 100vh; display: flex; flex-direction: column; }
        #topbar {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 12px 16px 10px;
            border-bottom: 1px solid #263241;
            background: rgba(15,19,26,0.94);
            backdrop-filter: blur(10px);
        }
        #brand { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
        #title { font-size: 15px; font-weight: 700; color: #f5f8fb; }
        #subtitle { font-size: 11px; color: #b9c6d4; text-transform: uppercase; letter-spacing: 0.6px; }
        #toolbar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 12px; align-items: center; }
        .group { display: inline-flex; align-items: center; gap: 8px; padding-left: 12px; border-left: 1px solid #263241; }
        .group:first-child { padding-left: 0; border-left: 0; }
        :root {
            --control-height: 36px;
        }
        .time-btn {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(24,30,39,0.85);
            color: #8290a2;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            padding: 7px 10px;
            border-radius: 8px;
            cursor: pointer;
        }
        .time-btn.active {
            color: #fff;
            border-color: rgba(94,161,255,0.85);
            background: linear-gradient(180deg, rgba(35,53,79,0.95), rgba(22,32,47,0.98));
        }
        .time-btn:disabled { opacity: 0.35; cursor: not-allowed; text-decoration: line-through; }
        .indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            min-height: var(--control-height);
            padding: 0 13px;
            border: 1px solid #263241;
            border-radius: 10px;
            background: rgba(20,25,33,0.86);
        }
        .indicator label {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            min-height: var(--control-height);
            font-size: 11px;
            font-weight: 700;
            color: #d7e0ea;
            text-transform: uppercase;
            white-space: nowrap;
        }
        .indicator input[type="checkbox"] { width: 14px; height: 14px; accent-color: #5ea1ff; }
        .indicator input[type="number"], .indicator select {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(10,14,19,0.92);
            color: #d7e0ea;
            border-radius: 8px;
            padding: 7px 10px;
            font-size: 11px;
            outline: none;
            width: 79px;
            min-width: 79px;
            height: calc(var(--control-height) - 8px);
        }
        .pair-toggle {
            appearance: none;
            width: 32px;
            height: 32px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid #263241;
            border-radius: 999px;
            background: radial-gradient(circle at 30% 30%, rgba(94,161,255,0.18), rgba(10,14,19,0.96));
            color: #d7e0ea;
            cursor: pointer;
            padding: 0;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
            transition: transform 120ms ease, border-color 120ms ease, background 120ms ease, color 120ms ease;
        }
        .pair-toggle:hover {
            transform: translateY(-1px);
            border-color: rgba(94,161,255,0.85);
            color: #fff;
        }
        .pair-toggle:active {
            transform: translateY(0);
        }
        .pair-toggle svg {
            width: 17px;
            height: 17px;
            fill: currentColor;
            display: block;
        }
        .pair-toggle.is-inverse {
            color: #5ea1ff;
            border-color: rgba(94,161,255,0.45);
        }
        .indicator .step-stack {
            display: inline-flex;
            flex-direction: column;
            vertical-align: middle;
            margin-left: 2px;
        }
        .indicator .step-btn {
            appearance: none;
            display: block;
            width: 24px;
            height: 13px;
            border: 1px solid #3d4a5a;
            background: #1a2332;
            color: #8b949e;
            font-size: 9px;
            line-height: 1;
            cursor: pointer;
            padding: 0;
            margin: 0;
        }
        .indicator .step-btn:first-child {
            border-radius: 3px 3px 0 0;
            border-bottom: none;
        }
        .indicator .step-btn:last-child {
            border-radius: 0 0 3px 3px;
        }
        .indicator .step-btn:hover {
            background: #263241;
        }
        .indicator .step-btn:active {
            background: #3d4a5a;
        }
        .indicator input[type="text"] {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(6,8,12,0.95);
            color: #d7e0ea;
            border-radius: 8px;
            padding: 7px 4px;
            font-size: 12px;
            outline: none;
            width: 44px;
            text-align: center;
        }
        .indicator input[type="text"]:focus {
            border-color: #5ea1ff;
        }
        #ama-fast {
            width: 38px;
        }
        .scale-toggle {
            appearance: none;
            min-width: 76px;
            height: 32px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid #263241;
            border-radius: 999px;
            background: rgba(10,14,19,0.92);
            color: #d7e0ea;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.45px;
            text-transform: uppercase;
            cursor: pointer;
            padding: 0 11px;
            transition: transform 120ms ease, border-color 120ms ease, background 120ms ease, color 120ms ease;
        }
        .scale-toggle:hover {
            transform: translateY(-1px);
            border-color: rgba(94,161,255,0.85);
            color: #fff;
        }
        .scale-toggle:active {
            transform: translateY(0);
        }
        .scale-toggle.is-linear {
            color: #5ea1ff;
            border-color: rgba(94,161,255,0.45);
        }
        .reset-btn {
            appearance: none;
            border: 1px solid #263241;
            background: rgba(24,30,39,0.85);
            color: #d7e0ea;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.45px;
            text-transform: uppercase;
            padding: 6px 11px;
            border-radius: 8px;
            cursor: pointer;
        }
        .reset-btn:hover {
            border-color: rgba(94,161,255,0.85);
            color: #fff;
        }
        .indicator .tag { font-size: 10px; color: #8290a2; text-transform: uppercase; letter-spacing: 0.5px; }
        #chart-shell { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
        #price-chart { position: relative; flex: 1 1 auto; min-height: 0; }
        #volume-chart { position: relative; flex: 0 0 19%; min-height: 0; border-top: 1px solid #263241; }
        #legend {
            position: absolute;
            top: 14px;
            left: 14px;
            z-index: 4;
            padding: 10px 12px;
            min-width: 280px;
            max-width: calc(100vw - 28px);
            border: 1px solid #263241;
            border-radius: 12px;
            background: rgba(10,14,20,0.72);
            backdrop-filter: blur(10px);
        }
        .legend-line { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; font-size: 11px; }
        .legend-line + .legend-line { margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); }
        .legend-item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
        .legend-dot { width: 10px; height: 10px; border-radius: 999px; flex: 0 0 auto; }
        .legend-label { color: #8290a2; text-transform: uppercase; letter-spacing: 0.45px; font-size: 10px; }
        .legend-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #eef4fb; font-weight: 700; }
        .status { display: inline-flex; align-items: center; gap: 8px; font-size: 10px; color: #8290a2; text-transform: uppercase; letter-spacing: 0.5px; }
        .pill { border: 1px solid rgba(255,255,255,0.06); border-radius: 999px; padding: 4px 8px; background: rgba(255,255,255,0.03); }
        .uplot { background: #0b0f14; }
        .u-cursor-x { border-left: 1px dashed rgba(255,255,255,0.3) !important; }
        .u-cursor-y { border-top: 1px dashed rgba(255,255,255,0.3) !important; display: none; }
        .is-hovered .u-cursor-y { display: block; }
        @media (max-width: 980px) {
            #topbar { flex-direction: column; align-items: flex-start; }
            #toolbar { justify-content: flex-start; }
            .group { padding-left: 0; border-left: 0; flex-wrap: wrap; }
            #legend { min-width: 0; max-width: calc(100vw - 24px); }
        }
    </style>
</head>
<body>
    <div id="app">
        <div id="topbar">
            <div id="brand">
                <div id="title">${escapeHtml(title)}</div>
                <div id="subtitle">${escapeHtml(poolLabel)} · ${escapeHtml(pairLabelNormal)} · ${escapeHtml(intervalLabel)} base · indicators from 1h · volume · uPlot</div>
            </div>
            <div id="toolbar">
                <div class="group" id="tf-group">
                    ${timeframes.map((item: any) => `<button class="time-btn${item.label === defaultTimeframe.label ? ' active' : ''}" data-timeframe="${escapeHtml(item.label)}"${item.enabled ? '' : ' disabled'}>${escapeHtml(item.label)}</button>`).join('')}
                </div>
                <div class="group">
                    <div class="indicator">
                        <span class="tag">pair</span>
                        <button type="button" class="pair-toggle${defaultPairMode === 'inverse' ? ' is-inverse' : ''}" id="pair-toggle" aria-label="Swap pair orientation" title="Swap pair orientation" data-pair-mode="${escapeHtml(defaultPairMode)}">
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path d="M6.5 7H19v2H6.5v3L2 8.5 6.5 5v2Zm11 10H5v-2h12.5v-3L22 15.5 17.5 19v-2Z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="indicator">
                        <span class="tag">scale</span>
                        <button type="button" class="scale-toggle${defaults.priceScale === 'linear' ? ' is-linear' : ''}" id="scale-toggle" data-scale="${escapeHtml(defaults.priceScale)}" aria-label="Toggle price scale" title="Toggle price scale">${defaults.priceScale === 'linear' ? 'Linear' : 'Log'}</button>
                    </div>
                    <div class="indicator">
                        <label><input type="checkbox" id="sma-toggle"${defaults.smaEnabled ? ' checked' : ''}> SMA</label>
                        <span class="tag">period</span>
                        <input type="text" inputmode="numeric" id="sma-period" value="${defaults.smaPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="sma-period-inc">▲</button>
                            <button type="button" class="step-btn" id="sma-period-dec">▼</button>
                        </span>
                    </div>
                    <div class="indicator">
                        <label><input type="checkbox" id="vwap-toggle"${defaults.vwapEnabled ? ' checked' : ''}> VWMA</label>
                        <span class="tag">bars</span>
                        <input type="text" inputmode="numeric" id="vwap-bars" value="${defaults.vwapBars}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="vwap-bars-inc">▲</button>
                            <button type="button" class="step-btn" id="vwap-bars-dec">▼</button>
                        </span>
                    </div>
                    <div class="indicator">
                        <label><input type="checkbox" id="ama-toggle"${defaults.amaEnabled ? ' checked' : ''}> AMA</label>
                        <span class="tag">er</span>
                        <input type="text" inputmode="numeric" id="ama-er" value="${defaults.amaDefaults.erPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="ama-er-inc">▲</button>
                            <button type="button" class="step-btn" id="ama-er-dec">▼</button>
                        </span>
                        <span class="tag">fast</span>
                        <input type="text" inputmode="decimal" id="ama-fast" value="${defaults.amaDefaults.fastPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="ama-fast-inc">▲</button>
                            <button type="button" class="step-btn" id="ama-fast-dec">▼</button>
                        </span>
                        <span class="tag">slow</span>
                        <input type="text" inputmode="decimal" id="ama-slow" value="${defaults.amaDefaults.slowPeriod}">
                        <span class="step-stack">
                            <button type="button" class="step-btn" id="ama-slow-inc">▲</button>
                            <button type="button" class="step-btn" id="ama-slow-dec">▼</button>
                        </span>
                        <button type="button" class="reset-btn" id="ama-reset">Reset</button>
                    </div>
                    <div class="indicator" style="margin-top:4px">
                        <label><input type="checkbox" id="ama-init-offset-toggle"> Init Offset</label>
                        <input type="range" id="ama-init-offset" min="-50" max="50" value="0" step="1" style="width:120px;vertical-align:middle" disabled>
                        <span id="ama-init-offset-val" style="font-size:11px;color:#8b949e;width:32px;display:inline-block;text-align:right">0%</span>
                    </div>
                </div>
                <div class="group"></div>
            </div>
        </div>
        <div id="chart-shell">
            <div id="legend">
                <div class="legend-line">
                    <span class="legend-item"><span class="legend-label">Time</span> <span class="legend-value" id="legend-time">-</span></span>
                    <span class="legend-item"><span class="legend-label">C</span> <span class="legend-value" id="legend-close">-</span></span>
                    <span class="legend-item"><span class="legend-label">Delta</span> <span class="legend-value" id="legend-delta">-</span></span>
                    <span class="legend-item"><span class="legend-label">Vol</span> <span class="legend-value" id="legend-volume">-</span></span>
                    <span class="legend-item"><span class="legend-label">Scale</span> <span class="legend-value" id="legend-scale">-</span></span>
                </div>
                <div class="legend-line">
                    <span class="legend-item"><span class="legend-dot" style="background:#f59e0b"></span><span class="legend-label">SMA</span> <span class="legend-value" id="legend-sma">-</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#2dd4bf"></span><span class="legend-label">AMA</span> <span class="legend-value" id="legend-ama">-</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#22c55e"></span><span class="legend-label">AMA Init</span> <span class="legend-value" id="legend-sma-init">-</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#a855f7"></span><span class="legend-label">Off Init</span> <span class="legend-value" id="legend-off-init">-</span></span>
                    <span class="legend-item"><span class="legend-dot" style="background:#a855f7"></span><span class="legend-label">AMA Off</span> <span class="legend-value" id="legend-ama-off">-</span></span>

                    <span class="legend-item"><span class="legend-dot" style="background:#93c5fd"></span><span class="legend-label">VWMA</span> <span class="legend-value" id="legend-vwap">-</span></span>
                </div>
            </div>
            <div id="price-chart" title="Wheel: zoom time (ulos = tyhjaa tilaa datan ymparilla) · Drag: siirra aika- ja hintanakymaa · Wheel/drag hinta-akselilla: zoomaa hintaa · Double-click hinta-akselia: autofit"></div>
            <div id="volume-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript(payload)}</script>
    <script>
    (function () {
        const payload = JSON.parse(document.getElementById('payload').textContent);
        const priceEl = document.getElementById('price-chart');
        const volumeEl = document.getElementById('volume-chart');
        const baseCandles = Array.isArray(payload.candles) ? payload.candles.slice() : [];
        const baseCloseValues = baseCandles.map((c) => c.close);
        const timeframes = Array.isArray(payload.timeframes) ? payload.timeframes.slice() : [];
        const timeframeMap = new Map(timeframes.map((item) => [item.label, item]));
        const STORAGE_KEY = 'dexbot2-tradingview-uplot-v2';

        const state = loadState();
        let currentTimeframe = state.timeframe || payload.defaultTimeframe || '1h';
        let currentSmaEnabled = state.smaEnabled ?? !!payload.smaEnabled;
        let currentSmaPeriod = Number.isFinite(state.smaPeriod) ? state.smaPeriod : Number(payload.smaPeriod || 500);
        let currentAmaEnabled = state.amaEnabled ?? !!payload.amaEnabled;
        let currentAmaErPeriod = Number.isFinite(state.amaErPeriod)
            ? Number(state.amaErPeriod)
            : Number(payload.amaDefaults?.erPeriod || ${MARKET_ADAPTER.AMAS.AMA3.erPeriod});
        let currentAmaFastPeriod = Number.isFinite(state.amaFastPeriod)
            ? Number(state.amaFastPeriod)
            : Number(payload.amaDefaults?.fastPeriod || ${MARKET_ADAPTER.AMAS.AMA3.fastPeriod});
        let currentAmaSlowPeriod = Number.isFinite(state.amaSlowPeriod)
            ? Number(state.amaSlowPeriod)
            : Number(payload.amaDefaults?.slowPeriod || ${MARKET_ADAPTER.AMAS.AMA3.slowPeriod});
        let currentVwapEnabled = state.vwapEnabled ?? !!payload.vwapEnabled;
        let currentVwapBars = Number.isFinite(state.vwapBars) ? state.vwapBars : Number(payload.vwapBars || 500);
        let currentAmaInitOffsetEnabled = false;
        let currentAmaInitOffset = Number.isFinite(state.amaInitOffset) ? state.amaInitOffset : 0;
        let currentPriceScale = state.priceScale || payload.priceScale || 'log';
        let currentPairMode = state.pairMode === 'inverse' ? 'inverse' : (payload.defaultPairMode === 'inverse' ? 'inverse' : 'normal');
        let currentCandles = [];
        let currentSeriesState = null;
        let currentSeriesCandles = baseCandles;
        let currentSeriesCloseValues = baseCloseValues;
        let currentOpen = [];
        let currentHigh = [];
        let currentLow = [];
        let currentClose = [];
        let currentDisplayCandles = [];
        let currentPriceData = [];
        let currentVolumeData = [];
        let currentSma = [];
        let currentAma = [];
        let currentVwap = [];
        let currentSmaInit = [];
        let currentSmaInitOff = [];
        let currentAmaOff = [];
        let priceChart = null;
        let volumeChart = null;
        let lastRenderedPriceScale = null;
        let charts = [];
        let chartEventsBound = false;
        let manualYRange = null;
        let pendingRange = null;
        let pendingRangeRaf = 0;
        let smaWorker = null;
        let smaWorkerJob = null;
        let smaWorkerStartRaf = 0;
        let smaWorkerPaintRaf = 0;
        let smaWorkerSeq = 0;
        const aggregateCache = new Map();
        const smaCache = new Map();
        const amaCache = new Map();
        const vwapCache = new Map();
        const seriesCache = new Map();

        function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
        function fmtPrice(v) {
            if (v == null || !Number.isFinite(v)) return '-';
            const abs = Math.abs(v);
            if (abs >= 1000) return v.toFixed(2);
            if (abs >= 100) return v.toFixed(3);
            if (abs >= 1) return v.toFixed(4);
            return v.toPrecision(6);
        }
        function fmtPriceAxis(vals) {
            if (!Array.isArray(vals) || vals.length === 0) return [];
            let step = Infinity;
            for (let i = 1; i < vals.length; i++) {
                const d = Math.abs(Number(vals[i]) - Number(vals[i - 1]));
                if (Number.isFinite(d) && d > 0 && d < step) step = d;
            }
            let decimals = 4;
            if (Number.isFinite(step) && step > 0) decimals = Math.ceil(-Math.log10(step));
            decimals = Math.max(0, Math.min(10, decimals));
            return vals.map((v) => (v == null || !Number.isFinite(v)) ? '' : Number(v).toFixed(decimals));
        }
        function fmtPriceLabel(v) {
            if (v == null || !Number.isFinite(v)) return '-';
            const abs = Math.abs(v);
            if (abs >= 1000) return v.toFixed(2);
            if (abs >= 1) return v.toFixed(4);
            let s = v.toPrecision(6);
            if (s.indexOf('e') >= 0) s = v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
            return s;
        }
        function fmtVolume(v) {
            if (v == null || !Number.isFinite(v)) return '-';
            const abs = Math.abs(v);
            if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
            if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
            if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'K';
            return v.toFixed(2);
        }
        function candleDirection(open, close) {
            if (close > open) return 'up';
            if (close < open) return 'down';
            return 'flat';
        }
        function fmtTime(ts) {
            if (!Number.isFinite(ts)) return '-';
            const d = new Date(ts * 1000);
            return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
        function pad2(n) {
            return String(n).padStart(2, '0');
        }
        function formatTimeLabel(tsSec, spanSec) {
            const d = new Date(tsSec * 1000);
            if (!Number.isFinite(spanSec)) spanSec = 0;
            if (spanSec >= 365 * 24 * 3600 * 2) {
                return String(d.getUTCFullYear());
            }
            if (spanSec >= 90 * 24 * 3600) {
                return d.toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
            }
            if (spanSec >= 14 * 24 * 3600) {
                return d.toLocaleString(undefined, { month: 'short', day: '2-digit', timeZone: 'UTC' });
            }
            return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
        }
        function makeTimeAxis(showLabels) {
            return {
                show: true,
                size: showLabels ? 24 : 14,
                stroke: '#ffffff',
                grid: { stroke: '#1c2128' },
                ticks: { stroke: '#30363d', width: 1 },
                font: '11px Segoe UI, sans-serif',
                values: showLabels ? (u, vals) => {
                    const xScale = u.scales.x || {};
                    const spanSec = Number.isFinite(xScale.min) && Number.isFinite(xScale.max)
                        ? Math.max(0, xScale.max - xScale.min)
                        : 0;
                    return vals.map((ts) => formatTimeLabel(ts, spanSec));
                } : () => [],
            };
        }
        function loadState() {
            try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; }
        }
        function saveState() {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    timeframe: currentTimeframe,
                    smaEnabled: currentSmaEnabled,
                    smaPeriod: currentSmaPeriod,
                    amaEnabled: currentAmaEnabled,
                    amaErPeriod: currentAmaErPeriod,
                    amaFastPeriod: currentAmaFastPeriod,
                    amaSlowPeriod: currentAmaSlowPeriod,
                    vwapEnabled: currentVwapEnabled,
                    vwapBars: currentVwapBars,
                    amaInitOffset: currentAmaInitOffset,
                    priceScale: currentPriceScale,
                    pairMode: currentPairMode,
                }));
            } catch (e) {}
        }
        function normalizePairMode(mode) {
            return String(mode).toLowerCase() === 'inverse' ? 'inverse' : 'normal';
        }
        function getPairLabel(mode = currentPairMode) {
            return normalizePairMode(mode) === 'inverse'
                ? (payload.pairLabelInverse || (payload.assetLabelB + '/' + payload.assetLabelA))
                : (payload.pairLabelNormal || (payload.assetLabelA + '/' + payload.assetLabelB));
        }
        function refreshSubtitle() {
            const subtitleEl = document.getElementById('subtitle');
            if (!subtitleEl) return;
            subtitleEl.textContent = payload.poolLabel + ' · ' + getPairLabel() + ' · ' + payload.intervalLabel + ' base · indicators from 1h · volume · uPlot';
        }
        function snapInitOffset(value) {
            const next = Math.round(Number(value) || 0);
            return Math.abs(next) <= 2 ? 0 : next;
        }
        function setActivePairMode(mode) {
            const label = normalizePairMode(mode);
            const btn = document.getElementById('pair-toggle');
            if (!btn) return;
            btn.dataset.pairMode = label;
            btn.classList.toggle('is-inverse', label === 'inverse');
            btn.title = label === 'inverse' ? 'Swap to A/B' : 'Swap to B/A';
            btn.setAttribute('aria-label', label === 'inverse' ? 'Swap to A/B' : 'Swap to B/A');
        }
        function invertCandle(candle) {
            const open = Number(candle?.open);
            const high = Number(candle?.high);
            const low = Number(candle?.low);
            const close = Number(candle?.close);
            if (![open, high, low, close].every(Number.isFinite) || open <= 0 || high <= 0 || low <= 0 || close <= 0) return null;
            const volume = Number(candle?.volume);
            return {
                time: candle.time,
                open: 1 / open,
                high: 1 / low,
                low: 1 / high,
                close: 1 / close,
                // Convert base-asset volume into the inverse pair's base units approximately.
                volume: Number.isFinite(volume) ? volume * close : 0,
            };
        }
        function getSeriesState(mode = currentPairMode) {
            const key = normalizePairMode(mode);
            if (seriesCache.has(key)) return seriesCache.get(key);
            const candles = key === 'inverse'
                ? baseCandles.map(invertCandle).filter(Boolean)
                : baseCandles.slice();
            const state = {
                candles,
                closeValues: candles.map((c) => c.close),
            };
            seriesCache.set(key, state);
            return state;
        }
        function aggregateCandles(rows, seconds) {
            const bucketSec = Math.max(1, Math.round(seconds || 3600));
            const cacheKey = currentPairMode + '|' + bucketSec;
            if (aggregateCache.has(cacheKey)) return aggregateCache.get(cacheKey);
            const out = [];
            const idxs = [];
            let cur = null;
            let curBucket = null;
            let curIdx = -1;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const ts = Number(row.time);
                if (!Number.isFinite(ts)) continue;
                const bucket = Math.floor(ts / bucketSec) * bucketSec;
                if (!cur || bucket !== curBucket) {
                    if (cur) {
                        out.push(cur);
                        idxs.push(curIdx);
                    }
                    curBucket = bucket;
                    curIdx = i;
                    cur = { time: bucket, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume || 0 };
                } else {
                    cur.high = Math.max(cur.high, row.high);
                    cur.low = Math.min(cur.low, row.low);
                    cur.close = row.close;
                    cur.volume += row.volume || 0;
                    curIdx = i;
                }
            }
            if (cur) {
                out.push(cur);
                idxs.push(curIdx);
            }
            const result = { candles: out, idxs };
            aggregateCache.set(cacheKey, result);
            return result;
        }
        function sampleSeriesByIndex(series, idxs) {
            if (!Array.isArray(series) || !Array.isArray(idxs)) return [];
            return idxs.map((idx) => (Number.isFinite(idx) && series[idx] != null ? series[idx] : null));
        }
        function deriveDisplayCandles(candles) {
            if (!Array.isArray(candles) || candles.length === 0) return [];
            return candles.map((c, i) => {
                const prevClose = i > 0 ? candles[i - 1].close : c.close;
                const open = Number.isFinite(prevClose) ? prevClose : c.close;
                const close = c.close;
                return {
                    time: c.time,
                    open,
                    close,
                    volume: c.volume,
                };
            });
        }
        function computeSMA(candles, period) {
            const safePeriod = Math.max(1, Math.round(period));
            const cacheKey = currentPairMode + '|' + safePeriod + '|' + candles.length;
            if (smaCache.has(cacheKey)) return smaCache.get(cacheKey);
            const out = [];
            let sum = 0;
            const window = new Array(safePeriod);
            let head = 0;
            let count = 0;
            for (const candle of candles) {
                const price = candle.close;
                if (count < safePeriod) {
                    window[count] = price;
                    sum += price;
                    count++;
                    out.push(count === safePeriod ? (sum / safePeriod) : null);
                    continue;
                }
                sum -= window[head];
                window[head] = price;
                sum += price;
                head = (head + 1) % safePeriod;
                out.push(sum / safePeriod);
            }
            smaCache.set(cacheKey, out);
            return out;
        }
        function getSmaCacheKey(period) {
            return currentPairMode + '|' + Math.max(1, Math.round(period)) + '|' + currentSeriesCloseValues.length;
        }
        function createSMAWorker() {
            if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return null;
            const workerSource = [
                'self.onmessage = function(e) {',
                '  const data = e.data || {};',
                '  const id = data.id;',
                '  const key = data.key;',
                '  const closes = Array.isArray(data.closes) ? data.closes : [];',
                '  const period = Math.max(1, Math.round(Number(data.period) || 1));',
                '  const out = new Array(closes.length);',
                '  const window = new Array(period);',
                '  let sum = 0;',
                '  let head = 0;',
                '  let count = 0;',
                '  for (let i = 0; i < closes.length; i++) {',
                '    const price = Number(closes[i]);',
                '    if (count < period) {',
                '      window[count] = price;',
                '      sum += price;',
                '      count++;',
                '      out[i] = count === period ? (sum / period) : null;',
                '      continue;',
                '    }',
                '    sum -= window[head];',
                '    window[head] = price;',
                '    sum += price;',
                '    head = (head + 1) % period;',
                '    out[i] = sum / period;',
                '  }',
                '  self.postMessage({ id, key, series: out });',
                '};',
            ].join('\\n');
            const blob = new Blob([workerSource], { type: 'text/javascript' });
            const worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = (e) => {
                const msg = e && e.data ? e.data : {};
                if (!smaWorkerJob || msg.id !== smaWorkerJob.id || msg.key !== smaWorkerJob.key) return;
                smaCache.set(msg.key, Array.isArray(msg.series) ? msg.series : []);
                smaWorkerJob = null;
                if (currentSmaEnabled && msg.key === getSmaCacheKey(currentSmaPeriod)) {
                    rerender(false);
                }
            };
            worker.onerror = () => {
                try { worker.terminate(); } catch (e) {}
                smaWorker = null;
                smaWorkerJob = null;
            };
            return worker;
        }
        function clearSMAWorker() {
            if (smaWorkerStartRaf) {
                cancelAnimationFrame(smaWorkerStartRaf);
                smaWorkerStartRaf = 0;
            }
            if (smaWorkerPaintRaf) {
                cancelAnimationFrame(smaWorkerPaintRaf);
                smaWorkerPaintRaf = 0;
            }
            if (!smaWorker) return;
            try { smaWorker.terminate(); } catch (e) {}
            smaWorker = null;
            smaWorkerJob = null;
        }
        function requestSMA(period) {
            const safePeriod = Math.max(1, Math.round(period));
            const key = getSmaCacheKey(safePeriod);
            if (smaCache.has(key)) return;
            if (smaWorkerJob && smaWorkerJob.key === key) return;
            if (smaWorkerJob && smaWorkerJob.key !== key) clearSMAWorker();
            if (!smaWorker) smaWorker = createSMAWorker();
            if (!smaWorker) {
                smaCache.set(key, computeSMA(currentSeriesCandles, safePeriod));
                if (currentSmaEnabled && key === getSmaCacheKey(currentSmaPeriod)) rerender(false);
                return;
            }
            smaWorkerJob = { id: ++smaWorkerSeq, key };
            if (smaWorkerStartRaf) cancelAnimationFrame(smaWorkerStartRaf);
            if (smaWorkerPaintRaf) cancelAnimationFrame(smaWorkerPaintRaf);
            smaWorkerStartRaf = requestAnimationFrame(() => {
                smaWorkerStartRaf = 0;
                smaWorkerPaintRaf = requestAnimationFrame(() => {
                    smaWorkerPaintRaf = 0;
                    if (!smaWorker || !smaWorkerJob || smaWorkerJob.key !== key || !currentSmaEnabled) return;
                    smaWorker.postMessage({
                        id: smaWorkerJob.id,
                        key,
                        period: safePeriod,
                        closes: currentSeriesCloseValues,
                    });
                });
            });
        }
        function currentAmaConfig() {
            return {
                erPeriod: Math.max(1, Math.round(currentAmaErPeriod)),
                fastPeriod: Math.max(0.1, Number(currentAmaFastPeriod) || 0.1),
                slowPeriod: Math.max(0.1, Number(currentAmaSlowPeriod) || 0.1),
            };
        }
        function computeAMA(candles, cfg, initOffset = 0) {
            const params = cfg || currentAmaConfig();
            const erPeriod = Math.max(1, Math.round(params.erPeriod ?? 10));
            const fastPeriod = Math.max(0.1, Number(params.fastPeriod ?? 2));
            const slowPeriod = Math.max(0.1, Number(params.slowPeriod ?? 30));
            const cacheKey = currentPairMode + '|' + erPeriod + '|' + fastPeriod + '|' + slowPeriod + '|' + candles.length + '|' + initOffset;
            if (amaCache.has(cacheKey)) return amaCache.get(cacheKey);
            const fastSC = 2 / (fastPeriod + 1);
            const slowSC = 2 / (slowPeriod + 1);
            const out = [];
            const windowSize = erPeriod + 1;
            const history = new Array(windowSize);
            let head = 0;
            let len = 0;
            let volatility = 0;
            let prev = null;
            let smaSum = 0;
            for (const candle of candles) {
                const price = candle.close;
                if (len < windowSize) {
                    history[(head + len) % windowSize] = price;
                    smaSum += price;
                    if (len > 0) {
                        volatility += Math.abs(price - history[(head + len - 1) % windowSize]);
                    }
                    len++;
                    if (len < windowSize) {
                        out.push(null);
                        continue;
                    }
                    prev = initOffset !== 0 ? (smaSum / windowSize) * (1 + initOffset / 100) : smaSum / windowSize;
                    out.push(prev);
                    continue;
                }
                const oldest = history[head];
                const second = history[(head + 1) % windowSize];
                const last = history[(head + windowSize - 1) % windowSize];
                volatility += Math.abs(price - last) - Math.abs(second - oldest);
                history[head] = price;
                head = (head + 1) % windowSize;
                const first = history[head];
                const direction = Math.abs(price - first);
                const er = volatility === 0 ? 0 : (direction / volatility);
                const smoothing = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
                const ama = prev + smoothing * (price - prev);
                prev = ama;
                out.push(ama);
            }
            amaCache.set(cacheKey, out);
            return out;
        }
        function computeVWMA(candles, bars) {
            const safeBars = Math.max(1, Math.round(bars || 500));
            const cacheKey = currentPairMode + '|' + safeBars + '|' + candles.length;
            if (vwapCache.has(cacheKey)) return vwapCache.get(cacheKey);
            const out = [];
            let cumPV = 0;
            let cumVol = 0;
            const window = new Array(safeBars);
            let head = 0;
            let count = 0;
            for (const candle of candles) {
                const typical = (candle.high + candle.low + candle.close) / 3;
                const volume = Number.isFinite(candle.volume) ? candle.volume : 0;
                cumPV += typical * volume;
                cumVol += volume;
                if (count < safeBars) {
                    window[count] = { typical, volume };
                    count++;
                } else {
                    const old = window[head];
                    cumPV -= old.typical * old.volume;
                    cumVol -= old.volume;
                    window[head] = { typical, volume };
                    head = (head + 1) % safeBars;
                }
                out.push(cumVol > 0 ? (cumPV / cumVol) : null);
            }
            vwapCache.set(cacheKey, out);
            return out;
        }
        function lowerBound(arr, value) {
            let lo = 0;
            let hi = arr.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (arr[mid] < value) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }
        function visiblePriceRange(u) {
            if (!currentCandles.length) return null;
            const xs = u.data[0];
            const xScale = u.scales.x || {};
            const minX = Number.isFinite(xScale.min) ? xScale.min : xs[0];
            const maxX = Number.isFinite(xScale.max) ? xScale.max : xs[xs.length - 1];
            let start = Math.max(0, lowerBound(xs, minX) - 1);
            let end = Math.min(xs.length, lowerBound(xs, maxX) + 2);
            let min = Infinity;
            let max = -Infinity;
            for (let i = start; i < end; i++) {
                const lo = currentLow[i];
                const hi = currentHigh[i];
                if (Number.isFinite(lo) && lo > 0 && lo < min) min = lo;
                if (Number.isFinite(hi) && hi > max) max = hi;
                const s = currentSma[i];
                const a = currentAma[i];
                const v = currentVwap[i];
                if (Number.isFinite(s)) { if (s < min) min = s; if (s > max) max = s; }
                if (Number.isFinite(a)) { if (a < min) min = a; if (a > max) max = a; }
                if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
            }
            if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;
            if (min === max) return [min * 0.96, max * 1.04];
            // ~7 % hengitystilaa yla- ja alapuolelle (TradingView-tyyli)
            return [min * 0.93, max * 1.07];
        }
        function visibleVolumeRange(u) {
            if (!currentCandles.length) return null;
            const xs = u.data[0];
            const xScale = u.scales.x || {};
            const minX = Number.isFinite(xScale.min) ? xScale.min : xs[0];
            const maxX = Number.isFinite(xScale.max) ? xScale.max : xs[xs.length - 1];
            let start = Math.max(0, lowerBound(xs, minX) - 1);
            let end = Math.min(xs.length, lowerBound(xs, maxX) + 2);
            let max = 0;
            for (let i = start; i < end; i++) {
                const v = currentCandles[i]?.volume;
                if (Number.isFinite(v) && v > max) max = v;
            }
            if (!Number.isFinite(max) || max <= 0) return [0, 1];
            return [0, max * 1.15];
        }
        function setActiveTimeframe(label) {
            document.querySelectorAll('.time-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.timeframe === label));
        }
        function setActivePriceScale(label) {
            const btn = document.getElementById('scale-toggle');
            if (!btn) return;
            const next = label === 'linear' ? 'linear' : 'log';
            btn.dataset.scale = next;
            btn.classList.toggle('is-linear', next === 'linear');
            btn.textContent = next === 'linear' ? 'Linear' : 'Log';
            btn.title = next === 'linear' ? 'Toggle to log scale' : 'Toggle to linear scale';
            btn.setAttribute('aria-label', next === 'linear' ? 'Toggle to log scale' : 'Toggle to linear scale');
        }
        function resetAmaDefaults() {
            currentAmaErPeriod = Number(payload.amaDefaults?.erPeriod || ${MARKET_ADAPTER.AMAS.AMA3.erPeriod});
            currentAmaFastPeriod = Number(payload.amaDefaults?.fastPeriod || ${MARKET_ADAPTER.AMAS.AMA3.fastPeriod});
            currentAmaSlowPeriod = Number(payload.amaDefaults?.slowPeriod || ${MARKET_ADAPTER.AMAS.AMA3.slowPeriod});
            setControls();
            rerender(false);
        }
        function setIndicatorSeriesVisible(seriesIndex, visible) {
            if (!priceChart) return;
            priceChart.setSeries(seriesIndex, { show: visible }, false, false);
        }
        function syncIndicatorSeriesVisibility() {
            if (!priceChart) return;
            setIndicatorSeriesVisible(5, currentSmaEnabled);
            setIndicatorSeriesVisible(6, currentAmaEnabled);
            setIndicatorSeriesVisible(7, currentVwapEnabled);
            setIndicatorSeriesVisible(8, currentAmaEnabled);
            setIndicatorSeriesVisible(9, currentAmaEnabled && currentAmaInitOffset !== 0);
            setIndicatorSeriesVisible(10, currentAmaEnabled && currentAmaInitOffset !== 0);
        }
        function hideSmaSeriesImmediate() {
            clearSMAWorker();
            currentSma = new Array(currentCandles.length).fill(null);
            if (Array.isArray(currentPriceData) && currentPriceData.length >= 11) {
                currentPriceData[5] = currentSma;
            }
            setIndicatorSeriesVisible(5, false);
            refreshLegend();
            saveState();
        }
        function hideAmaSeriesImmediate() {
            currentAma = new Array(currentCandles.length).fill(null);
            currentAmaOff = new Array(currentCandles.length).fill(null);
            currentSmaInit = new Array(currentCandles.length).fill(null);
            currentSmaInitOff = new Array(currentCandles.length).fill(null);
            if (Array.isArray(currentPriceData) && currentPriceData.length >= 11) {
                currentPriceData[6] = currentAma;
                currentPriceData[8] = currentSmaInit;
                currentPriceData[9] = currentSmaInitOff;
                currentPriceData[10] = currentAmaOff;
            }
            setIndicatorSeriesVisible(6, false);
            setIndicatorSeriesVisible(8, false);
            setIndicatorSeriesVisible(9, false);
            setIndicatorSeriesVisible(10, false);
            refreshLegend();
            saveState();
        }
        function hideVwapSeriesImmediate() {
            currentVwap = new Array(currentCandles.length).fill(null);
            if (Array.isArray(currentPriceData) && currentPriceData.length >= 11) {
                currentPriceData[7] = currentVwap;
            }
            setIndicatorSeriesVisible(7, false);
            refreshLegend();
            saveState();
        }
        function updateLegend(idx) {
            const c = currentCandles[idx];
            if (!c) return;
            const smaKey = getSmaCacheKey(currentSmaPeriod);
            const smaPending = currentSmaEnabled && smaWorkerJob && smaWorkerJob.key === smaKey && !smaCache.has(smaKey);
            document.getElementById('legend-time').textContent = fmtTime(c.time);
            document.getElementById('legend-close').textContent = fmtPrice(c.close);
            const delta = Number.isFinite(c.open) && Number.isFinite(c.close) ? (c.close - c.open) : null;
            document.getElementById('legend-delta').textContent = Number.isFinite(delta)
                ? ((delta >= 0 ? '+' : '') + fmtPrice(delta))
                : '-';
            document.getElementById('legend-volume').textContent = fmtVolume(c.volume);
            document.getElementById('legend-scale').textContent = currentPriceScale === 'linear' ? 'Linear' : 'Log';
            document.getElementById('legend-sma').textContent = Number.isFinite(currentSma[idx]) ? fmtPrice(currentSma[idx]) : (smaPending ? '...' : '-');
            document.getElementById('legend-ama').textContent = Number.isFinite(currentAma[idx]) ? fmtPrice(currentAma[idx]) : '-';
            document.getElementById('legend-sma-init').textContent = Number.isFinite(currentSmaInit[idx]) ? fmtPrice(currentSmaInit[idx]) : '-';
            document.getElementById('legend-off-init').textContent = Number.isFinite(currentSmaInitOff[idx]) ? fmtPrice(currentSmaInitOff[idx]) : '-';
            document.getElementById('legend-ama-off').textContent = Number.isFinite(currentAmaOff[idx]) ? fmtPrice(currentAmaOff[idx]) : '-';
            document.getElementById('legend-vwap').textContent = Number.isFinite(currentVwap[idx]) ? fmtPrice(currentVwap[idx]) : '-';
        }
        function candlePlugin() {
            function drawCandles(u) {
                u.ctx.save();

                const offset = 0.5;
                u.ctx.translate(offset, offset);

                const [iMin, iMax] = u.series[0].idxs;

                for (let i = iMin; i <= iMax; i++) {
                    const xVal = u.scales.x.distr == 2 ? i : u.data[0][i];
                    const open = u.data[1][i];
                    const high = u.data[2][i];
                    const low = u.data[3][i];
                    const close = u.data[4][i];

                    const x = u.valToPos(xVal, 'x', true);
                    const openY = u.valToPos(open, 'y', true);
                    const highY = u.valToPos(high, 'y', true);
                    const lowY = u.valToPos(low, 'y', true);
                    const closeY = u.valToPos(close, 'y', true);
                    if (![x, openY, highY, lowY, closeY].every(Number.isFinite)) continue;

                    const nextX = i + 1 <= iMax ? u.valToPos(u.scales.x.distr == 2 ? (i + 1) : u.data[0][i + 1], 'x', true) : null;
                    const prevX = i - 1 >= iMin ? u.valToPos(u.scales.x.distr == 2 ? (i - 1) : u.data[0][i - 1], 'x', true) : null;
                    const spacing = Number.isFinite(nextX) ? (nextX - x) : (Number.isFinite(prevX) ? (x - prevX) : 12);
                    // Wider bodies read better when zoomed in and reduce empty space between candles.
                    const bodyW = Math.max(
                        4,
                        Math.min(
                            Math.abs(spacing) * 0.86,
                            Math.max(18, Math.abs(spacing) * 0.94),
                        ),
                    );
                    const dir = candleDirection(open, close);
                    const bodyColor = dir === 'up' ? '#26a69a' : (dir === 'down' ? '#ef5350' : '#64748b');
                    const wickColor = dir === 'up' ? '#b3fff3' : (dir === 'down' ? '#ffb3b3' : '#94a3b8');
                    const bodyTop = Math.min(openY, closeY);
                    const bodyBottom = Math.max(openY, closeY);
                    const bodyH = Math.max(dir === 'flat' ? 2 : 3, Math.round(bodyBottom - bodyTop));
                    const bodyX = Math.round(x - bodyW / 2);
                    const bodyY = Math.round(bodyTop);

                    const wickW = Math.max(1, Math.min(5, Math.round(Math.abs(spacing) * 0.14)));
                    u.ctx.strokeStyle = wickColor;
                    u.ctx.lineWidth = wickW;
                    u.ctx.beginPath();
                    u.ctx.moveTo(x, highY);
                    u.ctx.lineTo(x, lowY);
                    u.ctx.stroke();

                    u.ctx.fillStyle = bodyColor;
                    u.ctx.fillRect(bodyX, bodyY, Math.round(bodyW), bodyH);
                    if (bodyW > 2 && bodyH > 2) {
                        u.ctx.strokeStyle = dir === 'up' ? '#0f7f77' : (dir === 'down' ? '#a92d35' : '#475569');
                        u.ctx.lineWidth = 1;
                        u.ctx.strokeRect(bodyX + 0.5, bodyY + 0.5, Math.round(bodyW) - 1, bodyH - 1);
                    }
                }

                u.ctx.translate(-offset, -offset);
                u.ctx.restore();
            }

                return {
                    opts: (u, opts) => {
                        uPlot.assign(opts, {
                            cursor: { drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                        });
                    opts.series.forEach((s, i) => {
                        if (i > 0 && i <= 4) {
                            s.paths = () => null;
                            s.points = { show: false };
                            s.stroke = 'transparent';
                        }
                    });
                },
                hooks: { drawAxes: [drawCandles] },
            };
        }
        function volumePlugin() {
            function drawVolumeBars(u) {
                u.ctx.save();

                const offset = 0.5;
                u.ctx.translate(offset, offset);

                const [iMin, iMax] = u.series[0].idxs;
                const xVals = u.data[0];
                const volVals = u.data[1];

                for (let i = iMin; i <= iMax; i++) {
                    const vol = volVals[i];
                    if (!Number.isFinite(vol) || vol <= 0) continue;

                    const xVal = u.scales.x.distr == 2 ? i : xVals[i];
                    const x = u.valToPos(xVal, 'x', true);
                    const top = u.valToPos(vol, 'y', true);
                    const bottom = u.valToPos(0, 'y', true);
                    if (![x, top, bottom].every(Number.isFinite)) continue;

                    const nextX = i + 1 <= iMax ? u.valToPos(u.scales.x.distr == 2 ? (i + 1) : xVals[i + 1], 'x', true) : null;
                    const prevX = i - 1 >= iMin ? u.valToPos(u.scales.x.distr == 2 ? (i - 1) : xVals[i - 1], 'x', true) : null;
                    const spacing = Number.isFinite(nextX) ? (nextX - x) : (Number.isFinite(prevX) ? (x - prevX) : 12);
                    const barW = Math.max(
                        4,
                        Math.min(
                            Math.abs(spacing) * 0.86,
                            Math.max(18, Math.abs(spacing) * 0.94),
                        ),
                    );

                    const left = Math.round(x - barW / 2);
                    const topY = Math.round(Math.min(top, bottom));
                    const h = Math.max(1, Math.round(Math.abs(bottom - top)));

                    u.ctx.fillStyle = '#ffffff';
                    u.ctx.fillRect(left, topY, Math.round(barW), h);
                }

                u.ctx.translate(-offset, -offset);
                u.ctx.restore();
            }

            return {
                opts: (u, opts) => {
                    uPlot.assign(opts, {
                        cursor: { drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                    });
                    opts.series.forEach((s, i) => {
                        if (i === 1) {
                            s.paths = () => null;
                            s.points = { show: false };
                            s.stroke = 'transparent';
                            s.fill = 'transparent';
                        }
                    });
                },
                hooks: { drawAxes: [drawVolumeBars] },
            };
        }
        function buildData() {
            const tf = timeframeMap.get(currentTimeframe) || timeframeMap.get(defaultTimeframe.label) || timeframes[0];
            currentSeriesState = getSeriesState(currentPairMode);
            currentSeriesCandles = currentSeriesState.candles;
            currentSeriesCloseValues = currentSeriesState.closeValues;
            const aggregated = aggregateCandles(currentSeriesCandles, tf?.seconds || 3600);
            currentCandles = aggregated.candles;
            currentDisplayCandles = deriveDisplayCandles(currentCandles);
            currentOpen = currentDisplayCandles.map((c) => c.open);
            currentHigh = currentCandles.map((c) => c.high);
            currentLow = currentCandles.map((c) => c.low);
            currentClose = currentDisplayCandles.map((c) => c.close);
            const baseAma = currentAmaEnabled ? computeAMA(currentSeriesCandles, currentAmaConfig()) : [];
            const baseAmaOff = currentAmaEnabled && currentAmaInitOffset !== 0
                ? computeAMA(currentSeriesCandles, currentAmaConfig(), currentAmaInitOffset)
                : [];
            const baseVwap = currentVwapEnabled ? computeVWMA(currentSeriesCandles, currentVwapBars) : [];
            if (currentSmaEnabled) {
                const smaKey = getSmaCacheKey(currentSmaPeriod);
                const baseSma = smaCache.get(smaKey);
                if (baseSma) {
                    currentSma = sampleSeriesByIndex(baseSma, aggregated.idxs);
                } else {
                    currentSma = new Array(currentCandles.length).fill(null);
                    requestSMA(currentSmaPeriod);
                }
            } else {
                currentSma = new Array(currentCandles.length).fill(null);
            }
            currentAma = currentAmaEnabled ? sampleSeriesByIndex(baseAma, aggregated.idxs) : new Array(currentCandles.length).fill(null);
            currentAmaOff = currentAmaEnabled && currentAmaInitOffset !== 0 ? sampleSeriesByIndex(baseAmaOff, aggregated.idxs) : new Array(currentCandles.length).fill(null);
            currentVwap = currentVwapEnabled ? sampleSeriesByIndex(baseVwap, aggregated.idxs) : new Array(currentCandles.length).fill(null);
            const amaCfg = currentAmaConfig();
            const warmupInit = currentAmaEnabled && baseAma.length > amaCfg.erPeriod ? baseAma[amaCfg.erPeriod] : null;
            const baseSmaInit = warmupInit !== null
                ? currentSeriesCandles.map((c, i) => i <= amaCfg.erPeriod ? warmupInit : null)
                : new Array(currentSeriesCandles.length).fill(null);
            currentSmaInit = sampleSeriesByIndex(baseSmaInit, aggregated.idxs);
            const offsetInit = currentAmaEnabled && currentAmaInitOffset !== 0 && baseAmaOff.length > amaCfg.erPeriod
                ? baseAmaOff[amaCfg.erPeriod]
                : null;
            const baseSmaInitOff = offsetInit !== null
                ? currentSeriesCandles.map((c, i) => i <= amaCfg.erPeriod ? offsetInit : null)
                : new Array(currentSeriesCandles.length).fill(null);
            currentSmaInitOff = sampleSeriesByIndex(baseSmaInitOff, aggregated.idxs);
            currentPriceData = [
                currentCandles.map((c) => c.time),
                currentOpen,
                currentHigh,
                currentLow,
                currentClose,
                currentSma,
                currentAma,
                currentVwap,
                currentSmaInit,
                currentSmaInitOff,
                currentAmaOff,
            ];
            currentVolumeData = [
                currentCandles.map((c) => c.time),
                currentCandles.map((c) => c.volume),
            ];
            return {
                priceData: currentPriceData,
                volumeData: currentVolumeData,
            };
        }
        function makeChart() {
            const data = buildData();
            const isLogScale = currentPriceScale !== 'linear';

            const priceOpts = {
                width: priceEl.clientWidth,
                height: priceEl.clientHeight,
                padding: [14, 8, 8, 8],
                legend: { show: false },
                select: { show: false },
                cursor: { sync: { key: STORAGE_KEY, setSeries: false, scales: ['x', null] }, drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                scales: {
                    x: { time: true },
                    y: {
                        auto: true,
                        distr: isLogScale ? 3 : 1,
                        log: isLogScale ? 10 : undefined,
                        range: (u, min, max) => {
                            if (manualYRange) return [manualYRange.min, manualYRange.max];
                            const vis = visiblePriceRange(u);
                            if (vis) return vis;
                            if (isLogScale) {
                                if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return [1, 10];
                            } else if (!Number.isFinite(min) || !Number.isFinite(max)) {
                                return [0, 1];
                            }
                            return [min * 0.97, max * 1.03];
                        },
                    },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Open' },
                    { label: 'High' },
                    { label: 'Low' },
                    { label: 'Close' },
                    { label: 'SMA', stroke: '#ffffff', width: 2, points: { show: false }, spanGaps: true },
                    { label: 'AMA', stroke: '#facc15', width: 2, points: { show: false }, spanGaps: true },
                    { label: 'VWMA', stroke: '#93c5fd', width: 2, points: { show: false }, spanGaps: true },
                    { label: 'AMA Init', stroke: '#22c55e', width: 1.5, dash: [6, 4], points: { show: false }, spanGaps: false },
                    { label: 'Off Init', stroke: '#a855f7', width: 1.5, dash: [6, 4], points: { show: false }, spanGaps: false },
                    { label: 'AMA Off', stroke: '#a855f7', width: 1.5, dash: [4, 4], points: { show: false }, spanGaps: false },
                ],
                axes: [
                    makeTimeAxis(false),
                    {
                        scale: 'y',
                        side: 1,
                        size: 76,
                        space: 16,
                        stroke: '#ffffff',
                        grid: { stroke: '#272f3a' },
                        ticks: { stroke: '#414b57', width: 1 },
                        font: '11px Segoe UI, sans-serif',
                        values: (u, vals) => fmtPriceAxis(vals),
                    },
                ],
                hooks: {
                    draw: [(u) => positionPriceMarker(u)],
                },
            };

            const plugin = candlePlugin();
            plugin.opts(null, priceOpts);
            priceOpts.plugins = [plugin];
            if (!priceChart) priceChart = new uPlot(priceOpts, data.priceData, priceEl);
            else priceChart.setData(data.priceData, false);

            const volumeOpts = {
                width: volumeEl.clientWidth,
                height: volumeEl.clientHeight,
                padding: [6, 8, 8, 8],
                legend: { show: false },
                select: { show: false },
                cursor: { sync: { key: STORAGE_KEY, setSeries: false, scales: ['x', null] }, drag: { x: false, y: false, setScale: false }, focus: { prox: 20 } },
                scales: {
                    x: { time: true },
                    y: {
                        auto: true,
                        range: (u, min, max) => {
                            const vis = visibleVolumeRange(u);
                            if (vis) return vis;
                            if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return [0, 1];
                            return [0, max * 1.15];
                        },
                    },
                },
                series: [
                    { label: 'Time' },
                    { label: 'Volume', stroke: '#ffffff', fill: '#ffffff', width: 1, points: { show: false } },
                ],
                axes: [
                    makeTimeAxis(true),
                    { scale: 'y', side: 1, size: 62, stroke: '#ffffff', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, values: (u, vals) => vals.map((v) => (v == null ? '' : fmtVolume(v))) },
                ],
            };

            const volumePluginInst = volumePlugin();
            volumePluginInst.opts(null, volumeOpts);
            volumeOpts.plugins = [volumePluginInst];
            if (!volumeChart) volumeChart = new uPlot(volumeOpts, data.volumeData, volumeEl);
            else volumeChart.setData(data.volumeData, false);

            charts = [priceChart, volumeChart];
            lastRenderedPriceScale = currentPriceScale;
            return priceChart;
        }
        function clampRange(min, max) {
            if (!currentCandles.length || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
            const first = currentCandles[0].time;
            const last = currentCandles[currentCandles.length - 1].time;
            // Salli tyhjaa tilaa datan molemmin puolin (TradingView-tyyli):
            // enintaan 75 % datan pituudesta reunapuskurina kummallekin puolelle.
            const dataSpan = Math.max(1, last - first);
            const maxPad = dataSpan * 0.75;
            const lo = Math.max(first - maxPad, min);
            const hi = Math.min(last + maxPad, max);
            if (hi <= lo) return null;
            return { min: lo, max: hi };
        }
        function syncXRange(min, max) {
            pendingRange = clampRange(min, max);
            if (pendingRangeRaf) return;
            pendingRangeRaf = requestAnimationFrame(() => {
                const next = pendingRange;
                pendingRange = null;
                pendingRangeRaf = 0;
                if (!next || charts.length === 0) return;
                charts.forEach((chart) => chart.batch(() => chart.setScale('x', next)));
            });
        }
        function inYAxisZone(chart, clientX) {
            const over = chart.over;
            if (!over) return false;
            const overRect = over.getBoundingClientRect();
            if (!overRect || overRect.width <= 0) return false;
            return clientX < overRect.left || clientX > overRect.right;
        }
        let priceMarkerLabel = null;
        let priceMarkerLine = null;
        function ensurePriceMarker(u) {
            if (priceMarkerLabel && priceMarkerLabel.parentNode === u.root) return;
            if (priceMarkerLabel && priceMarkerLabel.parentNode) priceMarkerLabel.parentNode.removeChild(priceMarkerLabel);
            if (priceMarkerLine && priceMarkerLine.parentNode) priceMarkerLine.parentNode.removeChild(priceMarkerLine);
            try { if (getComputedStyle(u.root).position === 'static') u.root.style.position = 'relative'; } catch (e) {}
            priceMarkerLabel = document.createElement('div');
            priceMarkerLabel.style.cssText = 'position:absolute;z-index:30;pointer-events:none;font:600 11px Segoe UI, sans-serif;line-height:18px;height:18px;padding:0 6px;border-radius:3px;color:#ffffff;white-space:nowrap;box-sizing:border-box;text-align:center;overflow:hidden;';
            priceMarkerLine = document.createElement('div');
            priceMarkerLine.style.cssText = 'position:absolute;z-index:1;pointer-events:none;height:0;border-top:1px dashed currentColor;opacity:0.6;';
            u.root.appendChild(priceMarkerLine);
            u.root.appendChild(priceMarkerLabel);
        }
        function positionPriceMarker(u) {
            if (!u || !u.over || !currentCandles.length) return;
            ensurePriceMarker(u);
            const last = currentCandles[currentCandles.length - 1];
            const prev = currentCandles.length > 1 ? currentCandles[currentCandles.length - 2] : last;
            const price = last.close;
            if (!Number.isFinite(price)) {
                priceMarkerLabel.style.display = 'none';
                priceMarkerLine.style.display = 'none';
                return;
            }
            const up = price >= (Number.isFinite(prev.close) ? prev.close : price);
            const color = up ? '#26a69a' : '#ef5350';
            const s = u.scales.y || {};
            const sMin = Number.isFinite(s.min) ? s.min : null;
            const sMax = Number.isFinite(s.max) ? s.max : null;
            if (sMin == null || sMax == null || sMax <= sMin) {
                priceMarkerLabel.style.display = 'none';
                priceMarkerLine.style.display = 'none';
                return;
            }
            let frac;
            if (currentPriceScale === 'log') {
                const lmin = Math.log10(sMin);
                const lmax = Math.log10(sMax);
                const lp = Math.log10(Math.max(price, 1e-12));
                frac = (lp - lmin) / (lmax - lmin);
            } else {
                frac = (price - sMin) / (sMax - sMin);
            }
            const rootRect = u.root.getBoundingClientRect();
            const overRect = u.over.getBoundingClientRect();
            if (!overRect || overRect.height <= 0) return;
            const plotTop = overRect.top - rootRect.top;
            const yRel = (1 - frac) * overRect.height;
            const inRange = frac >= 0 && frac <= 1;
            priceMarkerLabel.style.display = 'block';
            priceMarkerLabel.textContent = fmtPriceLabel(price);
            priceMarkerLabel.style.background = color;
            priceMarkerLabel.style.top = (plotTop + Math.max(0, Math.min(overRect.height, yRel)) - 9) + 'px';
            const leftAxisW = overRect.left - rootRect.left;
            const rightAxisW = rootRect.right - overRect.right;
            if (leftAxisW >= rightAxisW) {
                priceMarkerLabel.style.left = '0px';
                priceMarkerLabel.style.right = '';
                priceMarkerLabel.style.width = Math.max(40, leftAxisW - 4) + 'px';
            } else {
                priceMarkerLabel.style.left = '';
                priceMarkerLabel.style.right = '0px';
                priceMarkerLabel.style.width = Math.max(40, rightAxisW - 4) + 'px';
            }
            if (inRange) {
                priceMarkerLine.style.display = 'block';
                priceMarkerLine.style.color = color;
                priceMarkerLine.style.top = (plotTop + yRel) + 'px';
                priceMarkerLine.style.left = (overRect.left - rootRect.left) + 'px';
                priceMarkerLine.style.width = overRect.width + 'px';
            } else {
                priceMarkerLine.style.display = 'none';
            }
        }
        function currentYRange(chart) {
            const s = chart.scales.y || {};
            let min = Number.isFinite(s.min) ? s.min : null;
            let max = Number.isFinite(s.max) ? s.max : null;
            if (min == null || max == null) {
                const vis = visiblePriceRange(chart);
                if (vis) { min = vis[0]; max = vis[1]; }
            }
            if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
            return { min: min, max: max };
        }
        let priceBounds = null;
        function computePriceBounds() {
            let min = Infinity;
            let max = -Infinity;
            for (let i = 0; i < currentCandles.length; i++) {
                const lo = currentLow[i];
                const hi = currentHigh[i];
                if (Number.isFinite(lo) && lo > 0 && lo < min) min = lo;
                if (Number.isFinite(hi) && hi > max) max = hi;
            }
            if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
                priceBounds = null;
                return;
            }
            const range = max - min;
            // Uloszoomauksen rajat: alin naytettava hinta voi painua viimeistaan
            // ~35 % datan minimin alapuolelle, ylin ~1.6x datan maksimin, ja
            // kokonaisvali saa olla enintaan ~1.6x datan hintahaarukasta —
            // ei siis paase "lipsahtamaan" candleita nakyvasta kadottaen.
            priceBounds = { min: min, max: max, floor: min * 0.35, ceil: max * 1.6, maxSpan: range * 1.6 };
        }
        function applyYRange(chart, min, max) {
            if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return false;
            const ref = Math.max(Math.abs(min), Math.abs(max), 1e-12);
            if (max - min < ref * 1e-9) return false;
            if (currentPriceScale === 'log' && min <= 0) {
                min = max > 0 ? max * 1e-6 : 1e-6;
                if (max <= min) return false;
            }
            if (priceBounds) {
                let nMin = Math.max(min, priceBounds.floor);
                let nMax = Math.min(max, priceBounds.ceil);
                if (nMax - nMin > priceBounds.maxSpan) {
                    const c = (nMin + nMax) / 2;
                    nMin = c - priceBounds.maxSpan / 2;
                    nMax = c + priceBounds.maxSpan / 2;
                    nMin = Math.max(nMin, priceBounds.floor);
                    nMax = Math.min(nMax, priceBounds.ceil);
                }
                if (nMax <= nMin) return false;
                min = nMin;
                max = nMax;
            }
            manualYRange = { min: min, max: max };
            chart.setScale('y', { min: min, max: max });
            return true;
        }
        function zoomYAt(chart, centerY, factor) {
            const r = currentYRange(chart);
            if (!r) return;
            const span = r.max - r.min;
            let ratio = (centerY - r.min) / span;
            if (!Number.isFinite(ratio)) ratio = 0.5;
            ratio = Math.max(0.05, Math.min(0.95, ratio));
            const nextSpan = span * factor;
            const nextMin = centerY - nextSpan * ratio;
            applyYRange(chart, nextMin, nextMin + nextSpan);
        }
        function bindWheelZoom(chart) {
            chart.root.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                e.preventDefault();
                const rect = chart.root.getBoundingClientRect();
                if (chart === priceChart && inYAxisZone(chart, e.clientX)) {
                    const centerY = chart.posToVal(e.clientY - rect.top, 'y');
                    zoomYAt(chart, centerY, e.deltaY < 0 ? 0.91 : 1.10);
                    return;
                }
                const center = chart.posToVal(e.clientX - rect.left, 'x');
                const s = chart.scales.x || {};
                const currMin = Number.isFinite(s.min) ? s.min : currentCandles[0].time;
                const currMax = Number.isFinite(s.max) ? s.max : currentCandles[currentCandles.length - 1].time;
                const span = currMax - currMin;
                const first = currentCandles[0]?.time;
                const last = currentCandles[currentCandles.length - 1]?.time;
                const fullSpan = Number.isFinite(first) && Number.isFinite(last) ? Math.max(1, last - first) : span;
                if (!Number.isFinite(span) || span <= 0) return;
                const factor = e.deltaY < 0 ? 0.85 : 1.15;
                // Uloszoomaus datan reunojen yli: kokonaisnakyyma enintaan 2.5x datan pituus
                const maxSpan = Number.isFinite(fullSpan) ? fullSpan * 2.5 : span;
                const nextSpan = Math.max(1, Math.min(maxSpan, span * factor));
                const ratio = (center - currMin) / span;
                syncXRange(center - nextSpan * ratio, center - nextSpan * ratio + nextSpan);
            }, { passive: false });
        }
        function bindPan(chart) {
            let dragging = false;
            let startClientX = 0;
            let startClientY = 0;
            let startMin = 0;
            let startMax = 0;
            let startYRange = null;
            const onMove = (e) => {
                if (!dragging) return;
                e.preventDefault();
                const rect = chart.root.getBoundingClientRect();
                const delta = chart.posToVal(e.clientX - rect.left, 'x') - chart.posToVal(startClientX - rect.left, 'x');
                // Pystysuuntainen siirto hinta-chartissa: hintaskaala seuraa hiirta
                // (aktivoi manuaalisen skaalan; kaksoisklikkaus akselilla palauttaa autofitin)
                if (chart === priceChart && startYRange && Number.isFinite(e.clientY)) {
                    const vStart = chart.posToVal(startClientY - rect.top, 'y');
                    const vCur = chart.posToVal(e.clientY - rect.top, 'y');
                    if (Number.isFinite(vStart) && Number.isFinite(vCur) && vCur !== vStart) {
                        if (currentPriceScale === 'log') {
                            const ratio = Math.max(1e-12, vStart) / Math.max(1e-12, vCur);
                            if (Number.isFinite(ratio) && ratio > 0) {
                                applyYRange(chart, startYRange.min * ratio, startYRange.max * ratio);
                            }
                        } else {
                            const dy = vStart - vCur;
                            if (Number.isFinite(dy)) {
                                applyYRange(chart, startYRange.min + dy, startYRange.max + dy);
                            }
                        }
                    }
                }
                syncXRange(startMin - delta, startMax - delta);
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                startYRange = null;
                document.body.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', endDrag);
            };
            chart.root.addEventListener('mousedown', (e) => {
                if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
                const rect = chart.root.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                if (chart === priceChart && inYAxisZone(chart, e.clientX)) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startClientX = e.clientX;
                startClientY = e.clientY;
                const s = chart.scales.x || {};
                startMin = Number.isFinite(s.min) ? s.min : currentCandles[0].time;
                startMax = Number.isFinite(s.max) ? s.max : currentCandles[currentCandles.length - 1].time;
                if (chart === priceChart) startYRange = currentYRange(chart);
                document.body.style.cursor = 'grabbing';
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            });
        }
        function bindYAxisDrag(chart) {
            let dragging = false;
            let startClientY = 0;
            let startRange = null;
            const onMove = (e) => {
                if (!dragging || !startRange) return;
                e.preventDefault();
                const deltaPx = e.clientY - startClientY;
                if (!Number.isFinite(deltaPx) || deltaPx === 0) return;
                const factor = Math.exp(deltaPx / 350);
                const span = startRange.max - startRange.min;
                const center = (startRange.min + startRange.max) / 2;
                const nextSpan = span * factor;
                applyYRange(chart, center - nextSpan / 2, center + nextSpan / 2);
            };
            const endDrag = () => {
                if (!dragging) return;
                dragging = false;
                startRange = null;
                document.body.style.cursor = '';
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', endDrag);
            };
            chart.root.addEventListener('mousedown', (e) => {
                if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
                const rect = chart.root.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
                if (chart !== priceChart || !inYAxisZone(chart, e.clientX)) return;
                const range = currentYRange(chart);
                if (!range) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startClientY = e.clientY;
                startRange = range;
                document.body.style.cursor = 'ns-resize';
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', endDrag, { once: true });
            });
        }
        function bindYAxisReset(chart) {
            chart.root.addEventListener('dblclick', (e) => {
                if (chart !== priceChart || !inYAxisZone(chart, e.clientX)) return;
                manualYRange = null;
                const vis = visiblePriceRange(chart);
                if (vis) chart.setScale('y', { min: vis[0], max: vis[1] });
            });
        }
        function refreshLegend() {
            updateLegend(Math.max(0, currentCandles.length - 1));
        }
        function setControls() {
            setActivePairMode(currentPairMode);
            setActivePriceScale(currentPriceScale);
            document.getElementById('sma-toggle').checked = currentSmaEnabled;
            document.getElementById('sma-period').value = String(currentSmaPeriod);
            document.getElementById('ama-toggle').checked = currentAmaEnabled;
            document.getElementById('ama-er').value = String(currentAmaErPeriod);
            document.getElementById('ama-fast').value = currentAmaFastPeriod.toFixed(1);
            document.getElementById('ama-slow').value = currentAmaSlowPeriod.toFixed(1);
            document.getElementById('vwap-toggle').checked = currentVwapEnabled;
            document.getElementById('vwap-bars').value = String(currentVwapBars);
            document.getElementById('ama-init-offset-toggle').checked = currentAmaInitOffsetEnabled;
            document.getElementById('ama-init-offset').value = String(currentAmaInitOffset);
            document.getElementById('ama-init-offset').disabled = !currentAmaInitOffsetEnabled;
            document.getElementById('ama-init-offset-val').textContent = currentAmaInitOffset + '%';
            setActiveTimeframe(currentTimeframe);
            refreshSubtitle();
        }
        function rerender(keepRange = true) {
            const oldRange = keepRange && priceChart ? priceChart.scales.x : null;
            const needsRebuild = !priceChart || !volumeChart || lastRenderedPriceScale !== currentPriceScale;
            if (needsRebuild) {
                manualYRange = null;
                priceMarkerLabel = null;
                priceMarkerLine = null;
                if (priceEl) priceEl.innerHTML = '';
                if (volumeEl) volumeEl.innerHTML = '';
                priceChart = null;
                volumeChart = null;
                charts = [];
                chartEventsBound = false;
            }
            const data = buildData();
            computePriceBounds();
            if (needsRebuild) {
                makeChart();
            } else {
                priceChart.setData(data.priceData, false);
                volumeChart.setData(data.volumeData, false);
            }
            syncIndicatorSeriesVisibility();
            if (!priceChart || !volumeChart) return;
            if (!chartEventsBound) {
                charts.forEach((chart) => {
                    bindWheelZoom(chart);
                    bindPan(chart);
                    if (chart === priceChart) {
                        bindYAxisDrag(chart);
                        bindYAxisReset(chart);
                        chart.root.addEventListener('mousemove', (e) => {
                            chart.root.style.cursor = inYAxisZone(chart, e.clientX) ? 'ns-resize' : '';
                        });
                    }
                    chart.over.addEventListener('mousemove', () => {
                        if (chart.cursor.idx != null) updateLegend(chart.cursor.idx);
                    });
                    chart.over.addEventListener('mouseleave', refreshLegend);
                    chart.root.addEventListener('mouseenter', () => chart.root.classList.add('is-hovered'));
                    chart.root.addEventListener('mouseleave', () => chart.root.classList.remove('is-hovered'));
                });
                chartEventsBound = true;
            }
            if (oldRange && Number.isFinite(oldRange.min) && Number.isFinite(oldRange.max)) {
                const next = clampRange(oldRange.min, oldRange.max);
                if (next) charts.forEach((chart) => chart.batch(() => chart.setScale('x', next)));
            }
            refreshLegend();
            saveState();
        }

        setControls();
        rerender(false);

        document.querySelectorAll('.time-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                const label = btn.dataset.timeframe;
                if (!label || label === currentTimeframe) return;
                currentTimeframe = label;
                setActiveTimeframe(label);
                rerender(true);
            });
        });

        const scaleToggle = document.getElementById('scale-toggle');
        if (scaleToggle) {
            scaleToggle.addEventListener('click', () => {
                currentPriceScale = currentPriceScale === 'linear' ? 'log' : 'linear';
                setActivePriceScale(currentPriceScale);
                rerender(false);
            });
        }
        const pairToggle = document.getElementById('pair-toggle');
        if (pairToggle) {
            pairToggle.addEventListener('click', () => {
                currentPairMode = currentPairMode === 'inverse' ? 'normal' : 'inverse';
                manualYRange = null;
                setControls();
                rerender(true);
            });
        }

        const syncInputs = () => {
            currentSmaEnabled = document.getElementById('sma-toggle').checked;
            currentSmaPeriod = clamp(Math.round(Number(document.getElementById('sma-period').value) || 20), 1, 9999);
            currentAmaEnabled = document.getElementById('ama-toggle').checked;
            currentAmaErPeriod = clamp(Math.round(Number(document.getElementById('ama-er').value) || ${MARKET_ADAPTER.AMAS.AMA3.erPeriod}), 1, 999999);
            currentAmaFastPeriod = Math.round(clamp(Number(document.getElementById('ama-fast').value) || Number(payload.amaDefaults?.fastPeriod || ${MARKET_ADAPTER.AMAS.AMA3.fastPeriod}), 0.1, 999999) * 10) / 10;
            currentAmaSlowPeriod = Math.round(clamp(Number(document.getElementById('ama-slow').value) || Number(payload.amaDefaults?.slowPeriod || ${MARKET_ADAPTER.AMAS.AMA3.slowPeriod}), 0.1, 999999) * 10) / 10;
            currentAmaInitOffsetEnabled = document.getElementById('ama-init-offset-toggle').checked;
            currentAmaInitOffset = currentAmaInitOffsetEnabled ? snapInitOffset(document.getElementById('ama-init-offset').value) : 0;
            document.getElementById('ama-init-offset').value = String(currentAmaInitOffset);
            document.getElementById('ama-init-offset').disabled = !currentAmaInitOffsetEnabled;
            document.getElementById('ama-init-offset-val').textContent = currentAmaInitOffset + '%';
            currentVwapEnabled = document.getElementById('vwap-toggle').checked;
            currentVwapBars = clamp(Math.round(Number(document.getElementById('vwap-bars').value) || 500), 24, 2000);
            setControls();
            rerender(false);
        };

        document.getElementById('sma-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('sma-toggle').checked;
            if (currentSmaEnabled === nextEnabled) return;
            currentSmaEnabled = nextEnabled;
            setControls();
            if (!currentSmaEnabled) {
                hideSmaSeriesImmediate();
                return;
            }
            rerender(false);
        });
        document.getElementById('ama-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('ama-toggle').checked;
            if (currentAmaEnabled === nextEnabled) return;
            currentAmaEnabled = nextEnabled;
            setControls();
            if (!currentAmaEnabled) {
                hideAmaSeriesImmediate();
                return;
            }
            rerender(false);
        });
        document.getElementById('vwap-toggle').addEventListener('change', () => {
            const nextEnabled = document.getElementById('vwap-toggle').checked;
            if (currentVwapEnabled === nextEnabled) return;
            currentVwapEnabled = nextEnabled;
            setControls();
            if (!currentVwapEnabled) {
                hideVwapSeriesImmediate();
                return;
            }
            rerender(false);
        });
        document.getElementById('ama-init-offset-toggle').addEventListener('change', syncInputs);
        ['sma-period', 'ama-er', 'ama-fast', 'ama-slow', 'vwap-bars'].forEach((id) => {
            document.getElementById(id).addEventListener('change', syncInputs);
            document.getElementById(id).addEventListener('blur', syncInputs);
        });
        ['ama-er'].forEach((id) => {
            document.getElementById(id).addEventListener('input', syncInputs);
        });
        function makeStepper(id, step, lo, precision) {
            const dec = document.getElementById(id + '-dec');
            const inc = document.getElementById(id + '-inc');
            if (!dec || !inc) return;
            const input = document.getElementById(id);
            function stepVal(dir) {
                const val = parseFloat(input.value) || 0;
                let next = dir < 0 ? Math.max(lo, val - step) : val + step;
                if (precision === 0) next = Math.round(next);
                else if (precision > 0) next = Math.round(next * Math.pow(10, precision)) / Math.pow(10, precision);
                input.value = precision >= 0 ? next.toFixed(precision) : String(next);
                syncInputs();
            }
            function addHold(el, dir) {
                let timer = null;
                function start() {
                    stepVal(dir);
                    timer = setTimeout(() => {
                        timer = setInterval(() => stepVal(dir), 100);
                    }, 300);
                }
                function stop() {
                    if (timer) { clearInterval(timer); clearTimeout(timer); timer = null; }
                }
                el.addEventListener('mousedown', start);
                el.addEventListener('mouseup', stop);
                el.addEventListener('mouseleave', stop);
            }
            addHold(dec, -1);
            addHold(inc, 1);
        }
        makeStepper('sma-period', 1, 1, 0);
        makeStepper('vwap-bars', 1, 24, 0);
        makeStepper('ama-er', 1, 1, 0);
        makeStepper('ama-fast', 0.1, 0.1, 1);
        makeStepper('ama-slow', 1, 0.1, 1);
        document.getElementById('ama-reset').addEventListener('click', resetAmaDefaults);
        document.getElementById('ama-init-offset').addEventListener('input', () => {
            const input = document.getElementById('ama-init-offset');
            const snapped = snapInitOffset(input.value);
            if (String(snapped) !== String(input.value)) input.value = String(snapped);
            document.getElementById('ama-init-offset-val').textContent = snapped + '%';
            syncInputs();
        });

        window.addEventListener('resize', () => {
            if (!charts.length) return;
            charts.forEach((chart) => {
                const el = chart === priceChart ? priceEl : volumeEl;
                chart.setSize({ width: el.clientWidth, height: el.clientHeight });
            });
        });

        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === '0' && charts.length) {
                const first = currentCandles[0]?.time;
                const last = currentCandles[currentCandles.length - 1]?.time;
                if (Number.isFinite(first) && Number.isFinite(last)) syncXRange(first, last);
            }
        });
    })();
    </script>
</body>
</html>`;
}

export { generateHTML, normalizeCandle, loadMarketProfiles }

