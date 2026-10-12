const assert = require('assert');
console.log('Running manager tests (COW)');

const { OrderManager, grid: Grid } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

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
    coreOrders: { buy: 2, sell: 2 },
};

const mgr = new OrderManager(cfg);

// Funds before setting account totals
assert(mgr.funds && typeof mgr.funds.available.buy === 'number', 'manager should have funds object');

(async () => {
    await mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });

    // Ensure funds reflect the simple config values
    assert.strictEqual(mgr.funds.available.buy, 900.990099009901);
    assert.strictEqual(mgr.funds.available.sell, 9.009900990099009);

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

    // Check syncFromOpenOrders flows
    const syncResult = await mgr.syncFromOpenOrders([]);
    assert(syncResult && typeof syncResult === 'object', 'syncResult should return object');
    assert(Array.isArray(syncResult.updatedOrders), 'updatedOrders should be array');
    assert(Array.isArray(syncResult.filledOrders), 'filledOrders should be array');

    console.log('manager core tests passed');

    // --- New tests for SPREAD selection behavior ---
    // MODERN: Uses performSafeRebalance (COW pipeline)
    
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
    // midpoint is 100. Price spacing 10%.
    // slots 0-5 are BUY zone, 6-11 are SELL zone
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
    for (const s of spreads) {
        await mgr._updateOrder(s);
    }

    // Ensure funds are large enough
    mgr.accountTotals.buyFree = 1000;
    mgr.accountTotals.sellFree = 1000;
    mgr.accountTotals.buy = 1000;
    mgr.accountTotals.sell = 1000;
    await mgr.recalculateFunds();

    mgr.boundaryIdx = undefined;

    // MODERN: COW rebalance plans the whole window at once
    const cowRes = await mgr.performSafeRebalance();
    const placements = cowRes.actions.filter(a => a.type === 'create');
    
    let placedBuys = placements.filter(a => a.order.type === ORDER_TYPES.BUY);
    let placedSells = placements.filter(a => a.order.type === ORDER_TYPES.SELL);
    
    // Sort all placed orders
    placedBuys.sort((a,b) => b.order.price - a.order.price); // Descending (90, 80)
    placedSells.sort((a,b) => a.order.price - b.order.price); // Ascending (110, 120)
    
    assert(placedBuys.length >= 2, 'Should plan at least two buys');
    assert(placedSells.length >= 2, 'Should plan at least two sells');
    
    // Verify we covered the window (both Inner and Outer)
    assert.strictEqual(placedBuys[0].order.price, 90, 'Should have planned Inner Buy (90)');
    assert.strictEqual(placedBuys[1].order.price, 80, 'Should have planned Outer Buy (80)');
    
    assert.strictEqual(placedSells[0].order.price, 110, 'Should have planned Inner Sell (110)');
    assert.strictEqual(placedSells[1].order.price, 120, 'Should have planned Outer Sell (120)');

    console.log('spread selection tests (COW) passed');

    // --- Test the rotation behavior via COW ---
    const rotateMgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 1,
        targetSpreadPercent: 5,
        botFunds: { buy: 1000, sell: 1000 },
        weightDistribution: { buy: 1.0, sell: 1.0 }, 
        coreOrders: { buy: 1, sell: 1 }
    });

    rotateMgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.1', precision: 5 } };
    await rotateMgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await rotateMgr.resetFunds();

    for (let i = 0; i < 100; i++) {
        const type = (i <= 50) ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        await rotateMgr._updateOrder({ id: `slot-${i}`, type, state: ORDER_STATES.VIRTUAL, price: 50 + i, size: 10 });
    }
    
    rotateMgr.boundaryIdx = 50; 
    
    // Place active BUY at furthest outlier (slot-0)
    const furthestOrder = { id: 'slot-0', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '1.7.100', size: 10, price: 50 };
    await rotateMgr._updateOrder(furthestOrder);
    await rotateMgr.recalculateFunds();

    // Trigger rebalance with a mock fill on the OPPOSITE side (SELL) 
    // This moves boundary UP (+1) -> slot-51 becomes new BUY hole.
    const mockFills = [{ type: ORDER_TYPES.SELL, price: 105 }];
    // performSafeRebalance expects fills
    const rotateRes = await rotateMgr.performSafeRebalance(mockFills);
    
    // Rotation optimization: boundary crawl should pair same-side cancel+create
    // into a single update-style rotation action.
    const rotation = rotateRes.actions.find(
        a => a.type === 'update' && a.id === 'slot-0' && a.newGridId === 'slot-51'
    );

    assert(rotation, 'Should rotate furthest outlier to new hole (slot-0 -> slot-51)');

    console.log('rotation behavior tests (COW) passed');
    process.exit(0);
})().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
