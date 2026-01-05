const assert = require('assert');
console.log('Running rotation cacheFunds tests');

const { OrderManager, grid: Grid, constants } = require('../modules/order/index.js');
const ORDER_TYPES = constants.ORDER_TYPES;
const ORDER_STATES = constants.ORDER_STATES;

async function makeManager() {
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100,
        minPrice: 50, maxPrice: 200, incrementPercent: 10, targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 }, activeOrders: { buy: 2, sell: 2 }
    });
    mgr.assets = { assetA: { precision: 5 }, assetB: { precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });
    mgr.resetFunds();
    return mgr;
}

function seedGridForRotation(mgr, targetType) {
    // Clear state
    mgr.orders = new Map();
    mgr._ordersByState = { [ORDER_STATES.VIRTUAL]: new Set(), [ORDER_STATES.ACTIVE]: new Set(), [ORDER_STATES.PARTIAL]: new Set() };
    mgr._ordersByType = { [ORDER_TYPES.BUY]: new Set(), [ORDER_TYPES.SELL]: new Set(), [ORDER_TYPES.SPREAD]: new Set() };

    // Inward slots (SPREAD zone)
    mgr._updateOrder({ id: 'buy-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 95 });
    mgr._updateOrder({ id: 'sell-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 105 });

    // Middle slots
    mgr._updateOrder({ id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 85 });
    mgr._updateOrder({ id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 115 });

    // Outer slots
    mgr._updateOrder({ id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 75 });
    mgr._updateOrder({ id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 125 });
}

(async () => {
    // Test 1: Rebalance uses cacheFunds budget
    const mgr = await makeManager();
    seedGridForRotation(mgr, ORDER_TYPES.BUY);
    
    // Set 2 active orders at the furthest positions
    mgr._updateOrder({ id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '1.7.1', price: 85, size: 50 });
    mgr._updateOrder({ id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '1.7.2', price: 75, size: 50 });
    
    // Total budget = available (100) + cacheFunds (100) = 200
    mgr.funds.available.buy = 100;
    mgr.funds.cacheFunds.buy = 100;
    mgr.recalculateFunds();

    // Trigger rebalance with an opposite side fill to force inward rotation
    const result = await mgr.strategy.rebalance([{ type: ORDER_TYPES.SELL, price: 105 }]);
    
    // Should rotate furthest (buy-2) to closest (buy-0)
    assert.strictEqual(result.ordersToRotate.length, 1);
    assert.strictEqual(result.ordersToRotate[0].oldOrder.id, 'buy-2');
    assert.strictEqual(result.ordersToRotate[0].newGridId, 'buy-0');
    
    // Verify budget utilization: 
    // Target count is 2. Available budget for these 2 orders is ~200.
    // So each order should be around 100 (if neutral weight)
    assert(result.ordersToRotate[0].newSize > 90, `Expected new size to reflect increased budget, got ${result.ordersToRotate[0].newSize}`);

    console.log('Test 1 passed: rebalance correctly uses cacheFunds budget');

    console.log('rotation cacheFunds tests passed');
})();

