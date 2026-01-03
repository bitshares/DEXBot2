const assert = require('assert');
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

    // Track ideal sizes for the slots
    const slotIdealSizes = {
        'sell-0': 10, 'sell-v1': 10, 'sell-1': 10, 'sell-v2': 10, 'sell-2': 10, 'sell-v3': 10
    };

    // Mock evaluatePartialOrderAnchor to return correct ideal size from our map
    mgr.strategy.evaluatePartialOrderAnchor = (p, moveInfo) => {
        const idealSize = slotIdealSizes[moveInfo.newGridId] || 10;
        const residualCapital = Math.max(0, (p.size - idealSize) * p.price);
        return {
            isDust: p.size < 5,
            idealSize: idealSize,
            residualCapital: residualCapital
        };
    };

    // Execute rebalance logic
    const result = await mgr._rebalanceSideAfterFill(ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    console.log('  Verifying partialMoves and ordersToUpdate:');
    console.log(`  partialMoves: ${result.partialMoves.length}, ordersToUpdate: ${result.ordersToUpdate.length}`);

    // Combine all moves for verification
    const allMoves = [...result.partialMoves, ...result.ordersToUpdate];
    assert(allMoves.length === 3, `Expected 3 total moves, got ${allMoves.length}`);

    // Sort allMoves by price to be sure of indices (Outermost first)
    const moves = allMoves.sort((a, b) => b.newPrice - a.newPrice);

    // P1 (Outermost): Should be upgraded to ideal size (10) and STAY AT 1.30
    console.log(`  Checking P1 (Outermost, 1.30): newPrice=${moves[0].newPrice}, size=${moves[0].partialOrder.size}`);
    assert(moves[0].partialOrder.size === 10, `P1 should be ideal size 10, got ${moves[0].partialOrder.size}`);
    assert(moves[0].newPrice === 1.30, 'P1 should have stayed at its original price');
    assert(!moves[0].partialOrder.isDoubleOrder, 'P1 should NOT be a double order');

    // P2 (Middle): Should be upgraded to ideal size (10) and STAY AT 1.20
    console.log(`  Checking P2 (Middle, 1.20): newPrice=${moves[1].newPrice}, size=${moves[1].partialOrder.size}`);
    assert(moves[1].partialOrder.size === 10, `P2 should be ideal size 10, got ${moves[1].partialOrder.size}`);
    assert(moves[1].newPrice === 1.20, 'P2 should have stayed at its original price');
    assert(!moves[1].partialOrder.isDoubleOrder, 'P2 should NOT be a double order');

    // Residual from P2: (15 - 10) * 1.20 = 6 USD
    // Innermost partial (P3) at 1.10 price. Ideal=10.
    // Resulting merged size = 10 + (6 / 1.10) = 15.4545
    // 15.45 > 10.5 (threshold). Should SPLIT.
    console.log(`  Checking P3 (Innermost, 1.10): newPrice=${moves[2].newPrice}, size=${moves[2].newSize || moves[2].partialOrder.size}`);
    assert(moves[2].newPrice === 1.10, 'P3 should have stayed at its original price');
    const p3Size = moves[2].newSize || moves[2].partialOrder.size;
    assert(p3Size === 10, `P3 should be restored to exactly ideal 10, got ${p3Size}`);
    assert(!moves[2].partialOrder.isDoubleOrder, 'P3 should NOT be a double order (since it split)');
    assert(moves[2].isSplitUpdate, 'P3 should be marked as a SPLIT update');

    // Verify residual order placement
    console.log(`  Checking ordersToPlace for residual: length=${result.ordersToPlace.length}`);
    assert(result.ordersToPlace.length >= 1, 'Should have created a residual order at the spread');
    const residual = result.ordersToPlace.find(o => o.isResidualFromSplitId);
    assert(residual, 'Residual order should be marked as residual from split');
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
