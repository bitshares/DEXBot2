const assert = require('assert');
const { activateClosestVirtualOrdersForPlacement, prepareFurthestOrdersForRotation, rebalanceSideAfterFill, evaluatePartialOrderAnchor } = require('../modules/order/legacy-testing');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

console.log('='.repeat(70));
console.log('Testing Anchor & Refill Integration - Rebalance Logic');
console.log('='.repeat(70));

// Helper to setup a manager with grid and test orders
function setupManager(name) {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 10000, sell: 10000 },
        activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return; // Skip debug logs
            console.log(`    [${level}] ${msg}`);
        }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    return mgr;
}

// Test 1: Case A - Dust Refill (small partial < threshold)
async function testCaseADustRefill() {
    console.log('\n[Test 1] Case A: Dust Refill - Decision Logic');
    console.log('-'.repeat(70));

    const mgr = setupManager('dust-test');

    // Test the _evaluatePartialOrderAnchor function directly for dust case
    const dustPartial = {
        id: 'buy-3',
        orderId: 'chain-buy-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        price: 0.95,
        size: 1.0  // 1% of ideal (well below 5% or 10% thresholds)
    };

    const moveInfo = {
        targetGridOrder: {
            id: 'buy-5',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 0.96,
            size: 100.0  // Ideal size
        },
        newGridId: 'buy-5',
        newPrice: 0.96
    };

    const decision = evaluatePartialOrderAnchor(mgr, dustPartial, moveInfo);

    console.log('  Testing dust classification (1% < threshold):');
    assert(decision.isDust === true, `Expected isDust=true, got ${decision.isDust}`);
    console.log(`  ✓ isDust: ${decision.isDust}`);
    console.log(`  ✓ percentOfIdeal: ${(decision.percentOfIdeal * 100).toFixed(1)}%`);
    console.log(`  ✓ mergedDustSize: ${decision.mergedDustSize}`);
    console.log(`  ✓ Strategy: Dust will be merged into new allocation with delayed rotation`);
}

// Test 2: Case B - Full Anchor with Residual (large partial >= threshold)
async function testCaseBFullAnchor() {
    console.log('\n[Test 2] Case B: Full Anchor - Decision Logic');
    console.log('-'.repeat(70));

    const mgr = setupManager('anchor-test');

    // Test with substantial partial (25% of ideal)
    const substantialPartial = {
        id: 'sell-2',
        orderId: 'chain-sell-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 1.03,
        size: 25.0  // 25% of ideal (well above 5% or 10% thresholds)
    };

    const moveInfo = {
        targetGridOrder: {
            id: 'sell-5',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 1.05,
            size: 100.0  // Ideal size
        },
        newGridId: 'sell-5',
        newPrice: 1.05
    };

    const decision = evaluatePartialOrderAnchor(mgr, substantialPartial, moveInfo);

    console.log('  Testing substantial classification (25% of ideal):');
    assert(decision.isDust === false, `Expected isDust=false, got ${decision.isDust}`);
    assert(decision.newSize === 100.0, `Expected newSize=100, got ${decision.newSize}`);
    console.log(`  ✓ isDust: ${decision.isDust}`);
    console.log(`  ✓ percentOfIdeal: ${(decision.percentOfIdeal * 100).toFixed(1)}%`);
    console.log(`  ✓ newSize (anchored): ${decision.newSize}`);
    console.log(`  ✓ residualCapital: ${decision.residualCapital.toFixed(8)}`);
    console.log(`  ✓ Strategy: Full anchor to ideal + residual order at spread`);
}

// Test 3: Verify countOrdersByType with pending rotation
function testPendingAwareCountingIntegration() {
    console.log('\n[Test 3] Pending-Aware Counting in Rebalance Context');
    console.log('-'.repeat(70));

    const { countOrdersByType } = require('../modules/order/utils');

    const orders = new Map();

    // Setup: 3 active SELL orders, 2 active BUY orders, 2 virtual BUY orders
    // Mark one SELL as having pendingRotation
    orders.set('sell-0', { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE });
    orders.set('sell-1', { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE });
    orders.set('sell-2', { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, pendingRotation: true });

    orders.set('buy-0', { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE });
    orders.set('buy-1', { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE });
    orders.set('buy-2', { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL });
    orders.set('buy-3', { id: 'buy-3', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL });

    console.log('  Setup:');
    console.log('    - 3 active SELL (one with pendingRotation flag)');
    console.log('    - 2 active BUY');
    console.log('    - 2 virtual BUY');

    const buyCount = countOrdersByType(ORDER_TYPES.BUY, orders);

    // When SELL has pendingRotation, BUY virtual orders should be counted
    // So: 2 active + 2 virtual = 4
    console.log(`\n  BUY count with pending SELL rotation: ${buyCount}`);
    assert(buyCount === 4, `Expected 4 (2 active + 2 virtual as pending-aware), got ${buyCount}`);

    console.log('  ✓ Pending-aware counting verified');
    console.log('    - Active BUY orders: 2');
    console.log('    - Virtual BUY orders counted as pending-aware: 2');
    console.log('    - Total: 4');

    // Clear the pendingRotation flag and recount
    const ordersNoRotation = new Map(orders);
    const sell2 = ordersNoRotation.get('sell-2');
    const updatedSell2 = { ...sell2 };
    delete updatedSell2.pendingRotation;
    ordersNoRotation.set('sell-2', updatedSell2);

    const buyCount2 = countOrdersByType(ORDER_TYPES.BUY, ordersNoRotation);

    console.log(`\n  BUY count without pending rotation: ${buyCount2}`);
    assert(buyCount2 === 2, `Expected 2 (only active), got ${buyCount2}`);

    console.log('  ✓ Without pending rotation, only active orders counted');
    console.log('    - Active BUY orders: 2');
    console.log('    - Virtual BUY orders not counted: 2');
    console.log('    - Total: 2');
}

// Run all integration tests
(async () => {
    try {
        await testCaseADustRefill();
        await testCaseBFullAnchor();
        testPendingAwareCountingIntegration();

        console.log('\n' + '='.repeat(70));
        console.log('All Integration Tests Passed!');
        console.log('='.repeat(70));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Integration test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
