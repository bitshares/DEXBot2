const assert = require('assert');
const { OrderManager, grid: Grid } = require('../modules/order');
const { ORDER_TYPES } = require('../modules/constants');

/**
 * Test that cacheFunds survive grid loading
 * This validates that the fix preserves cacheFunds through resetFunds
 */

async function testPendingProceedsPreservedDuringGridLoad() {
    console.log('Test: cacheFunds preserved during Grid.loadGrid()');
    
    // Create a simple manager with some test config
    const testConfig = {
        assetA: 'BTS',
        assetB: 'USD',
        marketPrice: 1.0,
        minPrice: 0.5,
        maxPrice: 2.0,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        activeOrders: { buy: 1, sell: 1 },
        botFunds: { buy: 1000, sell: 1000 },
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const manager = new OrderManager(testConfig);
    
    // Simulate some proceeds (from a partial fill) stored in cacheFunds
    const testPendingProceeds = { buy: 123.456, sell: 234.567 };
    manager.funds.cacheFunds = { ...testPendingProceeds };

    console.log(`  Before loadGrid: cacheFunds = { buy: ${manager.funds.cacheFunds.buy}, sell: ${manager.funds.cacheFunds.sell} }`);
    
    // Create a mock persisted grid
    const mockGrid = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, price: 0.99, size: 500, state: 'virtual' },
        { id: 'sell-0', type: ORDER_TYPES.SELL, price: 1.01, size: 500, state: 'virtual' }
    ];
    
    // Load the grid (this calls resetFunds internally)
    await Grid.loadGrid(manager, mockGrid);
    
    console.log(`  After loadGrid: cacheFunds = { buy: ${manager.funds.cacheFunds.buy}, sell: ${manager.funds.cacheFunds.sell} }`);

    // CRITICAL: Verify cacheFunds were NOT cleared by resetFunds during loadGrid
    assert.strictEqual(
        manager.funds.cacheFunds.buy, 
        testPendingProceeds.buy, 
        'Buy cacheFunds were cleared during loadGrid!'
    );
    assert.strictEqual(
        manager.funds.cacheFunds.sell, 
        testPendingProceeds.sell, 
        'Sell cacheFunds were cleared during loadGrid!'
    );
    
    console.log('✅ cacheFunds correctly preserved during Grid.loadGrid()');
}

async function testPendingProceedsPreservedDuringInitializeGrid() {
    console.log('\nTest: cacheFunds preserved during Grid.initializeGrid()');
    
    const testConfig = {
        assetA: 'BTS',
        assetB: 'USD',
        marketPrice: 1.0,
        minPrice: 0.5,
        maxPrice: 2.0,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        activeOrders: { buy: 1, sell: 1 },
        botFunds: { buy: 1000, sell: 1000 },
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const manager = new OrderManager(testConfig);
    
    // Initialize assets manually to avoid network calls
    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 8 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 4 }
    };
    
    // Set up minimal account totals
    manager.accountTotals = { buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 };
    
    // Simulate some proceeds (from a partial fill)
    const testPendingProceeds = { buy: 50.5, sell: 75.25 };
    manager.funds.cacheFunds = { ...testPendingProceeds };

    console.log(`  Before initializeGrid: cacheFunds = { buy: ${manager.funds.cacheFunds.buy}, sell: ${manager.funds.cacheFunds.sell} }`);
    
    // Initialize grid (this calls resetFunds internally)
    try {
        await Grid.initializeGrid(manager);
    } catch (err) {
        // Grid initialization might fail due to missing chain connection, that's OK
        // We just want to test that pendingProceeds survive the resetFunds call
        console.log(`  Note: initializeGrid threw (expected in test): ${err.message}`);
    }
    
    console.log(`  After initializeGrid: cacheFunds = { buy: ${manager.funds.cacheFunds.buy}, sell: ${manager.funds.cacheFunds.sell} }`);

    // CRITICAL: Verify cacheFunds were NOT cleared by resetFunds during initializeGrid
    assert.strictEqual(
        manager.funds.cacheFunds.buy, 
        testPendingProceeds.buy, 
        'Buy cacheFunds were cleared during initializeGrid!'
    );
    assert.strictEqual(
        manager.funds.cacheFunds.sell, 
        testPendingProceeds.sell, 
        'Sell cacheFunds were cleared during initializeGrid!'
    );
    
    console.log('✅ cacheFunds correctly preserved during Grid.initializeGrid()');
}

// Run tests
async function runTests() {
    try {
        await testPendingProceedsPreservedDuringGridLoad();
        await testPendingProceedsPreservedDuringInitializeGrid();
        console.log('\n✅ All grid load tests passed!');
    } catch (err) {
        console.error('❌ Test failed:', err.message);
        process.exit(1);
    }
}

runTests();
