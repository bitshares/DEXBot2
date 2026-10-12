const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testScaledSpreadCorrection() {
    console.log('Running test: Scaled Spread Correction');

    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 }, coreOrders: { buy: 1, sell: 1 },
        incrementPercent: 1, targetSpreadPercent: 1
    });

    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    mgr.btsBalance = { free: 1000, total: 1000, locked: 0 };

    // 1. Setup a grid slot + one live opposite-side order so the shared
    //    readiness gate does not classify the book as cold (the gate's live
    //    view is slot-N gated, matching production).
    await mgr._updateOrder({ id: 'slot-1', price: 0.9, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0 });
    await mgr._updateOrder({ id: 'slot-2', price: 1.0, type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, orderId: '1.7.9001' });
    
    // 2. Scenario A: Funds sufficient for IDEAL size
    console.log('  Scenario A: Sufficient funds');
    await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await mgr.recalculateFunds();
    
    // Ideal size for 1 order with 1000 budget is 1000
    const resultA = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY);
    assert.strictEqual(resultA.ordersToPlace[0].size, 1000, 'Should place full ideal size');
    console.log('  ✓ Placed full ideal size');

    // 3. Scenario B: Funds slightly low (Scales down)
    console.log('  Scenario B: Low funds (Scales down)');
    // Reset slot
    await mgr._updateOrder({ id: 'slot-1', price: 0.9, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0 });
    await mgr.setAccountTotals({ buy: 500, sell: 1000, buyFree: 500, sellFree: 1000 });
    await mgr.recalculateFunds();
    
    const resultB = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY);
    assert.strictEqual(resultB.ordersToPlace[0].size, 500, 'Should scale down to 500');
    console.log('  ✓ Scaled down to available funds (500)');

    // 4. Scenario C: Funds extremely low (Below 2*Dust threshold)
    console.log('  Scenario C: Extremely low funds (Below 2*Dust)');
    // Threshold is 5%. 2*Dust = 10%. Ideal is 1000. So minHealthy is 100.
    await mgr._updateOrder({ id: 'slot-1', price: 0.9, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0 });
    await mgr.setAccountTotals({ buy: 50, sell: 1000, buyFree: 50, sellFree: 1000 });
    await mgr.recalculateFunds();
    
    const resultC = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY);
    assert.strictEqual(resultC.ordersToPlace.length, 0, 'Should NOT place order because 50 < 100 (minHealthy)');
    console.log('  ✓ Skipped order because available (50) < double-dust threshold (100)');

    console.log('✓ Scaled Spread Correction test PASSED\n');
}

testScaledSpreadCorrection().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
