
const assert = require('assert');
const Grid = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// Mock Manager
class MockManager {
    constructor() {
        this.config = {
            weightDistribution: { buy: 1, sell: 1 },
            incrementPercent: 1,
            assetA: 'BTC',
            assetB: 'BTS'
        };
        this.orders = new Map();
        this.funds = {
            available: { buy: 0, sell: 0 },
            total: { grid: { buy: 1000, sell: 1000 } },
            cacheFunds: { buy: 0, sell: 0 }
        };
        this.assets = {
            assetA: { precision: 8 },
            assetB: { precision: 8 }
        };
        this.logger = {
            log: (msg) => console.log(`[MockManager] ${msg}`)
        };
        this._gridSidesUpdated = [];
    }

    calculateAvailableFunds(side) {
        return this.funds.available[side];
    }

    recalculateFunds() {
        // Mock: in real life this updates available based on chain totals
        // Here we just ensure available is set for our tests
    }

    _updateOrder(order) {
        this.orders.set(order.id, order);
    }

    _persistCacheFunds() { }
    _persistBtsFeesOwed() { }

    async processFilledOrders(filledOrders) {
        // Mock the fund migration logic from manager.js
        const currentAvailBuy = this.calculateAvailableFunds('buy');
        const currentAvailSell = this.calculateAvailableFunds('sell');

        this.funds.cacheFunds.buy += currentAvailBuy;
        this.funds.cacheFunds.sell += currentAvailSell;

        // Simulating recalculateFunds reset
        this.funds.available.buy = 0;
        this.funds.available.sell = 0;

        this.logger.log(`Mock: Moved available funds to cacheFunds. Buy: ${this.funds.cacheFunds.buy.toFixed(8)}, Sell: ${this.funds.cacheFunds.sell.toFixed(8)}`);

        // After migration, check if grid update is needed
        Grid.checkAndUpdateGridIfNeeded(this, this.funds.cacheFunds);

        return { ordersToPlace: [], ordersToRotate: [], partialMoves: [] };
    }
}

async function runTest() {
    console.log('--- Test: available -> cacheFunds -> grid update ---');

    const manager = new MockManager();

    // Setup initial grid state (1000 BTS locked in 10 orders)
    for (let i = 0; i < 10; i++) {
        manager.orders.set(`buy-${i}`, { id: `buy-${i}`, type: ORDER_TYPES.BUY, size: 100, price: 1, state: ORDER_STATES.ACTIVE, orderId: `order-${i}` });
    }

    // 1. Add available funds (50)
    manager.funds.available.buy = 50;
    console.log(`Initial Available: ${manager.funds.available.buy}`);

    // 2. Process an empty fill (simulating a fill event or just a sync cycle)
    // In our new logic, this should move 50 from available to cacheFunds and trigger a resize
    await manager.processFilledOrders([]);

    // 3. Assertions
    console.log(`Final Available: ${manager.funds.available.buy}`);
    console.log(`Final CacheFunds: ${manager.funds.cacheFunds.buy}`);

    assert.strictEqual(manager.funds.available.buy, 0, 'Available funds should be 0 after cycling');
    // Note: cacheFunds might be 0 or small if completely consumed by sizing (depending on precision/dust)
    // In our MockManager, updateGridOrderSizesForSide is called, which calculates surplus.

    const orders = Array.from(manager.orders.values()).filter(o => o.type === ORDER_TYPES.BUY);
    const totalSize = orders.reduce((sum, o) => sum + o.size, 0);
    console.log(`Total grid size after update: ${totalSize.toFixed(8)} (Expected ~1050)`);
    assert.ok(Math.abs(totalSize - 1050) < 0.000001, 'Total grid size should equal original grid + cycled available funds');

    console.log('\n--- Test: Threshold NOT Exceeded ---');
    const manager2 = new MockManager();
    for (let i = 0; i < 10; i++) {
        manager2.orders.set(`buy-${i}`, { id: `buy-${i}`, type: ORDER_TYPES.BUY, size: 100, price: 1, state: ORDER_STATES.ACTIVE, orderId: `order-${i}` });
    }
    manager2.funds.available.buy = 10; // 1% < 3%
    console.log('Scenario: available=10, grid=1000, threshold=3%. Update should NOT trigger.');

    await manager2.processFilledOrders([]);
    const totalSize2 = Array.from(manager2.orders.values()).filter(o => o.type === ORDER_TYPES.BUY).reduce((s, o) => s + o.size, 0);
    assert.strictEqual(totalSize2, 1000, 'Grid should NOT have been updated');
    assert.strictEqual(manager2.funds.cacheFunds.buy, 10, 'Available funds should move to cacheFunds even if threshold not met');

    console.log('\n✅ All Fund Cycling Trigger Tests Passed!');
}

runTest().catch(err => {
    console.error('❌ Test Failed:', err);
    process.exit(1);
});
