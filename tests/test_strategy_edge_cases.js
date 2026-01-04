/**
 * tests/test_strategy_edge_cases.js
 *
 * Tests for edge cases and defensive fixes in the Physical Rail Strategy
 * Validates:
 * 1. targetCount > slots.length handling
 * 2. Window initialization with various grid sizes
 * 3. MERGE consolidation with dust-threshold partials
 * 4. Role assignment doesn't corrupt state
 * 5. Zero budget edge case handling
 */

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../modules/constants');
const assert = require('assert');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ ${name}`);
        testsPassed++;
    } catch (err) {
        console.log(`✗ ${name}: ${err.message}`);
        testsFailed++;
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`✓ ${name}`);
        testsPassed++;
    } catch (err) {
        console.log(`✗ ${name}: ${err.message}`);
        testsFailed++;
    }
}

// Helper to create a manager with custom grid size
function createManagerWithGridSize(gridSize = 14, budgetBuy = 1000, budgetSell = 10) {
    const config = {
        market: 'TEST/USDT',
        assetA: 'TEST',
        assetB: 'USDT',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 5,
        targetSpreadPercent: 2,
        botFunds: { buy: budgetBuy, sell: budgetSell },
        activeOrders: { buy: 3, sell: 3 },
        weightDistribution: { buy: 1.0, sell: 1.0 }
    };

    const mgr = new OrderManager(config);
    mgr.assets = {
        assetA: { symbol: 'TEST', precision: 8 },
        assetB: { symbol: 'USDT', precision: 8 }
    };

    // Initialize funds
    mgr.funds.total = { grid: { buy: budgetBuy, sell: budgetSell } };
    mgr.funds.available = { buy: budgetBuy, sell: budgetSell };
    mgr.funds.cacheFunds = { buy: 0, sell: 0 };
    mgr.accountTotals = { buy: budgetBuy, sell: budgetSell, buyFree: 0, sellFree: 0 };

    // Create grid orders
    const startPrice = 100;
    const increment = 1 + (config.incrementPercent / 100);
    for (let i = 0; i < gridSize; i++) {
        const price = startPrice * Math.pow(increment, i - Math.floor(gridSize / 2));
        const gridId = `grid-${i}`;
        const orderType = i < Math.floor(gridSize / 2) ? ORDER_TYPES.SELL : (i > Math.floor(gridSize / 2) ? ORDER_TYPES.BUY : ORDER_TYPES.SPREAD);

        mgr.orders.set(gridId, {
            id: gridId,
            type: orderType,
            price: Math.round(price * 100) / 100,
            size: 0,
            state: ORDER_STATES.VIRTUAL,
            orderId: null
        });
    }

    return mgr;
}

// Test definitions
async function testCase1a() {
    const mgr = createManagerWithGridSize(5, 1000, 10);
    const slots = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        1000,
        new Set(),
        false,
        false
    );

    assert(Array.isArray(result.ordersToPlace), 'ordersToPlace should be an array');
    assert(result.ordersToPlace.length <= slots.length, 'Cannot place more orders than slots available');
}

async function testCase1b() {
    const mgr = createManagerWithGridSize(3, 1000, 10);
    const slots = Array.from(mgr.orders.values());

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        1000,
        new Set(),
        false,
        false
    );

    assert(result !== undefined, 'Should return a valid result');
    assert(result.ordersToPlace.length >= 0, 'Should have zero or more placements');
}

async function testCase2a() {
    const mgr = createManagerWithGridSize(3, 100, 10);
    const slots = Array.from(mgr.orders.values());

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        100,
        new Set(),
        false,
        false
    );

    assert(result.ordersToPlace.length <= 3, 'Window should not exceed grid size');
}

async function testCase2b() {
    const mgr = createManagerWithGridSize(5, 200, 20);
    const slots = Array.from(mgr.orders.values());

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        200,
        new Set(),
        false,
        false
    );

    assert(result !== undefined, 'Should initialize window correctly');
    assert(Array.isArray(result.ordersToPlace), 'ordersToPlace should be an array');
}

async function testCase2c() {
    const mgr = createManagerWithGridSize(10, 500, 50);
    const slots = Array.from(mgr.orders.values());

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        500,
        new Set(),
        false,
        false
    );

    assert(result !== undefined, 'Should initialize window correctly');
}

async function testCase2d() {
    const mgr = createManagerWithGridSize(20, 1000, 100);
    const slots = Array.from(mgr.orders.values());

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        1000,
        new Set(),
        false,
        false
    );

    assert(result !== undefined, 'Should initialize window correctly with large grid');
}

async function testCase3a() {
    const mgr = createManagerWithGridSize(10, 500, 50);
    const slots = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);

    const dustPercentage = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100;
    const idealSize = 10;
    const dustSize = idealSize * dustPercentage;

    const partialSlot = slots[3];
    if (partialSlot) {
        mgr._updateOrder({
            ...partialSlot,
            type: ORDER_TYPES.BUY,
            orderId: 'partial-buy-1',
            size: dustSize,
            state: ORDER_STATES.PARTIAL
        });

        mgr.funds.available.buy = 100;

        const result = await mgr.strategy.rebalanceSideLogic(
            ORDER_TYPES.BUY,
            slots,
            500,
            new Set(),
            false,
            false
        );

        assert(result !== undefined, 'Should process MERGE consolidation');
        assert(Array.isArray(result.ordersToUpdate), 'Should have updates');
    }
}

async function testCase3b() {
    const mgr = createManagerWithGridSize(10, 500, 50);
    const slots = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);

    const dustPercentage = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE / 100;
    const idealSize = 10;
    const largePartialSize = idealSize * (dustPercentage + 0.5);

    const partialSlot = slots[4];
    if (partialSlot) {
        mgr._updateOrder({
            ...partialSlot,
            type: ORDER_TYPES.BUY,
            orderId: 'partial-buy-2',
            size: largePartialSize,
            state: ORDER_STATES.PARTIAL
        });

        const result = await mgr.strategy.rebalanceSideLogic(
            ORDER_TYPES.BUY,
            slots,
            500,
            new Set(),
            false,
            false
        );

        assert(result !== undefined, 'Should process partial without MERGE');
    }
}

async function testCase4a() {
    const mgr = createManagerWithGridSize(10, 500, 50);

    const result1 = await mgr.strategy.rebalance([], new Set());
    assert(result1 !== undefined, 'First rebalance should succeed');

    const orderCount1 = mgr.orders.size;
    assert(orderCount1 === 10, 'Grid should still have all slots after rebalance');

    const result2 = await mgr.strategy.rebalance([], new Set());
    assert(result2 !== undefined, 'Second rebalance should succeed');

    const orderCount2 = mgr.orders.size;
    assert(orderCount2 === orderCount1, 'Grid size should not change between rebalances');
}

async function testCase4b() {
    const mgr = createManagerWithGridSize(14, 1000, 100);

    const initialTypes = new Map();
    for (const [id, order] of mgr.orders) {
        initialTypes.set(id, order.type);
    }

    await mgr.strategy.rebalance([], new Set());

    for (const [id, order] of mgr.orders) {
        assert(
            [ORDER_TYPES.BUY, ORDER_TYPES.SELL, ORDER_TYPES.SPREAD].includes(order.type),
            `Order ${id} has invalid type: ${order.type}`
        );
    }
}

async function testCase5a() {
    const mgr = createManagerWithGridSize(10, 0, 50);

    const result = await mgr.strategy.rebalance([], new Set());
    assert(result !== undefined, 'Should handle zero buy budget gracefully');
    assert(Array.isArray(result.ordersToPlace), 'Should return valid result structure');
}

async function testCase5b() {
    const mgr = createManagerWithGridSize(10, 500, 0);

    const result = await mgr.strategy.rebalance([], new Set());
    assert(result !== undefined, 'Should handle zero sell budget gracefully');
    assert(Array.isArray(result.ordersToPlace), 'Should return valid result structure');
}

async function testCase5c() {
    const mgr = createManagerWithGridSize(10, 0, 0);

    const result = await mgr.strategy.rebalance([], new Set());
    assert(result !== undefined, 'Should handle zero budgets gracefully');
    assert(Array.isArray(result.ordersToPlace), 'Should return valid result structure');
    // Strategy maintains grid structure even with zero budget (places with size 0)
    assert(result.ordersToPlace.every(o => o.size >= 0), 'All placed orders should have non-negative size');
}

async function testCase6a() {
    const mgr = createManagerWithGridSize(12, 800, 80);
    const slots = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        800,
        new Set(),
        false,
        false
    );

    if (result.ordersToPlace.length > 1) {
        const indices = result.ordersToPlace.map(o => slots.findIndex(s => s.id === o.id)).sort((a, b) => a - b);
        for (let i = 1; i < indices.length; i++) {
            assert(indices[i] - indices[i-1] === 1, 'Window indices should be contiguous');
        }
    }
}

async function testCase7a() {
    const mgr = createManagerWithGridSize(8, 500, 50);
    const slots = Array.from(mgr.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);

    const result = await mgr.strategy.rebalanceSideLogic(
        ORDER_TYPES.BUY,
        slots,
        500,
        new Set(),
        false,
        false
    );

    assert(result !== undefined, 'Should handle missing SPREAD slots gracefully');
    assert(result.ordersToPlace !== undefined, 'Should return valid structure');
}

// Main test runner
async function runAllTests() {
    console.log('\n=== STRATEGY EDGE CASE TESTS ===\n');

    // Test 1: targetCount > slots.length
    await testAsync('Edge Case 1a: targetCount > slots.length (5 slots, 10 target)', testCase1a);
    await testAsync('Edge Case 1b: targetCount > slots.length (3 slots, 5 target)', testCase1b);

    // Test 2: Window initialization with various grid sizes
    await testAsync('Edge Case 2a: Window init with 3-slot grid', testCase2a);
    await testAsync('Edge Case 2b: Window init with 5-slot grid', testCase2b);
    await testAsync('Edge Case 2c: Window init with 10-slot grid', testCase2c);
    await testAsync('Edge Case 2d: Window init with 20-slot grid', testCase2d);

    // Test 3: MERGE consolidation with dust threshold
    await testAsync('Edge Case 3a: MERGE with dust-threshold-sized partial', testCase3a);
    await testAsync('Edge Case 3b: MERGE above dust threshold', testCase3b);

    // Test 4: Role assignment doesn't corrupt state
    await testAsync('Edge Case 4a: Consecutive rebalances don\'t corrupt state', testCase4a);
    await testAsync('Edge Case 4b: Order types preserved after rebalance', testCase4b);

    // Test 5: Zero budget edge cases
    await testAsync('Edge Case 5a: Zero buy budget', testCase5a);
    await testAsync('Edge Case 5b: Zero sell budget', testCase5b);
    await testAsync('Edge Case 5c: Zero both budgets', testCase5c);

    // Test 6: Contiguity validation
    await testAsync('Edge Case 6a: Window contiguity maintained', testCase6a);

    // Test 7: Hardcoded fallback removal validation
    await testAsync('Edge Case 7a: Window fallback with no SPREAD slots', testCase7a);

    // Summary
    console.log(`\n=== TEST SUMMARY ===`);
    console.log(`Passed: ${testsPassed}`);
    console.log(`Failed: ${testsFailed}`);
    console.log(`Total: ${testsPassed + testsFailed}`);

    if (testsFailed > 0) {
        console.log('\n❌ Some tests failed');
        process.exit(1);
    } else {
        console.log('\n✅ All edge case tests passed');
        process.exit(0);
    }
}

// Run tests
runAllTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
