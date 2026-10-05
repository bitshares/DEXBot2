'use strict';

import { getStorage } from './storage/index.js';
const storage = getStorage();
const { readJSON } = storage;
import { PATHS } from './paths.js';
import { normalizeBotEntry } from './bot_settings.js';
import { getErrorMessage, getErrorCode } from './utils/errors.js';
import { MERGE_STRATEGIES } from './settings_merge.js';
import { DEFAULT_WHITELIST_FLAGS } from './market_adapter_whitelist.js';


interface ValidationProblem {
    file: string;
    field: string;
    message: string;
    severity: 'error' | 'warn';
}

type ProblemList = ValidationProblem[];

const PROFILE_KNOWN_FIELDS = new Set([
    'key', 'assetA', 'assetB', 'assetAId', 'assetBId',
    'poolId', 'intervalSeconds', 'intervalLabel',
    'defaultAma', 'sourceResultsFile', 'updatedAt', 'amas',
]);

const PROFILE_AMA_KNOWN_FIELDS = new Set([
    'name', 'erPeriod', 'fastPeriod', 'slowPeriod',
]);

const GENERAL_SETTINGS_KNOWN_FIELDS = new Set([
    ...Object.keys(MERGE_STRATEGIES),
    'NODES',
]);

// Derived from the canonical flag constants so a new flag lands here
// automatically instead of drifting out of sync with the reader.
const WHITELIST_KNOWN_FLAGS: Set<string> = new Set(Object.keys(DEFAULT_WHITELIST_FLAGS));

const MA_SETTINGS_KNOWN_FIELDS = new Set([
    'globals', 'pairs',
]);
const MA_PAIR_KNOWN_FIELDS = new Set([
    'key', 'assetASymbol', 'assetBSymbol',
    'marketAdapterSettings', 'botOverrides',
]);

function push(problems: ProblemList, file: string, field: string, message: string, severity: 'error' | 'warn' = 'error') {
    problems.push({ file, field, message, severity });
}

type JsonObject = Record<string, unknown>;

function isPositiveFinite(v: unknown): boolean {
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function loadJsonFile(filePath: string): { data: unknown; ok: boolean; error?: string } {
    try {
        const data = readJSON(filePath);
        return { data, ok: true };
    } catch (err) {
        if (getErrorCode(err) === 'ENOENT') return { data: null, ok: true };
        if (err instanceof SyntaxError) return { data: null, ok: false, error: `${filePath}: invalid JSON (${getErrorMessage(err)})` };
        return { data: null, ok: false, error: `${filePath}: ${getErrorMessage(err)}` };
    }
}

// --- market_profiles.json ---
function validateMarketProfiles(data: unknown, filePath: string, problems: ProblemList) {
    if (!data) return;
    const doc = data as JsonObject;

    if ('version' in doc && typeof doc.version !== 'number') {
        push(problems, filePath, 'version', `Must be a number`);
    }

    const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
    profiles.forEach((p, idx) => {
        const prefix = `profiles[${idx}]`;
        if (typeof p !== 'object' || p === null) return;
        const prof = p as JsonObject;

        for (const key of Object.keys(prof)) {
            if (!PROFILE_KNOWN_FIELDS.has(key)) {
                push(problems, filePath, `${prefix}.${key}`,
                    `Unrecognized field "${key}"`, 'warn');
            }
        }

        if ('assetA' in prof && typeof prof.assetA !== 'string') {
            push(problems, filePath, `${prefix}.assetA`, `Must be a string`);
        }
        if ('assetB' in prof && typeof prof.assetB !== 'string') {
            push(problems, filePath, `${prefix}.assetB`, `Must be a string`);
        }
        if ('defaultAma' in prof && typeof prof.defaultAma !== 'string') {
            push(problems, filePath, `${prefix}.defaultAma`, `Must be a string`);
        }
        if ('intervalSeconds' in prof && !isPositiveFinite(prof.intervalSeconds)) {
            push(problems, filePath, `${prefix}.intervalSeconds`, `Must be a positive number`);
        }

        if (prof.amas && typeof prof.amas === 'object') {
            for (const [amaKey, amaVal] of Object.entries(prof.amas as JsonObject)) {
                const ap = `${prefix}.amas.${amaKey}`;
                if (typeof amaVal !== 'object' || amaVal === null) {
                    push(problems, filePath, ap, `Must be an object`);
                    continue;
                }
                const v = amaVal as JsonObject;
                for (const k of Object.keys(v)) {
                    if (!PROFILE_AMA_KNOWN_FIELDS.has(k)) {
                        push(problems, filePath, `${ap}.${k}`,
                            `Unrecognized field "${k}"`, 'warn');
                    }
                }
                if ('erPeriod' in v && !isPositiveFinite(v.erPeriod)) {
                    push(problems, filePath, `${ap}.erPeriod`, `Must be a positive number`);
                }
                if ('fastPeriod' in v && !isPositiveFinite(v.fastPeriod)) {
                    push(problems, filePath, `${ap}.fastPeriod`, `Must be a positive number`);
                }
                if ('slowPeriod' in v && !isPositiveFinite(v.slowPeriod)) {
                    push(problems, filePath, `${ap}.slowPeriod`, `Must be a positive number`);
                }
            }
        }
    });
}

// --- market_adapter_whitelist.json ---
function validateWhitelist(data: unknown, filePath: string, problems: ProblemList) {
    if (!data) return;
    const doc = data as JsonObject;

    const raw = doc.whitelist;
    if (raw === undefined) {
        push(problems, filePath, 'whitelist', `Missing required key "whitelist"`);
        return;
    }

    if (Array.isArray(raw)) {
        raw.forEach((entry, idx) => {
            if (entry !== null && entry !== undefined && typeof entry !== 'string') {
                push(problems, filePath, `whitelist[${idx}]`,
                    `Array entries should be bot key strings, got ${typeof entry}`, 'warn');
            }
        });
        return;
    }

    if (raw && typeof raw === 'object') {
        for (const [botKey, entry] of Object.entries(raw)) {
            const prefix = `whitelist.${botKey}`;
            if (entry === true || entry === false || entry === null || entry === undefined) continue;
            if (typeof entry !== 'object') {
                push(problems, filePath, prefix,
                    `Expected object or boolean, got ${typeof entry}`, 'warn');
                continue;
            }
            for (const k of Object.keys(entry)) {
                if (!WHITELIST_KNOWN_FLAGS.has(k)) {
                    push(problems, filePath, `${prefix}.${k}`,
                        `Unrecognized flag "${k}" — must be one of: ${[...WHITELIST_KNOWN_FLAGS].join(', ')}`, 'warn');
                }
            }
            for (const flag of WHITELIST_KNOWN_FLAGS) {
                const entryObj = entry as Record<string, unknown>;
                if (flag in entryObj && typeof entryObj[flag] !== 'boolean') {
                    push(problems, filePath, `${prefix}.${flag}`,
                        `Must be a boolean, got ${typeof entryObj[flag]}`);
                }
            }
        }
    }
}

// --- market_adapter_settings.json ---
function validateMarketAdapterSettings(data: unknown, filePath: string, problems: ProblemList) {
    if (!data) return;
    const doc = data as JsonObject;

    for (const key of Object.keys(doc)) {
        if (!MA_SETTINGS_KNOWN_FIELDS.has(key)) {
            push(problems, filePath, key,
                `Unrecognized field "${key}"`, 'warn');
        }
    }

    if ('globals' in doc && doc.globals !== null) {
        if (typeof doc.globals !== 'object') {
            push(problems, filePath, 'globals', `Must be an object`);
        }
    }

    if ('pairs' in doc && doc.pairs !== null) {
        if (!Array.isArray(doc.pairs)) {
            push(problems, filePath, 'pairs', `Must be an array`);
        } else {
            doc.pairs.forEach((pair, idx) => {
                const prefix = `pairs[${idx}]`;
                if (typeof pair !== 'object' || pair === null) return;
                const pr = pair as JsonObject;
                for (const key of Object.keys(pr)) {
                    if (!MA_PAIR_KNOWN_FIELDS.has(key)) {
                        push(problems, filePath, `${prefix}.${key}`,
                            `Unrecognized field "${key}"`, 'warn');
                    }
                }
                if ('key' in pr && typeof pr.key !== 'string') {
                    push(problems, filePath, `${prefix}.key`, `Must be a string`);
                }
                if ('marketAdapterSettings' in pr && pr.marketAdapterSettings !== null
                    && typeof pr.marketAdapterSettings !== 'object') {
                    push(problems, filePath, `${prefix}.marketAdapterSettings`, `Must be an object`);
                }
                if ('botOverrides' in pr && pr.botOverrides !== null
                    && typeof pr.botOverrides !== 'object') {
                    push(problems, filePath, `${prefix}.botOverrides`, `Must be an object`);
                }
            });
        }
    }
}

// --- general.settings.json ---
function validateGeneralSettings(data: unknown, filePath: string, problems: ProblemList) {
    if (!data) return;
    const doc = data as JsonObject;

    for (const key of Object.keys(doc)) {
        if (!GENERAL_SETTINGS_KNOWN_FIELDS.has(key) && !key.startsWith('_')) {
            push(problems, filePath, key,
                `Unrecognized field "${key}" — may be stale/misspelled, has no effect`, 'warn');
        }
    }

    if ('LOG_LEVEL' in doc && doc.LOG_LEVEL !== undefined) {
        const valid = ['debug', 'info', 'warn', 'error', 'critical'];
        if (!valid.includes(String(doc.LOG_LEVEL).toLowerCase())) {
            push(problems, filePath, 'LOG_LEVEL',
                `Must be one of: ${valid.join(', ')}, got ${JSON.stringify(doc.LOG_LEVEL)}`, 'warn');
        }
    }

    if ('MARKET_ADAPTER' in doc && doc.MARKET_ADAPTER !== null && doc.MARKET_ADAPTER !== undefined) {
        if (typeof doc.MARKET_ADAPTER !== 'object') {
            push(problems, filePath, 'MARKET_ADAPTER', `Must be an object`);
        }
    }
}

// --- Cross-file consistency ---
function validateCrossFileConsistency(problems: ProblemList) {
    const botKeysInWhitelist = new Set<string>();
    const botKeysInWhitelistEnabledAma = new Set<string>();

    // Load whitelist
    const wlFile = PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();
    const wlResult = loadJsonFile(wlFile);
    if (wlResult.ok && wlResult.data) {
        const wlDoc = wlResult.data as JsonObject;
        const raw = wlDoc.whitelist;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [botKey, entry] of Object.entries(raw)) {
                botKeysInWhitelist.add(botKey);
                const flags = typeof entry === 'object' && entry !== null ? entry as JsonObject : {};
                if (flags.ama !== false) {
                    botKeysInWhitelistEnabledAma.add(botKey);
                }
            }
        } else if (Array.isArray(raw)) {
            for (const entry of raw) {
                if (entry) {
                    const k = String(entry);
                    botKeysInWhitelist.add(k);
                    botKeysInWhitelistEnabledAma.add(k);
                }
            }
        }
    }

    // Load market_profiles
    const mpFile = PATHS.PROFILES.MARKET_PROFILES_JSON;
    const mpResult = loadJsonFile(mpFile);
    const profiles: JsonObject[] = [];
    if (mpResult.ok && mpResult.data) {
        const mpDoc = mpResult.data as JsonObject;
        const raw = Array.isArray(mpDoc.profiles) ? mpDoc.profiles : [];
        profiles.push(...raw);
    }

    // Load bots.json — match AMA bots against profiles and whitelist
    const botsFile = PATHS.PROFILES.BOTS_JSON;
    const botsResult = loadJsonFile(botsFile);
    const amaBotKeys = new Set<string>();
    if (botsResult.ok && botsResult.data) {
        const botsDoc = botsResult.data as JsonObject;
        const bots = Array.isArray(botsDoc.bots) ? botsDoc.bots : [];
        bots.forEach((bot, idx) => {
            if (!bot) return;
            const botObj = bot as JsonObject;
            const gp = botObj.gridPrice;
            const usesAma = typeof gp === 'string' && /^ama(?:[1-4])?$/i.test(gp.trim());
            if (!usesAma) return;

            const name = botObj.name || `unnamed-${idx}`;
            const botKey = normalizeBotEntry(botObj, idx).botKey || '';
            amaBotKeys.add(botKey);

            // Check whitelist: warn if AMA bot has no whitelist entry
            if (botKeysInWhitelist.size > 0 && !botKeysInWhitelistEnabledAma.has(botKey)) {
                push(problems, wlFile, `whitelist`,
                    `Bot "${name}" uses gridPrice: "${gp}" but is not in the AMA whitelist (or ama=false) — market adapter runs in dry-run mode`, 'warn');
            }

            // No market profile check needed: AMA falls back to built-in defaults by design
        });
    }

    // Check whitelist entries that have no corresponding AMA bot in bots.json
    if (amaBotKeys.size > 0) {
        for (const bk of botKeysInWhitelistEnabledAma) {
            if (!amaBotKeys.has(bk)) {
                push(problems, botsFile, `bots`,
                    `Whitelist entry "${bk}" has no corresponding AMA bot in bots.json — stale entry`, 'warn');
            }
        }
    }
}

// --- Main entry ---
function validateAllProfiles(): { errors: ProblemList; warnings: ProblemList } {
    const all: ProblemList = [];

    // general.settings.json
    const gsFile = PATHS.PROFILES.GENERAL_SETTINGS_JSON;
    const gsResult = loadJsonFile(gsFile);
    if (!gsResult.ok) {
        push(all, gsFile, '(root)', `Failed to parse — ${gsResult.error}`);
    } else if (gsResult.data) {
        validateGeneralSettings(gsResult.data, gsFile, all);
    }

    // bots.json — delegate to existing bot_settings.ts validateBotEntry.
    // Only check parse errors here; field-level validation is handled by
    // collectValidationIssues in bot_settings.ts which is already called
    // by runBotInstances (dexbot.ts).
    const botsFile = PATHS.PROFILES.BOTS_JSON;
    const botsResult = loadJsonFile(botsFile);
    if (!botsResult.ok) {
        push(all, botsFile, '(root)', `Failed to parse — ${botsResult.error}`);
    }

    // market_adapter_whitelist.json
    const wlFile = PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();
    const wlResult = loadJsonFile(wlFile);
    if (!wlResult.ok) {
        push(all, wlFile, '(root)', `Failed to parse — ${wlResult.error}`);
    } else if (wlResult.data) {
        validateWhitelist(wlResult.data, wlFile, all);
    }

    // market_profiles.json
    const mpFile = PATHS.PROFILES.MARKET_PROFILES_JSON;
    const mpResult = loadJsonFile(mpFile);
    if (!mpResult.ok) {
        push(all, mpFile, '(root)', `Failed to parse — ${mpResult.error}`);
    } else if (mpResult.data) {
        validateMarketProfiles(mpResult.data, mpFile, all);
    }

    // market_adapter_settings.json
    const maFile = PATHS.PROFILES.MARKET_ADAPTER_SETTINGS_JSON;
    const maResult = loadJsonFile(maFile);
    if (!maResult.ok) {
        push(all, maFile, '(root)', `Failed to parse — ${maResult.error}`);
    } else if (maResult.data) {
        validateMarketAdapterSettings(maResult.data, maFile, all);
    }

    // Cross-file consistency
    validateCrossFileConsistency(all);

    const errors = all.filter((p) => p.severity === 'error');
    const warnings = all.filter((p) => p.severity === 'warn');
    return { errors, warnings };
}

function printValidationProblems(result: { errors: ProblemList; warnings: ProblemList }): boolean {
    if (result.errors.length === 0 && result.warnings.length === 0) return true;

    if (result.warnings.length > 0) {
        console.warn('\n═══════════════════════════════════════════');
        console.warn('  Profile Configuration Warnings');
        console.warn('═══════════════════════════════════════════');
        for (const w of result.warnings) {
            console.warn(`  * ${w.file}:${w.field}`);
            console.warn(`    ${getErrorMessage(w)}`);
        }
        console.warn('');
    }

    if (result.errors.length > 0) {
        console.error('\n═══════════════════════════════════════════');
        console.error('  Profile Configuration ERRORS');
        console.error('═══════════════════════════════════════════');
        for (const e of result.errors) {
            console.error(`  * ${e.file}:${e.field}`);
            console.error(`    ${getErrorMessage(e)}`);
        }
        console.error('');
        return false;
    }

    return true;
}

export { validateAllProfiles, printValidationProblems }

