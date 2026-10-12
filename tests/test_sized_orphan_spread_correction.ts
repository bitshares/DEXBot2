const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// Regression test for the sized-orphan spread-correction fix.
//
// Before the fix, `orphanedVirtualCandidates` in prepareSpreadCorrectionOrders
// required `Number(o.size || 0) === 0`. A sized virtual slot that lost its
// orderId (e.g. a lowest-sell CREATE whose broadcast was dropped/discarded with
// no rollback) has size > 0 but no on-chain order — it was excluded, so spread
// correction silently planned 0 orders and the gap never closed.
//
// This test builds exactly that scenario and asserts the orphans are accepted
// as candidates and turned into CREATE actions. On the unfixed code the
// function returns empty (guarded by `size === 0`), failing the assertions.
async function testSizedOrphanSpreadCorrection() {
    console.log('Running test: Sized Orphan Spread Correction');

    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 0, sell: 100 },
        coreOrders: { buy: 1, sell: 2 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });

    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    mgr.config.weightDistribution = { buy: 0.5, sell: 0.5 };
    // Non-BTS mock pair: give a BTS balance so the BTS-fee reservation does not
    // zero the side budget (adjustBudgetForBtsFees carves the deficit from a
    // side with no BTS free balance).
    mgr.btsBalance = { free: 1000, total: 1000, locked: 0 };

    // Price-sorted slots (boundary at index 2, gapSlots = 1 => sellStartIdx = 4):
    //   idx0  buy-1          BUY   ACTIVE  0.80  (placed)
    //   idx1  buy-2          BUY   ACTIVE  0.90  (placed)
    //   idx2  buy-edge       BUY   ACTIVE  0.95  (placed, boundary)
    //   idx3  gap            SPREAD VIRTUAL 0.97  (empty gap band)
    //   idx4  sell-orphan-1  SELL  VIRTUAL 1.00  sized, NO orderId  <-- orphan
    //   idx5  sell-orphan-2  SELL  VIRTUAL 1.02  sized, NO orderId  <-- orphan
    //   idx6  sell-1         SELL  ACTIVE  1.10  (placed, real lowest sell)
    await mgr._updateOrder({ id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 0.80, size: 10, orderId: '1.7.101' });
    await mgr._updateOrder({ id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 0.90, size: 10, orderId: '1.7.102' });
    await mgr._updateOrder({ id: 'buy-edge', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 0.95, size: 10, orderId: '1.7.103' });
    await mgr._updateOrder({ id: 'gap', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 0.97, size: 0 });
    await mgr._updateOrder({ id: 'sell-orphan-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.00, size: 0.5 });
    await mgr._updateOrder({ id: 'sell-orphan-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.02, size: 0.5 });
    await mgr._updateOrder({ id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1.10, size: 10, orderId: '1.7.104' });
    // Live grid-slot order so the shared readiness gate does not classify this
    // book as cold (the gate's live view is slot-N gated, matching production).
    await mgr._updateOrder({ id: 'slot-9', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1.20, size: 10, orderId: '1.7.9002' });

    mgr.boundaryIdx = 2;
    mgr._gapSlots = 1;

    // Fund the sell side so the correction has budget to CREATE both orphans.
    await mgr.setAccountTotals({ buy: 0, sell: 100, buyFree: 0, sellFree: 100 });
    await mgr.recalculateFunds();

    console.log('  Scenario: sized virtual orphans (size>0, no orderId) adjacent to gap');
    const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.SELL, 2);

    assert.strictEqual(
        correction.ordersToPlace.length,
        2,
        'Should plan 2 CREATE actions for the sized orphans (unfixed code plans 0)'
    );
    const placedIds = correction.ordersToPlace.map((o: any) => o.id).sort();
    assert.deepStrictEqual(
        placedIds,
        ['sell-orphan-1', 'sell-orphan-2'],
        'Both sized orphans must be the correction targets'
    );
    for (const create of correction.ordersToPlace) {
        assert.strictEqual(create.state, ORDER_STATES.VIRTUAL, 'Planned create must remain VIRTUAL until broadcast');
        assert(create.size > 0, 'Planned create must carry a positive size');
        assert.strictEqual(create.type, ORDER_TYPES.SELL, 'Planned create must be on the corrected rail');
    }
    console.log('  ✓ Sized orphans accepted as candidates and planned for CREATE');
    console.log('✓ Sized Orphan Spread Correction test PASSED\n');
}

testSizedOrphanSpreadCorrection().catch((err: any) => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
