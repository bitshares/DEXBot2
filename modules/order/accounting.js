/**
 * modules/order/accounting.js
 *
 * Specialized engine for financial state and fund tracking.
 * Responsible for calculating available funds, committed capital,
 * and managing BTS blockchain fees.
 */

const { ORDER_TYPES, ORDER_STATES } = require('../constants');
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
     */
    recalculateFunds() {
        const mgr = this.manager;
        if (!mgr.funds) this.resetFunds();

        let gridBuy = 0, gridSell = 0;
        let chainBuy = 0, chainSell = 0;
        let virtuelBuy = 0, virtuelSell = 0;

        for (const order of mgr.orders.values()) {
            const size = Number(order.size) || 0;
            if (size <= 0) continue;

            if (order.type === ORDER_TYPES.BUY) {
                if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) {
                    gridBuy += size;
                    if (order.orderId) chainBuy += size;
                } else if (order.state === ORDER_STATES.VIRTUAL) {
                    virtuelBuy += size;
                }
            } else if (order.type === ORDER_TYPES.SELL) {
                if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) {
                    gridSell += size;
                    if (order.orderId) chainSell += size;
                } else if (order.state === ORDER_STATES.VIRTUAL) {
                    virtuelSell += size;
                }
            }
        }

        // Get chain free balances
        const chainFreeBuy = mgr.accountTotals?.buyFree || 0;
        const chainFreeSell = mgr.accountTotals?.sellFree || 0;

        // Set committed
        mgr.funds.committed.grid = { buy: gridBuy, sell: gridSell };
        mgr.funds.committed.chain = { buy: chainBuy, sell: chainSell };

        // Set virtuel
        mgr.funds.virtuel = { buy: virtuelBuy, sell: virtuelSell };
        mgr.funds.reserved = mgr.funds.virtuel; // backwards compat alias

        // Set totals
        const inferredChainTotalBuy = chainFreeBuy + chainBuy;
        const inferredChainTotalSell = chainFreeSell + chainSell;
        const onChainTotalBuy = Number.isFinite(Number(mgr.accountTotals?.buy)) ? Number(mgr.accountTotals.buy) : null;
        const onChainTotalSell = Number.isFinite(Number(mgr.accountTotals?.sell)) ? Number(mgr.accountTotals.sell) : null;
        
        mgr.funds.total.chain = {
            buy: onChainTotalBuy !== null ? Math.max(onChainTotalBuy, inferredChainTotalBuy) : inferredChainTotalBuy,
            sell: onChainTotalSell !== null ? Math.max(onChainTotalSell, inferredChainTotalSell) : inferredChainTotalSell
        };
        mgr.funds.total.grid = { buy: gridBuy + virtuelBuy, sell: gridSell + virtuelSell };

        // Set available
        mgr.funds.available.buy = calculateAvailableFundsValue('buy', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
        mgr.funds.available.sell = calculateAvailableFundsValue('sell', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders);
    }

    /**
     * Deduct an amount from the optimistic chainFree balance.
     */
    deductFromChainFree(orderType, size, operation = 'move') {
        const mgr = this.manager;
        const isBuy = orderType === ORDER_TYPES.BUY;
        const key = isBuy ? 'buyFree' : 'sellFree';

        if (mgr.accountTotals && mgr.accountTotals[key] !== undefined) {
            const oldFree = mgr.accountTotals[key];
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
            const oldFree = mgr.accountTotals[key];
            mgr.accountTotals[key] = (Number(oldFree) || 0) + size;
            const asset = isBuy ? (mgr.config?.assetB || 'quote') : (mgr.config?.assetA || 'base');
            mgr.logger.log(
                `[chainFree update] ${orderType} order ${operation}: ${oldFree.toFixed(8)} + ${size.toFixed(8)} = ${mgr.accountTotals[key].toFixed(8)} ${asset}`,
                'debug'
            );
        }
    }

    /**
     * Update optimistic free balance during order state transitions.
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

            mgr.logger.log(`Deducting ${feesOwedThisSide.toFixed(8)} BTS fees from cacheFunds.${side}. Remaining fees: ${(mgr.funds.btsFeesOwed - feesOwedThisSide).toFixed(8)} BTS`, 'info');

            mgr.funds.cacheFunds[side] -= feesOwedThisSide;
            mgr.funds.btsFeesOwed -= feesOwedThisSide;

            await mgr._persistCacheFunds();
            await mgr._persistBtsFeesOwed();
        }
    }

    /**
     * Adjust funds for partial fills detected via size deltas.
     */
    adjustFunds(gridOrder, deltaSize) {
        const mgr = this.manager;
        if (!gridOrder || !Number.isFinite(deltaSize)) return;
        if (deltaSize >= 0) return; // only react to size decreases (fills)

        const fillSize = Math.abs(deltaSize);
        const price = Number(gridOrder.price || 0);
        if (fillSize <= 0 || price <= 0) return;

        if (!mgr.funds) this.resetFunds();
        if (!mgr.accountTotals) {
            mgr.accountTotals = { buy: 0, sell: 0, buyFree: 0, sellFree: 0 };
        }

        // Partial proceeds: Internal accounting only. 
        // We no longer update accountTotals (chain totals) here to prevent double-counting
        // during the transition to processFilledOrders.
    }
}

module.exports = Accountant;
