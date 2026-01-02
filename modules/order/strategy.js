/**
 * modules/order/strategy.js
 *
 * Specialized engine for grid rebalancing and rotation strategies.
 * Implements Anchor & Refill, Multi-Partial Consolidation, and Geometric Rotations.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../constants');
const { 
    countOrdersByType, 
    getPrecisionForSide, 
    getCacheFundsValue,
    formatOrderSize,
    convertToSpreadPlaceholder,
    calculateAvailableFundsValue,
    getMinOrderSize
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
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        mgr.logger.log(`>>> processFilledOrders() called with ${filledOrders.length} filled orders`, 'info');

        const filledCounts = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };
        const partialFillCount = { [ORDER_TYPES.BUY]: 0, [ORDER_TYPES.SELL]: 0 };

        let proceedsBuy = 0;
        let proceedsSell = 0;
        let deltaBuyFree = 0;
        let deltaSellFree = 0;
        let deltaBuyTotal = 0;
        let deltaSellTotal = 0;

        const hasBtsPair = mgr.config.assetA === 'BTS' || mgr.config.assetB === 'BTS';
        const { getAssetFees } = require('./utils');

        for (const filledOrder of filledOrders) {
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
                mgr.funds.btsFeesOwed += 100;
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

        if (hasBtsPair && mgr.funds.btsFeesOwed > 0) await mgr.accountant.deductBtsFees();

        mgr.recalculateFunds();
        await mgr._persistCacheFunds();
        if (mgr.funds.btsFeesOwed > 0) await mgr._persistBtsFeesOwed();

        const hasFullFills = filledCounts[ORDER_TYPES.BUY] > 0 || filledCounts[ORDER_TYPES.SELL] > 0;
        if (!hasFullFills && (partialFillCount[ORDER_TYPES.BUY] > 0 || partialFillCount[ORDER_TYPES.SELL] > 0)) {
            mgr.logger.log(`Only partial fills detected (no rotations needed).`, 'info');
            return { ordersToPlace: [], ordersToRotate: [], partialMoves: [] };
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
                mgr.funds.btsFeesOwed += 100;
            }
        }

        mgr.recalculateFunds();
        await mgr._persistCacheFunds();
        return newOrders;
    }

    /**
     * Rebalance orders after fills using count-based creation vs rotation strategy.
     */
    async rebalanceOrders(filledCounts, extraOrderCount = 0, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        const ordersToPlace = [];
        const ordersToRotate = [];
        const partialMoves = [];

        if (filledCounts[ORDER_TYPES.SELL] > 0) {
            const result = await this.rebalanceSideAfterFill(
                ORDER_TYPES.SELL, ORDER_TYPES.BUY,
                filledCounts[ORDER_TYPES.SELL], extraOrderCount, excludeOrderIds
            );
            ordersToPlace.push(...result.ordersToPlace);
            ordersToRotate.push(...result.ordersToRotate);
            partialMoves.push(...result.partialMoves);
        }

        if (filledCounts[ORDER_TYPES.BUY] > 0) {
            const result = await this.rebalanceSideAfterFill(
                ORDER_TYPES.BUY, ORDER_TYPES.SELL,
                filledCounts[ORDER_TYPES.BUY], extraOrderCount, excludeOrderIds
            );
            ordersToPlace.push(...result.ordersToPlace);
            ordersToRotate.push(...result.ordersToRotate);
            partialMoves.push(...result.partialMoves);
        }

        return { ordersToPlace, ordersToRotate, partialMoves };
    }

    /**
     * Rebalance one side after the opposite side fills.
     */
    async rebalanceSideAfterFill(filledType, oppositeType, filledCount, extraOrderCount, excludeOrderIds) {
        const mgr = this.manager;
        const ordersToPlace = [];
        const ordersToRotate = [];
        const partialMoves = [];
        const count = filledCount + extraOrderCount;
        const partialMoveSlots = filledCount;
        const side = oppositeType === ORDER_TYPES.BUY ? 'buy' : 'sell';

        const activatedOrders = await this.activateClosestVirtualOrdersForPlacement(filledType, count, excludeOrderIds);
        ordersToPlace.push(...activatedOrders);
        mgr.logger.log(`Prepared ${activatedOrders.length} virtual ${filledType} orders for on-chain placement`, 'debug');

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

            // CRITICAL: Temporarily mark all partials as VIRTUAL so they don't block each other's moves
            // AND capture their original state/data for accurate target calculations
            const originalPartialData = new Map();
            for (const p of partialOrders) {
                originalPartialData.set(p.id, { ...p });
                p.state = ORDER_STATES.VIRTUAL;
            }

            try {
                const reservedGridIds = new Set();
                let accumulatedResidualCapital = 0;

                for (let i = 0; i < partialOrders.length; i++) {
                    const p = partialOrders[i];
                    const isInnermost = (i === partialOrders.length - 1);
                    
                    // ANCHOR STRATEGY: We never shift partial orders to new slots (moveDist = 0)
                    // We only update their sizes in their current positions.
                    const moveInfo = this.preparePartialOrderMove(p, 0, reservedGridIds);
                    
                    if (!moveInfo) {
                        mgr.logger.log(`Could not prepare anchor for partial ${p.id}`, 'warn');
                        continue;
                    }

                    // ENSURE moveInfo.targetGridOrder reflects the original data (with original size)
                    // if it happened to be one of our ghost-virtualized orders.
                    // This is critical both for moves and for anchoring (moveDist=0).
                    if (originalPartialData.has(moveInfo.newGridId)) {
                        moveInfo.targetGridOrder = originalPartialData.get(moveInfo.newGridId);
                    } else {
                        // If it's not in our ghost list, it must be a truly VIRTUAL slot.
                        // Fetch the latest from the manager to be sure we have the size.
                        moveInfo.targetGridOrder = mgr.orders.get(moveInfo.newGridId);
                    }

                    // CRITICAL: Evaluate anchor while states are still VIRTUAL
                    const isAnchorDecision = this.evaluatePartialOrderAnchor(p, moveInfo);
                    const idealSize = isAnchorDecision.idealSize;

                    if (!isInnermost) {
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
                        const totalResidualCapital = accumulatedResidualCapital + (isAnchorDecision.residualCapital || 0);
                        const residualSize = totalResidualCapital / p.price;
                        const mergedSize = idealSize + residualSize;
                        const dustThresholdPercent = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE || 5;
                        const maxMergedSize = idealSize * (1 + dustThresholdPercent / 100);
                        const shouldMerge = isAnchorDecision.isDust && mergedSize <= maxMergedSize;

                        if (shouldMerge) {
                            mgr.logger.log(`[MULTI-PARTIAL MERGE] Innermost Partial ${oppositeType} ${p.id}: size=${p.size.toFixed(8)} absorbing ${totalResidualCapital.toFixed(8)} residual. New size: ${mergedSize.toFixed(8)}.`, 'info');
                            const dustRefillInfo = {
                                ...moveInfo,
                                partialOrder: {
                                    ...moveInfo.partialOrder, size: mergedSize, isDustRefill: true,
                                    isDoubleOrder: true, mergedDustSize: residualSize, filledSinceRefill: 0, pendingRotation: true
                                },
                                newSize: mergedSize, isDustRefill: true
                            };
                            partialMoves.push(dustRefillInfo);
                        } else {
                            mgr.logger.log(`[MULTI-PARTIAL SPLIT] Innermost Partial ${oppositeType} ${p.id}: size=${p.size.toFixed(8)} -> upgrading to ideal=${idealSize.toFixed(8)}.`, 'info');
                            const anchorMoveInfo = {
                                ...moveInfo,
                                partialOrder: { ...moveInfo.partialOrder, size: idealSize },
                                newSize: idealSize
                            };
                            partialMoves.push(anchorMoveInfo);

                            const spreadOrders = Array.from(mgr.orders.values())
                                .filter(o => o.type === oppositeType && o.state === ORDER_STATES.SPREAD);
                            const spreadPrice = spreadOrders.length > 0
                                ? (oppositeType === ORDER_TYPES.BUY ? Math.max(...spreadOrders.map(o => o.price)) : Math.min(...spreadOrders.map(o => o.price)))
                                : moveInfo.newPrice;

                            const precision = getPrecisionForSide(mgr.assets, side);
                            const { floatToBlockchainInt, blockchainToFloat } = require('./utils');
                            let residualOrderSize = 0;
                            if (totalResidualCapital > 0) {
                                residualOrderSize = blockchainToFloat(floatToBlockchainInt(totalResidualCapital / spreadPrice, precision), precision);
                            } else {
                                const cache = getCacheFundsValue(mgr.funds, side);
                                residualOrderSize = blockchainToFloat(floatToBlockchainInt(cache / count, precision), precision);
                            }

                            if (residualOrderSize > 0) {
                                const residualOrder = {
                                    id: null, type: oppositeType, price: spreadPrice, size: residualOrderSize,
                                    state: ORDER_STATES.VIRTUAL, isResidualFromAnchor: true, anchoredFromPartialId: p.id
                                };
                                ordersToPlace.push(residualOrder);
                                mgr.logger.log(`[RESIDUAL ORDER] Created replacement ${oppositeType} order at spread price ${spreadPrice.toFixed(4)}, size ${residualOrderSize.toFixed(8)}`, 'info');
                            }
                        }
                    }
                }
            } finally {
                for (const p of partialOrders) {
                    if (originalPartialData.has(p.id)) {
                        p.state = originalPartialData.get(p.id).state;
                    }
                }
            }
        }

        const currentActiveCount = countOrdersByType(oppositeType, mgr.orders);
        let targetCount = 1; 
        if (mgr.config.activeOrders && mgr.config.activeOrders[side] && Number.isFinite(mgr.config.activeOrders[side])) {
            targetCount = Math.max(1, mgr.config.activeOrders[side]);
        }

        const belowTarget = currentActiveCount < targetCount;

        if (belowTarget) {
            const shortage = targetCount - currentActiveCount;
            const ordersToCreate = Math.min(shortage, count);
            mgr.logger.log(`Active ${oppositeType} orders (${currentActiveCount}) below target (${targetCount}). Creating ${ordersToCreate} new orders.`, 'info');

            const vacatedSlots = partialMoves
                .filter(m => m.partialOrder.type === oppositeType && m.vacatedGridId)
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
                const { floatToBlockchainInt, blockchainToFloat } = require('./utils');
                const quantizedSize = blockchainToFloat(floatToBlockchainInt(sizePerOrder, precision), precision);

                const newOrder = { ...gridOrder, type: oppositeType, size: quantizedSize, price: slot.price };
                ordersToPlace.push(newOrder);
                ordersCreated++;
                mgr.logger.log(`Using vacated partial slot ${slot.id} for new ${oppositeType} at price ${slot.price.toFixed(4)}, size ${quantizedSize.toFixed(8)}`, 'info');
            }

            if (ordersCreated < ordersToCreate) {
                const remaining = ordersToCreate - ordersCreated;
                const newOrders = await this.activateClosestVirtualOrdersForPlacement(oppositeType, remaining, excludeOrderIds);
                ordersToPlace.push(...newOrders);
            }
        } else {
            const rotatedOrders = await this.prepareFurthestOrdersForRotation(
                oppositeType, count, excludeOrderIds, filledCount,
                {
                    avoidPrices: partialMoves.map(m => m.newPrice),
                    preferredSlots: partialMoves.filter(m => m.partialOrder.type === oppositeType).map(m => ({ id: m.vacatedGridId, price: m.vacatedPrice })),
                    partialMoves: partialMoves
                }
            );
            ordersToRotate.push(...rotatedOrders);
        }

        return { ordersToPlace, ordersToRotate, partialMoves };
    }

    /**
     * Evaluate whether a partial order should be treated as "Dust" or "Substantial".
     */
    evaluatePartialOrderAnchor(partialOrder, moveInfo) {
        const mgr = this.manager;
        if (!moveInfo || !moveInfo.targetGridOrder) {
            return { isDust: true, idealSize: partialOrder.size || 0, percentOfIdeal: 0 };
        }

        // The targetGridOrder should represent the geometric ideal for that slot.
        const idealSize = moveInfo.targetGridOrder.size || partialOrder.size || 0;
        const partialSize = partialOrder.size || 0;

        if (idealSize <= 0) {
            mgr.logger.log(`Cannot evaluate partial order ${partialOrder.id}: target grid slot has no ideal size`, 'warn');
            return { isDust: true, idealSize, percentOfIdeal: 0 };
        }

        const percentOfIdeal = partialSize / idealSize;

        if (percentOfIdeal < (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE || 5) / 100) {
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
            
            // Filter spread slots to ensure they are on the correct side of the marketAction
            // For BUY rotation (moving outermost buy to spread): target must be < startPrice
            // For SELL rotation (moving outermost sell to spread): target must be > startPrice
            const spreadOrders = allSpreadOrders.filter(o => 
                targetType === ORDER_TYPES.BUY 
                    ? o.price < mgr.config.startPrice 
                    : o.price > mgr.config.startPrice
            );

            if (spreadOrders.length === 0) {
                mgr.logger.log(`No eligible SPREAD slots available for ${targetType} rotation`, 'warn');
                break;
            }

            // Create a copy before sorting
            const sortedSpreads = [...spreadOrders];

            // Sort spread slots by closeness to market action
            // For BUY: higher price is closer
            // For SELL: lower price is closer
            sortedSpreads.sort((a, b) =>
                targetType === ORDER_TYPES.BUY
                    ? b.price - a.price // Highest first
                    : a.price - b.price // Lowest first
            );

            const targetSpreadSlot = sortedSpreads[0];

            const rotatedOrder = { 
                oldOrder: { ...order }, 
                newPrice: targetSpreadSlot.price, 
                newGridId: targetSpreadSlot.id, 
                newSize: fundsPerOrder,
                type: targetType
            };

            const virtualOrder = { ...targetSpreadSlot, type: targetType, size: fundsPerOrder, state: ORDER_STATES.VIRTUAL };
            mgr.accountant.updateOptimisticFreeBalance(order, virtualOrder, 'rotation');
            mgr._updateOrder(virtualOrder);
            rotated.push(rotatedOrder);
            mgr.shadowOrderIds.set(order.orderId, Date.now());
        }
        return rotated;
    }

    /**
     * Complete an order rotation after blockchain confirmation.
     */
    completeOrderRotation(oldOrderInfo) {
        const mgr = this.manager;
        const oldGridOrder = mgr.orders.get(oldOrderInfo.id);
        if (oldGridOrder && oldGridOrder.orderId === oldOrderInfo.orderId) {
            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SPREAD, size: 0, orderId: null };
            mgr._updateOrder(updatedOld);
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
            partialOrder: { id: partialOrder.id, orderId: partialOrder.orderId, type: partialOrder.type, price: partialOrder.price, size: partialOrder.size },
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
            const newState = partialOrder.size >= (targetGridOrder.size || 0) ? ORDER_STATES.ACTIVE : ORDER_STATES.PARTIAL;
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
        const spreadOrders = allSpreadOrders
            .filter(o => (targetType === ORDER_TYPES.BUY && o.price < mgr.config.startPrice) || (targetType === ORDER_TYPES.SELL && o.price > mgr.config.startPrice))
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
        const maxByFunds = minSize > 0 ? Math.floor(availableFunds / minSize) : desiredCount;
        const ordersToCreate = Math.max(0, Math.min(desiredCount, maxByFunds || desiredCount));

        if (ordersToCreate === 0) {
            mgr.logger.log(`Insufficient funds to create any ${targetType} orders (available=${availableFunds}, minOrderSize=${minSize})`, 'warn');
            return [];
        }

        const actualOrders = spreadOrders.slice(0, ordersToCreate);
        const fundsPerOrder = availableFunds / actualOrders.length;

        if (fundsPerOrder < minSize) {
            mgr.logger.log(`Available funds insufficient for requested orders: fundsPerOrder=${fundsPerOrder} < minOrderSize=${minSize}`, 'warn');
            return [];
        }

        const activatedOrders = [];
        actualOrders.forEach(order => {
            if (fundsPerOrder <= 0) return;
            const activatedOrder = { ...order, type: targetType, size: fundsPerOrder, state: ORDER_STATES.ACTIVE };
            mgr.accountant.updateOptimisticFreeBalance(order, activatedOrder, 'spread-activation');
            mgr._updateOrder(activatedOrder);
            activatedOrders.push(activatedOrder);
            mgr.currentSpreadCount--;
            mgr.logger.log(`Prepared ${targetType} order at ${order.price.toFixed(2)} (Amount: ${fundsPerOrder.toFixed(8)})`, 'info');
        });

        return activatedOrders;
    }
}

module.exports = StrategyEngine;