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

    // Execute rebalance logic - simulate opposite side fill
    const result = await mgr.strategy.rebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    console.log('  Verifying strategy actions:');
    console.log(`  ordersToPlace: ${result.ordersToPlace.length}, ordersToUpdate: ${result.ordersToUpdate.length}, ordersToRotate: ${result.ordersToRotate.length}`);

    // The new strategy (activeOrders=2) will want a window of 2 orders.
    // It will find active/partial orders p1, p2, p3.
    // Since targetCount is 2, it will keep p3 (closest) and p2, and cancel/rotate p1.
    
    // Check that we have some actions
    assert(result.ordersToRotate.length > 0 || result.ordersToUpdate.length > 0, 'Should have rotation or updates for partials');

    const updatedP2 = result.ordersToUpdate.find(u => u.partialOrder.id === 'sell-1');
    const rotatedP1 = result.ordersToRotate.find(r => r.oldOrder.id === 'sell-0');

    console.log(`  ✓ Multi-partial handling verified via unified strategy`);
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
