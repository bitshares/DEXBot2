/**
 * Tests for rebalance symmetric logic using StrategyEngine
 * Verifies that SELL fills and BUY fills are handled symmetrically:
 * - When SELL fills: window shifts, activating replacements
 * - When BUY fills: window shifts, activating replacements
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

console.log('\n========== REBALANCE ORDERS TESTS ==========\n');

/**
 * TEST 1: When SELL fills and BUY < target, should create new BUY orders (via window expansion)
 */
async function testSellFillCreateBuy() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 3, sell: 3 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 active BUYs, 3 active SELLs
    const testOrders = [
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.2' },
        // buy-0 missing - below target of 3 (indices are sorted inward-first: 0 is closest to market)
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.3' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.4' },
        { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.5' },
        // Spread placeholders
        { id: 'buy-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 95 },
        { id: 'sell-X', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 140 }, 
    ];

    testOrders.forEach(o => mgr._updateOrder(o));
    mgr.recalculateFunds();

    // Simulating SELL fill: sell-0 is gone (replaced by virtual)
    mgr._updateOrder({ ...testOrders[2], state: ORDER_STATES.VIRTUAL, orderId: null });
    const fills = [{ type: ORDER_TYPES.SELL, price: 110 }];
    
    // When SELL fills:
    // 1. SELL window expands to maintain target (activates sell-X)
    // 2. BUY window might slide or stay (if below target, expansion happens)
    const result = await mgr.strategy.rebalance(fills);

    const placeByType = {};
    result.ordersToPlace.forEach(o => {
        placeByType[o.type] = (placeByType[o.type] || 0) + 1;
    });

    assert(placeByType[ORDER_TYPES.SELL] >= 1, 'Should activate SELL replacement');
    assert(placeByType[ORDER_TYPES.BUY] >= 1, 'Should expand BUY window if below target');

    console.log('✅ TEST 1 PASSED: SELL fill triggers symmetric rebalance');
}

/**
 * TEST 2: When BUY fills and SELL < target, should create new SELL orders
 */
async function testBuyFillCreateSell() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 3, sell: 3 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 3 active BUYs, 2 active SELLs
    const testOrders = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.2' },
        { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 70, size: 100, orderId: '1.7.3' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.4' },
        { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.5' },
        // sell-0 missing
        { id: 'sell-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 110 },
        { id: 'buy-X', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 60 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));
    mgr.recalculateFunds();

    // Simulating BUY fill: buy-0 is gone
    mgr._updateOrder({ ...testOrders[0], state: ORDER_STATES.VIRTUAL, orderId: null });
    const fills = [{ type: ORDER_TYPES.BUY, price: 90 }];

    const result = await mgr.strategy.rebalance(fills);

    const placeByType = {};
    result.ordersToPlace.forEach(o => {
        placeByType[o.type] = (placeByType[o.type] || 0) + 1;
    });

    assert(placeByType[ORDER_TYPES.BUY] >= 1, 'Should activate BUY replacement');
    assert(placeByType[ORDER_TYPES.SELL] >= 1, 'Should expand SELL window if below target');

    console.log('✅ TEST 2 PASSED: BUY fill triggers symmetric rebalance (BUG FIXED!)');
}

/**
 * TEST 3: When SELL fills and BUY >= target, should rotate BUY orders
 */
async function testSellFillRotateBuy() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 active BUYs (= target), 2 active SELLs
    const testOrders = [
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.1' },
        { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 70, size: 100, orderId: '1.7.2' }, // furthest
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.3' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.4' },
        // buy-0 is SPREAD (inward slot)
        { id: 'buy-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 90 },
        { id: 'sell-X', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 130 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));
    mgr.recalculateFunds();

    // Simulating SELL fill: sell-0 is gone
    mgr._updateOrder({ ...testOrders[2], state: ORDER_STATES.VIRTUAL, orderId: null });
    const fills = [{ type: ORDER_TYPES.SELL, price: 110 }];

    const result = await mgr.strategy.rebalance(fills);

    assert(result.ordersToRotate.length > 0, 'Should rotate orders to maintain contiguous rail');
    const hasRotatedBuy = result.ordersToRotate.some(r => r.type === ORDER_TYPES.BUY);
    assert(hasRotatedBuy, 'Should rotate BUY orders inward when opposite side fills');

    console.log('✅ TEST 3 PASSED: SELL fill rotates BUY when BUY >= target');
}

/**
 * TEST 4: When BUY fills and SELL >= target, should rotate SELL orders
 */
async function testBuyFillRotateSell() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 active BUYs, 2 active SELLs (= target)
    const testOrders = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.2' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.3' },
        { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 130, size: 1, orderId: '1.7.4' }, // furthest
        // sell-0 is SPREAD (inward slot)
        { id: 'sell-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 110 },
        { id: 'buy-X', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 70 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));
    mgr.recalculateFunds();

    // Simulating BUY fill: buy-0 is gone
    mgr._updateOrder({ ...testOrders[0], state: ORDER_STATES.VIRTUAL, orderId: null });
    const fills = [{ type: ORDER_TYPES.BUY, price: 90 }];

    const result = await mgr.strategy.rebalance(fills);

    assert(result.ordersToRotate.length > 0, 'Should rotate orders');
    const hasRotatedSell = result.ordersToRotate.some(r => r.type === ORDER_TYPES.SELL);
    assert(hasRotatedSell, 'Should rotate SELL orders inward when opposite side fills');

    console.log('✅ TEST 4 PASSED: BUY fill rotates SELL when SELL >= target (BUG FIXED!)');
}

/**
 * TEST 5: Both SELL and BUY fill together - should handle both sides
 */
async function testBothSidesFilledTogether() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 2, sell: 2 }
    });

    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10 });

    // Set up orders: 2 BUY, 2 SELL (all at target)
    const testOrders = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 90, size: 100, orderId: '1.7.1' },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 80, size: 100, orderId: '1.7.2' },
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 110, size: 1, orderId: '1.7.3' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 120, size: 1, orderId: '1.7.4' },
        // Replacements
        { id: 'buy-X', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 70 },
        { id: 'sell-X', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 130 },
    ];

    testOrders.forEach(o => mgr._updateOrder(o));
    mgr.recalculateFunds();

    // When both sides fill
    mgr._updateOrder({ ...testOrders[0], state: ORDER_STATES.VIRTUAL, orderId: null });
    mgr._updateOrder({ ...testOrders[2], state: ORDER_STATES.VIRTUAL, orderId: null });
    const fills = [
        { type: ORDER_TYPES.BUY, price: 90 },
        { type: ORDER_TYPES.SELL, price: 110 }
    ];

    const result = await mgr.strategy.rebalance(fills);

    const placeByType = {};
    result.ordersToPlace.forEach(o => {
        placeByType[o.type] = (placeByType[o.type] || 0) + 1;
    });

    // Both should activate expansion (since targetCount is 2 and we have 1 active left on each side)
    assert(placeByType[ORDER_TYPES.BUY] >= 1, 'Should activate BUY expansion');
    assert(placeByType[ORDER_TYPES.SELL] >= 1, 'Should activate SELL expansion');

    console.log('✅ TEST 5 PASSED: Both sides handled correctly when both fill');
}

// Run all tests
(async () => {
    try {
        await testSellFillCreateBuy();
        await testBuyFillCreateSell();
        await testSellFillRotateBuy();
        await testBuyFillRotateSell();
        await testBothSidesFilledTogether();

        console.log('\n✅ All rebalance orders tests passed!\n');
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();

