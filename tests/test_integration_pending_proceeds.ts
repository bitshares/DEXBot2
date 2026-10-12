#!/usr/bin/env node

/**
 * Integration Test: Grid + BTS fee persistence lifecycle
 *
 * Simulates:
 * 1. Runtime state update after fills
 * 2. storeMasterGrid() persistence
 * 3. Restart + restore from disk
 */

const { AccountOrders, createBotKey } = require('../modules/account_orders');
const { OrderManager } = require('../modules/order').default;
const Format = require('../modules/order/format');
const { getErrorMessage } = require('../modules/utils/errors');

async function testCompleteLifecycle() {
    console.log('\n╔========================================================╗');
    console.log('║  Integration Test: Grid/Fee Persistence Lifecycle      ║');
    console.log('╚========================================================╝\n');

    const botKey = createBotKey({ name: 'integration-test' }, 0);
    const accountOrders = new AccountOrders({ botKey });

    console.log('📌 PHASE 1: Runtime State Update\n');

    const config = {
        name: 'integration-test',
        assetA: 'BTS',
        assetB: 'USD',
        botKey,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 1, sell: 1 },
        dryRun: false
    };

    const manager = new OrderManager(config);
    manager.accountOrders = accountOrders;
    await manager.resetFunds();
    manager.funds.available.buy = 409.36835306;
    manager.funds.available.sell = 1000;
    manager.funds.btsFeesOwed = 0.125;

    console.log('   ✓ Runtime funds updated');
    console.log(`   ✓ Available funds: Buy=${manager.funds.available.buy.toFixed(8)}, Sell=${manager.funds.available.sell.toFixed(8)}`);
    console.log(`   ✓ BTS fees owed: ${Format.formatAmount8(manager.funds.btsFeesOwed)}\n`);

    console.log('📌 PHASE 2: Persist Grid Snapshot\n');

    const mockOrders = [
        { id: 'sell-50', type: 'sell', price: 1.5, size: 10, state: 'virtual', orderId: null },
        { id: 'buy-50', type: 'buy', price: 0.9, size: 10, state: 'virtual', orderId: null }
    ];

    await accountOrders.storeMasterGrid(mockOrders, manager.funds.btsFeesOwed);

    console.log(`   ✓ Persisted ${mockOrders.length} orders`);
    console.log(`   ✓ Persisted BTS fees owed: ${Format.formatAmount8(manager.funds.btsFeesOwed)}\n`);

    console.log('📌 PHASE 3: Restart + Restore\n');

    const accountOrders2 = new AccountOrders({ botKey });
    const restoredGrid = accountOrders2.loadGrid();
    const restoredBtsFees = accountOrders2.loadBtsFeesOwed();

    console.log(`   ✓ Restored grid: ${restoredGrid ? restoredGrid.length : 0} orders`);
    console.log(`   ✓ Restored BTS fees owed: ${Format.formatAmount8(restoredBtsFees)}\n`);

    console.log('📌 PHASE 4: Verification\n');

    const passed = [];
    const failed = [];

    if (restoredGrid && restoredGrid.length === mockOrders.length) {
        console.log('   ✓ Test 1: Grid persisted correctly');
        passed.push('grid');
    } else {
        console.log(`   ✗ Test 1: Expected ${mockOrders.length} orders, got ${restoredGrid ? restoredGrid.length : 0}`);
        failed.push('grid');
    }

    if (Math.abs(restoredBtsFees - manager.funds.btsFeesOwed) < 1e-12) {
        console.log('   ✓ Test 2: BTS fee state persisted correctly');
        passed.push('btsFeesOwed');
    } else {
        console.log(`   ✗ Test 2: Expected ${manager.funds.btsFeesOwed}, got ${restoredBtsFees}`);
        failed.push('btsFeesOwed');
    }

    console.log('\n╔========================================================╗');
    console.log(`║  Results: ${passed.length} Passed | ${failed.length} Failed`.padEnd(56) + '║');
    console.log('╚========================================================╝\n');

    if (failed.length === 0) {
        console.log('✅ SUCCESS: Persistence lifecycle verified\n');
    } else {
        console.log('❌ FAILURE: Some tests failed\n');
        console.log('Failed tests:', failed.join(', ') + '\n');
    }

    process.exit(failed.length > 0 ? 1 : 0);
}

testCompleteLifecycle().catch(err => {
    console.error('Test error:', getErrorMessage(err));
    process.exit(1);
});
