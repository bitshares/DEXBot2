const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../constants');
const OrderUtils = require('./utils');

function _countActiveOnGrid(manager, type) {
    const active = manager.getOrdersByTypeAndState(type, ORDER_STATES.ACTIVE).filter(o => o && o.orderId);
    const partial = manager.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter(o => o && o.orderId);
    return active.length + partial.length;
}

function _pickVirtualSlotsToActivate(manager, type, count) {
    if (count <= 0) return [];

    const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
    const allSlots = Array.from(manager.orders.values())
        .filter(o => (o.id && String(o.id).startsWith(side + "-")) || o.type === type)
        .sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

    let effectiveMin = 0;
    try {
        effectiveMin = OrderUtils.getMinOrderSize(type, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
    } catch (e) { effectiveMin = 0; }

    const firstVirtualIdx = allSlots.findIndex(o => !o.orderId && o.state === ORDER_STATES.VIRTUAL);
    if (firstVirtualIdx === -1) return [];

    const valid = [];
    for (let i = 0; i < count && (firstVirtualIdx + i) < allSlots.length; i++) {
        const slot = allSlots[firstVirtualIdx + i];
        if (slot.id && (Number(slot.size) || 0) >= effectiveMin) {
            valid.push(slot);
        }
    }

    return valid;
}
/**
 * Detect if grid edge is fully occupied with active orders.
 * When all outermost (furthest from market) orders are ACTIVE with orderId,
 * we're at grid edge and all balance is committed to those orders.
 *
 * @param {Object} manager - OrderManager instance
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} updateCount - Number of orders being updated
 * @returns {boolean} true if edge orders are all active
 * @private
 */
function _isGridEdgeFullyActive(manager, orderType, updateCount) {
    if (!manager || updateCount <= 0) return false;

    // Get all orders of this type
    const allOrders = Array.from(manager.orders.values()).filter(o => o.type === orderType);
    if (allOrders.length === 0) return false;

    // Sort: for BUY (highest to lowest price), for SELL (lowest to highest)
    // This puts market edge first, grid edge (furthest) last
    const sorted = orderType === ORDER_TYPES.BUY
        ? allOrders.sort((a, b) => (b.price || 0) - (a.price || 0))  // Buy: high to low price
        : allOrders.sort((a, b) => (a.price || 0) - (b.price || 0));  // Sell: low to high price

    // Get the outermost orders (last N in sorted = furthest from market)
    const outerEdgeCount = Math.min(updateCount, sorted.length);
    const edgeOrders = sorted.slice(-outerEdgeCount);

    // Check if ALL edge orders are ACTIVE (have orderId set)
    const allEdgeActive = edgeOrders.every(o => o.orderId && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL));

    return allEdgeActive;
}

async function _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId, gridOrder, dryRun }) {
    if (dryRun) return;

    const { amountToSell, minToReceive } = OrderUtils.buildCreateOrderArgs(gridOrder, manager.assets.assetA, manager.assets.assetB);

    await chainOrders.updateOrder(account, privateKey, chainOrderId, {
        newPrice: gridOrder.price,
        amountToSell,
        minToReceive,
        orderType: gridOrder.type,
    });

    const btsFeeData = OrderUtils.getAssetFees('BTS', 1);

    // Centralized Fund Tracking: Use manager's sync core to handle state transition and fund deduction
    await manager.synchronizeWithChain({
        gridOrderId: gridOrder.id,
        chainOrderId,
        isPartialPlacement: false,
        fee: btsFeeData.updateFee
    }, 'createOrder');
}

/**
 * Find the largest order among those being updated.
 * Returns both the order and its index in unmatchedOrders for pairing with gridOrders.
 * @private
 */
function _findLargestOrder(unmatchedOrders, updateCount) {
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const ordersToCheck = unmatchedOrders.slice(0, updateCount);
    let largestOrder = null;
    let largestIndex = -1;
    let largestSize = 0;

    for (let i = 0; i < ordersToCheck.length; i++) {
        const order = ordersToCheck[i];
        const size = Number(order.for_sale) || 0;
        if (size > largestSize) {
            largestSize = size;
            largestOrder = order;
            largestIndex = i;
        }
    }

    return largestIndex >= 0 ? { order: largestOrder, index: largestIndex } : null;
}

/**
 * Cancel the largest unmatched order to free up maximum funds.
 * This is more efficient than reducing to size 1 and then updating twice.
 * Returns the grid slot index and grid order that needs to be filled.
 * @private
 */
async function _cancelLargestOrder({ chainOrders, account, privateKey, manager, unmatchedOrders, updateCount, orderType, dryRun }) {
    if (dryRun) return null;
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const logger = manager && manager.logger;

    // Find the largest order among those being updated
    const largestInfo = _findLargestOrder(unmatchedOrders, updateCount);
    if (!largestInfo) return null;

    const { order: largestOrder, index: largestIndex } = largestInfo;
    const originalSize = Number(largestOrder.for_sale) || 0;
    const orderId = largestOrder.id;

    logger?.log?.(
        `Grid edge detected: cancelling largest order ${orderId} (size ${originalSize}) to free up funds`,
        'info'
    );

    try {
        // Cancel the largest order on blockchain
        await chainOrders.cancelOrder(account, privateKey, orderId);
        logger?.log?.(`Cancelled largest order ${orderId}`, 'info');

        // Mark for removal from unmatched list (handled by caller)
        // Return info needed to create this order fresh later
        return { index: largestIndex, orderType };
    } catch (err) {
        logger?.log?.(`Warning: Could not cancel largest order ${orderId}: ${err.message}`, 'warn');
        return null;
    }
}

async function _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun }) {
    if (dryRun) return;

    const { amountToSell, sellAssetId, minToReceive, receiveAssetId } = OrderUtils.buildCreateOrderArgs(
        gridOrder,
        manager.assets.assetA,
        manager.assets.assetB
    );

    const result = await chainOrders.createOrder(
        account,
        privateKey,
        amountToSell,
        sellAssetId,
        minToReceive,
        receiveAssetId,
        null,
        false
    );

    const chainOrderId =
        result &&
        result[0] &&
        result[0].trx &&
        result[0].trx.operation_results &&
        result[0].trx.operation_results[0] &&
        result[0].trx.operation_results[0][1];

    if (chainOrderId) {
        const btsFeeData = OrderUtils.getAssetFees('BTS', 1);

        // Centralized Fund Tracking: Use manager's sync core to handle state transition and fund deduction
        // This keeps accountBalances accurate during startup by using the same logic as synchronizeWithChain
        await manager.synchronizeWithChain({
            gridOrderId: gridOrder.id,
            chainOrderId,
            isPartialPlacement: false,
            fee: btsFeeData.createFee
        }, 'createOrder');
    }
}

async function _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId, dryRun }) {
    if (dryRun) return;

    await chainOrders.cancelOrder(account, privateKey, chainOrderId);
    await manager.synchronizeWithChain(chainOrderId, 'cancelOrder');
}

/**
 * Attempt to resume a persisted grid when orderIds don't match (e.g. orders.json out of sync),
 * by matching existing on-chain open orders to grid orders using price+size matching.
 *
 * Returns { resumed: boolean, matchedCount: number }.
 */
async function attemptResumePersistedGridByPriceMatch({
    manager,
    persistedGrid,
    chainOpenOrders,
    logger,
    storeGrid,
}) {
    if (!Array.isArray(persistedGrid) || persistedGrid.length === 0) return { resumed: false, matchedCount: 0 };
    if (!Array.isArray(chainOpenOrders) || chainOpenOrders.length === 0) return { resumed: false, matchedCount: 0 };
    if (!manager || typeof manager.synchronizeWithChain !== 'function') return { resumed: false, matchedCount: 0 };

    try {
        logger && logger.log && logger.log('No matching active order IDs found. Attempting to match by price...', 'info');
        const Grid = require('./grid');
        await Grid.loadGrid(manager, persistedGrid);
        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

        const matchedOrderIds = new Set(
            Array.from(manager.orders.values())
                .filter(o => o && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL))
                .map(o => o.orderId)
                .filter(Boolean)
        );

        if (matchedOrderIds.size === 0) {
            logger && logger.log && logger.log('Price-based matching found no matches. Generating new grid.', 'info');
            return { resumed: false, matchedCount: 0 };
        }

        logger && logger.log && logger.log(`Successfully matched ${matchedOrderIds.size} orders by price. Resuming with existing grid.`, 'info');
        if (typeof storeGrid === 'function') {
            storeGrid(Array.from(manager.orders.values()));
        }
        return { resumed: true, matchedCount: matchedOrderIds.size };
    } catch (err) {
        logger && logger.log && logger.log(`Price-based resume attempt failed: ${err && err.message ? err.message : err}`, 'warn');
        return { resumed: false, matchedCount: 0 };
    }
}

/**
 * Decide whether a startup should regenerate the grid or resume a persisted grid.
 *
 * Resulting behavior matches the existing startup policy:
 * - If no persisted grid -> regenerate
 * - If any persisted ACTIVE orderId exists on-chain -> resume
 * - Else if there are on-chain orders -> attempt price-based matching; resume if it matches any
 * - Else -> regenerate
 */
async function decideStartupGridAction({
    persistedGrid,
    chainOpenOrders,
    manager,
    logger,
    storeGrid,
    attemptResumeFn = attemptResumePersistedGridByPriceMatch,
}) {
    const persisted = Array.isArray(persistedGrid) ? persistedGrid : [];
    const chain = Array.isArray(chainOpenOrders) ? chainOpenOrders : [];

    if (persisted.length === 0) {
        return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
    }

    const chainOrderIds = new Set(chain.map(o => o && o.id).filter(Boolean));
    const hasActiveMatch = persisted.some(order => order && order.state === 'active' && order.orderId && chainOrderIds.has(order.orderId));
    if (hasActiveMatch) {
        return { shouldRegenerate: false, hasActiveMatch: true, resumedByPrice: false, matchedCount: 0 };
    }

    if (chain.length > 0) {
        const resume = await attemptResumeFn({ manager, persistedGrid: persisted, chainOpenOrders: chain, logger, storeGrid });
        return { shouldRegenerate: !resume.resumed, hasActiveMatch: false, resumedByPrice: !!resume.resumed, matchedCount: resume.matchedCount || 0 };
    }

    return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
}

/**
 * Reconcile existing on-chain orders to a newly generated grid.
 *
 * Policy (per side):
 * - Prefer updating existing unmatched chain orders to match the target grid slots.
 * - Then create missing orders if chain has fewer than target.
 * - Then cancel excess orders if chain has more than target.
 *
 * Targets are derived from config.activeOrders.{buy,sell} and chain counts are computed
 * from current on-chain open orders.
 */
async function reconcileStartupOrders({
    manager,
    config,
    account,
    privateKey,
    chainOrders,
    chainOpenOrders,
    syncResult,
}) {
    const logger = manager && manager.logger;
    const dryRun = !!(config && config.dryRun);

    const parsedChain = (chainOpenOrders || [])
        .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    const activeCfg = (config && config.activeOrders) ? config.activeOrders : {};
    const targetBuy = Math.max(0, Number.isFinite(Number(activeCfg.buy)) ? Number(activeCfg.buy) : 1);
    const targetSell = Math.max(0, Number.isFinite(Number(activeCfg.sell)) ? Number(activeCfg.sell) : 1);

    const chainBuys = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    const chainSells = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    const unmatchedChain = (syncResult && syncResult.unmatchedChainOrders) ? syncResult.unmatchedChainOrders : [];
    const unmatchedParsed = unmatchedChain
        .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    let unmatchedBuys = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    let unmatchedSells = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    // ---- SELL SIDE ----
    const matchedSell = _countActiveOnGrid(manager, ORDER_TYPES.SELL);
    const needSellSlots = Math.max(0, targetSell - matchedSell);
    const desiredSellSlots = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.SELL, needSellSlots);

    // Sort unmatched SELL orders by price (low to high) to pair with desiredSellSlots
    // which are already sorted by price (closest to market first)
    const sortedUnmatchedSells = unmatchedSells
        .slice(0)  // Create copy to avoid mutating original
        .sort((a, b) => {
            const priceA = OrderUtils.parseChainOrder(a, manager.assets)?.price || 0;
            const priceB = OrderUtils.parseChainOrder(b, manager.assets)?.price || 0;
            return priceA - priceB;  // Low to high (market to edge)
        });

    const sellUpdates = Math.min(sortedUnmatchedSells.length, desiredSellSlots.length);
    let cancelledSellIndex = null;

    // PHASE 1: Cancel largest order if grid edge is fully active (frees maximum funds)
    if (sellUpdates > 0 && _isGridEdgeFullyActive(manager, ORDER_TYPES.SELL, sellUpdates)) {
        logger && logger.log && logger.log(`Startup: SELL grid edge is fully active, cancelling largest order to free funds`, 'info');
        const cancelInfo = await _cancelLargestOrder({
            chainOrders, account, privateKey, manager,
            unmatchedOrders: sortedUnmatchedSells,
            updateCount: sellUpdates,
            orderType: ORDER_TYPES.SELL,
            dryRun
        });
        if (cancelInfo) {
            cancelledSellIndex = cancelInfo.index;
            // Don't splice - keep index alignment with desiredSellSlots
        }
    }

    // PHASE 2: Update remaining unmatched orders to their target sizes
    for (let i = 0; i < sellUpdates; i++) {
        // Skip the cancelled order's slot - will be handled in Phase 3
        if (cancelledSellIndex !== null && i === cancelledSellIndex) {
            continue;
        }
        const chainOrder = sortedUnmatchedSells[i];
        const gridOrder = desiredSellSlots[i];
        logger && logger.log && logger.log(
            `Startup: Updating chain SELL ${chainOrder.id} -> grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId: chainOrder.id, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to update SELL ${chainOrder.id}: ${err.message}`, 'error');
        }
    }

    // PHASE 3: Create new order for the grid slot that had the cancelled order
    if (cancelledSellIndex !== null && !dryRun) {
        const targetGridOrder = desiredSellSlots[cancelledSellIndex];
        if (targetGridOrder) {
            logger && logger.log && logger.log(
                `Startup: Creating new SELL for cancelled slot at grid ${targetGridOrder.id} (price=${targetGridOrder.price.toFixed(6)}, size=${targetGridOrder.size.toFixed(8)})`,
                'info'
            );
            try {
                await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder: targetGridOrder, dryRun });
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to create SELL for cancelled slot: ${err.message}`, 'error');
            }
        }
    }

    // Remove processed orders from the unmatched list
    unmatchedSells = sortedUnmatchedSells.slice(sellUpdates);

    const chainSellCount = chainSells.length;
    const sellCreateCount = Math.max(0, targetSell - chainSellCount);
    const remainingSellSlots = desiredSellSlots.slice(sellUpdates);
    for (let i = 0; i < Math.min(sellCreateCount, remainingSellSlots.length); i++) {
        const gridOrder = remainingSellSlots[i];
        logger && logger.log && logger.log(
            `Startup: Creating SELL for grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to create SELL: ${err.message}`, 'error');
        }
    }

    let sellCancelCount = Math.max(0, chainSellCount - targetSell);
    if (sellCancelCount > 0) {
        const parsedUnmatchedSells = unmatchedSells
            .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort((a, b) => (b.parsed.price || 0) - (a.parsed.price || 0));

        for (const x of parsedUnmatchedSells) {
            if (sellCancelCount <= 0) break;
            logger && logger.log && logger.log(`Startup: Cancelling excess SELL chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: x.chain.id, dryRun });
                logger && logger.log && logger.log(`Startup: Successfully cancelled excess SELL order ${x.chain.id}`, 'info');
                sellCancelCount--;
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to cancel SELL ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (sellCancelCount > 0) {
            const activeSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort((a, b) => (b.price || 0) - (a.price || 0));

            for (const o of activeSells) {
                if (sellCancelCount <= 0) break;
                logger && logger.log && logger.log(`Startup: Cancelling excess matched SELL ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun });
                    logger && logger.log && logger.log(`Startup: Successfully cancelled excess matched SELL order ${o.orderId} (grid ${o.id})`, 'info');
                    sellCancelCount--;
                } catch (err) {
                    logger && logger.log && logger.log(`Startup: Failed to cancel matched SELL ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    // ---- BUY SIDE ----
    const matchedBuy = _countActiveOnGrid(manager, ORDER_TYPES.BUY);
    const needBuySlots = Math.max(0, targetBuy - matchedBuy);
    const desiredBuySlots = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.BUY, needBuySlots);

    // Sort unmatched BUY orders by price (high to low) to pair with desiredBuySlots
    // which are already sorted by price (closest to market first = highest to lowest)
    const sortedUnmatchedBuys = unmatchedBuys
        .slice(0)  // Create copy to avoid mutating original
        .sort((a, b) => {
            const priceA = OrderUtils.parseChainOrder(a, manager.assets)?.price || 0;
            const priceB = OrderUtils.parseChainOrder(b, manager.assets)?.price || 0;
            return priceB - priceA;  // High to low (market to edge)
        });

    const buyUpdates = Math.min(sortedUnmatchedBuys.length, desiredBuySlots.length);
    let cancelledBuyIndex = null;

    // PHASE 1: Cancel largest order if grid edge is fully active (frees maximum funds)
    if (buyUpdates > 0 && _isGridEdgeFullyActive(manager, ORDER_TYPES.BUY, buyUpdates)) {
        logger && logger.log && logger.log(`Startup: BUY grid edge is fully active, cancelling largest order to free funds`, 'info');
        const cancelInfo = await _cancelLargestOrder({
            chainOrders, account, privateKey, manager,
            unmatchedOrders: sortedUnmatchedBuys,
            updateCount: buyUpdates,
            orderType: ORDER_TYPES.BUY,
            dryRun
        });
        if (cancelInfo) {
            cancelledBuyIndex = cancelInfo.index;
            // Don't splice - keep index alignment with desiredBuySlots
        }
    }

    // PHASE 2: Update remaining unmatched orders to their target sizes
    for (let i = 0; i < buyUpdates; i++) {
        // Skip the cancelled order's slot - will be handled in Phase 3
        if (cancelledBuyIndex !== null && i === cancelledBuyIndex) {
            continue;
        }
        const chainOrder = sortedUnmatchedBuys[i];
        const gridOrder = desiredBuySlots[i];
        logger && logger.log && logger.log(
            `Startup: Updating chain BUY ${chainOrder.id} -> grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _updateChainOrderToGrid({ chainOrders, account, privateKey, manager, chainOrderId: chainOrder.id, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to update BUY ${chainOrder.id}: ${err.message}`, 'error');
        }
    }

    // PHASE 3: Create new order for the grid slot that had the cancelled order
    if (cancelledBuyIndex !== null && !dryRun) {
        const targetGridOrder = desiredBuySlots[cancelledBuyIndex];
        if (targetGridOrder) {
            logger && logger.log && logger.log(
                `Startup: Creating new BUY for cancelled slot at grid ${targetGridOrder.id} (price=${targetGridOrder.price.toFixed(6)}, size=${targetGridOrder.size.toFixed(8)})`,
                'info'
            );
            try {
                await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder: targetGridOrder, dryRun });
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to create BUY for cancelled slot: ${err.message}`, 'error');
            }
        }
    }

    // Remove processed orders from the unmatched list
    unmatchedBuys = sortedUnmatchedBuys.slice(buyUpdates);

    const chainBuyCount = chainBuys.length;
    const buyCreateCount = Math.max(0, targetBuy - chainBuyCount);
    const remainingBuySlots = desiredBuySlots.slice(buyUpdates);
    for (let i = 0; i < Math.min(buyCreateCount, remainingBuySlots.length); i++) {
        const gridOrder = remainingBuySlots[i];
        logger && logger.log && logger.log(
            `Startup: Creating BUY for grid ${gridOrder.id} (price=${gridOrder.price.toFixed(6)}, size=${gridOrder.size.toFixed(8)})`,
            'info'
        );
        try {
            await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
        } catch (err) {
            logger && logger.log && logger.log(`Startup: Failed to create BUY: ${err.message}`, 'error');
        }
    }

    let buyCancelCount = Math.max(0, chainBuyCount - targetBuy);
    if (buyCancelCount > 0) {
        const parsedUnmatchedBuys = unmatchedBuys
            .map(co => ({ chain: co, parsed: OrderUtils.parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort((a, b) => (a.parsed.price || 0) - (b.parsed.price || 0));

        for (const x of parsedUnmatchedBuys) {
            if (buyCancelCount <= 0) break;
            logger && logger.log && logger.log(`Startup: Cancelling excess BUY chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: x.chain.id, dryRun });
                logger && logger.log && logger.log(`Startup: Successfully cancelled excess BUY order ${x.chain.id}`, 'info');
                buyCancelCount--;
            } catch (err) {
                logger && logger.log && logger.log(`Startup: Failed to cancel BUY ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (buyCancelCount > 0) {
            const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort((a, b) => (a.price || 0) - (b.price || 0));

            for (const o of activeBuys) {
                if (buyCancelCount <= 0) break;
                logger && logger.log && logger.log(`Startup: Cancelling excess matched BUY ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun });
                    logger && logger.log && logger.log(`Startup: Successfully cancelled excess matched BUY order ${o.orderId} (grid ${o.id})`, 'info');
                    buyCancelCount--;
                } catch (err) {
                    logger && logger.log && logger.log(`Startup: Failed to cancel matched BUY ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    logger && logger.log && logger.log(
        `Startup reconcile complete: target(sell=${targetSell}, buy=${targetBuy}), chain(sell=${chainSellCount}, buy=${chainBuyCount}), ` +
        `gridActive(sell=${_countActiveOnGrid(manager, ORDER_TYPES.SELL)}, buy=${_countActiveOnGrid(manager, ORDER_TYPES.BUY)})`,
        'info'
    );
}

module.exports = {
    reconcileStartupOrders,
    attemptResumePersistedGridByPriceMatch,
    decideStartupGridAction,
};
