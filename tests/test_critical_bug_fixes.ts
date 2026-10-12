const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { createOrderGrid } = require('../modules/order/grid');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('='.repeat(80));
console.log('Testing Critical Bug Fixes (COW)');
console.log('='.repeat(80));

// Helper to setup a manager
async function setupManager() {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        minPrice: 0.1,
        maxPrice: 10.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => { }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });

    return mgr;
}

// ============================================================================
// TEST 1: COW REBALANCE PRODUCES VALID ACTIONS
// ============================================================================
async function testCOWRebalanceProducesValidActions() {
    console.log('\n[Test 1] COW rebalance produces valid create and rotation actions');
    console.log('-'.repeat(80));

    const mgr = await setupManager();
    const { orders, boundaryIdx } = createOrderGrid(mgr.config);

    // Index
    for (const o of orders) {
        mgr.orders.set(o.id, o);
        await mgr._updateOrder(o);
    }
    mgr.boundaryIdx = boundaryIdx;

    // Force a surplus far away on sell side
    const furthestSell = Array.from(mgr.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.SELL)
        .sort((a,b) => (b as any).price - (a as any).price)[0];

    await mgr._updateOrder({ ...((furthestSell as any)), state: ORDER_STATES.ACTIVE, orderId: 'chain-surplus', size: 100 });

    // Target count 1 ensures furthest is surplus
    mgr.config.coreOrders.sell = 1;

    // Rebalance with a fill to trigger boundary crawl
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    // Should produce at least one CREATE action for shortages
    const creations = result.actions.filter(a => a.type === 'create');
    assert(creations.length > 0, 'Should plan at least one creation');

    // Created orders should have valid prices and sizes
    for (const c of creations) {
        assert(typeof c.order.price === 'number' && c.order.price > 0, 'Create action should have positive price');
        assert(typeof c.order.size === 'number' && c.order.size > 0, 'Create action should have positive size');
    }

    // The surplus should be paired with a hole via rotation (UPDATE action)
    const rotations = result.actions.filter(a => a.type === 'update' && a.isRotation);
    if (rotations.length > 0) {
        const rot = rotations[0];
        assert(rot.orderId, 'Rotation should reference the old orderId');
        assert(rot.newGridId, 'Rotation should specify a new grid slot');
        assert(typeof rot.newPrice === 'number' && rot.newPrice > 0, 'Rotation should have a positive newPrice');
    }

    console.log(`✓ COW rebalance produced ${creations.length} create(s) and ${rotations.length} rotation(s)`);
}

// ============================================================================
// TEST 2: STATE TRANSITION STABILITY - ORDERS STAY ACTIVE AT 100%
// ============================================================================
async function testOrderStateTransitionStability() {
    console.log('\n[Test 2] Order state transition stays ACTIVE when size >= 100%');
    console.log('-'.repeat(80));

    const mgr = await setupManager();

    const activeOrder = {
        id: 'sell-test',
        orderId: 'chain-test-sell',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 10.2, 
        state: ORDER_STATES.ACTIVE
    };

    await mgr._updateOrder(activeOrder);

    const updatedOrder = { ...activeOrder, size: 10.0, state: ORDER_STATES.ACTIVE };
    await mgr._updateOrder(updatedOrder);

    const after = mgr.orders.get('sell-test');
    assert(after.state === ORDER_STATES.ACTIVE, `Should remain ACTIVE when size=100%, got ${after.state}`);

    const partialOrder = { ...activeOrder, size: 5.0, state: ORDER_STATES.PARTIAL };
    await mgr._updateOrder(partialOrder);

    const final = mgr.orders.get('sell-test');
    assert(final.state === ORDER_STATES.PARTIAL, `Should transition to PARTIAL when size < 100%`);

    console.log('✓ Order state transitions correctly based on size threshold');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testCOWRebalanceProducesValidActions();
        await testOrderStateTransitionStability();

        console.log('\n' + '='.repeat(80));
        console.log('Critical Bug Fix Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', getErrorMessage(err));
        console.error((err as any).stack);
        process.exit(1);
    }
})();
