import { getErrorMessage } from './utils/errors.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { deepMerge } from './settings_merge.js';
import type { UnknownRecord } from './types.js';
import { isUnknownRecord } from './types.js';

import {
    GRID_LIMITS, FEE_PARAMETERS, INCREMENT_BOUNDS, TIMING,
    LOG_LEVEL, LOGGING_CONFIG, FILL_PROCESSING,
    PIPELINE_TIMING, API_LIMITS, COW_PERFORMANCE,
} from './constants.js';

function _toScreamingCase(key: string): string {
    return key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function _normalizeKeys(obj: unknown): unknown {
    if (Array.isArray(obj) || obj === null || typeof obj !== 'object') return obj;
    const out: UnknownRecord = {};
    for (const [k, v] of Object.entries(obj)) {
        out[_toScreamingCase(k)] = _normalizeKeys(v);
    }
    return out;
}

function _deepMerge<T extends UnknownRecord>(target: T | undefined, source: unknown): T {
    return deepMerge(target ?? ({} as T), _normalizeKeys(source) as UnknownRecord) as T;
}

interface BotRuntimeSettings {
    gridLimits: typeof GRID_LIMITS;
    feeParams: typeof FEE_PARAMETERS;
    incrementBounds: typeof INCREMENT_BOUNDS;
    timing: typeof TIMING;
    fillProcessing: typeof FILL_PROCESSING;
    cowPerformance: typeof COW_PERFORMANCE;
    pipelineTiming: typeof PIPELINE_TIMING;
    apiLimits: typeof API_LIMITS;
    logging: {
        level: string;
        config: typeof LOGGING_CONFIG;
    };
}

type BotRuntimeSettingsOverrides = Partial<BotRuntimeSettings> & {
    poolSlippageTolerance?: number;
};

export const RUNTIME_SETTINGS_KEYS: readonly string[] = [
    'gridLimits', 'feeParams', 'incrementBounds', 'timing',
    'fillProcessing', 'cowPerformance', 'pipelineTiming', 'apiLimits', 'logging',
];

/**
 * Bot-config keys safe to apply to a live bot without a grid rebuild or a
 * process restart (Issue #27 follow-up). Single source of truth — consumed
 * by the live bot-config check (dexbot_maintenance_runtime.ts) and the
 * `dexbot bot` editor hint (account_bots.ts) so the two can never drift.
 * activeOrders/reserveOrders are re-read via the targeted-reconcile path,
 * botFunds via recalculateFunds, weightDistribution base via
 * refreshDynamicWeightDistribution, min_BTS_value via the fee/acquisition
 * reads, and debtPolicy via the credit runtime's live getter (next credit
 * maintenance/watchdog cycle applies it; enabling from zero also
 * (re)starts the credit watchdog, removal stops it).
 */
export const BOT_LIVE_CONFIG_KEYS: readonly string[] = [
    'activeOrders',
    'reserveOrders',
    'botFunds',
    'weightDistribution',
    'min_BTS_value',
    'debtPolicy',
];

export function resolveBotRuntimeSettings(botConfig: UnknownRecord): BotRuntimeSettings {
    const result: BotRuntimeSettings = {
        gridLimits: { ...GRID_LIMITS, GRID_COMPARISON: { ...GRID_LIMITS.GRID_COMPARISON } },
        feeParams: { ...FEE_PARAMETERS },
        incrementBounds: { ...INCREMENT_BOUNDS },
        timing: { ...TIMING },
        fillProcessing: { ...FILL_PROCESSING },
        cowPerformance: { ...COW_PERFORMANCE },
        pipelineTiming: { ...PIPELINE_TIMING },
        apiLimits: { ...API_LIMITS },
        logging: {
            level: LOG_LEVEL,
            config: JSON.parse(JSON.stringify(LOGGING_CONFIG)),
        },
    };

    const marketOverrides = _resolveMarketOverrides(botConfig);
    if (marketOverrides) {
        if (marketOverrides.gridLimits) result.gridLimits = _deepMerge(result.gridLimits, marketOverrides.gridLimits);
        if (marketOverrides.feeParams) result.feeParams = _deepMerge(result.feeParams, marketOverrides.feeParams);
        if (marketOverrides.incrementBounds) result.incrementBounds = _deepMerge(result.incrementBounds, marketOverrides.incrementBounds);
        if (marketOverrides.timing) result.timing = _deepMerge(result.timing, marketOverrides.timing);
        if (marketOverrides.fillProcessing) result.fillProcessing = _deepMerge(result.fillProcessing, marketOverrides.fillProcessing);
        if (marketOverrides.cowPerformance) result.cowPerformance = _deepMerge(result.cowPerformance, marketOverrides.cowPerformance);
        if (marketOverrides.pipelineTiming) result.pipelineTiming = _deepMerge(result.pipelineTiming, marketOverrides.pipelineTiming);
        if (marketOverrides.apiLimits) result.apiLimits = _deepMerge(result.apiLimits, marketOverrides.apiLimits);
        if (marketOverrides.poolSlippageTolerance !== undefined) result.feeParams.POOL_SLIPPAGE_TOLERANCE = marketOverrides.poolSlippageTolerance;
    }

    if (botConfig.gridLimits) result.gridLimits = _deepMerge(result.gridLimits, botConfig.gridLimits);
    if (botConfig.feeParams) result.feeParams = _deepMerge(result.feeParams, botConfig.feeParams);
    if (botConfig.incrementBounds) result.incrementBounds = _deepMerge(result.incrementBounds, botConfig.incrementBounds);
    if (botConfig.timing) result.timing = _deepMerge(result.timing, botConfig.timing);
    if (botConfig.fillProcessing) result.fillProcessing = _deepMerge(result.fillProcessing, botConfig.fillProcessing);
    if (botConfig.cowPerformance) result.cowPerformance = _deepMerge(result.cowPerformance, botConfig.cowPerformance);
    if (botConfig.pipelineTiming) result.pipelineTiming = _deepMerge(result.pipelineTiming, botConfig.pipelineTiming);
    if (botConfig.apiLimits) result.apiLimits = _deepMerge(result.apiLimits, botConfig.apiLimits);
    if (botConfig.logging) {
        const loggingOverride = botConfig.logging;
        if (isUnknownRecord(loggingOverride)) {
            if (typeof loggingOverride.level === 'string') result.logging.level = loggingOverride.level;
            if (isUnknownRecord(loggingOverride.config)) {
                result.logging.config = deepMerge(result.logging.config, loggingOverride.config) as typeof LOGGING_CONFIG;
            }
        }
    }

    return result;
}

function _resolveMarketOverrides(botConfig: UnknownRecord): BotRuntimeSettingsOverrides | null {
    try {
        const marketAdapter = require('../market_adapter/market_adapter');
        const settings = (typeof marketAdapter.loadMarketAdapterSettings === 'function')
            ? marketAdapter.loadMarketAdapterSettings()
            : null;
        if (!settings) return null;

        const overrides: BotRuntimeSettingsOverrides = {};

        if (settings.globals) {
            if (settings.globals.runtimeGridLimits) overrides.gridLimits = { ...settings.globals.runtimeGridLimits };
            if (settings.globals.runtimeFeeParams) overrides.feeParams = { ...settings.globals.runtimeFeeParams };
            if (settings.globals.runtimeTiming) overrides.timing = { ...settings.globals.runtimeTiming };
            if (settings.globals.runtimeIncrementBounds) overrides.incrementBounds = { ...settings.globals.runtimeIncrementBounds };
            if (settings.globals.runtimeFillProcessing) overrides.fillProcessing = { ...settings.globals.runtimeFillProcessing };
            if (settings.globals.runtimeCowPerformance) overrides.cowPerformance = { ...settings.globals.runtimeCowPerformance };
            if (settings.globals.runtimePipelineTiming) overrides.pipelineTiming = { ...settings.globals.runtimePipelineTiming };
            if (settings.globals.runtimeApiLimits) overrides.apiLimits = { ...settings.globals.runtimeApiLimits };
            if (settings.globals.runtimePoolSlippageTolerance !== undefined) overrides.poolSlippageTolerance = settings.globals.runtimePoolSlippageTolerance;
        }

        if (Array.isArray(settings.pairs) && typeof marketAdapter.findPairForBot === 'function') {
            const pair = marketAdapter.findPairForBot(botConfig, settings.pairs);
            if (pair) {
                if (pair.marketGridLimits) overrides.gridLimits = _deepMerge(overrides.gridLimits, pair.marketGridLimits);
                if (pair.marketFeeParams) overrides.feeParams = _deepMerge(overrides.feeParams, pair.marketFeeParams);
                if (pair.marketTiming) overrides.timing = _deepMerge(overrides.timing, pair.marketTiming);
                if (pair.marketIncrementBounds) overrides.incrementBounds = _deepMerge(overrides.incrementBounds, pair.marketIncrementBounds);
                if (pair.marketFillProcessing) overrides.fillProcessing = _deepMerge(overrides.fillProcessing, pair.marketFillProcessing);
                if (pair.marketCowPerformance) overrides.cowPerformance = _deepMerge(overrides.cowPerformance, pair.marketCowPerformance);
                if (pair.marketPipelineTiming) overrides.pipelineTiming = _deepMerge(overrides.pipelineTiming, pair.marketPipelineTiming);
                if (pair.marketApiLimits) overrides.apiLimits = _deepMerge(overrides.apiLimits, pair.marketApiLimits);
                if (pair.marketPoolSlippageTolerance !== undefined) overrides.poolSlippageTolerance = pair.marketPoolSlippageTolerance;

                if (pair.botOverrides && pair.botOverrides[String(botConfig.name)]) {
                    const bo = pair.botOverrides[String(botConfig.name)];
                    if (bo.botGridLimits) overrides.gridLimits = _deepMerge(overrides.gridLimits, bo.botGridLimits);
                    if (bo.botFeeParams) overrides.feeParams = _deepMerge(overrides.feeParams, bo.botFeeParams);
                    if (bo.botTiming) overrides.timing = _deepMerge(overrides.timing, bo.botTiming);
                    if (bo.botIncrementBounds) overrides.incrementBounds = _deepMerge(overrides.incrementBounds, bo.botIncrementBounds);
                    if (bo.botFillProcessing) overrides.fillProcessing = _deepMerge(overrides.fillProcessing, bo.botFillProcessing);
                    if (bo.botCowPerformance) overrides.cowPerformance = _deepMerge(overrides.cowPerformance, bo.botCowPerformance);
                    if (bo.botPipelineTiming) overrides.pipelineTiming = _deepMerge(overrides.pipelineTiming, bo.botPipelineTiming);
                    if (bo.botApiLimits) overrides.apiLimits = _deepMerge(overrides.apiLimits, bo.botApiLimits);
                    if (bo.botPoolSlippageTolerance !== undefined) overrides.poolSlippageTolerance = bo.botPoolSlippageTolerance;
                }
            }
        }

        if (Object.keys(overrides).length === 0) return null;
        return overrides;
    } catch (err) {
        console.warn(
            `[runtime_settings] Failed to resolve market adapter overrides for bot "${botConfig?.name ?? 'unknown'}" ` +
            `(${getErrorMessage(err)}); continuing with base settings only.`
        );
        return null;
    }
}
