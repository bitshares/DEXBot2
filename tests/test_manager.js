const assert = require('assert');
console.log('Running manager tests');

const { OrderManager, grid: Grid } = require('../modules/order/index.js');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants.js');

// Initialize manager in a deterministic way (no chain lookups)
const cfg = {
    assetA: 'BASE',
    assetB: 'QUOTE',
    startPrice: 100,
    minPrice: 50,
    maxPrice: 200,
    incrementPercent: 10,
    targetSpreadPercent: 20,
    botFunds: { buy: 1000, sell: 10 },
    activeOrders: { buy: 1, sell: 1 },
};

const mgr = new OrderManager(cfg);

// Funds before setting account totals
assert(mgr.funds && typeof mgr.funds.available.buy === 'number', 'manager should have funds object');

mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });

// Ensure funds reflect the simple config values
assert.strictEqual(mgr.funds.available.buy, 1000);
assert.strictEqual(mgr.funds.available.sell, 10);

(async () => {
    // Provide mock asset metadata to avoid on-chain lookups in unit tests
    mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    await Grid.initializeGrid(mgr);
    // after initialize there should be orders
    assert(mgr.orders.size > 0, 'initializeGrid should create orders');

    // funds should have committed some sizes for either side (using new nested structure)
    const committedBuy = mgr.funds.committed.grid.buy;
    const committedSell = mgr.funds.committed.grid.sell;
    assert(typeof committedBuy === 'number');
    assert(typeof committedSell === 'number');

    // Check fetchOrderUpdates flows
    const updates = await mgr.fetchOrderUpdates({ calculate: true });
    assert(updates && typeof updates === 'object', 'fetchOrderUpdates should return object');
    assert(Array.isArray(updates.remaining), 'remaining should be array');
    assert(Array.isArray(updates.filled), 'filled should be array');

    console.log('manager tests passed');

    // --- New tests for SPREAD selection behavior ---
    // In the new StrategyEngine, spread activation happens during rebalance() 
    // when shortages are detected in the active window.
    
    // Clear any existing orders and indices so test is deterministic
    mgr.orders = new Map();
    mgr._ordersByState = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set()
    };
    mgr._ordersByType = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    // Add SPREAD placeholders around the market price
    const spreads = [
        { id: 'buy-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 95, size: 0 },
        { id: 'buy-1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 92, size: 0 },
        { id: 'sell-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 105, size: 0 },
        { id: 'sell-1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 108, size: 0 }
    ];
    spreads.forEach(s => mgr._updateOrder(s));

    // Ensure funds are large enough
    mgr.funds.available.buy = 1000;
    mgr.funds.available.sell = 1000;
    mgr.recalculateFunds();

    // Trigger rebalance: Since there are no active orders, it should try to place new ones
    // and correctly assign SPREAD types vs BUY/SELL types.
    const rebalanceResult = await mgr.strategy.rebalance();
    
    const buyPlacements = rebalanceResult.ordersToPlace.filter(o => o.type === ORDER_TYPES.BUY);
    const sellPlacements = rebalanceResult.ordersToPlace.filter(o => o.type === ORDER_TYPES.SELL);
    
    assert(buyPlacements.length > 0, 'Should place at least one buy');
    assert(sellPlacements.length > 0, 'Should place at least one sell');
    
    // The new engine picks the inward-most slot for activation
    assert.strictEqual(buyPlacements[0].price, 95, 'BUY activation should pick closest spread price (95)');
    assert.strictEqual(sellPlacements[0].price, 105, 'SELL activation should pick closest spread price (105)');

    console.log('spread selection tests (via rebalance) passed');
})();

// --- Test the rotation behavior via rebalance ---
(async () => {
    const rotateMgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 10,
        targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 },
        activeOrders: { buy: 1, sell: 1 } // Simpler setup: 1 active order per side
    });

    rotateMgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    rotateMgr.setAccountTotals({ buy: 1000, sell: 10 });
    rotateMgr.resetFunds();

    // Set up a scenario where an active order is OUTSIDE the window (should be rotated)
    // 1. Grid of slots
    const slots = [
        { id: 'buy-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 95 },
        { id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 85 },
        { id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 75 }
    ];
    slots.forEach(s => rotateMgr._updateOrder(s));
    
    // 2. Place an active order at the furthest slot (buy-2)
    // In the new strategy, if targetCount is 1, the window wants to be at buy-0 (closest to market)
    const furthestOrder = { ...slots[2], state: ORDER_STATES.ACTIVE, orderId: '1.7.100', size: 100 };
    rotateMgr._updateOrder(furthestOrder);
    rotateMgr.recalculateFunds();

    // 3. Trigger rebalance with a mock fill on the OPPOSITE side (SELL) 
    // to force inward rotation.
    const mockFills = [{ type: ORDER_TYPES.SELL, price: 105 }];
    const result = await rotateMgr.strategy.rebalance(mockFills);
    
    assert.strictEqual(result.ordersToRotate.length, 1, 'Should rotate 1 order');
    assert.strictEqual(result.ordersToRotate[0].oldOrder.id, 'buy-2', 'Should rotate the furthest order');
    // Inward rotation: index 2 should move to index 1
    assert.strictEqual(result.ordersToRotate[0].newGridId, 'buy-1', 'Should rotate inward by one slot (to buy-1)');

    console.log('rotation behavior tests (via rebalance) passed');
})();


