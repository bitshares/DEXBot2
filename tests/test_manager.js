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
    targetSpreadPercent: 10,
    botFunds: { buy: 1000, sell: 10 },
    activeOrders: { buy: 2, sell: 2 },
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

    // Add SPREAD placeholders across a wider range (Unified IDs)
    // midpoint is 100. slots 0-5 are BUY zone, 6-11 are SELL zone
    const spreads = [
        { id: 'slot-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 50, size: 10 },
        { id: 'slot-1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 60, size: 10 },
        { id: 'slot-2', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 70, size: 10 },
        { id: 'slot-3', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 80, size: 10 },
        { id: 'slot-4', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 90, size: 10 },
        { id: 'slot-5', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 95, size: 10 },
        { id: 'slot-6', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 105, size: 10 },
        { id: 'slot-7', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 110, size: 10 },
        { id: 'slot-8', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 120, size: 10 },
        { id: 'slot-9', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 130, size: 10 },
        { id: 'slot-10', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 140, size: 10 },
        { id: 'slot-11', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 150, size: 10 }
    ];
    spreads.forEach(s => mgr._updateOrder(s));

    // Ensure funds are large enough
    mgr.funds.available.buy = 1000;
    mgr.funds.available.sell = 1000;
    mgr.recalculateFunds();

    // Ensure each test case starts with a fresh boundary determination
    mgr.boundaryIdx = undefined;

    // Trigger rebalance: Since there are no active orders, it should try to place new ones
    // and correctly assign SPREAD types vs BUY/SELL types.
    const rebalanceResult = await mgr.strategy.rebalance();
    
    const buyPlacements = rebalanceResult.ordersToPlace.filter(o => o.type === ORDER_TYPES.BUY).sort((a,b) => b.price - a.price);
    const sellPlacements = rebalanceResult.ordersToPlace.filter(o => o.type === ORDER_TYPES.SELL).sort((a,b) => a.price - b.price);
    
    assert(buyPlacements.length > 0, 'Should place at least one buy');
    assert(sellPlacements.length > 0, 'Should place at least one sell');
    
    // The new engine picks the inward-most slot for activation
    assert.strictEqual(buyPlacements[0].price, 90, 'BUY activation should pick closest price below pivot (90)');
    assert.strictEqual(sellPlacements[0].price, 110, 'SELL activation should pick closest price above pivot (110)');

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
        incrementPercent: 1,
        targetSpreadPercent: 5,
        botFunds: { buy: 1000, sell: 1000 },
        weightDistribution: { buy: 1.0, sell: 1.0 }, // EQUAL WEIGHTS for rotation test
        activeOrders: { buy: 1, sell: 1 }
    });

    rotateMgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    rotateMgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    rotateMgr.resetFunds();

    // 1. Large grid of slots
    for (let i = 0; i < 100; i++) {
        const type = (i <= 50) ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        rotateMgr._updateOrder({ id: `slot-${i}`, type, state: ORDER_STATES.VIRTUAL, price: 50 + i, size: 10 });
    }
    
    // 2. Set Boundary and Outlier
    rotateMgr.boundaryIdx = 50; 
    rotateMgr.config.activeOrders = { buy: 1, sell: 1 };
    
    // Place active BUY at furthest outlier (slot-0)
    const furthestOrder = { id: 'slot-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '1.7.100', size: 10, price: 50 };
    rotateMgr._updateOrder(furthestOrder);
    rotateMgr.recalculateFunds();

    // 3. Trigger rebalance with a mock fill on the OPPOSITE side (SELL) 
    // This moves boundary UP (+1) -> slot-51 becomes new BUY hole.
    const mockFills = [{ type: ORDER_TYPES.SELL, price: 105 }];
    const result = await rotateMgr.strategy.rebalance(mockFills);
    
    assert.strictEqual(result.ordersToRotate.length, 1, 'Should rotate 1 order');
    assert.strictEqual(result.ordersToRotate[0].oldOrder.id, 'slot-0', 'Should rotate the furthest outlier');
    assert.strictEqual(result.ordersToRotate[0].newGridId, 'slot-51', 'Should rotate to the new market hole (slot-51)');

    console.log('rotation behavior tests (via rebalance) passed');
})();

