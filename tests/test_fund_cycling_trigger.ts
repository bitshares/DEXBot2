
const assert = require('assert');
const { checkAndUpdateGridIfNeeded } = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils/system');

// Mock BitShares for fee cache initialization
const mockBitShares = {
    db: {
        getGlobalProperties: async () => ({
            parameters: { current_fees: { parameters: [[1, { fee: 100000 }], [2, { fee: 10000 }], [77, { fee: 1000 }]] } }
        }),
        lookupAssetSymbols: async (symbols) => symbols.map(s => ({
            id: s === 'BTS' ? '1.3.0' : '1.3.1',
            symbol: s,
            options: { market_fee_percent: 0, extensions: {} }
        }))
    }
};

/**
 * MockManager that satisfies checkAndUpdateGridIfNeeded's real data contract.
 *
 * The threshold check works as follows:
 *   avail  = calculateAvailableFundsValue(side, accountTotals, funds, assetA, assetB, coreOrders)
 *          = max(0, chainFree - virtual - btsFeesOwed - btsFeesReservation)
 *   ratio  = (avail / allocated) * 100
 *   trigger when ratio >= GRID_REGENERATION_PERCENTAGE (default 3%)
 *
 * To isolate threshold logic from BTS fee reservation, tests use non-BTS asset
 * pairs (USD/EUR) so btsFeesReservation = 0 and avail = chainFree exactly.
 */
class MockManager {
    [key: string]: any;
    constructor({ gridBuy = 1000, gridSell = 1000, chainFreeBuy = 0, chainFreeSell = 0 } = {}) {
        this.config = {
            assetA: 'USD',
            assetB: 'EUR',
            coreOrders: { buy: 10, sell: 10 },
            incrementPercent: 1,
            weightDistribution: { buy: 1, sell: 1 },
            gridLimits: { GRID_REGENERATION_PERCENTAGE: GRID_LIMITS.GRID_REGENERATION_PERCENTAGE }
        };
        this.orders = new Map();
        this.funds = {
            available: { buy: 0, sell: 0 },
            total: { grid: { buy: gridBuy, sell: gridSell } },
            virtual: { buy: 0, sell: 0 },
            btsFeesOwed: 0
        };
        // accountTotals drives calculateAvailableFundsValue
        this.accountTotals = {
            buyFree: chainFreeBuy,
            sellFree: chainFreeSell,
            buy: gridBuy + chainFreeBuy,
            sell: gridSell + chainFreeSell
        };
        this.assets = {
            assetA: { precision: 8 },
            assetB: { precision: 8 }
        };
        this.logger = {
            log: (msg) => console.log(`  [MockManager] ${msg}`)
        };
        this._gridSidesUpdated = new Set();
    }

    getChainFundsSnapshot() {
        return {
            chainTotalBuy: this.accountTotals.buy,
            chainTotalSell: this.accountTotals.sell,
            allocatedBuy: this.accountTotals.buy,
            allocatedSell: this.accountTotals.sell
        };
    }
}

function populateOrders(manager, side, count = 10) {
    const type = side === 'buy' ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
    const basePrice = side === 'buy' ? 1.0 : 1.01;
    const dir = side === 'buy' ? -0.01 : 0.01;
    for (let i = 0; i < count; i++) {
        manager.orders.set(`${side}-${i}`, {
            id: `${side}-${i}`, type, size: 100,
            price: basePrice + i * dir, state: ORDER_STATES.ACTIVE, orderId: `order-${side}-${i}`
        });
    }
}

const threshold = GRID_LIMITS.GRID_REGENERATION_PERCENTAGE;

async function testThresholdExceeded() {
    console.log('\n--- Test 1: Available funds exceed regeneration threshold ---');

    // chainFreeBuy = 50, allocated = 1050 → ratio = 4.76% > 3%
    const manager = new MockManager({ gridBuy: 1000, chainFreeBuy: 50 });
    populateOrders(manager, 'buy');

    const result = checkAndUpdateGridIfNeeded(manager);
    const ratio = (50 / 1050) * 100;
    console.log(`  chainFreeBuy=50, allocated=1050, ratio=${ratio.toFixed(2)}% (threshold=${threshold}%)`);
    console.log(`  buyUpdated=${result.buyUpdated}`);

    assert.strictEqual(result.buyUpdated, true, 'Buy side should exceed regeneration threshold');
    assert.ok(manager._gridSidesUpdated.has(ORDER_TYPES.BUY), '_gridSidesUpdated should contain BUY');
    console.log('  PASS');
}

async function testThresholdNotExceeded() {
    console.log('\n--- Test 2: Available funds below regeneration threshold ---');

    // chainFreeBuy = 5, allocated = 1005 → ratio = 0.50% < 3%
    const manager = new MockManager({ gridBuy: 1000, chainFreeBuy: 5 });
    populateOrders(manager, 'buy');

    const result = checkAndUpdateGridIfNeeded(manager);
    const ratio = (5 / 1005) * 100;
    console.log(`  chainFreeBuy=5, allocated=1005, ratio=${ratio.toFixed(2)}% (threshold=${threshold}%)`);
    console.log(`  buyUpdated=${result.buyUpdated}`);

    assert.strictEqual(result.buyUpdated, false, 'Buy side should NOT exceed regeneration threshold');
    assert.ok(!manager._gridSidesUpdated.has(ORDER_TYPES.BUY), '_gridSidesUpdated should NOT contain BUY');
    console.log('  PASS');
}

async function testBothSidesIndependent() {
    console.log('\n--- Test 3: Independent per-side triggering ---');

    // Buy: 80 / 1080 = 7.4% > 3%  → triggers
    // Sell: 10 / 1010 = 1.0% < 3%  → does not trigger
    const manager = new MockManager({ gridBuy: 1000, gridSell: 1000, chainFreeBuy: 80, chainFreeSell: 10 });
    populateOrders(manager, 'buy');
    populateOrders(manager, 'sell');

    const result = checkAndUpdateGridIfNeeded(manager);
    console.log(`  buy ratio=${(80 / 1080 * 100).toFixed(2)}%, sell ratio=${(10 / 1010 * 100).toFixed(2)}%`);
    console.log(`  buyUpdated=${result.buyUpdated} (expected true), sellUpdated=${result.sellUpdated} (expected false)`);

    assert.strictEqual(result.buyUpdated, true, 'Buy side should trigger');
    assert.strictEqual(result.sellUpdated, false, 'Sell side should not trigger');
    console.log('  PASS');
}

async function testZeroGridSkipped() {
    console.log('\n--- Test 4: Zero grid capital skips threshold check ---');

    const manager = new MockManager({ gridBuy: 0, gridSell: 0, chainFreeBuy: 100, chainFreeSell: 100 });

    const result = checkAndUpdateGridIfNeeded(manager);
    console.log(`  buyUpdated=${result.buyUpdated}, sellUpdated=${result.sellUpdated}`);

    assert.strictEqual(result.buyUpdated, false, 'Zero grid buy should skip');
    assert.strictEqual(result.sellUpdated, false, 'Zero grid sell should skip');
    console.log('  PASS');
}

async function testExactThresholdBoundary() {
    console.log('\n--- Test 5: Exact threshold boundary ---');

    // Need ratio = exactly threshold. For threshold=3%, allocated=1000+x, free=x:
    // x/(1000+x) = 0.03 → x = 30/0.97 ≈ 30.93
    // Use 31 → ratio = 31/1031 = 3.006% ≥ 3% → triggers
    const manager1 = new MockManager({ gridBuy: 1000, chainFreeBuy: 31 });
    populateOrders(manager1, 'buy');
    const result1 = checkAndUpdateGridIfNeeded(manager1);
    const ratio1 = (31 / 1031) * 100;
    console.log(`  chainFreeBuy=31, ratio=${ratio1.toFixed(3)}% → buyUpdated=${result1.buyUpdated} (expected true)`);
    assert.strictEqual(result1.buyUpdated, true, 'Just above threshold should trigger');

    // Use 29 → ratio = 29/1029 = 2.818% < 3% → does not trigger
    const manager2 = new MockManager({ gridBuy: 1000, chainFreeBuy: 29 });
    populateOrders(manager2, 'buy');
    const result2 = checkAndUpdateGridIfNeeded(manager2);
    const ratio2 = (29 / 1029) * 100;
    console.log(`  chainFreeBuy=29, ratio=${ratio2.toFixed(3)}% → buyUpdated=${result2.buyUpdated} (expected false)`);
    assert.strictEqual(result2.buyUpdated, false, 'Just below threshold should not trigger');
    console.log('  PASS');
}

(async () => {
    try {
        console.log('=== Fund Cycling Trigger Tests ===');
        console.log('Tests verify checkAndUpdateGridIfNeeded threshold logic');
        console.log(`using calculateAvailableFundsValue (chainFree - virtual - fees)`);
        console.log(`GRID_REGENERATION_PERCENTAGE = ${threshold}%`);

        // Initialize fee cache (required by calculateAvailableFundsValue internals)
        await initializeFeeCache(['BTS', 'USD', 'EUR'], mockBitShares);

        await testThresholdExceeded();
        await testThresholdNotExceeded();
        await testBothSidesIndependent();
        await testZeroGridSkipped();
        await testExactThresholdBoundary();

        console.log('\n✅ All Fund Cycling Trigger Tests Passed!');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test Failed:', err);
        process.exit(1);
    }
})();
