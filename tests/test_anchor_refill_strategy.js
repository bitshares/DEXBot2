const assert = require('assert');
const { activateClosestVirtualOrdersForPlacement, prepareFurthestOrdersForRotation, rebalanceSideAfterFill, evaluatePartialOrderAnchor } = require('../modules/order/legacy-testing');
const fs = require('fs');
const path = require('path');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { AccountOrders } = require('../modules/account_orders');

console.log('='.repeat(70));
console.log('Testing Anchor, Refill & Residual Strategy Implementation');
console.log('='.repeat(70));

const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

// Test 1: _evaluatePartialOrderAnchor - Dust Classification
function testDustClassification() {
    console.log('\n[Test 1] Dust Classification (< 5% threshold)');

    const cfg = { assetA: 'BTS', assetB: 'USD', startPrice: 1.0, botFunds: { buy: 1000, sell: 1000 } };
    const mgr = new OrderManager(cfg);

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Create a target grid order with ideal size
    const idealSize = 100;
    const targetGridOrder = {
        id: 'buy-5',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: 0.95,
        size: idealSize
    };

    // Create moveInfo that would be returned from preparePartialOrderMove
    const moveInfo = {
        targetGridOrder,
        newGridId: 'buy-5',
        newPrice: 0.95
    };

    // Test dust case: 1% of ideal (well below 5% or 10% thresholds)
    const dustPartial = {
        id: 'buy-3',
        orderId: 'chain-order-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        price: 0.93,
        size: 1.0  // 1% of 100
    };

    const decision = evaluatePartialOrderAnchor(mgr, dustPartial, moveInfo);

    assert(decision.isDust === true, `Expected isDust=true for 1% partial, got ${decision.isDust}`);
    assert(Math.abs(decision.percentOfIdeal - 0.01) < 0.001, `Expected percentOfIdeal=0.01, got ${decision.percentOfIdeal}`);
    assert(decision.mergedDustSize === 1.0, `Expected mergedDustSize=1.0, got ${decision.mergedDustSize}`);

    console.log(`✓ Dust classification correct: 1% < threshold`);
    console.log(`  - isDust: ${decision.isDust}`);
    console.log(`  - percentOfIdeal: ${(decision.percentOfIdeal * 100).toFixed(1)}%`);
    console.log(`  - mergedDustSize: ${decision.mergedDustSize}`);
}

// Test 2: _evaluatePartialOrderAnchor - Substantial Classification
function testSubstantialClassification() {
    console.log('\n[Test 2] Substantial Classification (≥ threshold)');

    const cfg = { assetA: 'BTS', assetB: 'USD', startPrice: 1.0, botFunds: { buy: 1000, sell: 1000 } };
    const mgr = new OrderManager(cfg);

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    const idealSize = 100;
    const targetGridOrder = {
        id: 'sell-5',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        price: 1.05,
        size: idealSize
    };

    const moveInfo = {
        targetGridOrder,
        newGridId: 'sell-5',
        newPrice: 1.05
    };

    // Test substantial case: 25% of ideal (well above 5% or 10% thresholds)
    const substantialPartial = {
        id: 'sell-3',
        orderId: 'chain-order-2',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 1.03,
        size: 25.0  // 25% of 100
    };

    const decision = evaluatePartialOrderAnchor(mgr, substantialPartial, moveInfo);

    assert(decision.isDust === false, `Expected isDust=false for 25% partial, got ${decision.isDust}`);
    assert(Math.abs(decision.percentOfIdeal - 0.25) < 0.001, `Expected percentOfIdeal=0.25, got ${decision.percentOfIdeal}`);
    assert(decision.newSize === idealSize, `Expected newSize=${idealSize}, got ${decision.newSize}`);

    // For SELL: residualCapital = (25 - 100) * newPrice (but clamped to 0)
    // Since 25 < 100, residualCapital should be 0
    assert(decision.residualCapital === 0, `Expected residualCapital=0 for smaller partial, got ${decision.residualCapital}`);

    console.log(`✓ Substantial classification correct: 25% ≥ threshold`);
    console.log(`  - isDust: ${decision.isDust}`);
    console.log(`  - percentOfIdeal: ${(decision.percentOfIdeal * 100).toFixed(1)}%`);
    console.log(`  - newSize: ${decision.newSize}`);
    console.log(`  - residualCapital: ${decision.residualCapital}`);

    // Test with partial larger than ideal (should have residual capital)
    const oversizePartial = {
        id: 'sell-3',
        orderId: 'chain-order-3',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 1.03,
        size: 150.0  // 150% of ideal
    };

    const decision2 = evaluatePartialOrderAnchor(mgr, oversizePartial, moveInfo);

    assert(decision2.isDust === false, `Expected isDust=false for 150% partial`);
    const expectedResidual = (150 - 100) * 1.05; // 50 * 1.05 = 52.5 (base asset * new price)
    assert(Math.abs(decision2.residualCapital - expectedResidual) < 0.01,
        `Expected residualCapital~${expectedResidual}, got ${decision2.residualCapital}`);

    console.log(`\n✓ Substantial with residual capital: 150% of ideal`);
    console.log(`  - expectedResidualCapital: ${expectedResidual.toFixed(8)}`);
    console.log(`  - actualResidualCapital: ${decision2.residualCapital.toFixed(8)}`);
}

// Test 3: Persistence of new fields
function testPersistenceOfStrategyFields() {
    console.log('\n[Test 3] Persistence of Anchor & Refill Fields');

    const tmpPath = path.join(tmpDir, 'anchor_refill_persist.json');
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

    const cfg = { assetA: 'BTS', assetB: 'USD', startPrice: 1.0, botFunds: { buy: 1000, sell: 1000 } };
    const mgr = new OrderManager(cfg);

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Create orders with new strategy fields
    const dustRefillOrder = {
        id: 'buy-5',
        orderId: 'chain-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        price: 0.95,
        size: 50.0,
        isDoubleOrder: true,
        mergedDustSize: 2.5
    };

    const pendingRotationOrder = {
        id: 'sell-3',
        orderId: 'chain-2',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 1.05,
        size: 30.0,
        pendingRotation: true
    };

    mgr.orders.set(dustRefillOrder.id, dustRefillOrder);
    mgr.orders.set(pendingRotationOrder.id, pendingRotationOrder);

    // Persist using AccountOrders
    const accountOrders = new AccountOrders({ profilesPath: tmpPath });
    const botKey = 'test-anchor-bot';

    (async () => {
        try {
            await accountOrders.storeMasterGrid(botKey, Array.from(mgr.orders.values()));

            // Verify file contains new fields
            const raw = fs.readFileSync(tmpPath, 'utf8');
            const parsed = JSON.parse(raw);

            assert(parsed.bots && parsed.bots[botKey], 'Bot entry should exist');
            const persistedOrders = parsed.bots[botKey].grid;

            const persistedDust = persistedOrders.find(o => o.id === dustRefillOrder.id);
            assert(persistedDust.isDoubleOrder === true, 'isDoubleOrder field not persisted');
            assert(persistedDust.mergedDustSize === 2.5, 'mergedDustSize field not persisted');

            const persistedPending = persistedOrders.find(o => o.id === pendingRotationOrder.id);
            assert(persistedPending.pendingRotation === true, 'pendingRotation field not persisted');

            console.log('✓ All new strategy fields persisted correctly');
            console.log(`  - isDoubleOrder: ${persistedDust.isDoubleOrder}`);
            console.log(`  - mergedDustSize: ${persistedDust.mergedDustSize}`);
            console.log(`  - pendingRotation: ${persistedPending.pendingRotation}`);

            testPendingAwareCountOrdersByType();
        } catch (err) {
            console.error('Persistence test failed:', err.message);
            process.exit(1);
        }
    })();
}

// Test 4: Pending-Aware countOrdersByType
function testPendingAwareCountOrdersByType() {
    console.log('\n[Test 4] Pending-Aware countOrdersByType');

    const { countOrdersByType } = require('../modules/order/utils');

    const cfg = { assetA: 'BTS', assetB: 'USD', startPrice: 1.0, botFunds: { buy: 1000, sell: 1000 } };
    const mgr = new OrderManager(cfg);

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Create orders: 2 active BUYs, 1 SELL with pendingRotation, 2 virtual BUYs
    const activeBuy1 = { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE };
    const activeBuy2 = { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE };
    const virtualBuy1 = { id: 'buy-3', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL };
    const virtualBuy2 = { id: 'buy-4', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL };
    const sellWithPending = {
        id: 'sell-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        pendingRotation: true
    };

    const orders = new Map();
    orders.set(activeBuy1.id, activeBuy1);
    orders.set(activeBuy2.id, activeBuy2);
    orders.set(virtualBuy1.id, virtualBuy1);
    orders.set(virtualBuy2.id, virtualBuy2);
    orders.set(sellWithPending.id, sellWithPending);

    // Count BUY orders when SELL has pendingRotation
    // Should count: 2 active + 2 virtual (pending-aware) = 4
    const buyCount = countOrdersByType(ORDER_TYPES.BUY, orders);

    assert(buyCount === 4, `Expected BUY count=4 (2 active + 2 virtual as pending-aware), got ${buyCount}`);

    console.log('✓ Pending-Aware counting works correctly');
    console.log(`  - 2 active BUY orders counted`);
    console.log(`  - 2 virtual BUY orders counted as pending-aware (SELL has pendingRotation)`);
    console.log(`  - Total: ${buyCount}`);

    // Test without pendingRotation
    const orders2 = new Map();
    orders2.set(activeBuy1.id, activeBuy1);
    orders2.set(activeBuy2.id, activeBuy2);
    orders2.set(virtualBuy1.id, virtualBuy1);
    orders2.set(virtualBuy2.id, virtualBuy2);

    const sellNormal = { id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE };
    orders2.set(sellNormal.id, sellNormal);

    const buyCount2 = countOrdersByType(ORDER_TYPES.BUY, orders2);

    assert(buyCount2 === 2, `Expected BUY count=2 (no pending-aware), got ${buyCount2}`);

    console.log('\n✓ Without pendingRotation, only active orders counted');
    console.log(`  - 2 active BUY orders counted`);
    console.log(`  - Virtual orders NOT counted (no pending rotation)`);
    console.log(`  - Total: ${buyCount2}`);

    testDoubleAwareDivergence();
}

// Test 5: Double-Aware Divergence Metric
function testDoubleAwareDivergence() {
    console.log('\n[Test 5] Double-Aware Divergence Metric');

    const { calculateGridSideDivergenceMetric } = require('../modules/order/utils');

    // Calculated orders: ideal sizes
    const calculatedOrders = [
        { id: 'buy-1', size: 100.0 },
        { id: 'buy-2', size: 90.0 }
    ];

    // Persisted orders: one is a double order with merged dust
    const persistedOrders = [
        { id: 'buy-1', size: 100.0, isDoubleOrder: false },
        { id: 'buy-2', size: 85.0, isDoubleOrder: true, mergedDustSize: 5.0 }  // Total expected: 90.0
    ];

    const metric = calculateGridSideDivergenceMetric(calculatedOrders, persistedOrders, 'buy');

    // With double-aware logic:
    // buy-1: (100 - 100) / 100 = 0 (perfect match)
    // buy-2: (90 - (85 + 5)) / 90 = (90 - 90) / 90 = 0 (perfect match with merged dust)
    // RMS = sqrt((0 + 0) / 2) = 0

    assert(metric === 0, `Expected metric=0 for perfect match with double-aware, got ${metric}`);

    console.log('✓ Double-Aware divergence metric works correctly');
    console.log(`  - buy-1: 100 vs 100 = match`);
    console.log(`  - buy-2: 90 vs (85 + 5 merged dust) = 90 vs 90 = match`);
    console.log(`  - RMS metric: ${metric} (0 = perfect match)`);

    // Test case without double-aware (should show divergence)
    const persistedOrders2 = [
        { id: 'buy-1', size: 100.0, isDoubleOrder: false },
        { id: 'buy-2', size: 85.0, isDoubleOrder: false }  // No double-aware adjustment
    ];

    const metric2 = calculateGridSideDivergenceMetric(calculatedOrders, persistedOrders2, 'buy');

    // Without double-aware:
    // buy-2: (90 - 85) / 85 = 0.0588... (5.88% divergence)
    const expectedDivergence = 5.0 / 85.0;

    assert(metric2 > 0, `Expected metric > 0 without double-aware, got ${metric2}`);
    console.log(`\n✓ Without double-aware adjustment: metric=${metric2.toFixed(6)} (shows divergence)`);
    console.log(`  - buy-2: 90 vs 85 (no dust adjustment) = ${(expectedDivergence * 100).toFixed(2)}% divergence`);

    console.log('\n' + '='.repeat(70));
    console.log('All Anchor & Refill Strategy Tests Passed!');
    console.log('='.repeat(70));
}

// Run all tests
try {
    testDustClassification();
    testSubstantialClassification();
    testPersistenceOfStrategyFields();
} catch (err) {
    console.error('\n❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
}
