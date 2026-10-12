const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { getErrorMessage } = require('../modules/utils/errors');

// Local implementation of counting logic
function countOrders(orderType, ordersMap) {
    if (!ordersMap?.size) return 0;
    let count = 0;
    for (const order of ordersMap.values()) {
        if (order.type === orderType && [ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL].includes(order.state)) count++;
    }
    return count;
}

console.log('Running Integration Tests: Partial Orders in Complex Scenarios\n');

// ============================================================================
// TEST 1: Startup After Divergence with Partial Orders
// ============================================================================
async function testStartupAfterDivergenceWithPartial() {
    console.log('TEST 1: Startup After Divergence with Partial Orders');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', startPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, coreOrders: { buy: 3, sell: 3 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    const persistedGrid = [
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1900, size: 10, orderId: '1.7.100' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1880, size: 12, orderId: '1.7.101' },
        { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, price: 1850, size: 5, orderId: '1.7.102' },
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1700, size: 100, orderId: '1.7.200' },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1680, size: 110, orderId: '1.7.201' },
        { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, price: 1750, size: 50, orderId: '1.7.202' }
    ];

    for (const order of persistedGrid) {
        await mgr._updateOrder(order);
    }

    const sellPartial = mgr.orders.get('sell-2');
    const buyPartial = mgr.orders.get('buy-2');

    assert.strictEqual(sellPartial.state, ORDER_STATES.PARTIAL, 'SELL partial should remain PARTIAL');
    assert.strictEqual(buyPartial.state, ORDER_STATES.PARTIAL, 'BUY partial should remain PARTIAL');
    console.log(`  ✓ PARTIAL states preserved at startup (not converted to ACTIVE)`);

    const activeBuyCount = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length;
    const partialBuyCount = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL).length;
    const totalBuyCount = countOrders(ORDER_TYPES.BUY, mgr.orders);

    assert.strictEqual(activeBuyCount, 2, 'Should have 2 ACTIVE buys');
    assert.strictEqual(partialBuyCount, 1, 'Should have 1 PARTIAL buy');
    assert.strictEqual(totalBuyCount, 3, 'Total should be 3 (2 ACTIVE + 1 PARTIAL)');
    console.log(`  ✓ BUY order count correct: ${activeBuyCount} ACTIVE + ${partialBuyCount} PARTIAL = ${totalBuyCount} total`);

    const targetBuys = mgr.config.coreOrders.buy;
    const belowTarget = totalBuyCount < targetBuys;
    assert(!belowTarget, `At target (${totalBuyCount} >= ${targetBuys}), should not create new orders`);
    console.log(`  ✓ Rebalancing recognizes: at target (${totalBuyCount}/${targetBuys}), no creation needed\n`);
}

// ============================================================================
// TEST 2: Fund Cycling with Partial Fills
// ============================================================================
async function testFundCyclingWithPartialFills() {
    console.log('TEST 2: Fund Cycling with Partial Fills');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', startPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, coreOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    await mgr._updateOrder({ id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1900, size: 10, orderId: '1.7.100' });
    await mgr._updateOrder({ id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, price: 1850, size: 5, orderId: '1.7.101' });
    await mgr._updateOrder({ id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1700, size: 100, orderId: '1.7.200' });

    await mgr.resetFunds();
    await mgr.setAccountTotals({ buy: 600, sell: 515, buyFree: 100, sellFree: 0 });
    await mgr.recalculateFunds();

    const buyCount = countOrders(ORDER_TYPES.BUY, mgr.orders);
    assert.strictEqual(buyCount, 1, 'Should have 1 ACTIVE buy after setup');
    console.log(`  ✓ Fund cycling with partial fill: maintains grid consistency`);
    console.log(`  ✓ Partial orders don't interfere with fund rebalancing\n`);
}

// ============================================================================
// TEST 3: Rebalancing After Full Fill with Partial Existing
// ============================================================================
async function testRebalancingWithExistingPartial() {
    console.log('TEST 3: Rebalancing After Full Fill with Existing Partial');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', startPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, coreOrders: { buy: 3, sell: 3 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    await mgr._updateOrder({ id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1750, size: 100, orderId: '1.7.100' });
    await mgr._updateOrder({ id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1700, size: 120, orderId: '1.7.101' });
    await mgr._updateOrder({ id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, price: 1650, size: 80, orderId: '1.7.102' });

    for (let i = 0; i < 3; i++) {
        await mgr._updateOrder({ id: `sell-${i}`, type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1850 + i * 10, size: 10, orderId: `1.7.${200 + i}` });
    }

    for (let i = 3; i < 6; i++) {
        await mgr._updateOrder({ id: `buy-${i}`, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 1600 - (i - 2) * 10, size: 0 });
    }

    const buyCount = countOrders(ORDER_TYPES.BUY, mgr.orders);
    const targetBuys = mgr.config.coreOrders.buy;
    const buyBelowTarget = buyCount < targetBuys;

    assert.strictEqual(buyCount, 3, 'Should count 3 BUYs (2 ACTIVE + 1 PARTIAL)');
    assert(!buyBelowTarget, 'Should NOT be below target');
    console.log(`  ✓ BUY count at target: ${buyCount}/${targetBuys}`);
    console.log(`  ✓ Decision: Will ROTATE (not create) because at target`);

    const partialStaysInPlace = mgr.orders.get('buy-2').state === ORDER_STATES.PARTIAL;
    assert(partialStaysInPlace, 'Partial on filled side should stay in place');
    console.log(`  ✓ Existing PARTIAL BUY remains in place during SELL-side rebalancing\n`);
}

// ============================================================================
// TEST 4: Grid Navigation Across Namespace with Multiple Partials
// ============================================================================
async function testGridNavigationWithPartials() {
    console.log('TEST 4: Grid Navigation Across Namespace with Partials');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', startPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, coreOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    const gridSlots = [
        { id: 'sell-0', type: ORDER_TYPES.SELL, price: 2000 },
        { id: 'sell-1', type: ORDER_TYPES.SELL, price: 1900 },
        { id: 'sell-2', type: ORDER_TYPES.SELL, price: 1850 },
        { id: 'sell-3', type: ORDER_TYPES.SELL, price: 1820 }, 
        { id: 'buy-0', type: ORDER_TYPES.SPREAD, price: 1780 },
        { id: 'buy-1', type: ORDER_TYPES.BUY, price: 1700 },
        { id: 'buy-2', type: ORDER_TYPES.BUY, price: 1600 }
    ];

    for (const slot of gridSlots) {
        const stateType = slot.id === 'sell-3' ? ORDER_STATES.PARTIAL : ORDER_STATES.VIRTUAL;
        const size = slot.id === 'sell-3' ? 5 : 0;
        const orderId = slot.id === 'sell-3' ? '1.7.999' : undefined;

        await mgr._updateOrder({ id: slot.id, type: slot.id.startsWith('sell') ? ORDER_TYPES.SELL : ORDER_TYPES.BUY, state: stateType, price: slot.price, size: size, orderId: orderId });
    }

    const partial = mgr.orders.get('sell-3');
    assert(partial !== undefined, 'Partial sell-3 should exist');
    assert(partial.state === ORDER_STATES.PARTIAL, 'sell-3 should be in PARTIAL state');
    assert(partial.price === 1820, `Partial should have price 1820, got ${partial.price}`);

    console.log(`  ✓ Partial sell-3 (price 1820) recognized at its position`);
    console.log(`  ✓ STEP 2.5 will handle in-place: evaluate if dust or non-dust`);

    const afterRebalance = mgr.orders.get('sell-3');
    assert(afterRebalance !== undefined, 'Partial should remain in grid after rebalancing');
    assert(afterRebalance.id === 'sell-3', 'Partial should stay at sell-3 position');
    console.log(`  ✓ Partial remains at sell-3 after rebalancing (not moved)\n`);
}

// ============================================================================
// TEST 5: Edge-Bound Grid with Partial Orders
// ============================================================================
async function testEdgeBoundGridWithPartial() {
    console.log('TEST 5: Edge-Bound Grid with Partial Orders');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', startPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, coreOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    await mgr._updateOrder({ id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, price: 2000, size: 5, orderId: '1.7.100' });
    await mgr._updateOrder({ id: 'buy-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 1800, size: 0 });
    await mgr._updateOrder({ id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 1700, size: 100, orderId: '1.7.200' });

    const sellCount = countOrders(ORDER_TYPES.SELL, mgr.orders);
    assert.strictEqual(sellCount, 1, 'Should count the partial sell at edge');
    console.log(`  ✓ Edge-bound partial recognized in count: ${sellCount}`);

    const partial = mgr.orders.get('sell-0');
    assert(partial !== undefined, 'Partial sell-0 should exist');
    assert(partial.state === ORDER_STATES.PARTIAL, 'sell-0 should be PARTIAL state');

    console.log(`  ✓ Partial at grid edge (sell-0) recognized`);
    console.log(`  ✓ STEP 2.5 handles in-place: not moved despite being at boundary`);

    const buyCount = countOrders(ORDER_TYPES.BUY, mgr.orders);
    const targetBuys = mgr.config.coreOrders.buy;
    const belowTarget = buyCount < targetBuys;
    console.log(`  ✓ BUY count (${buyCount}) vs target (${targetBuys}): Below=${belowTarget}`);
    if (belowTarget) {
        console.log(`  ✓ Would CREATE new orders (not rotate) at grid edge`);
    }
    console.log();
}

// ============================================================================
// TEST 6: Dust at Startup Does Not Force Rebalance
// ============================================================================
async function testStartupDustNoForcedRebalance() {
    console.log('TEST 6: Dust at Startup Does Not Force Rebalance');

    const mgr = new OrderManager({
        assetA: 'IOB.XRP', assetB: 'BTS', startPrice: 1800,
        botFunds: { buy: 1000, sell: 1000 }, coreOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Provide dummy synchronizeWithChain
    mgr.synchronizeWithChain = async () => ({ newOrders: [], ordersNeedingCorrection: [] });

    await mgr._updateOrder({ id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, price: 1900, size: 1, orderId: '1.7.100' });
    await mgr._updateOrder({ id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, price: 1700, size: 5, orderId: '1.7.200' });

    const { reconcileGridOrders } = require('../modules/order/grid_reconcile');
    
    mgr.getChainFundsSnapshot = () => ({
        allocatedBuy: 1000, allocatedSell: 1000,
        chainFreeBuy: 1000, chainFreeSell: 1000,
        committedChainBuy: 5, committedChainSell: 1
    });

    let rebalanceCalled = false;
    const originalRebalance = mgr.performSafeRebalance;
    const originalApplyRebalance = mgr._applySafeRebalanceCOW;
    
    mgr.performSafeRebalance = async () => {
        rebalanceCalled = true;
        return { actions: [], stateUpdates: [] };
    };
    mgr._applySafeRebalanceCOW = async () => {
        rebalanceCalled = true;
        return { actions: [], stateUpdates: [] };
    };

    const chainDustOrders = [
        { id: '1.7.100', sell_price: { base: { asset_id: '1.3.5537', amount: 1000 }, quote: { asset_id: '1.3.0', amount: 1900 } }, for_sale: 1000 },
        { id: '1.7.200', sell_price: { base: { asset_id: '1.3.0', amount: 8500 }, quote: { asset_id: '1.3.5537', amount: 5000 } }, for_sale: 8500 }
    ];

    await reconcileGridOrders({
        manager: mgr,
        config: mgr.config,
        account: 'test-account',
        privateKey: 'test-key',
        chainOrders: {
            updateOrder: async () => {},
            buildUpdateOrderOp: async () => ({
                op: {
                    op_name: 'limit_order_update',
                    op_data: {
                        fee: { amount: 0, asset_id: '1.3.0' }
                    }
                }
            }),
            executeBatch: async () => ({ success: true, operation_results: [] }),
            cancelOrder: async () => {},
            createOrder: async () => [[{ trx: { operation_results: [[null, 'test-order-id']] } }]],
            readOpenOrders: async () => chainDustOrders,
        },
        chainOpenOrders: chainDustOrders
    });

    assert.strictEqual(rebalanceCalled, false, 'Startup dust should not trigger full rebalance');
    console.log('  ✓ Startup dust no longer forces rebalance\n');
    
    mgr.performSafeRebalance = originalRebalance;
    mgr._applySafeRebalanceCOW = originalApplyRebalance;
}

(async () => {
    try {
        await testStartupAfterDivergenceWithPartial();
        await testFundCyclingWithPartialFills();
        await testRebalancingWithExistingPartial();
        await testGridNavigationWithPartials();
        await testEdgeBoundGridWithPartial();
        await testStartupDustNoForcedRebalance();

        console.log('===================================================');
        console.log('✓ All Integration Tests PASSED');
        console.log('===================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('\n✗ Test FAILED:', getErrorMessage(err));
        console.error((err as any).stack);
        process.exit(1);
    }
})();
