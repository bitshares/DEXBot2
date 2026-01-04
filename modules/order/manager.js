/**
 * OrderManager - Core grid-based order management system for DEXBot2
 * 
 * This module is responsible for:
 * - Maintaining the virtual order grid state (Map of orders + indices)
 * - Coordinating between specialized engines:
 *   - Accountant (accounting.js): Fund tracking and fee management
 *   - StrategyEngine (strategy.js): Grid rebalancing and anchoring
 *   - SyncEngine (sync_engine.js): Blockchain reconciliation
 */

const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL, PRECISION_DEFAULTS } = require('../constants');
const {
    calculatePriceTolerance,
    findMatchingGridOrderByOpenOrder,
    calculateAvailableFundsValue,
    getMinOrderSize,
    getAssetFees,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValue,
    floatToBlockchainInt
} = require('./utils');
const Logger = require('./logger');
const AsyncLock = require('./async_lock');
const Accountant = require('./accounting');
const StrategyEngine = require('./strategy');
const SyncEngine = require('./sync_engine');

class OrderManager {
    /**
     * Create a new OrderManager instance
     *
     * @param {Object} [config={}] - Configuration object
     * @param {string} [config.market] - Market identifier (e.g., "BTS/USDT")
     * @param {string} [config.assetA] - Base asset symbol
     * @param {string} [config.assetB] - Quote asset symbol
     * @param {number} [config.startPrice] - Initial market price
     * @param {number} [config.minPrice] - Minimum price for grid
     * @param {number} [config.maxPrice] - Maximum price for grid
     * @param {number} [config.incrementPercent] - Price step percentage between orders
     * @param {number} [config.targetSpreadPercent] - Spread zone width around market
     * @param {Object} [config.botFunds] - Fund allocation limits
     * @param {string|number} [config.botFunds.buy] - Buy fund limit (number or "50%")
     * @param {string|number} [config.botFunds.sell] - Sell fund limit
     * @param {Object} [config.activeOrders] - Active order count targets
     * @param {number} [config.activeOrders.buy] - Target active buy orders
     * @param {number} [config.activeOrders.sell] - Target active sell orders
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        this.logger = new Logger(LOG_LEVEL);
        this.logger.marketName = this.marketName;
        this.orders = new Map();
        
        // Specialized Engines
        this.accountant = new Accountant(this);
        this.strategy = new StrategyEngine(this);
        this.sync = new SyncEngine(this);

        // Indices for fast lookup
        this._ordersByState = {
            [ORDER_STATES.VIRTUAL]: new Set(),
            [ORDER_STATES.ACTIVE]: new Set(),
            [ORDER_STATES.PARTIAL]: new Set()
        };
        this._ordersByType = {
            [ORDER_TYPES.BUY]: new Set(),
            [ORDER_TYPES.SELL]: new Set(),
            [ORDER_TYPES.SPREAD]: new Set()
        };
        this.resetFunds();
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = false;
        this.assets = null;
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        this.ordersNeedingPriceCorrection = [];
        this.ordersPendingCancellation = [];
        this.shadowOrderIds = new Map();
        this._correctionsLock = new AsyncLock();
        this._syncLock = new AsyncLock();  // Prevents concurrent full-sync operations (defense-in-depth)
        this._recentlyRotatedOrderIds = new Set();
        this._gridSidesUpdated = [];
        this._pauseFundRecalcDepth = 0;  // Counter for safe nested pausing (not boolean)

        // Metrics for observability
        this._metrics = {
            fundRecalcCount: 0,
            invariantViolations: { buy: 0, sell: 0 },
            lockAcquisitions: 0,
            lockContentionSkips: 0,
            stateTransitions: {},
            lastSyncDurationMs: 0,
            metricsStartTime: Date.now()
        };

        // Clean up any stale locks from previous process crash on startup
        this._cleanExpiredLocks();
    }

    // --- Accounting Delegation ---
    resetFunds() { return this.accountant.resetFunds(); }

    recalculateFunds() {
        this._metrics.fundRecalcCount++;
        return this.accountant.recalculateFunds();
    }

    /**
     * Get metrics for observability and monitoring
     */
    getMetrics() {
        const now = Date.now();
        const uptime = now - this._metrics.metricsStartTime;
        return {
            ...this._metrics,
            timestamp: now,
            uptimeMs: uptime,
            fundRecalcPerMinute: (this._metrics.fundRecalcCount / (uptime / 60000)).toFixed(2)
        };
    }

    /**
     * Record state transition for metrics tracking
     */
    _recordStateTransition(fromState, toState) {
        if (!fromState || !toState) return;
        const key = `${fromState}→${toState}`;
        this._metrics.stateTransitions[key] = (this._metrics.stateTransitions[key] || 0) + 1;
    }
    _deductFromChainFree(type, size, op) { return this.accountant.deductFromChainFree(type, size, op); }
    _addToChainFree(type, size, op) { return this.accountant.addToChainFree(type, size, op); }
    _updateOptimisticFreeBalance(oldO, newO, ctx, fee) { return this.accountant.updateOptimisticFreeBalance(oldO, newO, ctx, fee); }
    async deductBtsFees(side) { return await this.accountant.deductBtsFees(side); }

    // --- Strategy Delegation ---
    async rebalanceOrders(fCounts, extra, excl) { return await this.strategy.rebalanceOrders(fCounts, extra, excl); }
    async _rebalanceSideAfterFill(fType, oType, fCount, extra, excl) { return await this.strategy.rebalanceSideAfterFill(fType, oType, fCount, extra, excl); }
    async processFilledOrders(orders, excl) { return await this.strategy.processFilledOrders(orders, excl); }
    async activateClosestVirtualOrdersForPlacement(type, count, excl) { return await this.strategy.activateClosestVirtualOrdersForPlacement(type, count, excl); }
    async prepareFurthestOrdersForRotation(type, count, excl, fCount, opt) { return await this.strategy.prepareFurthestOrdersForRotation(type, count, excl, fCount, opt); }
    completeOrderRotation(oldInfo) { return this.strategy.completeOrderRotation(oldInfo); }
    _evaluatePartialOrderAnchor(p, move) { return this.strategy.evaluatePartialOrderAnchor(p, move); }
    preparePartialOrderMove(p, dist, excl) { return this.strategy.preparePartialOrderMove(p, dist, excl); }
    completePartialOrderMove(move) { return this.strategy.completePartialOrderMove(move); }
    async activateSpreadOrders(type, count) { return await this.strategy.activateSpreadOrders(type, count); }

    // --- Sync Delegation ---
    syncFromOpenOrders(orders, info) { return this.sync.syncFromOpenOrders(orders, info); }
    syncFromFillHistory(op) { return this.sync.syncFromFillHistory(op); }
    async synchronizeWithChain(data, src) { return await this.sync.synchronizeWithChain(data, src); }
    async _fetchAccountBalancesAndSetTotals() { return await this.sync.fetchAccountBalancesAndSetTotals(); }
    async _initializeAssets() { return await this.sync.initializeAssets(); }

    // --- Controller Logic ---

    /**
     * Resolve a configuration value (absolute or percentage-based).
     * SIDE EFFECT: If value is a percentage but total is unavailable,
     * this method triggers an async fetch of account totals for future calls.
     * Use _resolveConfigValueWithAccountFetch() to handle the fetch explicitly.
     */
    _resolveConfigValue(value, total) {
        const resolved = resolveConfigValue(value, total);
        // If percentage-based but no total available, trigger background fetch
        if (resolved === 0 && typeof value === 'string' && value.trim().endsWith('%')) {
            if (total === null || total === undefined) {
                this._triggerAccountTotalsFetchIfNeeded();
            }
        }
        return resolved;
    }

    /**
     * Trigger background fetch of account totals if not already fetching.
     * Used by _resolveConfigValue() when percentage-based allocation is requested.
     * @private
     */
    _triggerAccountTotalsFetchIfNeeded() {
        if (!this._isFetchingTotals) {
            this._isFetchingTotals = true;
            this._fetchAccountBalancesAndSetTotals().finally(() => {
                this._isFetchingTotals = false;
            });
        }
    }

    getChainFundsSnapshot() {
        const totals = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = Number.isFinite(Number(this.funds?.allocated?.buy)) ? Number(this.funds.allocated.buy) : totals.chainTotalBuy;
        const allocatedSell = Number.isFinite(Number(this.funds?.allocated?.sell)) ? Number(this.funds.allocated.sell) : totals.chainTotalSell;
        return { ...totals, allocatedBuy, allocatedSell };
    }

    /**
     * Lock orders to prevent concurrent modifications during async operations.
     * Locking is a critical race condition prevention mechanism.
     *
     * WHY LOCKING IS NEEDED:
     * ========================================================================
     * The bot processes orders asynchronously from multiple sources:
     * 1. Blockchain syncs (detecting fills, price changes)
     * 2. Strategy engine (rebalancing, rotations)
     * 3. User actions (manual adjustments)
     *
     * Without locking, this sequence can occur (BAD):
     *   - Strategy: "Partial P1 looks good for rotation" → calculates rotation
     *   - Blockchain: "P1 just filled completely" → converts P1 to SPREAD
     *   - Strategy: Tries to rotate P1 (now SPREAD) → data corruption
     *
     * With locking (GOOD):
     *   - Blockchain locks P1: isOrderLocked(P1) = true
     *   - Strategy: Checks if P1 locked → skips it
     *   - Blockchain finishes P1 fill → unlocks P1
     *   - Strategy: Now can safely process P1 in next cycle
     *
     * LOCK LIFETIME:
     * Locks are temporary (default 5-10 seconds) to prevent stale locks from
     * permanently blocking orders if a process crashes. This self-healing
     * mechanism prevents deadlocks while still protecting against races.
     *
     * USAGE:
     * - Lock orders: mgr.lockOrders([orderId1, orderId2])
     * - Check if locked: mgr.isOrderLocked(orderId)
     * - Unlock: mgr.unlockOrders([orderId1, orderId2])
     *
     * BEST PRACTICE:
     * Always use try/finally to ensure unlocking happens even if error occurs:
     *   mgr.lockOrders([id]);
     *   try {
     *     // expensive operation on order
     *   } finally {
     *     mgr.unlockOrders([id]);
     *   }
     */
    lockOrders(orderIds) {
        if (!orderIds) return;
        const now = Date.now();
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, now);
        this._cleanExpiredLocks();
    }

    /**
     * Explicitly unlock orders. Locks are also automatically released after
     * LOCK_TIMEOUT_MS milliseconds (self-healing mechanism).
     */
    unlockOrders(orderIds) {
        if (!orderIds) return;
        for (const id of orderIds) if (id) this.shadowOrderIds.delete(id);
        this._cleanExpiredLocks();
    }

    /**
     * Clean up expired locks. Called after lock/unlock to remove stale locks
     * that exceeded LOCK_TIMEOUT_MS. This prevents stale locks from permanently
     * blocking orders if a process crashed while holding the lock.
     *
     * SELF-HEALING MECHANISM:
     * Even if unlockOrders() is never called (e.g., process crash), the lock
     * will automatically expire after LOCK_TIMEOUT_MS. This ensures orders
     * are never permanently blocked and trading can resume.
     */
    _cleanExpiredLocks() {
        const now = Date.now();
        for (const [id, timestamp] of this.shadowOrderIds) {
            if (now - timestamp > TIMING.LOCK_TIMEOUT_MS) this.shadowOrderIds.delete(id);
        }
    }

    /**
     * Check if an order is currently locked.
     * Also auto-expires locks that have exceeded the timeout.
     *
     * @param {string} id - Order ID to check
     * @returns {boolean} true if order is locked and within timeout window
     */
    isOrderLocked(id) {
        if (!id || !this.shadowOrderIds.has(id)) return false;
        if (Date.now() - this.shadowOrderIds.get(id) > TIMING.LOCK_TIMEOUT_MS) {
            this.shadowOrderIds.delete(id);
            return false;
        }
        return true;
    }

    /**
     * Apply bot funds allocation limits based on configuration.
     * Controls how much of total account funds the bot is allowed to use.
     *
     * ALLOCATION STRATEGY:
     * ========================================================================
     * The bot can be configured with fund limits in several ways:
     *
     * 1. ABSOLUTE amounts: botFunds.buy = 1000 (always use max 1000 units)
     * 2. PERCENTAGES: botFunds.buy = "50%" (use max 50% of account balance)
     * 3. NOT SET: No limit, use all available funds
     *
     * WHY ALLOCATION MATTERS:
     * - Prevents bot from using 100% of account, leaving room for manual trading
     * - Allows multiple bots to trade from same account with separate budgets
     * - Provides risk control: Limit losses to allocated portion if bot fails
     *
     * FUND FORMULA AFTER ALLOCATION:
     * If config.botFunds.buy = "30%" and account has 10000 total:
     *   - allocatedBuy = 3000 (30% of 10000)
     *   - funds.available.buy = min(calculated_available, 3000)
     *   - Bot can never spend more than 3000 in buy orders
     *
     * PERCENTAGE RESOLUTION:
     * Uses _resolveConfigValue() to convert percentages to absolute amounts.
     * For percentages, uses current chainTotal (account balance on blockchain)
     * as the base for calculation.
     */
    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;
        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = this._resolveConfigValue(this.config.botFunds.buy, chainTotalBuy);
        const allocatedSell = this._resolveConfigValue(this.config.botFunds.sell, chainTotalSell);
        this.funds.allocated = { buy: allocatedBuy, sell: allocatedSell };
        if (allocatedBuy > 0) this.funds.available.buy = Math.min(this.funds.available.buy, allocatedBuy);
        if (allocatedSell > 0) this.funds.available.sell = Math.min(this.funds.available.sell, allocatedSell);
    }

    setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        this.accountTotals = { ...this.accountTotals, ...totals };
        if (!this.funds) this.resetFunds();
        this.recalculateFunds();
        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try {
                this._accountTotalsResolve();
            } catch (e) {
                this.logger?.log?.(`Error resolving account totals promise: ${e.message}`, 'warn');
            }
            this._accountTotalsPromise = null;
            this._accountTotalsResolve = null;
        }
    }

    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, false)) return;
        if (!this._accountTotalsPromise) this._accountTotalsPromise = new Promise((resolve) => { this._accountTotalsResolve = resolve; });
        await Promise.race([this._accountTotalsPromise, new Promise(resolve => setTimeout(resolve, timeoutMs))]);
    }

    async fetchAccountTotals(accountId) {
        if (accountId) this.accountId = accountId;
        await this._fetchAccountBalancesAndSetTotals();
    }

    /**
     * Update or insert an order into the manager's state, maintaining all indices.
     * This is the CENTRAL STATE TRANSITION mechanism for the order system.
     *
     * STATE TRANSITIONS (the valid flows):
     * =========================================================================
     * VIRTUAL: The initial state for all orders. No on-chain existence.
     *   → ACTIVE: Order is activated for on-chain placement. Funds become locked.
     *   → SPREAD: After a fill, order becomes a placeholder for future rebalancing.
     *
     * ACTIVE: Order is on-chain with an orderId. Funds are locked/committed.
     *   → PARTIAL: Order fills partially. Remaining size is tracked for rebalancing.
     *   → VIRTUAL: Order is cancelled/rotated. Becomes eligible for re-use.
     *   → SPREAD: Order is cancelled/rotated after being filled. Becomes placeholder.
     *
     * PARTIAL: Order has partially filled and is waiting for consolidation or rotation.
     *   → ACTIVE: Upgraded by multi-partial consolidation (if size >= 100% of ideal).
     *   → VIRTUAL: Consolidated and moved. Returns to virtual pool.
     *   → SPREAD: Order absorbed or consolidated, converted to placeholder.
     *
     * CRITICAL RULE - Size determines ACTIVE vs PARTIAL:
     * When an order size < 100% of its slot's ideal size (determined by grid geometry),
     * it MUST be in PARTIAL state, not ACTIVE. This prevents orders from being stuck
     * in the wrong state after partial fills.
     *
     * FUND DEDUCTION RULES (fund tracking via state change):
     * - VIRTUAL → ACTIVE: Funds are deducted from chainFree (become locked)
     * - ACTIVE → VIRTUAL: Funds are added back to chainFree (become free)
     * - ACTIVE → PARTIAL: Partial fills reduce chainFree based on filled amount
     * - PARTIAL → ACTIVE: Consolidation may lock additional funds if upgrading
     *
     * INDEX MAINTENANCE:
     * This method maintains three critical indices for O(1) lookups:
     * 1. _ordersByState: Groups orders by state (VIRTUAL, ACTIVE, PARTIAL)
     * 2. _ordersByType: Groups orders by type (BUY, SELL, SPREAD)
     * 3. orders: Central Map storing the order object data
     *
     * IMPORTANT: Always call this method instead of directly modifying this.orders
     * to ensure indices remain consistent. Inconsistent indices can cause:
     * - Missed orders during rebalancing
     * - Incorrect fund calculations
     * - Stuck orders in wrong states
     *
     * @param {Object} order - Order object to update/insert
     * @param {string} order.id - Unique grid order identifier
     * @param {string} order.state - State: VIRTUAL, ACTIVE, or PARTIAL
     * @param {string} order.type - Type: BUY, SELL, or SPREAD
     * @param {number} order.size - Order size in base asset units
     * @param {number} order.price - Order price
     * @param {string} [order.orderId] - Blockchain order ID (if on-chain)
     * @returns {void}
     */
    _updateOrder(order) {
        // Input validation
        if (order.id === undefined || order.id === null) return;
        if (typeof order.size === 'number' && order.size < 0) {
            this.logger.log(`Warning: Order ${order.id} has negative size ${order.size}`, 'warn');
            return;
        }
        // Validate state if provided (allow undefined for intermediate operations)
        if (order.state !== undefined && !Object.values(ORDER_STATES).includes(order.state)) {
            this.logger.log(`Error: Invalid order state '${order.state}' for order ${order.id}. Valid states: ${Object.values(ORDER_STATES).join(', ')}`, 'error');
            return;
        }
        // Skip update if state is undefined (incomplete order object)
        if (order.state === undefined) {
            this.logger.log(`Debug: Skipping order ${order.id} - state not set`, 'debug');
            return;
        }

        const existing = this.orders.get(order.id);

        // Validate state transition if order exists
        if (existing && existing.state && order.state && existing.state !== order.state) {
            const validTransitions = {
                // VIRTUAL can go ACTIVE (normal) or directly PARTIAL (partial fill before activation)
                [ORDER_STATES.VIRTUAL]: [ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL],
                // ACTIVE can go PARTIAL (partial fill) or back to VIRTUAL (cancelled)
                [ORDER_STATES.ACTIVE]: [ORDER_STATES.PARTIAL, ORDER_STATES.VIRTUAL],
                // PARTIAL can be upgraded to ACTIVE (consolidation) or returned to VIRTUAL (rebalance)
                [ORDER_STATES.PARTIAL]: [ORDER_STATES.ACTIVE, ORDER_STATES.VIRTUAL]
            };

            const allowedNextStates = validTransitions[existing.state] || [];
            if (!allowedNextStates.includes(order.state)) {
                this.logger?.log?.(
                    `Error: Invalid state transition for order ${order.id}: ${existing.state} → ${order.state}. ` +
                    `Valid next states: ${allowedNextStates.join(', ')}`,
                    'error'
                );
                return;
            }

            // Record state transition for metrics
            this._recordStateTransition(existing.state, order.state);
        }

        // SPREAD type orders should remain in VIRTUAL state and not transition
        if (order.type === ORDER_TYPES.SPREAD && existing && existing.type === ORDER_TYPES.SPREAD) {
            if (order.state !== ORDER_STATES.VIRTUAL) {
                this.logger?.log?.(
                    `Error: SPREAD type orders must be in VIRTUAL state, not ${order.state}`,
                    'error'
                );
                return;
            }
        }
        if (existing) {
            this._ordersByState[existing.state]?.delete(order.id);
            this._ordersByType[existing.type]?.delete(order.id);
        }
        this._ordersByState[order.state]?.add(order.id);
        this._ordersByType[order.type]?.add(order.id);
        this.orders.set(order.id, order);

        // Only recalculate funds if not in batch mode (depth == 0 means all pauses resolved)
        if (this._pauseFundRecalcDepth === 0) {
            this.recalculateFunds();
        }
    }

    _logAvailable(label = '') {
        const avail = this.funds?.available || { buy: 0, sell: 0 };
        const cache = this.funds?.cacheFunds || { buy: 0, sell: 0 };
        this.logger.log(`Available [${label}]: buy=${(avail.buy || 0).toFixed(8)}, sell=${(avail.sell || 0).toFixed(8)}, cacheFunds buy=${(cache.buy || 0).toFixed(8)}, sell=${(cache.sell || 0).toFixed(8)}`, 'info');
    }

    /**
     * Pause fund recalculation during batch order updates.
     * Uses a depth counter to safely support nested pauses.
     * Use with resumeFundRecalc() to optimize multi-order operations.
     *
     * NESTING EXAMPLE:
     *   pauseFundRecalc();      // depth = 1
     *   pauseFundRecalc();      // depth = 2
     *   resumeFundRecalc();     // depth = 1 (recalc NOT called)
     *   resumeFundRecalc();     // depth = 0 (recalc IS called)
     */
    pauseFundRecalc() {
        this._pauseFundRecalcDepth++;
    }

    /**
     * Resume fund recalculation after batch updates.
     * Recalculation only happens when depth reaches 0 (all pauses resolved).
     * All orders updated during pause are now reflected in fund calculations.
     */
    resumeFundRecalc() {
        if (this._pauseFundRecalcDepth > 0) {
            this._pauseFundRecalcDepth--;
        }
        if (this._pauseFundRecalcDepth === 0) {
            this.recalculateFunds();
        }
    }

    getInitialOrdersToActivate() {
        const sellCount = Math.max(0, Number(this.config.activeOrders?.sell || 1));
        const buyCount = Math.max(0, Number(this.config.activeOrders?.buy || 1));
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, this.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        // Use integer arithmetic for size comparisons to match blockchain behavior
        const sellPrecision = this.assets?.assetA?.precision || PRECISION_DEFAULTS.ASSET_FALLBACK;
        const buyPrecision = this.assets?.assetB?.precision || PRECISION_DEFAULTS.ASSET_FALLBACK;
        const minSellSizeInt = floatToBlockchainInt(minSellSize, sellPrecision);
        const minBuySizeInt = floatToBlockchainInt(minBuySize, buyPrecision);

        const vSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL).sort((a, b) => a.price - b.price).slice(0, sellCount);
        const validSells = vSells.filter(o => floatToBlockchainInt(o.size, sellPrecision) >= minSellSizeInt).sort((a, b) => b.price - a.price);

        const vBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL).sort((a, b) => b.price - a.price).slice(0, buyCount);
        const validBuys = vBuys.filter(o => floatToBlockchainInt(o.size, buyPrecision) >= minBuySizeInt).sort((a, b) => a.price - b.price);

        return [...validSells, ...validBuys];
    }

    getOrdersByTypeAndState(type, state) {
        if (state !== null && type !== null) {
            const stateIds = this._ordersByState[state] || new Set();
            const typeIds = this._ordersByType[type] || new Set();
            return [...stateIds].filter(id => typeIds.has(id)).map(id => this.orders.get(id)).filter(Boolean);
        } else if (state !== null) {
            return [...(this._ordersByState[state] || [])].map(id => this.orders.get(id)).filter(Boolean);
        } else if (type !== null) {
            return [...(this._ordersByType[type] || [])].map(id => this.orders.get(id)).filter(Boolean);
        }
        return Array.from(this.orders.values());
    }

    /**
     * Validate that all order indices are consistent with the orders Map.
     * Use this for debugging if index corruption is suspected.
     * @returns {boolean} true if all indices are valid, false if corruption detected
     */
    validateIndices() {
        for (const [id, order] of this.orders) {
            if (!order) {
                this.logger.log(`Index corruption: ${id} exists in orders Map but is null/undefined`, 'error');
                return false;
            }
            if (!order.state) {
                this.logger.log(`Index corruption: ${id} has no state`, 'error');
                return false;
            }
            if (!order.type) {
                this.logger.log(`Index corruption: ${id} has no type`, 'error');
                return false;
            }
            if (!this._ordersByState[order.state]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByState[${order.state}]`, 'error');
                return false;
            }
            if (!this._ordersByType[order.type]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByType[${order.type}]`, 'error');
                return false;
            }
        }

        // Also check that indices don't reference orders that don't exist
        for (const [state, orderIds] of Object.entries(this._ordersByState)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByState[${state}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        for (const [type, orderIds] of Object.entries(this._ordersByType)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByType[${type}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Perform a defensive index consistency check and repair if possible.
     * Call this after critical operations or periodically as a safety measure.
     * THREAD-SAFE: Does not modify orders, only validates/logs
     * @returns {boolean} true if indices are valid, false if corruption found
     */
    assertIndexConsistency() {
        if (!this.validateIndices()) {
            this.logger.log('CRITICAL: Index corruption detected! Attempting repair...', 'error');
            return this._repairIndices();
        }
        return true;
    }

    /**
     * Repair indices by rebuilding them from the orders Map.
     * ONLY call this if corruption is detected - rebuilds both index sets.
     * @returns {boolean} true if repair succeeded, false if structure is damaged
     */
    _repairIndices() {
        try {
            // Clear and rebuild all indices
            for (const set of Object.values(this._ordersByState)) set.clear();
            for (const set of Object.values(this._ordersByType)) set.clear();

            // Rebuild from orders Map
            for (const [id, order] of this.orders) {
                if (order && order.state && order.type) {
                    this._ordersByState[order.state]?.add(id);
                    this._ordersByType[order.type]?.add(id);
                } else {
                    this.logger.log(`Skipping corrupted order ${id} during index repair`, 'warn');
                }
            }

            // Verify repair worked
            if (this.validateIndices()) {
                this.logger.log('✓ Index repair successful', 'info');
                return true;
            } else {
                this.logger.log('✗ Index repair failed - structure is damaged', 'error');
                return false;
            }
        } catch (e) {
            this.logger.log(`Index repair failed with exception: ${e.message}`, 'error');
            return false;
        }
    }

    /**
     * Get all PARTIAL orders of a given type that are NOT locked.
     *
     * PARTIAL orders are those that have partially filled on-chain and are waiting for
     * consolidation or rotation. They are critical to the multi-partial consolidation
     * logic which:
     * - Restores outer partials to their ideal grid sizes
     * - Absorbs residual capital into the innermost partial
     * - Prevents "traffic jams" where multiple partials block each other
     *
     * We exclude locked orders because they are being processed in parallel by
     * other operations (fills, rotations, etc.) and should not be moved while locked.
     */
    getPartialOrdersOnSide(type) {
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter(o => !this.isOrderLocked(o.id) && !this.isOrderLocked(o.orderId));
    }

    async fetchOrderUpdates(options = { calculate: false }) {
        try {
            const activeOrders = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
            if (activeOrders.length === 0 || (options && options.calculate)) {
                const { remaining, filled } = await this.calculateOrderUpdates();
                remaining.forEach(o => this.orders.set(o.id, o));
                if (filled.length > 0) await this.processFilledOrders(filled);
                return { remaining, filled };
            }
            return { remaining: activeOrders, filled: [] };
        } catch (e) {
            this.logger.log(`Error fetching order updates: ${e.message}`, 'error');
            return { remaining: [], filled: [] };
        }
    }

    async calculateOrderUpdates() {
        const active = this.getOrdersByTypeAndState(null, ORDER_STATES.ACTIVE);
        const start = this.config.startPrice;
        const sells = active.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => Math.abs(a.price - start) - Math.abs(b.price - start));
        const buys = active.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => Math.abs(a.price - start) - Math.abs(b.price - start));
        const filled = [];
        if (sells.length > 0) filled.push({ ...sells[0] });
        else if (buys.length > 0) filled.push({ ...buys[0] });
        return { remaining: active.filter(o => !filled.some(f => f.id === o.id)), filled };
    }

    async checkSpreadCondition(BitShares, batchCb) {
        const Grid = require('./grid');
        return await Grid.checkSpreadCondition(this, BitShares, batchCb);
    }

    async checkGridHealth(batchCb) {
        const Grid = require('./grid');
        return await Grid.checkGridHealth(this, batchCb);
    }

    calculateCurrentSpread() {
        const Grid = require('./grid');
        return Grid.calculateCurrentSpread(this);
    }

    /**
     * Generic retry wrapper for persistence operations.
     * Handles transient failures gracefully without crashing.
     */
    async _persistWithRetry(persistFn, dataType, dataValue, maxAttempts = 3) {
        if (!this.config || !this.config.botKey || !this.accountOrders) {
            return true;  // Can't persist, but that's ok (e.g., dry run)
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await persistFn();  // Execute the persistence function
                this.logger.log(`✓ Persisted ${dataType}`, 'debug');

                // Clear any previous persistence warning flag
                if (this._persistenceWarning) {
                    delete this._persistenceWarning;
                }
                return true;  // Success
            } catch (e) {
                if (attempt === maxAttempts) {
                    // All retries failed - don't throw, just flag the issue
                    this.logger.log(`CRITICAL: Failed to persist ${dataType} after ${attempt} attempts: ${e.message}. Data held in memory. Will retry on next cycle.`, 'error');

                    // Flag this issue so caller can know persistence is degraded
                    this._persistenceWarning = { dataType, error: e.message, timestamp: Date.now() };
                    return false;
                } else {
                    // Retry with exponential backoff (capped at TIMING.ACCOUNT_TOTALS_TIMEOUT_MS)
                    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), TIMING.ACCOUNT_TOTALS_TIMEOUT_MS);
                    this.logger.log(`Attempt ${attempt}/${maxAttempts} to persist ${dataType} failed: ${e.message}. Retrying in ${delayMs}ms...`, 'warn');
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }
        return false;
    }

    /**
     * Unified persistence for grid state and fund metadata.
     * Delegates to OrderUtils.persistGridSnapshot for centralized handling.
     */
    async persistGrid() {
        const { persistGridSnapshot } = require('./utils');
        return await persistGridSnapshot(this, this.accountOrders, this.config.botKey);
    }
}

module.exports = { OrderManager };