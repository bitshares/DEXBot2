/**
 * Utility helpers for OrderManager calculations and conversions
 * 
 * This module provides:
 * - Percentage string parsing ('50%' -> 0.5)
 * - Blockchain integer <-> human float conversions
 * - Relative price multiplier parsing ('5x' -> 5)
 */

/**
 * Check if a value is a percentage string (ends with '%')
 * @param {*} v - Value to check
 * @returns {boolean} True if percentage string
 */
function isPercentageString(v) {
    return typeof v === 'string' && v.trim().endsWith('%');
}

/**
 * Parse a percentage string to a decimal fraction.
 * @param {string} v - Percentage string (e.g., '50%')
 * @returns {number|null} Decimal fraction (0.5) or null if invalid
 */
function parsePercentageString(v) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    if (Number.isNaN(num)) return null;
    return num / 100.0;
}

/**
 * Convert a blockchain integer amount to human-readable float.
 * Blockchain stores amounts as integers (satoshis), this converts
 * to the human-readable decimal value.
 * 
 * @example blockchainToFloat(12345678, 4) -> 1234.5678
 * 
 * @param {number} intValue - Integer amount from blockchain
 * @param {number} precision - Asset precision (decimal places)
 * @returns {number} Human-readable float value
 */
function blockchainToFloat(intValue, precision) {
    if (intValue === null || intValue === undefined) return 0;
    const p = Number(precision || 0);
    return Number(intValue) / Math.pow(10, p);
}

/**
 * Convert a human-readable float to blockchain integer.
 * Reverses blockchainToFloat - converts decimals to satoshis.
 * 
 * @example floatToBlockchainInt(1234.5678, 4) -> 12345678
 * 
 * @param {number} floatValue - Human-readable amount
 * @param {number} precision - Asset precision (decimal places)
 * @returns {number} Integer amount for blockchain
 */
function floatToBlockchainInt(floatValue, precision) {
    const p = Number(precision || 0);
    // Return a JS Number integer representing the blockchain integer (not BigInt)
    return Math.round(Number(floatValue) * Math.pow(10, p));
}

/**
 * Check if a value is a relative multiplier string (e.g., '5x')
 * @param {*} value - Value to check
 * @returns {boolean} True if multiplier string
 */
function isRelativeMultiplierString(value) {
    return typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value);
}

/**
 * Parse a relative multiplier string to a number.
 * @param {string} value - Multiplier string (e.g., '5x')
 * @returns {number|null} Numeric multiplier or null if invalid
 */
function parseRelativeMultiplierString(value) {
    if (!isRelativeMultiplierString(value)) return null;
    const cleaned = value.trim().toLowerCase();
    const numeric = parseFloat(cleaned.slice(0, -1));
    return Number.isNaN(numeric) ? null : numeric;
}

/**
 * Resolve a relative price multiplier to an absolute price.
 * Used to configure min/max price bounds relative to market price.
 * 
 * @example
 * resolveRelativePrice('5x', 100, 'max') -> 500 (100 * 5)
 * resolveRelativePrice('5x', 100, 'min') -> 20  (100 / 5)
 * 
 * @param {string} value - Multiplier string (e.g., '5x')
 * @param {number} marketPrice - Current market price
 * @param {string} mode - 'min' (divide) or 'max' (multiply)
 * @returns {number|null} Absolute price or null if invalid
 */
function resolveRelativePrice(value, marketPrice, mode = 'min') {
    // Interpret relative multipliers like '5x' as min/max bounds around the market price.
    const multiplier = parseRelativeMultiplierString(value);
    if (multiplier === null || !Number.isFinite(marketPrice) || multiplier === 0) return null;
    if (mode === 'min') return marketPrice / multiplier;
    if (mode === 'max') return marketPrice * multiplier;
    return null;
}

/**
 * Calculate the maximum allowable price difference between grid and blockchain
 * based on asset precisions and order size.
 *
 * This mirrors the OrderManager.calculatePriceTolerance logic but is a plain
 * function so it can be reused across the codebase for a single canonical
 * implementation.
 *
 * @param {number} gridPrice - The price in the grid (stored snapshot)
 * @param {number} orderSize - The order size (human units)
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL (optional)
 * @param {Object|null} assets - Optional assets metadata { assetA: {precision}, assetB: {precision} }
 * @returns {number} - Maximum allowable absolute price difference
 */
function calculatePriceTolerance(gridPrice, orderSize, orderType, assets = null) {
    if (!assets || !gridPrice || !orderSize) {
        // Fallback to the same reasonable default used in OrderManager
        return gridPrice ? gridPrice * 0.001 : 0;
    }

    const precisionA = assets.assetA?.precision ?? 8;
    const precisionB = assets.assetB?.precision ?? 8;

    let orderSizeA, orderSizeB;
    if (orderType === 'sell' || orderType === 'SELL' || orderType === 'Sell') {
        orderSizeA = orderSize;
        orderSizeB = orderSize * gridPrice;
    } else {
        // default assume buy semantics if not explicitly sell
        orderSizeB = orderSize;
        orderSizeA = orderSize / gridPrice;
    }

    const termA = 1 / (orderSizeA * Math.pow(10, precisionA));
    const termB = 1 / (orderSizeB * Math.pow(10, precisionB));
    const tolerance = (termA + termB) * gridPrice;
    return tolerance;
}

/**
 * Check whether a chain order price is within the allowable tolerance
 * of a grid order price. Returns an object matching the previous
 * OrderManager.checkPriceWithinTolerance shape so consumers can use
 * the helper interchangeably.
 *
 * @param {Object} gridOrder - Grid order snapshot ({ price, size, type })
 * @param {Object} chainOrder - Parsed chain order ({ price, size })
 * @param {Object|null} assets - Optional assets object to calculate tolerance
 * @returns {Object} { isWithinTolerance, priceDiff, tolerance, gridPrice, chainPrice, orderSize }
 */
function checkPriceWithinTolerance(gridOrder, chainOrder, assets = null) {
    const gridPrice = Number(gridOrder && gridOrder.price);
    const chainPrice = Number(chainOrder && chainOrder.price);
    const orderSize = Number((chainOrder && chainOrder.size) || (gridOrder && gridOrder.size) || 0);

    const priceDiff = Math.abs(gridPrice - chainPrice);
    const tolerance = calculatePriceTolerance(gridPrice, orderSize, gridOrder && gridOrder.type, assets);

    return {
        isWithinTolerance: priceDiff <= tolerance,
        priceDiff,
        tolerance,
        gridPrice,
        chainPrice,
        orderSize
    };
}

// --- New helpers extracted from OrderManager for reuse and testing ---
const { ORDER_TYPES, ORDER_STATES } = require('./constants');

/**
 * Parse a raw blockchain order into { orderId, price, type, size }
 * @param {Object} chainOrder
 * @param {Object} assets
 */
function parseChainOrder(chainOrder, assets) {
    if (!chainOrder || !chainOrder.sell_price || !assets) return null;
    const { base, quote } = chainOrder.sell_price;
    if (!base || !quote || !base.asset_id || !quote.asset_id || base.amount == 0) return null;
    let price; let type;
    if (base.asset_id === assets.assetA.id && quote.asset_id === assets.assetB.id) {
        price = (quote.amount / base.amount) * Math.pow(10, assets.assetA.precision - assets.assetB.precision);
        type = ORDER_TYPES.SELL;
    } else if (base.asset_id === assets.assetB.id && quote.asset_id === assets.assetA.id) {
        price = (base.amount / quote.amount) * Math.pow(10, assets.assetA.precision - assets.assetB.precision);
        type = ORDER_TYPES.BUY;
    } else return null;

    let size = null;
    try {
        if (chainOrder.for_sale !== undefined && chainOrder.for_sale !== null) {
            if (type === ORDER_TYPES.SELL) {
                const prec = assets.assetA && assets.assetA.precision !== undefined ? assets.assetA.precision : 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), prec);
            } else {
                const prec = assets.assetB && assets.assetB.precision !== undefined ? assets.assetB.precision : 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), prec);
            }
        }
    } catch (e) { size = null; }

    return { orderId: chainOrder.id, price, type, size };
}

/**
 * Scan candidate order ids and find the best match by price within tolerance.
 * @param {Object} chainOrder - { price, type, size }
 * @param {Iterable} candidateIds - iterable of grid order ids
 * @param {Map} ordersMap - Map of orderId->order object
 * @param {Function} calcToleranceFn - function(gridPrice, orderSize, orderType)
 * @returns {{match: Object|null, priceDiff: number}}
 */
function findBestMatchByPrice(chainOrder, candidateIds, ordersMap, calcToleranceFn) {
    let bestMatch = null; let smallestDiff = Infinity;
    for (const gridOrderId of candidateIds) {
        const gridOrder = ordersMap.get(gridOrderId);
        if (!gridOrder || gridOrder.type !== chainOrder.type) continue;
        const priceDiff = Math.abs(gridOrder.price - chainOrder.price);
        const orderSize = gridOrder.size || chainOrder.size || 0;
        const tolerance = calcToleranceFn(gridOrder.price, orderSize, gridOrder.type);
        if (priceDiff <= tolerance && priceDiff < smallestDiff) {
            smallestDiff = priceDiff; bestMatch = gridOrder;
        }
    }
    return { match: bestMatch, priceDiff: smallestDiff };
}

/**
 * Find a matching grid order for a parsed chain order using manager-like indices.
 * opts: { orders: Map, ordersByState: {virtual,active,filled}, assets, calcToleranceFn, logger }
 */
function findMatchingGridOrderByOpenOrder(parsedChainOrder, opts) {
    const { orders, ordersByState, assets, calcToleranceFn, logger } = opts || {};
    if (!parsedChainOrder || !orders) return null;

    // OrderId match first
    if (parsedChainOrder.orderId) {
        for (const gridOrder of orders.values()) {
            if (gridOrder.orderId === parsedChainOrder.orderId) return gridOrder;
        }
        logger?.log?.(`_findMatchingGridOrderByOpenOrder: orderId ${parsedChainOrder.orderId} NOT found in grid, falling back to price matching (chain price=${parsedChainOrder.price?.toFixed(6)}, type=${parsedChainOrder.type})`, 'info');
    }

    // Try ALL orders by price (virtual, active, spread) — match first order within tolerance
    // This widens the search so orders in any state can be matched by price if they
    // are sufficiently close to the parsed chain order price.
    for (const gridOrder of orders.values()) {
        if (!gridOrder) continue;
        const priceDiff = Math.abs(gridOrder.price - parsedChainOrder.price);
        const orderSize = (gridOrder.size && Number.isFinite(Number(gridOrder.size))) ? Number(gridOrder.size) : null;
        const tolerance = calcToleranceFn ? calcToleranceFn(gridOrder.price, orderSize, gridOrder.type) : 0;
        if (gridOrder.type === parsedChainOrder.type && priceDiff <= tolerance) return gridOrder;
    }

    // ACTIVE orders: find closest within tolerance
    if (parsedChainOrder.price !== undefined && parsedChainOrder.type) {
        const activeIds = (ordersByState && ordersByState[ORDER_STATES.ACTIVE]) || new Set();
        return findBestMatchByPrice(parsedChainOrder, activeIds, orders, calcToleranceFn).match;
    }
    return null;
}

/**
 * Match a fill operation to a grid order using manager context
 * opts: { orders: Map, assets, calcToleranceFn, logger }
 */
function findMatchingGridOrderByFill(fillOp, opts) {
    const { orders, assets, calcToleranceFn, logger } = opts || {};
    if (!fillOp) return null;

    if (fillOp.order_id) {
        for (const gridOrder of orders.values()) {
            if (gridOrder.orderId === fillOp.order_id && gridOrder.state === ORDER_STATES.ACTIVE) return gridOrder;
        }
    }

    if (!fillOp.pays || !fillOp.receives || !assets) return null;

    const paysAssetId = String(fillOp.pays.asset_id);
    const receivesAssetId = String(fillOp.receives.asset_id);
    const assetAId = String(assets.assetA?.id || '');
    const assetBId = String(assets.assetB?.id || '');
    let fillType = null; let fillPrice = null;

    if (paysAssetId === assetAId && receivesAssetId === assetBId) {
        fillType = ORDER_TYPES.SELL;
        const paysAmount = blockchainToFloat(Number(fillOp.pays.amount), assets.assetA?.precision || 0);
        const receivesAmount = blockchainToFloat(Number(fillOp.receives.amount), assets.assetB?.precision || 0);
        if (paysAmount > 0) fillPrice = receivesAmount / paysAmount;
    } else if (paysAssetId === assetBId && receivesAssetId === assetAId) {
        fillType = ORDER_TYPES.BUY;
        const paysAmount = blockchainToFloat(Number(fillOp.pays.amount), assets.assetB?.precision || 0);
        const receivesAmount = blockchainToFloat(Number(fillOp.receives.amount), assets.assetA?.precision || 0);
        if (receivesAmount > 0) fillPrice = paysAmount / receivesAmount;
    } else return null;

    if (!fillType || !Number.isFinite(fillPrice)) return null;

    logger?.log?.(`Fill analysis: type=${fillType}, price=${fillPrice.toFixed(4)}`, 'debug');

    // Find by price among ACTIVE orders
    const activeIds = [];
    for (const [id, order] of orders.entries()) if (order.state === ORDER_STATES.ACTIVE) activeIds.push(id);
    const result = findBestMatchByPrice({ type: fillType, price: fillPrice }, activeIds, orders, calcToleranceFn);
    return result.match;
}

/** Apply on-chain reported size to a tracked grid order, including funds reconciliation.
 * manager must provide: logger, _adjustFunds(delta), _updateOrder(order), assets
 */
function applyChainSizeToGridOrder(manager, gridOrder, chainSize) {
    if (!manager || !gridOrder) return;
    if (gridOrder.state !== ORDER_STATES.ACTIVE) {
        manager.logger?.log?.(`Skipping chain size apply for non-ACTIVE order ${gridOrder.id} (state=${gridOrder.state})`, 'debug');
        return;
    }
    const oldSize = Number(gridOrder.size || 0);
    const newSize = Number.isFinite(Number(chainSize)) ? Number(chainSize) : oldSize;
    const delta = newSize - oldSize;
    const precision = (gridOrder.type === ORDER_TYPES.SELL) ? manager.assets?.assetA?.precision : manager.assets?.assetB?.precision;
    const oldInt = floatToBlockchainInt(oldSize, precision);
    const newInt = floatToBlockchainInt(newSize, precision);
    if (oldInt === newInt) { gridOrder.size = newSize; return; }
    manager.logger?.log?.(`Order ${gridOrder.id} size adjustment: ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (delta: ${delta.toFixed(8)})`, 'info');
    // Adjust funds using manager helper
    try { manager._adjustFunds(gridOrder.type, delta); } catch (e) { /* best-effort */ }
    gridOrder.size = newSize;
    try { manager._updateOrder(gridOrder); } catch (e) { /* best-effort */ }
}

/**
 * Correct an order on-chain to match grid price. Uses accountOrders.updateOrder
 * manager is used for logging and available helpers.
 */
async function correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders) {
    const { gridOrder, chainOrderId, expectedPrice, size, type } = correctionInfo;
    manager.logger?.log?.(`Correcting order ${gridOrder.id} (${chainOrderId}): updating to price ${expectedPrice.toFixed(8)}`, 'info');
    try {
        let amountToSell, minToReceive;
        if (type === ORDER_TYPES.SELL) {
            amountToSell = size;
            minToReceive = size * expectedPrice;
        } else {
            amountToSell = size;
            minToReceive = size / expectedPrice;
        }
        manager.logger?.log?.(`Updating order: amountToSell=${amountToSell.toFixed(8)}, minToReceive=${minToReceive.toFixed(8)}`, 'info');
        const updateResult = await accountOrders.updateOrder(accountName, privateKey, chainOrderId, { amountToSell, minToReceive });
        if (updateResult === null) {
            manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) price correction skipped (no change to amount_to_sell)`, 'info');
            return { success: false, error: 'No change to amount_to_sell (delta=0) - update skipped' };
        }
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);
        manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) price corrected to ${expectedPrice.toFixed(8)}`, 'info');
        return { success: true, error: null };
    } catch (error) {
        manager.logger?.log?.(`Failed to correct order ${gridOrder.id}: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

/**
 * Compute minimum order size based on asset precision and factor.
 * Mirrors manager.getMinOrderSize but decoupled.
 */
function getMinOrderSize(orderType, assets, factor = 50) {
    const f = Number(factor);
    if (!f || !Number.isFinite(f) || f <= 0) return 0;
    let precision = null;
    if (assets) {
        if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
        else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
    }
    if (precision === null || precision === undefined || !Number.isFinite(precision)) return 0;
    const smallestUnit = Math.pow(10, -precision);
    return Number(f) * smallestUnit;
}

module.exports = {
    isPercentageString,
    parsePercentageString,
    blockchainToFloat,
    floatToBlockchainInt,
    resolveRelativePrice, 
    calculatePriceTolerance,
    checkPriceWithinTolerance,
    // new helpers
    parseChainOrder,
    findBestMatchByPrice,
    findMatchingGridOrderByOpenOrder,
    findMatchingGridOrderByFill,
    applyChainSizeToGridOrder,
    correctOrderPriceOnChain,
    getMinOrderSize
};

