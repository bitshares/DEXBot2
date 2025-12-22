#!/usr/bin/env node
/**
 * bot.js - PM2-friendly entry point for single bot instance
 *
 * Standalone bot launcher executed by PM2 for each configured bot.
 * Handles bot initialization, authentication, and trading loop management.
 *
 * 1. Bot Configuration Loading
 *    - Reads bot settings from profiles/bots.json by bot name (from argv)
 *    - Validates bot exists in configuration
 *    - Reports market pair and account being used
 *
 * 2. Master Password Authentication
 *    - First checks MASTER_PASSWORD environment variable (set by pm2.js)
 *    - Falls back to interactive prompt if env var not set
 *    - Suppresses BitShares client logs during password entry
 *    - Password never written to disk
 *
 * 3. Bot Initialization
 *    - Waits for BitShares connection (30 second timeout)
 *    - Loads private key for configured account
 *    - Resolves account ID from BitShares
 *    - Initializes OrderManager with bot configuration
 *
 * 4. Grid Initialization or Resume
 *    - Loads persisted grid if it exists and matches on-chain orders
 *    - Places initial orders if no existing grid found
 *    - Synchronizes grid state with BitShares blockchain
 *
 * 5. Trading Loop
 *    - Continuously monitors for fill events
 *    - Updates order status from chain
 *    - Regenerates grid as needed
 *    - Runs indefinitely (PM2 manages restart/stop)
 *
 * Usage:
 *   Direct (single bot): node bot.js <bot-name>
 *   Via PM2 ecosystem: pm2 start profiles/ecosystem.config.js
 *   Full setup: npm run pm2:unlock-start or node dexbot.js pm2
 *
 * Environment Variables:
 *   MASTER_PASSWORD - Master password for account (set by pm2.js)
 *   RUN_LOOP_MS     - Trading loop interval in ms (default: 5000)
 *   BOT_NAME        - Bot name (alternative to argv)
 *
 * Logs:
 *   - Bot output: profiles/logs/{botname}.log
 *   - Bot errors: profiles/logs/{botname}-error.log
 *   - Rotated automatically by PM2
 *
 * Security:
 *   - Master password from environment variable (RAM only)
 *   - No password written to disk
 *   - Private key loaded into memory
 *   - All sensitive operations in encrypted BitShares module
 */

const fs = require('fs');
const path = require('path');
const DEXBot = require('./modules/dexbot_class');
const accountBots = require('./modules/account_bots');
const { parseJsonWithComments } = accountBots;
const { createBotKey } = require('./modules/account_orders');

const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');

// Get bot name from args or environment
let botNameArg = process.argv[2];
if (botNameArg && botNameArg.startsWith('--')) {
    botNameArg = botNameArg.substring(2);
}
const botNameEnv = process.env.BOT_NAME || process.env.PREFERRED_ACCOUNT;
const botName = botNameArg || botNameEnv;

if (!botName) {
    console.error('[bot.js] No bot name provided. Usage: node bot.js <bot-name>');
    console.error('[bot.js] Or set BOT_NAME or PREFERRED_ACCOUNT environment variable');
    process.exit(1);
}

console.log(`[bot.js] Starting bot: ${botName}`);

// Load bot configuration from profiles/bots.json
function loadBotConfig(name) {
    if (!fs.existsSync(PROFILES_BOTS_FILE)) {
        console.error('[bot.js] profiles/bots.json not found. Run: npm run bootstrap:profiles');
        process.exit(1);
    }

    try {
        const content = fs.readFileSync(PROFILES_BOTS_FILE, 'utf8');
        const config = parseJsonWithComments(content);
        const bots = config.bots || [];
        const botEntry = bots.find(b => b.name === name);

        if (!botEntry) {
            console.error(`[bot.js] Bot '${name}' not found in profiles/bots.json`);
            console.error(`[bot.js] Available bots: ${bots.map(b => b.name).join(', ') || 'none'}`);
            process.exit(1);
        }

        return botEntry;
    } catch (err) {
        console.error(`[bot.js] Error loading bot config:`, err.message);
        process.exit(1);
    }
}

// Authenticate master password
async function authenticateMasterPassword() {
    const chainKeys = require('./modules/chain_keys');
    // Check environment variable first
    if (process.env.MASTER_PASSWORD) {
        console.log('[bot.js] Master password loaded from environment');
        return process.env.MASTER_PASSWORD;
    }

    // Try interactive prompt
    try {
        console.log('[bot.js] Prompting for master password...');

        // Suppress BitShares client logs during password prompt
        const originalLog = console.log;
        console.log = (...args) => {
            const msg = args.join(' ');
            if (!msg.includes('bitshares_client') && !msg.includes('modules/')) {
                originalLog(...args);
            }
        };

        const masterPassword = await chainKeys.authenticate();

        // Restore console output
        console.log = originalLog;
        console.log('[bot.js] Master password authenticated successfully');
        return masterPassword;
    } catch (err) {
        if (err && err.message && err.message.includes('No master password set')) {
            console.error('[bot.js] No master password set. Run: node dexbot.js keys');
            process.exit(1);
        }
        throw err;
    }
}

// Normalize bot entry with metadata
function normalizeBotEntry(entry, index = 0) {
    const normalized = { active: entry.active === undefined ? true : !!entry.active, ...entry };
    return { ...normalized, botIndex: index, botKey: createBotKey(normalized, index) };
}

// Main entry point
(async () => {
    try {
        // Load bot configuration
        const botConfig = loadBotConfig(botName);
        console.log(`[bot.js] Loaded configuration for bot: ${botName}`);
        console.log(`[bot.js] Market: ${botConfig.assetA}-${botConfig.assetB}, Account: ${botConfig.preferredAccount}`);

        // Load all bots from configuration to prevent pruning other active bots
        const allBotsConfig = parseJsonWithComments(fs.readFileSync(PROFILES_BOTS_FILE, 'utf8')).bots || [];
        const allActiveBots = allBotsConfig
            .filter(b => b.active !== false)
            .map((b, idx) => normalizeBotEntry(b, idx));

        // Find the correct index for the current bot in the bots.json list
        const botIndex = allBotsConfig.findIndex(b => b.name === botName);
        if (botIndex === -1) {
            throw new Error(`Bot "${botName}" not found in ${PROFILES_BOTS_FILE}`);
        }

        // Normalize config for current bot with correct index
        const normalizedConfig = normalizeBotEntry(botConfig, botIndex);

        // Authenticate master password
        const masterPassword = await authenticateMasterPassword();

        // Create and start bot with log prefix for [bot.js] context
        const bot = new DEXBot(normalizedConfig, { logPrefix: '[bot.js]' });
        await bot.start(masterPassword);

    } catch (err) {
        console.error('[bot.js] Failed to start bot:', err.message);
        process.exit(1);
    }
})();
