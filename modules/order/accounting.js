/**
 * modules/order/accounting.js
 *
 * Specialized engine for financial state and fund tracking.
 * Responsible for calculating available funds, committed capital,
 * and managing BTS blockchain fees.
 */

const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../constants');
const { 
    computeChainFundTotals, 
    calculateAvailableFundsValue, 
    getAssetFees 
} = require('./utils');

class Accountant {
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Initialize the funds structure with zeroed values.
     */
    resetFunds() {
        const mgr = this.manager;
        mgr.accountTotals = mgr.accountTotals || (mgr.config.accountTotals ? { ...mgr.config.accountTotals } : { buy: null, sell: null, buyFree: null, sellFree: null });

        mgr.funds = {
            available: { buy: 0, sell: 0 },
            total: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            virtuel: { buy: 0, sell: 0 },
            reserved: { buy: 0, sell: 0 }, // backwards compat alias
            committed: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            cacheFunds: { buy: 0, sell: 0 },       // Surplus from rotation + fill proceeds
            btsFeesOwed: 0                         // Unpaid BTS fees (deducted from cache)
        };
        // Make reserved an alias for virtuel
        mgr.funds.reserved = mgr.funds.virtuel;
    }

    /**
     * Recalculate all fund values based on current order states.
     * This is THE MASTER FUND CALCULATION and must be called after any state change.
     * Called automatically by _updateOrder(), but can be manually triggered to verify consistency.
     *
     * FUND CATEGORIES:
     * ========================================================================
     * 1. CHAIN FUNDS (blockchain source of truth)
     *    - chainTotal: Total balance in account (on-chain)
     *    - chainFree: Unallocated balance (on-chain, not locked in orders)
     *    - chainCommitted: Locked in on-chain orders (orderId exists)
     *    Formula: chainTotal = chainFree + chainCommitted
     *
     * 2. GRID FUNDS (orders we placed, might be on-chain or not yet)
     *    - gridBuy/gridSell: ACTIVE + PARTIAL orders (including those not on-chain yet)
     *    - Includes both on-chain orders and pending placements
     *
     * 3. VIRTUAL FUNDS (in grid but not on-chain)
     *    - virtuelBuy/virtuelSell: VIRTUAL orders (pure grid state, no blockchain)
     *    - Also called "reserved" in old code (backwards compat alias)
     *
     * 4. AVAILABLE FUNDS (what we can spend right now)
     *    - Calculated as: chainFree - funds needed for grid allocation
     *    - respects botFunds allocation limits
     *    - gates new orders from being placed if insufficient
     *
     * CALCULATION FLOW:
     * 1. Walk all orders, sum sizes by (state, orderId presence)
     * 2. Calculate committed amounts from sums
     * 3. Infer total from free + committed
     * 4. Compare inferred total vs. blockchain's reported total
     *    - Use max of inferred vs reported (prevents undercounting)
     * 5. Calculate available funds based on totals and committed
     *
     * WHY THIS MATTERS:
     * If recalculateFunds() is not called after order state changes:
     * - Phantom funds appear (orders deducted but still counted as available)
     * - Available funds go negative (impossible to place new orders)
     * - Inconsistent state between blockchain and grid (causes sync errors)
     *
     * FUND CONSISTENCY CHECK (use to detect leaks):
     *   gridBuy_committed + gridSell_committed + available.buy <= chainTotal.buy
     *   gridBuy_committed + gridSell_committed + available.sell <= chainTotal.sell
     * If this fails, funds are leaking somewhere.
     */
    recalculateFunds() {
        const mgr = this.manager;
        if (!mgr.funds) this.resetFunds();

        let gridBuy = 0, gridSell = 0;
        let chainBuy = 0, chainSell = 0;
        let virtuelBuy = 0, virtuelSell = 0;

        // Use indices for faster iteration - only walk active/partial/virtual states
        const activePartialIds = [
            ...(mgr._ordersByState[ORDER_STATES.ACTIVE] || new Set()),
            ...(mgr._ordersByState[ORDER_STATES.PARTIAL] || new Set())
        ];
        const virtualIds = [...(mgr._ordersByState[ORDER_STATES.VIRTUAL] || new Set())];

        // Calculate grid and chain committed funds from active/partial orders
        for (const orderId of activePartialIds) {
            const order = mgr.orders.get(orderId);
            if (!order) continue;
            const size = Number(order.size) || 0;
            if (size <= 0) continue;

            if (order.type === ORDER_TYPES.BUY) {
                gridBuy += size;
                if (order.orderId) chainBuy += size;
            } else if (order.type === ORDER_TYPES.SELL) {
                gridSell += size;
                if (order.orderId) chainSell += size;
            }
        }

        // Calculate virtual funds from virtual orders
        for (const orderId of virtualIds) {
            const order = mgr.orders.get(orderId);
            if (!order) continue;
            const size = Number(order.size) || 0;
            if (size <= 0) continue;

            if (order.type === ORDER_TYPES.BUY) {
                virtuelBuy += size;
            } else if (order.type === ORDER_TYPES.SELL) {
                virtuelSell += size;
            }
        }

        // Get chain free balances (unallocated funds per blockchain)
        const chainFreeBuy = mgr.accountTotals?.buyFree || 0;
        const chainFreeSell = mgr.accountTotals?.sellFree || 0;

        // Set committed (funds locked in orders)
        mgr.funds.committed.grid = { buy: gridBuy, sell: gridSell };
        mgr.funds.committed.chain = { buy: chainBuy, sell: chainSell };

        // Set virtuel/virtual (grid orders not on-chain yet)
        mgr.funds.virtuel = { buy: virtuelBuy, sell: virtuelSell };
        mgr.funds.reserved = mgr.funds.virtuel; // backwards compat alias

        // Set totals (infer from free + committed, or use reported if available)
        const inferredChainTotalBuy = chainFreeBuy + chainBuy;
        const inferredChainTotalSell = chainFreeSell + chainSell;
        const onChainTotalBuy = Number.isFinite(Number(mgr.accountTotals?.buy)) ? Number(mgr.accountTotals.buy) : null;
        const onChainTotalSell = Number.isFinite(Number(mgr.accountTotals?.sell)) ? Number(mgr.accountTotals.sell) : null;

        mgr.funds.total.chain = {
            buy: onChainTotalBuy !== null ? Math.max(onChainTotalBuy, inferredChainTotalBuy) : inferredChainTotalBuy,
            sell: onChainTotalSell !== null ? Math.max(onChainTotalSell, inferredChainTotalSell) : inferredChainTotalSell
        };
        mgr.funds.total.grid = { buy: gridBuy + virtuelBuy, sell: gridSell + virtuelSell };

        // Set available (what we can spend right now)
        mgr.funds.available.buy = calculateAvailableFundsValue('buy', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
        mgr.funds.available.sell = calculateAvailableFundsValue('sell', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);

        // Verify fund invariants to catch leaks early
        this._verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell);
    }

    /**
     * Verify critical fund tracking invariants.
     * These checks catch fund leaks and inconsistencies early.
     *
     * INVARIANT 1: chainTotal = chainFree + chainCommitted
     * INVARIANT 2: available <= chainFree
     * INVARIANT 3: gridCommitted <= chainTotal
     *
     * TOLERANCE: Dynamic based on asset precision. Allows 2 units of slack
     * (one unit from each operand's rounding). This accounts for the fact that
     * both chainFree and chainCommitted are calculated independently and may
     * each have minor rounding differences.
     */
    _verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell) {
        // 1. Dynamic tolerance based on asset precision (slack for rounding)
        const buyPrecision = mgr.assets?.assetB?.precision || 5;
        const sellPrecision = mgr.assets?.assetA?.precision || 5;
        const precisionSlackBuy = 2 * Math.pow(10, -buyPrecision);
        const precisionSlackSell = 2 * Math.pow(10, -sellPrecision);

        // 2. Percentage-based tolerance to handle market fees and timing offsets
        const PERCENT_TOLERANCE = (GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE || 0.1) / 100;

        // INVARIANT 1: chainTotal = chainFree + chainCommitted (BUY side)
        const chainTotalBuy = mgr.funds.total.chain.buy;
        const expectedBuy = chainFreeBuy + chainBuy;
        const diffBuy = Math.abs(chainTotalBuy - expectedBuy);
        const allowedBuyTolerance = Math.max(precisionSlackBuy, chainTotalBuy * PERCENT_TOLERANCE);

        if (diffBuy > allowedBuyTolerance) {
            mgr._metrics?.invariantViolations && (mgr._metrics.invariantViolations.buy++);
            mgr.logger?.log?.(
                `WARNING: Fund invariant violation (BUY): chainTotal (${chainTotalBuy.toFixed(8)}) != chainFree (${chainFreeBuy.toFixed(8)}) + chainCommitted (${chainBuy.toFixed(8)}) = ${expectedBuy.toFixed(8)} (diff: ${diffBuy.toFixed(8)}, allowed: ${allowedBuyTolerance.toFixed(8)})`,
                'warn'
            );
        }

        // INVARIANT 1: chainTotal = chainFree + chainCommitted (SELL side)
        const chainTotalSell = mgr.funds.total.chain.sell;
        const expectedSell = chainFreeSell + chainSell;
        const diffSell = Math.abs(chainTotalSell - expectedSell);
        const allowedSellTolerance = Math.max(precisionSlackSell, chainTotalSell * PERCENT_TOLERANCE);

        if (diffSell > allowedSellTolerance) {
            mgr._metrics?.invariantViolations && (mgr._metrics.invariantViolations.sell++);
            mgr.logger?.log?.(
                `WARNING: Fund invariant violation (SELL): chainTotal (${chainTotalSell.toFixed(8)}) != chainFree (${chainFreeSell.toFixed(8)}) + chainCommitted (${chainSell.toFixed(8)}) = ${expectedSell.toFixed(8)} (diff: ${diffSell.toFixed(8)}, allowed: ${allowedSellTolerance.toFixed(8)})`,
                'warn'
            );
        }

        // INVARIANT 2: Available should not exceed chainFree
        if (mgr.funds.available.buy > chainFreeBuy + allowedBuyTolerance) {
            mgr.logger?.log?.(
                `WARNING: Fund invariant violation (BUY available): available (${mgr.funds.available.buy.toFixed(8)}) > chainFree (${chainFreeBuy.toFixed(8)})`,
                'warn'
            );
        }
        if (mgr.funds.available.sell > chainFreeSell + allowedSellTolerance) {
            mgr.logger?.log?.(
                `WARNING: Fund invariant violation (SELL available): available (${mgr.funds.available.sell.toFixed(8)}) > chainFree (${chainFreeSell.toFixed(8)})`,
                'warn'
            );
        }

        // INVARIANT 3: Grid committed should not exceed chain total
        const gridCommittedBuy = mgr.funds.committed.grid.buy;
        const gridCommittedSell = mgr.funds.committed.grid.sell;
        if (gridCommittedBuy > chainTotalBuy + allowedBuyTolerance) {
            mgr.logger?.log?.(
                `WARNING: Fund invariant violation (BUY grid): gridCommitted (${gridCommittedBuy.toFixed(8)}) > chainTotal (${chainTotalBuy.toFixed(8)})`,
                'warn'
            );
        }
        if (gridCommittedSell > chainTotalSell + allowedSellTolerance) {
            mgr.logger?.log?.(
                `WARNING: Fund invariant violation (SELL grid): gridCommitted (${gridCommittedSell.toFixed(8)}) > chainTotal (${chainTotalSell.toFixed(8)})`,
                'warn'
            );
        }
    }

    /**
     * Check if sufficient funds exist AND atomically deduct.
     * This prevents race conditions where multiple operations check the same balance
     * and all think they have enough funds, leading to negative balances.
     *
     * ATOMIC CHECK-AND-DEDUCT:
     * This pattern solves the TOCTOU (Time-of-Check vs Time-of-Use) race where:
     * 1. Op A checks: buyFree=1000 (has 1000)
     * 2. Op B checks: buyFree=1000 (has 1000)  ← Race condition!
     * 3. Op A deducts: buyFree=400
     * 4. Op B deducts: buyFree=-600 ← PROBLEM!
     *
     * With atomic check-and-deduct, either both checks succeed or one fails.
     */
    tryDeductFromChainFree(orderType, size, operation = 'move') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) {
            mgr.logger.log(
                `[chainFree check-and-deduct] ${orderType} order ${operation}: accountTotals not available`,
                'warn'
            );
            return false;
        }

        const current = Number(mgr.accountTotals[key]) || 0;

        // Check: Do we have enough?
        if (current < size) {
            mgr.logger.log(
                `[chainFree check-and-deduct] ${orderType} order ${operation}: INSUFFICIENT FUNDS (have ${current.toFixed(8)}, need ${size.toFixed(8)})`,
                'warn'
            );
            return false;
        }

        // Deduct: Now that we've passed the check, deduct
        mgr.accountTotals[key] = Math.max(0, current - size);
        const asset = isBuy ? (mgr.config?.assetB || 'quote') : (mgr.config?.assetA || 'base');
        mgr.logger.log(
            `[chainFree update] ${orderType} order ${operation}: ${current.toFixed(8)} - ${size.toFixed(8)} = ${mgr.accountTotals[key].toFixed(8)} ${asset}`,
            'debug'
        );
        return true;
    }

    /**
     * Deduct an amount from the optimistic chainFree balance.
     * DEPRECATED: Use tryDeductFromChainFree() for new code to prevent race conditions.
     * This method is kept for backward compatibility but doesn't validate availability.
     */
    deductFromChainFree(orderType, size, operation = 'move') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (mgr.accountTotals && mgr.accountTotals[key] !== undefined) {
            const oldFree = Number(mgr.accountTotals[key]) || 0;
            mgr.accountTotals[key] = Math.max(0, oldFree - size);
            const asset = isBuy ? (mgr.config?.assetB || 'quote') : (mgr.config?.assetA || 'base');
            mgr.logger.log(
                `[chainFree update] ${orderType} order ${operation}: ${oldFree.toFixed(8)} - ${size.toFixed(8)} = ${mgr.accountTotals[key].toFixed(8)} ${asset}`,
                'debug'
            );
        }
    }

    /**
     * Add an amount back to the optimistic chainFree balance.
     */
    addToChainFree(orderType, size, operation = 'release') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (mgr.accountTotals && mgr.accountTotals[key] !== undefined) {
            const oldFree = Number(mgr.accountTotals[key]) || 0;
            mgr.accountTotals[key] = oldFree + size;
            const asset = isBuy ? (mgr.config?.assetB || 'quote') : (mgr.config?.assetA || 'base');
            mgr.logger.log(
                `[chainFree update] ${orderType} order ${operation}: ${oldFree.toFixed(8)} + ${size.toFixed(8)} = ${mgr.accountTotals[key].toFixed(8)} ${asset}`,
                'debug'
            );
        }
    }

    /**
     * Update optimistic free balance during order state transitions.
     * This is CRITICAL for preventing "fund leaks" where locked capital is never released.
     *
     * STATE TRANSITION RULES (chainFree impact):
     * =========================================================================
     * VIRTUAL → ACTIVE/PARTIAL: Funds transition from "free" to "locked"
     *   Action: DEDUCT from chainFree (funds become committed/on-chain)
     *   Why: New on-chain orders lock available capital
     *
     * ACTIVE/PARTIAL → VIRTUAL: Funds transition from "locked" to "free"
     *   Action: ADD to chainFree (funds become available again)
     *   Why: Cancelled orders release their capital back to available pool
     *
     * ACTIVE/PARTIAL → ACTIVE/PARTIAL (RESIZE): Size changes within active state
     *   Action: DEDUCT if growing, ADD if shrinking
     *   Why: Consolidations and rotations may resize orders, affecting committed capital
     *
     * SIZE CONSISTENCY CHECK:
     * After any state transition, the formula below should hold:
     *   chainTotal = chainFree + chainCommitted
     * Where chainCommitted = sum of all (ACTIVE or PARTIAL orders with orderId)
     * If this breaks, we have a fund leak somewhere.
     *
     * BTS FEE HANDLING:
     * When an order is placed on a BTS-containing pair, we deduct the transaction fee
     * from chainFree immediately. This prevents over-committing capital for fees.
     *
     * CONTEXT PARAMETER:
     * Always log the context (e.g., 'rotation', 'consolidation', 'fill') to aid debugging
     * fund discrepancies. The full context trail makes it easier to trace which operation
     * caused a fund leak if one occurs.
     */
    updateOptimisticFreeBalance(oldOrder, newOrder, context, fee = 0) {
        const mgr = this.manager;
        if (!oldOrder || !newOrder) return;

        const oldIsActive = (oldOrder.state === ORDER_STATES.ACTIVE || oldOrder.state === ORDER_STATES.PARTIAL);
        const newIsActive = (newOrder.state === ORDER_STATES.ACTIVE || newOrder.state === ORDER_STATES.PARTIAL);
        const oldSize = Number(oldOrder.size) || 0;
        const newSize = Number(newOrder.size) || 0;

        const btsSide = (mgr.config?.assetA === 'BTS') ? 'sell' :
            (mgr.config?.assetB === 'BTS') ? 'buy' : null;

        if (!oldIsActive && newIsActive) {
            if (newSize > 0) {
                this.deductFromChainFree(newOrder.type, newSize, `${context} (${oldOrder.state}->${newOrder.state})`);
            }
            if (fee > 0 && btsSide && newOrder.type === (btsSide === 'buy' ? ORDER_TYPES.BUY : ORDER_TYPES.SELL)) {
                this.deductFromChainFree(newOrder.type, fee, `${context} (tx-fee)`);
            }
        }
        else if (oldIsActive && !newIsActive) {
            if (oldSize > 0) {
                this.addToChainFree(oldOrder.type, oldSize, `${context} (${oldOrder.state}->${newOrder.state})`);
            }
        }
        else if (oldIsActive && newIsActive) {
            const sizeDelta = newSize - oldSize;
            if (sizeDelta > 0) {
                this.deductFromChainFree(newOrder.type, sizeDelta, `${context} (resize-up)`);
            } else if (sizeDelta < 0) {
                this.addToChainFree(newOrder.type, Math.abs(sizeDelta), `${context} (resize-down)`);
            }
            if (fee > 0 && btsSide && newOrder.type === (btsSide === 'buy' ? ORDER_TYPES.BUY : ORDER_TYPES.SELL)) {
                this.deductFromChainFree(newOrder.type, fee, `${context} (tx-fee)`);
            }
        }
    }

    /**
     * Accumulate and deduct BTS blockchain fees from cache funds.
     */
    async deductBtsFees(requestedSide = null) {
        const mgr = this.manager;
        if (!mgr.funds.btsFeesOwed || mgr.funds.btsFeesOwed <= 0) return;

        const assetA = mgr.config.assetA;
        const assetB = mgr.config.assetB;
        const btsSide = (assetA === 'BTS') ? 'sell' :
            (assetB === 'BTS') ? 'buy' : null;

        const side = requestedSide ? (requestedSide === btsSide ? btsSide : null) : btsSide;

        if (side) {
            const cache = mgr.funds.cacheFunds?.[side] || 0;
            const feesOwedThisSide = Math.min(mgr.funds.btsFeesOwed, cache);

            if (feesOwedThisSide > 0) {
                mgr.logger.log(`Deducting ${feesOwedThisSide.toFixed(8)} BTS fees from cacheFunds.${side} and chainFree.${side}. Remaining fees: ${(mgr.funds.btsFeesOwed - feesOwedThisSide).toFixed(8)} BTS`, 'info');

                // Deduct from logical trackers
                mgr.funds.cacheFunds[side] -= feesOwedThisSide;
                mgr.funds.btsFeesOwed -= feesOwedThisSide;

                // CRITICAL: Physically deduct from optimistic chainFree balance so recalculateFunds stays correct
                const orderType = (side === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
                this.deductFromChainFree(orderType, feesOwedThisSide, 'bts-fee-settlement');

                await mgr._persistCacheFunds();
                await mgr._persistBtsFeesOwed();
            }
        }
    }

}

module.exports = Accountant;
