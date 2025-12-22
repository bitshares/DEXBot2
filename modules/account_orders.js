/**
 * Account Orders Module - Local persistence for order grid snapshots
 *
 * Per-Bot Architecture:
 * Each bot has its own dedicated file: profiles/orders/{botKey}.json
 * This eliminates race conditions when multiple bots write simultaneously.
 *
 * File structure (per-bot):
 * {
 *   "bots": {
 *     "botkey": {
 *       "meta": { name, assetA, assetB, active, index },
 *       "grid": [ { id, type, state, price, size, orderId }, ... ],
 *       "cacheFunds": { buy: number, sell: number },
 *       "btsFeesOwed": number,
 *       "createdAt": "ISO timestamp",
 *       "lastUpdated": "ISO timestamp"
 *     }
 *   },
 *   "lastUpdated": "ISO timestamp"
 * }
 *
 * The grid snapshot allows the bot to resume from where it left off
 * without regenerating orders, maintaining consistency with on-chain state.
 */
const fs = require('fs');
const path = require('path');
const { ORDER_STATES } = require('./constants');

const PROFILES_ORDERS_FILE = path.join(__dirname, '..', 'profiles', 'orders.json');

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeKey(source) {
  if (!source) return 'bot';
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';
}

/**
 * Generate a unique key for identifying a bot in storage.
 * Uses bot name or asset pair, sanitized and indexed.
 * @param {Object} bot - Bot configuration
 * @param {number} index - Index in bots array
 * @returns {string} Sanitized key like 'mybot-0' or 'iob-xrp-bts-1'
 */
function createBotKey(bot, index) {
  const identifier = bot && bot.name
    ? bot.name
    : bot && bot.assetA && bot.assetB
      ? `${bot.assetA}/${bot.assetB}`
      : `bot-${index}`;
  return `${sanitizeKey(identifier)}-${index}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * AccountOrders class - manages order grid persistence
 * 
 * Provides methods to:
 * - Store and load order grid snapshots
 * - Track bot metadata and state
 * - Calculate asset balances from stored grids
 * 
 * Each bot has its own file: {botkey}.json
 * This eliminates race conditions when multiple bots write simultaneously.
 * 
 * @class
 */
class AccountOrders {
  /**
   * Create an AccountOrders instance.
   * @param {Object} options - Configuration options
   * @param {string} options.botKey - Bot identifier (e.g., 'xrp-bts-0', 'h-bts-1')
   *                                   If provided, uses {botKey}.json
   * @param {string} options.profilesPath - Custom path for orders.json (legacy single-file mode)
   */
  constructor(options = {}) {
    this.botKey = options.botKey;
    
    // Determine file path: per-bot file if botKey provided, otherwise legacy shared file
    if (this.botKey) {
      const ordersDir = path.join(__dirname, '..', 'profiles', 'orders');
      this.profilesPath = path.join(ordersDir, `${this.botKey}.json`);
    } else {
      this.profilesPath = options.profilesPath || PROFILES_ORDERS_FILE;
    }
    
    this._needsBootstrapSave = !fs.existsSync(this.profilesPath);
    this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    if (this._needsBootstrapSave) {
      this._persist();
    }
  }

  _loadData() {
    // Load the file directly - per-bot files only contain their own bot's data
    return this._readFile(this.profilesPath);
  }

  _readFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (err) {
      console.warn('account_orders: failed to read', filePath, '-', err.message);
    }
    return null;
  }

  _persist() {
    ensureDirExists(this.profilesPath);
    fs.writeFileSync(this.profilesPath, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
  }

  /**
   * Ensure storage entries exist for all provided bot configurations.
   * Creates new entries for unknown bots, updates metadata for existing ones.
   *
   * When in per-bot mode (botKey set): Only processes the matching bot entry and ignores others.
   * When in shared mode (no botKey): Processes all bot entries and prunes stale ones.
   *
   * @param {Array} botEntries - Array of bot configurations from bots.json
   */
  ensureBotEntries(botEntries = []) {
    if (!Array.isArray(botEntries)) return;
    const validKeys = new Set();
    let changed = false;

    // In per-bot mode: only process the matching bot
    const entriesToProcess = this.botKey
      ? botEntries.filter(bot => {
          const key = bot.botKey || createBotKey(bot, botEntries.indexOf(bot));
          return key === this.botKey;
        })
      : botEntries;

    // 1. Update/Create active bots
    for (const [index, bot] of entriesToProcess.entries()) {
      const key = bot.botKey || createBotKey(bot, index);
      validKeys.add(key);

      let entry = this.data.bots[key];
      const meta = this._buildMeta(bot, key, index, entry && entry.meta);

      if (!entry) {
        entry = {
          meta,
          grid: [],
          cacheFunds: { buy: 0, sell: 0 },
          btsFeesOwed: 0,
          createdAt: meta.createdAt,
          lastUpdated: meta.updatedAt
        };
        this.data.bots[key] = entry;
        changed = true;
      } else {
        // Ensure cacheFunds exists even for existing bots
        if (!entry.cacheFunds || typeof entry.cacheFunds.buy !== 'number') {
          entry.cacheFunds = { buy: 0, sell: 0 };
          changed = true;
        }

        

        // Ensure btsFeesOwed exists even for existing bots
        if (typeof entry.btsFeesOwed !== 'number') {
          entry.btsFeesOwed = 0;
          changed = true;
        }

        entry.grid = entry.grid || [];
        if (this._metaChanged(entry.meta, meta)) {
          entry.meta = { ...entry.meta, ...meta, createdAt: entry.meta?.createdAt || meta.createdAt };
          entry.lastUpdated = nowIso();
          changed = true;
        }
      }
      bot.botKey = key;
    }

    // 2. Prune zombie bots (remove entries not in botEntries) - only in shared mode
    if (!this.botKey) {
      for (const key of Object.keys(this.data.bots)) {
        if (!validKeys.has(key)) {
          console.log(`[AccountOrders] Pruning stale bot entry: ${key}`);
          delete this.data.bots[key];
          changed = true;
        }
      }
    }

    if (changed) {
      this.data.lastUpdated = nowIso();
      this._persist();
    }
  }

  _metaChanged(existing, next) {
    if (!existing) return true;
    return existing.name !== next.name ||
      existing.assetA !== next.assetA ||
      existing.assetB !== next.assetB ||
      existing.active !== next.active ||
      existing.index !== next.index;
  }

  _buildMeta(bot, key, index, existing = {}) {
    const timestamp = nowIso();
    return {
      key,
      name: bot.name || null,
      assetA: bot.assetA || null,
      assetB: bot.assetB || null,
      active: !!bot.active,
      index,
      createdAt: existing.createdAt || timestamp,
      updatedAt: timestamp
    };
  }

  /**
   * Save the current order grid snapshot for a bot.
   * Called after grid changes (initialization, fills, syncs).
   *
   * In per-bot mode: Only stores the specified bot's data (ignores other bots in this.data).
   * In shared mode: Stores all bot data.
   *
   * @param {string} botKey - Bot identifier key
   * @param {Array} orders - Array of order objects from OrderManager
  * @param {Object} cacheFunds - Optional cached funds { buy: number, sell: number }
  * @param {number} btsFeesOwed - Optional BTS blockchain fees owed
  */
  storeMasterGrid(botKey, orders = [], cacheFunds = null, btsFeesOwed = null) {
    if (!botKey) return;

    // CRITICAL: Reload from disk before writing to prevent race conditions between bot processes
    // In per-bot mode: loads only this bot's data from its dedicated file
    // In shared mode: loads all bots from the shared file
    this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

    const snapshot = Array.isArray(orders) ? orders.map(order => this._serializeOrder(order)) : [];
    if (!this.data.bots[botKey]) {
      const meta = this._buildMeta({ name: null, assetA: null, assetB: null, active: false }, botKey, null);
      this.data.bots[botKey] = {
        meta,
        grid: snapshot,
        cacheFunds: cacheFunds || { buy: 0, sell: 0 },
        btsFeesOwed: Number.isFinite(btsFeesOwed) ? btsFeesOwed : 0,
        createdAt: meta.createdAt,
        lastUpdated: meta.updatedAt
      };
    } else {
      this.data.bots[botKey].grid = snapshot;
      if (cacheFunds) {
        this.data.bots[botKey].cacheFunds = cacheFunds;
      }
      
      if (Number.isFinite(btsFeesOwed)) {
        this.data.bots[botKey].btsFeesOwed = btsFeesOwed;
      }
      const timestamp = nowIso();
      this.data.bots[botKey].lastUpdated = timestamp;
      if (this.data.bots[botKey].meta) this.data.bots[botKey].meta.updatedAt = timestamp;
    }
    this.data.lastUpdated = nowIso();
    this._persist();
  }

  /**
   * Load the persisted order grid for a bot.
   * @param {string} botKey - Bot identifier key
   * @returns {Array|null} Order grid array or null if not found
   */
  loadBotGrid(botKey) {
    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      return botData.grid || null;
    }
    return null;
  }

  /**
   * Load cached funds for a bot (difference between available and calculated rotation sizes).
   * @param {string} botKey - Bot identifier key
   * @returns {Object|null} Cached funds { buy, sell } or null if not found
   */
  loadCacheFunds(botKey) {
    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const cf = botData.cacheFunds;
      if (cf && typeof cf.buy === 'number' && typeof cf.sell === 'number') {
        return cf;
      }
    }
    return { buy: 0, sell: 0 };
  }

  /**
   * Update cached funds for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {Object} cacheFunds - Cached funds { buy, sell }
   */
  updateCacheFunds(botKey, cacheFunds) {
    if (!botKey) return;

    // Reload from disk in per-bot mode to ensure consistency
    if (this.botKey) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
      return;
    }
    this.data.bots[botKey].cacheFunds = cacheFunds || { buy: 0, sell: 0 };
    this.data.lastUpdated = nowIso();
    this._persist();
  }

  /* `pendingProceeds` storage removed. */

  /**
   * Load BTS blockchain fees owed for a bot.
   * BTS fees accumulate during fill processing and must persist across restarts
   * to ensure they are properly deducted from proceeds during rotation.
   * @param {string} botKey - Bot identifier key
   * @returns {number} BTS fees owed or 0 if not found
   */
  loadBtsFeesOwed(botKey) {
    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const fees = botData.btsFeesOwed;
      if (typeof fees === 'number' && Number.isFinite(fees)) {
        return fees;
      }
    }
    return 0;
  }

  /**
   * Update (persist) BTS blockchain fees for a bot.
   * BTS fees are deducted during fill processing and must be tracked across restarts
   * to prevent fund loss if the bot crashes before rotation.
   * @param {string} botKey - Bot identifier key
   * @param {number} btsFeesOwed - BTS blockchain fees owed
   */
  updateBtsFeesOwed(botKey, btsFeesOwed) {
    if (!botKey) return;

    // Reload from disk in per-bot mode to ensure consistency
    if (this.botKey) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
      return;
    }
    this.data.bots[botKey].btsFeesOwed = Number.isFinite(btsFeesOwed) ? btsFeesOwed : 0;
    this.data.lastUpdated = nowIso();
    this._persist();
  }

  /**
   * Calculate asset balances from a stored grid.
   * Sums order sizes by asset and state (active vs virtual).
   * @param {string} botKeyOrName - Bot key or name to look up
   * @returns {Object|null} Balance summary or null if not found
   */
  getDBAssetBalances(botKeyOrName) {
    if (!botKeyOrName) return null;
    // Find entry by key or by matching meta.name (case-insensitive)
    let key = null;
    if (this.data && this.data.bots) {
      if (this.data.bots[botKeyOrName]) key = botKeyOrName;
      else {
        const lower = String(botKeyOrName).toLowerCase();
        for (const k of Object.keys(this.data.bots)) {
          const meta = this.data.bots[k] && this.data.bots[k].meta;
          if (meta && meta.name && String(meta.name).toLowerCase() === lower) { key = k; break; }
        }
      }
    }
    if (!key) return null;
    const entry = this.data.bots[key];
    if (!entry) return null;
    const meta = entry.meta || {};
    const grid = Array.isArray(entry.grid) ? entry.grid : [];

    const sums = {
      assetA: { active: 0, virtual: 0 },
      assetB: { active: 0, virtual: 0 },
      meta: { key, name: meta.name || null, assetA: meta.assetA || null, assetB: meta.assetB || null }
    };

    for (const o of grid) {
      const size = Number(o && o.size) || 0;
      const state = o && o.state ? String(o.state).toLowerCase() : '';
      const typ = o && o.type ? String(o.type).toLowerCase() : '';

      if (typ === 'sell') {
        if (state === 'active') sums.assetA.active += size;
        else if (state === 'virtual') sums.assetA.virtual += size;
      } else if (typ === 'buy') {
        if (state === 'active') sums.assetB.active += size;
        else if (state === 'virtual') sums.assetB.virtual += size;
      }
    }

    return sums;
  }

  _serializeOrder(order = {}) {
    const priceValue = Number(order.price !== undefined && order.price !== null ? order.price : 0);
    const sizeValue = Number(order.size !== undefined && order.size !== null ? order.size : 0);
    // Preserve orderId for both ACTIVE and PARTIAL orders
    const shouldHaveId = order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL;
    const orderId = shouldHaveId ? (order.orderId || order.id || '') : '';
    return {
      id: order.id || null,
      type: order.type || null,
      state: order.state || null,
      price: Number.isFinite(priceValue) ? priceValue : 0,
      size: Number.isFinite(sizeValue) ? sizeValue : 0,
      orderId
    };
  }
}

module.exports = {
  AccountOrders,
  createBotKey
};

