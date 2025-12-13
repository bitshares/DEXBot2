/**
 * Test suite for Grid.compareGrids() function
 * 
 * Tests the grid comparison metric that calculates normalized sum of squared
 * relative differences between calculated and persisted grids separately by side,
 * including automatic grid regeneration when divergence exceeds threshold.
 */

const assert = require('assert');
const Grid = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS } = require('../modules/order/constants');
const { GRID_COMPARISON } = GRID_LIMITS;

/**
 * Test helper to create a mock order
 */
function createOrder(type, price, size, id = null, state = ORDER_STATES.VIRTUAL) {
    return {
        id: id || `order-${type}-${price}`,
        type,
        price: Number(price),
        size: Number(size),
        state,
        orderId: null
    };
}

/**
 * Test helper to create a minimal mock manager
 */
function createMockManager(options = {}) {
    return {
        config: options.config || { botKey: 'test-bot' },
        funds: options.funds || { 
            total: { grid: { buy: 100, sell: 100 } },
            cacheFunds: { buy: 0, sell: 0 },
            virtuel: { buy: 100, sell: 100 }
        },
        orders: new Map(),
        assets: options.assets || { 
            assetA: { precision: 8 }, 
            assetB: { precision: 8 } 
        },
        logger: {
            log: options.logFn || (() => {})
        },
        _updateOrder: options.updateOrderFn || ((o) => {}),
        recalculateFunds: options.recalculateFundsFn || (() => {})
    };
}

/**
 * Test helper to print test result
 */
function logTest(testName, passed, details = '') {
    const status = passed ? '✓ PASS' : '✗ FAIL';
    console.log(`${status}: ${testName}${details ? ` - ${details}` : ''}`);
    if (!passed) process.exitCode = 1;
}

console.log('\n=== Grid Comparison Function Tests (By Side) ===\n');

// Test 1: Identical grids should return 0 for both sides
{
    const grid1 = [
        createOrder(ORDER_TYPES.SELL, 1.0, 10),
        createOrder(ORDER_TYPES.SELL, 0.95, 12),
        createOrder(ORDER_TYPES.BUY, 0.90, 15),
        createOrder(ORDER_TYPES.BUY, 0.85, 18)
    ];
    const grid2 = [...grid1];
    const result = Grid.compareGrids(grid1, grid2);
    const passed = result.buy.metric === 0 && result.sell.metric === 0 && result.totalMetric === 0;
    logTest('Identical grids', passed, `buy=${result.buy.metric}, sell=${result.sell.metric}`);
}

// Test 2: Empty grids should return 0
{
    const result = Grid.compareGrids([], []);
    const passed = result.buy.metric === 0 && result.sell.metric === 0 && result.totalMetric === 0;
    logTest('Empty grids', passed);
}

// Test 3: Null/undefined inputs should return 0
{
    const result1 = Grid.compareGrids(null, []);
    const result2 = Grid.compareGrids([], null);
    const passed = result1.buy.metric === 0 && result2.buy.metric === 0;
    logTest('Null/undefined inputs', passed);
}

// Test 4: Only BUY orders - SELL should be 0
{
    const calculated = [
        createOrder(ORDER_TYPES.BUY, 0.90, 15),
        createOrder(ORDER_TYPES.BUY, 0.85, 18)
    ];
    const persisted = [
        createOrder(ORDER_TYPES.BUY, 0.90, 10),
        createOrder(ORDER_TYPES.BUY, 0.85, 10)
    ];
    const result = Grid.compareGrids(calculated, persisted);
    // Buy: (15-10)^2/100 + (18-10)^2/100 = 0.25 + 0.64 / 2 = 0.445
    const buyMetricExpected = ((0.5) * (0.5) + (0.8) * (0.8)) / 2;
    const passed = result.sell.metric === 0 && result.buy.metric > 0;
    logTest('Only BUY orders - SELL metric = 0', passed, `buy=${result.buy.metric.toFixed(6)}, sell=${result.sell.metric}`);
}

// Test 5: Only SELL orders - BUY should be 0
{
    const calculated = [
        createOrder(ORDER_TYPES.SELL, 1.0, 12),
        createOrder(ORDER_TYPES.SELL, 0.95, 15)
    ];
    const persisted = [
        createOrder(ORDER_TYPES.SELL, 1.0, 10),
        createOrder(ORDER_TYPES.SELL, 0.95, 10)
    ];
    const result = Grid.compareGrids(calculated, persisted);
    const passed = result.buy.metric === 0 && result.sell.metric > 0;
    logTest('Only SELL orders - BUY metric = 0', passed, `buy=${result.buy.metric}, sell=${result.sell.metric.toFixed(6)}`);
}

// Test 6: Different divergence on buy vs sell
{
    const calculated = [
        createOrder(ORDER_TYPES.SELL, 1.0, 12),   // 20% difference
        createOrder(ORDER_TYPES.BUY, 0.90, 10.5)  // 5% difference
    ];
    const persisted = [
        createOrder(ORDER_TYPES.SELL, 1.0, 10),
        createOrder(ORDER_TYPES.BUY, 0.90, 10)
    ];
    const result = Grid.compareGrids(calculated, persisted);
    // SELL: (12-10)/10 = 0.2, squared = 0.04
    // BUY: (10.5-10)/10 = 0.05, squared = 0.0025
    const tolerance = 0.0001;
    const passed = Math.abs(result.sell.metric - 0.04) < tolerance && Math.abs(result.buy.metric - 0.0025) < tolerance;
    logTest('Different divergence by side', passed, `buy=${result.buy.metric.toFixed(6)}, sell=${result.sell.metric.toFixed(6)}`);
}

// Test 7: Multiple orders with averaging per side
{
    const calculated = [
        createOrder(ORDER_TYPES.SELL, 2.0, 10),
        createOrder(ORDER_TYPES.SELL, 1.5, 12),
        createOrder(ORDER_TYPES.BUY, 0.8, 15),
        createOrder(ORDER_TYPES.BUY, 0.7, 20)
    ];
    const persisted = [
        createOrder(ORDER_TYPES.SELL, 2.0, 10),
        createOrder(ORDER_TYPES.SELL, 1.5, 10),
        createOrder(ORDER_TYPES.BUY, 0.8, 15),
        createOrder(ORDER_TYPES.BUY, 0.7, 10)
    ];
    const result = Grid.compareGrids(calculated, persisted);
    // SELL: (10-10)^2/100 + (12-10)^2/100 = 0 + 0.04 / 2 = 0.02
    // BUY: (15-15)^2/225 + (20-10)^2/100 = 0 + 1.0 / 2 = 0.5
    // Total: (0.02 + 0.5) / 2 = 0.26
    const tolerance = 0.0001;
    const sellPassed = Math.abs(result.sell.metric - 0.02) < tolerance;
    const buyPassed = Math.abs(result.buy.metric - 0.5) < tolerance;
    const totalPassed = Math.abs(result.totalMetric - 0.26) < tolerance;
    logTest('Multiple orders per side', sellPassed && buyPassed && totalPassed, 
            `buy=${result.buy.metric.toFixed(6)}, sell=${result.sell.metric.toFixed(6)}, total=${result.totalMetric.toFixed(6)}`);
}

// Test 8: Persisted size is 0 but calculated size > 0 (maximum divergence per side)
{
    const calculated = [
        createOrder(ORDER_TYPES.SELL, 1.0, 10),
        createOrder(ORDER_TYPES.BUY, 0.90, 10)
    ];
    const persisted = [
        createOrder(ORDER_TYPES.SELL, 1.0, 0),
        createOrder(ORDER_TYPES.BUY, 0.90, 0)
    ];
    const result = Grid.compareGrids(calculated, persisted);
    const passed = result.sell.metric === 1.0 && result.buy.metric === 1.0 && result.totalMetric === 1.0;
    logTest('Zero persisted size on both sides', passed, `buy=${result.buy.metric}, sell=${result.sell.metric}`);
}

// Test 9: Non-matching orders ignored per side
{
    const calculated = [
        createOrder(ORDER_TYPES.SELL, 1.0, 12),
        createOrder(ORDER_TYPES.SELL, 0.95, 15),  // Won't match
        createOrder(ORDER_TYPES.BUY, 0.90, 18),
        createOrder(ORDER_TYPES.BUY, 0.85, 20)    // Won't match
    ];
    const persisted = [
        createOrder(ORDER_TYPES.SELL, 1.0, 10),
        createOrder(ORDER_TYPES.BUY, 0.90, 15)
    ];
    const result = Grid.compareGrids(calculated, persisted);
    // SELL: only 1.0 matches: (12-10)^2/100 = 0.04
    // BUY: only 0.90 matches: (18-15)^2/225 = 0.04
    const tolerance = 0.0001;
    const passed = Math.abs(result.sell.metric - 0.04) < tolerance && Math.abs(result.buy.metric - 0.04) < tolerance;
    logTest('Non-matching orders ignored per side', passed, `buy=${result.buy.metric.toFixed(6)}, sell=${result.sell.metric.toFixed(6)}`);
}

console.log('\n=== Auto-Update Tests (By Side) ===\n');

// Test 10: BUY side exceeds threshold, SELL does not - only BUY updated
{
    let buyUpdateCalled = false;
    let sellUpdateCalled = false;
    
    const originalUpdateSide = Grid.updateGridOrderSizesForSide;
    Grid.updateGridOrderSizesForSide = (mgr, orderType, funds) => {
        if (orderType === ORDER_TYPES.BUY) buyUpdateCalled = true;
        if (orderType === ORDER_TYPES.SELL) sellUpdateCalled = true;
    };
    
    try {
        const manager = createMockManager();
        const calculated = [
            createOrder(ORDER_TYPES.SELL, 1.0, 10.5),  // 5% - below threshold
            createOrder(ORDER_TYPES.BUY, 0.90, 30)     // 200% - above threshold
        ];
        const persisted = [
            createOrder(ORDER_TYPES.SELL, 1.0, 10),
            createOrder(ORDER_TYPES.BUY, 0.90, 10)
        ];
        
        const result = Grid.compareGrids(calculated, persisted, manager, { buy: 0, sell: 0 });
        
        const passed = result.buy.updated === true && result.sell.updated === false && 
                      buyUpdateCalled && !sellUpdateCalled;
        logTest('Only BUY side updated when threshold exceeded', passed, 
                `buy_updated=${result.buy.updated}, sell_updated=${result.sell.updated}`);
    } finally {
        Grid.updateGridOrderSizesForSide = originalUpdateSide;
    }
}

// Test 11: SELL side exceeds threshold, BUY does not - only SELL updated
{
    let buyUpdateCalled = false;
    let sellUpdateCalled = false;
    
    const originalUpdateSide = Grid.updateGridOrderSizesForSide;
    Grid.updateGridOrderSizesForSide = (mgr, orderType, funds) => {
        if (orderType === ORDER_TYPES.BUY) buyUpdateCalled = true;
        if (orderType === ORDER_TYPES.SELL) sellUpdateCalled = true;
    };
    
    try {
        const manager = createMockManager();
        const calculated = [
            createOrder(ORDER_TYPES.SELL, 1.0, 25),    // 150% - above threshold
            createOrder(ORDER_TYPES.BUY, 0.90, 10.5)   // 5% - below threshold
        ];
        const persisted = [
            createOrder(ORDER_TYPES.SELL, 1.0, 10),
            createOrder(ORDER_TYPES.BUY, 0.90, 10)
        ];
        
        const result = Grid.compareGrids(calculated, persisted, manager, { buy: 0, sell: 0 });
        
        const passed = result.buy.updated === false && result.sell.updated === true && 
                      !buyUpdateCalled && sellUpdateCalled;
        logTest('Only SELL side updated when threshold exceeded', passed,
                `buy_updated=${result.buy.updated}, sell_updated=${result.sell.updated}`);
    } finally {
        Grid.updateGridOrderSizesForSide = originalUpdateSide;
    }
}

// Test 12: Both sides exceed threshold - both updated
{
    let buyUpdateCalled = false;
    let sellUpdateCalled = false;
    
    const originalUpdateSide = Grid.updateGridOrderSizesForSide;
    Grid.updateGridOrderSizesForSide = (mgr, orderType, funds) => {
        if (orderType === ORDER_TYPES.BUY) buyUpdateCalled = true;
        if (orderType === ORDER_TYPES.SELL) sellUpdateCalled = true;
    };
    
    try {
        const manager = createMockManager();
        const calculated = [
            createOrder(ORDER_TYPES.SELL, 1.0, 30),   // 200% - above threshold
            createOrder(ORDER_TYPES.BUY, 0.90, 25)    // 150% - above threshold
        ];
        const persisted = [
            createOrder(ORDER_TYPES.SELL, 1.0, 10),
            createOrder(ORDER_TYPES.BUY, 0.90, 10)
        ];
        
        const result = Grid.compareGrids(calculated, persisted, manager, { buy: 0, sell: 0 });
        
        const passed = result.buy.updated === true && result.sell.updated === true && 
                      buyUpdateCalled && sellUpdateCalled;
        logTest('Both sides updated when both exceed threshold', passed,
                `buy_updated=${result.buy.updated}, sell_updated=${result.sell.updated}`);
    } finally {
        Grid.updateGridOrderSizesForSide = originalUpdateSide;
    }
}

// Test 13: No sides exceed threshold - nothing updated
{
    let updateCalled = false;
    
    const originalUpdateSide = Grid.updateGridOrderSizesForSide;
    Grid.updateGridOrderSizesForSide = (mgr, orderType, funds) => {
        updateCalled = true;
    };
    
    try {
        const manager = createMockManager();
        const calculated = [
            createOrder(ORDER_TYPES.SELL, 1.0, 10.3),  // 3% - below threshold
            createOrder(ORDER_TYPES.BUY, 0.90, 10.2)   // 2% - below threshold
        ];
        const persisted = [
            createOrder(ORDER_TYPES.SELL, 1.0, 10),
            createOrder(ORDER_TYPES.BUY, 0.90, 10)
        ];
        
        const result = Grid.compareGrids(calculated, persisted, manager, { buy: 0, sell: 0 });
        
        const passed = result.buy.updated === false && result.sell.updated === false && !updateCalled;
        logTest('No sides updated when all below threshold', passed);
    } finally {
        Grid.updateGridOrderSizesForSide = originalUpdateSide;
    }
}

console.log('\n=== Test Summary ===');
console.log(`Threshold: ${GRID_COMPARISON.DIVERGENCE_THRESHOLD}`);
console.log('Separate metrics for buy/sell sides');
console.log('Independent auto-updates by side');
console.log('Run: npm test -- tests/test_grid_comparison.js');
console.log('Or: node tests/test_grid_comparison.js\n');
