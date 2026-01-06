/**
 * modules/order/sync_engine.js
 *
 * Specialized engine for blockchain synchronization.
 * Responsible for matching chain orders to the grid and processing fill history.
 */

const { ORDER_TYPES, ORDER_STATES, TIMING, PRECISION_DEFAULTS } = require('../constants');
const { 
    blockchainToFloat, 
    floatToBlockchainInt, 
    calculatePriceTolerance, 
    findMatchingGridOrderByOpenOrder, 
    applyChainSizeToGridOrder, 
    convertToSpreadPlaceholder,
    hasValidAccountTotals
} = require('./utils');

class SyncEngine {
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Reconcile grid orders against fresh blockchain open orders snapshot.
     * This is the MAIN SYNCHRONIZATION MECHANISM that corrects the grid state when
     * the blockchain state diverges from our local expectations.
     *
     * CRITICAL: This method uses AsyncLock (defense-in-depth) to ensure only one
     * full-sync operation runs at a time. WITHIN that lock, per-order locks prevent
     * concurrent createOrder/cancelOrder races.
     *
     * LOCK HIERARCHY:
     * 1. _syncLock (AsyncLock): Ensures only one full-sync at a time
     * 2. Per-order locks (shadowOrderIds): Protect specific orders during sync
     * 3. Lock refresh mechanism: Prevents timeout during long reconciliation
     *
     * RECONCILIATION FLOW:
     * ========================================================================
     * This method performs a two-pass reconciliation:
     *
     * PASS 1: Match grid orders to chain orders (known grid → chain lookup)
     * - For each grid order with an orderId, find the matching chain order
     * - Detect partial fills: if chain size < grid size, downgrade to PARTIAL state
     * - Detect full fills: if order no longer exists on chain, convert to SPREAD
     * - Detect price slippage: flag orders for price correction if needed
     * - Update grid order sizes to match chain reality
     *
     * PASS 2: Orphan chain orders (chain → grid lookup)
     * - For chain orders not matched in Pass 1, find best grid slot match
     * - This handles cases where an order was placed but grid lost track (race condition)
     * - Uses price tolerance and geometric proximity to find the best match
     * - Once matched, retroactively assign orderId and synchronize state
     *
     * CRITICAL RULES:
     * 1. ACTIVE orders can only stay ACTIVE if size matches chain exactly
     *    If chain size < grid size → must transition to PARTIAL
     * 2. If an ACTIVE order is not found on chain → it filled → convert to SPREAD
     * 3. Precision matters: Use blockchain integer arithmetic to compare sizes
     *    Floating point comparisons can give false positives for partial fills
     * 4. Size updates are applied via applyChainSizeToGridOrder() which handles
     *    precision conversion and may adjust sizes slightly for blockchain granularity
     *
     * RETURNS: { filledOrders, updatedOrders, ordersNeedingCorrection }
     * - filledOrders: Orders that completed (now SPREAD placeholders)
     * - updatedOrders: All orders modified during sync (state changes, size updates)
     * - ordersNeedingCorrection: Orders with price slippage requiring correction
     *
     * EDGE CASES HANDLED:
     * - Orphan chain orders (placed but grid lost track due to race condition)
     * - Partial fills (size reduced on chain)
     * - Full fills (order removed from chain completely)
     * - Price tolerance (small slippage acceptable, large slippage flagged)
     * - Precision mismatches (blockchain integer precision vs float grid)
     * - Double spending prevention (each chain order matched to at most one grid order)
     */
    /**
     * Synchronize grid orders with blockchain open orders snapshot.
     * @param {Array|null} chainOrders - Array of blockchain order objects
     * @param {Object|null} fillInfo - Optional fill information metadata
     * @returns {Promise<Object>} Result with filledOrders, updatedOrders, ordersNeedingCorrection
     */
    async syncFromOpenOrders(chainOrders, fillInfo = null) {
        const mgr = this.manager;

        if (!mgr) {
            throw new Error('manager required for syncFromOpenOrders');
        }
        if (!mgr._syncLock) {
            mgr.logger?.log?.('Error: syncLock not initialized', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        // Defense-in-depth: Use AsyncLock to ensure only one full-sync at a time
        return await mgr._syncLock.acquire(async () => {
            return this._doSyncFromOpenOrders(chainOrders, fillInfo);
        });
    }

    /**
     * Internal method that performs the actual sync logic.
     * Called within _syncLock to guarantee exclusive execution.
     * @param {Array|null} chainOrders - Array of blockchain order objects
     * @param {Object|null} fillInfo - Optional metadata
     * @returns {Promise<Object>} Sync result
     * @private
     */
    async _doSyncFromOpenOrders(chainOrders, fillInfo = null) {
        const mgr = this.manager;

        // Validate inputs
        if (!mgr) {
            throw new Error('manager required');
        }
        if (!chainOrders || !Array.isArray(chainOrders)) {
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }
        if (!mgr.orders || !(mgr.orders instanceof Map)) {
            mgr.logger?.log?.('Error: manager.orders is not initialized as a Map', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }
        if (mgr.assets?.assetA?.precision === undefined || mgr.assets?.assetB?.precision === undefined) {
            mgr.logger?.log?.('Error: manager.assets precision missing', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        }

        const assetAPrecision = mgr.assets.assetA.precision;
        const assetBPrecision = mgr.assets.assetB.precision;

        const parsedChainOrders = new Map();
        for (const order of chainOrders) {
            // Validate order structure before processing
            if (!order || !order.id || !order.sell_price || !order.for_sale) {
                mgr.logger?.log?.(`Warning: Skipping malformed chain order missing required fields`, 'warn');
                continue;
            }

            try {
                const sellAssetId = order.sell_price.base?.asset_id;
                const receiveAssetId = order.sell_price.quote?.asset_id;

                if (!sellAssetId || !receiveAssetId) {
                    mgr.logger?.log?.(`Warning: Chain order ${order.id} missing asset IDs`, 'warn');
                    continue;
                }

                const type = (sellAssetId === mgr.assets.assetA.id) ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
                const precision = (type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const size = blockchainToFloat(order.for_sale, precision);
                const price = (type === ORDER_TYPES.SELL)
                    ? (Number(order.sell_price.quote.amount) / Number(order.sell_price.base.amount)) * Math.pow(10, assetBPrecision - assetAPrecision)
                    : (Number(order.sell_price.base.amount) / Number(order.sell_price.quote.amount)) * Math.pow(10, assetBPrecision - assetAPrecision);
                parsedChainOrders.set(order.id, { id: order.id, type, size, price, raw: order });
            } catch (e) {
                mgr.logger?.log?.(`Warning: Error parsing chain order ${order.id}: ${e.message}`, 'warn');
                continue;
            }
        }

        // Collect all order IDs that might be modified during reconciliation
        // Lock them to prevent concurrent modifications from createOrder/cancelOrder
        const orderIdsToLock = new Set();
        for (const gridOrder of mgr.orders.values()) {
            // Lock any order with a chain orderId (already on-chain)
            if (gridOrder.orderId) {
                orderIdsToLock.add(gridOrder.id);
                orderIdsToLock.add(gridOrder.orderId);
            }
            // Also lock ACTIVE/PARTIAL orders that might transition to/from SPREAD
            if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                orderIdsToLock.add(gridOrder.id);
            }
        }

        const chainOrderIdsOnGrid = new Set();
        const matchedGridOrderIds = new Set();
        const filledOrders = [];
        const updatedOrders = [];
        const ordersNeedingCorrection = [];

        // Lock orders before reconciliation
        mgr.lockOrders([...orderIdsToLock]);

        // Set up lock refresh mechanism to prevent timeout during long reconciliation
        // Refreshes every LOCK_TIMEOUT_MS/2 to keep locks alive
        //
        // DESIGN NOTE: The refresh mechanism ensures that long-running reconciliations
        // don't lose their locks mid-operation. If reconciliation completes normally,
        // clearInterval() in the finally block stops the refresh. If the process crashes
        // before finally executes, the locks will eventually expire after LOCK_TIMEOUT_MS,
        // allowing orders to be unlocked and traded again in the next bot instance.
        const lockRefreshInterval = setInterval(() => {
            const now = Date.now();
            for (const id of orderIdsToLock) {
                mgr.shadowOrderIds.set(id, now);
            }
            mgr.logger?.log?.(`Refreshed locks for ${orderIdsToLock.size} orders to prevent timeout expiry`, 'debug');
        }, TIMING.LOCK_TIMEOUT_MS / 2);

        try {
            mgr.pauseFundRecalc();
            // Reconciliation logic moved below in the try block
            this._performSyncFromOpenOrders(mgr, assetAPrecision, assetBPrecision, parsedChainOrders,
                                            chainOrderIdsOnGrid, matchedGridOrderIds, filledOrders, updatedOrders, ordersNeedingCorrection);
        } finally {
            mgr.resumeFundRecalc();
            // Stop refresh interval first
            clearInterval(lockRefreshInterval);
            // Unlock after reconciliation completes
            mgr.unlockOrders([...orderIdsToLock]);
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection };
    }

    /**
     * Internal helper that performs the actual reconciliation logic.
     * Called with locks held to prevent concurrent modifications.
     */
    _performSyncFromOpenOrders(mgr, assetAPrecision, assetBPrecision, parsedChainOrders,
                               chainOrderIdsOnGrid, matchedGridOrderIds, filledOrders, updatedOrders, ordersNeedingCorrection) {

        for (const gridOrder of mgr.orders.values()) {
            if (gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) {
                const chainOrder = parsedChainOrders.get(gridOrder.orderId);
                const updatedOrder = { ...gridOrder };
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                matchedGridOrderIds.add(gridOrder.id);

                const priceTolerance = calculatePriceTolerance(gridOrder.price, gridOrder.size, gridOrder.type, mgr.assets);
                if (Math.abs(chainOrder.price - gridOrder.price) > priceTolerance) {
                    ordersNeedingCorrection.push({ gridOrder: { ...gridOrder }, chainOrderId: gridOrder.orderId, expectedPrice: gridOrder.price, actualPrice: chainOrder.price, size: chainOrder.size, type: gridOrder.type });
                }

                const precision = (gridOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const currentSizeInt = floatToBlockchainInt(gridOrder.size, precision);
                const chainSizeInt = floatToBlockchainInt(chainOrder.size, precision);

                if (currentSizeInt !== chainSizeInt) {
                    const newSize = blockchainToFloat(chainSizeInt, precision);
                    const newInt = floatToBlockchainInt(newSize, precision);

                    if (newInt > 0) {
                        applyChainSizeToGridOrder(mgr, updatedOrder, newSize);
                        if (updatedOrder.state === ORDER_STATES.ACTIVE) {
                            updatedOrder.state = ORDER_STATES.PARTIAL;
                        }
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                        mgr._updateOrder(spreadOrder);
                        filledOrders.push({ ...gridOrder });
                        updatedOrders.push(spreadOrder);
                        continue;
                    }
                }
                mgr._updateOrder(updatedOrder);
                updatedOrders.push(updatedOrder);
            } else if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                if (gridOrder.orderId && !parsedChainOrders.has(gridOrder.orderId)) {
                    const filledOrder = { ...gridOrder };
                    const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                    mgr._updateOrder(spreadOrder);
                    filledOrders.push(filledOrder);
                }
            }
        }

        for (const [chainOrderId, chainOrder] of parsedChainOrders) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue;
            let bestMatch = findMatchingGridOrderByOpenOrder({ orderId: chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size }, { orders: mgr.orders, assets: mgr.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets), logger: mgr.logger });

            if (bestMatch && !matchedGridOrderIds.has(bestMatch.id)) {
                bestMatch.orderId = chainOrderId;
                bestMatch.state = ORDER_STATES.ACTIVE;
                matchedGridOrderIds.add(bestMatch.id);

                const precision = (bestMatch.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                if (floatToBlockchainInt(bestMatch.size, precision) !== floatToBlockchainInt(chainOrder.size, precision)) {
                    applyChainSizeToGridOrder(mgr, bestMatch, chainOrder.size);
                    if (floatToBlockchainInt(chainOrder.size, precision) > 0) {
                        if (bestMatch.state === ORDER_STATES.ACTIVE) bestMatch.state = ORDER_STATES.PARTIAL;
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(bestMatch);
                        filledOrders.push({ ...bestMatch });
                        bestMatch = spreadOrder;
                    }
                }
                mgr._updateOrder(bestMatch);
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            }
        }
    }

    /**
     * Process a single fill history operation (incremental update).
     * This is called for individual fills detected in blockchain history, as opposed to
     * the snapshot approach used by syncFromOpenOrders().
     *
     * FILL PROCESSING:
     * ========================================================================
     * When an order fills on-chain, we need to:
     * 1. Find the grid order matching this fill's orderId
     * 2. Calculate how much of the order was filled (based on asset paid)
     * 3. Update grid size: newSize = currentSize - filledAmount
     * 4. Determine if fill is complete or partial
     * 5. For DoubleOrders, track accumulated fills and trigger delayed rotations
     *
     * PRECISION HANDLING:
     * Fill amounts must be converted using the same blockchain precision as the order.
     * For SELL orders: check paysAsset == assetA (what we sold)
     * For BUY orders: check paysAsset == assetB (what we paid)
     * Use floatToBlockchainInt/blockchainToFloat to ensure consistency.
     *
     * DOUBLEORDER SPECIAL HANDLING:
     * DoubleOrders are created when the innermost partial absorbs residual capital
     * from other partials during consolidation. They have a mergedDustSize field
     * tracking how much "extra" size was merged in.
     *
     * Delayed Rotation Logic:
     * - Track filledSinceRefill: cumulative fills since consolidation
     * - When filledSinceRefill >= mergedDustSize:
     *   * Mark fill as isDelayedRotationTrigger (signals later rotation)
     *   * Clear isDoubleOrder flag
     *   * Reset filledSinceRefill to 0
     *   * Return to ACTIVE state for rotation
     * - This prevents premature rotations while the merged dust is still useful
     *
     * COMPLETE vs PARTIAL FILL:
     * - Complete: newSize <= 0 → convert to SPREAD placeholder
     * - Partial: newSize > 0 → stay in PARTIAL state, track remaining
     *
     * RETURNS: { filledOrders, updatedOrders, partialFill }
     * - filledOrders: The filled portion (what was sold/paid)
     * - updatedOrders: The updated grid order (remaining portion)
     * - partialFill: true if fill was partial (order still on chain), false if complete
     */
    syncFromFillHistory(fillOp) {
        const mgr = this.manager;
        if (!fillOp || !fillOp.order_id) return { filledOrders: [], updatedOrders: [], partialFill: false };

        mgr.pauseFundRecalc();
        try {
            const orderId = fillOp.order_id;
            const paysAmount = fillOp.pays ? Number(fillOp.pays.amount) : 0;
            const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;

            const assetAPrecision = mgr.assets?.assetA?.precision;
            const assetBPrecision = mgr.assets?.assetB?.precision;

            if (assetAPrecision === undefined || assetBPrecision === undefined) {
                mgr.logger?.log?.('Error: manager.assets precision missing in syncFromFillHistory', 'error');
                return { filledOrders: [], updatedOrders: [], partialFill: false };
            }

            let matchedGridOrder = null;
            for (const gridOrder of mgr.orders.values()) {
                if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                    matchedGridOrder = gridOrder;
                    break;
                }
            }

            if (!matchedGridOrder) return { filledOrders: [], updatedOrders: [], partialFill: false };

            const orderType = matchedGridOrder.type;
            const currentSize = Number(matchedGridOrder.size || 0);
            let filledAmount = 0;
            if (orderType === ORDER_TYPES.SELL) {
                if (paysAssetId === mgr.assets.assetA.id) filledAmount = blockchainToFloat(paysAmount, assetAPrecision);
            } else {
                if (paysAssetId === mgr.assets.assetB.id) filledAmount = blockchainToFloat(paysAmount, assetBPrecision);
            }

            const precision = (orderType === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
            const currentSizeInt = floatToBlockchainInt(currentSize, precision);
            const filledAmountInt = floatToBlockchainInt(filledAmount, precision);
            const newSizeInt = Math.max(0, currentSizeInt - filledAmountInt);
            const newSize = blockchainToFloat(newSizeInt, precision);

            const filledOrders = [];
            const updatedOrders = [];
            if (newSizeInt <= 0) {
                const filledOrder = { ...matchedGridOrder };
                const spreadOrder = convertToSpreadPlaceholder(matchedGridOrder);
                mgr._updateOrder(spreadOrder);
                filledOrders.push(filledOrder);
                return { filledOrders, updatedOrders, partialFill: false };
            } else {
                const filledPortion = { ...matchedGridOrder, size: filledAmount, isPartial: true };
                const updatedOrder = { ...matchedGridOrder };
                updatedOrder.state = ORDER_STATES.PARTIAL;
                applyChainSizeToGridOrder(mgr, updatedOrder, newSize);

                if (updatedOrder.isDoubleOrder && updatedOrder.mergedDustSize) {
                    updatedOrder.filledSinceRefill = (Number(updatedOrder.filledSinceRefill) || 0) + filledAmount;
                    const mergedDustSize = Number(updatedOrder.mergedDustSize);

                    // Double order stays ACTIVE while size >= original core size (before dust merged)
                    // Once it drops below original core size, it becomes PARTIAL
                    const originalCoreSize = (Number(matchedGridOrder.size) || 0) - mergedDustSize;
                    const currentSize = Number(updatedOrder.size) || 0;

                    if (currentSize < originalCoreSize) {
                        // Order has filled below the original core size - become PARTIAL
                        updatedOrder.state = ORDER_STATES.PARTIAL;
                    } else {
                        // Still at or above original core size - stay ACTIVE
                        updatedOrder.state = ORDER_STATES.ACTIVE;
                    }

                    // When accumulated fills reach mergedDustSize, trigger delayed rotation
                    if (updatedOrder.filledSinceRefill >= mergedDustSize) {
                        filledPortion.isDelayedRotationTrigger = true;
                        updatedOrder.isDoubleOrder = false;
                        updatedOrder.pendingRotation = false;
                        updatedOrder.filledSinceRefill = 0;
                    }
                }
                mgr._updateOrder(updatedOrder);
                updatedOrders.push(updatedOrder);
                filledOrders.push(filledPortion);
                return { filledOrders, updatedOrders, partialFill: true };
            }
        } finally {
            mgr.resumeFundRecalc();
        }
    }

    /**
     * High-level dispatcher for different blockchain synchronization sources.
     * Routes to the appropriate sync strategy based on the data source.
     *
     * SOURCES AND STRATEGIES:
     * ========================================================================
     * source: 'createOrder'
     *   Purpose: Grid order was successfully placed on-chain
     *   Data: { gridOrderId, chainOrderId, isPartialPlacement, fee }
     *   Action:
     *     1. Look up grid order by gridOrderId
     *     2. Assign the returned chainOrderId (so we can find it later)
     *     3. Transition state based on isPartialPlacement:
     *        - false → ACTIVE (full order placed)
     *        - true → PARTIAL (placed as partial, likely due to insufficient funds)
     *     4. Update optimistic chainFree balance (deduct fees if BTS pair)
     *   Fund Impact: Funds transition from free → locked/committed
     *
     * source: 'cancelOrder'
     *   Purpose: Grid order was successfully cancelled on-chain
     *   Data: The chainOrderId to cancel
     *   Action:
     *     1. Find grid order by orderId (reverse lookup)
     *     2. Transition to VIRTUAL (order no longer on-chain)
     *     3. Clear orderId so it can be re-used
     *     4. Update optimistic chainFree balance (add funds back as free)
     *   Fund Impact: Funds transition from locked → free
     *   Note: This is used for direct cancellations (not rotation/consolidation)
     *
     * source: 'readOpenOrders' or 'periodicBlockchainFetch'
     *   Purpose: Full snapshot sync of all open orders from blockchain
     *   Data: Array of chain orders from blockchain API
     *   Action: Delegates to syncFromOpenOrders() for full reconciliation
     *   Use Case: Periodic health check or startup initialization
     *
     * FUND TRACKING:
     * Both 'createOrder' and 'cancelOrder' call updateOptimisticFreeBalance() to
     * keep the optimistic chainFree balance in sync with actual on-chain state.
     * This prevents fund leaks where placed orders weren't deducted or cancelled
     * orders weren't released.
     *
     * RETURNS: { newOrders, ordersNeedingCorrection }
     * Most callers use ordersNeedingCorrection to flag price corrections needed.
     * Only syncFromOpenOrders() populates ordersNeedingCorrection.
     */
    async synchronizeWithChain(chainData, source) {
        const mgr = this.manager;
        if (!mgr.assets) return { newOrders: [], ordersNeedingCorrection: [] };

        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId, isPartialPlacement, fee } = chainData;
                // Lock order to prevent concurrent modifications during state transition
                mgr.lockOrders([gridOrderId]);
                try {
                    const gridOrder = mgr.orders.get(gridOrderId);
                    if (gridOrder) {
                        const newState = isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                        const updatedOrder = { ...gridOrder, state: newState, orderId: chainOrderId };
                        mgr.accountant.updateOptimisticFreeBalance(gridOrder, updatedOrder, 'createOrder', fee);
                        mgr._updateOrder(updatedOrder);
                    }
                } finally {
                    mgr.unlockOrders([gridOrderId]);
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData;
                const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: mgr.orders, assets: mgr.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets), logger: mgr.logger });
                if (gridOrder) {
                    // Lock both chain orderId and grid order ID to prevent concurrent modifications
                    const orderIds = [orderId, gridOrder.id].filter(Boolean);
                    mgr.lockOrders(orderIds);
                    try {
                        // Re-fetch to ensure we have latest state after acquiring lock
                        const currentGridOrder = mgr.orders.get(gridOrder.id);
                        if (currentGridOrder && currentGridOrder.orderId === orderId) {
                            const updatedOrder = { ...currentGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
                            mgr.accountant.updateOptimisticFreeBalance(currentGridOrder, updatedOrder, 'cancelOrder');
                            mgr._updateOrder(updatedOrder);
                        }
                    } finally {
                        mgr.unlockOrders(orderIds);
                    }
                }
                break;
            }
            case 'readOpenOrders':
            case 'periodicBlockchainFetch': {
                return this.syncFromOpenOrders(chainData);
            }
        }
        return { newOrders: [], ordersNeedingCorrection: [] };
    }

    /**
     * Fetch account balances from blockchain and update optimistic fund totals.
     * This is a critical method for financial accuracy and must be called periodically.
     *
     * BALANCE FETCHING:
     * ========================================================================
     * This method queries the blockchain for the actual account balances in both
     * assetA and assetB. It retrieves:
     *   - total: Total balance (including locked amounts)
     *   - free: Available balance (not locked in orders)
     *
     * These are stored in mgr.accountTotals as:
     *   - sell: assetA total (what we can sell)
     *   - sellFree: assetA available
     *   - buy: assetB total (what we can buy with)
     *   - buyFree: assetB available
     *
     * IMPORTANCE FOR FUND TRACKING:
     * The grid maintains an "optimistic" free balance that tracks fund deductions
     * as orders transition states. However, the blockchain is the source of truth.
     * Periodically fetching actual balances allows us to:
     *
     * 1. RECONCILE: Detect if optimistic state diverged from reality
     *    Example: If we think buyFree=1000 but blockchain says 950,
     *    something was deducted (fee, slippage, etc.) that we didn't track.
     *
     * 2. RECOVER: Identify "orphaned" funds that got stuck somewhere
     *    If actual > optimistic, we can reabsorb the extra into available pool.
     *
     * 3. PREVENT OVERSPEND: Use actual totals as the hard ceiling
     *    Even if optimistic calc says we have X funds, we never exceed actual total.
     *
     * FUND FORMULA:
     * At any time, this should hold:
     *   chainTotal = chainFree + chainCommitted
     * Where:
     *   chainTotal = actual on-chain total from blockchain
     *   chainFree = free balance (unallocated)
     *   chainCommitted = sum of all ACTIVE/PARTIAL order sizes on-chain
     *
     * ASSET INITIALIZATION:
     * First calls initializeAssets() to ensure assetA and assetB metadata is loaded.
     * Without this, we can't convert between blockchain precision and float values.
     *
     * ERROR HANDLING:
     * Gracefully handles lookup failures. If blockchain fetch fails, we don't crash
     * but instead log a warning. The system continues with last-known balances.
     */
    async fetchAccountBalancesAndSetTotals() {
        const mgr = this.manager;
        try {
            const { BitShares } = require('../bitshares_client');
            if (!BitShares || !BitShares.db) return;
            const accountIdOrName = mgr.accountId || mgr.account || null;
            if (!accountIdOrName) return;

            try { await this.initializeAssets(); } catch (err) { }
            const assetAId = mgr.assets?.assetA?.id;
            const assetBId = mgr.assets?.assetB?.id;
            if (!assetAId || !assetBId) return;

            const { getOnChainAssetBalances } = require('../chain_orders');
            const lookup = await getOnChainAssetBalances(accountIdOrName, [assetAId, assetBId]);
            const aInfo = lookup?.[assetAId] || lookup?.[mgr.config.assetA];
            const bInfo = lookup?.[assetBId] || lookup?.[mgr.config.assetB];

            if (aInfo && bInfo) {
                mgr.setAccountTotals({ sell: aInfo.total, sellFree: aInfo.free, buy: bInfo.total, buyFree: bInfo.free });
            }
        } catch (err) {
            mgr.logger.log(`Failed to fetch on-chain balances: ${err.message}`, 'warn');
        }
    }

    /**
     * Initialize asset metadata for assetA and assetB.
     * This must be called before any blockchain operations, as asset metadata
     * (ID, precision) is required for all conversions and lookups.
     *
     * WHY ASSET METADATA MATTERS:
     * ========================================================================
     * The blockchain and grid use different representations for amounts:
     *
     * Blockchain: Uses integers (atomic units based on asset precision)
     *   - BTS: precision 5 → 1 BTS = 100000 satoshis
     *   - USDT: precision 6 → 1 USDT = 1000000 satoshis
     *   Storage on-chain is always integer to prevent floating-point errors
     *
     * Grid: Uses floats for all calculations
     *   - Easier to work with for price/size calculations
     *   - Must round-trip correctly through blockchain precision
     *
     * Asset Metadata Needed:
     * 1. asset_id: Required to match orders on-chain
     *    When we see an order selling assetA for assetB, we identify it by comparing
     *    the asset_ids in the sell_price object.
     *
     * 2. precision: Required for float ↔ integer conversions
     *    floatToBlockchainInt(1.5, precision=5) = 150000
     *    blockchainToFloat(150000, precision=5) = 1.5
     *
     * Without precision, we can't:
     * - Compare order sizes (float vs blockchain int)
     * - Calculate fills (precision matters at extreme sizes)
     * - Match chain orders to grid orders (need correct ID)
     * - Convert fill amounts to grid sizes
     *
     * INITIALIZATION STRATEGY:
     * Assets are looked up asynchronously via the BitShares API.
     * The lookup is idempotent: if assets are already initialized, returns immediately.
     * This allows safe calls from multiple places without redundant lookups.
     *
     * ERROR HANDLING:
     * If asset lookup fails (asset doesn't exist, API error, etc.), the error
     * is propagated (not caught). This is intentional - a missing asset is a
     * configuration error that must be fixed before the bot can operate.
     */
    async initializeAssets() {
        const mgr = this.manager;
        if (mgr.assets) return;
        try {
            const { lookupAsset } = require('./utils');
            const { BitShares } = require('../bitshares_client');
            mgr.assets = {
                assetA: await lookupAsset(BitShares, mgr.config.assetA),
                assetB: await lookupAsset(BitShares, mgr.config.assetB)
            };
        } catch (err) {
            mgr.logger.log(`Asset metadata lookup failed: ${err.message}`, 'error');
            throw err;
        }
    }
}

module.exports = SyncEngine;
