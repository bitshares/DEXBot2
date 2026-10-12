const { OrderManager } = require('../modules/order/manager');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');
const { makeLadderFromPrices } = require('./helpers/order_test_helpers');

console.log('Running offline partial-fill unit test (syncing startup orders)...');

(async () => {
    try {
        // Create manager with a minimal config and mocked assets
        const cfg = {
            assetA: 'ASSTA', assetB: 'ASSTB', startPrice: 2,
            coreOrders: { buy: 1, sell: 1 },
            botFunds: { buy: 1000, sell: 1000 }
        };
        const mgr = new OrderManager(cfg);
        // Genesis-frozen engine: a populated grid needs a price ladder or the
        // sync gate refuses the run (INV-GRID-004).
        mgr._genesis = makeLadderFromPrices([2]);

        // Mock asset metadata (ids and precisions) so conversions work
        mgr.assets = {
            assetA: { id: '1.3.100', precision: 3 },
            assetB: { id: '1.3.101', precision: 3 }
        };

        // 1. Setup: Create a grid order that is VIRTUAL (or ACTIVE with missing ID)
        const gridId = 'grid-1';
        const initialSize = 10;
        const price = 2;
        // We start with it being ACTIVE in our internal state (simulating a grid that was just loaded or an order that was previously tracked)
        const gridOrder = { id: gridId, orderId: 'old-chain-id', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: initialSize, price };
        mgr.orders.set(gridId, gridOrder);
        mgr._ordersByState[ORDER_STATES.VIRTUAL].add(gridId);
        mgr._ordersByType[ORDER_TYPES.SELL].add(gridId);

        await mgr.resetFunds();
        await mgr.setAccountTotals({ buy: 0, sell: initialSize, buyFree: initialSize, sellFree: initialSize });
        await mgr.recalculateFunds();

        // 2. Action: Simulate finding this order on chain during startup, but PARTIALLY FILLED
        const partialFilledHuman = 4.0;
        const remainingHuman = initialSize - partialFilledHuman;
        const chainOrderId = 'old-chain-id';

        const chainOrders = [{
            id: chainOrderId,
            sell_price: {
                base: { asset_id: mgr.assets.assetA.id, amount: Math.round(initialSize * Math.pow(10, mgr.assets.assetA.precision)) },
                quote: { asset_id: mgr.assets.assetB.id, amount: Math.round(initialSize * price * Math.pow(10, mgr.assets.assetB.precision)) }
            },
            for_sale: Math.round(remainingHuman * Math.pow(10, mgr.assets.assetA.precision))
        }];

        console.log(`Initial state: ${mgr.orders.get(gridId).state}, size: ${mgr.orders.get(gridId).size}`);

        // Call synchronizeWithChain simulating startup sync
        await mgr.synchronizeWithChain(chainOrders, 'readOpenOrders');

        const updated = mgr.orders.get(gridId);
        console.log(`Updated state: ${updated.state}, size: ${updated.size}, orderId: ${updated.orderId}`);

        // ASSERTIONS
        const assert = require('assert');
        // Sync engine detects size mismatch and transitions to PARTIAL.
        assert.strictEqual(updated.state, ORDER_STATES.PARTIAL, 'Order should transition to PARTIAL when sync detects size mismatch');
        assert.strictEqual(updated.size, remainingHuman, 'Order size should reflect remaining chain amount');
        assert.strictEqual(updated.orderId, chainOrderId, 'Order should have chain ID');

        // Check funds
        await mgr.recalculateFunds();
        console.log('Final Free Sell:', mgr.accountTotals.sellFree);
        // Total sell was 10. 6 is committed (PARTIAL). So 4 should be released.
        // We seeded with 10 free, so 10 + 4 = 14.
        assert.strictEqual(mgr.accountTotals.sellFree, 14.0, 'Sell Free should be 14.0');

        console.log('✅ Offline partial-fill startup sync test passed!');
    } catch (err) {
        console.error('❌ Test failed:', err);
        process.exit(1);
    }
})();
