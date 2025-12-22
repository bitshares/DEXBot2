#!/usr/bin/env node

/**
 * Test: Verify cacheFunds (migration target) are persisted to orders.json
 */

const path = require('path');
const { AccountOrders, createBotKey } = require('../modules/account_orders');

async function testCacheFundsPersistenceToFile() {
    console.log('\n=== Test: cacheFunds Persistence to File ===\n');

    const config = {
        name: 'test-bot-persistence',
        assetA: 'BTS',
        assetB: 'USD',
        botKey: createBotKey({ name: 'test-bot-persistence' }, 0),
    };

    const accountOrders = new AccountOrders();

    // Test 1: storeMasterGrid with proceeds merged into cacheFunds
    console.log('Test 1: Store grid with proceeds (merged into cacheFunds)');
    const orders = [
        { id: 'sell-1', type: 'sell', price: 1.5, size: 10, state: 'ACTIVE' },
        { id: 'buy-1', type: 'buy', price: 0.9, size: 10, state: 'ACTIVE' }
    ];
    
    const cacheFunds = { buy: 500, sell: 500 };
    const pendingProceeds = { buy: 199.85817653, sell: 0.00000000 };

    // New behavior: persist proceeds into cacheFunds (migration target)
    const cacheWithProceeds = { buy: cacheFunds.buy + pendingProceeds.buy, sell: cacheFunds.sell + pendingProceeds.sell };
    accountOrders.storeMasterGrid(config.botKey, orders, cacheWithProceeds);
    
    // Verify it was stored in memory (cacheFunds should hold the proceeds)
    const savedBot = accountOrders.data.bots[config.botKey];
    if (savedBot && savedBot.cacheFunds) {
        console.log(`✓ cacheFunds stored in memory: Buy ${savedBot.cacheFunds.buy.toFixed(8)}, Sell ${savedBot.cacheFunds.sell.toFixed(8)}`);
    } else {
        console.log('✗ cacheFunds NOT stored in memory');
    }

    // Test 2: Load from disk (fresh instance)
    console.log('\nTest 2: Load from fresh instance (from disk)');
    const accountOrders2 = new AccountOrders();
    const loadedCacheFunds = accountOrders2.loadCacheFunds(config.botKey);
    
    if (loadedCacheFunds && loadedCacheFunds.buy >= pendingProceeds.buy) {
        console.log(`✓ proceeds merged into cacheFunds on disk: Buy ${loadedCacheFunds.buy.toFixed(8)}, Sell ${loadedCacheFunds.sell.toFixed(8)}`);
    } else {
        console.log(`✗ proceeds NOT present in cacheFunds. Got: Buy ${loadedCacheFunds.buy}, Sell ${loadedCacheFunds.sell}`);
    }

    // Test 3: Verify loadBotGrid also returns grid
    console.log('\nTest 3: Verify grid is also saved and loaded');
    const loadedGrid = accountOrders2.loadBotGrid(config.botKey);
    if (loadedGrid && loadedGrid.length > 0) {
        console.log(`✓ Grid loaded from disk: ${loadedGrid.length} orders`);
    } else {
        console.log('✗ Grid NOT loaded from disk');
    }

    // Test 4: Update cacheFunds separately
    console.log('\nTest 4: Update cacheFunds after initial storage (simulate proceeds accumulation)');
    const newCache = { buy: 250.12345678, sell: 50.87654321 };
    accountOrders.updateCacheFunds(config.botKey, newCache);
    
    const accountOrders3 = new AccountOrders();
    const updatedCache = accountOrders3.loadCacheFunds(config.botKey);
    
    if (updatedCache.buy === newCache.buy && updatedCache.sell === newCache.sell) {
        console.log(`✓ Updated cacheFunds persisted: Buy ${updatedCache.buy.toFixed(8)}, Sell ${updatedCache.sell.toFixed(8)}`);
    } else {
        console.log(`✗ Updated cacheFunds NOT persisted correctly. Got: Buy ${updatedCache.buy}, Sell ${updatedCache.sell}`);
    }

    // Test 5: Clear cacheFunds
    console.log('\nTest 5: Clear cacheFunds and verify persistence');
    accountOrders.updateCacheFunds(config.botKey, { buy: 0, sell: 0 });
    
    const accountOrders4 = new AccountOrders();
    const clearedCache = accountOrders4.loadCacheFunds(config.botKey);
    
    if (clearedCache.buy === 0 && clearedCache.sell === 0) {
        console.log(`✓ Cleared cacheFunds persisted: Buy ${clearedCache.buy}, Sell ${clearedCache.sell}`);
    } else {
        console.log(`✗ Cleared cacheFunds NOT persisted correctly`);
    }

    console.log('\n=== All persistence tests completed ===\n');
}

testCacheFundsPersistenceToFile().catch(console.error);
