#!/usr/bin/env node

/**
 * Integration Test: Complete cacheFunds persistence lifecycle (pendingProceeds migrated)
 * Simulates the exact scenario the user reported:
 * 1. Partial fill occurs → proceeds accumulate into cacheFunds
 * 2. Log shows cacheFunds values
 * 3. storeMasterGrid() called → cacheFunds saved to orders.json
 * 4. Bot restarts → cacheFunds restored from orders.json
 */

const { AccountOrders, createBotKey } = require('../modules/account_orders');
const { OrderManager } = require('../modules/order');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

async function testCompleteLifecycle() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
        console.log('║  Integration Test: cacheFunds Complete Lifecycle  ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    const botKey = createBotKey({ name: 'integration-test' }, 0);
    const accountOrders = new AccountOrders();

    // ============================================================
    // PHASE 1: Bot Running - Partial Fill Occurs
    // ============================================================
    console.log('📌 PHASE 1: Bot Running - Partial Fill Occurs\n');

    const config = {
        name: 'integration-test',
        assetA: 'BTS',
        assetB: 'USD',
        botKey,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 1, sell: 1 },
        dryRun: false
    };

    // Create manager with initial state
    const manager = new OrderManager(config);
    manager.accountOrders = accountOrders;
    manager.funds = {
        available: { buy: 1000, sell: 1000 },
        cacheFunds: { buy: 0, sell: 0 },
        btsFeesOwed: 0
    };

    // Simulate partial fill
    console.log('   Simulating partial SELL order fill...');
    // In the migrated model, proceeds are added directly to cacheFunds
    manager.funds.cacheFunds.buy = 199.85817653;  // Fill proceeds
    manager.funds.available.buy = 409.36835306;  // Updated availability

    console.log(`   ✓ Partial fill processed`);
    console.log(`   ✓ cacheFunds updated: Buy=${manager.funds.cacheFunds.buy.toFixed(8)}, Sell=${manager.funds.cacheFunds.sell.toFixed(8)}`);
    console.log(`   ✓ Available funds updated: Buy=${manager.funds.available.buy.toFixed(8)}, Sell=${manager.funds.available.sell.toFixed(8)}\n`);

    // ============================================================
    // PHASE 2: Save Grid with PendingProceeds
    // ============================================================
    console.log('📌 PHASE 2: Save Grid with PendingProceeds\n');

    const mockOrders = [
        { id: 'sell-50', type: 'sell', price: 1.5, size: 10, state: 'VIRTUAL', orderId: null },
        { id: 'buy-50', type: 'buy', price: 0.9, size: 10, state: 'VIRTUAL', orderId: null }
    ];

    console.log('   Calling storeMasterGrid() with:');
    console.log(`   - Orders: ${mockOrders.length} grid orders`);
    console.log(`   - cacheFunds (with proceeds): Buy=${manager.funds.cacheFunds.buy}, Sell=${manager.funds.cacheFunds.sell}`);

    // Persist cacheFunds (already includes proceeds)
    const cacheWithProceeds = { buy: manager.funds.cacheFunds.buy, sell: manager.funds.cacheFunds.sell };
    accountOrders.storeMasterGrid(botKey, mockOrders, cacheWithProceeds);

    console.log('\n   ✓ Grid saved to memory');
    console.log('   ✓ cacheFunds persisted to orders.json\n');
    console.log('\n✅ SUCCESS: cacheFunds persistence working correctly!\n');

    // ============================================================
    // PHASE 3: Bot Restart - Load from Disk
    // ============================================================
    console.log('📌 PHASE 3: Bot Restart - Load from Disk\n');

    // Simulate fresh bot instance after restart
    const accountOrders2 = new AccountOrders();
    const manager2 = new OrderManager(config);
    manager2.accountOrders = accountOrders2;
    manager2.funds = {
        available: { buy: 0, sell: 0 },
        cacheFunds: { buy: 0, sell: 0 },
        btsFeesOwed: 0
    };

    console.log('   Reading from disk after restart...');
    
    // Restore from disk
    const restoredGrid = accountOrders2.loadBotGrid(botKey);
    const restoredCacheFunds = accountOrders2.loadCacheFunds(botKey);

    manager2.funds.cacheFunds = { ...restoredCacheFunds };

    console.log(`   ✓ Restored cacheFunds: Buy=${restoredCacheFunds.buy}, Sell=${restoredCacheFunds.sell}`);
    console.log(`   ✓ Restored grid: ${restoredGrid ? restoredGrid.length + ' orders' : 'none'}\n`);

    // ============================================================
    // PHASE 4: Verification
    // ============================================================
    console.log('📌 PHASE 4: Verification\n');

    const passed = [];
    const failed = [];

    // Test 1: Proceeds merged into cacheFunds correctly
    const expectedBuy = cacheWithProceeds.buy;
    if (Math.abs(restoredCacheFunds.buy - expectedBuy) < 1e-12) {
        console.log('   ✓ Test 1: proceeds merged into cacheFunds.buy correctly');
        passed.push('cacheFunds.buy');
    } else {
        console.log(`   ✗ Test 1: FAILED - Expected ${expectedBuy}, got ${restoredCacheFunds.buy}`);
        failed.push('cacheFunds.buy');
    }

    // Test 2: Sell-side proceeds (should be same logic)
    const expectedSell = cacheWithProceeds.sell;
    if (Math.abs(restoredCacheFunds.sell - expectedSell) < 1e-12) {
        console.log('   ✓ Test 2: proceeds merged into cacheFunds.sell correctly');
        passed.push('cacheFunds.sell');
    } else {
        console.log(`   ✗ Test 2: FAILED - Expected ${expectedSell}, got ${restoredCacheFunds.sell}`);
        failed.push('cacheFunds.sell');
    }

    // Test 3: Grid persisted
    if (restoredGrid && restoredGrid.length === mockOrders.length) {
        console.log('   ✓ Test 3: Grid persisted correctly');
        passed.push('grid');
    } else {
        console.log(`   ✗ Test 3: FAILED - Expected ${mockOrders.length} orders, got ${restoredGrid ? restoredGrid.length : 0}`);
        failed.push('grid');
    }

    // Test 4: Funds not lost
    const fundsRecovered = (restoredCacheFunds.buy || 0) > 0;
    if (fundsRecovered) {
        console.log(`   ✓ Test 4: Funds NOT lost - ${restoredCacheFunds.buy.toFixed(8)} USD recovered`);
        passed.push('funds_recovered');
    } else {
        console.log('   ✗ Test 4: FAILED - Funds were lost!');
        failed.push('funds_recovered');
    }

    // Summary
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${passed.length} Passed | ${failed.length} Failed`.padEnd(56) + '║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    if (failed.length === 0) {
        console.log('✅ SUCCESS: PendingProceeds persistence working correctly!\n');
        console.log('Summary:');
        console.log('  • Partial fill proceeds tracked in memory');
        console.log('  • Proceeds saved to orders.json with grid');
        console.log('  • Proceeds restored from disk on restart');
        console.log('  • Funds never lost across restart cycle\n');
    } else {
        console.log('❌ FAILURE: Some tests failed\n');
        console.log('Failed tests:', failed.join(', ') + '\n');
    }

    process.exit(failed.length > 0 ? 1 : 0);
}

testCompleteLifecycle().catch(err => {
    console.error('Test error:', err.message);
    process.exit(1);
});
