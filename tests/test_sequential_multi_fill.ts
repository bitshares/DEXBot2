/**
 * tests/test_sequential_multi_fill.ts
 * 
 * Focused test for sequential processing of multiple filled orders.
 * UPDATED: Uses modern COW pipeline (performSafeRebalance).
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils/system');
const Format = require('../modules/order/format');
const { getErrorMessage } = require('../modules/utils/errors');

// Mock BitShares for fee initialization
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

async function setupManager() {
    const cfg = {
        name: 'multi-fill-test',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 0.02,
        minPrice: 0.01,
        maxPrice: 0.04,
        botFunds: { buy: 1000, sell: 50000 },
        coreOrders: { buy: 3, sell: 3 }, 
        incrementPercent: 1,
        targetSpreadPercent: 2,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, lvl) => { if (lvl !== 'debug') console.log(`[${(lvl || 'INFO').toUpperCase().padEnd(5)}] ${msg}`); },
        logFundsStatus: () => { },
        level: 'info'
    };
    mgr.assets = {
        assetA: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        assetB: { id: '1.3.1', precision: 8, symbol: 'USD' }
    };
    await mgr.setAccountTotals({ buy: 1000, buyFree: 1000, sell: 50000, sellFree: 50000 });

    return mgr;
}

async function testSequentialMultiFillProcessing() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST: Sequential Multi-Fill Processing (COW)');
    console.log('='.repeat(80));

    const mgr = await setupManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    console.log('\n>>> Initial Grid Setup');
    
    // COW rebalance builds the window instantly if budget allows
    const setupRes = await mgr.performSafeRebalance();
    const setupPlacements = setupRes.actions.filter(a => a.type === 'create');
    
    for (const action of setupPlacements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `ord-${action.id}` });
    }
    await mgr.recalculateFunds();

    const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE)
        .sort((a, b) => b.price - a.price); 
    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE)
        .sort((a, b) => a.price - b.price); 

    console.log(`\n>>> Initial Active Orders:`);
    console.log(`    BUY: ${activeBuys.map(o => `${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
    console.log(`    SELL: ${activeSells.map(o => `${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
    console.log(`    Boundary Index: ${mgr.boundaryIdx}`);

    const fill1 = { ...activeBuys[0], isPartial: false };
    const fill2 = { ...activeBuys[1], isPartial: false };

    console.log('\n' + '─'.repeat(80));
    console.log('SIMULATING: Two buy orders filled at once');
    console.log(`    Fill 1: ${fill1.id} @ ${fill1.price.toFixed(4)}`);
    console.log(`    Fill 2: ${fill2.id} @ ${fill2.price.toFixed(4)}`);
    console.log('─'.repeat(80));

    // PROCESS FILL 1
    console.log('\n>>> Processing FILL 1');
    await mgr.strategy.processFillsOnly([fill1], new Set([fill2.id]));
    const result1 = await mgr.performSafeRebalance([fill1], new Set([fill2.id]));

    console.log(`    Actions: ${result1.actions.length}`);

    // Apply actions from result1
    for (const action of result1.actions) {
        if (action.type === 'create') {
            await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `new1-${action.id}` });
        } else if (action.type === 'cancel') {
            await mgr._updateOrder({ ...mgr.orders.get(action.id), state: ORDER_STATES.VIRTUAL, orderId: null });
        } else if (action.type === 'update') {
            await mgr._updateOrder({ ...mgr.orders.get(action.id), size: action.newSize });
        }
    }
    await mgr.recalculateFunds();

    // PROCESS FILL 2
    console.log('\n>>> Processing FILL 2');
    await mgr.strategy.processFillsOnly([fill2]);
    const result2 = await mgr.performSafeRebalance([fill2]);

    console.log(`    Actions: ${result2.actions.length}`);

    // ASSERTIONS
    console.log('\n>>> Verification');

    assert(result1.actions.length > 0, 'Fill 1 should trigger at least one action');
    assert(result2.actions.length > 0, 'Fill 2 should trigger at least one action');

    console.log('\n✅ Sequential multi-fill processing test PASSED');
}

(async () => {
    try {
        await initializeFeeCache(['BTS', 'USD'], mockBitShares);
        await testSequentialMultiFillProcessing();
        console.log('\n' + '='.repeat(80));
        console.log('ALL TESTS PASSED');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test FAILED:', getErrorMessage(err));
        console.error((err as any).stack);
        process.exit(1);
    }
})();
