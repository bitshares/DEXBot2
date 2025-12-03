const assert = require('assert');

console.log('Running account totals waiter tests');

const { OrderManager } = require('../modules/order/index.js');

(async () => {
    // Test: waiter resolves when setAccountTotals is called
    const mgr1 = new OrderManager({ botFunds: { buy: 0, sell: 0 } });
    // ensure no totals initially
    mgr1.accountTotals = { buy: null, sell: null };

    // after a short delay, simulate an on-chain fetch completing
    setTimeout(() => {
        mgr1.setAccountTotals({ buy: 123.45, sell: 67.89 });
    }, 50);

    // should resolve before timeout
    await mgr1.waitForAccountTotals(500);
    assert.strictEqual(Number(mgr1.accountTotals.buy), 123.45);
    assert.strictEqual(Number(mgr1.accountTotals.sell), 67.89);

    // Test: waiter times out and returns when totals are not provided
    const mgr2 = new OrderManager({ botFunds: { buy: 0, sell: 0 } });
    mgr2.accountTotals = { buy: null, sell: null };

    const start = Date.now();
    await mgr2.waitForAccountTotals(100);
    const elapsed = Date.now() - start;
    // elapsed should be at least the timeout (or close); ensure it did not resolve with values
    assert(elapsed >= 90, 'waitForAccountTotals should wait approximately the timeout when no totals arrive');
    // We don't assert on accountTotals here (environment may populate it);
    // the important behavior is that the waiter respects the timeout.

    console.log('account totals waiter tests passed');
})();
