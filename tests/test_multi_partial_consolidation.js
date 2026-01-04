const assert = require('assert');
const { activateClosestVirtualOrdersForPlacement, prepareFurthestOrdersForRotation, rebalanceSideAfterFill, evaluatePartialOrderAnchor } = require('../modules/order/legacy-testing');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

console.log('='.repeat(70));
console.log('Testing Multi-Partial Consolidation Rule');
console.log('='.repeat(70));

// Helper to setup a manager with grid and test orders
function setupManager() {
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
            if (level === 'debug') return;
            console.log(`    [${level}] ${msg}`);
        }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Setup a simple grid with slots between partials, all with size 10
    mgr.orders.set('sell-0', { id: 'sell-0', type: ORDER_TYPES.SELL, price: 1.30, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-v1', { id: 'sell-v1', type: ORDER_TYPES.SELL, price: 1.25, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-1', { id: 'sell-1', type: ORDER_TYPES.SELL, price: 1.20, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-v2', { id: 'sell-v2', type: ORDER_TYPES.SELL, price: 1.15, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-2', { id: 'sell-2', type: ORDER_TYPES.SELL, price: 1.10, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-v3', { id: 'sell-v3', type: ORDER_TYPES.SELL, price: 1.05, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('buy-0', { id: 'buy-0', type: ORDER_TYPES.BUY, price: 0.90, size: 10, state: ORDER_STATES.ACTIVE });
    mgr.orders.set('buy-1', { id: 'buy-1', type: ORDER_TYPES.BUY, price: 0.80, size: 10, state: ORDER_STATES.ACTIVE });

    // Initialize indices by adding the initial orders
    for (const order of mgr.orders.values()) {
        mgr._updateOrder(order);
    }

    return mgr;
}

async function testMultiPartialConsolidation() {
    console.log('\n[Test] Consolidating 3 SELL partials');
    console.log('-'.repeat(70));

    const mgr = setupManager();

    // Setup 3 partial SELL orders
    // P1 (130, size 2) - Outermost
    // P2 (120, size 15) - Middle (has residual: 15 - 10 = 5)
    // P3 (110, size 1) - Innermost
    const p1 = { id: 'sell-0', orderId: 'chain-p1', type: ORDER_TYPES.SELL, price: 1.30, size: 2, state: ORDER_STATES.PARTIAL };
    const p2 = { id: 'sell-1', orderId: 'chain-p2', type: ORDER_TYPES.SELL, price: 1.20, size: 15, state: ORDER_STATES.PARTIAL };
    const p3 = { id: 'sell-2', orderId: 'chain-p3', type: ORDER_TYPES.SELL, price: 1.10, size: 1, state: ORDER_STATES.PARTIAL };

    mgr._updateOrder(p1);
    mgr._updateOrder(p2);
    mgr._updateOrder(p3);

    // Execute rebalance logic
    const result = await rebalanceSideAfterFill(mgr, ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    console.log('  Verifying partialMoves and ordersToUpdate:');
    console.log(`  partialMoves: ${result.partialMoves.length}, ordersToUpdate: ${result.ordersToUpdate.length}, ordersToRotate: ${result.ordersToRotate.length}`);

    // Combine all moves for verification (Rotated partials are in ordersToRotate)
    const allMoves = [
        ...result.partialMoves.map(m => ({ id: m.partialOrder.id, newPrice: m.newPrice, newSize: m.newSize, isDouble: m.partialOrder.isDoubleOrder })),
        ...result.ordersToUpdate.map(m => ({ id: m.partialOrder.id, newPrice: m.partialOrder.price, newSize: m.newSize, isDouble: m.partialOrder.isDoubleOrder })),
        ...result.ordersToRotate.map(m => ({ id: m.oldOrder.id, newPrice: m.newPrice, newSize: m.newSize, isDouble: m.oldOrder.isDoubleOrder }))
    ];
    assert(allMoves.length === 3, `Expected 3 total moves, got ${allMoves.length}`);

    // Find each specific partial by its ID
    const m1 = allMoves.find(m => m.id === 'sell-0');
    const m2 = allMoves.find(m => m.id === 'sell-1');
    const m3 = allMoves.find(m => m.id === 'sell-2');

    // P1 (sell-0): Should be upgraded to its new geometric ideal and shifted to near-market price
    console.log(`  Checking P1 (sell-0): newPrice=${m1.newPrice}, size=${m1.newSize}`);
    assert(m1.newSize > 0, `P1 should have a non-zero ideal size`);
    assert(m1.newPrice === 1.05, 'P1 should have rotated to near-market slot price 1.05');

    // P2 (sell-1): Should be upgraded to its geometric ideal and STAY AT 1.20
    console.log(`  Checking P2 (sell-1): newPrice=${m2.newPrice}, size=${m2.newSize}`);
    assert(m2.newSize > 0, `P2 should have a non-zero ideal size`);
    assert(m2.newPrice === 1.20, 'P2 should have stayed at its original price');

    // P3 (sell-2): Should be anchored to its geometric ideal and STAY AT 1.10
    console.log(`  Checking P3 (sell-2): newPrice=${m3.newPrice}, size=${m3.newSize}`);
    assert(m3.newPrice === 1.10, 'P3 should have stayed at its original price');
    assert(m3.newSize > 0, `P3 should have a non-zero ideal size`);

    // Verify residual order placement
    console.log(`  Checking ordersToPlace for residual: length=${result.ordersToPlace.length}`);
    const residual = result.ordersToPlace.find(o => o.isResidualFromAnchor);
    assert(residual, 'Should have created a residual order marked as isResidualFromAnchor');
    console.log(`  ✓ Multi-partial consolidation (Split Branch) verified`);
}

(async () => {
    try {
        await testMultiPartialConsolidation();
        console.log('\n' + '='.repeat(70));
        console.log('All Multi-Partial Consolidation Tests Passed!');
        console.log('='.repeat(70));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
