#!/usr/bin/env node
/**
 * DEXBot2 - Primary CLI driver for automated BitShares DEX market making
 * 
 * This is the main entry point that manages tracked bots and provides helper
 * utilities such as key/bot editors. The bot creates grid-based limit orders
 * across a price range and automatically replaces filled orders.
 * 
 * Main features:
 * - Grid-based order placement with configurable spread and increment
 * - Automatic order replacement when fills occur
 * - Master password encryption for private keys
 * - Dry-run mode for testing without broadcasting transactions
 * - CLI commands: start, drystart, reset, disable, keys, bots
 */
const { BitShares, waitForConnected, setSuppressConnectionLog } = require('./modules/bitshares_client');
const fs = require('fs');
const path = require('path');
const readline = require('readline-sync');
const chainOrders = require('./modules/chain_orders');
const chainKeys = require('./modules/chain_keys');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./modules/order');
const { retryPersistenceIfNeeded } = OrderUtils;
const { ORDER_STATES } = require('./modules/constants');
const { reconcileStartupOrders, attemptResumePersistedGridByPriceMatch, decideStartupGridAction } = require('./modules/order/startup_reconcile');
const accountKeys = require('./modules/chain_keys');
const accountBots = require('./modules/account_bots');
const { parseJsonWithComments } = accountBots;
const { AccountOrders, createBotKey } = require('./modules/account_orders');
const SharedDEXBot = require('./modules/dexbot_class');

// Note: accountOrders is now per-bot only. Each bot has its own AccountOrders instance
// created in DEXBot.start() (line 663). This eliminates shared-file race conditions.

// Primary CLI driver that manages tracked bots and helper utilities such as key/bot editors.
const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

// Initialize profiles directory if it doesn't exist
function ensureProfilesDirectory() {
    if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
        console.log('✓ Created profiles directory');
        return true;
    }
    return false;
}


const CLI_COMMANDS = ['start', 'reset', 'disable', 'drystart', 'keys', 'bots', 'pm2'];
const CLI_HELP_FLAGS = ['-h', '--help'];
const CLI_EXAMPLES_FLAG = '--cli-examples';
const CLI_EXAMPLES = [
    { title: 'Start a bot from the tracked config', command: 'dexbot start bot-name', notes: 'Targets the named entry in profiles/bots.json.' },
    { title: 'Dry-run a bot without broadcasting', command: 'dexbot drystart bot-name', notes: 'Forces the run into dry-run mode even if the stored config was live.' },
    { title: 'Disable a bot in config', command: 'dexbot disable bot-name', notes: 'Marks the bot inactive in config.' },
    { title: 'Reset a bot grid', command: 'dexbot reset bot-name', notes: 'Triggers a full grid regeneration for the named bot.' },
    { title: 'Manage keys', command: 'dexbot keys', notes: 'Runs modules/chain_keys.js to add or update master passwords.' },
    { title: 'Edit bot definitions', command: 'dexbot bots', notes: 'Launches the interactive modules/account_bots.js helper for the JSON config.' },
    { title: 'Start bots with PM2', command: 'dexbot pm2', notes: 'Generates ecosystem config, authenticates, and starts PM2.' }
];
const cliArgs = process.argv.slice(2);

// Show the CLI usage/help text when requested or upon invalid commands.
function printCLIUsage() {
    console.log('Usage: dexbot [command] [bot-name]');
    console.log('Commands:');
    console.log('  start <bot>       Start the named bot using the tracked config.');
    console.log('  drystart <bot>    Same as start but forces dry-run execution.');
    console.log('  reset <bot>       Trigger a grid reset (auto-reloads if running, or applies on next start).');
    console.log('  disable <bot>     Mark the bot inactive in config.');
    console.log('  keys              Launch the chain key helper (modules/chain_keys.js).');
    console.log('  bots              Launch the interactive bot configurator (modules/account_bots.js).');
    console.log('  pm2               Start all active bots with PM2 (authenticate + generate config + start).');
    console.log('Options:');
    console.log('  --cli-examples    Print curated CLI snippets.');
    console.log('  -h, --help        Show this help text.');
    console.log('Envs: RUN_LOOP_MS controls the polling delay; LIVE_BOT_NAME or BOT_NAME selects a single entry.');
}

// Print curated CLI snippets for quick reference.
function printCLIExamples() {
    console.log('CLI Examples:');
    CLI_EXAMPLES.forEach((example, index) => {
        console.log(`${index + 1}. ${example.title}`);
        console.log(`   ${example.command}`);
        if (example.notes) console.log(`   ${example.notes}`);
    });
    console.log(`Read the README “CLI usage” section for more details (file: ${PROFILES_BOTS_FILE}).`);
}

if (cliArgs.some(arg => CLI_HELP_FLAGS.includes(arg))) {
    printCLIUsage();
    process.exit(0);
}

if (cliArgs.includes(CLI_EXAMPLES_FLAG)) {
    printCLIExamples();
    process.exit(0);
}

// `parseJsonWithComments` is provided by `modules/account_bots.js` (shared single-source)

// Load the tracked bot settings file, handling missing files or parse failures gracefully.
function loadSettingsFile({ silent = false } = {}) {
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        if (!silent) {
            console.error('profiles/bots.json not found. Run `npm run bootstrap:profiles` to create it from the tracked examples.');
        }
        return { config: {}, filePath: PROFILES_BOTS_FILE };
    }
    try {
        const content = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
        if (!content || !content.trim()) return { config: {}, filePath: PROFILES_BOTS_FILE };
        return { config: parseJsonWithComments(content), filePath: PROFILES_BOTS_FILE };
    } catch (err) {
        console.warn('Failed to load bot settings from', PROFILES_BOTS_FILE, '-', err.message);
        return { config: {}, filePath: PROFILES_BOTS_FILE };
    }
}

// Persist the tracked bot settings to disk when users edit via CLI.
function saveSettingsFile(config, filePath) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Failed to save bot settings to', filePath, '-', err.message);
        throw err;
    }
}

// Normalize the root data structure so we always operate on an array of bot entries.
function resolveRawBotEntries(settings) {
    if (!settings || typeof settings !== 'object') return [];
    if (Array.isArray(settings.bots)) return settings.bots;
    if (Object.keys(settings).length > 0) return [settings];
    return [];
}

// Decorate each bot entry with metadata (botKey, index, default active) for runtime use.
function normalizeBotEntries(rawEntries) {
    return rawEntries.map((entry, index) => {
        const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
        return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
    });
}

// Connection handled centrally by modules/bitshares_client; use waitForConnected() when needed

/**
 * DEXBot - Core trading bot class that manages grid-based market making
 * 
 * Responsibilities:
 * - Initializes connection to BitShares and authenticates account
 * - Creates and manages an OrderManager instance for grid operations
 * - Places initial orders and listens for fills to replace them
 * - Handles grid synchronization with on-chain state
 * - Supports dry-run mode for testing without broadcasting
 * 
 * @class
 */
// Extend SharedDEXBot for dexbot.js context (currently just a thin wrapper)
class DEXBot extends SharedDEXBot {
    constructor(config) {
        super(config, { logPrefix: '' });
    }
}

let accountKeysAutostarted = false;

// Launch the account key manager helper with optional BitShares handshake and cleanup.
async function runAccountManager({ waitForConnection = false, exitAfter = false, disconnectAfter = false } = {}) {
    if (waitForConnection) {
        try {
            await waitForConnected();
        } catch (err) {
            console.warn('Timed out waiting for BitShares connection before launching key manager.');
        }
    }

    let succeeded = false;
    try {
        await accountKeys.main();
        succeeded = true;
    } finally {
        if (disconnectAfter) {
            try {
                BitShares.disconnect();
            } catch (err) {
                console.warn('Failed to disconnect BitShares connection after key manager exited:', err.message || err);
            }
        }
    }

    if (exitAfter && succeeded) {
        process.exit(0);
    }
}

/**
 * Handle master password authentication with auto-launch fallback.
 * If no master password is set, automatically launches the key manager
 * to guide the user through initial setup.
 * @returns {Promise<string>} The authenticated master password
 */
async function authenticateMasterPassword() {
    try {
        return await chainKeys.authenticate();
    } catch (err) {
        if (!accountKeysAutostarted && err && err.message && err.message.includes('No master password set')) {
            accountKeysAutostarted = true;
            console.log('no master password set');
            console.log('autostart account keys');
            await runAccountManager();
            return await chainKeys.authenticate();
        }
        throw err;
    }
}

/**
 * Validate a bot configuration entry for required fields.
 * Checks for: assetA, assetB, activeOrders (buy/sell), botFunds (buy/sell)
 * @param {Object} b - Bot entry from bots.json
 * @param {number} i - Index in the bots array
 * @param {string} src - Source name for error messages
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateBotEntry(b, i, src) {
    const problems = [];
    const required = ['assetA', 'assetB', 'activeOrders', 'botFunds'];
    for (const k of required) {
        if (!(k in b)) problems.push(`missing '${k}'`);
    }

    if ('activeOrders' in b) {
        if (typeof b.activeOrders !== 'object' || b.activeOrders === null) problems.push("'activeOrders' must be an object");
        else {
            if (!('buy' in b.activeOrders)) problems.push("activeOrders missing 'buy'");
            if (!('sell' in b.activeOrders)) problems.push("activeOrders missing 'sell'");
        }
    }

    if ('botFunds' in b) {
        if (typeof b.botFunds !== 'object' || b.botFunds === null) problems.push("'botFunds' must be an object");
        else {
            if (!('buy' in b.botFunds)) problems.push("botFunds missing 'buy'");
            if (!('sell' in b.botFunds)) problems.push("botFunds missing 'sell'");
        }
    }

    if (problems.length) {
        const name = b.name || `<unnamed-${i}>`;
        return `Bot[${i}] '${name}' (${src}) -> ${problems.join('; ')}`;
    }
    return null;
}

function collectValidationIssues(entries, sourceName) {
    const errors = [];
    const warnings = [];
    entries.forEach((entry, index) => {
        const issue = validateBotEntry(entry, index, sourceName);
        if (issue) {
            if (entry.active) errors.push(issue);
            else warnings.push(issue);
        }
    });
    return { errors, warnings };
}

/**
 * Execute the provided bot entries after validation and authentication.
 * This is the main orchestration function that:
 * 1. Validates all bot configurations
 * 2. Prompts for master password if any bot needs it
 * 3. Creates DEXBot instances and starts them
 * 
 * @param {Array} botEntries - Array of normalized bot configurations
 * @param {Object} options - Execution options
 * @param {boolean} options.forceDryRun - Force all bots into dry-run mode
 * @param {string} options.sourceName - Source label for logging
 * @returns {Promise<Array>} Array of started DEXBot instances
 */
async function runBotInstances(botEntries, { forceDryRun = false, sourceName = 'settings' } = {}) {
    if (!botEntries.length) {
        console.log(`No bot entries were found in ${sourceName}.`);
        return [];
    }

    const prepared = botEntries.map(entry => ({
        ...entry,
        dryRun: forceDryRun ? true : entry.dryRun,
    }));

    // Note: ensureBotEntries is no longer needed here. Each bot creates its own AccountOrders
    // instance with per-bot file when it starts, eliminating the need for shared initialization.

    const { errors, warnings } = collectValidationIssues(prepared, sourceName);
    if (warnings.length) {
        console.warn(`Found problems in inactive bot entries (${sourceName}):`);
        warnings.forEach(w => console.warn('  -', w));
    }

    if (errors.length) {
        console.error('ERROR: Invalid configuration for one or more **active** bots:');
        errors.forEach(e => console.error('  -', e));
        console.error('Fix the configuration problems in profiles/bots.json and restart. Aborting.');
        process.exit(1);
    }

    const needMaster = prepared.some(b => b.active && b.preferredAccount);
    let masterPassword = null;
    if (needMaster) {
        try {
            await waitForConnected();
        } catch (err) {
            console.warn('Timed out waiting for BitShares connection before prompting for master password.');
        }
        try {
            masterPassword = await authenticateMasterPassword();
        } catch (err) {
            console.warn('Master password entry failed or was cancelled. Bots requiring preferredAccount may need interactive selection.');
            masterPassword = null;
        }
    }

    // Fee cache is required for fill processing (getAssetFees), including offline fill reconciliation at startup.
    // Initialize it once per process for the assets used by active bots.
    try {
        await waitForConnected();
        await OrderUtils.initializeFeeCache(prepared.filter(b => b.active), BitShares);
    } catch (err) {
        console.warn(`Fee cache initialization failed: ${err.message}`);
    }

    const instances = [];
    for (const entry of prepared) {
        if (!entry.active) {
            console.log('Skipping inactive bot entry (active=false) — settings preserved.');
            continue;
        }

        try {
            const bot = new DEXBot(entry);
            await bot.start(masterPassword);
            instances.push(bot);
        } catch (err) {
            console.error('Failed to start bot:', err.message);
            if (err && err instanceof chainKeys.MasterPasswordError) {
                console.error('Aborting because the master password failed 3 times.');
                process.exit(1);
            }
            if (err && err.message && String(err.message).toLowerCase().includes('marketprice')) {
                console.info('Hint: startPrice could not be derived.');
                console.info(' - If using profiles/bots.json with "pool" or "market" signals, ensure the chain contains a matching liquidity pool or orderbook for the configured pair.');
                console.info(' - Alternatively, set a numeric `startPrice` directly in profiles/bots.json for this bot to avoid auto-derive.');
                console.info(' - You can also set LIVE_BOT_NAME or BOT_NAME to select a different bot from the profiles settings.');
            }
        }
    }

    if (instances.length === 0) {
        console.log('No active bots were started. Check bots.json and ensure at least one bot is active.');
    }

    return instances;
}

/**
 * Start a specific bot by name or all active bots if no name provided.
 * Looks up the bot in profiles/bots.json and starts it.
 * @param {string|null} botName - Name of the bot to start, or null for all active
 * @param {Object} options - Start options
 * @param {boolean} options.dryRun - Run in dry-run mode (no broadcasts)
 */
async function startBotByName(botName, { dryRun = false } = {}) {
    if (!botName) {
        return runDefaultBots({ forceDryRun: dryRun, sourceName: dryRun ? 'CLI drystart (all)' : 'CLI start (all)' });
    }
    const { config } = loadSettingsFile();
    const entries = resolveRawBotEntries(config);
    if (!entries.length) {
        console.error('No bot definitions exist in the tracked settings.');
        process.exit(1);
    }
    const match = entries.find(b => b.name === botName);
    if (!match) {
        console.error(`Could not find any bot named '${botName}' in the tracked settings.`);
        process.exit(1);
    }
    const entryCopy = JSON.parse(JSON.stringify(match));
    entryCopy.active = true;
    if (dryRun) entryCopy.dryRun = true;
    const normalized = normalizeBotEntries([entryCopy]);
    await runBotInstances(normalized, { forceDryRun: dryRun, sourceName: dryRun ? 'CLI drystart' : 'CLI start' });
}

/**
 * Mark a bot (or all bots) as inactive in profiles/bots.json.
 * Note: This only updates the config file; running processes must be
 * stopped separately using pm2.js or Ctrl+C.
 * @param {string|null} botName - Name of the bot to disable, or null for all
 */
async function disableBotByName(botName) {
    const { config, filePath } = loadSettingsFile();
    const entries = resolveRawBotEntries(config);
    if (!botName) {
        let updated = false;
        entries.forEach(entry => {
            if (entry.active) {
                entry.active = false;
                updated = true;
            }
        });
        if (!updated) {
            console.log('No active bots were found to disable.');
            return;
        }
        saveSettingsFile(config, filePath);
        console.log(`Marked all bots inactive in ${path.basename(filePath)}.`);
        return;
    }
    const match = entries.find(b => b.name === botName);
    if (!match) {
        console.error(`Could not find any bot named '${botName}' to disable.`);
        process.exit(1);
    }
    if (!match.active) {
        console.log(`Bot '${botName}' is already inactive.`);
        return;
    }
    match.active = false;
    saveSettingsFile(config, filePath);
    console.log(`Marked '${botName}' inactive in ${path.basename(filePath)}. Stop the PM2 process using 'node pm2.js stop ${botName}'.`);
}

/**
 * Reset a bot by regenerating its grid and starting it fresh.
 * This method creates a trigger file that signals the bot instance
 * (whether running locally or via PM2) to perform a full grid resync.
 *
 * 1. Creates profiles/recalculate.<botKey>.trigger
 * 2. If bot is running, it detects file -> resyncs grid -> deletes file
 * 3. If bot is stopped, it detects file on startup -> resyncs grid -> deletes file
 *
 * @param {string|null} botName - Name of the bot to reset, or null for all active
 */
async function resetBotByName(botName) {
    const { config } = loadSettingsFile();
    const entries = normalizeBotEntries(resolveRawBotEntries(config));

    // Filter targets
    const targets = botName ? entries.filter(b => b.name === botName) : entries.filter(b => b.active);
    if (botName && targets.length === 0) {
        console.error(`Could not find any bot named '${botName}' to reset.`);
        process.exit(1);
    }

    console.log(`Setting regeneration trigger for ${targets.length} bot(s)...`);

    for (const bot of targets) {
        try {
            const triggerFile = path.join(PROFILES_DIR, `recalculate.${bot.botKey}.trigger`);
            fs.writeFileSync(triggerFile, '');
            console.log(`✓ Trigger set for '${bot.name}' (${path.basename(triggerFile)})`);
        } catch (err) {
            console.warn(`Failed to set trigger for '${bot.name}': ${err.message}`);
        }
    }

    console.log();
    console.log('Action complete.');
    console.log('- If the bot is running (CLI or PM2), it will detect the trigger and reset automatically.');
    console.log('- If the bot is stopped, the grid will be regenerated the next time you run `dexbot start`.');
}

/**
 * Parse and execute CLI commands.
 * Supported commands: start, drystart, reset, stop, keys, bots
 * @returns {Promise<boolean>} True if a command was handled, false otherwise
 */
async function handleCLICommands() {
    if (!cliArgs.length) return false;
    const [command, target] = cliArgs;
    if (!CLI_COMMANDS.includes(command)) {
        console.error(`Unknown command '${command}'.`);
        printCLIUsage();
        process.exit(1);
    }
    switch (command) {
        case 'start':
            await startBotByName(target, { dryRun: false });
            return true;
        case 'drystart':
            await startBotByName(target, { dryRun: true });
            return true;
        case 'reset':
            await resetBotByName(target);
            process.exit(0);
        case 'disable':
            await disableBotByName(target);
            process.exit(0);
        case 'keys':
            await runAccountManager({ waitForConnection: true, exitAfter: true, disconnectAfter: true });
            return true;
        case 'bots':
            await accountBots.main();
            try {
                BitShares.disconnect();
            } catch (err) {
                console.warn('Failed to disconnect BitShares after bot helper exit:', err && err.message ? err.message : err);
            }
            process.exit(0);
            return true;
        case 'pm2':
            try {
                const pm2Launcher = require('./pm2.js');
                await pm2Launcher.main();
                // Close stdin and exit cleanly after PM2 startup
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } catch (err) {
                console.error('Error:', err.message);
                process.exit(1);
            }
            return true;
        default:
            printCLIUsage();
            process.exit(1);
    }
}

// Run whatever bots are marked active in the tracked settings file.
async function runDefaultBots({ forceDryRun = false, sourceName = 'settings' } = {}) {
    const { config } = loadSettingsFile();
    const entries = resolveRawBotEntries(config);
    const normalized = normalizeBotEntries(entries);
    await runBotInstances(normalized, { forceDryRun, sourceName });
}

// Entry point combining CLI shortcuts and default bot execution.
async function bootstrap() {
    // Ensure profiles directory exists
    const isNewSetup = ensureProfilesDirectory();

    // If this is a new setup, prompt to set up keys
    if (isNewSetup) {
        // Suppress BitShares connection log during first-time setup
        setSuppressConnectionLog(true);
        console.log();
        console.log('='.repeat(50));
        console.log('Welcome to DEXBot2!');
        console.log('='.repeat(50));
        console.log();
        console.log('To get started, you need to configure your master password.');
        console.log('This password will encrypt your private keys.');
        console.log();
        const setupKeys = readline.keyInYN('Set up master password now?');
        if (setupKeys) {
            console.log();
            await accountKeys.main();
            console.log();
            console.log('Master password configured! Now you can:');
            console.log('  node dexbot bots   - Create and manage bots');
            console.log('  node dexbot        - Run your configured bots');
            console.log();
        } else {
            console.log();
            console.log('You can set up your master password later by running:');
            console.log('  node dexbot keys');
            console.log();
        }
        return;
    }

    // Handle CLI commands first (before checking for bots.json)
    if (await handleCLICommands()) return;

    // Check if bots.json exists - if not, guide user
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        // Suppress BitShares connection log when no bots configured
        setSuppressConnectionLog(true);
        console.log();
        console.log('No bot configuration found.');
        console.log();
        console.log('First, set up your master password:');
        console.log('  node dexbot keys');
        console.log();
        console.log('Then, create your first bot:');
        console.log('  node dexbot bots');
        console.log();
        process.exit(0);
    }

    await runDefaultBots();
}

bootstrap().catch(console.error);
