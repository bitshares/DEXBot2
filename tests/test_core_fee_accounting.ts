const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const MathUtils = require('../modules/order/utils/math');

async function createManager() {
    MathUtils._setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 1 },
            limitOrderUpdate: { bts: 0.1 },
            limitOrderCancel: { bts: 0.2 },
            makerFeeDiscountPercent: 0.9,
        },
        USD: {
            chargesMarketFees: true,
            marketFee: { percent: 1 },
            takerFee: { percent: 2 },
            maxMarketFee: { float: 0.5 },
        },
        NOFEE: {
            chargesMarketFees: false,
            marketFee: { percent: 10 },
            takerFee: { percent: 20 },
            maxMarketFee: { float: 100 },
        },
    });

    const mgr = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 1, sell: 1 },
        incrementPercent: 1,
    });
    mgr.assets = {
        assetA: { id: '1.3.0', precision: 5 },
        assetB: { id: '1.3.121', precision: 5 },
    };
    await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    mgr.isBootstrapping = () => true;
    return mgr;
}

async function main() {
    console.log('=== Core Fee Accounting Tests ===');

    {
        const mgr = await createManager();
        await mgr._updateOrder(
            { id: 's1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 2, size: 10 },
            'seed',
            { skipAccounting: true }
        );
        await mgr._updateOrder(
            { id: 's1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 2, size: 10, orderId: '1.7.1' },
            'createOrder',
            { fee: 1 }
        );
        assert.strictEqual(mgr.orders.get('s1').btsFeeState.deferredFee, 1);
        assert.strictEqual(mgr.accountTotals.sellFree, 989);
        assert.strictEqual(mgr.accountTotals.sell, 999);

        await mgr._updateOrder(
            { ...mgr.orders.get('s1'), size: 9 },
            'order-update',
            { fee: 0.1 }
        );
        assert.strictEqual(mgr.orders.get('s1').btsFeeState.deferredFee, 0.1);
        assert(Math.abs(mgr.accountTotals.sell - 999.88) < 1e-12, 'update refunds old deferred fee minus discounted cancel charge, then defers update fee');

        await mgr._updateOrder(
            { ...mgr.orders.get('s1'), state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null },
            'cancelOrder',
            { fee: 0.2 }
        );
        assert.strictEqual(mgr.orders.get('s1').btsFeeState, undefined);
        assert(Math.abs(mgr.accountTotals.sell - 999.88) < 1e-12, 'cancel refunds remaining deferred fee after cap (deferred_fee < cancel_fee → 0 refund)');
    }

    {
        const mgr = await createManager();
        await mgr._updateOrder(
            { id: 's2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 2, size: 10, orderId: '1.7.2', btsFeeState: { deferredFee: 1 } },
            'seed',
            { skipAccounting: true }
        );
        const applied = await mgr.accountant.processFillAccounting({
            order_id: '1.7.2',
            pays: { amount: 100000, asset_id: '1.3.0' },
            receives: { amount: 20000000, asset_id: '1.3.121' },
            is_maker: true,
        }, 'fill-core-fee-test');
        assert.strictEqual(applied, true);
        assert(Math.abs(mgr.accountTotals.sell - 999.9) < 1e-12, 'maker fill refunds 90% of deferred BTS fee independent of received asset');
        assert(Math.abs(mgr.accountTotals.buy - 1199.5) < 1e-12, 'market fee is capped by max_market_fee');

        await mgr._updateOrder(
            { ...mgr.orders.get('s2'), size: 5, state: ORDER_STATES.PARTIAL },
            'handle-fill-partial',
            { fee: 0 }
        );
        assert.strictEqual(mgr.orders.get('s2').btsFeeState, undefined, 'partial fill clears deferred fee after Core processes it');
        assert(Math.abs(mgr.accountTotals.sell - 999.9) < 1e-12, 'fill state update must not refund deferred fee a second time');
    }

    {
        const mgr = await createManager();
        MathUtils._setFeeCache({
            BTS: {
                limitOrderCreate: { bts: 1 },
                limitOrderUpdate: { bts: 0.1 },
                limitOrderCancel: { bts: 0.2 },
                makerFeeDiscountPercent: 0.25,
            },
            USD: {
                chargesMarketFees: true,
                marketFee: { percent: 1 },
                takerFee: { percent: 2 },
                maxMarketFee: { float: 0.5 },
            },
        });
        await mgr._updateOrder(
            { id: 's3', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 2, size: 10, orderId: '1.7.3', btsFeeState: { deferredFee: 1 } },
            'seed',
            { skipAccounting: true }
        );
        await mgr.accountant.processFillAccounting({
            order_id: '1.7.3',
            pays: { amount: 100000, asset_id: '1.3.0' },
            receives: { amount: 10000000, asset_id: '1.3.121' },
            is_maker: true,
        }, 'fill-core-fee-discount-test');
        assert(Math.abs(mgr.accountTotals.sell - 999.25) < 1e-12, 'maker fill refund follows cached Core maker_fee_discount_percent');

        const proceeds = MathUtils.getAssetFees('BTS', 10, true);
        assert.strictEqual(proceeds.refund, 0.25, 'legacy BTS proceeds helper follows cached maker discount');
    }

    {
        MathUtils._setFeeCache({
            BTS: {
                limitOrderCreate: { bts: 1 },
                limitOrderUpdate: { bts: 0.1 },
                limitOrderCancel: { bts: 0.2 },
            },
        });
        const proceeds = MathUtils.getAssetFees('BTS', 10, true);
        assert.strictEqual(proceeds.refund, 0.9, 'missing Core maker_fee_discount_percent defaults to current 90% behavior');
    }

    {
        await createManager();
        const noFee = MathUtils.getAssetFees('NOFEE', 100, false);
        assert.strictEqual(noFee.feeAmount, 0, 'market fees require charge_market_fee flag');
        const capped = MathUtils.getAssetFees('USD', 100, false);
        assert.strictEqual(capped.feeAmount, 0.5, 'market fee is capped');
    }

    console.log('=== Core fee accounting tests passed ===');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
