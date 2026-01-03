/**
 * modules/order/strategy.js
 *
 * Specialized engine for grid rebalancing and rotation strategies.
 * Implements Anchor & Refill, Multi-Partial Consolidation, and Geometric Rotations.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, FEE_PARAMETERS, PRECISION_DEFAULTS } = require('../constants');
const {
    countOrdersByType,
    getPrecisionForSide,
    getCacheFundsValue,
    formatOrderSize,
    convertToSpreadPlaceholder,
    calculateAvailableFundsValue,
    getMinOrderSize,
    getAssetFees,
    floatToBlockchainInt,
    blockchainToFloat,
    calculateRotationOrderSizes
} = require('./utils');

class StrategyEngine {
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Process filled orders and trigger rebalancing.
     * @param {Array} filledOrders - Array of filled order objects
     * @param {Set} excludeOrderIds - Order IDs to skip during processing
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;

        // Validate inputs
        if (!mgr) throw new Error('manager required for processFilledOrders');
        if (!Array.isArray(filledOrders)) {
            mgr.logger.log(`Error: filledOrders must be an array, got ${typeof filledOrders}`, 'error');
            return;
        }
        if (!mgr.config) {
            mgr.logger.log('Error: manager.config is undefined', 'error');
            return;
        }

        mgr.logger.log(`>>> processFilledOrders() called with ${filledOrders.length} filled orders`, 'info');

        mgr.pauseFundRecalc();
        try {
            const filledCounts = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };
            const partialFillCount = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };

            let proceedsBuy = 0;
            let proceedsSell = 0;
            let deltaBuyFree = 0;
            let deltaSellFree = 0;
            let deltaBuyTotal = 0;
            let deltaSellTotal = 0;

            const hasBtsPair = (mgr.config?.assetA === 'BTS' || mgr.config?.assetB === 'BTS');

            for (const filledOrder of filledOrders) {
                // Validate order object
                if (!filledOrder || typeof filledOrder !== 'object') {
                    mgr.logger.log(`Warning: Skipping invalid filled order`, 'warn');
                    continue;
                }
                if (excludeOrderIds?.has?.(filledOrder.id)) {
                    mgr.logger.log(`Skipping excluded order ${filledOrder.id}`, 'debug');
                    continue;
                }
                if (!filledOrder.type || !filledOrder.size) {
                    mgr.logger.log(`Warning: Skipping order ${filledOrder.id} - missing type or size`, 'warn');
                    continue;
                }
                const isPartial = filledOrder.isPartial === true;
                if (isPartial) {
                    partialFillCount[filledOrder.type]++;
                    if (filledOrder.isDelayedRotationTrigger) {
                        filledCounts[filledOrder.type]++;
                        mgr.logger.log(`Delayed rotation trigger detected for ${filledOrder.type} order ${filledOrder.id}`, 'debug');
                    }
                } else {
                    filledCounts[filledOrder.type]++;
                }

                if (filledOrder.type === ORDER_TYPES.SELL) {
                    const rawProceeds = filledOrder.size * filledOrder.price;
                    let netProceeds = rawProceeds;
                    let feeInfo = '';
                    if (mgr.config.assetB !== 'BTS') {
                        try {
                            const feeResult = getAssetFees(mgr.config.assetB, rawProceeds);
                            netProceeds = typeof feeResult === 'number' ? feeResult : rawProceeds;
                            if (netProceeds !== rawProceeds) feeInfo = ` (net after market fee: ${netProceeds.toFixed(8)})`;
                        } catch (e) {
                            mgr.logger.log(`WARNING: Could not get fees for ${mgr.config.assetB}: ${e.message}`, 'warn');
                        }
                    }
                    proceedsBuy += netProceeds;
                    deltaBuyFree += netProceeds;
                    deltaBuyTotal += netProceeds;
                    deltaSellTotal -= filledOrder.size;
                    mgr.logger.log(`Sell filled: +${rawProceeds.toFixed(8)} ${mgr.config.assetB || 'quote'}${feeInfo}, -${filledOrder.size.toFixed(8)} ${mgr.config.assetA || 'base'} committed`, 'info');
                } else {
                    const rawProceeds = filledOrder.size / filledOrder.price;
                    let netProceeds = rawProceeds;
                    let feeInfo = '';
                    if (mgr.config.assetA !== 'BTS') {
                        try {
                            const feeResult = getAssetFees(mgr.config.assetA, rawProceeds);
                            netProceeds = typeof feeResult === 'number' ? feeResult : rawProceeds;
                            if (netProceeds !== rawProceeds) feeInfo = ` (net after market fee: ${netProceeds.toFixed(8)})`;
                        } catch (e) {
                            mgr.logger.log(`WARNING: Could not get fees for ${mgr.config.assetA}: ${e.message}`, 'warn');
                        }
                    }
                    proceedsSell += netProceeds;
                    deltaSellFree += netProceeds;
                    deltaSellTotal += netProceeds;
                    deltaBuyTotal -= filledOrder.size;
                    mgr.logger.log(`Buy filled: +${rawProceeds.toFixed(8)} ${mgr.config.assetA || 'base'}${feeInfo}, -${filledOrder.size.toFixed(8)} ${mgr.config.assetB || 'quote'} committed`, 'info');
                }

                if (!isPartial) {
                    const updatedOrder = convertToSpreadPlaceholder(filledOrder);
                    mgr._updateOrder(updatedOrder);
                    mgr.currentSpreadCount++;
                    mgr.logger.log(`Converted order ${filledOrder.id} to SPREAD`, 'debug');
                } else {
                    mgr.logger.log(`Partial fill processed: order ${filledOrder.id} remains active with ${formatOrderSize(filledOrder.size)} filled`, 'debug');
                }
            }

            if (hasBtsPair && filledOrders.length > 0) {
                try {
                    const btsFeeData = getAssetFees('BTS', 0);
                    const fullFillCount = filledCounts[ORDER_TYPES.BUY] + filledCounts[ORDER_TYPES.SELL];
                    mgr.funds.btsFeesOwed += fullFillCount * btsFeeData.total;
                } catch (err) {
                    mgr.logger?.log?.(`Warning: Could not calculate BTS fees: ${err.message}`, 'warn');
                    mgr.funds.btsFeesOwed += FEE_PARAMETERS.BTS_FALLBACK_FEE;
                }
            }

            if (!mgr.accountTotals) mgr.accountTotals = { buy: 0, sell: 0, buyFree: 0, sellFree: 0 };
            const bumpTotal = (key, delta) => {
                const next = (Number(mgr.accountTotals[key]) || 0) + delta;
                mgr.accountTotals[key] = next < 0 ? 0 : next;
            };
            bumpTotal('buyFree', deltaBuyFree);
            bumpTotal('sellFree', deltaSellFree);
            bumpTotal('buy', deltaBuyTotal);
            bumpTotal('sell', deltaSellTotal);

            mgr.funds.cacheFunds.buy = (mgr.funds.cacheFunds.buy || 0) + proceedsBuy;
            mgr.funds.cacheFunds.sell = (mgr.funds.cacheFunds.sell || 0) + proceedsSell;

            // CRITICAL: Settle all pending BTS fees immediately after fills
            // This ensures chainFree reflects true available balance when BTS is the trading asset
            if (hasBtsPair && mgr.funds.btsFeesOwed > 0) await mgr.accountant.deductBtsFees();

            mgr.recalculateFunds();
            await mgr._persistCacheFunds();
            if (mgr.funds.btsFeesOwed > 0) await mgr._persistBtsFeesOwed();

            const hasFullFills = filledCounts[ORDER_TYPES.BUY] > 0 || filledCounts[ORDER_TYPES.SELL] > 0;
            if (!hasFullFills && (partialFillCount[ORDER_TYPES.BUY] > 0 || partialFillCount[ORDER_TYPES.SELL] > 0)) {
                mgr.logger.log(`Only partial fills detected (no rotations needed).`, 'info');
                return { ordersToPlace: [], ordersToRotate: [], partialMoves: [], ordersToUpdate: [] };
            }

            if (!excludeOrderIds) excludeOrderIds = new Set();
            for (const f of filledOrders) {
                if (f.orderId) excludeOrderIds.add(f.orderId);
                if (f.id) excludeOrderIds.add(f.id);
            }

            const newOrders = await this.rebalanceOrders(filledCounts, 0, excludeOrderIds);

            if (hasBtsPair && newOrders.partialMoves && newOrders.partialMoves.length > 0) {
                try {
                    const btsFeeData = getAssetFees('BTS', 0);
                    mgr.funds.btsFeesOwed += btsFeeData.updateFee * newOrders.partialMoves.length;
                } catch (err) {
                    mgr.funds.btsFeesOwed += FEE_PARAMETERS.BTS_FALLBACK_FEE;
                }
            }

            mgr.recalculateFunds();
            await mgr._persistCacheFunds();

            // Log funding state after fill processing
            mgr.logger.logFundsStatus(mgr, `AFTER processFilledOrders (${filledOrders.length} fills)`);

            return newOrders;
        } finally {
            mgr.resumeFundRecalc();
        }
    }

    /**
     * Rebalance orders after fills using count-based creation vs rotation strategy.
     */
    async rebalanceOrders(filledCounts, extraOrderCount = 0, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        const ordersToPlace = [];
        const ordersToRotate = [];
        const partialMoves = [];
        const ordersToUpdate = [];

        if (filledCounts[ORDER_TYPES.SELL] > 0) {
            const result = await this.rebalanceSideAfterFill(
                ORDER_TYPES.SELL, ORDER_TYPES.BUY,
                filledCounts[ORDER_TYPES.SELL], extraOrderCount, excludeOrderIds
            );
            ordersToPlace.push(...result.ordersToPlace);
            ordersToRotate.push(...result.ordersToRotate);
            partialMoves.push(...result.partialMoves);
            if (result.ordersToUpdate) ordersToUpdate.push(...result.ordersToUpdate);
        }

        if (filledCounts[ORDER_TYPES.BUY] > 0) {
            const result = await this.rebalanceSideAfterFill(
                ORDER_TYPES.BUY, ORDER_TYPES.SELL,
                filledCounts[ORDER_TYPES.BUY], extraOrderCount, excludeOrderIds
            );
            ordersToPlace.push(...result.ordersToPlace);
            ordersToRotate.push(...result.ordersToRotate);
            partialMoves.push(...result.partialMoves);
            if (result.ordersToUpdate) ordersToUpdate.push(...result.ordersToUpdate);
        }

        return { ordersToPlace, ordersToRotate, partialMoves, ordersToUpdate };
    }

    /**
     * Rebalance one side after the opposite side fills.
     */
    async rebalanceSideAfterFill(filledType, oppositeType, filledCount, extraOrderCount, excludeOrderIds) {
        const mgr = this.manager;
        const ordersToPlace = [];
        const ordersToRotate = [];
        const partialMoves = [];
        const splitUpdatedOrderIds = new Set();  // Track orders being SPLIT updated
        const count = filledCount + extraOrderCount;
        const partialMoveSlots = filledCount;
        const side = oppositeType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const filledSide = filledType === ORDER_TYPES.BUY ? 'buy' : 'sell';

        mgr.logger.log(`[REBALANCE] Called for filledType=${filledType}, oppositeType=${oppositeType}, filledCount=${filledCount}`, 'info');

        // Check if we already have enough active orders on the filled side
        // (e.g. if spread correction already placed an order)
        const currentFilledSideActive = countOrdersByType(filledType, mgr.orders);
        let filledTargetCount = 1;
        if (mgr.config.activeOrders && mgr.config.activeOrders[filledSide]) {
            filledTargetCount = Math.max(1, mgr.config.activeOrders[filledSide]);
        }

        const shortageOnFilledSide = Math.max(0, filledTargetCount - currentFilledSideActive);
        const toActivate = Math.min(count, shortageOnFilledSide);

        if (toActivate > 0) {
            const activatedOrders = await this.activateClosestVirtualOrdersForPlacement(filledType, toActivate, excludeOrderIds);
            ordersToPlace.push(...activatedOrders);
            mgr.logger.log(`Prepared ${activatedOrders.length} virtual ${filledType} orders for on-chain placement (target: ${filledTargetCount}, active: ${currentFilledSideActive})`, 'debug');
        } else {
            mgr.logger.log(`Skipping ${filledType} activation: already at or above target count (${currentFilledSideActive} >= ${filledTargetCount})`, 'debug');
        }

        let partialOrders = mgr.getPartialOrdersOnSide(oppositeType);
        
        if (excludeOrderIds && excludeOrderIds.size > 0) {
            const originalCount = partialOrders.length;
            partialOrders = partialOrders.filter(o => !excludeOrderIds.has(o.orderId) && !excludeOrderIds.has(o.id));
            if (partialOrders.length < originalCount) {
                mgr.logger.log(`Excluded ${originalCount - partialOrders.length} partial ${oppositeType} order(s) from move because they are being filled in this batch`, 'debug');
            }
        }

        if (partialOrders.length >= 1) {
            partialOrders.sort((a, b) =>
                oppositeType === ORDER_TYPES.SELL ? b.price - a.price : a.price - b.price
            );

            // ============================================================================
            // GHOST VIRTUALIZATION MECHANISM
            // ============================================================================
            // This is a critical technique for safely moving multiple partial orders while
            // preventing traffic jams and ensuring accurate target sizing.
            //
            // PROBLEM: Multiple partials in the same slot occupy physical space. If we try
            // to move them sequentially without virtualization, the first partial leaves
            // behind residual capital/size that blocks the next partial's move.
            //
            // SOLUTION: Temporarily mark all partials as VIRTUAL (not ACTIVE/PARTIAL) so
            // they don't block each other's geometric calculations. This creates a "ghost"
            // state where we can accurately compute what each partial's target slot would
            // receive if it were on that grid position.
            //
            // DATA CAPTURE: Before virtualizing, we capture originalPartialData (a snapshot
            // of each partial's current state including size, price, orderId). This is
            // CRITICAL because:
            // 1. evaluatePartialOrderAnchor() needs the original size to calculate residuals
            // 2. During anchoring (moveDist=0), we ensure targetGridOrder reflects the
            //    original data, not the ghost-virtualized state
            // 3. This prevents "target size drift" where ideal sizes get miscalculated
            //
            // ERROR SAFETY: The virtualization is wrapped in try/catch to ensure that if
            // an exception occurs, we don't leave orders in a partially-virtualized state.
            //
            // FINALIZATION: After processing all partials, we restore their original states
            // in the finally block. This ensures the manager's order indices remain accurate.
            //
            const originalPartialData = new Map();
            try {
                for (const p of partialOrders) {
                    originalPartialData.set(p.id, { ...p });
                    p.state = ORDER_STATES.VIRTUAL;
                }
            } catch (virtualizationError) {
                // If virtualization fails, restore any partially-virtualized orders
                mgr.logger.log(`Error during ghost virtualization setup: ${virtualizationError.message}. Rolling back partial orders.`, 'error');
                for (const p of partialOrders) {
                    if (originalPartialData.has(p.id)) {
                        const originalData = originalPartialData.get(p.id);
                        if (originalData.state) {
                            p.state = originalData.state;
                        }
                    }
                }
                throw virtualizationError;
            }

            try {
                const reservedGridIds = new Set();
                let accumulatedResidualCapital = 0;

                for (let i = 0; i < partialOrders.length; i++) {
                    const p = partialOrders[i];
                    const isInnermost = (i === partialOrders.length - 1);

                    // ========================================================================
                    // ANCHOR STRATEGY: Keep partials in their current grid positions
                    // ========================================================================
                    // We use moveDist=0 to indicate that partials should NOT move to new
                    // slots. Instead, they stay anchored in place and we update their sizes.
                    //
                    // Why anchoring matters:
                    // - Each grid slot has a geometric ideal size (larger spreads → larger sizes)
                    // - If a partial is "dust" (< 5% of ideal), it gets absorbed by innermost
                    // - If substantial, outer partials restore to ideal, innermost absorbs residuals
                    // - Keeping partials anchored prevents "spread rebalancing" which could
                    //   violate the grid's price spacing rules
                    //
                    const moveInfo = this.preparePartialOrderMove(p, 0, reservedGridIds);

                    if (!moveInfo) {
                        mgr.logger.log(`Could not prepare anchor for partial ${p.id}`, 'warn');
                        continue;
                    }

                    // ========================================================================
                    // TARGET GRID ORDER RESOLUTION
                    // ========================================================================
                    // Since partials are ghost-virtualized, we need to restore their original
                    // state data when calculating target slots. This prevents "size drift" where
                    // the ghost state's virtual sizes would distort ideal size calculations.
                    //
                    // Two cases:
                    // 1. Partial is one of our ghost-virtualized orders: use originalPartialData
                    // 2. Target slot is a truly VIRTUAL slot (not a partial): fetch from manager
                    //
                    if (originalPartialData.has(moveInfo.newGridId)) {
                        moveInfo.targetGridOrder = originalPartialData.get(moveInfo.newGridId);
                    } else {
                        // If it's not in our ghost list, it must be a truly VIRTUAL slot.
                        // Fetch the latest from the manager to be sure we have the size.
                        moveInfo.targetGridOrder = mgr.orders.get(moveInfo.newGridId);
                    }

                    // CRITICAL: Evaluate anchor while states are still VIRTUAL
                    // This ensures all partials are evaluated against the same virtual state,
                    // not against partially-updated manager state
                    const isAnchorDecision = this.evaluatePartialOrderAnchor(p, moveInfo);
                    const idealSize = isAnchorDecision.idealSize;

                    // Store the order list and index for potential reuse in merge calculations
                    // (we'll reconstruct this if needed for accurate geometric calculations)
                    moveInfo.anchorOrderType = oppositeType;

                    if (!isInnermost) {
                        // ====================================================================
                        // OUTER PARTIAL CLEANUP
                        // ====================================================================
                        // Outer partials (not the innermost) are always restored to their
                        // geometric ideal size. Any excess residual capital from this partial
                        // is accumulated for the innermost partial to absorb.
                        //
                        // Example: Outer partial size=15, ideal=10 → restore to 10, residual=5*price
                        //
                        mgr.logger.log(`[MULTI-PARTIAL CLEANUP] Outer Partial ${oppositeType} ${p.id}: size=${p.size.toFixed(8)} -> restoring to ideal=${idealSize.toFixed(8)}.`, 'info');
                        const cleanMoveInfo = {
                            ...moveInfo,
                            partialOrder: { ...moveInfo.partialOrder, size: idealSize },
                            newSize: idealSize
                        };
                        partialMoves.push(cleanMoveInfo);
                        if (isAnchorDecision.residualCapital > 0) {
                            accumulatedResidualCapital += isAnchorDecision.residualCapital;
                        }
                    } else {
                        // ====================================================================
                        // INNERMOST PARTIAL: MERGE vs SPLIT DECISION
                        // ====================================================================
                        // Decision is based SOLELY on partial order size vs dust threshold.
                        // idealSize is calculated from geometric grid distribution, NOT from
                        // the partial's current size.
                        //
                        // MERGE: partial_size < dust_threshold (5% of ideal)
                        //        merged_size = partial_size + fundable_amount
                        //        Constraint: merged_size <= ideal_size * 1.05
                        //        Result: 1 order (partial updated to merged size)
                        //
                        // SPLIT: partial_size >= dust_threshold
                        //        Update partial to ideal_size
                        //        Create residual order with original_partial_size (if > ideal)
                        //        Result: 1 or 2 orders
                        //
                        const dustThresholdPercent = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE;
                        const dustThreshold = idealSize * (dustThresholdPercent / 100);

                        if (p.size < dustThreshold) {
                            // ================================================================
                            // MERGE: Combine partial dust with ideal size (using available funds)
                            // ================================================================
                            // Get available funds for the opposite side (including cacheFunds)
                            const side = oppositeType === ORDER_TYPES.BUY ? 'buy' : 'sell';
                            const availableFunds = (mgr.funds?.available?.[side] || 0) + (mgr.funds?.cacheFunds?.[side] || 0);

                            // Only proceed with consolidation if we have funds available
                            if (availableFunds <= 0) {
                                mgr.logger.log(`[MERGE SKIP] No available funds for consolidation of ${oppositeType} ${p.id} (available=${(mgr.funds?.available?.[side] || 0).toFixed(8)}, cache=${(mgr.funds?.cacheFunds?.[side] || 0).toFixed(8)})`, 'info');
                                // Fall through to SPLIT behavior: restore to ideal without merging
                                mgr.logger.log(`[DUST NO-FUND SPLIT] Dust partial ${p.type} ${p.id}: restoring to ideal=${idealSize.toFixed(8)} without merge.`, 'info');
                                const orderUpdate = {
                                    partialOrder: {
                                        id: p.id,
                                        orderId: p.orderId,
                                        type: p.type,
                                        price: p.price,
                                        size: p.size
                                    },
                                    newPrice: moveInfo.newPrice,
                                    newSize: idealSize,
                                    isSplitUpdate: true,
                                    newState: ORDER_STATES.ACTIVE
                                };
                                partialMoves.push(orderUpdate);
                                splitUpdatedOrderIds.add(p.id);
                                const updatedPartial = {
                                    ...p,
                                    size: idealSize,
                                    state: ORDER_STATES.ACTIVE
                                };
                                mgr._updateOrder(updatedPartial);
                            } else {
                                // Calculate ideal size WITH available funds using same fund sources as grid update
                                // Match: cache + grid + available (same as updateGridOrderSizes)
                                // CRITICAL: Use the partial's own type, not the opposite type
                                // We're resizing a SELL partial, so we need SELL order distribution
                                const orderType = p.type;  // Use partial's type, not opposite
                                const side = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
                                const cache = mgr.funds?.cacheFunds?.[side] || 0;
                                const grid = mgr.funds?.total?.grid?.[side] || 0;
                                const available = mgr.funds?.available?.[side] || 0;
                                const totalFunds = cache + grid + available;

                                // Get ALL orders on this side (same as grid update does)
                                // filterOrdersByType automatically excludes SPREAD since SPREAD is a separate type
                                const allOrders = Array.from(mgr.orders.values());
                                const gridOrdersOnSide = allOrders
                                    .filter(o => o && o.type === orderType)
                                    .sort((a, b) => orderType === ORDER_TYPES.SELL ? a.price - b.price : b.price - a.price);

                                // Count orders by state for debugging
                                const ordersByState = {
                                    ACTIVE: gridOrdersOnSide.filter(o => o.state === ORDER_STATES.ACTIVE).length,
                                    PARTIAL: gridOrdersOnSide.filter(o => o.state === ORDER_STATES.PARTIAL).length,
                                    VIRTUAL: gridOrdersOnSide.filter(o => o.state === ORDER_STATES.VIRTUAL).length,
                                    SPREAD: gridOrdersOnSide.filter(o => o.state === ORDER_STATES.SPREAD).length,
                                    OTHER: gridOrdersOnSide.filter(o => !Object.values(ORDER_STATES).includes(o.state)).length
                                };

                                // Also calculate using evaluatePartialOrderAnchor's method for comparison
                                const anchorOrdersOnSide = [
                                    ...mgr.getOrdersByTypeAndState(orderType, ORDER_STATES.ACTIVE),
                                    ...mgr.getOrdersByTypeAndState(orderType, ORDER_STATES.PARTIAL),
                                    ...mgr.getOrdersByTypeAndState(orderType, ORDER_STATES.VIRTUAL)
                                ];

                                // Calculate ideal sizes for all grid positions with new total funds
                                const precision = getPrecisionForSide(mgr, orderType);
                                const mergedIdealSizes = calculateRotationOrderSizes(
                                    totalFunds,
                                    0,
                                    gridOrdersOnSide.length,
                                    orderType,
                                    mgr.config,
                                    0,
                                    precision
                                );

                                // Calculate sum of all ideal sizes to verify fund distribution
                                const sumIdealSizes = mergedIdealSizes.reduce((sum, size) => sum + size, 0);

                                // Debug: Log the order count and ideal sizes
                                mgr.logger.log(`[DEBUG MERGE] filterByType=${gridOrdersOnSide.length} (A=${ordersByState.ACTIVE}, P=${ordersByState.PARTIAL}, V=${ordersByState.VIRTUAL}, S=${ordersByState.SPREAD}), anchorMethod=${anchorOrdersOnSide.length}, partial_pos=${gridOrdersOnSide.findIndex(o => o.id === p.id)}, first_5=[${mergedIdealSizes.slice(0, 5).map(s => s.toFixed(8)).join(', ')}]`, 'info');
                                mgr.logger.log(`[DEBUG MERGE FUNDS] totalFunds=${totalFunds.toFixed(8)}, sumIdealSizes=${sumIdealSizes.toFixed(8)}, ratio=${(sumIdealSizes / totalFunds).toFixed(4)}`, 'info');

                                // Find this partial's position in the grid
                                const partialIndex = gridOrdersOnSide.findIndex(o => o.id === p.id);
                                // For SELL side, geometric distribution is in reverse order
                                // SELL orders sorted lowest->highest, but distribution is calculated highest->lowest
                                const idealIndex = orderType === ORDER_TYPES.SELL
                                    ? (gridOrdersOnSide.length - 1 - partialIndex)
                                    : partialIndex;
                                const newGeometricIdeal = (idealIndex >= 0 && idealIndex < mergedIdealSizes.length)
                                    ? mergedIdealSizes[idealIndex]
                                    : idealSize;
                                // Merge = dust partial size + new ideal geometric size (using expanded funds)
                                const mergedSize = p.size + newGeometricIdeal;

                                // The merged size IS the calculated ideal with all available funds
                                // It's the geometric distribution result, so always proceed with MERGE
                                // (no constraint needed since it's the ideal for this position)
                                mgr.logger.log(`[MULTI-PARTIAL MERGE] Innermost Partial ${oppositeType} ${p.id}: dust=${p.size.toFixed(8)}, ideal_without_avail=${idealSize.toFixed(8)}, available=${available.toFixed(8)}, total_funds=${totalFunds.toFixed(8)}, grid=${grid.toFixed(8)}, cache=${cache.toFixed(8)}, ideal_with_avail=${mergedSize.toFixed(8)}, calc_ratio=${(mergedSize / idealSize).toFixed(4)}x.`, 'info');
                                const dustRefillInfo = {
                                    ...moveInfo,
                                    partialOrder: {
                                        ...moveInfo.partialOrder,
                                        size: mergedSize,
                                        isDustRefill: true,
                                        isDoubleOrder: true,
                                        mergedDustSize: p.size,  // The dust portion that was merged
                                        filledSinceRefill: 0,
                                        pendingRotation: true
                                    },
                                    newSize: mergedSize,
                                    isDustRefill: true
                                };
                                mgr.logger.log(`[DEBUG MERGE] Created dustRefillInfo: id=${dustRefillInfo.partialOrder.id}, orderId=${dustRefillInfo.partialOrder.orderId}, size=${dustRefillInfo.partialOrder.size.toFixed(8)}, isDoubleOrder=${dustRefillInfo.partialOrder.isDoubleOrder}`, 'info');
                                partialMoves.push(dustRefillInfo);
                                // Update manager's in-memory state immediately so the partial order becomes a double order
                                // in its original grid position (no new order created)
                                mgr._updateOrder(dustRefillInfo.partialOrder);
                                const updatedInMgr = mgr.orders.get(p.id);
                                mgr.logger.log(`[DEBUG MERGE] After _updateOrder: id=${p.id}, mgr has it: ${updatedInMgr ? 'YES' : 'NO'}, isDoubleOrder=${updatedInMgr?.isDoubleOrder}, size=${updatedInMgr?.size.toFixed(8)}`, 'info');

                                // CRITICAL: Remove virtual orders that were calculated for this grid position
                                // Since the merged double order is now filling this slot, we don't need the virtual placeholder
                                // Look for virtual orders on the opposite side that match the grid position
                                // BUT: Exclude the partial order's own ID (it's now a double order, not virtual)
                                const mergedPrice = moveInfo.newPrice;

                                // Find virtual orders at very close price (grid precision tolerance)
                                const priceTolerance = moveInfo.incrementPrice || (mergedPrice * 0.001);  // 0.1% price tolerance

                                const virtualAtSameGridPos = Array.from(mgr.orders.values()).filter(order =>
                                    order.type === oppositeType &&
                                    order.state === ORDER_STATES.VIRTUAL &&
                                    order.id !== p.id &&  // CRITICAL: Don't remove the partial we just converted!
                                    Math.abs(order.price - mergedPrice) <= priceTolerance
                                );

                                if (virtualAtSameGridPos.length > 0) {
                                    mgr.logger.log(`[DEBUG MERGE] Found ${virtualAtSameGridPos.length} virtual ${oppositeType} order(s) near price ${mergedPrice.toFixed(8)} - removing to prevent duplicate placement`, 'debug');
                                    virtualAtSameGridPos.forEach(vorder => {
                                        mgr.orders.delete(vorder.id);
                                        mgr.logger.log(`[DEBUG MERGE] Removed virtual ${vorder.id} at price ${vorder.price.toFixed(8)}, size ${vorder.size.toFixed(8)}`, 'debug');
                                    });
                                }
                            }
                        } else {
                            // ================================================================
                            // SPLIT: Update partial order size in place, create residual at spread
                            // ================================================================
                            mgr.logger.log(`[MULTI-PARTIAL SPLIT] Innermost Partial ${p.type} ${p.id}: size=${p.size.toFixed(8)} -> ideal=${idealSize.toFixed(8)}.`, 'info');

                            // Update the existing order in place with delta size
                            // Keep same orderId, just change the size from p.size to idealSize
                            // Updated PARTIAL order transitions back to ACTIVE
                            // Structure it like a partial move so it gets processed correctly
                            const orderUpdate = {
                                partialOrder: {
                                    id: p.id,
                                    orderId: p.orderId,
                                    type: p.type,
                                    price: p.price,
                                    size: p.size
                                },
                                newPrice: moveInfo.newPrice,  // Same price, same grid slot
                                newSize: idealSize,            // Delta: p.size -> idealSize
                                isSplitUpdate: true,
                                newState: ORDER_STATES.ACTIVE  // Transition PARTIAL -> ACTIVE
                            };
                            partialMoves.push(orderUpdate);
                            mgr.logger.log(`[SPLIT UPDATE] Updating ${p.type} ${p.id}: size ${p.size.toFixed(8)} -> ${idealSize.toFixed(8)}, state PARTIAL -> ACTIVE`, 'info');

                            // Track this order as being SPLIT updated so we don't restore it
                            splitUpdatedOrderIds.add(p.id);

                            // Update manager's in-memory state to reflect the new size and state
                            const updatedPartial = {
                                ...p,
                                size: idealSize,
                                state: ORDER_STATES.ACTIVE
                            };
                            mgr._updateOrder(updatedPartial);

                            // Create residual order at spread with ONLY the original partial size
                            // This new order will be in PARTIAL state
                            const spreadOrders = Array.from(mgr.orders.values())
                                .filter(o => o.type === p.type && o.state === ORDER_STATES.SPREAD);
                            const spreadPrice = spreadOrders.length > 0
                                ? (p.type === ORDER_TYPES.BUY ? Math.max(...spreadOrders.map(o => o.price)) : Math.min(...spreadOrders.map(o => o.price)))
                                : moveInfo.newPrice;

                            const residualOrder = {
                                id: null, type: p.type, price: spreadPrice, size: p.size,
                                state: ORDER_STATES.PARTIAL, isResidualFromSplitId: p.id
                            };
                            ordersToPlace.push(residualOrder);
                            mgr.logger.log(`[SPLIT RESIDUAL] Created ${p.type} order at spread price ${spreadPrice.toFixed(4)}, size ${p.size.toFixed(8)}, state PARTIAL`, 'info');
                        }
                    }
                }
            } finally {
                // Restore original states through _updateOrder to keep indices in sync
                // Use batch mode to avoid redundant fund recalculations
                mgr.pauseFundRecalc();
                try {
                    for (const p of partialOrders) {
                        if (originalPartialData.has(p.id)) {
                            const originalData = originalPartialData.get(p.id);
                            const currentOrder = mgr.orders.get(p.id);

                            mgr.logger.log(`[DEBUG RESTORE] Checking ${p.id}: currentOrder exists=${!!currentOrder}, isDoubleOrder=${currentOrder?.isDoubleOrder}, isSplitUpdate=${splitUpdatedOrderIds.has(p.id)}, originalState=${originalData?.state}`, 'info');

                            // Skip restoration if this order is now a double order (already updated above)
                            if (currentOrder && currentOrder.isDoubleOrder) {
                                mgr.logger.log(`[DEBUG RESTORE] Skipping ${p.id} - it's a double order`, 'info');
                                continue;
                            }

                            // Skip restoration if this order was SPLIT updated (it's now ACTIVE, don't revert to PARTIAL)
                            if (splitUpdatedOrderIds.has(p.id)) {
                                mgr.logger.log(`[DEBUG RESTORE] Skipping ${p.id} - it's a SPLIT updated order`, 'info');
                                continue;
                            }

                            if (currentOrder && originalData && originalData.state !== undefined) {
                                const restoredOrder = { ...currentOrder, state: originalData.state };
                                mgr.logger.log(`[DEBUG RESTORE] Restoring ${p.id} from ${currentOrder.state} to ${originalData.state}`, 'info');
                                mgr._updateOrder(restoredOrder);
                            }
                        }
                    }
                } finally {
                    mgr.resumeFundRecalc();
                }
            }
        }

        const currentActiveCount = countOrdersByType(oppositeType, mgr.orders);

        // Include double orders (merged partials) in the active count since they're about to be on-chain
        const doubleOrdersBeingMoved = partialMoves
            .filter(m => m.partialOrder?.type === oppositeType && m.partialOrder?.isDoubleOrder)
            .length;

        // Also count new orders being placed that match oppositeType (including residuals from SPLIT)
        const newOrdersBeingPlaced = ordersToPlace
            .filter(o => o.type === oppositeType)
            .length;

        const effectiveActiveCount = currentActiveCount + doubleOrdersBeingMoved + newOrdersBeingPlaced;

        mgr.logger.log(`[DEBUG COUNT] oppositeType=${oppositeType}, currentActive=${currentActiveCount}, doubleOrders=${doubleOrdersBeingMoved}, newOrders=${newOrdersBeingPlaced} (ordersToPlace.length=${ordersToPlace.length}), effectiveActive=${effectiveActiveCount}`, 'info');

        let targetCount = 1;
        if (mgr.config.activeOrders && mgr.config.activeOrders[side] && Number.isFinite(mgr.config.activeOrders[side])) {
            targetCount = Math.max(1, mgr.config.activeOrders[side]);
        }

        const belowTarget = effectiveActiveCount < targetCount;

        // CRITICAL: If we have double orders being moved, skip rotations entirely
        // Double orders movement IS the rebalancing - no additional rotations needed
        const hasDoubleOrders = doubleOrdersBeingMoved > 0;

        // CRITICAL: If we have SPLIT updates, skip rotations entirely
        // SPLIT updates in-place with residuals at spread = complete rebalancing for this cycle
        const hasSplitUpdates = splitUpdatedOrderIds.size > 0;

        mgr.logger.log(`[DEBUG ROTATION CHECK] targetCount=${targetCount}, effectiveActive=${effectiveActiveCount}, belowTarget=${belowTarget}, hasDoubleOrders=${hasDoubleOrders}, hasSplitUpdates=${hasSplitUpdates}`, 'info');

        if (belowTarget && !hasDoubleOrders && !hasSplitUpdates) {
            mgr.logger.log(`[DEBUG ROTATION] ENTERING rotation block`, 'info');
            const shortage = targetCount - effectiveActiveCount;
            const ordersToCreate = Math.min(shortage, count);
            const logMsg = (doubleOrdersBeingMoved > 0 || newOrdersBeingPlaced > 0)
                ? `Active ${oppositeType} orders (${currentActiveCount} + ${doubleOrdersBeingMoved} double + ${newOrdersBeingPlaced} new = ${effectiveActiveCount}) below target (${targetCount}). Creating ${ordersToCreate} new orders.`
                : `Active ${oppositeType} orders (${currentActiveCount}) below target (${targetCount}). Creating ${ordersToCreate} new orders.`;
            mgr.logger.log(logMsg, 'info');

            const vacatedSlots = partialMoves
                .filter(m => {
                    // Only process moves with partialOrder property (not SPLIT updates)
                    if (!m.partialOrder) return false;
                    return m.partialOrder.type === oppositeType && m.vacatedGridId;
                })
                .map(m => ({ id: m.vacatedGridId, price: m.vacatedPrice }));

            let ordersCreated = 0;
            for (const slot of vacatedSlots) {
                if (ordersCreated >= ordersToCreate) break;
                const gridOrder = mgr.orders.get(slot.id);
                if (!gridOrder) continue;

                const cache = getCacheFundsValue(mgr.funds, side);
                const remainingOrders = ordersToCreate - ordersCreated;
                const sizePerOrder = cache / remainingOrders;
                if (sizePerOrder <= 0) continue;

                const precision = getPrecisionForSide(mgr.assets, side);
                const quantizedSize = blockchainToFloat(floatToBlockchainInt(sizePerOrder, precision), precision);

                const newOrder = { ...gridOrder, type: oppositeType, size: quantizedSize, price: slot.price };

                // Consume from cacheFunds
                mgr.funds.cacheFunds[side] = Math.max(0, (mgr.funds.cacheFunds[side] || 0) - quantizedSize);

                ordersToPlace.push(newOrder);
                ordersCreated++;
                mgr.logger.log(`Using vacated partial slot ${slot.id} for new ${oppositeType} at price ${slot.price.toFixed(4)}, size ${quantizedSize.toFixed(8)}`, 'info');
            }

            if (ordersCreated < ordersToCreate) {
                const remaining = ordersToCreate - ordersCreated;
                // Exclude double orders (merged partials) from virtual activation to prevent duplicate orders at same price
                const excludeDoubleOrderIds = new Set(excludeOrderIds || []);
                for (const doubleOrderMove of partialMoves.filter(m => m.partialOrder?.isDoubleOrder)) {
                    if (doubleOrderMove.partialOrder?.id) {
                        excludeDoubleOrderIds.add(doubleOrderMove.partialOrder.id);
                    }
                    if (doubleOrderMove.partialOrder?.orderId) {
                        excludeDoubleOrderIds.add(doubleOrderMove.partialOrder.orderId);
                    }
                }
                const newOrders = await this.activateClosestVirtualOrdersForPlacement(oppositeType, remaining, excludeDoubleOrderIds);
                ordersToPlace.push(...newOrders);
            }
        } else if (!hasDoubleOrders && !hasSplitUpdates) {
            // Only do rotations if we don't have double orders or SPLIT updates being moved
            // SPLIT updates are already complete rebalancing, no rotation needed
            // Also exclude double orders from rotation selection - they're already being handled by partial moves
            const excludeForRotation = new Set(excludeOrderIds || []);
            for (const doubleOrderMove of partialMoves.filter(m => m.partialOrder?.isDoubleOrder)) {
                if (doubleOrderMove.partialOrder?.id) {
                    excludeForRotation.add(doubleOrderMove.partialOrder.id);
                }
                if (doubleOrderMove.partialOrder?.orderId) {
                    excludeForRotation.add(doubleOrderMove.partialOrder.orderId);
                }
            }

            // Filter out vacated slots from double orders (they don't vacate, they just update in place)
            // SPLIT updates don't have vacatedGridId since they update in place
            const nonDoubleVacatedSlots = partialMoves
                .filter(m => {
                    // Only process moves with partialOrder property (not SPLIT updates)
                    if (!m.partialOrder) return false;
                    return m.partialOrder.type === oppositeType && m.vacatedGridId && !m.partialOrder?.isDoubleOrder;
                })
                .map(m => ({ id: m.vacatedGridId, price: m.vacatedPrice }));

            const rotatedOrders = await this.prepareFurthestOrdersForRotation(
                oppositeType, count, excludeForRotation, filledCount,
                {
                    avoidPrices: partialMoves.map(m => m.newPrice || m.price),  // SPLIT updates use price, moves use newPrice
                    preferredSlots: nonDoubleVacatedSlots,
                    partialMoves: partialMoves
                }
            );
            mgr.logger.log(`[ROTATION] Adding ${rotatedOrders.length} rotated orders for ${oppositeType}`, 'info');
            ordersToRotate.push(...rotatedOrders);
        } else if (hasDoubleOrders && belowTarget) {
            // If we have double orders but still below target, we can activate virtuals
            const shortage = targetCount - effectiveActiveCount;
            const ordersToActivate = Math.min(shortage, count);
            if (ordersToActivate > 0) {
                const excludeDoubleOrderIds = new Set(excludeOrderIds || []);
                for (const doubleOrderMove of partialMoves.filter(m => m.partialOrder?.isDoubleOrder)) {
                    if (doubleOrderMove.partialOrder?.id) {
                        excludeDoubleOrderIds.add(doubleOrderMove.partialOrder.id);
                    }
                    if (doubleOrderMove.partialOrder?.orderId) {
                        excludeDoubleOrderIds.add(doubleOrderMove.partialOrder.orderId);
                    }
                }
                const newOrders = await this.activateClosestVirtualOrdersForPlacement(oppositeType, ordersToActivate, excludeDoubleOrderIds);
                ordersToPlace.push(...newOrders);
                mgr.logger.log(`Active ${oppositeType} orders (${currentActiveCount} + ${doubleOrdersBeingMoved} double orders = ${effectiveActiveCount}) still below target (${targetCount}). Activated ${newOrders.length} virtual orders to reach target.`, 'info');
            }
        }

        // Separate SPLIT updates from regular partial moves
        const splitUpdates = partialMoves.filter(m => m.isSplitUpdate);
        const regularPartialMoves = partialMoves.filter(m => !m.isSplitUpdate);

        return { ordersToPlace, ordersToRotate, partialMoves: regularPartialMoves, ordersToUpdate: splitUpdates };
    }

    /**
     * Evaluate whether a partial order should be treated as "Dust" or "Substantial".
     * Uses blockchain integer arithmetic for precision consistency.
     */
    evaluatePartialOrderAnchor(partialOrder, moveInfo, includeAvailableFunds = false) {
        const mgr = this.manager;
        if (!moveInfo || !moveInfo.targetGridOrder) {
            return { isDust: true, idealSize: partialOrder.size || 0, percentOfIdeal: 0 };
        }

        // Calculate the TRUE geometric ideal for this slot based on grid configuration
        // We cannot use targetGridOrder.size because when anchoring, that's the partial's
        // current (reduced) size, not the geometric ideal.
        const partialSize = partialOrder.size || 0;
        let idealSize = 0;

        // Get all orders on this side to calculate geometric distribution
        const orderType = partialOrder.type;
        const allOrdersOnSide = [
            ...mgr.getOrdersByTypeAndState(orderType, ORDER_STATES.ACTIVE),
            ...mgr.getOrdersByTypeAndState(orderType, ORDER_STATES.PARTIAL),
            ...mgr.getOrdersByTypeAndState(orderType, ORDER_STATES.VIRTUAL)
        ].sort((a, b) => orderType === ORDER_TYPES.SELL ? a.price - b.price : b.price - a.price);

        if (allOrdersOnSide.length > 0) {
            // Calculate total funds committed to this side (optionally including available)
            const side = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
            const virtuel = mgr.funds?.virtuel?.[side] || 0;
            const committed = mgr.funds?.committed?.[side] || 0;
            let totalFunds = virtuel + committed;

            // If requested, include available funds in the calculation
            // This ensures the ideal reflects what the size should be with all available capital
            if (includeAvailableFunds) {
                const available = (mgr.funds?.available?.[side] || 0) + (mgr.funds?.cacheFunds?.[side] || 0);
                totalFunds += available;
            }

            if (totalFunds > 0) {
                const precision = getPrecisionForSide(mgr, orderType);
                const idealSizes = calculateRotationOrderSizes(
                    totalFunds,
                    0,
                    allOrdersOnSide.length,
                    orderType,
                    mgr.config,
                    0,
                    precision
                );

                // Find partial's position in the sorted order list
                const partialIndex = allOrdersOnSide.findIndex(o => o.id === partialOrder.id);
                if (partialIndex >= 0 && partialIndex < idealSizes.length) {
                    idealSize = idealSizes[partialIndex];
                }
            }
        }

        // Fallback to targetGridOrder.size or partialOrder.size if calculation failed
        if (idealSize <= 0) {
            idealSize = moveInfo.targetGridOrder.size || partialOrder.size || 0;
        }

        if (idealSize <= 0) {
            mgr.logger.log(`Cannot evaluate partial order ${partialOrder.id}: target grid slot has no ideal size`, 'warn');
            return { isDust: true, idealSize, percentOfIdeal: 0 };
        }

        // Use integer arithmetic for precision consistency with blockchain
        const precision = (partialOrder.type === ORDER_TYPES.SELL)
            ? mgr.assets?.assetA?.precision || (() => {
                mgr.logger?.log?.(`WARNING: Asset precision not found for assetA, using fallback precision=${PRECISION_DEFAULTS.ASSET_FALLBACK}`, 'warn');
                return PRECISION_DEFAULTS.ASSET_FALLBACK;
            })()
            : mgr.assets?.assetB?.precision || (() => {
                mgr.logger?.log?.(`WARNING: Asset precision not found for assetB, using fallback precision=${PRECISION_DEFAULTS.ASSET_FALLBACK}`, 'warn');
                return PRECISION_DEFAULTS.ASSET_FALLBACK;
            })();

        const partialInt = floatToBlockchainInt(partialSize, precision);
        const idealInt = floatToBlockchainInt(idealSize, precision);

        // Calculate percent using integer arithmetic to match blockchain behavior
        const percentOfIdeal = idealInt > 0 ? partialInt / idealInt : 0;

        if (percentOfIdeal < GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100) {
            return { isDust: true, idealSize, percentOfIdeal, mergedDustSize: partialSize };
        } else {
            let residualCapital = 0;
            if (partialOrder.type === ORDER_TYPES.SELL) {
                const extraSize = Math.max(0, partialSize - idealSize);
                residualCapital = extraSize * moveInfo.newPrice;
            } else {
                const extraQuote = Math.max(0, partialSize - idealSize);
                residualCapital = extraQuote;
            }
            return { isDust: false, idealSize, percentOfIdeal, newSize: idealSize, residualCapital: Math.max(0, residualCapital) };
        }
    }

    /**
     * Activate the closest VIRTUAL orders for on-chain placement.
     */
    async activateClosestVirtualOrdersForPlacement(targetType, count, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (count <= 0) return [];

        let virtualOrders = mgr.getOrdersByTypeAndState(targetType, ORDER_STATES.VIRTUAL);

        if (excludeOrderIds && excludeOrderIds.size > 0) {
            virtualOrders = virtualOrders.filter(o => !excludeOrderIds.has(o.id) && !excludeOrderIds.has(o.orderId) && !mgr.isOrderLocked(o.id) && !mgr.isOrderLocked(o.orderId));
        } else {
            virtualOrders = virtualOrders.filter(o => !mgr.isOrderLocked(o.id) && !mgr.isOrderLocked(o.orderId));
        }

        mgr.logger.log(`Found ${virtualOrders.length} VIRTUAL ${targetType} orders for activation`, 'debug');

        virtualOrders.sort((a, b) => targetType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        const toActivate = virtualOrders.slice(0, count);
        const activated = [];

        for (const order of toActivate) {
            const currentOrder = mgr.orders.get(order.id);
            if (!currentOrder || currentOrder.state !== ORDER_STATES.VIRTUAL) continue;

            const orderSize = order.size || 0;
            if (orderSize <= 0) continue;

            const activatedOrder = { ...order, type: targetType, size: orderSize, state: ORDER_STATES.VIRTUAL };
            mgr.accountant.updateOptimisticFreeBalance(order, activatedOrder, 'spread-activation');

            mgr._updateOrder(activatedOrder);
            activated.push(activatedOrder);
            mgr.logger.log(`Activated virtual ${targetType} at ${order.price.toFixed(4)} (Amount: ${orderSize.toFixed(8)})`, 'info');
        }
        return activated;
    }

    /**
     * Prepare the furthest ACTIVE orders for rotation to new prices.
     */
    async prepareFurthestOrdersForRotation(targetType, count, excludeOrderIds = new Set(), filledCount = 0, options = {}) {
        const mgr = this.manager;
        if (count <= 0) return [];

        let activeOrders = mgr.getOrdersByTypeAndState(targetType, ORDER_STATES.ACTIVE)
            .filter(o =>
                !excludeOrderIds.has(o.id) &&
                !excludeOrderIds.has(o.orderId) &&
                !mgr.isOrderLocked(o.id) &&
                !mgr.isOrderLocked(o.orderId)
            );

        if (activeOrders.length === 0) {
            mgr.logger.log(`No active ${targetType} orders available for rotation`, 'debug');
            return [];
        }

        activeOrders.sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        const toRotate = activeOrders.slice(0, count);
        const rotated = [];

        const side = targetType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const cache = getCacheFundsValue(mgr.funds, side);
        const fundsPerOrder = cache / toRotate.length;

        for (const order of toRotate) {
            const allSpreadOrders = mgr.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);

            if (allSpreadOrders.length === 0) {
                mgr.logger.log(`No SPREAD slots available for ${targetType} rotation`, 'warn');
                break;
            }

            // ====================================================================
            // SPREAD ZONE BOUNDARY: Valid SPREADs must be between active orders
            // ====================================================================
            // The spread zone is defined by:
            // - Lower boundary: Highest active BUY order price
            // - Upper boundary: Lowest active SELL order price
            // Valid SPREADs must be: highestActiveBuy < spreadPrice < lowestActiveSell
            //
            // Selection priority:
            // - BUY rotation: Use LOWEST SPREAD (closest to BUY orders from above)
            // - SELL rotation: Use HIGHEST SPREAD (closest to SELL orders from below)
            //
            const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
            const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);

            const highestActiveBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : -Infinity;
            const lowestActiveSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : Infinity;

            // Filter SPREADs to those within the spread zone
            const validSpreads = allSpreadOrders.filter(o =>
                o.price > highestActiveBuy && o.price < lowestActiveSell
            );

            if (validSpreads.length === 0) {
                mgr.logger.log(`No valid SPREAD slots in spread zone (${highestActiveBuy.toFixed(4)} < price < ${lowestActiveSell.toFixed(4)}) for ${targetType} rotation`, 'warn');
                break;
            }

            // Select the target SPREAD slot based on rotation type
            const targetSpreadSlot = targetType === ORDER_TYPES.BUY
                ? validSpreads.reduce((min, o) => o.price < min.price ? o : min)  // Lowest SPREAD
                : validSpreads.reduce((max, o) => o.price > max.price ? o : max); // Highest SPREAD

            const rotatedOrder = { 
                oldOrder: { ...order }, 
                newPrice: targetSpreadSlot.price, 
                newGridId: targetSpreadSlot.id, 
                newSize: fundsPerOrder,
                type: targetType
            };

            const virtualOrder = { ...targetSpreadSlot, type: targetType, size: fundsPerOrder, state: ORDER_STATES.VIRTUAL };
            mgr.accountant.updateOptimisticFreeBalance(order, virtualOrder, 'rotation');
            
            // Consume from cacheFunds
            mgr.funds.cacheFunds[side] = Math.max(0, (mgr.funds.cacheFunds[side] || 0) - fundsPerOrder);
            
            mgr._updateOrder(virtualOrder);
            rotated.push(rotatedOrder);
            mgr.shadowOrderIds.set(order.orderId, Date.now());
        }
        return rotated;
    }

    /**
     * Complete an order rotation after blockchain confirmation.
     * Returns the old order to VIRTUAL state with its original type and size.
     * CRITICAL: Updates accountTotals to reflect released funds from cancelled order.
     * Do NOT convert to SPREAD here - that only happens on full fill.
     */
    completeOrderRotation(oldOrderInfo) {
        const mgr = this.manager;
        const oldGridOrder = mgr.orders.get(oldOrderInfo.id);
        if (oldGridOrder && oldGridOrder.orderId === oldOrderInfo.orderId) {
            const size = oldGridOrder.size || 0;

            // CRITICAL: Update accountTotals to reflect released funds
            // The order was locked on blockchain (ACTIVE with orderId), now it's cancelled.
            // When cancelled on-chain, the blockchain releases these funds to chainFree.
            // We must update our accountTotals copy to stay in sync, so:
            // - chainFree increases by size (funds released from lock)
            // - virtuel increases by size (funds now reserved as virtual)
            // - available stays constant (both increase equally)
            if (oldGridOrder.type === ORDER_TYPES.BUY) {
                mgr.accountTotals.buyFree = (mgr.accountTotals.buyFree || 0) + size;
            } else if (oldGridOrder.type === ORDER_TYPES.SELL) {
                mgr.accountTotals.sellFree = (mgr.accountTotals.sellFree || 0) + size;
            }

            // Restore to VIRTUAL with original type and size (not SPREAD)
            // This preserves the slot's grid position for potential re-activation
            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr._updateOrder(updatedOld);
            mgr.logger.log(
                `Rotated order ${oldOrderInfo.id} (${oldOrderInfo.type}) at price ${oldOrderInfo.price.toFixed(4)} -> VIRTUAL (size preserved: ${oldGridOrder.size?.toFixed(8) || 0})`,
                'info'
            );
        }
    }

    /**
     * Prepare a partial order to move toward market/spread.
     */
    preparePartialOrderMove(partialOrder, gridSlotsToMove, reservedGridIds = new Set()) {
        const mgr = this.manager;
        if (!partialOrder || gridSlotsToMove < 0) return null;
        if (!partialOrder.orderId) return null;

        const allSlots = Array.from(mgr.orders.values())
            .filter(o => o.price != null)
            .sort((a, b) => b.price - a.price);

        const currentIndex = allSlots.findIndex(o => o.id === partialOrder.id);
        if (currentIndex === -1) return null;

        const direction = partialOrder.type === ORDER_TYPES.SELL ? 1 : -1;
        const targetIndex = currentIndex + (direction * gridSlotsToMove);

        if (targetIndex < 0 || targetIndex >= allSlots.length) return null;

        const targetGridOrder = allSlots[targetIndex];
        const newGridId = targetGridOrder.id;

        if (reservedGridIds.has(newGridId)) return null;
        if (gridSlotsToMove > 0 && targetGridOrder.state !== ORDER_STATES.VIRTUAL) return null;

        const newPrice = targetGridOrder.price;
        let newMinToReceive;
        if (partialOrder.type === ORDER_TYPES.SELL) {
            newMinToReceive = partialOrder.size * newPrice;
            const precision = mgr.assets?.assetB?.precision || 8;
            const scale = Math.pow(10, precision);
            newMinToReceive = Math.round(newMinToReceive * scale) / scale;
        } else {
            newMinToReceive = partialOrder.size / newPrice;
            const precision = mgr.assets?.assetA?.precision || 8;
            const scale = Math.pow(10, precision);
            newMinToReceive = Math.round(newMinToReceive * scale) / scale;
        }

        return {
            partialOrder: { id: partialOrder.id, orderId: partialOrder.orderId, type: partialOrder.type, price: partialOrder.price, size: partialOrder.size, state: partialOrder.state },
            newGridId, newPrice, newMinToReceive, targetGridOrder,
            vacatedGridId: gridSlotsToMove > 0 ? partialOrder.id : null,
            vacatedPrice: gridSlotsToMove > 0 ? partialOrder.price : null
        };
    }

    /**
     * Complete the partial order move after blockchain confirmation.
     */
    completePartialOrderMove(moveInfo) {
        const mgr = this.manager;
        const { partialOrder, newGridId, newPrice } = moveInfo;

        const oldGridOrder = mgr.orders.get(partialOrder.id);
        if (oldGridOrder && (!oldGridOrder.orderId || oldGridOrder.orderId === partialOrder.orderId)) {
            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr.accountant.updateOptimisticFreeBalance(oldGridOrder, updatedOld, 'move-vacate');
            mgr._updateOrder(updatedOld);
        }

        const targetGridOrder = mgr.orders.get(newGridId);
        if (targetGridOrder) {
            // Use blockchain integer precision for state determination (consistent with rest of system)
            const precision = (partialOrder.type === ORDER_TYPES.SELL)
                ? mgr.assets?.assetA?.precision || (() => {
                    mgr.logger?.log?.(`WARNING: Asset precision not found for assetA in completePartialOrderMove, using fallback precision=${PRECISION_DEFAULTS.ASSET_FALLBACK}`, 'warn');
                    return PRECISION_DEFAULTS.ASSET_FALLBACK;
                })()
                : mgr.assets?.assetB?.precision || (() => {
                    mgr.logger?.log?.(`WARNING: Asset precision not found for assetB in completePartialOrderMove, using fallback precision=${PRECISION_DEFAULTS.ASSET_FALLBACK}`, 'warn');
                    return PRECISION_DEFAULTS.ASSET_FALLBACK;
                })();
            const partialInt = floatToBlockchainInt(partialOrder.size, precision);
            const idealInt = floatToBlockchainInt(targetGridOrder.size || 0, precision);
            const newState = partialInt >= idealInt ? ORDER_STATES.ACTIVE : ORDER_STATES.PARTIAL;

            const updatedNew = {
                ...targetGridOrder, ...partialOrder, type: partialOrder.type,
                state: newState, orderId: partialOrder.orderId, size: partialOrder.size, price: newPrice
            };
            mgr.accountant.updateOptimisticFreeBalance(targetGridOrder, updatedNew, 'move-occupy');
            mgr._updateOrder(updatedNew);
        }
    }

    /**
     * Activate spread placeholder orders as buy/sell orders.
     */
    async activateSpreadOrders(targetType, count) {
        const mgr = this.manager;
        const { calculateAvailableFundsValue, getMinOrderSize } = require('./utils');
        if (count <= 0) return [];

        const allSpreadOrders = mgr.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);

        // ====================================================================
        // SPREAD ZONE BOUNDARY: Valid SPREADs must be between active orders
        // ====================================================================
        // The spread zone is defined by:
        // - Lower boundary: Highest active BUY order price
        // - Upper boundary: Lowest active SELL order price
        // Valid SPREADs must be: highestActiveBuy < spreadPrice < lowestActiveSell
        //
        // Selection priority:
        // - BUY activation: Use LOWEST SPREADs (closest to BUY orders from above)
        // - SELL activation: Use HIGHEST SPREADs (closest to SELL orders from below)
        //
        const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);

        const highestActiveBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : -Infinity;
        const lowestActiveSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : Infinity;

        // Filter SPREADs to those within the spread zone, then sort by proximity
        const spreadOrders = allSpreadOrders
            .filter(o => o.price > highestActiveBuy && o.price < lowestActiveSell)
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        const availableFunds = calculateAvailableFundsValue(targetType === ORDER_TYPES.BUY ? 'buy' : 'sell', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
        if (availableFunds <= 0) {
            mgr.logger.log(`No available funds to create ${targetType} orders`, 'warn');
            return [];
        }

        let desiredCount = Math.min(count, spreadOrders.length);
        if (desiredCount <= 0) {
            mgr.logger.log(`No SPREAD orders available for ${targetType} (total spreads: ${allSpreadOrders.length})`, 'warn');
            return [];
        }

        const minSize = getMinOrderSize(targetType, mgr.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const ordersToCreate = desiredCount;

        const activatedOrders = [];
        const side = targetType === ORDER_TYPES.BUY ? 'buy' : 'sell';

        // Sequential placement with per-iteration fund recalculation
        for (let i = 0; i < ordersToCreate && i < spreadOrders.length; i++) {
            // Recalculate available funds at each iteration
            const currentAvailable = calculateAvailableFundsValue(side, mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
            const remainingOrders = ordersToCreate - i;
            const fundsPerOrder = remainingOrders > 0 ? currentAvailable / remainingOrders : 0;

            if (fundsPerOrder < minSize) {
                mgr.logger.log(`Stopped at order ${i + 1}/${ordersToCreate}: insufficient funds (available=${currentAvailable.toFixed(8)}, minSize=${minSize.toFixed(8)})`, 'info');
                break;
            }

            const order = spreadOrders[i];
            const activatedOrder = { ...order, type: targetType, size: fundsPerOrder, state: ORDER_STATES.ACTIVE };
            mgr.accountant.updateOptimisticFreeBalance(order, activatedOrder, 'spread-activation');
            
            // Consume from cacheFunds first, then the rest from available (chainFree)
            // Since cacheFunds are part of available, we must decrease the counter
            mgr.funds.cacheFunds[side] = Math.max(0, (mgr.funds.cacheFunds[side] || 0) - fundsPerOrder);
            
            mgr._updateOrder(activatedOrder);
            activatedOrders.push(activatedOrder);
            mgr.currentSpreadCount--;
            mgr.logger.log(`Prepared ${targetType} order ${i + 1}/${ordersToCreate} at ${order.price.toFixed(2)} (Amount: ${fundsPerOrder.toFixed(8)})`, 'info');
        }

        return activatedOrders;
    }
}

module.exports = StrategyEngine;