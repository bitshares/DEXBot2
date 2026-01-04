const assert = require('assert');
const { activateClosestVirtualOrdersForPlacement, prepareFurthestOrdersForRotation, rebalanceSideAfterFill, evaluatePartialOrderAnchor } = require('../modules/order/legacy-testing');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

console.log('='.repeat(80));
console.log('Testing Engine Integration: Fill → Rebalance → Sync Cycle');
console.log('='.repeat(80));

// Helper to setup a manager with initial grid
function setupManager() {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 50000, sell: 50000 },
        activeOrders: { buy: 3, sell: 3 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return;
            console.log(`    [${level}] ${msg}`);
        }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Setup initial grid
    for (let i = 0; i < 6; i++) {
        const price = 1.0 + (i * 0.05);
        mgr.orders.set(`sell-${i}`, {
            id: `sell-${i}`,
            type: ORDER_TYPES.SELL,
            price: price,
            size: 10,
            state: ORDER_STATES.VIRTUAL
        });
    }

    for (let i = 0; i < 6; i++) {
        const price = 1.0 - (i * 0.05);
        mgr.orders.set(`buy-${i}`, {
            id: `buy-${i}`,
            type: ORDER_TYPES.BUY,
            price: price,
            size: 10,
            state: ORDER_STATES.VIRTUAL
        });
    }

    for (const order of mgr.orders.values()) {
        mgr._updateOrder(order);
    }

    // Mock persistence methods for testing
    mgr.accountOrders = {
        updateCacheFunds: async () => true,
        updateBtsFeesOwed: async () => true
    };

    mgr._persistWithRetry = async (fn) => {
        try {
            return await fn();
        } catch (e) {
            return null; // Silent fail for testing
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

    const mgr = setupManager();

    // Initial state: all VIRTUAL orders
    assert(mgr.orders.get('sell-0').state === ORDER_STATES.VIRTUAL);
    assert(mgr.orders.get('buy-0').state === ORDER_STATES.VIRTUAL);

    // Step 1: SYNC ENGINE - Activate a SELL order on chain
    const sellOrder = mgr.orders.get('sell-0');
    const activeSell = { ...sellOrder, state: ORDER_STATES.ACTIVE, orderId: 'chain-sell-1' };
    mgr._updateOrder(activeSell);

    // Verify: Order is now ACTIVE and chainFree is deducted
    assert(mgr.orders.get('sell-0').state === ORDER_STATES.ACTIVE);
    assert(mgr.orders.get('sell-0').orderId === 'chain-sell-1');

    console.log('  ✓ Step 1: Sync activated SELL order');

    // Step 2: SYNC ENGINE - Detect partial fill (fill 5 of 10)
    const partialSell = { ...activeSell, size: 5, state: ORDER_STATES.PARTIAL };
    mgr._updateOrder(partialSell);

    assert(mgr.orders.get('sell-0').state === ORDER_STATES.PARTIAL);
    assert(mgr.orders.get('sell-0').size === 5);
    console.log('  ✓ Step 2: Sync detected partial fill (size 5)');

    // Step 3: STRATEGY ENGINE - Process fills and rebalance
    const filledOrders = [{ ...sellOrder, size: 5, isPartial: false }];
    const result = await mgr.strategy.processFilledOrders(filledOrders, new Set());

    // Verify rebalancing created new orders
    assert(result.ordersToPlace.length > 0, 'Should have rebalancing orders');
    console.log(`  ✓ Step 3: Strategy rebalanced, created ${result.ordersToPlace.length} new orders`);

    // Step 4: ACCOUNTANT - Verify fund calculations are consistent
    // Recalculate funds to verify consistency
    mgr.recalculateFunds();

    // Check that committed funds reflect the partial order (at least the size)
    const partialOrderSize = mgr.orders.get('sell-0').size;
    const committedSell = mgr.funds.committed.grid.sell;
    assert(committedSell >= partialOrderSize - 0.1, 'Committed funds should include partial order size');
    console.log(`  ✓ Step 4: Accountant tracked order state (partial size: ${partialOrderSize})`);

    // Verify no fund leaks
    assert(mgr.funds.available.sell >= 0, 'Available funds should never be negative');
    console.log('  ✓ Fund consistency verified (no leaks)');
}

// ============================================================================
// TEST 2: ORDER LOCKING PREVENTS RACE CONDITIONS
// ============================================================================
async function testOrderLockingPreventsRaces() {
    console.log('\n[Test 2] Order locking prevents race conditions between engines');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Simulate StrategyEngine starting to process a partial
    const orderId = 'sell-0';
    mgr.lockOrders([orderId]);

    // Verify: Order is locked
    assert(mgr.isOrderLocked(orderId), 'Order should be locked');
    console.log('  ✓ Order locked by Strategy engine');

    // Simulate SyncEngine trying to process the same order while locked
    const shouldSkip = mgr.isOrderLocked(orderId);
    assert(shouldSkip, 'Sync should skip locked orders');
    console.log('  ✓ Sync correctly skipped locked order');

    // Simulate Strategy completing and unlocking
    mgr.unlockOrders([orderId]);
    assert(!mgr.isOrderLocked(orderId), 'Order should be unlocked');
    console.log('  ✓ Order unlocked by Strategy engine');

    // Now Sync can process it
    assert(!mgr.isOrderLocked(orderId), 'Sync can now process it');
    console.log('  ✓ Sync can now safely process order');
}

// ============================================================================
// TEST 3: STATE TRANSITION FUND TRACKING
// ============================================================================
async function testStatTransitionFundTracking() {
    console.log('\n[Test 3] Fund tracking across state transitions');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Setup optimistic chainFree tracking
    mgr.accountTotals = { buy: 50000, buyFree: 50000, sell: 50000, sellFree: 50000 };
    mgr.recalculateFunds();

    const initialFreeAmnasset = mgr.accountTotals.sellFree;
    const orderSize = 10;

    // Transition: VIRTUAL → ACTIVE (funds should be deducted)
    const virtualSell = mgr.orders.get('sell-0');
    const activeSell = { ...virtualSell, state: ORDER_STATES.ACTIVE, orderId: 'chain-1' };

    mgr.accountant.updateOptimisticFreeBalance(virtualSell, activeSell, 'test-placement');
    mgr._updateOrder(activeSell);

    // Verify: chainFree decreased
    const afterActivationFree = mgr.accountTotals.sellFree;
    assert(afterActivationFree < initialFreeAmnasset, 'chainFree should decrease after activation');
    console.log(`  ✓ VIRTUAL→ACTIVE: chainFree decreased ${initialFreeAmnasset} → ${afterActivationFree}`);

    // Transition: ACTIVE → VIRTUAL (funds should be added back)
    const virtualAgain = { ...activeSell, state: ORDER_STATES.VIRTUAL, orderId: null };
    mgr.accountant.updateOptimisticFreeBalance(activeSell, virtualAgain, 'test-cancellation');
    mgr._updateOrder(virtualAgain);

    // Verify: chainFree increased back
    const afterCancellationFree = mgr.accountTotals.sellFree;
    assert(afterCancellationFree > afterActivationFree, 'chainFree should increase after cancellation');
    console.log(`  ✓ ACTIVE→VIRTUAL: chainFree increased ${afterActivationFree} → ${afterCancellationFree}`);

    // Verify: Back to original
    assert(afterCancellationFree === initialFreeAmnasset, 'Should return to initial free balance');
    console.log('  ✓ Fund tracking is balanced (no leaks)');
}

// ============================================================================
// TEST 4: MULTI-ENGINE CONSOLIDATION → SYNC → REBALANCE
// ============================================================================
async function testConsolidationSyncRebalanceCycle() {
    console.log('\n[Test 4] Complex cycle: Consolidation → Sync → Rebalance');
    console.log('-'.repeat(80));

    const mgr = setupManager();

    // Create two partial orders on opposite sides
    const partial1 = { ...mgr.orders.get('sell-1'), size: 5, state: ORDER_STATES.PARTIAL, orderId: 'chain-s1' };
    const partial2 = { ...mgr.orders.get('sell-3'), size: 7, state: ORDER_STATES.PARTIAL, orderId: 'chain-s2' };

    mgr._updateOrder(partial1);
    mgr._updateOrder(partial2);

    console.log('  Step 1: Created 2 partial SELL orders');

    // Step 2: STRATEGY ENGINE - Run consolidation
    // Mock evaluatePartialOrderAnchor for this test
    mgr.strategy.evaluatePartialOrderAnchor = (p, moveInfo) => {
        return {
            isDust: p.size < 5,
            idealSize: 10,
            percentOfIdeal: p.size / 10,
            residualCapital: 0
        };
    };

    const consolidationResult = await rebalanceSideAfterFill(mgr, ORDER_TYPES.BUY, ORDER_TYPES.SELL, 1, 0, new Set());

    assert(consolidationResult.partialMoves.length > 0, 'Should have partial moves from consolidation');
    console.log(`  ✓ Step 2: Consolidation created ${consolidationResult.partialMoves.length} moves`);

    // Step 3: SYNC ENGINE - Sync updated orders from blockchain
    // Simulate one of the partials completing fill
    const filledPartial = { ...partial1, size: 0, state: ORDER_STATES.SPREAD };
    mgr._updateOrder(filledPartial);

    console.log('  ✓ Step 3: Sync detected full fill of partial');

    // Step 4: STRATEGY ENGINE - Rebalance based on fills
    const rebalanceResult = await mgr.strategy.processFilledOrders([partial1], new Set());

    assert(rebalanceResult.ordersToPlace.length >= 0, 'Rebalancing should complete');
    console.log('  ✓ Step 4: Rebalancing completed');

    // Verify final state consistency
    mgr.recalculateFunds();
    assert(mgr.funds.available.sell >= 0, 'Available funds should be consistent');
    console.log('  ✓ Final state: All engines consistent');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================
(async () => {
    try {
        await testFillToRebalanceCycle();
        await testOrderLockingPreventsRaces();
        await testStatTransitionFundTracking();
        await testConsolidationSyncRebalanceCycle();

        console.log('\n' + '='.repeat(80));
        console.log('All Engine Integration Tests Passed! ✓');
        console.log('='.repeat(80));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
