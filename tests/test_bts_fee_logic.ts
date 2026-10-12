/**
 * tests/test_bts_fee_logic.ts
 *
 * Unit tests for BTS fee settlement fix
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function runTests() {
    console.log('Running BTS Fee Logic Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 1.0, botFunds: { buy: 10000, sell: 1000 },
            coreOrders: { buy: 5, sell: 5 }, incrementPercent: 1
        });
        mgr.assets = { assetA: { id: '1.3.0', precision: 5 }, assetB: { id: '1.3.121', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 1000, buyFree: 10000, sellFree: 1000 });
        await mgr.resetFunds();
        return mgr;
    };

    console.log(' - Testing Normal Settlement Flow...');
    {
        const manager = await createManager();
        manager.funds.btsFeesOwed = 50;
        const buyFreeBefore = manager.accountTotals.buyFree;
        await manager.accountant.deductBtsFees('buy');
        assert.strictEqual(manager.accountTotals.buyFree, buyFreeBefore - 50);
        assert.strictEqual(manager.funds.btsFeesOwed, 0);
    }

    console.log(' - Testing Full Fee Deduction...');
    {
        const manager = await createManager();
        manager.funds.btsFeesOwed = 50;
        const buyFreeBefore = manager.accountTotals.buyFree;
        await manager.accountant.deductBtsFees('buy');
        assert.strictEqual(buyFreeBefore - manager.accountTotals.buyFree, 50, 'Full fee amount must reduce chainFree');
        assert.strictEqual(manager.funds.btsFeesOwed, 0);
    }

    console.log(' - Testing Insufficient Funds (Deferral)...');
    {
        const manager = await createManager();
        manager.funds.btsFeesOwed = 50;
        await manager.setAccountTotals({ buy: 40, sell: 10000, buyFree: 40, sellFree: 10000 });
        await manager.accountant.deductBtsFees('buy');
        assert.strictEqual(manager.funds.btsFeesOwed, 50, 'Settlement should be deferred');
    }

    console.log(' - Testing Zero Fees Graceful Handling...');
    {
        const manager = await createManager();
        manager.funds.btsFeesOwed = 0;
        await manager.accountant.deductBtsFees('buy');
        assert.strictEqual(manager.funds.btsFeesOwed, 0);
    }

    console.log('✓ BTS Fee logic tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
