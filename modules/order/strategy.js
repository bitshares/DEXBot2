/**
 * modules/order/strategy.js
 *
 * Physical Rail Maintenance Strategy (Contiguous Window Version)
 * Maintains side-pinned contiguous physical shifts with fixed grid integrity.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, FEE_PARAMETERS, PRECISION_DEFAULTS } = require('../constants');
const {
    getPrecisionForSide,
    getAssetFees,
    allocateFundsByWeights,
    calculateOrderCreationFees
} = require('./utils');

class StrategyEngine {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Unified rebalancing entry point.
     * Maintains contiguous physical rails for BUY and SELL sides.
     */
    async rebalance(fills = [], excludeIds = new Set()) {
        const mgr = this.manager;
        mgr.logger.log(`[UNIFIED] Starting contiguous physical rail rebalance.`, 'info');
        
        const allOrders = Array.from(mgr.orders.values());
        
        // 1. Partition Slots by Rail (Fixed ID Isolation)
        // BUY RAIL: Sorted Inward First (Highest Price @ Index 0)
        const buySlots = allOrders.filter(o => o.id.startsWith('buy-')).sort((a, b) => b.price - a.price);
        // SELL RAIL: Sorted Inward First (Lowest Price @ Index 0)
        const sellSlots = allOrders.filter(o => o.id.startsWith('sell-')).sort((a, b) => a.price - b.price);

        // 2. Identify Fill Context
        const filledSide = (fills.length > 0) ? fills[0].type : null;

        // 3. Identify Side Budgets
        const snap = mgr.getChainFundsSnapshot ? mgr.getChainFundsSnapshot() : {};
        
        // 4. Process Rails Independently
        const buyResult = await this.rebalanceSideLogic(ORDER_TYPES.BUY, buySlots, snap.chainTotalBuy, excludeIds, filledSide === ORDER_TYPES.BUY, filledSide != null);
        const sellResult = await this.rebalanceSideLogic(ORDER_TYPES.SELL, sellSlots, snap.chainTotalSell, excludeIds, filledSide === ORDER_TYPES.SELL, filledSide != null);
        
        const result = {
            ordersToPlace: [...buyResult.ordersToPlace, ...sellResult.ordersToPlace],
            ordersToRotate: [...buyResult.ordersToRotate, ...sellResult.ordersToRotate],
            ordersToUpdate: [...buyResult.ordersToUpdate, ...sellResult.ordersToUpdate],
            ordersToCancel: [...buyResult.ordersToCancel, ...sellResult.ordersToCancel],
            hadRotation: (buyResult.ordersToRotate.length > 0 || sellResult.ordersToRotate.length > 0),
            partialMoves: []
        };
        
        mgr.logger.log(`[UNIFIED] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate, ${result.ordersToUpdate.length} update.`, 'info');
        
        return result;
    }

    /**
     * Contiguous Rail Maintenance Logic.
     * Manages a sliding window of ACTIVE orders over the fixed rail.
     */
    async rebalanceSideLogic(type, slots, sideBudget, excludeIds, wasFilledSide, anyFillOccurred) {
        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';
        if (slots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [] };

        // 1. Determine targetCount and geometric ideal sizing
        const targetCount = Math.max(1, mgr.config.activeOrders[side]);
        const btsFees = ((mgr.config.assetA === 'BTS' && side === 'sell') || (mgr.config.assetB === 'BTS' && side === 'buy'))
            ? calculateOrderCreationFees(mgr.config.assetA, mgr.config.assetB, targetCount, 5) : 0;
        const availableBudget = Math.max(0, sideBudget - btsFees);
        const precision = getPrecisionForSide(mgr.assets, side);
        const weight = mgr.config.weightDistribution[side];
        const idealSizes = allocateFundsByWeights(availableBudget, slots.length, weight, mgr.config.incrementPercent / 100, false, 0, precision);

        // 2. Identify current physical active indices (Inward-First sorting)
        // Indices are 0 (closest to market) to N (furthest from market)
        let activeOnChain = slots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !excludeIds.has(s.id));
        let activeIndices = activeOnChain.map(o => slots.findIndex(s => s.id === o.id)).sort((a, b) => a - b);

        // 3. Sliding Window Transition
        let nextIndices = [...activeIndices];
        if (activeIndices.length === 0) {
            // First run or recovery: find first non-spread slot
            const start = Math.max(0, slots.findIndex(s => s.type !== ORDER_TYPES.SPREAD));
            nextIndices = Array.from({length: targetCount}, (_, i) => (start !== -1 ? start : 3) + i);
        } else {
            if (wasFilledSide) {
                // Fill Side: Expand Outward (maintain count)
                // e.g. [3, 4, 5] -> 3 filled -> [4, 5] -> add 6 -> [4, 5, 6]
                if (nextIndices.length < targetCount) {
                    nextIndices.push(Math.max(...nextIndices) + 1);
                }
            } else if (anyFillOccurred) {
                // Opposite Side: Shift Inward (rotation)
                // e.g. [3, 4, 5] -> shift in -> [2, 3, 4]
                const innerEdge = Math.min(...nextIndices);
                if (innerEdge > 0) {
                    nextIndices = nextIndices.map(i => i - 1);
                }
            }
        }

        // Force exactly targetCount and contiguity
        if (nextIndices.length > 0) {
            const min = Math.min(...nextIndices);
            nextIndices = Array.from({length: targetCount}, (_, i) => Math.max(0, min + i));
        }

        const targetIndexSet = new Set(nextIndices);
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToUpdate = [];
        const ordersToCancel = [];

        // 4. Resolve Shortages and Surpluses
        const shortages = nextIndices.filter(idx => !slots[idx].orderId || excludeIds.has(slots[idx].id));
        const surpluses = slots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !targetIndexSet.has(slots.findIndex(o => o.id === s.id)));

        // Pair Rotations: Furthest Surplus to Nearest Shortage
        surpluses.sort((a, b) => b.price - a.price); // FURTHEST
        shortages.sort((a, b) => a - b); // NEAREST (indices are inward-first)

        const pairCount = Math.min(surpluses.length, shortages.length);
        for (let i = 0; i < pairCount; i++) {
            const surplus = surpluses[i];
            const shortageIdx = shortages[i];
            const shortageSlot = slots[shortageIdx];
            const idealSize = idealSizes[shortageIdx];

            ordersToRotate.push({
                oldOrder: { ...surplus },
                newPrice: shortageSlot.price, // FIXED Grid Price
                newSize: idealSize,
                newGridId: shortageSlot.id,
                type: type
            });
            mgr._updateOrder({ ...surplus, state: ORDER_STATES.VIRTUAL });
            mgr._updateOrder({ ...shortageSlot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
            mgr.logger.log(`[UNIFIED] Rotation: Shifting furthest ${type} ${surplus.id} -> contiguous slot ${shortageSlot.id}.`, 'info');
        }

        // New Placements (remaining shortages)
        for (let i = pairCount; i < shortages.length; i++) {
            const idx = shortages[i];
            const slot = slots[idx];
            const idealSize = idealSizes[idx];
            ordersToPlace.push({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
            mgr._updateOrder({ ...slot, type: type, size: idealSize, state: ORDER_STATES.ACTIVE });
            mgr.logger.log(`[UNIFIED] Expansion: Placing ${type} at fixed edge slot ${slot.id}.`, 'info');
        }

        // Surplus Cancellations (remaining surpluses)
        for (let i = pairCount; i < surpluses.length; i++) {
            const surplus = surpluses[i];
            ordersToCancel.push({ ...surplus });
            mgr._updateOrder({ ...surplus, state: ORDER_STATES.VIRTUAL, orderId: null });
            mgr.logger.log(`[UNIFIED] Surplus: Cancelling out-of-window ${type} order ${surplus.id}.`, 'info');
        }

        // 5. In-Place Maintenance (Resize & Merge)
        for (const idx of nextIndices) {
            const slot = slots[idx];
            if (!slot.orderId || excludeIds.has(slot.id)) continue;
            if (ordersToRotate.some(r => r.oldOrder.id === slot.id)) continue;
            
            const idealSize = idealSizes[idx];
            if (slot.state === ORDER_STATES.PARTIAL) {
                const dustThreshold = idealSize * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
                if (slot.size < dustThreshold) {
                    const mergedSize = idealSize + slot.size;
                    ordersToUpdate.push({ partialOrder: { ...slot }, newSize: mergedSize, isSplitUpdate: true, newState: ORDER_STATES.ACTIVE });
                    mgr._updateOrder({ ...slot, size: mergedSize, state: ORDER_STATES.ACTIVE });
                    mgr.logger.log(`[UNIFIED] Merge: Dust partial ${slot.id} refilled to ${mergedSize.toFixed(precision)}.`, 'info');
                } else {
                    ordersToUpdate.push({ partialOrder: { ...slot }, newSize: idealSize, isSplitUpdate: true, newState: ORDER_STATES.ACTIVE });
                    mgr._updateOrder({ ...slot, size: idealSize, state: ORDER_STATES.ACTIVE });
                    mgr.logger.log(`[UNIFIED] Anchor: Substantial partial ${slot.id} resized to ideal.`, 'info');
                }
            } else if (Math.abs(slot.size - idealSize) > 1e-8) {
                ordersToUpdate.push({ partialOrder: { ...slot }, newSize: idealSize, isSplitUpdate: true, newState: ORDER_STATES.ACTIVE });
                mgr._updateOrder({ ...slot, size: idealSize });
                mgr.logger.log(`[UNIFIED] Maintenance: Resizing active ${slot.id} to ${idealSize.toFixed(precision)}.`, 'info');
            }
        }

        // 6. Role Assignment: Ensure Spread Buffer is correctly labeled
        const minActiveIdx = Math.min(...nextIndices);
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (i < minActiveIdx) {
                slot.type = ORDER_TYPES.SPREAD; // Inward from window is the Spread Zone
            } else {
                slot.type = type; // Window and Outward are the Asset Rail
            }
        }

        return { ordersToPlace, ordersToRotate, ordersToUpdate, ordersToCancel };
    }

    /**
     * Complete an order rotation after blockchain confirmation.
     */
    completeOrderRotation(oldOrderInfo) {
        const mgr = this.manager;
        const oldGridOrder = mgr.orders.get(oldOrderInfo.id);
        if (oldGridOrder && oldGridOrder.orderId === oldOrderInfo.orderId) {
            const size = oldGridOrder.size || 0;
            if (oldGridOrder.type === ORDER_TYPES.BUY) mgr.accountTotals.buyFree = (mgr.accountTotals.buyFree || 0) + size;
            else if (oldGridOrder.type === ORDER_TYPES.SELL) mgr.accountTotals.sellFree = (mgr.accountTotals.sellFree || 0) + size;

            const updatedOld = { ...oldGridOrder, state: ORDER_STATES.VIRTUAL, orderId: null };
            mgr._updateOrder(updatedOld);
            mgr.logger.log(`Rotated order ${oldOrderInfo.id} -> VIRTUAL (capital preserved).`, 'info');
        }
    }

    /**
     * Process filled orders and trigger rebalance.
     */
    async processFilledOrders(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!mgr || !Array.isArray(filledOrders)) return;

        mgr.logger.log(`>>> processFilledOrders() with ${filledOrders.length} orders`, 'info');
        mgr.pauseFundRecalc();

        try {
            const hasBtsPair = (mgr.config?.assetA === 'BTS' || mgr.config?.assetB === 'BTS');
            let fillsToSettle = 0;

            for (const filledOrder of filledOrders) {
                if (excludeOrderIds?.has?.(filledOrder.id)) continue;
                
                const isPartial = filledOrder.isPartial === true;
                if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                    fillsToSettle++;
                    // Release capital immediately
                    mgr._updateOrder({ ...filledOrder, state: ORDER_STATES.VIRTUAL, orderId: null });
                }

                // Balance Accounting
                if (filledOrder.type === ORDER_TYPES.SELL) {
                    mgr.funds.cacheFunds.buy = (mgr.funds.cacheFunds.buy || 0) + (filledOrder.size * filledOrder.price);
                } else {
                    mgr.funds.cacheFunds.sell = (mgr.funds.cacheFunds.sell || 0) + (filledOrder.size / filledOrder.price);
                }
            }

            if (hasBtsPair && fillsToSettle > 0) {
                const btsFeeData = getAssetFees('BTS', 0);
                mgr.funds.btsFeesOwed += fillsToSettle * btsFeeData.total;
                await mgr.accountant.deductBtsFees();
            }

            mgr.recalculateFunds();
            await mgr._persistCacheFunds();

            const result = await this.rebalance(filledOrders, excludeOrderIds);

            if (hasBtsPair && (result.ordersToRotate.length > 0 || result.ordersToUpdate.length > 0)) {
                const btsFeeData = getAssetFees('BTS', 0);
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
}

module.exports = StrategyEngine;
