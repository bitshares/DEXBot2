const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('='.repeat(80));
console.log('Testing Multi-Partial Consolidation Edge Cases (COW)');
console.log('='.repeat(80));

// Helper to setup a manager with grid
async function setupManager(gridSize = 6) {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 60, sell: 60 },
        activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => {
            if (level !== 'debug') console.log(`    [${level}] ${msg}`);
        },
        logFundsStatus: () => {}
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });

    // Setup grid
    for (let i = 0; i < gridSize; i++) {
        const price = 1.0 + (i * 0.05);
        mgr.orders.set(`sell-${i}`, {
            id: `sell-${i}`,
            type: ORDER_TYPES.SELL,
            price: price,
            size: 10,
            state: ORDER_STATES.VIRTUAL
        });
    }

    for (const order of Array.from(mgr.orders.values())) {
        await mgr._updateOrder(order);
    }

    return mgr;
}

// ============================================================================
// TEST 1: SINGLE DUST PARTIAL
// ============================================================================
async function testSingleDustPartial() {
    console.log('\n[Test 1] Single DUST partial (should restore to ideal)');
    console.log('-'.repeat(80));

    const mgr = await setupManager();

    // Create a single tiny partial
    const dustPartial = {
        id: 'sell-2',
        orderId: 'chain-dust',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 0.3,
        state: ORDER_STATES.PARTIAL
    };

    await mgr._updateOrder(dustPartial);

    // Test fixtures create partials via _updateOrder, which stamps them as
    // fresh placements. Consolidation runs on resting partials, so age the
    // stamps to exercise the mechanics rather than the fresh-cancel grace.
    mgr._placedAt.clear();
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    assert(result.actions.length > 0, 'Should have at least one strategy action for partial');
    console.log('✓ Single dust partial correctly handled via COW');
}

// ============================================================================
// TEST 2: MULTIPLE DUST PARTIALS (all at different prices)
// ============================================================================
async function testMultipleDustPartials() {
    console.log('\n[Test 2] Multiple DUST partials at different grid positions');
    console.log('-'.repeat(80));

    const mgr = await setupManager(8);

    const dustPartials = [
        { id: 'sell-1', price: 1.05, size: 0.2, orderId: 'chain-d1' },
        { id: 'sell-3', price: 1.15, size: 0.3, orderId: 'chain-d2' },
        { id: 'sell-5', price: 1.25, size: 0.1, orderId: 'chain-d3' }
    ];

    for (const dp of dustPartials) {
        const order = {
            ...mgr.orders.get(dp.id),
            ...dp,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL
        };
        await mgr._updateOrder(order);
    }

    // Test fixtures create partials via _updateOrder, which stamps them as
    // fresh placements. Consolidation runs on resting partials, so age the
    // stamps to exercise the mechanics rather than the fresh-cancel grace.
    mgr._placedAt.clear();
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    console.log(`  Strategy actions found: ${result.actions.length}`);
    assert(result.actions.length >= 3, `Should have at least 3 strategy actions for 3 partials`);

    console.log('✓ All dust partials correctly handled via COW');
}

// ============================================================================
// TEST 3: SUBSTANTIAL PARTIAL
// ============================================================================
async function testSubstantialPartial() {
    console.log('\n[Test 3] Substantial partial correctly handled');
    console.log('-'.repeat(80));

    const mgr = await setupManager(6);

    const partial = {
        id: 'sell-2',
        orderId: 'chain-inner',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 8,
        state: ORDER_STATES.PARTIAL
    };

    await mgr._updateOrder(partial);

    // Test fixtures create partials via _updateOrder, which stamps them as
    // fresh placements. Consolidation runs on resting partials, so age the
    // stamps to exercise the mechanics rather than the fresh-cancel grace.
    mgr._placedAt.clear();
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    assert(result.actions.length >= 1, `Should have strategy actions`);
    console.log('✓ Substantial partial correctly handled via COW');
}

// ============================================================================
// TEST 4: LARGE RESIDUAL (Oversized)
// ============================================================================
async function testLargeResidual() {
    console.log('\n[Test 4] Large residual capital (oversized partial)');
    console.log('-'.repeat(80));

    const mgr = await setupManager(6);

    const outerOversized = {
        id: 'sell-4',
        orderId: 'chain-outer',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 20, // Double ideal 10
        state: ORDER_STATES.PARTIAL
    };

    await mgr._updateOrder(outerOversized);

    // Test fixtures create partials via _updateOrder, which stamps them as
    // fresh placements. Consolidation runs on resting partials, so age the
    // stamps to exercise the mechanics rather than the fresh-cancel grace.
    mgr._placedAt.clear();
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    // Modern strategy might cancel it if outside window, or update it
    const action = result.actions.find(a => a.id === 'sell-4');
    if (action && action.type === 'update') {
        assert(action.newSize <= 10.1, `Should be anchored down to ideal size, got ${action.newSize}`);
    }

    console.log('✓ Large residual correctly handled via COW');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testSingleDustPartial();
        await testMultipleDustPartials();
        await testSubstantialPartial();
        await testLargeResidual();

        console.log('\n' + '='.repeat(80));
        console.log('All Multi-Partial Edge Case Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', getErrorMessage(err));
        console.error((err as any).stack);
        process.exit(1);
    }
})();
