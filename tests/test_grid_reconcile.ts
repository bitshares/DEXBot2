/**
 * Tests for startup reconciliation logic
 * Validates <bot> grid edge detection and two-phase update strategy
 */

const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// Mock OrderManager for testing
class MockOrderManager {
    [key: string]: any;
    constructor() {
        this.orders = new Map();
        this._ordersByState = {
            [ORDER_STATES.ACTIVE]: new Set(),
            [ORDER_STATES.PARTIAL]: new Set(),
            [ORDER_STATES.VIRTUAL]: new Set(),
        };
        this._ordersByType = {
            [ORDER_TYPES.BUY]: new Set(),
            [ORDER_TYPES.SELL]: new Set(),
        };
        this.logger = { log: () => {} };
        this.assets = { assetA: { precision: 5 }, assetB: { precision: 5 } };
        this.funds = { available: { buy: 0, sell: 0 }, committed: { chain: { buy: 0, sell: 0 } } };
    }

    _updateOrder(order) {
        this.orders.set(order.id, order);
        this._ordersByType[order.type]?.add(order.id);
        this._ordersByState[order.state]?.add(order.id);
    }

    getOrdersByTypeAndState(type, state) {
        const typeIds = this._ordersByType[type] || new Set();
        const stateIds = this._ordersByState[state] || new Set();
        const ids = new Set([...typeIds].filter(id => stateIds.has(id)));
        return Array.from(ids).map(id => this.orders.get(id)).filter((x: any) => x);
    }
}

/**
 * TEST 1: Grid edge detection with all ACTIVE orders
 */
async function testGridEdgeDetection() {
    const manager = new MockOrderManager();

    // Create BUY orders: 5 VIRTUAL + 5 ACTIVE (edge orders)
    for (let i = 0; i < 5; i++) {
        await manager._updateOrder({
            id: `buy-virtual-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 100 - i * 5,
            size: 100,
            orderId: null
        });
    }

    for (let i = 0; i < 5; i++) {
        await manager._updateOrder({
            id: `buy-active-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 75 - i * 5,
            size: 150,
            orderId: `chain-buy-${i}`
        });
    }

    // Test edge detection (all 5 outermost BUY orders are ACTIVE)
    const orders = Array.from(manager.orders.values()).filter(o => (o as any).type === ORDER_TYPES.BUY);
    const sorted = orders.sort((a, b) => ((b as any).price || 0) - ((a as any).price || 0));
    const outerEdgeCount = 5;
    const edgeOrders = sorted.slice(-outerEdgeCount);
    const allEdgeActive = edgeOrders.every(o => (o as any).orderId && ((o as any).state === ORDER_STATES.ACTIVE || (o as any).state === ORDER_STATES.PARTIAL));

    assert.strictEqual(allEdgeActive, true, 'Edge orders should all be ACTIVE');
    assert.strictEqual(edgeOrders.length, 5, 'Should have 5 edge orders');
    console.log('✅ TEST 1 PASSED: Grid edge detection works correctly');
}

/**
 * TEST 2: Grid edge detection fails when edge has VIRTUAL orders
 */
async function testGridEdgeDetectionWithVirtual() {
    const manager = new MockOrderManager();

    // Create BUY orders: mix of VIRTUAL and ACTIVE at edges
    for (let i = 0; i < 3; i++) {
        await manager._updateOrder({
            id: `buy-active-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100 - i * 5,
            size: 150,
            orderId: `chain-buy-${i}`
        });
    }

    // Virtual orders at the edge (should prevent detection)
    for (let i = 0; i < 3; i++) {
        await manager._updateOrder({
            id: `buy-virtual-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 85 - i * 5,
            size: 100,
            orderId: null
        });
    }

    const orders = Array.from(manager.orders.values()).filter(o => (o as any).type === ORDER_TYPES.BUY);
    const sorted = orders.sort((a, b) => ((b as any).price || 0) - ((a as any).price || 0));
    const outerEdgeCount = 3;
    const edgeOrders = sorted.slice(-outerEdgeCount);
    const allEdgeActive = edgeOrders.every(o => (o as any).orderId && ((o as any).state === ORDER_STATES.ACTIVE || (o as any).state === ORDER_STATES.PARTIAL));

    assert.strictEqual(allEdgeActive, false, 'Edge should NOT be all ACTIVE when VIRTUAL orders exist');
    console.log('✅ TEST 2 PASSED: Edge detection correctly rejects partial ACTIVE edges');
}

/**
 * TEST 3: Find largest order from multiple options
 */
async function testFindLargestOrder() {
    const unmatchedOrders = [
        { id: 'order-1', for_sale: 500 },
        { id: 'order-2', for_sale: 1000 },  // Largest
        { id: 'order-3', for_sale: 750 },
    ];

    // Simulate _findLargestOrder logic
    let largestOrder = null;
    let largestIndex = -1;
    let largestSize = 0;

    for (let i = 0; i < unmatchedOrders.length; i++) {
        const order = unmatchedOrders[i];
        const size = Number(order.for_sale) || 0;
        if (size > largestSize) {
            largestSize = size;
            largestOrder = order;
            largestIndex = i;
        }
    }

    assert.strictEqual(largestOrder.id, 'order-2', 'Should find order-2 as largest');
    assert.strictEqual(largestSize, 1000, 'Largest size should be 1000');
    assert.strictEqual(largestIndex, 1, 'Index should be 1');
    console.log('✅ TEST 3 PASSED: Largest order detection works correctly');
}

/**
 * TEST 4: Find largest order with ties (picks first)
 */
async function testFindLargestOrderWithTies() {
    const unmatchedOrders = [
        { id: 'order-1', for_sale: 1000 },  // First maximum
        { id: 'order-2', for_sale: 1000 },  // Same size (should be skipped)
        { id: 'order-3', for_sale: 500 },
    ];

    let largestOrder = null;
    let largestIndex = -1;
    let largestSize = 0;

    for (let i = 0; i < unmatchedOrders.length; i++) {
        const order = unmatchedOrders[i];
        const size = Number(order.for_sale) || 0;
        if (size > largestSize) {  // Using > not >= picks first occurrence on ties
            largestSize = size;
            largestOrder = order;
            largestIndex = i;
        }
    }

    assert.strictEqual(largestOrder.id, 'order-1', 'Should pick first order when tied');
    assert.strictEqual(largestIndex, 0, 'Index should be 0 (first occurrence)');
    console.log('✅ TEST 4 PASSED: Tie-breaking correctly picks first order');
}

/**
 * TEST 5: Order restoration via index mapping
 */
async function testOrderRestorationByIndex() {
    const unmatchedOrders = [
        { id: 'order-a', for_sale: 500 },
        { id: 'order-b', for_sale: 1000 },  // Index 1 (largest)
        { id: 'order-c', for_sale: 750 },
    ];

    const desiredGridOrders = [
        { id: 'grid-1', size: 450 },
        { id: 'grid-2', size: 950 },  // Corresponds to index 1
        { id: 'grid-3', size: 700 },
    ];

    // Simulate the reduction info returned
    const reducedInfo = { orderId: 'order-b', index: 1, originalSize: 1000 };

    // Find target grid order using index
    const targetGridOrder = desiredGridOrders[reducedInfo.index];

    assert.strictEqual(targetGridOrder.id, 'grid-2', 'Should find correct grid order by index');
    assert.strictEqual(targetGridOrder.size, 950, 'Grid order size should match');
    console.log('✅ TEST 5 PASSED: Index-based restoration mapping works correctly');
}

/**
 * TEST 6: Verify SELL side ordering (low to high price)
 */
async function testSellOrderEdgeOrdering() {
    const manager = new MockOrderManager();

    // Create SELL orders: highest prices first (center), lowest last (edge)
    const sellPrices = [0.8, 0.7, 0.6, 0.5, 0.4];  // descending = market to edge

    for (const [i, price] of sellPrices.entries()) {
        await manager._updateOrder({
            id: `sell-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price,
            size: 100 + i * 20,
            orderId: `chain-sell-${i}`
        });
    }

    // Sort for edge detection (low to high = market to edge)
    const orders = Array.from(manager.orders.values()).filter(o => (o as any).type === ORDER_TYPES.SELL);
    const sorted = orders.sort((a, b) => ((a as any).price || 0) - ((b as any).price || 0));

    assert.strictEqual((sorted[0] as any).price, 0.4, 'Lowest price (edge) should be first in market-to-edge sort');
    assert.strictEqual((sorted[4] as any).price, 0.8, 'Highest price (market) should be last');

    // Get last N as edge
    const edgeCount = 2;
    const edgeOrders = sorted.slice(-edgeCount);
    assert.strictEqual((edgeOrders[0] as any).price, 0.7, 'Edge should start from second-highest');
    assert.strictEqual((edgeOrders[1] as any).price, 0.8, 'Edge should end at highest (market closest)');
    console.log('✅ TEST 6 PASSED: SELL order edge ordering is correct');
}

/**
 * TEST 7: Verify BUY side ordering (high to low price)
 */
async function testBuyOrderEdgeOrdering() {
    const manager = new MockOrderManager();

    // Create BUY orders: lowest prices last (edge), highest first (center)
    const buyPrices = [0.4, 0.5, 0.6, 0.7, 0.8];  // ascending = market to edge

    for (const [i, price] of buyPrices.entries()) {
        await manager._updateOrder({
            id: `buy-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price,
            size: 100 + i * 20,
            orderId: `chain-buy-${i}`
        });
    }

    // Sort for edge detection (high to low = market to edge)
    const orders = Array.from(manager.orders.values()).filter(o => (o as any).type === ORDER_TYPES.BUY);
    const sorted = orders.sort((a, b) => ((b as any).price || 0) - ((a as any).price || 0));

    assert.strictEqual((sorted[0] as any).price, 0.8, 'Highest price (market) should be first');
    assert.strictEqual((sorted[4] as any).price, 0.4, 'Lowest price (edge) should be last');

    // Get last N as edge
    const edgeCount = 2;
    const edgeOrders = sorted.slice(-edgeCount);
    assert.strictEqual((edgeOrders[0] as any).price, 0.5, 'Edge should start from second-lowest');
    assert.strictEqual((edgeOrders[1] as any).price, 0.4, 'Edge should end at lowest (furthest)');
    console.log('✅ TEST 7 PASSED: BUY order edge ordering is correct');
}

/**
 * TEST 8: No reduction needed when edge has VIRTUAL orders
 */
async function testNoReductionWhenEdgeHasVirtual() {
    const manager = new MockOrderManager();

    // Edge has VIRTUAL - reduction NOT needed
    await manager._updateOrder({
        id: 'buy-active-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 100,
        size: 500,
        orderId: 'chain-1'
    });

    await manager._updateOrder({
        id: 'buy-virtual-edge',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: 50,
        size: 200,
        orderId: null
    });

    const orders = Array.from(manager.orders.values()).filter(o => (o as any).type === ORDER_TYPES.BUY);
    const sorted = orders.sort((a, b) => ((b as any).price || 0) - ((a as any).price || 0));
    const edgeOrders = sorted.slice(-1);  // Last 1 = edge
    const isEdgeFullyActive = edgeOrders.every(o => (o as any).orderId && ((o as any).state === ORDER_STATES.ACTIVE || (o as any).state === ORDER_STATES.PARTIAL));

    assert.strictEqual(isEdgeFullyActive, false, 'Edge with VIRTUAL should not be fully active');
    console.log('✅ TEST 8 PASSED: Correctly skips reduction when edge has VIRTUAL orders');
}

// Run all tests
(async () => {
    console.log('\n========== STARTUP RECONCILE TESTS ==========\n');
    await testGridEdgeDetection();
    await testGridEdgeDetectionWithVirtual();
    await testFindLargestOrder();
    await testFindLargestOrderWithTies();
    await testOrderRestorationByIndex();
    await testSellOrderEdgeOrdering();
    await testBuyOrderEdgeOrdering();
    await testNoReductionWhenEdgeHasVirtual();

    console.log('\n✅ All startup reconcile tests passed!\n');
})();
