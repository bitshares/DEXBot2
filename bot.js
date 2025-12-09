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
 *   Direct (single bot): node bot.js bbot9
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
const { BitShares, waitForConnected } = require('./modules/bitshares_client');
const chainKeys = require('./modules/chain_keys');
const chainOrders = require('./modules/chain_orders');
const { OrderManager, grid: Grid, utils: OrderUtils } = require('./modules/order');
const { ORDER_STATES } = require('./modules/order/constants');
const { AccountOrders, createBotKey } = require('./modules/account_orders');
const accountBots = require('./modules/account_bots');
const { parseJsonWithComments } = accountBots;

const PROFILES_BOTS_FILE = path.join(__dirname, 'profiles', 'bots.json');
const PROFILES_DIR = path.join(__dirname, 'profiles');

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

const accountOrders = new AccountOrders();

/**
 * DEXBot - Core trading bot class (copied from dexbot.js)
 */
class DEXBot {
    constructor(config) {
        this.config = config;
        this.account = null;
        this.privateKey = null;
        this.manager = null;
        this.isResyncing = false;
        this.triggerFile = path.join(PROFILES_DIR, `recalculate.${config.botKey}.trigger`);
        this._recentlyProcessedFills = new Map();
        this._fillDedupeWindowMs = 5000;
        this._processingFill = false;
        this._pendingFills = [];
    }

    async initialize(masterPassword = null) {
        await waitForConnected(30000);
        let accountData = null;
        if (this.config && this.config.preferredAccount) {
            try {
                const pwd = masterPassword || await chainKeys.authenticate();
                const privateKey = chainKeys.getPrivateKey(this.config.preferredAccount, pwd);
                let accId = null;
                try {
                    const full = await BitShares.db.get_full_accounts([this.config.preferredAccount], false);
                    if (full && full[0]) {
                        const maybe = full[0][0];
                        if (maybe && String(maybe).startsWith('1.2.')) accId = maybe;
                        else if (full[0][1] && full[0][1].account && full[0][1].account.id) accId = full[0][1].account.id;
                    }
                } catch (e) { /* best-effort */ }

                if (accId) chainOrders.setPreferredAccount(accId, this.config.preferredAccount);
                accountData = { accountName: this.config.preferredAccount, privateKey, id: accId };
            } catch (err) {
                console.warn('[bot.js] Auto-selection of preferredAccount failed:', err.message);
                throw err;
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
        this.account = accountData.accountName;
        this.accountId = accountData.id || null;
        this.privateKey = accountData.privateKey;
        console.log(`[bot.js] Initialized DEXBot for account: ${this.account}`);
    }

    async placeInitialOrders() {
        if (!this.manager) this.manager = new OrderManager(this.config);
        try {
            const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await this.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch) {
            console.warn('[bot.js] Could not fetch account totals before initializing grid:', errFetch && errFetch.message ? errFetch.message : errFetch);
        }

        await Grid.initializeGrid(this.manager);

        if (this.config.dryRun) {
            this.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));
            return;
        }

        this.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = this.manager.getInitialOrdersToActivate();

        const sellOrders = ordersToActivate.filter(o => o.type === 'sell');
        const buyOrders = ordersToActivate.filter(o => o.type === 'buy');
        const interleavedOrders = [];
        const maxLen = Math.max(sellOrders.length, buyOrders.length);
        for (let i = 0; i < maxLen; i++) {
            if (i < sellOrders.length) interleavedOrders.push(sellOrders[i]);
            if (i < buyOrders.length) interleavedOrders.push(buyOrders[i]);
        }

        const { assetA, assetB } = this.manager.assets;

        const buildCreateOrderArgs = (order) => {
            let amountToSell, sellAssetId, minToReceive, receiveAssetId;
            if (order.type === 'sell') {
                amountToSell = order.size;
                sellAssetId = assetA.id;
                minToReceive = order.size * order.price;
                receiveAssetId = assetB.id;
            } else {
                amountToSell = order.size;
                sellAssetId = assetB.id;
                minToReceive = order.size / order.price;
                receiveAssetId = assetA.id;
            }
            return { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        };

        const createAndSyncOrder = async (order) => {
            this.manager.logger.log(`Placing ${order.type} order: size=${order.size}, price=${order.price}`, 'debug');
            const args = buildCreateOrderArgs(order);
            const result = await chainOrders.createOrder(
                this.account, this.privateKey, args.amountToSell, args.sellAssetId,
                args.minToReceive, args.receiveAssetId, null, false
            );
            const chainOrderId = result && result[0] && result[0].trx && result[0].trx.operation_results && result[0].trx.operation_results[0] && result[0].trx.operation_results[0][1];
            if (!chainOrderId) {
                throw new Error('Order creation response missing order_id');
            }
            await this.manager.synchronizeWithChain({ gridOrderId: order.id, chainOrderId }, 'createOrder');
        };

        const placeOrderGroup = async (ordersGroup) => {
            const settled = await Promise.allSettled(ordersGroup.map(order => createAndSyncOrder(order)));
            settled.forEach((result, index) => {
                if (result.status === 'rejected') {
                    const order = ordersGroup[index];
                    const reason = result.reason;
                    const errMsg = reason && reason.message ? reason.message : `${reason}`;
                    this.manager.logger.log(`Failed to place ${order.type} order ${order.id}: ${errMsg}`, 'error');
                }
            });
        };

        const orderGroups = [];
        for (let i = 0; i < interleavedOrders.length;) {
            const current = interleavedOrders[i];
            const next = interleavedOrders[i + 1];
            if (next && current.type === 'sell' && next.type === 'buy') {
                orderGroups.push([current, next]);
                i += 2;
            } else {
                orderGroups.push([current]);
                i += 1;
            }
        }

        for (const group of orderGroups) {
            await placeOrderGroup(group);
        }
        accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));
    }

    async start(masterPassword = null) {
        await this.initialize(masterPassword);
        if (!this.manager) {
            this.manager = new OrderManager(this.config || {});
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
        }

        // Start listening for fills
        await chainOrders.listenForFills(this.account || undefined, async (fills) => {
            // Fill handling code (simplified for PM2 usage)
            if (this.manager && !this.isResyncing && !this.config.dryRun) {
                console.log(`[bot.js] Fill detected: ${fills.length} fill(s)`);
            }
        });

        const persistedGrid = accountOrders.loadBotGrid(this.config.botKey);
        const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

        let shouldRegenerate = false;
        if (!persistedGrid || persistedGrid.length === 0) {
            shouldRegenerate = true;
            console.log('[bot.js] No persisted grid found. Generating new grid.');
        } else {
            await this.manager._initializeAssets();
            const chainOrderIds = new Set(chainOpenOrders.map(o => o.id));
            const hasActiveMatch = persistedGrid.some(order => order.state === 'active' && chainOrderIds.has(order.orderId));
            if (!hasActiveMatch) {
                shouldRegenerate = true;
                console.log('[bot.js] Persisted grid found, but no matching active orders on-chain. Generating new grid.');
            }
        }

        if (shouldRegenerate) {
            await this.placeInitialOrders();
        } else {
            console.log('[bot.js] Found active session. Loading and syncing existing grid.');
            await Grid.loadGrid(this.manager, persistedGrid);
            await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
            accountOrders.storeMasterGrid(this.config.botKey, Array.from(this.manager.orders.values()));
        }

        // Main loop
        const loopDelayMs = Number(process.env.RUN_LOOP_MS || 5000);
        console.log(`[bot.js] DEXBot started. Running loop every ${loopDelayMs}ms (dryRun=${!!this.config.dryRun})`);

        while (true) {
            try {
                if (this.manager && !this.isResyncing) {
                    await this.manager.fetchOrderUpdates();
                }
            } catch (err) {
                console.error('[bot.js] Order manager loop error:', err.message);
            }
            await new Promise(resolve => setTimeout(resolve, loopDelayMs));
        }
    }
}

// Main entry point
(async () => {
    try {
        // Load bot configuration
        const botConfig = loadBotConfig(botName);
        console.log(`[bot.js] Loaded configuration for bot: ${botName}`);
        console.log(`[bot.js] Market: ${botConfig.assetA}-${botConfig.assetB}, Account: ${botConfig.preferredAccount}`);

        // Normalize config
        const normalizedConfig = normalizeBotEntry(botConfig, 0);
        accountOrders.ensureBotEntries([normalizedConfig]);

        // Authenticate master password
        const masterPassword = await authenticateMasterPassword();

        // Create and start bot
        const bot = new DEXBot(normalizedConfig);
        await bot.start(masterPassword);

    } catch (err) {
        console.error('[bot.js] Failed to start bot:', err.message);
        process.exit(1);
    }
})();
