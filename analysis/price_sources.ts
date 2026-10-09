'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fillCandleGaps } from '../market_adapter/candle_utils.js';
import { getCandleClose, getCandleTimestamp, loadCandleFile } from './math_utils.js';
import { PATHS } from '../modules/paths.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../modules/utils/errors.js';

/**
 * Price Source Abstraction
 *
 * Unified interface for fetching market prices from multiple sources:
 * - JSON candle files
 * - Market adapter state
 *
 * Each source returns: { marketPrice, timestamp }
 */


interface JsonFileConfig {
    filePath: string;
}

class JsonFileSource {
    filePath: string;
    name: string;

    constructor(config: JsonFileConfig) {
        this.filePath = config.filePath;
        this.name = `json:${path.basename(this.filePath)}`;
        if (!fs.existsSync(this.filePath)) {
            throw new Error(`[JsonFileSource] File not found: ${this.filePath}`);
        }
    }

    async fetchCandles(): Promise<Record<string, unknown>[]> {
        try {
            const { candles, meta } = loadCandleFile(this.filePath);
            if (!Array.isArray(candles) || candles.length === 0) {
                throw new Error('Expected JSON array or object with .candles or .data property');
            }

            const intervalSeconds = Number(meta?.intervalSeconds) || 3600;
            const lookbackHours = Number(meta?.lookbackHours) || 0;

            if (lookbackHours && candles.length > 0) {
                const nowMs = new Date(Number(meta?.fetchedAt) || Date.now()).getTime();
                const startTs = nowMs - (lookbackHours * 3600 * 1000);
                return fillCandleGaps(candles, intervalSeconds, startTs, nowMs) as unknown as Record<string, unknown>[];
            }

            return candles;
        } catch (err) {
            throw new Error(`[JsonFileSource] Failed to read ${this.filePath}: ${getErrorMessage(err)}`);
        }
    }

    extractMarketPrice(candle: unknown): { marketPrice: number; timestamp: number } {
        return { marketPrice: getCandleClose(candle) as number, timestamp: getCandleTimestamp(candle) as number };
    }
}

interface InlineConfig {
    candles: Record<string, unknown>[];
    meta?: Record<string, unknown> | null;
    name?: string;
}

/**
 * In-memory candle series (no backing file). Used when discovery assembles a
 * series across month shards, where there is no single whole-history file to
 * hand JsonFileSource.
 */
class InlineCandleSource {
    candles: Record<string, unknown>[];
    meta: Record<string, unknown> | null;
    name: string;

    constructor(config: InlineConfig) {
        this.candles = config.candles || [];
        this.meta = config.meta || null;
        this.name = `inline:${config.name || 'lp-series'}`;
    }

    async fetchCandles(): Promise<Record<string, unknown>[]> {
        return this.candles;
    }

    extractMarketPrice(candle: unknown): { marketPrice: number; timestamp: number } {
        return { marketPrice: getCandleClose(candle) as number, timestamp: getCandleTimestamp(candle) as number };
    }
}

interface MarketAdapterConfig {
    stateDir?: string;
    botKey: string;
}

class MarketAdapterSource {
    stateDir: string;
    centersFile: string;
    botKey: string;
    name: string;

    constructor(config: MarketAdapterConfig) {
        this.stateDir = config.stateDir || PATHS.MARKET_ADAPTER.STATE_DIR;
        // Canonical filename from modules/paths.ts when using the default
        // state dir; custom state dirs keep the sibling-file layout.
        this.centersFile = config.stateDir
            ? path.join(this.stateDir, 'market_adapter_centers.json')
            : PATHS.MARKET_ADAPTER.CENTERS_FILE;
        this.botKey = config.botKey;
        this.name = `market_adapter:${this.botKey}`;
    }

    async fetchCandles(): Promise<Record<string, unknown>[]> {
        const centersFile = this.centersFile;
        if (!fs.existsSync(centersFile)) {
            throw new Error(`[MarketAdapterSource] Centers file not found: ${centersFile}`);
        }

        try {
            type CentersBot = { history?: Array<Record<string, unknown>> };
            const data = readJSON<{ bots?: Record<string, CentersBot>; [key: string]: unknown }>(centersFile);

            let botData = data[this.botKey] as CentersBot | undefined;
            if (!botData && data.bots && data.bots[this.botKey]) {
                botData = data.bots[this.botKey];
            }

            if (!botData) {
                throw new Error(`Bot '${this.botKey}' not found in centers file`);
            }

            return botData.history?.map((entry: Record<string, unknown>) => ({
                timestamp: entry.timestamp,
                open: entry.center,
                high: entry.center,
                low: entry.center,
                close: entry.center,
                volume: 0,
            })) || [];
        } catch (err) {
            throw new Error(`[MarketAdapterSource] Failed to read: ${getErrorMessage(err)}`);
        }
    }

    extractMarketPrice(candle: unknown): { marketPrice: number; timestamp: number } {
        const c = candle as { close?: number; timestamp?: number };
        return { marketPrice: c.close as number, timestamp: c.timestamp as number };
    }
}

function createSource(type: string, config: JsonFileConfig | InlineConfig | MarketAdapterConfig): JsonFileSource | InlineCandleSource | MarketAdapterSource {
    switch (type.toLowerCase()) {
        case 'json':
            return new JsonFileSource(config as JsonFileConfig);
        case 'inline':
            return new InlineCandleSource(config as InlineConfig);
        case 'market_adapter':
            return new MarketAdapterSource(config as MarketAdapterConfig);
        default:
            throw new Error(`[PriceSource] Unknown type: ${type}`);
    }
}

export { createSource }

