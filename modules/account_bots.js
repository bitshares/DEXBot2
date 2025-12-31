// Interactive CLI helper for editing the tracked bot profiles stored in profiles/bots.json.
const fs = require('fs');
const path = require('path');
const readlineSync = require('readline-sync');
const readline = require('readline');
const { execSync } = require('child_process');
const { DEFAULT_CONFIG, GRID_LIMITS, TIMING, LOG_LEVEL } = require('./constants');

function parseJsonWithComments(raw) {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped);
}

const BOTS_FILE = path.join(__dirname, '..', 'profiles', 'bots.json');
const SETTINGS_FILE = path.join(__dirname, '..', 'profiles', 'general.settings.json');


function ensureProfilesDirectory() {
    const dir = path.dirname(BOTS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function loadBotsConfig() {
    if (!fs.existsSync(BOTS_FILE)) {
        return { config: { bots: [] }, filePath: BOTS_FILE };
    }
    try {
        const content = fs.readFileSync(BOTS_FILE, 'utf8');
        if (!content || !content.trim()) return { config: { bots: [] }, filePath: BOTS_FILE };
        const parsed = parseJsonWithComments(content);
        if (!Array.isArray(parsed.bots)) parsed.bots = [];
        return { config: parsed, filePath: BOTS_FILE };
    } catch (err) {
        console.error('Failed to load bots configuration:', err.message);
        return { config: { bots: [] }, filePath: BOTS_FILE };
    }
}

function saveBotsConfig(config, filePath) {
    try {
            ensureProfilesDirectory();
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Failed to save bots configuration:', err.message);
        throw err;
    }
}

function loadGeneralSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) {
        return {
            LOG_LEVEL: LOG_LEVEL,
            GRID_LIMITS: { ...GRID_LIMITS },
            TIMING: { ...TIMING }
        };
    }
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error('Failed to load general settings:', err.message);
        return {
            LOG_LEVEL: LOG_LEVEL,
            GRID_LIMITS: { ...GRID_LIMITS },
            TIMING: { ...TIMING }
        };
    }
}

function saveGeneralSettings(settings) {
    try {
        ensureProfilesDirectory();
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        console.log(`\n✓ General settings saved to ${path.basename(SETTINGS_FILE)}`);
    } catch (err) {
        console.error('Failed to save general settings:', err.message);
    }
}

function listBots(bots) {
    if (!bots.length) {
        console.log('  (no bot entries defined yet)');
        return;
    }
    bots.forEach((bot, index) => {
        const name = bot.name || `<unnamed-${index + 1}>`;
        const inactiveSuffix = bot.active === false ? ' [inactive]' : '';
        const dryRunSuffix = bot.dryRun ? ' (dryRun)' : '';
        console.log(`  ${index + 1}: ${name}${inactiveSuffix}${dryRunSuffix} ${bot.assetA || '?'} / ${bot.assetB || '?'}`);
    });
}

function selectBotIndex(bots, promptMessage) {
    if (!bots.length) return null;
    listBots(bots);
    const raw = readlineSync.question(`${promptMessage} [1-${bots.length}]: `).trim();
    const idx = Number(raw);
    if (Number.isNaN(idx) || idx < 1 || idx > bots.length) {
        console.log('Invalid selection.');
        return null;
    }
    return idx - 1;
}

function askString(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const answer = readlineSync.question(`${promptText}${suffix}: `);
    if (!answer) return defaultValue;
    return answer.trim();
}

function askRequiredString(promptText, defaultValue) {
    while (true) {
        const value = askString(promptText, defaultValue);
        if (value && value.trim()) return value.trim();
        console.log('This field is required.');
    }
}

async function askAsset(promptText, defaultValue) {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        // Use readlineSync with mask to capture and display as uppercase
        const answer = readlineSync.question(`${promptText}${suffix}: `, {
            hideEchoBack: false
        }).trim();

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        return answer.toUpperCase();
    }
}

async function askAssetB(promptText, defaultValue, assetA) {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        // Use readlineSync with mask to capture and display as uppercase
        const answer = readlineSync.question(`${promptText}${suffix}: `, {
            hideEchoBack: false
        }).trim();

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        const assetB = answer.toUpperCase();

        // Validate that Asset B is different from Asset A
        if (assetB === assetA) {
            console.log(`Invalid: Asset B cannot be the same as Asset A (${assetA})`);
            continue;
        }

        return assetB;
    }
}

function askNumber(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumber(promptText, defaultValue);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askNumber(promptText, defaultValue);
    }
    return parsed;
}

function askWeightDistribution(promptText, defaultValue) {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    console.log('\x1b[33m  -1=SuperValley ←→ 0=Valley ←→ 0.5=Neutral ←→ 1=Mountain ←→ 2=SuperMountain\x1b[0m');
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistribution(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistribution(promptText, defaultValue);
    }
    return parsed;
}

function askWeightDistributionNoLegend(promptText, defaultValue) {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    return parsed;
}

function isMultiplierString(value) {
    return typeof value === 'string' && /^[ -￿]*[0-9]+(?:\.[0-9]+)?x[ -￿]*$/i.test(value);
}

function askNumberWithBounds(promptText, defaultValue, minVal, maxVal) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= ${minVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    if (parsed > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be <= ${maxVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
}

function askTargetSpreadPercent(promptText, defaultValue, incrementPercent) {
    const minRequired = incrementPercent * 2;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue.toFixed(2)}]` : '';
    const raw = readlineSync.question(`${promptText} (>= ${minRequired.toFixed(2)})${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    // Validate >= 2x incrementPercent
    if (parsed < minRequired) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= 2x incrementPercent (${minRequired.toFixed(2)})`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    // Validate no negative
    if (parsed < 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Cannot be negative`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent);
    }
    return parsed;
}

function askIntegerInRange(promptText, defaultValue, minVal, maxVal) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is integer (not float)
    if (!Number.isInteger(parsed)) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be an integer (no decimals)`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal || Math.floor(parsed) > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be between ${minVal} and ${maxVal}`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
}

function askNumberOrMultiplier(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askNumberOrMultiplier(promptText, defaultValue);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    return parsed;
}

function askMaxPrice(promptText, defaultValue, minPrice) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askMaxPrice(promptText, defaultValue, minPrice);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that maxPrice > minPrice
    const minPriceValue = typeof minPrice === 'string' ? parseFloat(minPrice) : minPrice;
    if (parsed <= minPriceValue) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > minPrice (${minPriceValue})`);
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    return parsed;
}

function normalizePercentageInput(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.endsWith('%')) return null;
    const numeric = Number(trimmed.slice(0, -1).trim());
    if (Number.isNaN(numeric)) return null;
    return `${numeric}%`;
}

function askNumberOrPercentage(promptText, defaultValue) {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = readlineSync.question(`${promptText}${suffix}: `).trim();
    if (raw === '') return defaultValue;
    const percent = normalizePercentageInput(raw);
    if (percent !== null) return percent;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or percentage (e.g. 100, 50%).');
        return askNumberOrPercentage(promptText, defaultValue);
    }
    return parsed;
}

function askBoolean(promptText, defaultValue) {
    const label = defaultValue ? 'Y/n' : 'y/N';
    const raw = readlineSync.question(`${promptText} (${label}): `).trim().toLowerCase();
    if (!raw) return !!defaultValue;
    return raw.startsWith('y');
}

function askStartPrice(promptText, defaultValue) {
    while (true) {
        const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
        const raw = readlineSync.question(`${promptText}${suffix}: `).trim();

        if (!raw) {
            if (defaultValue !== undefined && defaultValue !== null) {
                return defaultValue;
            }
            return undefined;
        }

        const lower = raw.toLowerCase();
        // Accept 'pool' or 'market' strings
        if (lower === 'pool' || lower === 'market') {
            return lower;
        }

        // Accept numeric values (including decimals)
        const num = Number(raw);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
            return num;
        }

        console.log('Please enter "pool", "market", or a numeric value.');
    }
}

async function promptBotData(base = {}) {
    // Create a working copy of the data
    const data = JSON.parse(JSON.stringify(base));
    
    // Ensure nested objects exist
    if (!data.weightDistribution) data.weightDistribution = { ...DEFAULT_CONFIG.weightDistribution };
    if (!data.botFunds) data.botFunds = { ...DEFAULT_CONFIG.botFunds };
    if (!data.activeOrders) data.activeOrders = { ...DEFAULT_CONFIG.activeOrders };
    
    // Set other defaults if missing
    if (data.active === undefined) data.active = DEFAULT_CONFIG.active;
    if (data.dryRun === undefined) data.dryRun = DEFAULT_CONFIG.dryRun;
    if (data.minPrice === undefined) data.minPrice = DEFAULT_CONFIG.minPrice;
    if (data.maxPrice === undefined) data.maxPrice = DEFAULT_CONFIG.maxPrice;
    if (data.incrementPercent === undefined) data.incrementPercent = DEFAULT_CONFIG.incrementPercent;
    if (data.targetSpreadPercent === undefined) data.targetSpreadPercent = DEFAULT_CONFIG.targetSpreadPercent;
    if (data.startPrice === undefined) data.startPrice = data.startPrice || DEFAULT_CONFIG.startPrice || 'pool';

    let finished = false;
    let cancelled = false;

    while (!finished) {
        console.log('\n\x1b[1m--- Bot Editor: ' + (data.name || 'New Bot') + ' ---\x1b[0m');
        console.log(`\x1b[36m1) Pair:\x1b[0m       \x1b[32m${data.assetA || '?'} / ${data.assetB || '?'} \x1b[0m`);
        console.log(`\x1b[36m2) Identity:\x1b[0m   \x1b[33mName:\x1b[0m ${data.name || '?'} , \x1b[33mAccount:\x1b[0m ${data.preferredAccount || '?'} , \x1b[33mActive:\x1b[0m ${data.active}, \x1b[33mDryRun:\x1b[0m ${data.dryRun}`);
        console.log(`\x1b[36m3) Price:\x1b[0m      \x1b[33mRange:\x1b[0m [${data.minPrice} - ${data.maxPrice}], \x1b[33mStart:\x1b[0m ${data.startPrice}`);
        console.log(`\x1b[36m4) Grid:\x1b[0m       \x1b[33mWeights:\x1b[0m (S:${data.weightDistribution.sell}, B:${data.weightDistribution.buy}), \x1b[33mIncr:\x1b[0m ${data.incrementPercent}%, \x1b[33mSpread:\x1b[0m ${data.targetSpreadPercent}%`);
        console.log(`\x1b[36m5) Funding:\x1b[0m    \x1b[33mSell:\x1b[0m ${data.botFunds.sell}, \x1b[33mBuy:\x1b[0m ${data.botFunds.buy} | \x1b[33mOrders:\x1b[0m (S:${data.activeOrders.sell}, B:${data.activeOrders.buy})`);
        console.log('--------------------------------------------------');
        console.log('\x1b[32mS) Save & Exit\x1b[0m');
        console.log('\x1b[31mC) Cancel (Discard changes)\x1b[0m');

        const choice = readlineSync.question('\nSelect section to edit or action: ').trim().toLowerCase();

        switch (choice) {
            case '1':
                data.assetA = await askAsset('Asset A for selling', data.assetA);
                data.assetB = await askAssetB('Asset B for buying', data.assetB, data.assetA);
                break;
            case '2':
                data.name = askRequiredString('Bot name', data.name);
                data.preferredAccount = askRequiredString('Preferred account', data.preferredAccount);
                data.active = askBoolean('Active', data.active);
                data.dryRun = askBoolean('Dry run', data.dryRun);
                break;
            case '3':
                data.minPrice = askNumberOrMultiplier('minPrice', data.minPrice);
                data.maxPrice = askMaxPrice('maxPrice', data.maxPrice, data.minPrice);
                data.startPrice = askStartPrice('startPrice (pool, market or A/B)', data.startPrice);
                break;
            case '4':
                data.weightDistribution.sell = askWeightDistribution('Weight distribution (sell)', data.weightDistribution.sell);
                data.weightDistribution.buy = askWeightDistributionNoLegend('Weight distribution (buy)', data.weightDistribution.buy);
                data.incrementPercent = askNumberWithBounds('incrementPercent', data.incrementPercent, 0.01, 10);
                const defaultSpread = data.targetSpreadPercent || data.incrementPercent * 4;
                data.targetSpreadPercent = askTargetSpreadPercent('targetSpread %', defaultSpread, data.incrementPercent);
                break;
            case '5':
                data.botFunds.sell = askNumberOrPercentage('botFunds sell amount', data.botFunds.sell);
                data.botFunds.buy = askNumberOrPercentage('botFunds buy amount', data.botFunds.buy);
                data.activeOrders.sell = askIntegerInRange('activeOrders sell count', data.activeOrders.sell, 1, 100);
                data.activeOrders.buy = askIntegerInRange('activeOrders buy count', data.activeOrders.buy, 1, 100);
                break;
            case 's':
                // Final basic validation before saving
                if (!data.name || !data.assetA || !data.assetB || !data.preferredAccount) {
                    console.log('\x1b[31mError: Name, Pair, and Account are required before saving.\x1b[0m');
                    break;
                }
                finished = true;
                break;
            case 'c':
                if (askBoolean('Discard all changes?', false)) {
                    finished = true;
                    cancelled = true;
                }
                break;
            default:
                console.log('Invalid choice.');
        }
    }

    if (cancelled) return null;

    // Return the final data structure
    return {
        name: data.name,
        active: data.active,
        dryRun: data.dryRun,
        preferredAccount: data.preferredAccount,
        assetA: data.assetA,
        assetB: data.assetB,
        startPrice: data.startPrice,
        minPrice: data.minPrice,
        maxPrice: data.maxPrice,
        incrementPercent: data.incrementPercent,
        targetSpreadPercent: data.targetSpreadPercent,
        weightDistribution: data.weightDistribution,
        botFunds: data.botFunds,
        activeOrders: data.activeOrders
    };
}

async function promptGeneralSettings() {
    const settings = loadGeneralSettings();
    let finished = false;

    while (!finished) {
        console.log('\n\x1b[1m--- General Settings (Global) ---\x1b[0m');
        console.log(`\x1b[36m1) Grid:\x1b[0m          \x1b[33mCache:\x1b[0m ${settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE}%, \x1b[33mRMS:\x1b[0m ${settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE}%, \x1b[33mDust:\x1b[0m ${settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE}%`);
        console.log(`\x1b[36m2) Timing:\x1b[0m        \x1b[33mFetchInterval:\x1b[0m ${settings.TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN}min, \x1b[33mSyncDelay:\x1b[0m ${settings.TIMING.SYNC_DELAY_MS}ms`);
        console.log(`\x1b[36m3) Log lvl:\x1b[0m       \x1b[33m${settings.LOG_LEVEL}\x1b[0m (debug, info, warn, error)`);
        console.log('--------------------------------------------------');
        console.log('\x1b[32mS) Save & Exit\x1b[0m');
        console.log('\x1b[31mC) Cancel (Discard changes)\x1b[0m');

        const choice = readlineSync.question('\nSelect section to edit or action: ').trim().toLowerCase();

        switch (choice) {
            case '1':
                settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE = askNumberWithBounds('Grid Cache Regeneration %', settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE, 0.1, 50);
                settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE = askNumberWithBounds('RMS Divergence Threshold %', settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE, 1, 100);
                settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE = askNumberWithBounds('Partial Dust Threshold %', settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE, 0.1, 50);
                break;
            case '2':
                settings.TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN = askNumberWithBounds('Blockchain Fetch Interval (min)', settings.TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN, 1, 1440);
                settings.TIMING.SYNC_DELAY_MS = askNumberWithBounds('Sync Delay (ms)', settings.TIMING.SYNC_DELAY_MS, 100, 10000);
                break;
            case '3':
                const levels = ['debug', 'info', 'warn', 'error'];
                console.log(`Available levels: ${levels.join(', ')}`);
                const newLevel = askString('Enter log level', settings.LOG_LEVEL).toLowerCase();
                if (levels.includes(newLevel)) {
                    settings.LOG_LEVEL = newLevel;
                } else {
                    console.log('Invalid log level.');
                }
                break;
            case 's':
                saveGeneralSettings(settings);
                finished = true;
                break;
            case 'c':
                if (askBoolean('Discard all changes?', false)) {
                    finished = true;
                }
                break;
            default:
                console.log('Invalid choice.');
        }
    }
}

// Entry point exposing a menu-driven interface for creating, modifying, and reviewing bots.
async function main() {
    console.log('dexbot bots — bots.json configurator (writes profiles/bots.json)');
    const { config, filePath } = loadBotsConfig();
    let exit = false;
    while (!exit) {
        console.log('\nActions:');
        console.log('  1) New bot');
        console.log('  2) Modify bot');
        console.log('  3) Delete bot');
        console.log('  4) Copy bot');
        console.log('  5) List bots');
        console.log('  6) General settings');
        console.log('  7) Exit');
        const selection = readlineSync.question('Choose an action [1-7]: ').trim();
        console.log('');
        switch (selection) {
            case '1': {
                try {
                    const entry = await promptBotData();
                    if (entry) {
                        config.bots.push(entry);
                        saveBotsConfig(config, filePath);
                        console.log(`\nAdded bot '${entry.name}' to ${path.basename(filePath)}.`);
                    }
                } catch (err) {
                    console.log(`\n❌ Invalid input: ${err.message}\n`);
                }
                break;
            }
            case '2': {
                const idx = selectBotIndex(config.bots, 'Select bot to modify');
                if (idx === null) break;
                try {
                    const entry = await promptBotData(config.bots[idx]);
                    if (entry) {
                        config.bots[idx] = entry;
                        saveBotsConfig(config, filePath);
                        console.log(`\nUpdated bot '${entry.name}' in ${path.basename(filePath)}.`);
                    }
                } catch (err) {
                    console.log(`\n❌ Invalid input: ${err.message}\n`);
                }
                break;
            }
            case '3': {
                const idx = selectBotIndex(config.bots, 'Select bot to delete');
                if (idx === null) break;
                const placeholderName = config.bots[idx].name || `<unnamed-${idx + 1}>`;
                const confirm = askBoolean(`Delete '${placeholderName}'?`, false);
                if (confirm) {
                    const removed = config.bots.splice(idx, 1)[0];
                    saveBotsConfig(config, filePath);
                    console.log(`\nRemoved bot '${removed.name || placeholderName}' from ${path.basename(filePath)}.`);
                } else {
                    console.log('\nDeletion cancelled.');
                }
                break;
            }
            case '4': {
                const idx = selectBotIndex(config.bots, 'Select bot to copy');
                if (idx === null) break;
                try {
                    const entry = await promptBotData(config.bots[idx]);
                    if (entry) {
                        config.bots.splice(idx + 1, 0, entry);
                        saveBotsConfig(config, filePath);
                        console.log(`\nCopied bot '${entry.name}' into ${path.basename(filePath)}.`);
                    }
                } catch (err) {
                    console.log(`\n❌ Invalid input: ${err.message}\n`);
                }
                break;
            }
            case '5':
                listBots(config.bots);
                break;
            case '6':
                await promptGeneralSettings();
                break;
            case '7':
                exit = true;
                break;
            default:
                console.log('Unknown selection.');
        }
    }
    console.log('Botmanager closed!');
}

module.exports = { main, parseJsonWithComments };
