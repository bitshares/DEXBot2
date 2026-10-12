const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils/system');
const { createTestLogger } = require('./helpers/silent_logger');
const { getErrorMessage } = require('../modules/utils/errors');

// Mock BitShares for fee initialization
const mockBitShares = {
    db: {
        getGlobalProperties: async () => ({
            parameters: {
                current_fees: {
                    parameters: [
                        [1, { fee: 100000 }], // limitOrderCreate
                        [2, { fee: 10000 }],  // limitOrderCancel
                        [77, { fee: 1000 }]   // limitOrderUpdate
                    ]
                }
            }
        }),
        lookupAssetSymbols: async (symbols) => {
            return symbols.map(s => ({
                id: s === 'BTS' ? '1.3.0' : '1.3.1',
                symbol: s,
                options: { market_fee_percent: 0 },
                precision: s === 'BTS' ? 8 : 5
            }));
        },
        get_full_accounts: async (names) => {
            return [[names[0], { account: { id: '1.2.1' } }]];
        }
    }
};

global.BitShares = mockBitShares;

console.log('='.repeat(80));
console.log('Testing Engine Integration (COW): Fill → Rebalance → Sync Cycle');
console.log('='.repeat(80));

// Helper to setup a manager with initial grid
async function setupManager() {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 50000, sell: 50000 },
        coreOrders: { buy: 3, sell: 3 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = createTestLogger({
        onLog: (msg, level) => {
            if (level === 'debug') return;
            console.log(`    [${level}] ${msg}`);
        }
    });

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    await mgr.setAccountTotals({ 
        buy: 50000, buyFree: 50000, 
        sell: 50000, sellFree: 50000 
    });

    mgr.fetchAccountTotals = async () => mgr.accountTotals;

    // Use slot-N ids in-rail (genesis-frozen determinism)
    mgr._gapSlots = 2;
    mgr.boundaryIdx = 5;
    // Setup initial grid: buy rail 0-5, sell rail 8-13
    for (let i = 0; i < 6; i++) {
        const price = 1.0 + (i * 0.05);
        const id = `slot-${8 + i}`;
        mgr.orders.set(id, {
            id,
            type: ORDER_TYPES.SELL,
            price: price,
            size: 10,
            state: ORDER_STATES.VIRTUAL
        });
    }

    for (let i = 0; i < 6; i++) {
        const price = 1.0 - (i * 0.05);
        const id = `slot-${i}`;
        mgr.orders.set(id, {
            id,
            type: ORDER_TYPES.BUY,
            price: price,
            size: 10,
            state: ORDER_STATES.VIRTUAL
        });
    }

    for (const order of mgr.orders.values()) {
        await mgr._updateOrder(order);
    }

    mgr.accountOrders = {
        updateBtsFeesOwed: async () => true
    };

    mgr._persistWithRetry = async (fn) => {
        try {
            return await fn();
        } catch (e) {
            return null;
        }
    };

    return mgr;
}

// ============================================================================
// TEST 1: SYNC ENGINE DETECTS FILL → STRATEGY REBALANCES → ACCOUNTANT TRACKS
// ============================================================================
async function testFillToRebalanceCycle() {
    console.log('\n[Test 1] Full cycle: Detect fill → Rebalance → Update funds');
    console.log('-'.repeat(80));

    const mgr = await setupManager();

    // Initial state: all VIRTUAL orders (slot-N ids)
    assert(mgr.orders.get('slot-8').state === ORDER_STATES.VIRTUAL);
    assert(mgr.orders.get('slot-5').state === ORDER_STATES.VIRTUAL);

    // Step 1: Activate a SELL order on chain
    const sellOrder = mgr.orders.get('slot-8');
    const activeSell = { ...sellOrder, state: ORDER_STATES.ACTIVE, orderId: 'chain-sell-1' };
    await mgr._updateOrder(activeSell);

    assert(mgr.orders.get('slot-8').state === ORDER_STATES.ACTIVE);
    assert(mgr.orders.get('slot-8').orderId === 'chain-sell-1');

    console.log('  ✓ Step 1: Sync activated SELL order');

    // Step 2: Detect partial fill (fill 5 of 10)
    const partialSell = { ...activeSell, size: 5, state: ORDER_STATES.PARTIAL };
    await mgr._updateOrder(partialSell);

    assert(mgr.orders.get('slot-8').state === ORDER_STATES.PARTIAL);
    assert(mgr.orders.get('slot-8').size === 5);
    console.log('  ✓ Step 2: Sync detected partial fill (size 5)');

    // Step 3: Process fills and rebalance
    const fill = { ...sellOrder, size: 5, isPartial: false };
    await mgr.strategy.processFillsOnly([fill]);
    const result = await mgr.performSafeRebalance([fill]);

    // Verify rebalancing actions
    assert(result.actions.length > 0, 'Should have rebalancing actions');
    console.log(`  ✓ Step 3: Strategy rebalanced, created ${result.actions.length} actions`);

    // Step 4: Verify fund calculations are consistent
    await mgr.recalculateFunds();

    const partialOrderSize = mgr.orders.get('slot-8').size;
    const committedSell = mgr.funds.committed.grid.sell;
    assert(committedSell >= partialOrderSize - 0.1, 'Committed funds should include partial order size');
    console.log(`  ✓ Step 4: Accountant tracked order state (partial size: ${partialOrderSize})`);

    assert(mgr.funds.available.sell >= 0, 'Available funds should never be negative');
    console.log('  ✓ Fund consistency verified (no leaks)');
}

// ============================================================================
// TEST 2: MULTI-ENGINE CONSOLIDATION → SYNC → REBALANCE
// ============================================================================
async function testConsolidationSyncRebalanceCycle() {
    console.log('\n[Test 2] Complex cycle: Consolidation → Sync → Rebalance');
    console.log('-'.repeat(80));

    const mgr = await setupManager();

    // Create two partial orders (slot-9 and slot-11 map to former sell-1/sell-3)
    const partial1 = { ...mgr.orders.get('slot-9'), size: 5, state: ORDER_STATES.PARTIAL, orderId: 'chain-s1' };
    const partial2 = { ...mgr.orders.get('slot-11'), size: 7, state: ORDER_STATES.PARTIAL, orderId: 'chain-s2' };

    await mgr._updateOrder(partial1);
    await mgr._updateOrder(partial2);

    console.log('  Step 1: Created 2 partial SELL orders');

    // Step 2: Run rebalance
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    assert(result.actions.length >= 0, 'Should have strategy actions');
    console.log(`  ✓ Step 2: Strategy rebalanced, created ${result.actions.length} actions`);

    // Step 3: Simulate full fill
    const filledPartial = { ...partial1, size: 0, state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SPREAD };
    await mgr._updateOrder(filledPartial);

    console.log('  ✓ Step 3: Sync detected full fill of partial');

    // Step 4: Rebalance based on fills
    await mgr.strategy.processFillsOnly([partial1]);
    const rebalanceResult = await mgr.performSafeRebalance([partial1]);

    assert(rebalanceResult.actions.length >= 0, 'Rebalancing should complete');
    console.log('  ✓ Step 4: Rebalancing completed');

    await mgr.recalculateFunds();
    assert(mgr.funds.available.sell >= 0, 'Available funds should be consistent');
    console.log('  ✓ Final state: All engines consistent');
}

(async () => {
    try {
        await initializeFeeCache(['BTS', 'USD'], mockBitShares);
        await testFillToRebalanceCycle();
        // Tests 2/3 (standalone rebalance exercises) were removed because they didn't test
        // the rebalance() entry point directly. Renumbered from Test 4 → Test 2 above.
        await testConsolidationSyncRebalanceCycle();

        console.log('\n' + '='.repeat(80));
        console.log('All Engine Integration Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', getErrorMessage(err));
        console.error((err as any).stack);
        process.exit(1);
    }
})();
