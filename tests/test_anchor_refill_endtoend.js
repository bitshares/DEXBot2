const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { AccountOrders } = require('../modules/account_orders');
const { calculateGridSideDivergenceMetric, countOrdersByType } = require('../modules/order/utils');

console.log('='.repeat(70));
console.log('End-to-End Anchor & Refill Strategy Test');
console.log('='.repeat(70));

const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

// Comprehensive scenario: Grid with mixed order states, including dust-refilled orders
async function testEndToEndScenario() {
    console.log('\n[Scenario] Mixed Grid with Dust-Refilled Orders');
    console.log('-'.repeat(70));

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
    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Create a realistic grid with some orders having dust refill markers
    const gridOrders = [
        // BUY side
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: 'chain-buy-0', price: 0.99, size: 100.0 },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, orderId: 'chain-buy-1', price: 0.98, size: 97.0, isDoubleOrder: true, mergedDustSize: 3.0 },
        { id: 'buy-2', type: ORDER_STATES.VIRTUAL, state: ORDER_STATES.VIRTUAL, price: 0.97, size: 90.0 },
        { id: 'buy-spread', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 0.995, size: 0 },

        // SELL side
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, orderId: 'chain-sell-0', price: 1.01, size: 100.0 },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, orderId: 'chain-sell-1', price: 1.02, size: 85.0, isDoubleOrder: true, mergedDustSize: 2.0, pendingRotation: false },
        { id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.03, size: 90.0 },
        { id: 'sell-spread', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 1.005, size: 0 }
    ];

    gridOrders.forEach(o => {
        mgr.orders.set(o.id, o);
        if (!mgr._ordersByType[o.type]) mgr._ordersByType[o.type] = new Set();
        if (!mgr._ordersByState[o.state]) mgr._ordersByState[o.state] = new Set();
        mgr._ordersByType[o.type].add(o.id);
        mgr._ordersByState[o.state].add(o.id);
    });

    console.log('Created grid with:');
    console.log('  - 2 active orders (1 BUY, 1 SELL)');
    console.log('  - 2 dust-refilled partial orders (marked with isDoubleOrder & mergedDustSize)');
    console.log('  - 2 virtual orders');
    console.log('  - 2 SPREAD placeholders');

    // Test 1: Verify order counting is pending-aware
    console.log('\n[Step 1] Verify Pending-Aware Order Counting');
    const buyCount = countOrdersByType(ORDER_TYPES.BUY, mgr.orders);
    const sellCount = countOrdersByType(ORDER_TYPES.SELL, mgr.orders);

    console.log(`  Buy count: ${buyCount} (1 active + 1 partial = 2)`);
    console.log(`  Sell count: ${sellCount} (1 active + 1 partial = 2)`);

    assert(buyCount === 2, `Expected BUY count=2, got ${buyCount}`);
    assert(sellCount === 2, `Expected SELL count=2, got ${sellCount}`);
    console.log('  ✓ Counting verified');

    // Test 2: Persist grid and reload
    console.log('\n[Step 2] Persist and Reload Grid');
    const tmpPath = path.join(tmpDir, 'anchor_e2e.json');
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

    const accountOrders = new AccountOrders({ profilesPath: tmpPath });
    const botKey = 'e2e-test-bot';

    await accountOrders.storeMasterGrid(botKey, Array.from(mgr.orders.values()));
    console.log('  ✓ Grid persisted');

    // Load and verify
    const reloadedGrid = accountOrders.loadBotGrid(botKey);
    assert(Array.isArray(reloadedGrid), 'Grid should be loaded as array');
    assert(reloadedGrid.length === gridOrders.length, `Expected ${gridOrders.length} orders, got ${reloadedGrid.length}`);

    const reloadedDust = reloadedGrid.find(o => o.id === 'buy-1');
    assert(reloadedDust.isDoubleOrder === true, 'isDoubleOrder not reloaded');
    assert(reloadedDust.mergedDustSize === 3.0, 'mergedDustSize not reloaded');
    console.log('  ✓ Grid reloaded with strategy fields intact');

    // Test 3: Verify divergence is double-aware
    console.log('\n[Step 3] Verify Double-Aware Divergence Metric');

    // Create calculated orders as they would be after grid sizing
    const calculatedOrders = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 100.0 },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, size: 100.0 },
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 100.0 },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, size: 87.0 }
    ];

    const persistedOrders = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 100.0 },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, size: 97.0, isDoubleOrder: true, mergedDustSize: 3.0 },
        { id: 'sell-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 100.0 },
        { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, size: 85.0, isDoubleOrder: true, mergedDustSize: 2.0 }
    ];

    // BUY side divergence
    const buyCalc = calculatedOrders.filter(o => o.type === ORDER_TYPES.BUY);
    const buyPers = persistedOrders.filter(o => o.type === ORDER_TYPES.BUY);
    const buyDivergence = calculateGridSideDivergenceMetric(buyCalc, buyPers, 'buy');

    console.log(`  Buy side divergence: ${buyDivergence.toFixed(6)}`);
    assert(buyDivergence === 0, `Expected perfect match with double-aware, got ${buyDivergence}`);
    console.log('  ✓ Buy side: Perfect match with double-aware divergence');

    // SELL side divergence
    const sellCalc = calculatedOrders.filter(o => o.type === ORDER_TYPES.SELL);
    const sellPers = persistedOrders.filter(o => o.type === ORDER_TYPES.SELL);
    const sellDivergence = calculateGridSideDivergenceMetric(sellCalc, sellPers, 'sell');

    console.log(`  Sell side divergence: ${sellDivergence.toFixed(6)}`);
    assert(sellDivergence === 0, `Expected perfect match with double-aware, got ${sellDivergence}`);
    console.log('  ✓ Sell side: Perfect match with double-aware divergence');

    // Test without double-aware to show the difference
    const sellPersNoDouble = sellPers.map(o => {
        const copy = { ...o };
        delete copy.isDoubleOrder;
        delete copy.mergedDustSize;
        return copy;
    });

    const sellDivergenceWithoutDouble = calculateGridSideDivergenceMetric(sellCalc, sellPersNoDouble, 'sell');
    console.log(`  Sell side divergence (without double-aware): ${sellDivergenceWithoutDouble.toFixed(6)}`);
    assert(sellDivergenceWithoutDouble > 0, 'Should show divergence without double-aware logic');
    console.log('  ✓ Comparison: Without double-aware logic would show divergence');

    console.log('\n' + '='.repeat(70));
    console.log('End-to-End Test Complete: All Scenarios Verified');
    console.log('='.repeat(70));
    console.log('\nSummary:');
    console.log('  ✓ Dust-refilled orders correctly persist new fields');
    console.log('  ✓ Pending-aware counting works in grid context');
    console.log('  ✓ Double-aware divergence prevents false grid resets');
    console.log('  ✓ Strategy enables efficient handling of partial fills');
}

// Run the scenario
(async () => {
    try {
        await testEndToEndScenario();
        process.exit(0);
    } catch (err) {
        console.error('\n❌ End-to-End test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
