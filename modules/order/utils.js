/**
 * modules/order/utils.js - Order subsystem utilities
 *
 * Centralized utility helpers organized into 10 functional categories:
 * - Parsing & validation of configuration values
 * - Blockchain conversions and precision handling
 * - Fund calculations and analysis
 * - Order sizing and allocation algorithms
 * - Price operations and tolerance checks
 * - Chain order matching and reconciliation
 * - Fee management and caching
 * - Grid state persistence and comparison
 * - Order object building and manipulation
 * - Order filtering, counting, and analysis
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * TABLE OF CONTENTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * SECTION 1: PARSING & VALIDATION (lines 22-95)
 *   - isPercentageString, parsePercentageString
 *   - isRelativeMultiplierString, parseRelativeMultiplierString
 *   - resolveRelativePrice, toFiniteNumber, isValidNumber
 *   Purpose: Parse and validate configuration strings
 *
 * SECTION 2: BLOCKCHAIN CONVERSIONS & PRECISION (lines 247-290)
 *   - blockchainToFloat, floatToBlockchainInt
 *   - getPrecisionByOrderType, getPrecisionForSide, getPrecisionsForManager
 *   - hasBtsPair
 *   Purpose: Handle blockchain conversions and precision calculations
 *
 * SECTION 3: FUND CALCULATIONS (lines 95-240)
 *   - computeChainFundTotals, calculateAvailableFundsValue
 *   - calculateSpreadFromOrders, resolveConfigValue
 *   - hasValidAccountTotals
 *   Purpose: Calculate fund-related values from state
 *
 * SECTION 4: PRICE OPERATIONS (lines 275-950)
 *   - calculatePriceTolerance, checkPriceWithinTolerance
 *   - deriveMarketPrice, derivePoolPrice, derivePrice
 *   - lookupAsset (helper)
 *   Purpose: Price calculation, tolerance checking, and derivation
 *
 * SECTION 5: CHAIN ORDER MATCHING & RECONCILIATION (lines 351-611)
 *   - parseChainOrder, findBestMatchByPrice
 *   - findMatchingGridOrderByOpenOrder
 *   - applyChainSizeToGridOrder, correctOrderPriceOnChain
 *   - correctAllPriceMismatches, validateOrderAmountsWithinLimits
 *   Purpose: Match grid orders to blockchain orders and reconcile state
 *
 * SECTION 6: FEE MANAGEMENT (lines 922-1180)
 *   - initializeFeeCache, getCachedFees, getAssetFees
 *   - _fetchBlockchainFees, _fetchAssetMarketFees
 *   - calculateOrderCreationFees, deductOrderFeesFromFunds
 *   Purpose: Cache and calculate market-making fees
 *
 * SECTION 7: GRID STATE MANAGEMENT (lines 1179-1440)
 *   - persistGridSnapshot, retryPersistenceIfNeeded
 *   - runGridComparisons, applyGridDivergenceCorrections
 *   - compareBlockchainSizes
 *   Purpose: Persist and compare grid state with blockchain
 *
 * SECTION 8: ORDER UTILITIES (lines 1442-1545)
 *   - buildCreateOrderArgs, convertToSpreadPlaceholder, formatOrderSize
 *   - getOrderTypeFromUpdatedFlags, resolveConfiguredPriceBound
 *   Purpose: Build and manipulate order objects
 *
 * SECTION 9: ORDER SIZING & ALLOCATION (lines 1755-1930)
 *   - allocateFundsByWeights, calculateOrderSizes
 *   - calculateRotationOrderSizes, getMinOrderSize
 *   - calculateGridSideDivergenceMetric
 *   Purpose: Calculate order sizes based on funds and grid
 *
 * SECTION 10: FILTERING & ANALYSIS (lines 1525-1750)
 *   - filterOrdersByType, filterOrdersByTypeAndState
 *   - sumOrderSizes, mapOrderSizes, countOrdersByType
 *   - checkSizesBeforeMinimum, checkSizesNearMinimum
 *   - shouldFlagOutOfSpread
 *   Purpose: Filter, count, and analyze orders
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Fund-aware functions call manager.recalculateFunds() to keep the funds
 * structure consistent with order state changes:
 * - applyChainSizeToGridOrder: Updates order size from chain data, adjusts funds
 * - correctOrderPriceOnChain: Corrects price mismatches, may affect committed funds
 * - getMinOrderSize: Calculates minimum order size based on asset precision
 */

const { ORDER_TYPES, ORDER_STATES, TIMING, GRID_LIMITS, PRECISION_DEFAULTS, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS } = require('../constants');

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1: PARSING & VALIDATION
// ════════════════════════════════════════════════════════════════════════════════
// Parse and validate configuration strings and values

/**
 * Safely convert a value to a finite number with fallback.
 * @param {*} value - Value to convert
 * @param {number} defaultValue - Fallback if not finite (default: 0)
 * @returns {number} Finite number or default
 */
function toFiniteNumber(value, defaultValue = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : defaultValue;
}

/**
 * Check if a value is defined and represents a finite number.
 * @param {*} value - Value to check
 * @returns {boolean} True if value is defined and finite
 */
function isValidNumber(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function isPercentageString(v) {
    return typeof v === 'string' && v.trim().endsWith('%');
}

function parsePercentageString(v) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    return Number.isNaN(num) ? null : num / 100.0;
}

function isRelativeMultiplierString(value) {
    return typeof value === 'string' && /^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value);
}

function parseRelativeMultiplierString(value) {
    if (!isRelativeMultiplierString(value)) return null;
    const numeric = parseFloat(value.trim().toLowerCase().slice(0, -1));
    return Number.isNaN(numeric) ? null : numeric;
}

function resolveRelativePrice(value, startPrice, mode = 'min') {
    const multiplier = parseRelativeMultiplierString(value);
    if (multiplier === null || !Number.isFinite(startPrice) || multiplier === 0) return null;
    if (mode === 'min') return startPrice / multiplier;
    if (mode === 'max') return startPrice * multiplier;
    return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3: FUND CALCULATIONS
// ════════════════════════════════════════════════════════════════════════════════
// Calculate fund-related values from account state

/**
 * Computes chain fund totals by combining free balances with committed amounts.
 *
 * @param {Object} accountTotals - Account totals object with buyFree, sellFree, buy, sell
 * @param {Object} committedChain - Committed chain funds with buy and sell properties
 * @returns {Object} Object containing:
 *   - chainFreeBuy/chainFreeSell: Free balances from account
 *   - committedChainBuy/committedChainSell: Committed amounts
 *   - freePlusLockedBuy/freePlusLockedSell: Sum of free + committed
 *   - chainTotalBuy/chainTotalSell: Account totals or free+locked, whichever is greater
 */
function computeChainFundTotals(accountTotals, committedChain) {
    const chainFreeBuy = toFiniteNumber(accountTotals?.buyFree);
    const chainFreeSell = toFiniteNumber(accountTotals?.sellFree);
    const committedChainBuy = toFiniteNumber(committedChain?.buy);
    const committedChainSell = toFiniteNumber(committedChain?.sell);

    const freePlusLockedBuy = chainFreeBuy + committedChainBuy;
    const freePlusLockedSell = chainFreeSell + committedChainSell;

    // Prefer accountTotals.buy/sell (free + locked in open orders) when available, but ensure
    // we don't regress to free-only by treating totals as at least (free + locked).
    const chainTotalBuy = isValidNumber(accountTotals?.buy)
        ? Math.max(Number(accountTotals.buy), freePlusLockedBuy)
        : freePlusLockedBuy;
    const chainTotalSell = isValidNumber(accountTotals?.sell)
        ? Math.max(Number(accountTotals.sell), freePlusLockedSell)
        : freePlusLockedSell;

    return {
        chainFreeBuy,
        chainFreeSell,
        committedChainBuy,
        committedChainSell,
        freePlusLockedBuy,
        freePlusLockedSell,
        chainTotalBuy,
        chainTotalSell
    };
}

/**
 * Calculates available funds for a specific side (buy/sell).
 *
 * FORMULA: available = max(0, chainFree - virtual - btsFeesOwed - btsFeesReservation)
 *
 * NOTE ON CACHEFUNDS:
 * cacheFunds (unspent fill proceeds and rotation surpluses) is intentionally NOT subtracted
 * from available. This is because cacheFunds represents capital that is still available for
 * grid sizing and order creation. It's kept separate from chainFree to track proceeds that
 * will be rotated back into the grid in future cycles. cacheFunds is added to grid sizing
 * calculations separately during rebalancing.
 *
 * FUND COMPONENTS:
 * - chainFree: Unallocated funds on blockchain (free to use immediately)
 * - virtual: Funds reserved for VIRTUAL grid orders (not yet on-chain)
 * - btsFeesOwed: Accumulated BTS fees waiting to be settled from cacheFunds
 * - btsFeesReservation: Buffer reserved for future order creation fees
 * - cacheFunds: Fill proceeds and rotation surplus (added to grid sizing separately)
 *
 * @param {string} side - 'buy' or 'sell'
 * @param {Object} accountTotals - Account totals with buyFree/sellFree
 * @param {Object} funds - Fund tracking object
 * @param {string} assetA - Asset A symbol (to determine BTS side)
 * @param {string} assetB - Asset B symbol (to determine BTS side)
 * @param {Object} activeOrders - Target order counts (for BTS fee reservation)
 * @returns {number} Available funds for the side (chainFree minus reserved/owed), always >= 0
 */
function calculateAvailableFundsValue(side, accountTotals, funds, assetA, assetB, activeOrders = null) {
    if (side !== 'buy' && side !== 'sell') return 0;

    const chainFree = toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree);
    const virtual = toFiniteNumber(side === 'buy' ? funds.virtual?.buy : funds.virtual?.sell);
    const btsFeesOwed = toFiniteNumber(funds.btsFeesOwed);

    // Determine which side actually has BTS as the asset
    const btsSide = (assetA === 'BTS') ? 'sell' : (assetB === 'BTS') ? 'buy' : null;

    // Reserve BTS fees for updating target open orders (needed when regenerating grid)
    let btsFeesReservation = 0;
    if (btsSide === side && activeOrders) {
        try {
            const targetBuy = Math.max(0, toFiniteNumber(activeOrders?.buy, 1));
            const targetSell = Math.max(0, toFiniteNumber(activeOrders?.sell, 1));
            const totalTargetOrders = targetBuy + targetSell;

            if (totalTargetOrders > 0) {
                const btsFeeData = getAssetFees('BTS', 1);
                btsFeesReservation = btsFeeData.createFee * totalTargetOrders * FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;
            }
        } catch (err) {
            btsFeesReservation = FEE_PARAMETERS.BTS_FALLBACK_FEE;
        }
    }

    // Subtract btsFeesOwed from the side that holds BTS to prevent over-allocation
    const currentFeesOwed = (btsSide === side) ? btsFeesOwed : 0;

    return Math.max(0, chainFree - virtual - currentFeesOwed - btsFeesReservation);
}

/**
 * Calculates the current spread percentage between best buy and sell orders.
 * Only uses active orders - virtual orders haven't been placed yet.
 *
 * @param {Array} activeBuys - Active buy orders
 * @param {Array} activeSells - Active sell orders
 * @returns {number} Spread percentage (e.g., 2.5 for 2.5%), or 0 if no valid spread
 */
function calculateSpreadFromOrders(activeBuys, activeSells) {
    // Only calculate spread from on-chain orders (ACTIVE + PARTIAL)
    // Virtual orders haven't been placed yet and don't affect the actual market spread
    const bestBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : null;
    const bestSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : null;

    // If no on-chain orders on either side, spread is undefined (return 0)
    if (bestBuy === null || bestSell === null || bestBuy === 0) return 0;

    return ((bestSell / bestBuy) - 1) * 100;
}

/**
 * Resolves a config value to a numeric amount.
 * Supports: direct numbers, percentage strings (e.g., "50%"), or numeric strings.
 * Returns 0 if value cannot be parsed or if total is needed but not provided.
 *
 * @param {*} value - The config value to resolve
 * @param {number} total - The total amount (required for percentage calculations)
 * @returns {number} Resolved numeric value
 */
function resolveConfigValue(value, total) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const p = parsePercentageString(value);
        if (p !== null) {
            if (total === null || total === undefined) {
                return 0; // Cannot resolve without total
            }
            return total * p;
        }
        const n = parseFloat(value);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2: BLOCKCHAIN CONVERSIONS & PRECISION
// ════════════════════════════════════════════════════════════════════════════════
// Handle blockchain integer/float conversions and precision calculations

function blockchainToFloat(intValue, precision) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for blockchainToFloat: ${precision}`);
    }
    return toFiniteNumber(intValue) / Math.pow(10, Number(precision));
}

function floatToBlockchainInt(floatValue, precision) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for floatToBlockchainInt: ${precision}`);
    }
    const p = Number(precision);
    const scaled = Math.round(toFiniteNumber(floatValue) * Math.pow(10, p));

    // 64-bit signed integer limits: -(2^63) to (2^63 - 1)
    const MAX_INT64 = 9223372036854775807;
    const MIN_INT64 = -9223372036854775808;

    if (scaled > MAX_INT64 || scaled < MIN_INT64) {
        console.warn(`[floatToBlockchainInt] Overflow detected: ${floatValue} with precision ${p} resulted in ${scaled}. Clamping to safe limits.`);
        return scaled > 0 ? MAX_INT64 : MIN_INT64;
    }

    return scaled;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4: PRICE OPERATIONS (PART 1 - Tolerance)
// ════════════════════════════════════════════════════════════════════════════════
// Price tolerance calculation and checking (also see Section 4 Part 2: Price derivation)

function calculatePriceTolerance(gridPrice, orderSize, orderType, assets = null) {
    if (!assets || !gridPrice || !orderSize) {
        return gridPrice ? gridPrice * PRECISION_DEFAULTS.PRICE_TOLERANCE : 0;
    }

    const precisionA = assets.assetA?.precision;
    const precisionB = assets.assetB?.precision;

    if (!isValidNumber(precisionA) || !isValidNumber(precisionB)) {
        throw new Error(`Missing or invalid asset precision in calculatePriceTolerance: A=${precisionA}, B=${precisionB}`);
    }

    let orderSizeA, orderSizeB;
    if (orderType === 'sell' || orderType === 'SELL' || orderType === 'Sell') {
        orderSizeA = orderSize;
        orderSizeB = orderSize * gridPrice;
    } else {
        orderSizeB = orderSize;
        orderSizeA = orderSize / gridPrice;
    }

    const termA = 1 / (orderSizeA * Math.pow(10, precisionA));
    const termB = 1 / (orderSizeB * Math.pow(10, precisionB));
    const tolerance = (termA + termB) * gridPrice;
    return tolerance;
}

function checkPriceWithinTolerance(gridOrder, chainOrder, assets = null) {
    const gridPrice = toFiniteNumber(gridOrder?.price);
    const chainPrice = toFiniteNumber(chainOrder?.price);
    const orderSize = toFiniteNumber(chainOrder?.size ?? gridOrder?.size);

    const priceDiff = Math.abs(gridPrice - chainPrice);
    const tolerance = calculatePriceTolerance(gridPrice, orderSize, gridOrder?.type, assets);

    return {
        isWithinTolerance: priceDiff <= tolerance,
        priceDiff,
        tolerance,
        gridPrice,
        chainPrice,
        orderSize
    };
}

/**
 * Validate that calculated order amounts won't exceed 64-bit integer limits.
 * Returns true if amounts are safe, false if they would overflow.
 * @param {number} amountToSell - Amount to sell (in float)
 * @param {number} minToReceive - Minimum to receive (in float)
 * @param {number} sellPrecision - Precision of sell asset
 * @param {number} receivePrecision - Precision of receive asset
 * @returns {boolean} true if amounts are within safe limits
 */
function validateOrderAmountsWithinLimits(amountToSell, minToReceive, sellPrecision, receivePrecision) {
    const MAX_INT64 = 9223372036854775807;

    const sellPrecFloat = Math.pow(10, toFiniteNumber(sellPrecision));
    const receivePrecFloat = Math.pow(10, toFiniteNumber(receivePrecision));

    const sellInt = Math.round(toFiniteNumber(amountToSell) * sellPrecFloat);
    const receiveInt = Math.round(toFiniteNumber(minToReceive) * receivePrecFloat);

    const withinLimits = sellInt <= MAX_INT64 && receiveInt <= MAX_INT64 && sellInt > 0 && receiveInt > 0;

    if (!withinLimits) {
        console.warn(
            `[validateOrderAmountsWithinLimits] Order amounts exceed safe limits or are invalid. ` +
            `Sell: ${amountToSell} (precision ${sellPrecision}) = ${sellInt}, ` +
            `Receive: ${minToReceive} (precision ${receivePrecision}) = ${receiveInt}. ` +
            `Max allowed: ${MAX_INT64}`
        );
    }

    return withinLimits;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5: CHAIN ORDER MATCHING & RECONCILIATION (PART 1 - Parsing & Matching)
// ════════════════════════════════════════════════════════════════════════════════
// Parse blockchain orders and match them to grid orders

function parseChainOrder(chainOrder, assets) {
    if (!chainOrder || !chainOrder.sell_price || !assets) return null;
    const { base, quote } = chainOrder.sell_price;
    if (!base || !quote || !base.asset_id || !quote.asset_id || base.amount === 0) return null;
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
                // For SELL: for_sale is in assetA (base asset)
                const prec = assets?.assetA?.precision ?? 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), prec);
            } else {
                // For BUY: for_sale is in assetB (quote asset we're selling)
                // IMPORTANT: grid BUY sizes are tracked in assetB units (see ORDER_STATES docs).
                // So we keep size in assetB units here.
                const bPrec = assets?.assetB?.precision ?? 0;
                size = blockchainToFloat(Number(chainOrder.for_sale), bPrec);
            }
        }
    } catch (e) { size = null; }

    return { orderId: chainOrder.id, price, type, size };
}

function findBestMatchByPrice(chainOrder, candidateIds, ordersMap, calcToleranceFn) {
    let bestMatch = null; let smallestDiff = Infinity;
    for (const gridOrderId of candidateIds) {
        const gridOrder = ordersMap.get(gridOrderId);
        if (!gridOrder || gridOrder.type !== chainOrder.type) continue;
        const priceDiff = Math.abs(gridOrder.price - chainOrder.price);
        const orderSize = toFiniteNumber(gridOrder.size ?? chainOrder.size);
        const tolerance = calcToleranceFn(gridOrder.price, orderSize, gridOrder.type);
        if (priceDiff <= tolerance && priceDiff < smallestDiff) {
            smallestDiff = priceDiff; bestMatch = gridOrder;
        }
    }
    return { match: bestMatch, priceDiff: smallestDiff };
}

/**
 * Match chain order to grid order by price + size tolerance.
 * - Matches with ACTIVE or VIRTUAL grid orders
 * - Both price AND size must be within tolerance
 * - When matched: grid order becomes ACTIVE with chain orderID
 * - Returns best match (closest price) or null
 */
function findMatchingGridOrderByOpenOrder(parsedChainOrder, opts) {
    const { orders, assets, calcToleranceFn, logger } = opts || {};
    if (!parsedChainOrder || !orders) return null;

    // 1. Fast path: exact orderId match
    if (parsedChainOrder.orderId) {
        for (const gridOrder of orders.values()) {
            if (gridOrder?.orderId === parsedChainOrder.orderId) return gridOrder;
        }
    }

    const chainSize = toFiniteNumber(parsedChainOrder.size);
    const chainPrice = toFiniteNumber(parsedChainOrder.price);
    const isSell = parsedChainOrder.type === ORDER_TYPES.SELL;
    const precision = isSell ? (assets?.assetA?.precision ?? 0) : (assets?.assetB?.precision ?? 0);
    const chainInt = floatToBlockchainInt(chainSize, precision);

    let bestMatch = null;
    let bestPriceDiff = Infinity;

    // 2. Match with ACTIVE/PARTIAL/VIRTUAL grid orders
    for (const gridOrder of orders.values()) {
        if (!gridOrder || gridOrder.type !== parsedChainOrder.type) continue;
        if (![ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL, ORDER_STATES.VIRTUAL].includes(gridOrder.state)) continue;

        // Price tolerance check
        const priceDiff = Math.abs(gridOrder.price - chainPrice);
        const priceTolerance = calcToleranceFn?.(gridOrder.price, gridOrder.size, gridOrder.type) || 0;
        if (priceDiff > priceTolerance) continue;

        // Size check: compare in blockchain integer units
        if (!opts?.skipSizeMatch && Math.abs(floatToBlockchainInt(gridOrder.size, precision) - chainInt) > 1) {
            logger?.log?.(`Chain size mismatch grid ${gridOrder.id}: chain=${chainSize.toFixed(8)}, grid=${toFiniteNumber(gridOrder.size).toFixed(8)}`, 'debug');
            continue;
        }

        if (priceDiff < bestPriceDiff) {
            bestPriceDiff = priceDiff;
            bestMatch = gridOrder;
        }
    }

    if (bestMatch) {
        logger?.log?.(`Matched chain ${parsedChainOrder.orderId} (price=${chainPrice.toFixed(6)}) to grid ${bestMatch.id} (price=${bestMatch.price.toFixed(6)}, state=${bestMatch.state})`, 'info');
        return bestMatch;
    }

    logger?.log?.(`No grid match for chain ${parsedChainOrder.orderId} (price=${chainPrice.toFixed(6)})`, 'warn');
    return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 5: CHAIN ORDER MATCHING & RECONCILIATION (PART 2 - Reconciliation)
// ════════════════════════════════════════════════════════════════════════════════
// Apply blockchain order data to grid orders and correct price mismatches

/**
 * Correct all orders that have been flagged for price mismatches on-chain.
 * Accepts a manager instance and iterates its ordersNeedingPriceCorrection.
 */
async function correctAllPriceMismatches(manager, accountName, privateKey, accountOrders) {
    if (!manager) throw new Error('manager required');

    // Use correction lock to prevent concurrent mutations during snapshot
    if (!manager._correctionsLock) {
        manager.logger?.log?.(`Warning: corrections lock not available, skipping corrections`, 'warn');
        return { corrected: 0, failed: 0, results: [] };
    }

    return await manager._correctionsLock.acquire(async () => {
        const results = [];
        let corrected = 0;
        let failed = 0;

        // Snapshot under lock (guaranteed no mutations happening)
        // Deduplicate by chainOrderId to avoid double-correction attempts
        const allOrders = Array.isArray(manager.ordersNeedingPriceCorrection) ? [...manager.ordersNeedingPriceCorrection] : [];
        const seen = new Set();
        const ordersToCorrect = allOrders.filter(c => {
            if (!c.chainOrderId || seen.has(c.chainOrderId)) return false;
            seen.add(c.chainOrderId);
            return true;
        });

        for (const correctionInfo of ordersToCorrect) {
            const result = await correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders);
            results.push({ ...correctionInfo, result });

            if (result && result.success) corrected++; else failed++;

            // Small delay between corrections to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, TIMING.SYNC_DELAY_MS));
        }

        manager.logger?.log?.(`Price correction complete: ${corrected} corrected, ${failed} failed`, 'info');
        return { corrected, failed, results };
    });
}

function applyChainSizeToGridOrder(manager, gridOrder, chainSize) {
    if (!manager || !gridOrder) return;
    // Allow updates for ACTIVE and PARTIAL orders
    if (gridOrder.state !== ORDER_STATES.ACTIVE && gridOrder.state !== ORDER_STATES.PARTIAL) {
        manager.logger?.log?.(`Skipping chain size apply for non-ACTIVE/PARTIAL order ${gridOrder.id} (state=${gridOrder.state})`, 'debug');
        return;
    }
    const oldSize = Number(gridOrder.size || 0);
    const newSize = Number.isFinite(Number(chainSize)) ? Number(chainSize) : oldSize;

    // ANCHOR & REFILL PROTECTION: If this is a dust refill that hasn't moved on-chain yet,
    // don't revert its size back to the tiny on-chain amount during sync.
    // We only accept the chain size if it's DIFFERENT from what we have and it's NOT a dust refill gap.
    if (gridOrder.isDustRefill && newSize < oldSize) {
        manager.logger?.log?.(`Sync: Preserving dust refill size for ${gridOrder.id} (${oldSize.toFixed(8)}) despite smaller chain size (${newSize.toFixed(8)})`, 'debug');
        return;
    }

    const delta = newSize - oldSize;
    const precision = (gridOrder.type === ORDER_TYPES.SELL) ? manager.assets?.assetA?.precision : manager.assets?.assetB?.precision;
    const oldInt = floatToBlockchainInt(oldSize, precision);
    const newInt = floatToBlockchainInt(newSize, precision);
    if (oldInt === newInt) { gridOrder.size = newSize; return; }
    manager.logger?.log?.(`Order ${gridOrder.id} size adjustment: ${oldSize.toFixed(8)} -> ${newSize.toFixed(8)} (delta: ${delta.toFixed(8)})`, 'debug');
    gridOrder.size = newSize;
    try { manager._updateOrder(gridOrder); } catch (e) { /* best-effort */ }

    if (delta < 0 && manager.logger) {
        // After partial fill adjustment, log funds snapshot for visibility
        if (typeof manager.logger.logFundsStatus === 'function') {
            manager.logger.logFundsStatus(manager);
        } else {
            const f = manager.funds || {};
            const a = f.available || {};
            manager.logger.log(
                `Funds after partial fill: available buy=${(a.buy || 0).toFixed(8)} sell=${(a.sell || 0).toFixed(8)}`,
                'info'
            );
        }
    }
}

/**
 * Correct a single order's price on the blockchain.
 * @param {Object} manager - Manager instance with correction list and logger
 * @param {Object} correctionInfo - Correction details
 * @param {Object} correctionInfo.gridOrder - Grid order object
 * @param {string} correctionInfo.chainOrderId - Order ID on chain
 * @param {number} correctionInfo.expectedPrice - Expected price (MUST be > 0 to avoid Infinity in calculations)
 * @param {number} correctionInfo.size - Order size
 * @param {string} correctionInfo.type - Order type (BUY/SELL)
 * @param {string} accountName - Account name
 * @param {string} privateKey - Private key for signing
 * @param {Object} accountOrders - Account orders API instance
 * @returns {Promise<{success: boolean, error?: string, skipped?: boolean, orderGone?: boolean}>}
 */
async function correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders) {
    const { gridOrder, chainOrderId, expectedPrice, size, type } = correctionInfo;

    // Skip if already removed from correction list (processed in another call)
    const stillNeeded = manager.ordersNeedingPriceCorrection?.some(c => c.chainOrderId === chainOrderId);
    if (!stillNeeded) {
        manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) correction already processed, skipping`, 'info');
        return { success: true, error: null, skipped: true };
    }

    manager.logger?.log?.(`Correcting order ${gridOrder.id} (${chainOrderId}): updating to price ${expectedPrice.toFixed(8)}`, 'info');

    // Calculate amounts (outside try block as this calculation is unlikely to fail)
    let amountToSell, minToReceive;
    if (type === ORDER_TYPES.SELL) {
        amountToSell = size;
        minToReceive = size * expectedPrice;
    } else {
        amountToSell = size;
        minToReceive = size / expectedPrice;
    }
    manager.logger?.log?.(`Updating order: amountToSell=${amountToSell.toFixed(8)}, minToReceive=${minToReceive.toFixed(8)}`, 'info');

    // Execute the chain update
    try {
        const updateResult = await accountOrders.updateOrder(accountName, privateKey, chainOrderId, { amountToSell, minToReceive });
        if (updateResult === null) {
            manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) price correction skipped (no change to amount_to_sell)`, 'info');
            return { success: false, error: 'No change to amount_to_sell (delta=0) - update skipped' };
        }
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);
        manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) price corrected to ${expectedPrice.toFixed(8)}`, 'info');
        return { success: true, error: null };
    } catch (error) {
        // Remove from list regardless of outcome to prevent retry loops
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(c => c.chainOrderId !== chainOrderId);

        // Handle "not found" gracefully - order was filled between detection and correction
        if (error.message && error.message.includes('not found')) {
            manager.logger?.log?.(`Order ${gridOrder.id} (${chainOrderId}) no longer exists on chain - was it filled?`, 'warn');
            return { success: false, error: error.message, orderGone: true };
        }

        manager.logger?.log?.(`Failed to correct order ${gridOrder.id}: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

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

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 4: PRICE OPERATIONS (PART 2 - Derivation)
// ════════════════════════════════════════════════════════════════════════════════
// Derive market and pool prices from blockchain (moved from modules/order/price.js)

const lookupAsset = async (BitShares, s) => {
    if (!BitShares) return null;
    const sym = s.toLowerCase();
    let cached = BitShares.assets ? BitShares.assets[sym] : null;

    // Only trust cached assets when they include precision; otherwise enrich via db.
    if (cached?.id && typeof cached.precision === 'number') return cached;

    const methods = [
        () => BitShares.db.lookup_asset_symbols([s]),
        () => BitShares.db.get_assets([s])
    ];

    for (const method of methods) {
        try {
            if (typeof method !== 'function') continue;
            const r = await method();
            if (r?.[0]?.id) return { ...(cached || {}), ...r[0] };
        } catch (e) {
            console.warn(`[utils.js] lookupAsset ${sym} failure:`, e.message);
        }
    }

    return cached?.id ? cached : null;
};

const deriveMarketPrice = async (BitShares, symA, symB) => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        const baseId = aMeta.id;
        const quoteId = bMeta.id;
        let mid = null;

        // Try order book first
        if (typeof BitShares.db?.get_order_book === 'function') {
            try {
                const ob = await BitShares.db.get_order_book(baseId, quoteId, API_LIMITS.ORDERBOOK_DEPTH);
                const bestBid = isValidNumber(ob.bids?.[0]?.price) ? ob.bids[0].price : null;
                const bestAsk = isValidNumber(ob.asks?.[0]?.price) ? ob.asks[0].price : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            } catch (e) { console.warn(`[utils.js] deriveMarketPrice orderbook failed for ${symA}/${symB}:`, e.message); }
        }

        // Fallback to ticker
        if (mid === null && typeof BitShares.db?.get_ticker === 'function') {
            try {
                const t = await BitShares.db.get_ticker(baseId, quoteId);
                // Handle 0 correctly by ensuring we only accept mid > 0 for final result
                mid = isValidNumber(t?.latest) ? Number(t.latest) : (isValidNumber(t?.latest_price) ? Number(t.latest_price) : null);
            } catch (err) { console.warn(`[utils.js] deriveMarketPrice ticker failed for ${symA}/${symB}:`, err.message); }
        }

        return (mid !== null && mid !== 0) ? 1 / mid : null;
    } catch (err) {
        return null;
    }
};

const derivePoolPrice = async (BitShares, symA, symB) => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        let chosen = null;

        // 1. Direct lookup
        if (typeof BitShares.db?.get_liquidity_pool_by_asset_ids === 'function') {
            try {
                chosen = await BitShares.db.get_liquidity_pool_by_asset_ids(aMeta.id, bMeta.id);
            } catch (e) { console.warn(`[utils.js] derivePoolPrice direct lookup failed for ${symA}/${symB}:`, e.message); }
        }

        // 2. Scan if not found
        if (!chosen && typeof BitShares.db?.list_liquidity_pools === 'function') {
            try {
                let startId = '1.19.0';
                let batchCount = 0;
                const allMatches = [];

                while (batchCount < API_LIMITS.MAX_POOL_SCAN_BATCHES) {
                    const pools = await BitShares.db.list_liquidity_pools(API_LIMITS.POOL_BATCH_SIZE, startId);
                    if (!pools?.length) break;

                    const matches = pools.filter(p => {
                        const ids = (p.asset_ids || [p.asset_a, p.asset_b]).map(String);
                        return ids.includes(aMeta.id) && ids.includes(bMeta.id);
                    });

                    if (matches.length) allMatches.push(...matches);
                    if (pools.length < API_LIMITS.POOL_BATCH_SIZE || startId === pools[pools.length - 1].id) break;
                    
                    startId = pools[pools.length - 1].id;
                    batchCount++;
                }

                if (allMatches.length) {
                    chosen = allMatches.sort((a, b) => {
                        const getBal = p => Number(p.asset_a === aMeta.id ? p.balance_a : p.balance_b);
                        return getBal(b) - getBal(a);
                    })[0];
                }
            } catch (e) { console.warn(`[utils.js] derivePoolPrice scan pools failed for ${symA}/${symB}:`, e.message); }
        }

        // 3. Last resort fallback
        if (!chosen && typeof BitShares.db?.get_liquidity_pools === 'function') {
            try {
                const pools = await BitShares.db.get_liquidity_pools();
                const matches = (pools || []).filter(p => (p.asset_ids || []).map(String).includes(aMeta.id) && (p.asset_ids || []).map(String).includes(bMeta.id));
                if (matches.length) chosen = matches.sort((a, b) => Number(b.total_reserve || 0) - Number(a.total_reserve || 0))[0];
            } catch (e) { console.warn(`[utils.js] derivePoolPrice get_liquidity_pools fallback failed for ${symA}/${symB}:`, e.message); }
        }

        if (!chosen) return null;

        // Fetch full object if needed
        if (!chosen.balance_a && chosen.id && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [full] = await BitShares.db.get_objects([chosen.id]);
                if (full) chosen = { ...chosen, ...full };
            } catch (e) { console.debug(`[utils.js] derivePoolPrice get_objects enrichment failed, proceeding with summary:`, e.message); }
        }

        let amtA = null, amtB = null;
        if (isValidNumber(chosen.balance_a) && isValidNumber(chosen.balance_b)) {
            const isA = chosen.asset_a === aMeta.id;
            amtA = Number(isA ? chosen.balance_a : chosen.balance_b);
            amtB = Number(isA ? chosen.balance_b : chosen.balance_a);
        } else if (Array.isArray(chosen.reserves)) {
            amtA = Number(chosen.reserves.find(r => String(r.asset_id) === aMeta.id)?.amount);
            amtB = Number(chosen.reserves.find(r => String(r.asset_id) === bMeta.id)?.amount);
        }

        if (!isValidNumber(amtA) || !isValidNumber(amtB) || amtA === 0) return null;

        const floatA = amtA / Math.pow(10, aMeta.precision);
        const floatB = amtB / Math.pow(10, bMeta.precision);
        return floatA > 0 ? floatB / floatA : null;
    } catch (err) {
        return null;
    }
};

// derivePrice: pooled -> market -> aggregated limit orders
const derivePrice = async (BitShares, symA, symB, mode = 'auto') => {
    mode = String(mode).toLowerCase();

    // 1. Try Pool Price
    if (mode === 'pool' || mode === 'auto') {
        try {
            const p = await derivePoolPrice(BitShares, symA, symB);
            if (p > 0) return p;
        } catch (e) { /* fallback */ }
    }

    // 2. Try Market Ticker/Orderbook
    if (mode === 'market' || mode === 'auto' || mode === 'pool') {
        try {
            const m = await deriveMarketPrice(BitShares, symA, symB);
            if (m > 0) return m;
        } catch (e) { /* fallback */ }
    }

    // 3. Fallback to aggregated limit orders
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        const aId = aMeta.id, bId = bMeta.id;
        const getOrders = (id1, id2) => BitShares.db?.get_limit_orders?.(id1, id2, API_LIMITS.LIMIT_ORDERS_BATCH);
        
        let orders = await getOrders(aId, bId).catch(() => null);
        if (!orders?.length) orders = await getOrders(bId, aId).catch(() => null);
        if (!orders?.length) return null;

        let sumNum = 0, sumDen = 0;
        for (const o of orders) {
            if (!o.sell_price) continue;
            const { base, quote } = o.sell_price;
            
            const getPrec = async (id) => {
                if (BitShares.assets?.[id]?.precision !== undefined) return BitShares.assets[id].precision;
                const [a] = await BitShares.db.get_assets([id]).catch(() => []);
                return a?.precision ?? 0;
            };

            const [basePrec, quotePrec] = await Promise.all([getPrec(base.asset_id), getPrec(quote.asset_id)]);
            const baseAmt = Number(base.amount), quoteAmt = Number(quote.amount);
            if (!baseAmt || !quoteAmt) continue;

            const price = (quoteAmt / baseAmt) * Math.pow(10, basePrec - quotePrec);
            const size = Number(o.for_sale) / Math.pow(10, basePrec);
            
            let priceInDesired = null;
            if (base.asset_id === aId && quote.asset_id === bId) priceInDesired = price;
            else if (base.asset_id === bId && quote.asset_id === aId && price !== 0) priceInDesired = 1 / price;

            if (isValidNumber(priceInDesired) && priceInDesired > 0) {
                const weight = Math.max(1e-12, size);
                sumNum += priceInDesired * weight;
                sumDen += weight;
            }
        }
        return sumDen > 0 ? sumNum / sumDen : null;
    } catch (e) {
        return null;
    }
};

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 6: FEE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════
// Cache and calculate market-making fees

/**
 * Cache for storing fee information for all assets
 * Structure: {
 *   assetSymbol: {
 *     assetId: string,
 *     precision: number,
 *     marketFee: { basisPoints: number, percent: number },
 *     takerFee: { percent: number } | null,
 *     maxMarketFee: { raw: number, float: number }
 *   },
 *   BTS: { blockchain fees - see below }
 * }
 */
let feeCache = {};

/**
 * Initialize and cache fees for all assets from bots.json configuration
 * Also includes BTS for blockchain fees (maker/taker order creation/cancel)
 *
 * @param {Array} botsConfig - Array of bot configurations from bots.json
 * @param {object} BitShares - BitShares library instance for fetching asset data
 * @returns {Promise<object>} The populated fee cache
 */
async function initializeFeeCache(botsConfig, BitShares) {
    if (!botsConfig || !Array.isArray(botsConfig)) {
        throw new Error('botsConfig must be an array of bot configurations');
    }
    if (!BitShares || !BitShares.db) {
        throw new Error('BitShares library instance with db methods required');
    }

    // Extract unique asset symbols from bot configurations
    const uniqueAssets = new Set(['BTS']); // Always include BTS for blockchain fees

    for (const bot of botsConfig) {
        if (bot.assetA) uniqueAssets.add(bot.assetA);
        if (bot.assetB) uniqueAssets.add(bot.assetB);
    }

    // Fetch and cache fees for each asset
    for (const assetSymbol of uniqueAssets) {
        try {
            if (assetSymbol === 'BTS') {
                // Special handling for BTS - fetch blockchain operation fees
                feeCache.BTS = await _fetchBlockchainFees(BitShares);
            } else {
                // Fetch market fees for other assets
                feeCache[assetSymbol] = await _fetchAssetMarketFees(assetSymbol, BitShares);
            }
        } catch (error) {
            console.error(`Error caching fees for ${assetSymbol}:`, error.message);
            // Continue with other assets even if one fails
        }
    }

    return feeCache;
}

/**
 * Get cached fees for a specific asset
 * Useful for checking if cache has been initialized
 *
 * @param {string} assetSymbol - Asset symbol (e.g., 'IOB.XRP', 'TWENTIX', 'BTS')
 * @returns {object|null} Fee data if cached, null otherwise
 */
function getCachedFees(assetSymbol) {
    return feeCache[assetSymbol] || null;
}

/**
 * Clear the fee cache (useful for testing or refreshing)
 */
/**
 * Get total fees (blockchain + market) for a filled order amount
 *
 * @param {string} assetSymbol - Asset symbol (e.g., 'IOB.XRP', 'TWENTIX', 'BTS')
 * @param {number} assetAmount - Amount of asset to calculate fees for
 * @returns {number|object} Fee amount in the asset's native units
 *   For BTS: object with { total: number, createFee: number }
 *     - total: blockchain fees (creation 10% + update)
 *     - createFee: the full limit order creation fee
 *   For market assets: total fee amount (number)
 */
function getAssetFees(assetSymbol, assetAmount) {
    const cachedFees = feeCache[assetSymbol];

    if (!cachedFees) {
        throw new Error(`Fees not cached for ${assetSymbol}. Call initializeFeeCache first.`);
    }

    assetAmount = Number(assetAmount);
    if (!Number.isFinite(assetAmount) || assetAmount < 0) {
        throw new Error(`Invalid assetAmount: ${assetAmount}`);
    }

    // Special handling for BTS (blockchain fees only)
    if (assetSymbol === 'BTS') {
        const orderCreationFee = cachedFees.limitOrderCreate.bts;
        const orderUpdateFee = cachedFees.limitOrderUpdate.bts;
        const makerNetFee = orderCreationFee * 0.1; // 10% of creation fee after 90% refund
        return {
            total: makerNetFee + orderUpdateFee,
            createFee: orderCreationFee,
            updateFee: orderUpdateFee,
            makerNetFee: makerNetFee
        };
    }

    // Handle regular assets - deduct market fee from the amount received
    const marketFeePercent = cachedFees.marketFee?.percent || 0;
    const marketFeeAmount = (assetAmount * marketFeePercent) / 100;

    // Return amount after market fees are deducted
    return assetAmount - marketFeeAmount;
}

/**
 * Internal function to fetch blockchain operation fees
 */
async function _fetchBlockchainFees(BitShares) {
    try {
        const globalProps = await BitShares.db.getGlobalProperties();
        const currentFees = globalProps.parameters.current_fees.parameters;

        const findFee = (opCode) => {
            const param = currentFees.find(p => p[0] === opCode);
            const fee = param?.[1]?.fee;
            const feeNum = toFiniteNumber(fee);
            return {
                raw: feeNum,
                satoshis: feeNum,
                bts: blockchainToFloat(feeNum, 5)
            };
        };

        return {
            limitOrderCreate: findFee(1),
            limitOrderCancel: findFee(2),
            limitOrderUpdate: findFee(77)
        };
    } catch (error) {
        throw new Error(`Failed to fetch blockchain fees: ${error.message}`);
    }
}

/**
 * Internal function to fetch market fees for a specific asset
 */
async function _fetchAssetMarketFees(assetSymbol, BitShares) {
    try {
        const fullAsset = await lookupAsset(BitShares, assetSymbol);
        if (!fullAsset || !fullAsset.id) {
            throw new Error(`Asset ${assetSymbol} not found or could not fetch full data`);
        }

        const assetId = fullAsset.id;
        const options = fullAsset.options || {};

        const marketFeeBasisPoints = options.market_fee_percent || 0;
        const marketFeePercent = marketFeeBasisPoints / 100;

        // Extract taker fee from extensions
        let takerFeePercent = null;
        if (options.extensions && typeof options.extensions === 'object') {
            if (options.extensions.taker_fee_percent !== undefined) {
                const value = toFiniteNumber(options.extensions.taker_fee_percent);
                takerFeePercent = value / 100;
            }
        }

        // Check if taker_fee_percent exists directly in options
        if (takerFeePercent === null && options.taker_fee_percent !== undefined) {
            const value = toFiniteNumber(options.taker_fee_percent);
            takerFeePercent = value / 100;
        }

        return {
            assetId: assetId,
            symbol: assetSymbol,
            precision: fullAsset.precision,
            marketFee: {
                basisPoints: marketFeeBasisPoints,
                percent: marketFeePercent
            },
            takerFee: takerFeePercent !== null ? { percent: takerFeePercent } : null,
            maxMarketFee: {
                raw: options.max_market_fee || 0,
                float: blockchainToFloat(options.max_market_fee || 0, fullAsset.precision)
            },
            issuer: fullAsset.issuer
        };
    } catch (error) {
        throw new Error(`Failed to fetch market fees for ${assetSymbol}: ${error.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 7: GRID STATE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════
// Persist and compare grid state with blockchain

/**
 * Centralized grid persistence helper.
 * Handles all persistence operations (grid snapshot + fund data) in one call.
 * Automatically manages error handling without throwing exceptions.
 * Now async to support AsyncLock in storeMasterGrid (fixes Issue #1, #5).
 *
 * Usage: Instead of:
 *   accountOrders.storeMasterGrid(botKey, Array.from(manager.orders.values()),
 *                                  manager.funds.cacheFunds,
 *                                  manager.funds.btsFeesOwed);
 *   const feesOk = manager._persistBtsFeesOwed();
 *
 * Just use:
 *   await persistGridSnapshot(manager, accountOrders, botKey);
 *
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders instance for storage
 * @param {string} botKey - Bot identifier key
 * @returns {Promise<boolean>} true if all persistence succeeded, false if any failed
 */
async function persistGridSnapshot(manager, accountOrders, botKey) {
    if (!manager || !accountOrders || !botKey) {
        return false;
    }

    try {
        // Persist the complete grid with all fund data
        // Now async to support AsyncLock serialization
        await accountOrders.storeMasterGrid(
            botKey,
            Array.from(manager.orders.values()),
            manager.funds.cacheFunds,
            manager.funds.btsFeesOwed
        );

        // Also try to persist fees component for redundancy
        const feesOk = manager._persistBtsFeesOwed?.();

        return (feesOk !== false);
    } catch (e) {
        if (manager.logger) {
            manager.logger.log(`Error during grid persistence: ${e.message}`, 'error');
        }
        return false;
    }
}

/**
 * Retry persistence of previously failed fund data.
 * Called periodically when bot is in a stable state to retry saving funds that couldn't be persisted.
 * Useful when disk I/O errors occur but later become transient.
 *
 * @param {Object} manager - The OrderManager instance containing persistence state
 * @returns {boolean} true if all retried data persisted successfully, false if some still failing
 *
 * Example:
 *   retryPersistenceIfNeeded(manager);
 */
async function retryPersistenceIfNeeded(manager) {
    if (!manager) {
        return true;
    }

    if (!manager._persistenceWarning) {
        return true;  // No pending persistence issues
    }

    const warning = manager._persistenceWarning;
    if (manager.logger) {
        manager.logger.log(`Retrying persistence for ${warning.type} (failed at ${new Date(warning.timestamp).toISOString()})...`, 'info');
    }

    try {
        if (warning.type === 'pendingProceeds' || warning.type === 'cacheFunds') {
            const success = typeof manager._persistCacheFunds === 'function' ? await manager._persistCacheFunds() : true;
            if (success && manager.logger) {
                manager.logger.log(`✓ Successfully retried cacheFunds persistence (was: ${warning.type})`, 'info');
            }
            return success;
        } else if (warning.type === 'btsFeesOwed') {
            const success = await manager._persistBtsFeesOwed();
            if (success && manager.logger) {
                manager.logger.log(`✓ Successfully retried btsFeesOwed persistence`, 'info');
            }
            return success;
        }
    } catch (e) {
        if (manager.logger) {
            manager.logger.log(`Error during persistence retry: ${e.message}`, 'error');
        }
        return false;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Grid comparisons
// ---------------------------------------------------------------------------
/**
 * Run grid comparisons after rotation to detect divergence.
 * Executes both simple cache ratio check and quadratic comparison.
 *
 * @param {Object} manager - The OrderManager instance
 * @param {Object} accountOrders - AccountOrders instance for loading persisted grid
 * @param {string} botKey - Bot key for grid retrieval
 */
async function runGridComparisons(manager, accountOrders, botKey) {
    if (!manager || !accountOrders) return;

    try {
        const Grid = require('./grid');
        const persistedGrid = accountOrders.loadBotGrid(botKey) || [];
        const calculatedGrid = Array.from(manager.orders.values());

        manager.logger?.log?.(
            `Starting grid comparisons: persistedGrid=${persistedGrid.length} orders, calculatedGrid=${calculatedGrid.length} orders, cacheFunds=buy:${manager.funds.cacheFunds.buy.toFixed(8)}/sell:${manager.funds.cacheFunds.sell.toFixed(8)}`,
            'debug'
        );

        // Step 1: Simple percentage-based check
        // Populates _gridSidesUpdated if cache ratio exceeds threshold
        const simpleCheckResult = Grid.checkAndUpdateGridIfNeeded(manager, manager.funds.cacheFunds);

        manager.logger?.log?.(
            `Simple check result: buyUpdated=${simpleCheckResult.buyUpdated}, sellUpdated=${simpleCheckResult.sellUpdated}`,
            'debug'
        );

        // Step 2: Quadratic comparison (if simple check didn't trigger)
        // Detects deeper structural divergence and also populates _gridSidesUpdated
        if (!simpleCheckResult.buyUpdated && !simpleCheckResult.sellUpdated) {
            const comparisonResult = Grid.compareGrids(calculatedGrid, persistedGrid, manager, manager.funds.cacheFunds);

            manager.logger?.log?.(
                `Quadratic comparison complete: buy=${comparisonResult.buy.metric.toFixed(6)}, sell=${comparisonResult.sell.metric.toFixed(6)}, buyUpdated=${comparisonResult.buy.updated}, sellUpdated=${comparisonResult.sell.updated}`,
                'debug'
            );

            if (comparisonResult.buy.metric > 0 || comparisonResult.sell.metric > 0) {
                manager.logger?.log?.(
                    `Grid divergence detected after rotation: buy=${comparisonResult.buy.metric.toFixed(6)}, sell=${comparisonResult.sell.metric.toFixed(6)}`,
                    'info'
                );
            }
        } else {
            manager.logger?.log?.(
                `Simple check triggered grid updates, skipping quadratic comparison`,
                'debug'
            );
        }
    } catch (err) {
        manager?.logger?.log?.(`Warning: Could not run grid comparisons after rotation: ${err.message}`, 'warn');
    }
}

// Grid divergence corrections
// ---------------------------------------------------------------------------
/**
 * Apply order corrections for sides marked by grid comparisons.
 * Marks orders on divergence-detected sides for size correction and executes batch update.
 *
 * @param {Object} manager - The OrderManager instance
 * @param {Object} accountOrders - AccountOrders instance for persistence
 * @param {string} botKey - Bot key for grid persistence
 * @param {Function} updateOrdersOnChainBatchFn - Callback function to execute batch updates (from bot/dexbot context)
 */
async function applyGridDivergenceCorrections(manager, accountOrders, botKey, updateOrdersOnChainBatchFn) {
    if (!manager._correctionsLock) {
        manager?.logger?.log?.(`Warning: corrections lock not available`, 'warn');
        return;
    }

    const { ORDER_STATES } = require('../constants');
    const Grid = require('./grid');

    // NOTE: Grid recalculation is already done by the caller (Grid.updateGridFromBlockchainSnapshot)
    // This function only applies the corrections on-chain, no need to recalculate again

    // Build array of orders needing correction from sides marked by grid comparisons
    // Use correction lock to protect all mutations AND the _gridSidesUpdated check (fixes TOCTOU)
    await manager._correctionsLock.acquire(async () => {
        // Early return check INSIDE lock to prevent TOCTOU race
        if (!manager._gridSidesUpdated || manager._gridSidesUpdated.length === 0) {
            return;
        }

        for (const orderType of manager._gridSidesUpdated) {
            const ordersOnSide = Array.from(manager.orders.values())
                .filter(o => o.type === orderType && o.orderId && o.state === ORDER_STATES.ACTIVE);

            for (const order of ordersOnSide) {
                // Mark for size correction (sizeChanged=true means we won't price-correct, just size)
                manager.ordersNeedingPriceCorrection.push({
                    gridOrder: { ...order },
                    chainOrderId: order.orderId,
                    rawChainOrder: null,
                    expectedPrice: order.price,
                    actualPrice: order.price,
                    expectedSize: order.size,
                    size: order.size,
                    type: order.type,
                    sizeChanged: true
                });
            }
        }

        if (manager.ordersNeedingPriceCorrection.length > 0) {
            manager.logger?.log?.(
                `DEBUG: Marked ${manager.ordersNeedingPriceCorrection.length} orders for size correction after grid divergence detection (sides: ${manager._gridSidesUpdated.join(', ')})`,
                'info'
            );

            // Log specific orders being corrected
            manager.ordersNeedingPriceCorrection.slice(0, 3).forEach(corr => {
                manager.logger?.log?.(
                    `  Correcting: ${corr.chainOrderId} | current size: ${corr.size.toFixed(8)} | price: ${corr.expectedPrice.toFixed(4)}`,
                    'debug'
                );
            });

            // Build rotation objects for size corrections
            const ordersToRotate = manager.ordersNeedingPriceCorrection.map(correction => ({
                oldOrder: { orderId: correction.chainOrderId },
                newPrice: correction.expectedPrice,
                newSize: correction.size,
                type: correction.type
            }));

            // Execute a batch correction for these marked orders
            try {
                const result = await updateOrdersOnChainBatchFn({
                    ordersToPlace: [],
                    ordersToRotate: ordersToRotate,
                    partialMoves: []
                });

                // Clear corrections after applying
                manager.ordersNeedingPriceCorrection = [];

                // CRITICAL: Only clear flags if operations were actually executed
                // If all operations were rejected (result.executed === false), keep flags
                // so the grid can be re-persisted without the phantom update
                if (result && result.executed) {
                    manager._gridSidesUpdated = [];
                    // Re-persist grid after corrections are applied to keep persisted state in sync
                    persistGridSnapshot(manager, accountOrders, botKey);
                } else {
                    manager.logger?.log?.(
                        `All divergence corrections were rejected (precision tolerance). Clearing flags to prevent loop.`,
                        'info'
                    );
                    // Clear flags anyway to prevent infinite loop, but don't persist
                    // The grid state in memory is correct, blockchain just doesn't need updating
                    manager._gridSidesUpdated = [];
                }
            } catch (err) {
                // CRITICAL: Clear corrections AND flags on error to prevent list explosion
                // Without this, failed corrections accumulate and never get retried
                manager.ordersNeedingPriceCorrection = [];
                manager._gridSidesUpdated = [];
                manager?.logger?.log?.(`Warning: Could not execute grid divergence corrections: ${err.message}`, 'warn');
            }
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 8: ORDER UTILITIES
// ════════════════════════════════════════════════════════════════════════════════
// Build and manipulate order objects

/**
 * Build create order arguments from an order object and asset information.
 * Handles both SELL and BUY orders, calculating appropriate amounts based on order type.
 *
 * PRECISION FIX: Quantizes order size to blockchain precision BEFORE placement.
 * This ensures no off-by-one errors between calculated size and blockchain storage.
 *
 * @param {Object} order - Order object with type, size, and price
 * @param {Object} assetA - Base asset object with id property
 * @param {Object} assetB - Quote asset object with id property
 * @returns {Object} - { amountToSell, sellAssetId, minToReceive, receiveAssetId }
 */
function buildCreateOrderArgs(order, assetA, assetB) {
    // CRITICAL: Quantize order size to blockchain precision BEFORE placing
    // This ensures no off-by-one errors between calculated size and blockchain storage
    const precision = (order.type === 'sell')
        ? (assetA?.precision ?? 8)
        : (assetB?.precision ?? 8);

    // Convert to blockchain int and back to ensure exact precision match
    const quantizedSize = blockchainToFloat(floatToBlockchainInt(order.size, precision), precision);

    let amountToSell, sellAssetId, minToReceive, receiveAssetId;
    if (order.type === 'sell') {
        amountToSell = quantizedSize;
        sellAssetId = assetA.id;
        minToReceive = quantizedSize * order.price;
        receiveAssetId = assetB.id;
    } else {
        amountToSell = quantizedSize;
        sellAssetId = assetB.id;
        minToReceive = quantizedSize / order.price;
        receiveAssetId = assetA.id;
    }
    return { amountToSell, sellAssetId, minToReceive, receiveAssetId };
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10: FILTERING & ANALYSIS (PART 1 - Numeric Validation)
// ════════════════════════════════════════════════════════════════════════════════
// Validate and convert numeric values

/**
 * Compare two sizes at blockchain integer precision.
 * @param {number} size1 - First size
 * @param {number} size2 - Second size
 * @param {number} precision - Blockchain precision
 * @returns {number} -1 if size1 < size2, 0 if equal, 1 if size1 > size2
 */
function compareBlockchainSizes(size1, size2, precision) {
    const int1 = floatToBlockchainInt(size1, precision);
    const int2 = floatToBlockchainInt(size2, precision);
    if (int1 === int2) return 0;
    return int1 > int2 ? 1 : -1;
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 10: FILTERING & ANALYSIS (PART 2 - Order Filtering)
// ════════════════════════════════════════════════════════════════════════════════
// Filter, count, and analyze orders

/**
 * Filter orders by type.
 * @param {Array<Object>} orders - Orders to filter
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @returns {Array<Object>} Filtered orders
 */
function filterOrdersByType(orders, orderType) {
    return Array.isArray(orders) ? orders.filter(o => o && o.type === orderType) : [];
}

/**
 * Filter orders by type and exclude a specific state.
 * @param {Array<Object>} orders - Orders to filter
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {string|null} excludeState - State to exclude (optional)
 * @returns {Array<Object>} Filtered orders
 */
function filterOrdersByTypeAndState(orders, orderType, excludeState = null) {
    return Array.isArray(orders) ? orders.filter(o => o && o.type === orderType && (!excludeState || o.state !== excludeState)) : [];
}

/**
 * Sum all sizes in an array of orders.
 * @param {Array<Object>} orders - Orders with size property
 * @returns {number} Total of all sizes
 */
function sumOrderSizes(orders) {
    return Array.isArray(orders) ? orders.reduce((sum, o) => sum + toFiniteNumber(o.size), 0) : 0;
}

/**
 * Extract sizes from orders as an array of numbers.
 * @param {Array<Object>} orders - Orders with size property
 * @returns {Array<number>} Sizes as numbers
 */
function mapOrderSizes(orders) {
    return Array.isArray(orders) ? orders.map(o => Number(o.size || 0)) : [];
}

/**
 * Count active and partial orders by type (used for target comparison).
 * Includes both ACTIVE and PARTIAL orders since both take up grid positions.
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {Map} ordersMap - The orders map from OrderManager
 * @returns {number} Count of ACTIVE + PARTIAL orders of the given type
 */
function countOrdersByType(orderType, ordersMap) {
    if (!ordersMap?.size) return 0;

    const oppositeType = orderType === ORDER_TYPES.BUY ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
    let hasOppositeWithPendingRotation = false;
    const candidates = [];

    for (const order of ordersMap.values()) {
        if (order.type === oppositeType && order.pendingRotation) {
            hasOppositeWithPendingRotation = true;
        }
        if (order.type === orderType) {
            candidates.push(order);
        }
    }

    return candidates.reduce((count, order) => {
        const isActive = [ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL].includes(order.state);
        const isEffectiveActive = hasOppositeWithPendingRotation && order.state === ORDER_STATES.VIRTUAL;
        return count + (isActive || isEffectiveActive ? 1 : 0);
    }, 0);
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2: BLOCKCHAIN CONVERSIONS & PRECISION (PART 2 - Precision Helpers)
// ════════════════════════════════════════════════════════════════════════════════
// Get precision for orders and assets

/**
 * Get blockchain precision for an order type.
 * SELL orders use assetA precision, BUY orders use assetB precision.
 * @param {Object} assets - Assets object with assetA and assetB precision
 * @param {string} orderType - ORDER_TYPES.SELL or ORDER_TYPES.BUY
 * @returns {number} Precision (defaults to 8)
 */
function getPrecisionByOrderType(assets, orderType) {
    const { ORDER_TYPES } = require('../constants');
    return orderType === ORDER_TYPES.SELL
        ? (assets?.assetA?.precision ?? 8)
        : (assets?.assetB?.precision ?? 8);
}

/**
 * Get blockchain precision for a side string.
 * @param {Object} assets - Assets object with assetA and assetB precision
 * @param {string} side - 'buy' or 'sell'
 * @returns {number} Precision (defaults to 8)
 */
function getPrecisionForSide(assets, side) {
    return side === 'buy'
        ? (assets?.assetB?.precision ?? 8)
        : (assets?.assetA?.precision ?? 8);
}

/**
 * Get both asset precisions at once.
 * @param {Object} assets - Assets object with assetA and assetB precision
 * @returns {Object} { A: precisionA, B: precisionB }
 */
function getPrecisionsForManager(assets) {
    return {
        A: assets?.assetA?.precision ?? 8,
        B: assets?.assetB?.precision ?? 8
    };
}

/**
 * Check if trading pair includes BTS as one of the assets.
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol
 * @returns {boolean} True if either asset is BTS
 */
function hasBtsPair(assetA, assetB) {
    return assetA === 'BTS' || assetB === 'BTS';
}

/**
 * Check if any order sizes fall below a minimum threshold.
 * Uses precision-aware integer comparison when available.
 * @param {Array<number>} sizes - Order sizes to check
 * @param {number} minSize - Minimum allowed size
 * @param {number|null} precision - Blockchain precision for integer comparison
 * @returns {boolean} True if any size is below minimum
 */
/**
 * Generic threshold check helper for order sizes.
 * @param {Array<number>} sizes - Order sizes to check
 * @param {number} threshold - Threshold size to compare against
 * @param {number|null} precision - Blockchain precision for integer comparison
 * @param {boolean} includeNonFinite - If true, non-finite sizes count as below threshold
 * @returns {boolean} True if any size is below/fails the threshold
 */
function checkSizeThreshold(sizes, threshold, precision, includeNonFinite = false) {
    if (threshold <= 0 || !Array.isArray(sizes) || sizes.length === 0) return false;

    const checkSize = (sz) => {
        if (!Number.isFinite(sz)) return includeNonFinite;
        if (sz <= 0) return false; // 0 or negative is accepted (not tradable yet or intentionally 0)

        if (precision !== undefined && precision !== null && Number.isFinite(precision)) {
            return floatToBlockchainInt(sz, precision) < floatToBlockchainInt(threshold, precision);
        }
        return sz < (threshold - 1e-8);
    };

    return sizes.some(checkSize);
}

function checkSizesBeforeMinimum(sizes, minSize, precision) {
    return checkSizeThreshold(sizes, minSize, precision, true);
}

/**
 * Check if any order sizes fall near a warning threshold.
 * Uses precision-aware integer comparison when available.
 * @param {Array<number>} sizes - Order sizes to check
 * @param {number} warningSize - Warning threshold size
 * @param {number|null} precision - Blockchain precision for integer comparison
 * @returns {boolean} True if any size is near/below warning threshold
 */
function checkSizesNearMinimum(sizes, warningSize, precision) {
    return checkSizeThreshold(sizes, warningSize, precision, false);
}

/**
 * Calculate BTS fees needed for creating target orders (with FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER buffer for rotations).
 * Returns 0 if pair doesn't include BTS, or FEE_PARAMETERS.BTS_FALLBACK_FEE as fallback if calculation fails.
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol
 * @param {number} totalOrders - Total number of orders to create
 * @param {number} feeMultiplier - Multiplier for fees (default: FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER for creation + rotation buffer)
 * @returns {number} Total BTS fees to reserve
 */
function calculateOrderCreationFees(assetA, assetB, totalOrders, feeMultiplier = FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER) {
    if (assetA !== 'BTS' && assetB !== 'BTS') return 0;

    try {
        if (totalOrders > 0) {
            const btsFeeData = getAssetFees('BTS', 1);
            return btsFeeData.createFee * totalOrders * feeMultiplier;
        }
    } catch (err) {
        // Return fallback
        return FEE_PARAMETERS.BTS_FALLBACK_FEE;
    }

    return 0;
}

/**
 * Apply order creation fee deduction to input funds for the appropriate side.
 * Returns adjusted funds after fee reservation with logging.
 * @param {number} buyFunds - Original buy-side funds
 * @param {number} sellFunds - Original sell-side funds
 * @param {number} fees - Total fees to deduct
 * @param {Object} config - Config object with assetA, assetB
 * @param {Object} logger - Logger instance (optional)
 * @returns {Object} { buyFunds, sellFunds } - Adjusted funds after fees
 */
function deductOrderFeesFromFunds(buyFunds, sellFunds, fees, config, logger = null) {
    let finalBuy = buyFunds;
    let finalSell = sellFunds;

    if (fees > 0) {
        if (config?.assetB === 'BTS') {
            finalBuy = Math.max(0, buyFunds - fees);
            if (logger?.log) {
                logger.log(
                    `Reduced available BTS (buy) funds by ${fees.toFixed(8)} for order creation fees: ${buyFunds.toFixed(8)} -> ${finalBuy.toFixed(8)}`,
                    'info'
                );
            }
        } else if (config?.assetA === 'BTS') {
            finalSell = Math.max(0, sellFunds - fees);
            if (logger?.log) {
                logger.log(
                    `Reduced available BTS (sell) funds by ${fees.toFixed(8)} for order creation fees: ${sellFunds.toFixed(8)} -> ${finalSell.toFixed(8)}`,
                    'info'
                );
            }
        }
    }

    return { buyFunds: finalBuy, sellFunds: finalSell };
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 9: ORDER SIZING & ALLOCATION
// ════════════════════════════════════════════════════════════════════════════════
// Calculate order sizes based on funds and grid parameters (moved from grid.js)

/**
 * Allocate funds across n orders using geometric weighting.
 * Creates exponentially-scaled order sizes based on position and weight distribution.
 *
 * @param {number} totalFunds - Total funds to distribute
 * @param {number} n - Number of orders
 * @param {number} weight - Weight distribution (-1 to 2): controls exponential scaling
 * @param {number} incrementFactor - Increment percentage / 100 (e.g., 0.01 for 1%)
 * @param {boolean} reverse - If true, reverse position indexing (for sell orders high→low)
 * @param {number} minSize - Minimum order size
 * @param {number|null} precision - Blockchain precision for quantization
 * @returns {Array<number>} Array of order sizes
 */
function allocateFundsByWeights(totalFunds, n, weight, incrementFactor, reverse = false, minSize = 0, precision = null) {
    if (n <= 0) return [];
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    if (!Number.isFinite(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
        throw new Error(`Invalid weight distribution: ${weight}. Must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
    }

    // CRITICAL: Validate increment factor (0.01 to 0.10 for 1% to 10%)
    // If incrementFactor is 0, base = 1, and all orders get equal weight (loses position weighting)
    // If incrementFactor >= 1, base <= 0, causing invalid exponential calculation
    if (incrementFactor <= 0 || incrementFactor >= 1) {
        throw new Error(`Invalid incrementFactor: ${incrementFactor}. Must be between ${INCREMENT_BOUNDS.MIN_FACTOR} (${INCREMENT_BOUNDS.MIN_PERCENT}%) and ${INCREMENT_BOUNDS.MAX_FACTOR} (${INCREMENT_BOUNDS.MAX_PERCENT}%).`);
    }

    // Step 1: Calculate base factor from increment
    // base = (1 - increment) creates exponential decay/growth
    // e.g., 1% increment → base = 0.99
    const base = 1 - incrementFactor;

    // Step 2: Calculate raw weights for each order position
    // The formula: weight[i] = base^(idx * weight)
    // - base^0 = 1.0 (first position always gets base weight)
    // - base^(idx*weight) scales exponentially based on position and weight coefficient
    // - reverse parameter inverts the position index so sell orders decrease geometrically
    const rawWeights = new Array(n);
    for (let i = 0; i < n; i++) {
        const idx = reverse ? (n - 1 - i) : i;
        rawWeights[i] = Math.pow(base, idx * weight);
    }

    // Step 3: Normalize weights to sum to 1, then scale by totalFunds
    // This ensures all funds are distributed and ratios are preserved
    const sizes = new Array(n).fill(0);
    const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;

    if (precision !== null && precision !== undefined) {
        // Quantitative allocation: use units to avoid floating point noise from the start
        // This ensures every order in the grid is perfectly aligned with blockchain increments.
        const totalUnits = floatToBlockchainInt(totalFunds, precision);
        let unitsSummary = 0;
        const units = new Array(n);

        for (let i = 0; i < n; i++) {
            units[i] = Math.round((rawWeights[i] / totalWeight) * totalUnits);
            unitsSummary += units[i];
        }

        // Adjust for rounding discrepancy in units calculation (usually +/- 1 unit)
        const diff = totalUnits - unitsSummary;
        if (diff !== 0 && n > 0) {
            let largestIdx = 0;
            for (let j = 1; j < n; j++) if (units[j] > units[largestIdx]) largestIdx = j;
            units[largestIdx] = Math.max(0, units[largestIdx] + diff);
        }
        for (let i = 0; i < n; i++) {
            sizes[i] = blockchainToFloat(units[i], precision);
        }
    } else {
        // Fallback for cases without precision (not recommended for grid orders)
        for (let i = 0; i < n; i++) {
            sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
        }
    }

    return sizes;
}

/**
 * Size orders based on config weight distribution and available funds.
 * Applies sizes proportionally to sell and buy order lists.
 *
 * @param {Array<Object>} orders - Order array with type property
 * @param {Object} config - Config with incrementPercent and weightDistribution
 * @param {number} sellFunds - Available sell-side funds
 * @param {number} buyFunds - Available buy-side funds
 * @param {number} minSellSize - Minimum sell order size
 * @param {number} minBuySize - Minimum buy order size
 * @param {number|null} precisionA - Asset A precision for quantization
 * @param {number|null} precisionB - Asset B precision for quantization
 * @returns {Array<Object>} Orders with assigned sizes
 */
function calculateOrderSizes(orders, config, sellFunds, buyFunds, minSellSize = 0, minBuySize = 0, precisionA = null, precisionB = null) {
    const { ORDER_TYPES } = require('../constants');
    const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
    const incrementFactor = incrementPercent / 100;

    const sellOrders = filterOrdersByType(orders, ORDER_TYPES.SELL);
    const buyOrders = filterOrdersByType(orders, ORDER_TYPES.BUY);

    const sellSizes = allocateFundsByWeights(sellFunds, sellOrders.length, sellWeight, incrementFactor, true, minSellSize, precisionA);
    const buySizes = allocateFundsByWeights(buyFunds, buyOrders.length, buyWeight, incrementFactor, false, minBuySize, precisionB);

    const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
    return orders.map(order => ({
        ...order,
        size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
    }));
}

/**
 * Calculate order sizes for rotation cycles based on available and grid funds.
 *
 * @param {number} availableFunds - Available funds for new orders
 * @param {number} totalGridAllocation - Total currently allocated to grid
 * @param {number} orderCount - Number of orders to size
 * @param {string} orderType - ORDER_TYPES.SELL or ORDER_TYPES.BUY
 * @param {Object} config - Config with incrementPercent and weightDistribution
 * @param {number} minSize - Minimum order size
 * @param {number|null} precision - Blockchain precision for quantization
 * @returns {Array<number>} Order sizes for rotation
 */
function calculateRotationOrderSizes(availableFunds, totalGridAllocation, orderCount, orderType, config, minSize = 0, precision = null) {
    const { ORDER_TYPES } = require('../constants');

    if (orderCount <= 0) {
        return [];
    }

    // Combine available + grid allocation to calculate total sizing context
    // This represents the "full reset" amount if we were regenerating the entire grid
    const totalFunds = availableFunds + totalGridAllocation;

    if (!Number.isFinite(totalFunds) || totalFunds <= 0) {
        return new Array(orderCount).fill(0);
    }

    const { incrementPercent, weightDistribution } = config;
    const incrementFactor = incrementPercent / 100;

    // Select weight distribution based on side (buy or sell)
    const weight = (orderType === ORDER_TYPES.SELL) ? weightDistribution.sell : weightDistribution.buy;

    // Reverse the allocation for sell orders so they're ordered from high to low price
    const reverse = (orderType === ORDER_TYPES.SELL);

    // Allocate total funds using geometric weighting
    return allocateFundsByWeights(totalFunds, orderCount, weight, incrementFactor, reverse, minSize, precision);
}

/**
 * Calculate RMS divergence metric between calculated and persisted grid sides.
 * Matches orders by ID and compares sizes; unmatched orders treated as max divergence.
 *
 * @param {Array<Object>} calculatedOrders - Orders generated by grid algorithm
 * @param {Array<Object>} persistedOrders - Orders persisted in storage
 * @param {string} sideName - Side name for logging ('buy', 'sell')
 * @returns {number} RMS metric (0 = perfect match, higher = more divergence)
 */
function calculateGridSideDivergenceMetric(calculatedOrders, persistedOrders, sideName = 'unknown') {
    if (!Array.isArray(calculatedOrders) || !Array.isArray(persistedOrders)) return 0;
    if (calculatedOrders.length === 0 && persistedOrders.length === 0) return 0;

    const persistedMap = new Map(persistedOrders.filter(o => o.id).map(o => [o.id, o]));
    let sumSquaredDiff = 0;
    let matchCount = 0;
    let unmatchedCount = 0;
    const largeDeviations = [];

    const trackDeviation = (id, persSize, calcSize, diff, type = 'Unmatched') => {
        largeDeviations.push({ id, persSize, calcSize, percentDiff: diff });
        sumSquaredDiff += 1.0;
        matchCount++; // For RMS calculation consistency
    };

    for (const calcOrder of calculatedOrders) {
        const persOrder = persistedMap.get(calcOrder.id);
        if (persOrder) {
            const calcSize = toFiniteNumber(calcOrder.size);
            const comparisonTarget = toFiniteNumber(persOrder.size) + (persOrder.isDoubleOrder ? toFiniteNumber(persOrder.mergedDustSize) : 0);

            if (comparisonTarget > 0) {
                const relativeDiff = (calcSize - comparisonTarget) / comparisonTarget;
                const relativePercent = Math.abs(relativeDiff) * 100;
                if (relativePercent > 10) {
                    largeDeviations.push({ id: calcOrder.id, persSize: comparisonTarget.toFixed(8), calcSize: calcSize.toFixed(8), percentDiff: relativePercent.toFixed(2) });
                }
                sumSquaredDiff += relativeDiff * relativeDiff;
                matchCount++;
            } else if (calcSize > 0) {
                trackDeviation(calcOrder.id, '0.00000000', calcSize.toFixed(8), 'Infinity');
            } else {
                matchCount++;
            }
        } else {
            trackDeviation(calcOrder.id, 'NOT_FOUND', toFiniteNumber(calcOrder.size).toFixed(8), 'Unmatched');
            unmatchedCount++;
        }
    }

    // Check for missing orders
    for (const persOrder of persistedOrders) {
        if (!calculatedOrders.some(c => c.id === persOrder.id)) {
            trackDeviation(persOrder.id, toFiniteNumber(persOrder.size).toFixed(8), 'NOT_FOUND', 'Unmatched');
            unmatchedCount++;
        }
    }

    const totalOrders = matchCount + unmatchedCount;
    const metric = totalOrders > 0 ? Math.sqrt(sumSquaredDiff / totalOrders) : 0;
    const rmsThreshold = (GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE || 14.3) / 100;

    if (metric > rmsThreshold) {
        console.debug(`\nDEBUG [${sideName}] Divergence Breakdown: RMS=${(metric * 100).toFixed(2)}% (Threshold: ${(rmsThreshold * 100).toFixed(1)}%) Matches: ${matchCount} Unmatched: ${unmatchedCount}`);
        if (largeDeviations.length) console.debug(`  Large deviations (>10%): ${largeDeviations.length}`);
    }

    return metric;
}

/**
 * Map blockchain update flags to order type string.
 *
 * @param {boolean} buyUpdated - Buy side was updated
 * @param {boolean} sellUpdated - Sell side was updated
 * @returns {string} 'buy', 'sell', or 'both'
 */
function getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated) {
    return (buyUpdated && sellUpdated) ? 'both' : (buyUpdated ? 'buy' : 'sell');
}

/**
 * Resolve a configured price bound (absolute or relative).
 * Used during grid initialization to parse min/max price bounds.
 *
 * @param {*} value - Raw config value (string, number, or expression)
 * @param {number} fallback - Fallback value if resolution fails
 * @param {number} startPrice - Market price for relative calculations
 * @param {string} mode - Relative resolution mode ('absolute', 'percentage', 'multiplier')
 * @returns {number} Resolved price bound
 */
function resolveConfiguredPriceBound(value, fallback, startPrice, mode) {
    const relative = resolveRelativePrice(value, startPrice, mode);
    if (Number.isFinite(relative)) return relative;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Format a numeric value to 8 decimal places (standard BTS precision).
 * Used for logging and display purposes.
 *
 * @param {number} value - Value to format
 * @returns {string} Value formatted to 8 decimals
 */
function formatOrderSize(value) {
    return (Number(value) || 0).toFixed(8);
}

/**
 * Convert a filled order to a SPREAD placeholder.
 * Sets type to SPREAD, state to VIRTUAL, size to 0, and clears orderId.
 *
 * @param {Object} order - Order object to convert
 * @returns {Object} Updated order object with SPREAD placeholder values
 */
function convertToSpreadPlaceholder(order) {
    return { ...order, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null };
}

/**
 * Check if account totals have valid buy and sell free amounts.
 * Used for validation before using accountTotals in calculations.
 *
 * @param {Object} accountTotals - Account totals object with buyFree/sellFree
 * @param {boolean} checkFree - If true, check buyFree/sellFree; if false, check buy/sell
 * @returns {boolean} True if both values are valid numbers, false otherwise
 */
function hasValidAccountTotals(accountTotals, checkFree = true) {
    if (!accountTotals) return false;
    const buyKey = checkFree ? 'buyFree' : 'buy';
    const sellKey = checkFree ? 'sellFree' : 'sell';
    return isValidNumber(accountTotals[buyKey]) && isValidNumber(accountTotals[sellKey]);
}
        
        /**
         * Determine if the spread is too wide and should be flagged for rebalancing. * Pure calculation: checks if spread exceeds threshold AND both sides have orders.
 *
 * @param {number} currentSpread - Current spread percentage
 * @param {number} targetSpread - Target spread threshold
 * @param {number} buyCount - Number of BUY orders
 * @param {number} sellCount - Number of SELL orders
 * @returns {boolean} True if spread is too wide and should be flagged
 */
function shouldFlagOutOfSpread(currentSpread, targetSpread, buyCount, sellCount) {
    const hasBothSides = buyCount > 0 && sellCount > 0;
    return hasBothSides && currentSpread > targetSpread;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    // Parsing
    isPercentageString,
    parsePercentageString,
    isRelativeMultiplierString,
    parseRelativeMultiplierString,
    resolveRelativePrice,

    // Fund calculations
    computeChainFundTotals,
    calculateAvailableFundsValue,
    calculateSpreadFromOrders,
    resolveConfigValue,

    // Conversions
    blockchainToFloat,
    floatToBlockchainInt,

    // Tolerance & checks
    calculatePriceTolerance,
    checkPriceWithinTolerance,
    validateOrderAmountsWithinLimits,

    // Parsing + matching
    parseChainOrder,
    findBestMatchByPrice,
    findMatchingGridOrderByOpenOrder,

    // Reconciliation
    applyChainSizeToGridOrder,
    correctOrderPriceOnChain,
    correctAllPriceMismatches,
    getMinOrderSize,

    // Price derivation
    lookupAsset,
    deriveMarketPrice,
    derivePoolPrice,
    derivePrice,

    // Fee caching and retrieval
    initializeFeeCache,
    getCachedFees,
    getAssetFees,

    // Persistence
    persistGridSnapshot,
    retryPersistenceIfNeeded,

    // Grid comparisons
    runGridComparisons,
    applyGridDivergenceCorrections,

    // Order building
    buildCreateOrderArgs,

    // Numeric validation helpers
    toFiniteNumber,
    isValidNumber,
    compareBlockchainSizes,

    // Order filtering helpers
    filterOrdersByType,
    filterOrdersByTypeAndState,
    sumOrderSizes,
    mapOrderSizes,
    countOrdersByType,

    // Precision helpers
    getPrecisionByOrderType,
    getPrecisionForSide,
    getPrecisionsForManager,

    // Pair detection
    hasBtsPair,

    // Size validation helpers
    checkSizesBeforeMinimum,
    checkSizesNearMinimum,

    // Fee helpers
    calculateOrderCreationFees,
    deductOrderFeesFromFunds,

    // Grid sizing & allocation (moved from grid.js)
    allocateFundsByWeights,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateGridSideDivergenceMetric,
    getOrderTypeFromUpdatedFlags,
    resolveConfiguredPriceBound,

    // Formatting
    formatOrderSize,
    convertToSpreadPlaceholder,

    // Validation helpers
    hasValidAccountTotals,
    shouldFlagOutOfSpread
};
