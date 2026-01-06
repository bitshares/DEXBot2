/**
 * modules/order/strategy.js
 *
 * Simple & Robust Pivot Strategy (Boundary-Crawl Version)
 * Maintains contiguous physical rails using a master boundary anchor.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, FEE_PARAMETERS, PRECISION_DEFAULTS } = require("../constants");
const {
    getPrecisionForSide,
    getAssetFees,
    allocateFundsByWeights,
    calculateOrderCreationFees,
    floatToBlockchainInt,
    blockchainToFloat,
    calculateAvailableFundsValue,
    getMinOrderSize
} = require("./utils");

class StrategyEngine {
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Unified rebalancing entry point.
     * Fixed-Gap Boundary Maintenance logic.
     */
    async rebalance(fills = [], excludeIds = new Set()) {
        const mgr = this.manager;
        mgr.logger.log("[BOUNDARY] Starting robust boundary-crawl rebalance.", "info");

        const allSlots = Array.from(mgr.orders.values())
            .sort((a, b) => {
                const idxA = parseInt(a.id.split('-')[1]);
                const idxB = parseInt(b.id.split('-')[1]);
                return idxA - idxB;
            });

        if (allSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], hadRotation: false, partialMoves: [] };

        // 1. Initial Boundary Determination (Recovery)
        if (mgr.boundaryIdx === undefined) {
            const referencePrice = mgr.config.startPrice;
            const step = 1 + (mgr.config.incrementPercent / 100);

            // Enforce MIN_SPREAD_FACTOR (synchronize with Grid.js)
            const minSpreadPercent = (mgr.config.incrementPercent || 0.5) * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2);
            const targetSpreadPercent = Math.max(mgr.config.targetSpreadPercent || 0, minSpreadPercent);
            const requiredSteps = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(step));
            const gapSlots = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps);

            // Find Split Point (first slot >= startPrice)
            let splitIdx = allSlots.findIndex(s => s.price >= referencePrice);
            if (splitIdx === -1) splitIdx = allSlots.length;

            const buySpread = Math.floor(gapSlots / 2);
            mgr.boundaryIdx = splitIdx - buySpread - 1;
        }

        // 2. Incremental Boundary Shift based on Fills
        for (const fill of fills) {
            if (fill.type === ORDER_TYPES.SELL) mgr.boundaryIdx++;
            else if (fill.type === ORDER_TYPES.BUY) mgr.boundaryIdx--;
        }

        mgr.boundaryIdx = Math.max(0, Math.min(allSlots.length - 1, mgr.boundaryIdx));
        const boundaryIdx = mgr.boundaryIdx;

        // 3. Define Roles and Static Gap
        const step = 1 + (mgr.config.incrementPercent / 100);
        const minSpreadPercent = (mgr.config.incrementPercent || 0.5) * (GRID_LIMITS.MIN_SPREAD_FACTOR || 2);
        const targetSpreadPercent = Math.max(mgr.config.targetSpreadPercent || 0, minSpreadPercent);
        const requiredSteps = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(step));
        const gapSlots = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS || 2, requiredSteps);

        const buyEndIdx = boundaryIdx;
        const sellStartIdx = boundaryIdx + gapSlots + 1;

        // Partition slots into Roles
        const buySlots = allSlots.slice(0, buyEndIdx + 1);
        const sellSlots = allSlots.slice(sellStartIdx);
        const spreadSlots = allSlots.slice(buyEndIdx + 1, sellStartIdx);

        // Update Slot Types
        buySlots.forEach(s => { if (s.type !== ORDER_TYPES.BUY) mgr._updateOrder({ ...s, type: ORDER_TYPES.BUY }); });
        sellSlots.forEach(s => { if (s.type !== ORDER_TYPES.SELL) mgr._updateOrder({ ...s, type: ORDER_TYPES.SELL }); });
        spreadSlots.forEach(s => { if (s.type !== ORDER_TYPES.SPREAD) mgr._updateOrder({ ...s, type: ORDER_TYPES.SPREAD }); });

        // 4. Budget Calculation (Total side budget for geometric sizing)
        const snap = mgr.getChainFundsSnapshot();

        // Target from Config (What we want)
        const targetBuy = snap.allocatedBuy + (mgr.funds.cacheFunds?.buy || 0);
        const targetSell = snap.allocatedSell + (mgr.funds.cacheFunds?.sell || 0);

        // Reality from Wallet (What we have)
        // Note: snap.chainTotalBuy already includes free + committed on-chain.
        // Combined with processFilledOrders optimistic updates, this is our total wealth.
        const realityBuy = snap.chainTotalBuy;
        const realitySell = snap.chainTotalSell;

        // Final Sizing Budgets: Cap strategy target by liquid reality
        const budgetBuy = Math.min(targetBuy, realityBuy);
        const budgetSell = Math.min(targetSell, realitySell);

        // Available Pool for net capital increases (Unreserved Cash + Surplus)
        // available already subtracts virtual reserves and fees
        const availablePoolBuy = (mgr.funds.available?.buy || 0) + (mgr.funds.cacheFunds?.buy || 0);
        const availablePoolSell = (mgr.funds.available?.sell || 0) + (mgr.funds.cacheFunds?.sell || 0);

        const reactionCap = Math.max(1, fills.length);

        // 5. Minimalist Side Rebalancing
        const buyResult = await this.rebalanceSideRobust(ORDER_TYPES.BUY, allSlots, buySlots, -1, budgetBuy, availablePoolBuy, excludeIds, reactionCap);
        const sellResult = await this.rebalanceSideRobust(ORDER_TYPES.SELL, allSlots, sellSlots, 1, budgetSell, availablePoolSell, excludeIds, reactionCap);

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

        mgr.logger.log(`[BOUNDARY] Sequence complete: ${result.ordersToPlace.length} place, ${result.ordersToRotate.length} rotate. Gap size: ${gapSlots} slots.`, "info");

        return result;
    }

    async rebalanceSideRobust(type, allSlots, sideSlots, direction, totalSideBudget, availablePool, excludeIds, reactionCap) {
        if (sideSlots.length === 0) return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [] };

        const mgr = this.manager;
        const side = type === ORDER_TYPES.BUY ? "buy" : "sell";
        const stateUpdates = [];
        const ordersToPlace = [];
        const ordersToRotate = [];
        const ordersToCancel = [];
        const ordersToUpdate = [];

        const targetCount = (mgr.config.activeOrders && Number.isFinite(mgr.config.activeOrders[side])) ? Math.max(1, mgr.config.activeOrders[side]) : sideSlots.length;

        // SORT SIDE SLOTS: Market-closest first
        // BUY: Highest price is closest. SELL: Lowest price is closest.
        const sortedSideSlots = [...sideSlots].sort((a, b) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

        const targetIndices = [];
        for (let i = 0; i < Math.min(targetCount, sortedSideSlots.length); i++) {
            targetIndices.push(allSlots.findIndex(s => s.id === sortedSideSlots[i].id));
        }
        const targetSet = new Set(targetIndices);

        const sideWeight = mgr.config.weightDistribution[side];
        const precision = getPrecisionForSide(mgr.assets, side);

        const currentGridAllocation = sideSlots
            .filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL))
            .reduce((sum, o) => sum + (Number(o.size) || 0), 0);

        // Calculate side-specific budget (Chain Total minus BTS fees reservation)
        // Only subtract fees if this side trades BTS (otherwise fees come from the OTHER side's balance)
        const hasBtsSide = (mgr.config.assetA === "BTS" || mgr.config.assetB === "BTS");
        const isBtsSide = (type === ORDER_TYPES.BUY && mgr.config.assetB === "BTS") || (type === ORDER_TYPES.SELL && mgr.config.assetA === "BTS");

        const btsFees = (hasBtsSide && isBtsSide)
            ? calculateOrderCreationFees(mgr.config.assetA, mgr.config.assetB, targetCount, FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER)
            : 0;

        const effectiveTotalSideBudget = Math.max(0, totalSideBudget - btsFees);

        const reverse = (type === ORDER_TYPES.BUY);
        const sideIdealSizes = allocateFundsByWeights(effectiveTotalSideBudget, sideSlots.length, sideWeight, mgr.config.incrementPercent / 100, reverse, 0, precision);

        // ════════════════════════════════════════════════════════════════════════════════
        // 1. GLOBAL SIDE CAPPING (The "Perfect Budget" Logic)
        // ════════════════════════════════════════════════════════════════════════════════
        // We calculate the net capital growth needed across the ENTIRE rail (all 347 slots).
        // If growth > availablePool, we scale down only the INCREASES to keep the bot within liquid limits.

        let totalSideGrowthNeeded = 0;
        const idealSizes = new Array(allSlots.length).fill(0);

        sideSlots.forEach((slot, i) => {
            const globalIdx = allSlots.findIndex(s => s.id === slot.id);
            const targetIdealSize = sideIdealSizes[i] || 0;
            idealSizes[globalIdx] = targetIdealSize;

            const oldReservedSize = Number(allSlots[globalIdx].size) || 0;
            if (targetIdealSize > oldReservedSize) {
                totalSideGrowthNeeded += (targetIdealSize - oldReservedSize);
            }
        });

        // Batch Scale: Total available / Total requested increase
        const sideScale = (totalSideGrowthNeeded > availablePool) ? (availablePool / totalSideGrowthNeeded) : 1.0;

        // Apply scale to the entire side and update state (Maintains Available=0 feature)
        const finalIdealSizes = new Array(allSlots.length).fill(0);
        sideSlots.forEach((slot) => {
            const globalIdx = allSlots.findIndex(s => s.id === slot.id);
            const targetIdealSize = idealSizes[globalIdx];
            const oldReservedSize = Number(allSlots[globalIdx].size) || 0;

            if (targetIdealSize > oldReservedSize) {
                finalIdealSizes[globalIdx] = oldReservedSize + (targetIdealSize - oldReservedSize) * sideScale;
            } else {
                finalIdealSizes[globalIdx] = targetIdealSize; // Shrinking or same: releases capital
            }

            const size = blockchainToFloat(floatToBlockchainInt(finalIdealSizes[globalIdx], precision), precision);
            stateUpdates.push({ ...slot, size: size });
        });

        if (totalSideGrowthNeeded > 0) {
            mgr.logger.log(`[CAPPING] ${side.toUpperCase()} Side Growth (Pool=${availablePool.toFixed(precision)}, Needed=${totalSideGrowthNeeded.toFixed(precision)}, Scale=${sideScale.toFixed(4)})`, "info");
        }

        // ════════════════════════════════════════════════════════════════════════════════
        // 2. REBALANCE EXECUTION (Using Capped Sizes)
        // ════════════════════════════════════════════════════════════════════════════════

        const activeOnChain = allSlots.filter(s => s.orderId && (s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL) && !excludeIds.has(s.id));
        const activeThisSide = activeOnChain.filter(s => s.type === type);

        const shortages = targetIndices.filter(idx => (!allSlots[idx].orderId || excludeIds.has(allSlots[idx].id)) && idealSizes[idx] > 0);
        const effectiveCap = (activeThisSide.length > 0) ? reactionCap : targetCount;

        // SORT SHORTAGES: Closest to market first
        // BUY: Highest price is closest. SELL: Lowest price is closest.
        shortages.sort((a, b) => {
            if (type === ORDER_TYPES.BUY) return allSlots[b].price - allSlots[a].price;
            return allSlots[a].price - allSlots[b].price;
        });

        // GREEDY CRAWL: Identify Surpluses
        // 1. Hard Surpluses (Outside the targetCount window)
        const hardSurpluses = activeThisSide.filter(s => !targetSet.has(allSlots.findIndex(o => o.id === s.id)));

        // 2. Crawl Candidate (Furthest order inside the window if we have shortages closer)
        let surpluses = [...hardSurpluses];
        const activeInsideWindow = activeThisSide
            .filter(s => targetSet.has(allSlots.findIndex(o => o.id === s.id)))
            .sort((a, b) => type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price); // Furthest first

        // Move furthest orders into closest shortages
        const shortagesToFill = shortages.length;
        const crawlCapacity = Math.max(0, (activeThisSide.length > 0 ? reactionCap : targetCount) - surpluses.length);

        for (let i = 0; i < Math.min(crawlCapacity, shortagesToFill, activeInsideWindow.length); i++) {
            const furthest = activeInsideWindow[i];
            const furthestIdx = allSlots.findIndex(o => o.id === furthest.id);
            const bestShortageIdx = shortages[i];

            // Only crawl if it's strictly a price improvement
            const isCloser = type === ORDER_TYPES.BUY ? (bestShortageIdx > furthestIdx) : (bestShortageIdx < furthestIdx);
            if (isCloser) {
                surpluses.push(furthest);
            }
        }

        // Final sort: furthest from market first (for rotation efficiency)
        surpluses.sort((a, b) => type === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

        const pairCount = Math.min(surpluses.length, shortages.length, effectiveCap);
        for (let i = 0; i < pairCount; i++) {
            const surplus = surpluses[i];
            const shortageIdx = shortages[i];
            const shortageSlot = allSlots[shortageIdx];
            const size = blockchainToFloat(floatToBlockchainInt(finalIdealSizes[shortageIdx], precision), precision);

            ordersToRotate.push({ oldOrder: { ...surplus }, newPrice: shortageSlot.price, newSize: size, newGridId: shortageSlot.id, type: type });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL });
            stateUpdates.push({ ...shortageSlot, type: type, size: size, state: ORDER_STATES.ACTIVE });

            mgr.logger.log(`  - Rotation: ${surplus.id} (${surplus.size.toFixed(precision)}) -> ${shortageSlot.id} (capped size=${size.toFixed(precision)})`, "debug");
        }

        const remainingCap = Math.max(0, effectiveCap - pairCount);
        const placementShortages = shortages.slice(pairCount, pairCount + remainingCap);

        for (const idx of placementShortages) {
            const slot = allSlots[idx];
            const size = blockchainToFloat(floatToBlockchainInt(finalIdealSizes[idx], precision), precision);

            if (size > 0) {
                ordersToPlace.push({ ...slot, type: type, size: size, state: ORDER_STATES.ACTIVE });
                stateUpdates.push({ ...slot, type: type, size: size, state: ORDER_STATES.ACTIVE });
                mgr.logger.log(`  - Placement: ${slot.id} (capped size=${size.toFixed(precision)})`, "debug");
            }
        }

        for (let i = pairCount; i < surpluses.length; i++) {
            const surplus = surpluses[i];
            ordersToCancel.push({ ...surplus });
            stateUpdates.push({ ...surplus, state: ORDER_STATES.VIRTUAL, orderId: null });
        }

        // 6. Surplus Consumption
        // Whatever we didn't put into grid slots (including virtual) remains in cacheFunds.
        // totalAllocated is the sum of sizes assigned to EVERY slot in the side.
        const finalStateMap = new Map();
        stateUpdates.forEach(s => finalStateMap.set(s.id, s));

        const sideSlotIds = new Set(sideSlots.map(s => s.id));
        const totalAllocated = Array.from(finalStateMap.values())
            .filter(s => sideSlotIds.has(s.id))
            .reduce((sum, s) => sum + (s.size || 0), 0);

        mgr.funds.cacheFunds[side] = Math.max(0, totalSideBudget - totalAllocated);

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
                    // Optimistic update to wallet balances
                    if (mgr.accountTotals) {
                        mgr.accountTotals.buyFree = (mgr.accountTotals.buyFree || 0) + netProceeds;
                        mgr.accountTotals.buy = (mgr.accountTotals.buy || 0) + netProceeds;
                        mgr.accountTotals.sell = (mgr.accountTotals.sell || 0) - filledOrder.size;
                        // Note: sellFree was already deducted at order creation
                    }
                } else {
                    mgr.funds.cacheFunds.sell = (mgr.funds.cacheFunds.sell || 0) + netProceeds;
                    // Optimistic update to wallet balances
                    if (mgr.accountTotals) {
                        mgr.accountTotals.sellFree = (mgr.accountTotals.sellFree || 0) + netProceeds;
                        mgr.accountTotals.sell = (mgr.accountTotals.sell || 0) + netProceeds;
                        mgr.accountTotals.buy = (mgr.accountTotals.buy || 0) - filledOrder.size;
                        // Note: buyFree was already deducted at order creation
                    }
                }
            }

            if (hasBtsPair && fillsToSettle > 0) {
                const btsFeeData = getAssetFees("BTS", 0);
                mgr.funds.btsFeesOwed += fillsToSettle * btsFeeData.total;
                await mgr.accountant.deductBtsFees();
            }

            mgr.recalculateFunds();
            await mgr.persistGrid();

            let shouldRebalance = (fillsToSettle > 0);

            if (!shouldRebalance) {
                const allOrders = Array.from(mgr.orders.values());
                const buyPartials = allOrders.filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.PARTIAL);
                const sellPartials = allOrders.filter(o => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.PARTIAL);

                if (buyPartials.length > 0 && sellPartials.length > 0) {
                    const snap = mgr.getChainFundsSnapshot ? mgr.getChainFundsSnapshot() : {};
                    const budgetBuy = snap.allocatedBuy + (mgr.funds.cacheFunds?.buy || 0);
                    const budgetSell = snap.allocatedSell + (mgr.funds.cacheFunds?.sell || 0);

                    const getIsDust = (partials, side, budget) => {
                        const slots = allOrders.filter(o => o.type === (side === "buy" ? ORDER_TYPES.BUY : ORDER_TYPES.SELL));
                        if (slots.length === 0) return false;
                        const precision = getPrecisionForSide(mgr.assets, side);
                        const sideWeight = mgr.config.weightDistribution[side];
                        const idealSizes = allocateFundsByWeights(budget, slots.length, sideWeight, mgr.config.incrementPercent / 100, side === "sell", 0, precision);

                        return partials.some(p => {
                            const idx = slots.findIndex(s => s.id === p.id);
                            if (idx === -1) return false;
                            const dustThreshold = idealSizes[idx] * (GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100);
                            return p.size < dustThreshold;
                        });
                    };

                    const buyHasDust = getIsDust(buyPartials, "buy", budgetBuy);
                    const sellHasDust = getIsDust(sellPartials, "sell", budgetSell);

                    if (buyHasDust && sellHasDust) {
                        mgr.logger.log("[BOUNDARY] Dual-side dust partials detected. Triggering rebalance.", "info");
                        shouldRebalance = true;
                    }
                }
            }

            if (!shouldRebalance) {
                mgr.logger.log("[BOUNDARY] Skipping rebalance: No full fills and no dual-side dust partials.", "info");
                return { ordersToPlace: [], ordersToRotate: [], ordersToUpdate: [], ordersToCancel: [], stateUpdates: [], partialMoves: [] };
            }

            const result = await this.rebalance(filledOrders, excludeOrderIds);

            if (hasBtsPair && (result.ordersToRotate.length > 0 || result.ordersToUpdate.length > 0)) {
                const btsFeeData = getAssetFees("BTS", 0);
                const updateCount = result.ordersToRotate.length + result.ordersToUpdate.length;
                mgr.funds.btsFeesOwed += updateCount * btsFeeData.updateFee;
            }

            mgr.recalculateFunds();
            return result;
        } finally {
            mgr.resumeFundRecalc();
        }
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
                ? mgr.assets?.assetA?.precision
                : mgr.assets?.assetB?.precision;
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
}

module.exports = StrategyEngine;