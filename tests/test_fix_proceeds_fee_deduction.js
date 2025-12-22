/**
 * Test: BTS Fee Deduction Fix
 *
 * Verifies that pendingProceeds are deducted only ONCE when fees are paid,
 * not repeatedly during calculateAvailableFunds() calls.
 *
 * Problem: calculateAvailableFunds() was side-effecting by modifying pendingProceeds
 * every time it was called, causing proceeds to be zeroed out prematurely.
 *
 * Solution: Make calculateAvailableFunds() pure (no side effects), and deduct fees
 * immediately after proceeds are added in processFilledOrders().
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');

// Mock config
const config = {
    botKey: 'test-bot',
    assetA: 'BTS',        // Buy side = BTS
    assetB: 'IOB.XRP',    // Sell side = IOB.XRP
};

// Mock logger
const logger = {
    log: (msg, level) => {},
    level: 'debug',
    logFundsStatus: () => {}
};

// Mock account orders (pendingProceeds persistence removed; use cacheFunds)
const accountOrders = {
    updateCacheFunds: () => {},
    loadCacheFunds: () => ({ buy: 0, sell: 0 })
};

// Run tests
console.log('Running BTS Fee Deduction Fix tests...\n');

const tests = [
    {
        name: 'should NOT deduct fees repeatedly in calculateAvailableFunds()',
        run: () => {
            let manager = new OrderManager(config, logger, accountOrders);
            manager.resetFunds();
            manager.setAccountTotals({ buyFree: 10000, sellFree: 100, buy: 10000, sell: 100 });

            // Sell-side fills produce buy-side proceeds (quote asset = BTS)
            manager.funds.cacheFunds = { buy: 100, sell: 0 };
            manager.funds.btsFeesOwed = 10;

            const available1 = manager.calculateAvailableFunds('buy');
            assert.strictEqual(manager.funds.cacheFunds.buy, 100, 'Proceeds not modified by calculateAvailableFunds');

            const available2 = manager.calculateAvailableFunds('buy');
            assert.strictEqual(available1, available2, 'Multiple calls should return same value');
            assert.strictEqual(manager.funds.cacheFunds.buy, 100, 'Proceeds unchanged after multiple calls');

            manager.deductBtsFees();
            assert.strictEqual(manager.funds.cacheFunds.buy, 90, 'Fees deducted once (100 - 10)');
        }
    },
    {
        name: 'should handle fee deduction on correct side based on asset',
        run: () => {
            let manager = new OrderManager(config, logger, accountOrders);
            manager.resetFunds();
            manager.setAccountTotals({ buyFree: 10000, sellFree: 100, buy: 10000, sell: 100 });

            manager.funds.cacheFunds = { buy: 100, sell: 0 };
            manager.funds.btsFeesOwed = 50;

            manager.deductBtsFees();
            assert.strictEqual(manager.funds.cacheFunds.buy, 50);
            assert.strictEqual(manager.funds.btsFeesOwed, 0);
        }
    }
];

let passed = 0, failed = 0;
tests.forEach(test => {
    try {
        test.run();
        console.log(`✓ ${test.name}`);
        passed++;
    } catch (e) {
        console.log(`✗ ${test.name}`);
        console.log(`  Error: ${e.message}`);
        failed++;
    }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
