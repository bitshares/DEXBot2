const assert = require('assert');
const { activateClosestVirtualOrdersForPlacement, prepareFurthestOrdersForRotation, rebalanceSideAfterFill, evaluatePartialOrderAnchor } = require('../modules/order/legacy-testing');
console.log('Running rotation cacheFunds tests');

const { OrderManager, grid: Grid, constants } = require('../modules/order/index.js');
const ORDER_TYPES = constants.ORDER_TYPES;
const ORDER_STATES = constants.ORDER_STATES;

async function makeManager() {
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100,
        minPrice: 50, maxPrice: 200, incrementPercent: 10, targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 }, activeOrders: { buy: 4, sell: 4 }
    });
    mgr.assets = { assetA: { precision: 5 }, assetB: { precision: 5 } };
    mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });
    mgr.resetFunds();
    return mgr;
}

function seedGridForRotation(mgr, targetType, orderCount) {
    // Clear state
    mgr.orders = new Map();
    mgr._ordersByState = { [ORDER_STATES.VIRTUAL]: new Set(), [ORDER_STATES.ACTIVE]: new Set(), [ORDER_STATES.PARTIAL]: new Set() };
    mgr._ordersByType = { [ORDER_TYPES.BUY]: new Set(), [ORDER_TYPES.SELL]: new Set(), [ORDER_TYPES.SPREAD]: new Set() };

    // Add active orders of targetType to rotate
    for (let i = 0; i < orderCount; i++) {
        const id = (targetType === ORDER_TYPES.BUY) ? `buyA${i}` : `sellA${i}`;
        mgr._updateOrder({ id, type: targetType, state: ORDER_STATES.ACTIVE, price: 50 + i, size: 1, orderId: `1.7.${i}` });
    }

    // Add at least orderCount spread slots
    for (let i = 0; i < orderCount; i++) {
        mgr._updateOrder({ id: `s${i}`, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 90 + i, size: 0 });
    }
}

(async () => {
    // Test 1: geometric sizes sum < available -> surplus should be added to cacheFunds
    const mgr1 = await makeManager();
    seedGridForRotation(mgr1, ORDER_TYPES.BUY, 4);
    mgr1.funds.cacheFunds = { buy: 100, sell: 0 };

    // Monkeypatch geometric sizing to sum to 80
    const GridModule = require('../modules/order/grid');
    const origFn = GridModule.calculateOrderSizes;
    GridModule.calculateOrderSizes = (orders) => orders.map((o, i) => ({ ...o, size: [30, 20, 20, 10][i] || 0 }));

    const rotations1 = await prepareFurthestOrdersForRotation(mgr1, ORDER_TYPES.BUY, 4);
    // Budget: cacheFunds (100)
    // patch sum: 80
    // Surplus = 100 - 80 = 20
    const cached1 = mgr1.funds.cacheFunds.buy || 0;
    assert(Math.abs(cached1 - 20) < 1e-8, `Expected cacheFunds.buy ~= 20, got ${cached1}`);
    console.log('Test 1 passed: surplus added to cacheFunds when geometric < cache');

    // Restore
    GridModule.calculateOrderSizes = origFn;

    // Test 2: geometric sizes sum > available -> sizes scaled, no surplus
    const mgr2 = await makeManager();
    mgr2.setAccountTotals({ buy: 0, sell: 0, buyFree: 0, sellFree: 0 });
    seedGridForRotation(mgr2, ORDER_TYPES.BUY, 4);
    mgr2.funds.cacheFunds = { buy: 100, sell: 0 };

    // Patch to sum to 120
    GridModule.calculateOrderSizes = (orders) => orders.map((o, i) => ({ ...o, size: [40, 30, 30, 20][i] || 0 }));
    // Budget: cache (100)
    // Sizing 120 > 100, so scales to 100.

    const rotations2 = await prepareFurthestOrdersForRotation(mgr2, ORDER_TYPES.BUY, 4);
    const cached2 = mgr2.funds.cacheFunds.buy || 0;
    assert(Math.abs(cached2 - 0) < 1e-8, `Expected cacheFunds.buy == 0 after scaling, got ${cached2}`);
    console.log('Test 2 passed: geometric > cache scaled and no surplus added');

    // Restore original
    GridModule.calculateOrderSizes = origFn;

    console.log('rotation cacheFunds tests passed');
})();
