/**
 * modules/legacy-testing.js
 * 
 * Legacy testing functions for backward compatibility with existing test suite.
 * These functions are deprecated and maintained only for testing purposes.
 * Do not use in production code - use the new processFilledOrders and related methods instead.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, PRECISION_DEFAULTS } = require('../constants');
const { calculateAvailableFundsValue, getMinOrderSize, floatToBlockchainInt, blockchainToFloat } = require('./utils');

/**
 * @deprecated Use manager.processFilledOrders instead
 * Legacy rebalancing function that accepts fill counts directly.
 * Converts fill counts to dummy fill objects and calls rebalance.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} filledCounts - Object with ORDER_TYPES as keys and count values
 * @param {number} extraTarget - Extra target for rebalancing
 * @param {Set} excludeOrderIds - IDs to exclude from processing
 * @returns {Promise<Object>} Rebalance result
 */
async function rebalanceOrders(manager, filledCounts, extraTarget = 0, excludeOrderIds = new Set()) {
    const dummyFills = [];
    if (filledCounts) {
        for (const [type, count] of Object.entries(filledCounts)) {
            const activeOnSide = Array.from(manager.orders.values())
                .filter(o => o.type === type && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL))
                .sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);
            
            for (let i = 0; i < count; i++) {
                dummyFills.push({ type, price: manager.config.startPrice });
                if (activeOnSide[i]) {
                    manager._updateOrder({ ...activeOnSide[i], state: ORDER_STATES.VIRTUAL, orderId: null });
                }
            }
        }
    }
    return await manager.strategy.rebalance(dummyFills, excludeOrderIds);
}

/**
 * @deprecated Use manager.processFilledOrders instead
 * Legacy rebalancing function for single side fills.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {string} filledType - Type that was filled (BUY or SELL)
 * @param {string} oppositeType - Opposite type
 * @param {number} filledCount - Number of fills
 * @param {number} extraTarget - Extra target
 * @param {Set} excludeOrderIds - IDs to exclude
 * @returns {Promise<Object>} Rebalance result
 */
async function rebalanceSideAfterFill(manager, filledType, oppositeType, filledCount, extraTarget = 0, excludeOrderIds = new Set()) {
    const dummyFills = [{ type: filledType, price: manager.config.startPrice }];
    return await manager.strategy.rebalance(dummyFills, excludeOrderIds);
}

/**
 * @deprecated Testing only
 * Activate the closest virtual orders for placement on the blockchain.
 * Finds virtual orders of a given type and activates the closest ones.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {string} targetType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} count - Number of orders to activate
 * @param {Set} excludeOrderIds - Order IDs to exclude from activation
 * @returns {Promise<Array>} Array of activated orders
 */
async function activateClosestVirtualOrdersForPlacement(manager, targetType, count, excludeOrderIds = new Set()) {
    if (count <= 0) return [];

    let virtualOrders = manager.getOrdersByTypeAndState(targetType, ORDER_STATES.VIRTUAL);

    if (excludeOrderIds && excludeOrderIds.size > 0) {
        virtualOrders = virtualOrders.filter(o => !excludeOrderIds.has(o.id) && !excludeOrderIds.has(o.orderId) && !manager.isOrderLocked(o.id) && !manager.isOrderLocked(o.orderId));
    } else {
        virtualOrders = virtualOrders.filter(o => !manager.isOrderLocked(o.id) && !manager.isOrderLocked(o.orderId));
    }

    manager.logger.log(`Found ${virtualOrders.length} VIRTUAL ${targetType} orders for activation`, "debug");

    virtualOrders.sort((a, b) => targetType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

    const toActivate = virtualOrders.slice(0, count);
    const activated = [];

    for (const order of toActivate) {
        const currentOrder = manager.orders.get(order.id);
        if (!currentOrder || currentOrder.state !== ORDER_STATES.VIRTUAL) continue;

        const orderSize = order.size || 0;
        if (orderSize <= 0) continue;

        const activatedOrder = { ...order, type: targetType, size: orderSize, state: ORDER_STATES.VIRTUAL };
        manager.accountant.updateOptimisticFreeBalance(order, activatedOrder, "spread-activation", 0);

        manager._updateOrder(activatedOrder);
        activated.push(activatedOrder);
        manager.logger.log(`Activated virtual ${targetType} at ${order.price.toFixed(4)} (Amount: ${orderSize.toFixed(8)})`, "info");
    }
    return activated;
}

/**
 * @deprecated Testing only
 * Prepare furthest orders for rotation.
 * Selects the furthest active orders and prepares them for rotation to spread slots.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {string} targetType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} count - Number of orders to rotate
 * @param {Set} excludeOrderIds - Order IDs to exclude
 * @param {number} filledCount - Number of fills for rotation calculation
 * @param {Object} options - Additional options
 * @returns {Promise<Array>} Array of rotation instructions
 */
async function prepareFurthestOrdersForRotation(manager, targetType, count, excludeOrderIds = new Set(), filledCount = 0, options = {}) {
    if (count <= 0) return [];

    let activeOrders = manager.getOrdersByTypeAndState(targetType, ORDER_STATES.ACTIVE)
        .filter(o =>
            !excludeOrderIds.has(o.id) &&
            !excludeOrderIds.has(o.orderId) &&
            !manager.isOrderLocked(o.id) &&
            !manager.isOrderLocked(o.orderId)
        );

    if (activeOrders.length === 0) {
        manager.logger.log(`No active ${targetType} orders available for rotation`, "debug");
        return [];
    }

    activeOrders.sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

    const toRotate = activeOrders.slice(0, count);
    const rotated = [];

    const side = targetType === ORDER_TYPES.BUY ? "buy" : "sell";
    const cache = Number(manager.funds?.cacheFunds?.[side] || 0);
    const fundsPerOrder = toRotate.length > 0 ? cache / toRotate.length : 0;

    for (const order of toRotate) {
        const allSpreadOrders = manager.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);

        if (allSpreadOrders.length === 0) {
            manager.logger.log(`No SPREAD slots available for ${targetType} rotation`, "warn");
            break;
        }

        const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);

        const highestActiveBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : -Infinity;
        const lowestActiveSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : Infinity;

        const validSpreads = allSpreadOrders.filter(o =>
            o.price > highestActiveBuy && o.price < lowestActiveSell
        );

        if (validSpreads.length === 0) {
            manager.logger.log(`No valid SPREAD slots in spread zone for ${targetType} rotation`, "warn");
            break;
        }

        const targetSpreadSlot = targetType === ORDER_TYPES.BUY
            ? validSpreads.reduce((min, o) => o.price < min.price ? o : min)
            : validSpreads.reduce((max, o) => o.price > max.price ? o : max);

        const rotatedOrder = { 
            oldOrder: { ...order }, 
            newPrice: targetSpreadSlot.price, 
            newGridId: targetSpreadSlot.id, 
            newSize: fundsPerOrder,
            type: targetType
        };

        const virtualOrder = { ...targetSpreadSlot, type: targetType, size: fundsPerOrder, state: ORDER_STATES.VIRTUAL };
        manager.accountant.updateOptimisticFreeBalance(order, virtualOrder, "rotation", 0);
        
        manager.funds.cacheFunds[side] = Math.max(0, (manager.funds.cacheFunds[side] || 0) - fundsPerOrder);
        
        manager._updateOrder(virtualOrder);
        rotated.push(rotatedOrder);
        manager.shadowOrderIds.set(order.orderId, Date.now());
    }
    return rotated;
}

/**
 * @deprecated Testing only
 * Evaluate whether a partial order is dust or substantial.
 * Calculates the percentage of ideal size and determines classification.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} partialOrder - The partial order to evaluate
 * @param {Object} moveInfo - Move information containing targetGridOrder and newPrice
 * @returns {Object} Classification object with isDust, percentOfIdeal, etc.
 */
function evaluatePartialOrderAnchor(manager, partialOrder, moveInfo) {
    const idealSize = moveInfo.targetGridOrder.size;
    const percentOfIdeal = partialOrder.size / idealSize;
    const dustThreshold = (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
    
    const isDust = percentOfIdeal < dustThreshold;
    
    let residualCapital = 0;
    if (partialOrder.size > idealSize) {
        if (partialOrder.type === ORDER_TYPES.SELL) {
            residualCapital = (partialOrder.size - idealSize) * moveInfo.newPrice;
        } else {
            residualCapital = (partialOrder.size - idealSize) / moveInfo.newPrice;
        }
    }
    
    return { isDust, percentOfIdeal, mergedDustSize: isDust ? partialOrder.size : 0, newSize: idealSize, residualCapital };
}

/**
 * @deprecated Testing only
 * Activate spread orders for a given type.
 * Finds SPREAD orders in the valid spread zone and activates them.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {string} targetType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} count - Number of spread orders to activate
 * @returns {Promise<Array>} Array of activated spread orders
 */
async function activateSpreadOrders(manager, targetType, count) {
    if (count <= 0) return [];

    const allSpreadOrders = manager.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);

    const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
    const activeSells = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);

    const highestActiveBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : -Infinity;
    const lowestActiveSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : Infinity;

    const spreadOrders = allSpreadOrders
        .filter(o => o.price > highestActiveBuy && o.price < lowestActiveSell)
        .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

    const availableFunds = calculateAvailableFundsValue(targetType === ORDER_TYPES.BUY ? "buy" : "sell", manager.accountTotals, manager.funds, manager.config.assetA, manager.config.assetB, manager.config.activeOrders);
    if (availableFunds <= 0) return [];

    let desiredCount = Math.min(count, spreadOrders.length);
    if (desiredCount <= 0) return [];

    const minSize = getMinOrderSize(targetType, manager.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
    const ordersToCreate = desiredCount;

    const activatedOrders = [];
    const side = targetType === ORDER_TYPES.BUY ? "buy" : "sell";

    for (let i = 0; i < ordersToCreate && i < spreadOrders.length; i++) {
        const currentAvailable = calculateAvailableFundsValue(side, manager.accountTotals, manager.funds, manager.config.assetA, manager.config.assetB, manager.config.activeOrders);
        const remainingOrders = ordersToCreate - i;
        const fundsPerOrder = remainingOrders > 0 ? currentAvailable / remainingOrders : 0;

        if (fundsPerOrder < minSize) break;

        const order = spreadOrders[i];
        const activatedOrder = { ...order, type: targetType, size: fundsPerOrder, state: ORDER_STATES.ACTIVE };
        manager.accountant.updateOptimisticFreeBalance(order, activatedOrder, "spread-activation", 0);
        
        manager.funds.cacheFunds[side] = Math.max(0, (manager.funds.cacheFunds[side] || 0) - fundsPerOrder);
        
        manager._updateOrder(activatedOrder);
        activatedOrders.push(activatedOrder);
        manager.logger.log(`Prepared ${targetType} order ${i + 1}/${ordersToCreate} at ${order.price.toFixed(2)} (Amount: ${fundsPerOrder.toFixed(8)})`, "info");
    }

    return activatedOrders;
}

module.exports = {
    rebalanceOrders,
    rebalanceSideAfterFill,
    activateClosestVirtualOrdersForPlacement,
    prepareFurthestOrdersForRotation,
    evaluatePartialOrderAnchor,
    activateSpreadOrders
};
