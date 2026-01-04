/**
 * modules/order/strategy.js
 *
 * Physical Rail Maintenance Strategy (Contiguous Window Version)
 * Maintains side-pinned contiguous physical shifts with fixed grid integrity.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, FEE_PARAMETERS, PRECISION_DEFAULTS } = require("../constants");
const {
    getPrecisionForSide,
    getAssetFees,
    allocateFundsByWeights,
    calculateOrderCreationFees,
    floatToBlockchainInt,
    blockchainToFloat
} = require("./utils");

class StrategyEngine {
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Unified rebalancing entry point.
     * Consolidates fills, rotations, and maintenance into a single standardized flow.
     * Maintains contiguous physical rails for BUY and SELL sides by sliding active windows.
     *
     * @param {Array} fills - Recent fills detected (optional)
     * @param {Set} excludeIds - IDs to skip during processing
     * @returns {Object} A batch of operations to execute on-chain
     */
    async rebalance(fills = [], excludeIds = new Set()) {
        const mgr = this.manager;
        mgr.logger.log("[UNIFIED] Starting contiguous physical rail rebalance.", "info");
        
        const allOrders = Array.from(mgr.orders.values());
        
        const buySlots = allOrders.filter(o => (o.id && String(o.id).startsWith("buy-")) || o.type === ORDER_TYPES.BUY).sort((a, b) => b.price - a.price);
        const sellSlots = allOrders.filter(o => (o.id && String(o.id).startsWith("sell-")) || o.type === ORDER_TYPES.SELL).sort((a, b) => a.price - b.price);

        const filledSide = (fills.length > 0) ? fills[0].type : null;

        const snap = mgr.getChainFundsSnapshot ? mgr.getChainFundsSnapshot() : {};
        const budgetBuy = Math.max(snap.chainTotalBuy || 0, snap.allocatedBuy || 0, (mgr.funds?.total?.grid?.buy || 0));
        const budgetSell = Math.max(snap.chainTotalSell || 0, snap.allocatedSell || 0, (mgr.funds?.total?.grid?.sell || 0));

        if (budgetBuy === 0 && budgetSell === 0) {
            mgr.logger.log("[UNIFIED] WARNING: No budget available for rebalancing (buy: 0, sell: 0)", "warn");
        }
        if (budgetBuy === 0) {
            mgr.logger.log("[UNIFIED] INFO: Buy side has no budget", "debug");
        }
        if (budgetSell === 0) {
            mgr.logger.log("[UNIFIED] INFO: Sell side has no budget", "debug");
        }

        const buyResult = await this.rebalanceSideLogic(ORDER_TYPES.BUY, buySlots, budgetBuy, excludeIds, filledSide === ORDER_TYPES.BUY, filledSide != null);
        const sellResult = await this.rebalanceSideLogic(ORDER_TYPES.SELL, sellSlots, budgetSell, excludeIds, filledSide === ORDER_TYPES.SELL, filledSide != null);
        
        const allUpdates = [...buyResult.stateUpdates, ...sellResult.stateUpdates]; 
        allUpdates.forEach(upd => mgr._updateOrder(upd)); 

        const result = {
            ordersToPlace: [...buyResult.ordersToPlace, ...sellResult.ordersToPlace],
            ordersToRotate: [...buyResult.ordersToRotate, ...sellResult.ordersToRotate],
            ordersToUpdate: [...buyResult.ordersToUpdate, ...sellResult.ordersToUpdate],
            ordersToCancel: [...buyResult.ordersToCancel, ...sellResult.ordersToCancel],
            hadRotation: (buyResult.ordersToRotate.length > 0 || sellResult.ordersToRotate.length > 0),
            partialMoves: []
        };
        
        mgr.logger.log(`[UNIFIED] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate, ${result.ordersToUpdate.length} update.`, "info");
        
        return result;
    }

    /**
     * Contiguous Rail Maintenance Logic for a specific side.
     * Manages a sliding window of ACTIVE orders over the fixed physical grid.
     * Implements directional sliding: expansion on fill-side, rotation on opposite side.
     *
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Array} slots - Grid slots belonging to this side (sorted inward-first)
     * @param {number} sideBudget - Total strategy budget for this side
     * @param {Set} excludeIds - IDs to skip
     * @param {boolean} wasFilledSide - True if a fill occurred on this rail
     * @param {boolean} anyFillOccurred - True if any fill occurred in this rebalance cycle
     */
    async rebalanceSideLogic(type, slots, sideBudget, excludeIds, wasFilledSide, anyFillOccurred) {
        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
        if (slots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };

        const stateUpdates = [];

        const targetCount = (mgr.config.activeOrders && Number.isFinite(mgr.config.activeOrders[side])) ? Math.max(1, mgr.config.activeOrders[side]) : 1;
        let btsFeesReservation = 0;
        if ((mgr.config.assetA === "BTS" && side === "sell") || (mgr.config.assetB === "BTS" && side === "buy")) {
            btsFeesReservation = calculateOrderCreationFees(mgr.config.assetA, mgr.config.assetB, targetCount, FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER);
        }
        const availableBudget = (sideBudget > btsFeesReservation * 10) 
            ? Math.max(0, sideBudget - btsFeesReservation)
            : sideBudget;

        const precision = getPrecisionForSide(mgr.assets, side);
        const weight = mgr.config.weightDistribution[side];
        const idealSizes = allocateFundsByWeights(availableBudget, slots.length, weight, mgr.config.incrementPercent / 100, false, 0, precision);

        let activeOnChain = slots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !excludeIds.has(s.id));
        let activeIndices = activeOnChain.map(o => slots.findIndex(s => s.id === o.id)).sort((a, b) => a - b);

        let nextIndices = [...activeIndices];
        if (activeIndices.length === 0) {
            const start = Math.max(0, slots.findIndex(s => s.type !== ORDER_TYPES.SPREAD));
            const fallbackStart = Math.max(0, Math.floor(slots.length / 2) - Math.floor(targetCount / 2));
            nextIndices = Array.from({length: targetCount}, (_, i) => (start !== -1 ? start : fallbackStart) + i);
        } else {
            if (wasFilledSide) {
                if (nextIndices.length < targetCount && nextIndices.length > 0) {
                    const maxIdx = Math.max(...nextIndices);
                    const minIdx = Math.min(...nextIndices);
                    if (maxIdx + 1 < slots.length) {
                        nextIndices.push(maxIdx + 1);
                    } else if (minIdx > 0) {
                        nextIndices.unshift(minIdx - 1);
                    }
                }
            } else if (anyFillOccurred) {
                if (nextIndices.length > 0) {
                    const innerEdge = Math.min(...nextIndices);
                    if (innerEdge > 0) {
                        nextIndices = nextIndices.map(i => i - 1);
                    }
                }
            }
        }

        if (nextIndices.length > 0) {
            const min = Math.min(...nextIndices);
            nextIndices = Array.from({length: targetCount}, (_, i) => min + i)
                .filter(idx => idx >= 0 && idx < slots.length);
        }

        if (nextIndices.length > 0) {
            const max = Math.max(...nextIndices);
            if (max >= slots.length) {
                mgr.logger.log(`[UNIFIED] WARN: Window exceeds slot bounds (${max} >= ${slots.length}), trimming indices`, "warn");
                nextIndices = nextIndices.filter(idx => idx < slots.length);
            }
            if (nextIndices.length < targetCount && slots.length > 0) {
                mgr.logger.log(`[UNIFIED] DEBUG: Window reduced from ${targetCount} to ${nextIndices.length} due to boundary constraints`, "debug");
            }
        }

        // ROLE ASSIGNMENT: Ensure spread zone roles are assigned transactionally
        if (nextIndices.length > 0) {
            const minActiveIdx = Math.min(...nextIndices);
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                const expectedType = (i < minActiveIdx) ? ORDER_TYPES.SPREAD : type;
                if (slot.type !== expectedType) {
                    stateUpdates.push({ ...slot, type: expectedType });
                }
            }
        }

        const targetIndexSet = new Set(nextIndices);
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToUpdate = [];
        const ordersToCancel = [];

        const shortages = nextIndices.filter(idx => slots[idx] && (!slots[idx].orderId || excludeIds.has(slots[idx].id)));
        const surpluses = slots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !targetIndexSet.has(slots.findIndex(o => o.id === s.id)));

        surpluses.sort((a, b) => b.price - a.price);
        shortages.sort((a, b) => a - b);

        const pairCount = Math.min(surpluses.length, shortages.length);
        for (let i = 0; i < pairCount; i++) {
            const surplus = surpluses[i];
            const shortageIdx = shortages[i];
            const shortageSlot = slots[shortageIdx];
            const idealSize = idealSizes[shortageIdx];

            ordersToRotate.push({
                oldOrder: { ...surplus },
                newPrice: shortageSlot.price,
                newSize: idealSize,
                newGridId: shortageSlot.id,
                type: type
            });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL });
            stateUpdates.push({ ...shortageSlot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
            mgr.logger.log(`[UNIFIED] Rotation: Shifting furthest ${type} ${surplus.id} -> contiguous slot ${shortageSlot.id}.`, "info");
        }

        for (let i = pairCount; i < shortages.length; i++) {
            const idx = shortages[i];
            const slot = slots[idx];
            const idealSize = idealSizes[idx];
            ordersToPlace.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
            stateUpdates.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
            mgr.logger.log(`[UNIFIED] Expansion: Placing ${type} at fixed edge slot ${slot.id}.`, "info");
        }

        for (let i = pairCount; i < surpluses.length; i++) {
            const surplus = surpluses[i];
            ordersToCancel.push({ ...surplus });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL, orderId: null });
            mgr.logger.log(`[UNIFIED] Surplus: Cancelling out-of-window ${type} order ${surplus.id}.`, "info");
        }

        const allOnChain = slots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL));
        
        for (const slot of allOnChain) {
            const wasRotationSource = ordersToRotate.some(r => r.oldOrder.id === slot.id);
            if (wasRotationSource) continue;

            const slotIdx = slots.findIndex(s => s.id === slot.id);
            const idealSize = idealSizes[slotIdx];

            if (slot.isDoubleOrder) continue;

            if (slot.state === ORDER_STATES.PARTIAL) {
                const dustThreshold = idealSize * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
                const availableFunds = mgr.funds.available[side];

                if (slot.size < dustThreshold) {
                    if (availableFunds > 0) {
                        const fundableIdealSize = Math.min(idealSize, availableFunds);
                        const mergedSize = slot.size + fundableIdealSize;
                        
                        if (mergedSize <= idealSize * 1.05) {
                            const rotIdx = ordersToRotate.findIndex(r => r.oldOrder.orderId === slot.orderId);
                            if (rotIdx !== -1) {
                                ordersToRotate[rotIdx].newSize = mergedSize;
                            } else {
                                ordersToUpdate.push({ 
                                    partialOrder: { ...slot }, 
                                    newSize: mergedSize, 
                                    isSplitUpdate: true, 
                                    newState: ORDER_STATES.ACTIVE 
                                });
                            }

                            stateUpdates.push({ 
                                ...slot, 
                                size: mergedSize, 
                                state: ORDER_STATES.ACTIVE,
                                isDoubleOrder: true,
                                mergedDustSize: slot.size,
                                filledSinceRefill: 0,
                                pendingRotation: true
                            });
                            mgr.logger.log(`[UNIFIED] MERGE: Dust partial ${slot.id} (${slot.size.toFixed(precision)}) absorbing ${fundableIdealSize.toFixed(precision)} funds.`, "info");
                            continue;
                        }
                    }
                }
                
                const rotIdx = ordersToRotate.findIndex(r => r.oldOrder.orderId === slot.orderId);
                if (rotIdx !== -1) {
                    ordersToRotate[rotIdx].newSize = idealSize;
                } else {
                    ordersToUpdate.push({ 
                        partialOrder: { ...slot }, 
                        newSize: idealSize, 
                        isSplitUpdate: true, 
                        newState: ORDER_STATES.ACTIVE 
                    });
                }
                stateUpdates.push({ ...slot, size: idealSize, state: ORDER_STATES.ACTIVE });
                mgr.logger.log(`[UNIFIED] SPLIT: Anchoring partial ${slot.id} to ideal size ${idealSize.toFixed(precision)}.`, "info");
                
                if (slot.size >= dustThreshold) {
                    const minIdx = nextIndices.length > 0 ? Math.min(...nextIndices) : -1;
                    const maxIdx = nextIndices.length > 0 ? Math.max(...nextIndices) : -1;
                    
                    let targetIdx = -1;
                    if (minIdx > 0 && !slots[minIdx - 1].orderId) {
                        targetIdx = minIdx - 1;
                    } else if (maxIdx !== -1 && maxIdx + 1 < slots.length && !slots[maxIdx + 1].orderId) {
                        targetIdx = maxIdx + 1;
                    }

                    if (targetIdx !== -1) {
                        const targetSlot = slots[targetIdx];
                        if (!excludeIds.has(targetSlot.id)) {
                            ordersToPlace.push({ 
                                ...targetSlot, 
                                type: type, 
                                size: slot.size, 
                                state: ORDER_STATES.ACTIVE,
                                isResidualFromAnchor: true,
                                anchoredFromPartialId: slot.id
                            });
                            stateUpdates.push({ 
                                ...targetSlot, 
                                type: type, 
                                size: slot.size, 
                                state: ORDER_STATES.ACTIVE 
                            });
                            mgr.logger.log(`[UNIFIED] SPLIT: Created residual order ${slot.size.toFixed(precision)} for ${slot.id} at slot ${targetSlot.id}.`, "info");
                        }
                    }
                }
                continue;
            } else if (Math.abs(slot.size - idealSize) > 1e-8) {
                const rotIdx = ordersToRotate.findIndex(r => r.oldOrder.orderId === slot.orderId);
                if (rotIdx !== -1) {
                    ordersToRotate[rotIdx].newSize = idealSize;
                } else {
                    ordersToUpdate.push({
                        partialOrder: { ...slot },
                        newSize: idealSize,
                        isSplitUpdate: true,
                        newState: ORDER_STATES.ACTIVE
                    });
                }
                stateUpdates.push({ ...slot, size: idealSize });
                mgr.logger.log(`[UNIFIED] Maintenance: Resizing active ${slot.id} to ${idealSize.toFixed(precision)}.`, "info");
            }
        }

        if (nextIndices.length > 0) {
            const minActiveIdx = Math.min(...nextIndices);
            const maxActiveIdx = Math.max(...nextIndices);
            mgr.logger.log(`[UNIFIED] Active window: indices [${minActiveIdx}-${maxActiveIdx}], spread zone before ${minActiveIdx}`, "debug");
        }

        return { ordersToPlace, ordersToRotate, ordersToUpdate, ordersToCancel, stateUpdates };
    }

    completeOrderRotation(oldOrderInfo) {
        const mgr = this.manager;
        const oldGridOrder = mgr.orders.get(oldOrderInfo.id);
        if (oldGridOrder && oldGridOrder.orderId === oldOrderInfo.orderId) {
            const size = oldGridOrder.size || 0;
            if (oldGridOrder.type === ORDER_TYPES.BUY) mgr.accountTotals.buyFree = (mgr.accountTotals.buyFree || 0) + size;
            else if (oldGridOrder.type === ORDER_TYPES.SELL) mgr.accountTotals.sellFree = (mgr.accountTotals.sellFree || 0) + size;

            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr._updateOrder(updatedOld);
            mgr.logger.log(`Rotated order ${oldOrderInfo.id} -> VIRTUAL (capital preserved).`, "info");
        }
    }

    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!mgr || !Array.isArray(filledOrders)) return;

        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders`, "info");
        mgr.pauseFundRecalc();

        try {
            const hasBtsPair = (mgr.config?.assetA === "BTS" || mgr.config?.assetB === "BTS");
            let fillsToSettle = 0;

            for (const filledOrder of filledOrders) {
                if (excludeOrderIds?.has?.(filledOrder.id)) continue;
                
                const isPartial = filledOrder.isPartial === true;
                if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                    fillsToSettle++;
                    mgr._updateOrder({ ...filledOrder, state: ORDER_STATES.VIRTUAL, orderId: null });
                }

                // Balance Accounting with Market Fee deduction
                let rawProceeds = 0;
                let assetForFee = null;
                if (filledOrder.type === ORDER_TYPES.SELL) {
                    rawProceeds = filledOrder.size * filledOrder.price;
                    assetForFee = mgr.config.assetB;
                } else {
                    rawProceeds = filledOrder.size / filledOrder.price;
                    assetForFee = mgr.config.assetA;
                }

                let netProceeds = rawProceeds;
                if (assetForFee !== "BTS") {
                    try {
                        netProceeds = getAssetFees(assetForFee, rawProceeds);
                    } catch (e) {
                        mgr.logger.log(`Warning: Could not calculate market fees for ${assetForFee}: ${e.message}`, "warn");
                    }
                }

                if (filledOrder.type === ORDER_TYPES.SELL) {
                    mgr.funds.cacheFunds.buy = (mgr.funds.cacheFunds.buy || 0) + netProceeds;
                } else {
                    mgr.funds.cacheFunds.sell = (mgr.funds.cacheFunds.sell || 0) + netProceeds;
                }
            }

            if (hasBtsPair && fillsToSettle > 0) {
                const btsFeeData = getAssetFees("BTS", 0);
                mgr.funds.btsFeesOwed += fillsToSettle * btsFeeData.total;
                await mgr.accountant.deductBtsFees();
            }

            mgr.recalculateFunds();
            await mgr._persistCacheFunds();

            const result = await this.rebalance(filledOrders, excludeOrderIds);

            if (hasBtsPair && (result.ordersToRotate.length > 0 || result.ordersToUpdate.length > 0)) {
                const btsFeeData = getAssetFees("BTS", 0);
                const updateCount = result.ordersToRotate.length + result.ordersToUpdate.length;
                mgr.funds.btsFeesOwed += updateCount * btsFeeData.updateFee;
            }

            mgr.recalculateFunds();
            mgr.logger.logFundsStatus(mgr, `AFTER processFilledOrders`);

            return result;
        } finally {
            mgr.resumeFundRecalc();
        }
    }

    async rebalanceOrders(filledCounts, extraTarget = 0, excludeOrderIds = new Set()) {
        const dummyFills = [];
        if (filledCounts) {
            for (const [type, count] of Object.entries(filledCounts)) {
                const activeOnSide = Array.from(this.manager.orders.values())
                    .filter(o => o.type === type && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL))
                    .sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);
                
                for (let i = 0; i < count; i++) {
                    dummyFills.push({ type, price: this.manager.config.startPrice });
                    if (activeOnSide[i]) {
                        this.manager._updateOrder({ ...activeOnSide[i], state: ORDER_STATES.VIRTUAL, orderId: null });
                    }
                }
            }
        }
        return await this.rebalance(dummyFills, excludeOrderIds);
    }

    async rebalanceSideAfterFill(filledType, oppositeType, filledCount, extraTarget = 0, excludeOrderIds = new Set()) {
        const dummyFills = [{ type: filledType, price: this.manager.config.startPrice }];
        return await this.rebalance(dummyFills, excludeOrderIds);
    }

    evaluatePartialOrderAnchor(partialOrder, moveInfo) {
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

    async activateClosestVirtualOrdersForPlacement(targetType, count, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (count <= 0) return [];

        let virtualOrders = mgr.getOrdersByTypeAndState(targetType, ORDER_STATES.VIRTUAL);

        if (excludeOrderIds && excludeOrderIds.size > 0) {
            virtualOrders = virtualOrders.filter(o => !excludeOrderIds.has(o.id) && !excludeOrderIds.has(o.orderId) && !mgr.isOrderLocked(o.id) && !mgr.isOrderLocked(o.orderId));
        } else {
            virtualOrders = virtualOrders.filter(o => !mgr.isOrderLocked(o.id) && !mgr.isOrderLocked(o.orderId));
        }

        mgr.logger.log(`Found ${virtualOrders.length} VIRTUAL ${targetType} orders for activation`, "debug");

        virtualOrders.sort((a, b) => targetType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        const toActivate = virtualOrders.slice(0, count);
        const activated = [];

        for (const order of toActivate) {
            const currentOrder = mgr.orders.get(order.id);
            if (!currentOrder || currentOrder.state !== ORDER_STATES.VIRTUAL) continue;

            const orderSize = order.size || 0;
            if (orderSize <= 0) continue;

            const activatedOrder = { ...order, type: targetType, size: orderSize, state: ORDER_STATES.VIRTUAL };
            mgr.accountant.updateOptimisticFreeBalance(order, activatedOrder, "spread-activation", 0);

            mgr._updateOrder(activatedOrder);
            activated.push(activatedOrder);
            mgr.logger.log(`Activated virtual ${targetType} at ${order.price.toFixed(4)} (Amount: ${orderSize.toFixed(8)})`, "info");
        }
        return activated;
    }

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
            mgr.logger.log(`No active ${targetType} orders available for rotation`, "debug");
            return [];
        }

        activeOrders.sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        const toRotate = activeOrders.slice(0, count);
        const rotated = [];

        const side = targetType === ORDER_TYPES.BUY ? "buy" : "sell";
        const cache = Number(mgr.funds?.cacheFunds?.[side] || 0);
        const fundsPerOrder = toRotate.length > 0 ? cache / toRotate.length : 0;

        for (const order of toRotate) {
            const allSpreadOrders = mgr.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);

            if (allSpreadOrders.length === 0) {
                mgr.logger.log(`No SPREAD slots available for ${targetType} rotation`, "warn");
                break;
            }

            const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
            const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);

            const highestActiveBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : -Infinity;
            const lowestActiveSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : Infinity;

            const validSpreads = allSpreadOrders.filter(o =>
                o.price > highestActiveBuy && o.price < lowestActiveSell
            );

            if (validSpreads.length === 0) {
                mgr.logger.log(`No valid SPREAD slots in spread zone for ${targetType} rotation`, "warn");
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
            mgr.accountant.updateOptimisticFreeBalance(order, virtualOrder, "rotation", 0);
            
            mgr.funds.cacheFunds[side] = Math.max(0, (mgr.funds.cacheFunds[side] || 0) - fundsPerOrder);
            
            mgr._updateOrder(virtualOrder);
            rotated.push(rotatedOrder);
            mgr.shadowOrderIds.set(order.orderId, Date.now());
        }
        return rotated;
    }

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
        
        // STANDARD QUANTIZATION for minToReceive
        if (partialOrder.type === ORDER_TYPES.SELL) {
            const rawMin = partialOrder.size * newPrice;
            const prec = mgr.assets?.assetB?.precision || 8;
            newMinToReceive = blockchainToFloat(floatToBlockchainInt(rawMin, prec), prec);
        } else {
            const rawMin = partialOrder.size / newPrice;
            const prec = mgr.assets?.assetA?.precision || 8;
            newMinToReceive = blockchainToFloat(floatToBlockchainInt(rawMin, prec), prec);
        }

        return {
            partialOrder: { id: partialOrder.id, orderId: partialOrder.orderId, type: partialOrder.type, price: partialOrder.price, size: partialOrder.size, state: partialOrder.state },
            newGridId, newPrice, newMinToReceive, targetGridOrder,
            vacatedGridId: gridSlotsToMove > 0 ? partialOrder.id : null,
            vacatedPrice: gridSlotsToMove > 0 ? partialOrder.price : null
        };
    }

    completePartialOrderMove(moveInfo) {
        const mgr = this.manager;
        const { partialOrder, newGridId, newPrice } = moveInfo;

        const oldGridOrder = mgr.orders.get(partialOrder.id);
        if (oldGridOrder && (!oldGridOrder.orderId || oldGridOrder.orderId === partialOrder.orderId)) {
            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr.accountant.updateOptimisticFreeBalance(oldGridOrder, updatedOld, "move-vacate", 0);
            mgr._updateOrder(updatedOld);
        }

        const targetGridOrder = mgr.orders.get(newGridId);
        if (targetGridOrder) {
            const precision = (partialOrder.type === ORDER_TYPES.SELL)
                ? mgr.assets?.assetA?.precision || PRECISION_DEFAULTS.ASSET_FALLBACK
                : mgr.assets?.assetB?.precision || PRECISION_DEFAULTS.ASSET_FALLBACK;
            const partialInt = floatToBlockchainInt(partialOrder.size, precision);
            const idealInt = floatToBlockchainInt(targetGridOrder.size || 0, precision);
            const newState = partialInt >= idealInt ? ORDER_STATES.ACTIVE : ORDER_STATES.PARTIAL;

            const updatedNew = {
                ...targetGridOrder, ...partialOrder, type: partialOrder.type,
                state: newState, orderId: partialOrder.orderId, size: partialOrder.size, price: newPrice
            };
            mgr.accountant.updateOptimisticFreeBalance(targetGridOrder, updatedNew, "move-occupy", 0);
            mgr._updateOrder(updatedNew);
        }
    }

    async activateSpreadOrders(targetType, count) {
        const mgr = this.manager;
        if (count <= 0) return [];

        const allSpreadOrders = mgr.getOrdersByTypeAndState(ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL);

        const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
        const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE);

        const highestActiveBuy = activeBuys.length > 0 ? Math.max(...activeBuys.map(o => o.price)) : -Infinity;
        const lowestActiveSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : Infinity;

        const spreadOrders = allSpreadOrders
            .filter(o => o.price > highestActiveBuy && o.price < lowestActiveSell)
            .sort((a, b) => targetType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        const { calculateAvailableFundsValue, getMinOrderSize } = require("./utils");
        const availableFunds = calculateAvailableFundsValue(targetType === ORDER_TYPES.BUY ? "buy" : "sell", mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
        if (availableFunds <= 0) return [];

        let desiredCount = Math.min(count, spreadOrders.length);
        if (desiredCount <= 0) return [];

        const minSize = getMinOrderSize(targetType, mgr.assets, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR);
        const ordersToCreate = desiredCount;

        const activatedOrders = [];
        const side = targetType === ORDER_TYPES.BUY ? "buy" : "sell";

        for (let i = 0; i < ordersToCreate && i < spreadOrders.length; i++) {
            const currentAvailable = calculateAvailableFundsValue(side, mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
            const remainingOrders = ordersToCreate - i;
            const fundsPerOrder = remainingOrders > 0 ? currentAvailable / remainingOrders : 0;

            if (fundsPerOrder < minSize) break;

            const order = spreadOrders[i];
            const activatedOrder = { ...order, type: targetType, size: fundsPerOrder, state: ORDER_STATES.ACTIVE };
            mgr.accountant.updateOptimisticFreeBalance(order, activatedOrder, "spread-activation", 0);
            
            mgr.funds.cacheFunds[side] = Math.max(0, (mgr.funds.cacheFunds[side] || 0) - fundsPerOrder);
            
            mgr._updateOrder(activatedOrder);
            activatedOrders.push(activatedOrder);
            mgr.currentSpreadCount--;
            mgr.logger.log(`Prepared ${targetType} order ${i + 1}/${ordersToCreate} at ${order.price.toFixed(2)} (Amount: ${fundsPerOrder.toFixed(8)})`, "info");
        }

        return activatedOrders;
    }
}

module.exports = StrategyEngine;
