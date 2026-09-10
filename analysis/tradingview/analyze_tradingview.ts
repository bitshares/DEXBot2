#!/usr/bin/env node
'use strict';


import fs from 'node:fs';
import path from 'node:path';
import { generateHTML } from './tradingview_uplot_chart_generator.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { loadCandleFile } from '../math_utils.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { toIntervalLabel } from '../../market_adapter/interval_utils.js';
import { loadBotMeta } from '../bot_key_utils.js';
import { resolveSource, listAvailableBots } from '../resolve_source.js';
import { writeChartFile, toFileUrl } from '../chart_utils.js';
import { PATHS } from '../../modules/paths.js';
import { isDeepShelfId } from '../../modules/order/utils/math.js';


const DEFAULT_CHART_DIR = PATHS.ANALYSIS.CHARTS_DIR;
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'tradingview_chart.html');
const DEFAULT_AMA = MARKET_ADAPTER.AMAS.AMA3;
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: { filePath: any; botKey?: any } };
        chartFile: string;
        title: string | null;
        priceScale: string;
        smaPeriod: number;
        amaErPeriod: number | undefined;
        amaFastPeriod: number | undefined;
        amaSlowPeriod: number | undefined;
        smaEnabled: boolean;
        amaEnabled: boolean;
        vwapEnabled: boolean;
        vwapBars: number;
        rangeEnabled: boolean;
        rangeScaleEnabled: boolean;
        rangeSpan: number | undefined;
        ordersFile: string | null;
        noOrders: boolean;
        updateMarkerTsSec: number | null;
        updateMarkerNewBars: number | null;
        quiet: boolean;
        listBots: boolean;
    } = {
        source: { type: 'market_adapter', config: { botKey: '', filePath: undefined as any } },
        chartFile: DEFAULT_CHART_FILE,
        title: null,
        priceScale: 'log',
        smaPeriod: 500,
        amaErPeriod: undefined,
        amaFastPeriod: undefined,
        amaSlowPeriod: undefined,
        smaEnabled: false,
        amaEnabled: true,
        vwapEnabled: false,
        vwapBars: 500,
        rangeEnabled: false,
        rangeScaleEnabled: false,
        rangeSpan: undefined,
        ordersFile: null,
        noOrders: false,
        updateMarkerTsSec: null,
        updateMarkerNewBars: null,
        quiet: false,
        listBots: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--source') config.source.type = String(args[++i] || 'json');
        else if (arg === '--file') {
            config.source.type = 'json';
            config.source.config.filePath = args[++i];
        }
        else if (arg === '--bot-key') config.source.config.botKey = args[++i];
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--title') config.title = args[++i];
        else if (arg === '--price-scale' || arg === '--scale') config.priceScale = String(args[++i] || 'log');
        else if (arg === '--sma-period') config.smaPeriod = Math.max(1, parseInt(args[++i], 10) || 500);
        else if (arg === '--ama-er-period') config.amaErPeriod = Math.max(1, parseInt(args[++i], 10) || DEFAULT_AMA.erPeriod);
        else if (arg === '--ama-fast-period') config.amaFastPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.fastPeriod);
        else if (arg === '--ama-slow-period') config.amaSlowPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.slowPeriod);
        else if (arg === '--no-sma') config.smaEnabled = false;
        else if (arg === '--no-ama') config.amaEnabled = false;
        else if (arg === '--no-vwap') config.vwapEnabled = false;
        else if (arg === '--vwap-bars') config.vwapBars = Math.max(5, parseInt(args[++i], 10) || 500);
        else if (arg === '--range') config.rangeEnabled = true;
        else if (arg === '--no-range') config.rangeEnabled = false;
        else if (arg === '--range-scale') config.rangeScaleEnabled = true;
        else if (arg === '--range-span') config.rangeSpan = parseFloat(args[++i]);
        else if (arg === '--orders-file') config.ordersFile = String(args[++i] || '');
        else if (arg === '--no-orders') config.noOrders = true;
        else if (arg === '--update-marker-ts') config.updateMarkerTsSec = Math.max(0, parseInt(args[++i], 10) || 0) || null;
        else if (arg === '--update-marker-bars') config.updateMarkerNewBars = Math.max(0, parseInt(args[++i], 10) || 0) || null;
        else if (arg === '--list-bots') config.listBots = true;
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function loadJsonMeta(filePath: any) {
    if (!filePath || !fs.existsSync(filePath)) return { meta: null, candles: null };
    return loadCandleFile(filePath);
}

// ── Order overlay: active grid orders (buys/sells) + grid LO factor ──
// Canonical source is profiles/orders/<botKey>.json (same files
// scripts/analyze-orders.ts reads); --orders-file overrides, --no-orders
// disables. Pool/pair charts without a bot key render without overlay,
// silently — no hardcoded personal paths.
function resolveOrdersFile(botKey: string | null | undefined, explicit: string | null | undefined, disabled: boolean): string | null {
    if (disabled) return null;
    if (explicit) {
        try { if (explicit && fs.existsSync(explicit)) return explicit; } catch { /* fall through */ }
        return null;
    }
    if (!botKey) return null;
    try {
        const ordersDir = (PATHS as any).ORDERS_DIR || path.join(path.dirname(PATHS.PROFILES.BOTS_JSON), 'orders');
        const direct = path.join(ordersDir, `${botKey}.json`);
        if (fs.existsSync(direct)) return direct;
    } catch { /* silent when absent */ }
    return null;
}

function loadActiveOrders(filePath: string | null): { buys: number[]; sells: number[]; deepBuys: number[] } {
    if (!filePath) return { buys: [], sells: [], deepBuys: [] };
    try {
        const od = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const grid = Array.isArray(od?.grid) ? od.grid : (Array.isArray(od?.orders) ? od.orders : []);
        const live = (s: any) => (s?.state === 'active' || s?.state === 'partial') && Number(s?.price) > 0;
        const buys = grid.filter((s: any) => s?.type === 'buy' && live(s)).map((s: any) => Number(s.price)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
        const sells = grid.filter((s: any) => s?.type === 'sell' && live(s)).map((s: any) => Number(s.price)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
        // Deep shelf: dip-insurance buys above the reserve floor (canonical id scheme).
        const deepBuys = grid.filter((s: any) => s?.type === 'buy' && live(s) && isDeepShelfId(s?.id)).map((s: any) => Number(s.price)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
        return { buys, sells, deepBuys };
    } catch { return { buys: [], sells: [], deepBuys: [] }; }
}

// Grid LO factor from bot minPrice ("1.15x" -> 1/1.15). Fallback 0.87
// (matches the pre-refactor personal overlay default).
function resolveGridLo(botMeta: any): number {
    try {
        const mp = botMeta?.minPrice;
        if (typeof mp === 'string' && mp.trim().toLowerCase().endsWith('x')) {
            const n = parseFloat(mp);
            if (Number.isFinite(n) && n > 0) return 1 / n;
        }
    } catch { /* fallback below */ }
    return 0.87;
}

function inferTitle(meta: any, fallback: string) {
    const pool = meta?.pool ? `Pool ${String(meta.pool).replace(/^1\.19\./, '')}` : null;
    const a = meta?.assetA?.symbol || meta?.assetA?.id || null;
    const b = meta?.assetB?.symbol || meta?.assetB?.id || null;
    const pair = a && b ? `${a}/${b}` : fallback;
    const label = pool || pair;
    const interval = Number(meta?.intervalSeconds) > 0 ? toIntervalLabel(meta.intervalSeconds) : '1h';
    return `${label} · ${interval} · TradingView`;
}

async function main() {
    try {
        const config = parseArgs();

        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source, botKey, amaConfig } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        if (!config.quiet) console.log(`[TradingView] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const isJsonSource = config.source.type === 'json';
        const filePath = config.source.config.filePath;
        const rawJson = isJsonSource ? loadJsonMeta(filePath) : { meta: null, candles: null };
        const botMeta = botKey ? loadBotMeta(botKey) : null;
        const jsonMeta = rawJson.meta || (botMeta ? {
            assetA: { symbol: botMeta.assetA },
            assetB: { symbol: botMeta.assetB },
            intervalSeconds: 3600,
        } : null);
        const title = config.title || inferTitle(jsonMeta, path.basename(filePath || 'tradingview'));
        const hasAmaGridPrice = AMA_KEYWORDS.has(String(botMeta?.gridPrice || '').trim().toLowerCase());
        const amaEnabled = hasAmaGridPrice ? config.amaEnabled : false;

        // Bot grid bounds for the range highlight: mirrors the runtime grid
        // (center = AMA, min "Nx" = center/N, max "Nx" = center*N) with the
        // live asymmetric tilt. Null when no bot key (width% fallback in-page).
        const grid = botMeta?.minPrice != null && botMeta?.maxPrice != null ? {
            minPrice: botMeta.minPrice,
            maxPrice: botMeta.maxPrice,
            incrementPercent: Number(botMeta.incrementPercent) > 0 ? Number(botMeta.incrementPercent) : null,
            maxAsymmetryFactor: Number.isFinite(Number(botMeta?.asymmetricBounds?.maxAsymmetryFactor))
                ? Number(botMeta.asymmetricBounds.maxAsymmetryFactor)
                : null,
            minScaleSlots: Number.isFinite(Number(botMeta?.asymmetricBounds?.minScaleSlots))
                ? Number(botMeta.asymmetricBounds.minScaleSlots)
                : null,
        } : null;
        // Order overlay (canonical profiles/orders/<botKey>.json; silent when absent)
        const ordersFile = resolveOrdersFile(botKey, config.ordersFile, config.noOrders);
        const { buys: orderBuys, sells: orderSells, deepBuys: orderDeepBuys } = loadActiveOrders(ordersFile);
        const gridLo = resolveGridLo(botMeta);
        if (!config.quiet && ordersFile) console.log(`[TradingView] Order overlay: ${orderBuys.length} buys + ${orderSells.length} sells + ${orderDeepBuys.length} deep from ${ordersFile}`);
        const html = generateHTML({
            candles,
            meta: jsonMeta || {
                assetA: { symbol: 'Asset A' },
                assetB: { symbol: 'Asset B' },
            },
            smaPeriod: config.smaPeriod,
            amaDefaults: {
                erPeriod: config.amaErPeriod ?? amaConfig.erPeriod,
                fastPeriod: config.amaFastPeriod ?? amaConfig.fastPeriod,
                slowPeriod: config.amaSlowPeriod ?? amaConfig.slowPeriod,
            },
            smaEnabled: config.smaEnabled,
            amaEnabled,
            vwapEnabled: config.vwapEnabled,
            vwapBars: config.vwapBars,
            rangeEnabled: config.rangeEnabled,
            rangeScaleEnabled: config.rangeScaleEnabled,
            rangeSpan: config.rangeSpan,
            grid,
            priceScale: config.priceScale === 'linear' ? 'linear' : 'log',
            defaultTimeframe: '1h',
            marketAdapter: MARKET_ADAPTER,
            orders: { buys: orderBuys, sells: orderSells, deepBuys: orderDeepBuys },
            gridLo,
            // Update marker ("updated from here" line): explicit CLI flags win,
            // otherwise fall back to stamped data-file meta when present.
            updateMarkerTsSec: config.updateMarkerTsSec
                ?? (Number((jsonMeta as any)?.prevUpdateLastCandleSec) > 0 ? Number((jsonMeta as any).prevUpdateLastCandleSec) : null),
            updateMarkerNewBars: config.updateMarkerNewBars
                ?? (Number((jsonMeta as any)?.prevUpdateNewBars) || null),
        }, title);

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(`\n[TradingView] ✓ Chart saved. Open chart: (${toFileUrl(config.chartFile)})`);
    } catch (err: any) {
        console.error(`[TradingView] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

export { main, parseArgs, loadJsonMeta, inferTitle }
