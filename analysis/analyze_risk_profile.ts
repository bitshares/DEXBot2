#!/usr/bin/env node
'use strict';
/**
 * RISK PROFILE ANALYZER
 *
 * Unified utility to measure historical inventory drift (divergence quantiles
 * and max divergence) to characterize risk bounds and establish safe ranges.
 *
 * Also computes the empirical standard deviation of per-bar AMA movement
 * (σ_ama_delta) for calibrating AMA_DELTA_THRESHOLD_PERCENT.
 *
 * Usage:
 *   node dist/analysis/analyze_risk_profile.js --source market_adapter --bot-key <key> [options]
 *   node dist/analysis/analyze_risk_profile.js --file <path_to_json> [options]
 */
import { getErrorMessage } from '../modules/utils/errors.js';
import { calculateAMA } from '../market_adapter/core/strategies/ama.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { generateHTML } from '../market_adapter/lp_chart_core.js';
import { calcStdDev, getCandleClose } from './math_utils.js';
import { writeChartFile } from './chart_utils.js';
import { resolveSource, listAvailableBots, type SourceConfig } from './resolve_source.js';
import { baseAnalysisConfig, consumeCommonAnalysisArg } from './analyze_args.js';


function normSInv(p: number) {
    if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
    const p_low = 0.02425;
    const p_high = 1 - p_low;
    if (p < p_low) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= p_high) {
        const q = p - 0.5;
        const r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
    }
}

function quantileToSigma(q: number) {
    return normSInv((1 + q) / 2);
}

function getAmaDeltaStdDev(closes: number[], amaConfig: unknown, warmup: number) {
    const amaValues = calculateAMA(closes, amaConfig as { erPeriod: number; fastPeriod: number; slowPeriod: number });
    const deltas: number[] = [];
    for (let i = warmup + 1; i < closes.length; i++) {
        const prev = amaValues[i - 1];
        const cur = amaValues[i];
        if (!prev || !cur) continue;
        deltas.push((cur - prev) / prev);
    }
    return deltas.length ? calcStdDev(deltas) : null;
}

function getDivergenceDist(closes: number[], amaConfig: unknown) {
    const amaValues = calculateAMA(closes, amaConfig as { erPeriod: number; fastPeriod: number; slowPeriod: number });
    const dists: number[] = [];
    for (let i = 1600; i < closes.length; i++) {
        const ama = amaValues[i];
        if (!ama) continue;
        dists.push(Math.abs(closes[i] - ama) / ama);
    }
    return dists.sort((a, b) => a - b);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: SourceConfig };
        ama: string;
        output: string | null;
        quiet: boolean;
        listBots: boolean;
    } = {
        ...baseAnalysisConfig(),
        ama: 'AMA3',
        output: null,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (consumeCommonAnalysisArg(arg, () => args[++i], config)) continue;
        if (arg === '--ama') config.ama = args[++i];
        else if (arg === '--output') config.output = args[++i];
    }

    return config;
}

async function main() {
    try {
        const config = parseArgs();

        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source, botKey } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        if (!config.quiet) console.log(`[RiskProfile] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const closes = candles.map(c => getCandleClose(c) ?? Number(c?.[4] ?? 0));
        const warmup = 1600;
        const presets = ['AMA1', 'AMA2', 'AMA3', 'AMA4'];
        const quantiles = [0.999, 0.9999, 0.99999];

        if (!config.quiet) console.log(`[RiskProfile] Analyzing ${closes.length} candles from ${source.name}`);
        const sigmaLabels = quantiles.map(q => `${(q * 100).toFixed(3)}% — ${quantileToSigma(q).toFixed(2)}σ`);
        console.log('Preset, Max_Divergence(x), ' + sigmaLabels.map((l, i) => `${l} (${['Soft','Hard','Emergency'][i]})`).join(', '));

        presets.forEach(name => {
            const cfg = MARKET_ADAPTER.AMAS[name as keyof typeof MARKET_ADAPTER.AMAS];
            const allDists = getDivergenceDist(closes, cfg);

            if (allDists.length === 0) {
                console.log(`${name}, N/A, N/A, N/A, N/A`);
                return;
            }
            const maxDist = allDists[allDists.length - 1];
            const meanDist = allDists.reduce((a, b) => a + b, 0) / allDists.length;
            const stdDist = calcStdDev(allDists);
            const amaDeltaSigma = getAmaDeltaStdDev(closes, cfg, warmup);
            const quantileResults = quantiles.map(q => {
                const val = allDists[Math.min(Math.floor(allDists.length * q), allDists.length - 1)];
                const sigma = quantileToSigma(q);
                const empSigma = (val - meanDist) / stdDist;
                return `${(1 + val).toFixed(3)}x (${sigma.toFixed(2)}σt, ${empSigma.toFixed(2)}σe)`;
            });
            console.log(`${name}, ${(1 + maxDist).toFixed(3)}x, ${quantileResults.join(', ')}`);
            console.log(`  σ_div: ${(stdDist * 100).toFixed(3)}% | mean_div: ${(meanDist * 100).toFixed(3)}% | σ_ama_delta: ${amaDeltaSigma !== null ? (amaDeltaSigma * 100).toFixed(3) : 'N/A'}%`);
        });

        if (config.output) {
            if (!MARKET_ADAPTER.AMAS[config.ama as keyof typeof MARKET_ADAPTER.AMAS]) {
                console.error(`Invalid AMA preset for output: ${config.ama}. Choose from: ${Object.keys(MARKET_ADAPTER.AMAS).join(', ')}`);
                process.exit(1);
            }

            const amaCfg = MARKET_ADAPTER.AMAS[config.ama as keyof typeof MARKET_ADAPTER.AMAS];
            const amaValues = calculateAMA(closes, amaCfg);
            const candleArrays = candles.map(c => [c?.timestamp ?? c?.[0] ?? 0, c?.open ?? c?.[1] ?? 0, c?.high ?? c?.[2] ?? 0, c?.low ?? c?.[3] ?? 0, c?.close ?? c?.[4] ?? 0, c?.volume ?? c?.[5] ?? 0]);

            const allDists = getDivergenceDist(closes, amaCfg);
            const amaDeltaSigma = getAmaDeltaStdDev(closes, amaCfg, warmup);
            const thresholds = quantiles.map(q => {
                const val = allDists[Math.min(Math.floor(allDists.length * q), allDists.length - 1)];
                return { quantile: q, multiplier: (1 + val).toFixed(3) };
            });
            const amaResult = {
                name: config.ama,
                values: amaValues,
                color: '#e3b341',
                lineWidth: 2,
                erPeriod: amaCfg.erPeriod,
                fastPeriod: amaCfg.fastPeriod,
                slowPeriod: amaCfg.slowPeriod
            };

            const pairName = botKey || 'Market';
            const meta = {
                pool: `${pairName} ${config.ama} Risk Analysis`,
                assetA: { symbol: 'Base' },
                assetB: { symbol: 'Quote' },
                intervalSeconds: candles.length > 1 ? (Number(candles[1]?.timestamp ?? candles[1]?.[0] ?? 0) - Number(candles[0]?.timestamp ?? candles[0]?.[0] ?? 0)) / 1000 : 3600,
                thresholds: thresholds,
                sigmaAmaDelta: amaDeltaSigma !== null ? +((amaDeltaSigma * 100).toFixed(3)) : null
            };

            const html = generateHTML(meta, candleArrays, [amaResult]);
            writeChartFile(config.output, html);
            console.log(`\n[RiskProfile] ✓ Risk report generated: ${config.output}`);
        }
    } catch (err) {
        console.error(`[RiskProfile] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
