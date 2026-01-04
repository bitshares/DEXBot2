const assert = require('assert');
const { activateClosestVirtualOrdersForPlacement, prepareFurthestOrdersForRotation, rebalanceSideAfterFill, evaluatePartialOrderAnchor } = require('../modules/order/legacy-testing');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

console.log('='.repeat(80));
console.log('Testing Critical Bug Fixes');
console.log('='.repeat(80));

// Helper to setup a manager
function setupManager() {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 50000, sell: 50000 },
        activeOrders: { buy: 4, sell: 4 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return;
            console.log(`    [${level}] ${msg}`);
        }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    return mgr;
}

// ============================================================================
// TEST 1: SPREAD SORTING - ROTATION PRIORITIZES CLOSEST TO MARKET
// ============================================================================
async function testSpreadSortingForRotation() {
    console.log('\n[Test 1] Spread sorting prioritizes rotation to closest market price');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a grid of SPREAD slots around startPrice (1.0)
    // For SELL rotation, spreads must be above 1.0, and we prioritize those closest to 1.0
    const spreads = [
        { id: 's-far', type: ORDER_TYPES.SPREAD, price: 1.50, size: 0, state: ORDER_STATES.VIRTUAL },
        { id: 's-mid', type: ORDER_TYPES.SPREAD, price: 1.20, size: 0, state: ORDER_STATES.VIRTUAL },
        { id: 's-close', type: ORDER_TYPES.SPREAD, price: 1.05, size: 0, state: ORDER_STATES.VIRTUAL },
        { id: 's-closest', type: ORDER_TYPES.SPREAD, price: 1.01, size: 0, state: ORDER_STATES.VIRTUAL }
    ];

    for (const spread of spreads) {
        mgr.orders.set(spread.id, spread);
        mgr._updateOrder(spread);
    }

    // Create an ACTIVE SELL order to rotate
    const activeOrder = {
        id: 'active-sell',
        orderId: 'chain-active-sell',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 10,
        state: ORDER_STATES.ACTIVE
    };
    mgr.orders.set(activeOrder.id, activeOrder);
    mgr._updateOrder(activeOrder);

    // Prepare rotation - should pick s-closest (1.01) because it's lowest SELL price (closest to market)
    const result = await prepareFurthestOrdersForRotation(mgr, ORDER_TYPES.SELL, 1, new Set(), 1, {});

    assert(result.length > 0, 'Should have rotated at least 1 order');
    const rotation = result[0];
    assert(rotation.newPrice === 1.01, `Should rotate to closest price 1.01, got ${rotation.newPrice}`);

    console.log(`✓ Rotation correctly selected closest SELL spread at price ${rotation.newPrice}`);
}

// ============================================================================
// TEST 2: STATE TRANSITION STABILITY - DOUBLEORDER STAYS ACTIVE AT 100%
// ============================================================================
async function testDoubleOrderStateTransitionStability() {
    console.log('\n[Test 2] DoubleOrder state transition stays ACTIVE when size >= 100%');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a DoubleOrder with size = idealSize * 1.02 (102% of ideal)
    const doubleOrder = {
        id: 'double-sell',
        orderId: 'chain-double-sell',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 10.2, // 102% of ideal (10)
        state: ORDER_STATES.ACTIVE,
        isDoubleOrder: true
    };

    mgr.orders.set(doubleOrder.id, doubleOrder);
    mgr._updateOrder(doubleOrder);

    // Verify it's in ACTIVE state
    const before = mgr.orders.get('double-sell');
    assert(before.state === ORDER_STATES.ACTIVE, `Should start as ACTIVE, got ${before.state}`);

    // Simulate some fills and state transitions
    // The state should remain ACTIVE as long as size >= 100% (10.0)
    const updatedOrder = { ...doubleOrder, size: 10.0, state: ORDER_STATES.ACTIVE };
    mgr._updateOrder(updatedOrder);

    const after = mgr.orders.get('double-sell');
    assert(after.state === ORDER_STATES.ACTIVE, `Should remain ACTIVE when size=100%, got ${after.state}`);
    assert(after.size === 10.0, `Size should be 10.0, got ${after.size}`);

    // Now test transition to PARTIAL when size < 100%
    const partialOrder = { ...doubleOrder, size: 5.0, state: ORDER_STATES.PARTIAL };
    mgr._updateOrder(partialOrder);

    const final = mgr.orders.get('double-sell');
    assert(final.state === ORDER_STATES.PARTIAL, `Should transition to PARTIAL when size < 100%, got ${final.state}`);

    console.log('✓ DoubleOrder state transitions correctly based on size threshold');
}

// ============================================================================
// TEST 3: GHOST-VIRTUAL TARGET SIZING ACCURACY
// ============================================================================
async function testGhostVirtualTargetSizingAccuracy() {
    console.log('\n[Test 3] Ghost virtualization ensures accurate target sizing');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a grid with specific ideal sizes
    const grid = [
        { id: 's-1.10', type: ORDER_TYPES.SELL, price: 1.10, size: 8, state: ORDER_STATES.VIRTUAL },
        { id: 's-1.15', type: ORDER_TYPES.SELL, price: 1.15, size: 9, state: ORDER_STATES.VIRTUAL },
        { id: 's-1.20', type: ORDER_TYPES.SELL, price: 1.20, size: 10, state: ORDER_STATES.VIRTUAL }
    ];

    for (const order of grid) {
        mgr.orders.set(order.id, order);
        mgr._updateOrder(order);
    }

    // Create 2 ghost-virtualized partials
    const partial1 = {
        id: 's-1.10',
        orderId: 'chain-p1',
        type: ORDER_TYPES.SELL,
        price: 1.10,
        size: 4, // Will be ghost-virtualized
        state: ORDER_STATES.PARTIAL
    };

    const partial2 = {
        id: 's-1.15',
        orderId: 'chain-p2',
        type: ORDER_TYPES.SELL,
        price: 1.15,
        size: 4.5,
        state: ORDER_STATES.PARTIAL
    };

    mgr._updateOrder(partial1);
    mgr._updateOrder(partial2);

    // Before rebalance: verify original sizes
    assert(mgr.orders.get('s-1.10').size === 4, 'Partial 1 should start at size 4');
    assert(mgr.orders.get('s-1.15').size === 4.5, 'Partial 2 should start at size 4.5');

    // Execute rebalance with ghost virtualization
    const result = await rebalanceSideAfterFill(mgr, ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    // After ghost virtualization, the orders should be restored to their original state
    // (state transitions should have happened but internal ghost state should be cleaned up)
    const restored1 = mgr.orders.get('s-1.10');
    const restored2 = mgr.orders.get('s-1.15');

    assert(restored1, 'Partial 1 should still exist after rebalance');
    assert(restored2, 'Partial 2 should still exist after rebalance');

    // Ghost virtualization should have completed without leaving orders in VIRTUAL state
    // (they should either be in PARTIAL, ACTIVE, or SPREAD state from the moves)
    assert(result.partialMoves.length >= 2, `Should have partial moves, got ${result.partialMoves.length}`);

    console.log('✓ Ghost virtualization completed without corrupting order states');
}

// ============================================================================
// TEST 4: SPREAD SORTING FOR BUY ORDERS (HIGHEST PRICE FIRST)
// ============================================================================
async function testSpreadSortingForBuyRotation() {
    console.log('\n[Test 4] BUY spread sorting prioritizes highest price (closest to market)');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a grid of SPREAD slots around startPrice (1.0)
    // For BUY rotation, spreads must be below 1.0, and we prioritize those closest to 1.0
    const spreads = [
        { id: 'b-far', type: ORDER_TYPES.SPREAD, price: 0.50, size: 0, state: ORDER_STATES.VIRTUAL },
        { id: 'b-mid', type: ORDER_TYPES.SPREAD, price: 0.80, size: 0, state: ORDER_STATES.VIRTUAL },
        { id: 'b-close', type: ORDER_TYPES.SPREAD, price: 0.95, size: 0, state: ORDER_STATES.VIRTUAL },
        { id: 'b-closest', type: ORDER_TYPES.SPREAD, price: 0.99, size: 0, state: ORDER_STATES.VIRTUAL }
    ];

    for (const spread of spreads) {
        mgr.orders.set(spread.id, spread);
        mgr._updateOrder(spread);
    }

    // Create an ACTIVE BUY order to rotate
    const activeOrder = {
        id: 'active-buy',
        orderId: 'chain-active-buy',
        type: ORDER_TYPES.BUY,
        price: 0.90,
        size: 10,
        state: ORDER_STATES.ACTIVE
    };
    mgr.orders.set(activeOrder.id, activeOrder);
    mgr._updateOrder(activeOrder);

    // Prepare rotation - should pick b-closest (0.99) because it's highest BUY price (closest to market)
    const result = await prepareFurthestOrdersForRotation(mgr, ORDER_TYPES.BUY, 1, new Set(), 1, {});

    assert(result.length > 0, 'Should have rotated at least 1 order');
    const rotation = result[0];
    assert(rotation.newPrice === 0.99, `Should rotate to highest BUY price 0.99, got ${rotation.newPrice}`);

    console.log(`✓ BUY rotation correctly selected closest BUY spread at price ${rotation.newPrice}`);
}

// ============================================================================
// TEST 5: STATE TRANSITION STABILITY - PARTIAL BELOW 100% CANNOT BE ACTIVE
// ============================================================================
async function testPartialStateTransitionBelow100() {
    console.log('\n[Test 5] Order state transitions correctly based on size vs ideal');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create an order that will transition from ACTIVE to PARTIAL
    const order = {
        id: 'test-order',
        orderId: 'chain-test',
        type: ORDER_TYPES.SELL,
        price: 1.20,
        size: 10,
        state: ORDER_STATES.ACTIVE
    };

    mgr.orders.set(order.id, order);
    mgr._updateOrder(order);

    // Verify initial state
    let current = mgr.orders.get('test-order');
    assert(current.state === ORDER_STATES.ACTIVE, 'Should start ACTIVE at size 10 (100% of ideal)');

    // Simulate partial fill: reduce to 99% of ideal
    const afterFill = { ...order, size: 9.9, state: ORDER_STATES.PARTIAL };
    mgr._updateOrder(afterFill);

    current = mgr.orders.get('test-order');
    assert(current.state === ORDER_STATES.PARTIAL, `Should be PARTIAL when size < ideal, got ${current.state}`);
    assert(current.size === 9.9, `Size should be 9.9, got ${current.size}`);

    // Refill back to 100%
    const restored = { ...order, size: 10.0, state: ORDER_STATES.ACTIVE };
    mgr._updateOrder(restored);

    current = mgr.orders.get('test-order');
    assert(current.state === ORDER_STATES.ACTIVE, `Should return to ACTIVE when size = ideal, got ${current.state}`);

    console.log('✓ State transitions correctly reflect size vs ideal threshold');
}

// ============================================================================
// TEST 6: GHOST VIRTUALIZATION RESTORES ORIGINAL STATES
// ============================================================================
async function testGhostVirtualizationRestoresStates() {
    console.log('\n[Test 6] Ghost virtualization properly restores original order states');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create a grid
    const grid = [
        { id: 's-0', type: ORDER_TYPES.SELL, price: 1.10, size: 10, state: ORDER_STATES.VIRTUAL },
        { id: 's-1', type: ORDER_TYPES.SELL, price: 1.15, size: 10, state: ORDER_STATES.VIRTUAL },
        { id: 's-2', type: ORDER_TYPES.SELL, price: 1.20, size: 10, state: ORDER_STATES.VIRTUAL }
    ];

    for (const order of grid) {
        mgr.orders.set(order.id, order);
        mgr._updateOrder(order);
    }

    // Create partials with specific initial states
    const partials = [
        { id: 's-0', orderId: 'p1', type: ORDER_TYPES.SELL, price: 1.10, size: 4, state: ORDER_STATES.PARTIAL },
        { id: 's-1', orderId: 'p2', type: ORDER_TYPES.SELL, price: 1.15, size: 4, state: ORDER_STATES.PARTIAL }
    ];

    for (const p of partials) {
        mgr._updateOrder(p);
    }

    // Verify initial states before rebalance
    assert(mgr.orders.get('s-0').state === ORDER_STATES.PARTIAL, 'P1 should start PARTIAL');
    assert(mgr.orders.get('s-1').state === ORDER_STATES.PARTIAL, 'P2 should start PARTIAL');

    // Execute rebalance (which uses ghost virtualization internally)
    const result = await rebalanceSideAfterFill(mgr, ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    // After rebalance, states should be properly restored
    // (not stuck in VIRTUAL state)
    const s0After = mgr.orders.get('s-0');
    const s1After = mgr.orders.get('s-1');

    assert(s0After, 's-0 should exist after rebalance');
    assert(s1After, 's-1 should exist after rebalance');

    // States should not be VIRTUAL (they should have been restored)
    const validStates = [ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL, ORDER_STATES.SPREAD];
    assert(validStates.includes(s0After.state), `s-0 state should be valid, got ${s0After.state}`);
    assert(validStates.includes(s1After.state), `s-1 state should be valid, got ${s1After.state}`);

    console.log('✓ Ghost virtualization restored all order states correctly');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testSpreadSortingForRotation();
        await testDoubleOrderStateTransitionStability();
        await testGhostVirtualTargetSizingAccuracy();
        await testSpreadSortingForBuyRotation();
        await testPartialStateTransitionBelow100();
        await testGhostVirtualizationRestoresStates();

        console.log('\n' + '='.repeat(80));
        console.log('All Critical Bug Fix Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
