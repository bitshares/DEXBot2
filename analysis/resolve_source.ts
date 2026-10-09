'use strict';

import path from 'node:path';
import { PATHS } from '../modules/paths.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { createSource } from './price_sources.js';
import { resolveCandleFile, resolveAmaConfig, resolveAmaKey, loadBotSettings, computeBotKey } from './bot_key_utils.js';
import { loadLatestLpSeries, loadLpSeriesFromPath } from '../market_adapter/utils/data_discovery.js';
import { loadCandleFile } from './math_utils.js';

const INTERVAL_LABEL = MARKET_ADAPTER.RUNTIME_DEFAULTS.intervalLabel;

interface SourceConfig {
    type?: string;
    botKey?: string;
    filePath?: string;
    stateDir?: string;
}

interface SourceResolution {
    source: ReturnType<typeof createSource>;
    botKey?: string;
    amaConfig: { erPeriod: number; fastPeriod: number; slowPeriod: number };
    amaKey: string;
    // Candle-file meta when the source is backed by a JSON file (pool id,
    // asset ids/symbols, intervalSeconds); null for the centers-file fallback.
    meta: Record<string, unknown> | null;
}

function listAvailableBots(): void {
    const settings = loadBotSettings();
    if (!settings?.bots?.length) {
        console.log('No bots found in profiles/bots.json');
        return;
    }
    console.log('Available bot keys:');
    settings.bots.forEach((bot: Record<string, unknown>, i: number) => {
        const key = computeBotKey(bot, i);
        console.log(`  ${key}  (name: ${bot.name})`);
    });
}

function resolveSource(config: SourceConfig, options: { quiet?: boolean } = {}): SourceResolution {
    const { quiet = false } = options;

    if (config.type === 'market_adapter') {
        if (!config.botKey) {
            throw new Error("No --bot-key provided. Use --list-bots to see available keys, or --file to specify a data file directly.");
        }

        const candleFile = resolveCandleFile(config.botKey, INTERVAL_LABEL);
        if (candleFile) {
            if (!quiet) console.log(`[Source] Resolved bot '${config.botKey}' → ${path.basename(candleFile)}`);
            const source = createSource('json', { filePath: candleFile });
            return {
                source,
                botKey: config.botKey,
                amaConfig: resolveAmaConfig(config.botKey),
                amaKey: resolveAmaKey(config.botKey),
                meta: loadCandleFile(candleFile).meta,
            };
        }

        if (!quiet) console.log(`[Source] No candle cache for '${config.botKey}', using centers file`);
        const stateDir = config.stateDir || PATHS.MARKET_ADAPTER.STATE_DIR;
        const source = createSource('market_adapter', { botKey: config.botKey, stateDir });
        return {
            source,
            botKey: config.botKey,
            amaConfig: resolveAmaConfig(config.botKey),
            amaKey: resolveAmaKey(config.botKey),
            meta: null,
        };
    }

    if (config.type === 'json') {
        const filePath = config.filePath;
        if (!filePath) {
            const series = loadLatestLpSeries();
            if (!series) {
                throw new Error('No --file provided and no LP data auto-discovered in market_adapter/data/lp');
            }
            if (!quiet) {
                console.log(`[Source] Auto-discovered LP data: ${series.path}${series.assembled ? ' (assembled from month shards)' : ''}`);
            }
            const source = createSource('inline', {
                candles: series.candles as Record<string, unknown>[],
                meta: series.meta,
                name: series.path,
            });
            if (config.botKey) {
                return { source, botKey: config.botKey, amaConfig: resolveAmaConfig(config.botKey), amaKey: resolveAmaKey(config.botKey), meta: series.meta };
            }
            return { source, amaConfig: resolveAmaConfig(''), amaKey: 'AMA3', meta: series.meta };
        }
        const series = loadLpSeriesFromPath(path.resolve(filePath));
        if (series && series.assembled) {
            if (!quiet) console.log(`[Source] Assembled ${path.basename(filePath)} across month shards`);
            const source = createSource('inline', {
                candles: series.candles as Record<string, unknown>[],
                meta: series.meta,
                name: series.path,
            });
            if (config.botKey) {
                return { source, botKey: config.botKey, amaConfig: resolveAmaConfig(config.botKey), amaKey: resolveAmaKey(config.botKey), meta: series.meta };
            }
            return { source, amaConfig: resolveAmaConfig(''), amaKey: 'AMA3', meta: series.meta };
        }
        const source = createSource('json', { filePath });
        const meta = loadCandleFile(filePath).meta;
        if (config.botKey) {
            return { source, botKey: config.botKey, amaConfig: resolveAmaConfig(config.botKey), amaKey: resolveAmaKey(config.botKey), meta };
        }
        return { source, amaConfig: resolveAmaConfig(''), amaKey: 'AMA3', meta };
    }

    throw new Error(`[Source] Unknown source type: ${config.type}. Use 'market_adapter' or 'json'.`);
}

export { resolveSource, listAvailableBots }
export type { SourceConfig }
