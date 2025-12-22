const assert = require('assert');
const { AccountOrders } = require('../modules/account_orders');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Test that cacheFunds (migration target for pendingProceeds) are properly persisted and restored
 * This ensures funds from partial fills are not lost on bot restart
 */

async function testPendingProceedsPersistence() {
    // Use temp directory for test
    const tmpDir = path.join(os.tmpdir(), 'dexbot-test-pending-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        // Create AccountOrders instance with test directory
        const accountDb = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });

        const botKey = 'test-bot-pending';
        const testBotConfig = { name: 'test-bot', assetA: 'BTS', assetB: 'USD', active: true, botKey };
        
        // Ensure bot entry exists
        accountDb.ensureBotEntries([testBotConfig]);

        const testProceeds = { buy: 123.45678901, sell: 234.56789012 };

        console.log('Test 1: Save and load as cacheFunds (migration target)');
        // Persist proceeds into cacheFunds (new behavior)
        accountDb.updateCacheFunds(botKey, testProceeds);
        
        // Create new instance to simulate restart
        const accountDb2 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loaded = accountDb2.loadCacheFunds(botKey);
        
        assert.strictEqual(loaded.buy, testProceeds.buy, 'Buy cacheFunds not persisted correctly');
        assert.strictEqual(loaded.sell, testProceeds.sell, 'Sell cacheFunds not persisted correctly');
        console.log('✓ cacheFunds persisted and restored correctly');

        console.log('\nTest 2: Clear cacheFunds on rotation completion');
        const clearedCache = { buy: 0, sell: 0 };
        accountDb2.updateCacheFunds(botKey, clearedCache);
        
        const accountDb3 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loadedCleared = accountDb3.loadCacheFunds(botKey);
        
        assert.strictEqual(loadedCleared.buy, 0, 'Cleared buy cacheFunds not persisted');
        assert.strictEqual(loadedCleared.sell, 0, 'Cleared sell cacheFunds not persisted');
        console.log('✓ Cleared cacheFunds state persisted correctly');

        console.log('\nTest 3: Partial cache update (only one side set)');
        const partialCache = { buy: 100.5, sell: 0 };
        accountDb3.updateCacheFunds(botKey, partialCache);
        
        const accountDb4 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loadedPartial = accountDb4.loadCacheFunds(botKey);
        
        assert.strictEqual(loadedPartial.buy, 100.5, 'Partial buy cacheFunds not restored');
        assert.strictEqual(loadedPartial.sell, 0, 'Sell cacheFunds should be cleared');
        console.log('✓ Partial cacheFunds state persisted correctly');

        console.log('\nTest 4: Default return on missing botKey');
        const accountDb5 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const defaultCache = accountDb5.loadCacheFunds('nonexistent-bot');
        
        assert.deepStrictEqual(defaultCache, { buy: 0, sell: 0 }, 'Should return default {buy:0, sell:0} for nonexistent bot');
        console.log('✓ Default cacheFunds returned for nonexistent bot');

        console.log('\nTest 5: Accumulation of proceeds (multiple partial fills)');
        accountDb5.updateCacheFunds(botKey, { buy: 50, sell: 0 });
        
        // Simulate another partial fill accumulation into cache
        const current = accountDb5.loadCacheFunds(botKey);
        const accumulated = { 
            buy: current.buy + 25.5, 
            sell: current.sell 
        };
        accountDb5.updateCacheFunds(botKey, accumulated);
        
        const accountDb6 = new AccountOrders({ profilesPath: path.join(tmpDir, 'orders.json') });
        const loadedAccumulated = accountDb6.loadCacheFunds(botKey);
        
        assert.strictEqual(loadedAccumulated.buy, 75.5, 'Accumulated cacheFunds not correct');
        console.log('✓ Accumulated cacheFunds persisted correctly');

        console.log('\n✅ All cacheFunds persistence tests passed!');

    } finally {
        // Cleanup
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}

// Run test
testPendingProceedsPersistence().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
