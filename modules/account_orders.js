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
 *       "cacheFunds": { buy: number, sell: number },  // All unallocated funds (fill proceeds + surplus)
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
const AsyncLock = require('./order/async_lock');

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

    // AsyncLock prevents concurrent read-modify-write races on file I/O
    // Serializes storeMasterGrid, updateCacheFunds, updateBtsFeesOwed operations
    this._persistenceLock = new AsyncLock();

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
  async ensureBotEntries(botEntries = []) {
    if (!Array.isArray(botEntries)) return;

    // Use AsyncLock to serialize with other write operations (storeMasterGrid, updateCacheFunds, etc.)
    // Prevents race conditions during hot-reload or concurrent initialization scenarios
    await this._persistenceLock.acquire(async () => {
      // Reload from disk to ensure we have the latest state
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      const validKeys = new Set();
      let changed = false;

      // In per-bot mode: only process the matching bot
      const entriesToProcess = this.botKey
        ? botEntries.filter(bot => {
            const key = bot.botKey || createBotKey(bot, botEntries.indexOf(bot));
            const matches = key === this.botKey;
            console.log(`[AccountOrders] per-bot filter: checking bot name=${bot.name}, key=${key}, this.botKey=${this.botKey}, matches=${matches}`);
            return matches;
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
            console.log(`[AccountOrders] Metadata changed for bot ${key}: updating from old metadata to new`);
            console.log(`  OLD: name=${entry.meta?.name}, assetA=${entry.meta?.assetA}, assetB=${entry.meta?.assetB}, active=${entry.meta?.active}`);
            console.log(`  NEW: name=${meta.name}, assetA=${meta.assetA}, assetB=${meta.assetB}, active=${meta.active}`);
            entry.meta = { ...entry.meta, ...meta, createdAt: entry.meta?.createdAt || meta.createdAt };
            entry.lastUpdated = nowIso();
            changed = true;
          } else {
            console.log(`[AccountOrders] No metadata change for bot ${key} - skipping update`);
            console.log(`  CURRENT: name=${entry.meta?.name}, assetA=${entry.meta?.assetA}, assetB=${entry.meta?.assetB}, active=${entry.meta?.active}`);
            console.log(`  PASSED:  name=${meta.name}, assetA=${meta.assetA}, assetB=${meta.assetB}, active=${meta.active}`);
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
    });
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
  async storeMasterGrid(botKey, orders = [], cacheFunds = null, btsFeesOwed = null) {
    if (!botKey) return;

    // Use AsyncLock to serialize read-modify-write operations (fixes Issue #1, #5)
    // Prevents concurrent calls from overwriting each other's changes
    await this._persistenceLock.acquire(async () => {
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
          processedFills: {},
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
        // Initialize processedFills if missing (backward compat)
        if (!this.data.bots[botKey].processedFills) {
          this.data.bots[botKey].processedFills = {};
        }
        const timestamp = nowIso();
        this.data.bots[botKey].lastUpdated = timestamp;
        if (this.data.bots[botKey].meta) this.data.bots[botKey].meta.updatedAt = timestamp;
      }
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Load the persisted order grid for a bot.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #2)
   * @returns {Array|null} Order grid array or null if not found
   */
  loadBotGrid(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      return botData.grid || null;
    }
    return null;
  }

  /**
   * Load cached funds for a bot (difference between available and calculated rotation sizes).
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #2)
   * @returns {Object|null} Cached funds { buy, sell } or null if not found
   */
  loadCacheFunds(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

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
  async updateCacheFunds(botKey, cacheFunds) {
    if (!botKey) return;

    // Use AsyncLock to serialize writes and prevent stale data issues (fixes Issue #3)
    // Always reload from disk regardless of mode to ensure latest state
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }
      this.data.bots[botKey].cacheFunds = cacheFunds || { buy: 0, sell: 0 };
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /* `pendingProceeds` storage removed. */

  /**
   * Load BTS blockchain fees owed for a bot.
   * BTS fees accumulate during fill processing and must persist across restarts
   * to ensure they are properly deducted from proceeds during rotation.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #2)
   * @returns {number} BTS fees owed or 0 if not found
   */
  loadBtsFeesOwed(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

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
  async updateBtsFeesOwed(botKey, btsFeesOwed) {
    if (!botKey) return;

    // Use AsyncLock to serialize writes and prevent stale data issues (fixes Issue #4)
    // Always reload from disk regardless of mode to ensure latest state
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }
      this.data.bots[botKey].btsFeesOwed = Number.isFinite(btsFeesOwed) ? btsFeesOwed : 0;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Load processed fill IDs for a bot to prevent reprocessing fills across restarts.
   * Returns a Map of fillKey => timestamp for fills already processed.
   * @param {string} botKey - Bot identifier key
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {Map} Map of fillKey => timestamp
   */
  loadProcessedFills(botKey, forceReload = false) {
    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

    if (this.data && this.data.bots && this.data.bots[botKey]) {
      const botData = this.data.bots[botKey];
      const fills = botData.processedFills || {};
      // Convert stored object to Map
      const fillMap = new Map(Object.entries(fills));
      return fillMap;
    }
    return new Map();
  }

  /**
   * Add or update a processed fill record (prevents reprocessing same fills).
   * @param {string} botKey - Bot identifier key
   * @param {string} fillKey - Unique fill identifier (e.g., "order_id:block_num:history_id")
   * @param {number} timestamp - Timestamp when fill was processed
   */
  async updateProcessedFills(botKey, fillKey, timestamp) {
    if (!botKey || !fillKey) return;

    // Use AsyncLock to serialize writes
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }

      if (!this.data.bots[botKey].processedFills) {
        this.data.bots[botKey].processedFills = {};
      }

      // Store fill with timestamp
      this.data.bots[botKey].processedFills[fillKey] = timestamp;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Update multiple processed fills at once (more efficient than updating one-by-one).
   * @param {string} botKey - Bot identifier key
   * @param {Map|Object} fills - Map or object of fillKey => timestamp
   */
  async updateProcessedFillsBatch(botKey, fills) {
    if (!botKey || !fills || (fills instanceof Map && fills.size === 0) || (typeof fills === 'object' && Object.keys(fills).length === 0)) {
      return;
    }

    // Use AsyncLock to serialize writes
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }

      if (!this.data.bots[botKey].processedFills) {
        this.data.bots[botKey].processedFills = {};
      }

      // Merge fills
      if (fills instanceof Map) {
        for (const [key, timestamp] of fills) {
          this.data.bots[botKey].processedFills[key] = timestamp;
        }
      } else {
        Object.assign(this.data.bots[botKey].processedFills, fills);
      }

      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Clean up old processed fill records (remove entries older than specified age).
   * Prevents processedFills from growing unbounded over time.
   * @param {string} botKey - Bot identifier key
   * @param {number} olderThanMs - Remove fills processed more than this many milliseconds ago
   */
  async cleanOldProcessedFills(botKey, olderThanMs = 3600000) {
    // Default: 1 hour (3600000ms)
    if (!botKey) return;

    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };

      if (!this.data || !this.data.bots || !this.data.bots[botKey]) {
        return;
      }

      if (!this.data.bots[botKey].processedFills) {
        return;
      }

      const now = Date.now();
      const fills = this.data.bots[botKey].processedFills;
      let deletedCount = 0;

      for (const [fillKey, timestamp] of Object.entries(fills)) {
        if (now - timestamp > olderThanMs) {
          delete fills[fillKey];
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.data.lastUpdated = nowIso();
        this._persist();
      }
    });
  }

  /**
   * Calculate asset balances from a stored grid.
   * Sums order sizes by asset and state (active vs virtual).
   * @param {string} botKeyOrName - Bot key or name to look up
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data (fixes Issue #6)
   * @returns {Object|null} Balance summary or null if not found
   */
  getDBAssetBalances(botKeyOrName, forceReload = false) {
    if (!botKeyOrName) return null;

    // Optionally reload from disk to prevent using stale in-memory data
    if (forceReload) {
      this.data = this._loadData() || { bots: {}, lastUpdated: nowIso() };
    }

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

    const serialized = {
      id: order.id || null,
      type: order.type || null,
      state: order.state || null,
      price: Number.isFinite(priceValue) ? priceValue : 0,
      size: Number.isFinite(sizeValue) ? sizeValue : 0,
      orderId
    };

    // NEW: Persist Anchor & Refill strategy fields
    // isDoubleOrder: marks partial orders that have merged dust (Case A: Dust Refill)
    if (order.isDoubleOrder) {
      serialized.isDoubleOrder = true;
    }

    // mergedDustSize: amount of dust merged into this order's new allocation
    if (order.mergedDustSize !== undefined && order.mergedDustSize !== null) {
      const mergedDustValue = Number(order.mergedDustSize);
      if (Number.isFinite(mergedDustValue) && mergedDustValue > 0) {
        serialized.mergedDustSize = mergedDustValue;
      }
    }

    // filledSinceRefill: accumulated fill progress toward clearing the dust debt
    if (order.filledSinceRefill !== undefined && order.filledSinceRefill !== null) {
      const filledValue = Number(order.filledSinceRefill);
      if (Number.isFinite(filledValue) && filledValue > 0) {
        serialized.filledSinceRefill = filledValue;
      }
    }

    // pendingRotation: marks when rotation is delayed until fill threshold is reached
    if (order.pendingRotation) {
      serialized.pendingRotation = true;
    }

    return serialized;
  }
}

module.exports = {
  AccountOrders,
  createBotKey
};

