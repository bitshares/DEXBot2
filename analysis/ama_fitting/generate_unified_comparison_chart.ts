'use strict';

import { getErrorMessage } from '../../modules/utils/errors.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateAMA } from '../../market_adapter/core/strategies/ama.js';
import { generateHTML } from '../../market_adapter/lp_chart_core.js';
import { calculateMetrics } from '../../market_adapter/lp_chart_runner.js';
import { loadLatestLpSeries, loadLpSeriesFromPath } from '../../market_adapter/utils/data_discovery.js';
import { toIntervalLabel } from '../../market_adapter/interval_utils.js';
import { loadCandleFile, normalizeCandle } from '../math_utils.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { getStorage } from '../../modules/storage/index.js';
const { ensureDir } = getStorage();
import { PATHS } from '../../modules/paths.js';

/**
 * UNIFIED COMPARISON CHART GENERATOR — Self-contained analysis chart
 *
 * Reads a local LP candle JSON file (any format: flat array, {candles: [...]},
 * or {data: [...]}), computes AMA series, and writes an interactive HTML chart
 * via the shared lp_chart_core renderer.
 *
 * No Kibana fetch. Candle normalization, LP data discovery, and drift metrics
 * are imported from the canonical implementations (math_utils →
 * market_adapter/candle_utils, market_adapter/utils/data_discovery,
 * lp_chart_runner.calculateMetrics) instead of local copies.
 *
 * Usage:
 *   node dist/analysis/ama_fitting/generate_unified_comparison_chart.js --data <file.json>
 *   node dist/analysis/ama_fitting/generate_unified_comparison_chart.js  (auto-discovers newest lp_pool_*.json)
 */



// ── Config ─────────────────────────────────────────────────────────────────────

const CHARTS_DIR = PATHS.ANALYSIS.CHARTS_DIR;

const DEFAULT_COLORS = ['#26a69a', '#fb8c00', '#5c9ee6', '#ef5350'];
const DEFAULT_DASHES = ['dot', 'solid', 'dash', 'dashdot'];

function buildDefaultStrategies() {
    const presets = MARKET_ADAPTER.AMAS as Record<string, typeof MARKET_ADAPTER.AMAS.AMA1>;
    return Object.keys(presets).map((key, i) => ({
        name: presets[key].name || key,
        erPeriod: presets[key].erPeriod,
        fastPeriod: presets[key].fastPeriod,
        slowPeriod: presets[key].slowPeriod,
        color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        dash: DEFAULT_DASHES[i % DEFAULT_DASHES.length],
    }));
}

const DEFAULT_STRATEGIES = buildDefaultStrategies();

// ── Data loading (canonical implementations, no local copies) ────────────────

function normalizeCandleRows(candles: unknown[]) {
    // normalizeCandle is the canonical accessor transform (market_adapter/
    // candle_utils.ts via math_utils re-export); it returns seconds-based time.
    const normalized = candles.map((c: unknown, i: number) => {
        const nc = normalizeCandle(c);
        if (!nc) throw new Error(`Invalid candle at index ${i}`);
        return nc;
    });
    const candleObjects = normalized.map(c => ({
        timestamp: c.time * 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    }));
    const candleArrays = normalized.map(c => [c.time * 1000, c.open, c.high, c.low, c.close, c.volume]);
    return { candleObjects, candleArrays };
}

function loadCandles(dataFile: string) {
    const resolved = path.resolve(dataFile);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

    // Shard-aware: `--data <shard>` yields the whole family, not one month.
    const series = loadLpSeriesFromPath(resolved);
    if (!series || series.candles.length === 0) {
        throw new Error('No candles found in file');
    }
    // Keep loadCandleFile's meta fallback for non-LP `{data:[...]}` shapes that
    // carry fields at the top level rather than under `meta`.
    const meta = series.meta ?? loadCandleFile(resolved).meta;

    return { dataFile: series.path, meta, ...normalizeCandleRows(series.candles) };
}

// ── Output path ────────────────────────────────────────────────────────────────

interface ChartMetaLike {
    intervalSeconds?: unknown;
    pool?: unknown;
    assetA?: unknown;
    assetB?: unknown;
    [key: string]: unknown;
}

function defaultChartPath(meta: ChartMetaLike | null) {
    const intervalSeconds = Number(meta?.intervalSeconds);
    const intervalLabel = Number.isFinite(intervalSeconds) && intervalSeconds > 0
        ? toIntervalLabel(intervalSeconds)
        : '1h';
    const assetA = meta?.assetA as { symbol?: unknown } | undefined;
    const assetB = meta?.assetB as { symbol?: unknown } | undefined;
    const suffix = meta?.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${assetA?.symbol || 'unknown'}_${assetB?.symbol || 'pair'}`;
    return path.join(CHARTS_DIR, `lp_chart_${suffix}_${intervalLabel}_UNIFIED_COMPARISON.html`);
}

// ── Help ───────────────────────────────────────────────────────────────────────

function showHelp() {
    console.log(`
Unified Comparison Chart Generator

Usage:
  node dist/analysis/ama_fitting/generate_unified_comparison_chart.js [options]

Options:
  --data FILE     LP candle export JSON file
  --file FILE     Alias for --data
  --output FILE   Output HTML file
  --quiet         Suppress console output
  --help          Show this help

Notes:
  - If --data is omitted, the newest lp_pool_*.json under market_adapter/data/lp is used.
  - Accepts several candle JSON shapes: flat [[ts,o,h,l,c,v],...], {candles: [...]}, or {data: [...]}.
  - Separate from Kibana fetching — run 'dexbot tv' (or fetch_lp_candles.ts) to pull data first.
`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
    const cfg: { dataFile: string | null; outFile: string | null; quiet: boolean; help: boolean } = {
        dataFile: null,
        outFile: null,
        quiet: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--data' || arg === '--file') && argv[i + 1]) {
            cfg.dataFile = path.resolve(argv[++i]);
        } else if ((arg === '--output' || arg === '--out') && argv[i + 1]) {
            cfg.outFile = path.resolve(argv[++i]);
        } else if (arg === '--quiet') {
            cfg.quiet = true;
        } else if (arg === '--help' || arg === '-h') {
            cfg.help = true;
        }
    }
    return cfg;
}

interface GenerateChartOptions {
    logger?: { log: (...args: unknown[]) => void };
    dataFile?: string | null;
    outFile?: string | null;
    strategies?: typeof DEFAULT_STRATEGIES;
    [key: string]: unknown;
}

function generateChart(options: GenerateChartOptions = {}) {
    const logger = options.logger ?? console;

    // Explicit --data wins; otherwise auto-discover and, when month shards are
    // the newest source, assemble the complete series before charting.
    let dataFile: string;
    let meta: Record<string, unknown> | null;
    let candleObjects: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;
    let candleArrays: number[][];
    if (options.dataFile) {
        ({ dataFile, meta, candleObjects, candleArrays } = loadCandles(options.dataFile));
    } else {
        const series = loadLatestLpSeries();
        if (!series || series.candles.length === 0) {
            throw new Error(`No LP data found. Use --data <path> or run \`dexbot tv\` first.`);
        }
        dataFile = series.path;
        meta = series.meta;
        ({ candleObjects, candleArrays } = normalizeCandleRows(series.candles));
    }

    const strategies = Array.isArray(options.strategies) && options.strategies.length
        ? options.strategies
        : [...DEFAULT_STRATEGIES];

    const closes = candleObjects.map(c => c.close);

    const enrichedMeta = {
        ...(meta || {}),
        assetA: meta?.assetA || { symbol: path.basename(dataFile, '.json') },
        assetB: meta?.assetB || { symbol: '' },
        intervalSeconds: meta?.intervalSeconds || 3600,
        fetchedAt: meta?.fetchedAt || new Date().toISOString(),
    };

    logger.log(`Data:        ${path.relative(process.cwd(), dataFile)} (${candleObjects.length} candles)`);

    const amaResults: Array<Record<string, unknown> & { values: number[] }> = [];
    logger.log('');
    for (const [index, strategy] of strategies.entries()) {
        const values = calculateAMA(closes, strategy);
        const metrics = calculateMetrics(values, candleObjects);
        amaResults.push({ ...strategy, lineWidth: index === 0 ? 2 : 1.5, values });

        logger.log(`${strategy.name}`);
        logger.log(`   ├─ Total Area:     ${metrics.totalDeviation.toFixed(2)}%`);
        logger.log(`   ├─ Max UP:         ${(metrics.maxDriftUp * 100).toFixed(2)}%`);
        logger.log(`   ├─ Max DOWN:       ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        logger.log(`   └─ Band Factor:    ${(metrics.maxDistance * 200).toFixed(2)}%\n`);
    }

    const outFile = options.outFile
        ? path.resolve(options.outFile)
        : defaultChartPath(enrichedMeta);

    logger.log(`Generating chart (${amaResults.length} AMAs)...`);
    const html = generateHTML(enrichedMeta, candleArrays, amaResults);
    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, html, 'utf8');

    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    logger.log(`Open:        file://${outFile}`);

    return { dataFile, outFile, amaResults, meta: enrichedMeta, candleArrays };
}

function run(argv = process.argv.slice(2)) {
    const { dataFile, outFile, quiet, help } = parseArgs(argv);
    if (help) { showHelp(); return; }

    if (!quiet) {
        console.log('════════════════════════════════════════════════');
        console.log(' Unified Comparison Chart Generator');
        console.log('════════════════════════════════════════════════');
        console.log('');
    }

    try {
        generateChart({
            dataFile,
            outFile,
            logger: quiet ? { log() {} } : console,
        });
    } catch (e: unknown) {
        console.error('Error:', getErrorMessage(e));
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run();
}

export { DEFAULT_STRATEGIES, generateChart, parseArgs, run, showHelp }

