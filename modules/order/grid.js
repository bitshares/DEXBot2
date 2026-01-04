/**
 * Grid - Order grid creation, synchronization, and health management
 *
 * This module manages the complete lifecycle of the order grid:
 * - Creates geometric price grids with configurable spacing
 * - Synchronizes grid state with blockchain and fund changes
 * - Monitors grid health and handles spread corrections
 */

const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, GRID_LIMITS, TIMING, INCREMENT_BOUNDS, FEE_PARAMETERS } = require('../constants');
const { GRID_COMPARISON } = GRID_LIMITS;
const {
    floatToBlockchainInt,
    blockchainToFloat,
    filterOrdersByType,
    filterOrdersByTypeAndState,
    sumOrderSizes,
    mapOrderSizes,
    getPrecisionByOrderType,
    getPrecisionForSide,
    getPrecisionsForManager,
    checkSizesBeforeMinimum,
    checkSizesNearMinimum,
    calculateOrderCreationFees,
    deductOrderFeesFromFunds,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateGridSideDivergenceMetric,
    resolveConfiguredPriceBound,
    getMinOrderSize,
    calculateAvailableFundsValue,
    calculateSpreadFromOrders,
    countOrdersByType,
    shouldFlagOutOfSpread,
    derivePrice
} = require('./utils');

class Grid {
    /**
     * Create the initial order grid structure based on configuration.
     * Generates physical price levels and identifies the spread zone.
     * 
     * @param {Object} config - Grid configuration
     * @returns {Object} { orders: Array, initialSpreadCount: { buy, sell } }
     */
    static createOrderGrid(config) {
        const { startPrice, minPrice, maxPrice, incrementPercent } = config;

        if (incrementPercent <= 0 || incrementPercent >= 100) {
            throw new Error(`Invalid incrementPercent: ${incrementPercent}. Must be between ${INCREMENT_BOUNDS.MIN_PERCENT} and ${INCREMENT_BOUNDS.MAX_PERCENT}.`);
        }

        // Geometric price steps: each order is multiplied by stepUp (sell) or stepDown (buy)
        // This creates exponential spacing: useful for covering wide price ranges
        const stepUp = 1 + (incrementPercent / 100);
        const stepDown = 1 - (incrementPercent / 100);

        // Spread zone width calculation: determine how many orders should be in the spread zone
        // between market price. Spread width determines order density near market.
        const minSpreadPercent = incrementPercent * Number(GRID_LIMITS.MIN_SPREAD_FACTOR);
        const targetSpreadPercent = Math.max(config.targetSpreadPercent, minSpreadPercent);

        // Calculate number of spread orders needed to achieve target spread width
        // Formula: nOrders = ceil(log(1 + spread%) / log(stepUp))
        // This ensures the outer-most spread order is approximately at the target spread distance
        const calculatedNOrders = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(stepUp));
        const nOrders = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS, calculatedNOrders);

        // SELL LEVEL GENERATION: Generate prices above market, growing exponentially upward
        // Starting from startPrice * sqrt(stepUp) ensures symmetric levels around market price
        const sellLevels = [];
        let currentSell = startPrice * Math.sqrt(stepUp);
        while (currentSell <= maxPrice) {
            sellLevels.push(currentSell);
            currentSell *= stepUp;
        }
        sellLevels.reverse(); // Reverse to sort from lowest to highest sell price

        // BUY LEVEL GENERATION: Generate prices below market, growing exponentially downward
        // Starting from startPrice * sqrt(stepDown) for symmetric positioning
        const buyLevels = [];
        let currentBuy = startPrice * Math.sqrt(stepDown);
        while (currentBuy >= minPrice) {
            buyLevels.push(currentBuy);
            currentBuy *= stepDown;
        }
        // Note: buyLevels are naturally in descending order (highest prices first)

        // SPREAD ZONE ASSIGNMENT: Designate outermost orders as SPREAD placeholders
        // These sit in the spread zone and are only activated when price moves
        const buySpread = Math.floor(nOrders / 2);
        const sellSpread = nOrders - buySpread;
        const initialSpreadCount = { buy: 0, sell: 0 };

        // Map sell levels to order objects: highest indices (furthest prices) are SPREAD orders
        const sellOrders = sellLevels.map((price, i) => ({
            price,
            type: i >= sellLevels.length - sellSpread ? (initialSpreadCount.sell++, ORDER_TYPES.SPREAD) : ORDER_TYPES.SELL,
            id: `sell-${i}`,
            state: ORDER_STATES.VIRTUAL,
            size: 0
        }));

        // Map buy levels to order objects: lowest indices (furthest prices) are SPREAD orders
        const buyOrders = buyLevels.map((price, i) => ({
            price,
            type: i < buySpread ? (initialSpreadCount.buy++, ORDER_TYPES.SPREAD) : ORDER_TYPES.BUY,
            id: `buy-${i}`,
            state: ORDER_STATES.VIRTUAL,
            size: 0
        }));

        return { orders: [...sellOrders, ...buyOrders], initialSpreadCount };
    }

    /**
     * Restore a persisted grid snapshot onto a manager instance.
     */
    static async loadGrid(manager, grid) {
        if (!Array.isArray(grid)) return;
        try {
            await manager._initializeAssets();
        } catch (e) {
            manager.logger?.log?.(`Asset initialization failed during grid load: ${e.message}`, 'warn');
        }

        manager.orders.clear();
        Object.values(manager._ordersByState).forEach(set => set.clear());
        Object.values(manager._ordersByType).forEach(set => set.clear());

        const savedCacheFunds = { ...manager.funds.cacheFunds };
        const savedBtsFeesOwed = manager.funds.btsFeesOwed;

        manager.resetFunds();
        manager.funds.cacheFunds = savedCacheFunds;
        manager.funds.btsFeesOwed = savedBtsFeesOwed;

        grid.forEach(order => manager._updateOrder(order));
        manager.logger.log(`Loaded ${manager.orders.size} orders from persisted grid.`, 'info');
    }

    /**
     * Initialize the order grid with blockchain-aware sizing.
     */
    static async initializeGrid(manager) {
        if (!manager) throw new Error('initializeGrid requires a manager instance');
        await manager._initializeAssets();
        
        const mpRaw = manager.config.startPrice;
        
        // Auto-derive price if requested
        if (!Number.isFinite(Number(mpRaw)) || typeof mpRaw === 'string') {
            try {
                const { BitShares } = require('../bitshares_client');
                const derived = await derivePrice(BitShares, manager.config.assetA, manager.config.assetB, manager.config.priceMode || 'auto');
                if (derived) manager.config.startPrice = derived;
            } catch (err) { console.warn("[grid.js] silent catch:", err.message); }
        }

        const mp = Number(manager.config.startPrice);
        const minP = resolveConfiguredPriceBound(manager.config.minPrice, DEFAULT_CONFIG.minPrice, mp, 'min');
        const maxP = resolveConfiguredPriceBound(manager.config.maxPrice, DEFAULT_CONFIG.maxPrice, mp, 'max');
        
        manager.config.minPrice = minP;
        manager.config.maxPrice = maxP;

        // Ensure percentage-based funds are resolved before sizing
        try {
            if (manager.accountId && !manager.accountTotals) {
                await manager.waitForAccountTotals(TIMING.ACCOUNT_TOTALS_TIMEOUT_MS);
            }
        } catch (e) { console.warn("[grid.js] silent catch:", e.message); }

        const { orders, initialSpreadCount } = Grid.createOrderGrid(manager.config);
        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);

        if (manager.applyBotFundsAllocation) manager.applyBotFundsAllocation();

        const snapshot = manager.getChainFundsSnapshot();
        const btsFees = calculateOrderCreationFees(manager.config.assetA, manager.config.assetB, (manager.config.activeOrders.buy + manager.config.activeOrders.sell), FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER);
        const { buyFunds, sellFunds } = deductOrderFeesFromFunds(snapshot.allocatedBuy, snapshot.allocatedSell, btsFees, manager.config);

        const { A: precA, B: precB } = getPrecisionsForManager(manager.assets);
        let sizedOrders = calculateOrderSizes(orders, manager.config, sellFunds, buyFunds, minSellSize, minBuySize, precA, precB);

        // Verification of sizes
        const sells = mapOrderSizes(filterOrdersByType(sizedOrders, ORDER_TYPES.SELL));
        const buys = mapOrderSizes(filterOrdersByType(sizedOrders, ORDER_TYPES.BUY));
        if (checkSizesBeforeMinimum(sells, minSellSize, precA) || checkSizesBeforeMinimum(buys, minBuySize, precB)) {
            throw new Error('Calculated orders fall below minimum allowable size.');
        }

        // Check for warning if orders are near minimal size (regression fix) 
        const warningSellSize = minSellSize > 0 ? getMinOrderSize(ORDER_TYPES.SELL, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR * 2) : 0; 
        const warningBuySize = minBuySize > 0 ? getMinOrderSize(ORDER_TYPES.BUY, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR * 2) : 0; 
        if (checkSizesNearMinimum(sells, warningSellSize, precA) || checkSizesNearMinimum(buys, warningBuySize, precB)) { 
            manager.logger.log("WARNING: Order grid contains orders near minimum size. To ensure the bot runs properly, consider increasing the funds of your bot.", "warn"); 
        }

        manager.orders.clear();
        Object.values(manager._ordersByState).forEach(set => set.clear());
        Object.values(manager._ordersByType).forEach(set => set.clear());
        manager.resetFunds();

        sizedOrders.forEach(order => manager._updateOrder(order));
        manager.targetSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell; manager.currentSpreadCount = manager.targetSpreadCount;
        
        manager.logger.log(`Initialized grid with ${orders.length} orders.`, 'info');
        manager.logger?.logFundsStatus?.(manager);
        manager.logger?.logOrderGrid?.(Array.from(manager.orders.values()), manager.config.startPrice);
    }

    /**
     * Full grid resynchronization from blockchain state.
     */
    static async recalculateGrid(manager, opts) {
        const { readOpenOrdersFn, chainOrders, account, privateKey } = opts;
        manager.logger.log('Starting full resync...', 'info');

        await manager._initializeAssets();
        await manager.updateAccountTotals();

        const chainOpenOrders = await readOpenOrdersFn();
        if (!Array.isArray(chainOpenOrders)) return;

        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
        manager.resetFunds();
        manager.funds.cacheFunds = { buy: 0, sell: 0 };

        await manager.persistGrid();
        await Grid.initializeGrid(manager);

        const { reconcileStartupOrders } = require('./startup_reconcile');
        await reconcileStartupOrders({ manager, config: manager.config, account, privateKey, chainOrders, chainOpenOrders, syncResult: { unmatchedChainOrders: chainOpenOrders } });
        manager.logger.log('Full resync complete.', 'info');
    }

    /**
     * Check for grid divergence and trigger update if threshold is met.
     */
    static checkAndUpdateGridIfNeeded(manager, cacheFunds = { buy: 0, sell: 0 }) {
        const threshold = GRID_LIMITS.GRID_REGENERATION_PERCENTAGE || 1;
        const snap = Grid._getFundSnapshot(manager);
        const result = { buyUpdated: false, sellUpdated: false };

        const sides = [
            { name: 'buy', grid: snap.gridBuy, cache: cacheFunds.buy || snap.cacheBuy, orderType: ORDER_TYPES.BUY },
            { name: 'sell', grid: snap.gridSell, cache: cacheFunds.sell || snap.cacheSell, orderType: ORDER_TYPES.SELL }
        ];

        for (const s of sides) {
            if (s.grid <= 0) continue;
            const avail = calculateAvailableFundsValue(s.name, manager.accountTotals, manager.funds, manager.config.assetA, manager.config.assetB, manager.config.activeOrders);
            const totalPending = s.cache + avail;
            const allocated = s.name === 'buy' ? snap.allocatedBuy : snap.allocatedSell;
            const denominator = (allocated > 0) ? allocated : (s.grid + totalPending);
            const ratio = (denominator > 0) ? (totalPending / denominator) * 100 : 0;

            if (ratio >= threshold) {
                if (!manager._gridSidesUpdated) manager._gridSidesUpdated = [];
                manager._gridSidesUpdated.push(s.orderType);
                if (s.name === 'buy') result.buyUpdated = true; else result.sellUpdated = true;
            }
        }
        return result;
    }

    /**
     * Standardize grid sizes using blockchain total context.
     * @private
     */
    static _recalculateGridOrderSizesFromBlockchain(manager, orderType) {
        if (!manager.assets) return;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const sideName = isBuy ? 'buy' : 'sell';
        const snap = manager.getChainFundsSnapshot ? manager.getChainFundsSnapshot() : {};
        const allocatedFunds = isBuy ? snap.chainTotalBuy : snap.chainTotalSell;

        const orders = Array.from(manager.orders.values()).filter(o => o.type === orderType);
        if (orders.length === 0) return;

        const precision = getPrecisionByOrderType(manager.assets, orderType);
        let fundsForSizing = allocatedFunds;

        if ((isBuy && manager.config.assetB === 'BTS') || (!isBuy && manager.config.assetA === 'BTS')) {
            const targetCount = Math.max(1, manager.config.activeOrders[sideName]);
            const btsFees = calculateOrderCreationFees(manager.config.assetA, manager.config.assetB, targetCount, FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER);
            fundsForSizing = Math.max(0, allocatedFunds - btsFees);
        }

        const newSizes = calculateRotationOrderSizes(fundsForSizing, 0, orders.length, orderType, manager.config, 0, precision);
        Grid._updateOrdersForSide(manager, orderType, newSizes, orders);
        manager.recalculateFunds();

        const totalInputInt = floatToBlockchainInt(allocatedFunds, precision);
        let totalAllocatedInt = 0;
        newSizes.forEach(s => totalAllocatedInt += floatToBlockchainInt(s, precision));
        
        if (!manager.funds.cacheFunds) manager.funds.cacheFunds = { buy: 0, sell: 0 };
        manager.funds.cacheFunds[sideName] = blockchainToFloat(totalInputInt - totalAllocatedInt, precision);
    }

    /**
     * High-level entry for resizing grid from snapshot.
     */
    static async updateGridFromBlockchainSnapshot(manager, orderType = 'both', fromBlockchainTimer = false) {
        if (!fromBlockchainTimer && manager.config?.accountId) {
            await manager.fetchAccountTotals(manager.config.accountId);
        }
        if (orderType === ORDER_TYPES.BUY || orderType === 'both') Grid._recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY);
        if (orderType === ORDER_TYPES.SELL || orderType === 'both') Grid._recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.SELL);
    }

    /**
     * Compare ideal grid vs persisted grid to detect divergence.
     *
     * PURPOSE: Detect if the calculated in-memory grid has diverged significantly from the
     * persisted grid state. High divergence indicates that order fills/rotations have caused
     * size distributions to deviate, potentially requiring a full grid regeneration.
     *
     * METRIC: RMS (Root Mean Square) percentage of relative size differences
     * Formula: RMS% = sqrt(mean((calculated - persisted) / persisted)²) × 100
     * This measures the typical relative error across all orders.
     *
     * @returns {Object} { buy: {metric, updated}, sell: {metric, updated}, totalMetric }
     *   - metric: RMS% divergence (higher = more divergent)
     *   - updated: true if metric exceeds GRID_COMPARISON.RMS_PERCENTAGE threshold
     */
    static compareGrids(calculatedGrid, persistedGrid, manager = null, cacheFunds = null) {
        if (!Array.isArray(calculatedGrid) || !Array.isArray(persistedGrid)) {
            return { buy: { metric: 0, updated: false }, sell: { metric: 0, updated: false }, totalMetric: 0 };
        }

        // Filter to PARTIAL orders only (excludes ACTIVE/SPREAD which have exact sizes)
        // PARTIAL orders are where divergence matters most (they indicate partial fills)
        const filterForRms = (orders, type) => filterOrdersByTypeAndState(orders, type, ORDER_STATES.PARTIAL).filter(o => !o.isDoubleOrder);
        const calculatedBuys = filterForRms(calculatedGrid, ORDER_TYPES.BUY);
        const calculatedSells = filterForRms(calculatedGrid, ORDER_TYPES.SELL);
        const persistedBuys = filterForRms(persistedGrid, ORDER_TYPES.BUY);
        const persistedSells = filterForRms(persistedGrid, ORDER_TYPES.SELL);

        // Calculate ideal sizes for each order based on current available budget
        // This gives us what sizes SHOULD be, allowing comparison with actual persisted sizes
        const getIdeals = (orders, type) => {
            if (!manager || orders.length === 0 || !manager.assets) return orders;
            const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';

            // Total budget = cache + grid committed + available funds
            const total = (cacheFunds?.[side] || 0) + (manager.funds?.total?.grid?.[side] || 0) + (manager.funds?.available?.[side] || 0);

            // Subtract existing partial sizes to get residual budget for ideal sizing
            const partials = sumOrderSizes(calculatedGrid.filter(o => o && o.type === type && o.state === ORDER_STATES.PARTIAL));
            const budget = Math.max(0, total - partials);

            // Calculate geometric ideal sizes based on remaining budget
            const precision = getPrecisionByOrderType(manager.assets, type);
            try {
                const idealSizes = calculateRotationOrderSizes(budget, 0, orders.length, type, manager.config, 0, precision);
                return orders.map((o, i) => ({ ...o, size: idealSizes[i] }));
            } catch (e) { return orders; }
        };

        // Calculate RMS divergence metric for each side
        const buyMetric = calculateGridSideDivergenceMetric(getIdeals(calculatedBuys, ORDER_TYPES.BUY), persistedBuys, 'buy');
        const sellMetric = calculateGridSideDivergenceMetric(getIdeals(calculatedSells, ORDER_TYPES.SELL), persistedSells, 'sell');

        // Check if metrics exceed threshold and flag sides for regeneration
        let buyUpdated = false, sellUpdated = false;
        if (manager) {
            const limit = GRID_COMPARISON.RMS_PERCENTAGE / 100;  // Convert percentage threshold to decimal

            if (buyMetric > limit) {
                if (!manager._gridSidesUpdated) manager._gridSidesUpdated = [];
                manager._gridSidesUpdated.push(ORDER_TYPES.BUY);
                buyUpdated = true;
            }
            if (sellMetric > limit) {
                if (!manager._gridSidesUpdated) manager._gridSidesUpdated = [];
                manager._gridSidesUpdated.push(ORDER_TYPES.SELL);
                sellUpdated = true;
            }
        }

        return {
            buy: { metric: buyMetric, updated: buyUpdated },
            sell: { metric: sellMetric, updated: sellUpdated },
            totalMetric: (buyMetric + sellMetric) / 2
        };
    }

    /**
     * Calculate current market spread using on-chain orders.
     */
    static calculateCurrentSpread(manager) {
        const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);
        const partialBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL);
        const partialSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.PARTIAL);

        const onChainBuys = [...activeBuys, ...partialBuys];
        const onChainSells = [...activeSells, ...partialSells];

        return calculateSpreadFromOrders(onChainBuys, onChainSells);
    }

    /**
     * Proactive spread correction check.
     */
    static async checkSpreadCondition(manager, BitShares, updateOrdersOnChainBatch = null) {
        const currentSpread = Grid.calculateCurrentSpread(manager);
        // Base target widens spread beyond nominal value to account for order density and price movement
        const baseTarget = manager.config.targetSpreadPercent + (manager.config.incrementPercent * GRID_LIMITS.SPREAD_WIDENING_MULTIPLIER);
        // If double orders exist (fills causing overlaps), add extra spread tolerance to prevent over-correction
        const targetSpread = baseTarget + (Array.from(manager.orders.values()).some(o => o.isDoubleOrder) ? manager.config.incrementPercent : 0);

        const buyCount = countOrdersByType(ORDER_TYPES.BUY, manager.orders);
        const sellCount = countOrdersByType(ORDER_TYPES.SELL, manager.orders);

        manager.outOfSpread = shouldFlagOutOfSpread(currentSpread, targetSpread, buyCount, sellCount);
        if (!manager.outOfSpread) return { ordersPlaced: 0, partialsMoved: 0 };

        manager.logger.log(`Spread too wide (${currentSpread.toFixed(2)}%), correcting...`, 'warn');

        let marketPrice = manager.config.startPrice;
        if (BitShares) {
            const derived = await derivePrice(BitShares, manager.assets.assetA.symbol, manager.assets.assetB.symbol, 'pool');
            if (derived) marketPrice = derived;
        }

        const decision = Grid.determineOrderSideByFunds(manager, marketPrice);
        if (!decision.side) return { ordersPlaced: 0, partialsMoved: 0 };

        const correction = await Grid.prepareSpreadCorrectionOrders(manager, decision.side);
        if (correction.ordersToPlace.length > 0 && updateOrdersOnChainBatch) {
            await updateOrdersOnChainBatch(correction);
            manager.recalculateFunds();
            return { ordersPlaced: correction.ordersToPlace.length, partialsMoved: 0 };
        }
        return { ordersPlaced: 0, partialsMoved: 0 };
    }

    /**
     * Grid health check for structural violations.
     */
    static async checkGridHealth(manager, updateOrdersOnChainBatch = null) {
        if (!manager) return;
        const allOrders = Array.from(manager.orders.values());
        const sells = allOrders.filter(o => o.type === ORDER_TYPES.SELL).sort((a, b) => a.price - b.price);
        const buys = allOrders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => b.price - a.price);

        const logViolations = (orders, label) => {
            let seenVirtual = false;
            const hasOppositePending = allOrders.some(o => o.type !== label && o.pendingRotation);
            for (const o of orders) {
                if (o.state === ORDER_STATES.VIRTUAL) seenVirtual = true;
                if ((o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) && seenVirtual && !hasOppositePending) {
                    manager.logger.log(`Health violation (${label}): ${o.id} is further than VIRTUAL slot.`, 'warn');
                }
            }
        };
        logViolations(sells, 'SELL');
        logViolations(buys, 'BUY');
        return { buyDust: false, sellDust: false };
    }

    /**
     * Utility to decide which side can support an extra order.
     */
    static determineOrderSideByFunds(manager, currentMarketPrice) {
        const reqBuy = Grid.calculateGeometricSizeForSpreadCorrection(manager, ORDER_TYPES.BUY);
        const reqSell = Grid.calculateGeometricSizeForSpreadCorrection(manager, ORDER_TYPES.SELL);
        const buyRatio = reqBuy ? (manager.funds.available.buy / reqBuy) : 0;
        const sellRatio = reqSell ? (manager.funds.available.sell / reqSell) : 0;

        let side = null;
        if (buyRatio >= 1 && sellRatio >= 1) side = buyRatio > sellRatio ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        else if (buyRatio >= 1) side = ORDER_TYPES.BUY;
        else if (sellRatio >= 1) side = ORDER_TYPES.SELL;

        return { side, reason: side ? `Choosing ${side}` : 'Insufficient funds' };
    }

    /**
     * Calculate simulated size for spread correction order.
     */
    static calculateGeometricSizeForSpreadCorrection(manager, targetType) {
        const side = targetType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const slotsCount = Array.from(manager.orders.values()).filter(o => o.type === targetType).length + 1;
        const total = (manager.funds.available[side] || 0) + (manager.funds.virtual[side] || 0);
        if (total <= 0 || slotsCount <= 1) return null;

        const precision = getPrecisionForSide(manager.assets, side);
        const dummy = Array(slotsCount).fill({ type: targetType });
        try {
            const sized = calculateOrderSizes(dummy, manager.config, side === 'sell' ? total : 0, side === 'buy' ? total : 0, 0, 0, precision, precision);
            return side === 'sell' ? sized[sized.length - 1].size : sized[0].size;
        } catch (e) { return null; }
    }

    /**
     * Prepare a new active order at a candidate rail slot to correct wide spread.
     */
    static async prepareSpreadCorrectionOrders(manager, preferredSide) {
        const ordersToPlace = [];
        const railType = preferredSide;
        const railPrefix = railType === ORDER_TYPES.BUY ? 'buy-' : 'sell-';
        const slots = Array.from(manager.orders.values())
            .filter(o => o.id.startsWith(railPrefix))
            .sort((a, b) => railType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        const candidate = slots.find(o => !o.orderId && o.state === ORDER_STATES.VIRTUAL);
        if (candidate) {
            const size = Grid.calculateGeometricSizeForSpreadCorrection(manager, railType);
            if (size && size <= manager.funds.available[railType === ORDER_TYPES.BUY ? 'buy' : 'sell']) {
                const activated = { ...candidate, type: railType, size, state: ORDER_STATES.VIRTUAL };
                ordersToPlace.push(activated);
                manager._updateOrder(activated);
            }
        }
        return { ordersToPlace, partialMoves: [] };
    }

    /**
     * Internal utility to update orders with new geometric sizes.
     * @private
     */
    static _updateOrdersForSide(manager, orderType, newSizes, orders = null) {
        const ords = Array.isArray(orders) ? orders : Array.from(manager.orders.values()).filter(o => o.type === orderType);
        if (ords.length === 0 || newSizes.length !== ords.length) return;
        ords.forEach((order, i) => {
            const newSize = newSizes[i] || 0;
            if (order.size === undefined || Math.abs(order.size - newSize) > 1e-8) {
                manager._updateOrder({ ...order, size: newSize });
            }
        });
    }

    static _getFundSnapshot(manager) {
        const snap = manager.getChainFundsSnapshot();
        return { ...snap, gridBuy: Number(manager.funds?.total?.grid?.buy || 0), gridSell: Number(manager.funds?.total?.grid?.sell || 0), cacheBuy: Number(manager.funds?.cacheFunds?.buy || 0), cacheSell: Number(manager.funds?.cacheFunds?.sell || 0) };
    }
}

module.exports = Grid;