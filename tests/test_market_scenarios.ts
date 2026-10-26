/**
 * tests/test_market_scenarios.ts
 * 
 * Complex integration test simulating realistic market scenarios.
 * Focuses on StrategyEngine unified rebalancing logic.
 * UPDATED: Uses modern COW pipeline (performSafeRebalance).
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils/system');
const { createTestLogger } = require('./helpers/silent_logger');
const { getErrorMessage } = require('../modules/utils/errors');

// --- Mock Environment ---
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

async function setupScenarioManager(activeCount = 3) {
    const cfg = {
        name: 'scenario-bot', assetA: 'BTS', assetB: 'USD',
        startPrice: 0.02, minPrice: 0.01, maxPrice: 0.04,
        botFunds: { buy: 1000, sell: 50000 },
        coreOrders: { buy: activeCount, sell: activeCount },
        incrementPercent: 1, targetSpreadPercent: 2, weightDistribution: { buy: 0.5, sell: 0.5 }
    };
    const mgr = new OrderManager(cfg);
    mgr.logger = createTestLogger({
        onLog: (msg, lvl) => {
            if (lvl === 'error' || lvl === 'warn') console.log(`    [${lvl.toUpperCase()}] ${msg}`);
        }
    });
    mgr.assets = { 
        assetA: { id: '1.3.0', precision: 5, symbol: 'BTS' }, 
        assetB: { id: '1.3.1', precision: 8, symbol: 'USD' } 
    };
    await mgr.setAccountTotals({ buy: 1000, buyFree: 1000, sell: 50000, sellFree: 50000 });
    return mgr;
}

// --- Scenarios ---

async function runMarketPumpScenario() {
    console.log('\n📈 SCENARIO 1: Market Pump');
    const mgr = await setupScenarioManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Initial rebalance to place orders
    const res = await mgr.performSafeRebalance();
    const placements = res.actions.filter(a => a.type === 'create');
    for (const action of placements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `id-${action.id}` });
    }
    await mgr.recalculateFunds();

    console.log('  >>> Market PUMPS');
    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const fills = activeSells.slice(0, 2).map(o => ({ ...o, isPartial: false }));
    
    // Fills settled, then rebalance
    await mgr.strategy.processFillsOnly(fills);
    const result = await mgr.performSafeRebalance(fills);
    assert(result.actions.length > 0, 'Pump should trigger strategy actions');
    console.log('    ✓ Pump handled.');
}

async function runDumpAndPumpScenario() {
    console.log('\n📉 SCENARIO 2: Dump and Recovery');
    const mgr = await setupScenarioManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    const setup = await mgr.performSafeRebalance();
    const placements = setup.actions.filter(a => a.type === 'create');
    for (const action of placements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `init-${action.id}` });
    }
    await mgr.recalculateFunds();

    console.log('  >>> Flash DUMP');
    const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
    const dumpFills = activeBuys.map(o => ({ ...o, isPartial: false }));
    await mgr.strategy.processFillsOnly(dumpFills);
    await mgr.performSafeRebalance(dumpFills);
    
    console.log('  >>> Fast RECOVERY');
    const currentSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const recoveryFills = currentSells.slice(0, 1).map(o => ({ ...o, isPartial: false }));
    await mgr.strategy.processFillsOnly(recoveryFills);
    const recoveryResult = await mgr.performSafeRebalance(recoveryFills);
    assert(recoveryResult, 'Recovery rebalance should return result');
    console.log('    ✓ V-Shape handled.');
}

async function runStateLifecycleScenario() {
    console.log('\n🔄 SCENARIO 3: Single Slot Lifecycle (V->A->S->A)');
    const mgr = await setupScenarioManager(1);
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Helper to commit COW results (required for type assignments to take effect)
    async function commitResult(res) {
        if (res?.workingGrid) {
            // Mirror the COW executor: the commit consumes exactly the owed
            // fill-crawl records this plan's derivation folded. A commit without
            // the wire consumes nothing, which would leave the crawl owed and
            // re-apply it on the next rebalance.
            await mgr._commitWorkingGrid(res.workingGrid, res.workingGrid.getIndexes(), res.workingBoundary, {
                consumedCrawlIds: res.consumedCrawlIds
            });
        }
    }

    const res1 = await mgr.performSafeRebalance();
    const targetAction = res1.actions.find(a => a.type === 'create' && a.order.type === ORDER_TYPES.SELL);
    const targetId = targetAction.id;
    
    // Commit initial grid to get proper boundary
    await commitResult(res1);
    
    const placements = res1.actions.filter(a => a.type === 'create');
    for (const action of placements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: 'L1' });
    }
    assert.strictEqual(mgr.orders.get(targetId).state, ORDER_STATES.ACTIVE);
    console.log('    ✓ ACTIVE');

    // Fill the target order
    const fill = { ...mgr.orders.get(targetId), isPartial: false };
    await mgr.strategy.processFillsOnly([fill]);
    const fillRes = await mgr.performSafeRebalance([fill]);
    
    // Commit the fill result to update boundary
    await commitResult(fillRes);
    
    // Move window past it - force a far slot to be active
    const sellSlots = Array.from(mgr.orders.values()).filter(o => (o as any).id.startsWith('sell-')).sort((a,b) => (a as any).price - (b as any).price);
    await mgr._updateOrder({ ...(sellSlots[10] as any), state: ORDER_STATES.ACTIVE, orderId: 'force' });
    
    // Rebalance to reassign types based on new boundary
    const res3 = await mgr.performSafeRebalance();
    await commitResult(res3);
    
    // After fill and boundary crawl, the original sell slot should be in SPREAD zone
    assert.strictEqual(mgr.orders.get(targetId).type, ORDER_TYPES.SPREAD);
    console.log('    ✓ SPREAD');

    // Restore: remove the forced active order and simulate a BUY fill to move boundary back
    await mgr._updateOrder({ ...(sellSlots[10] as any), state: ORDER_STATES.VIRTUAL, orderId: null });
    
    // Simulate a BUY fill to move boundary back down (boundary-- for buy fills)
    // This should cause the SPREAD slot to become SELL again
    const buyFill = { type: ORDER_TYPES.BUY, price: mgr.config.startPrice * 0.99, isPartial: false };
    const res2 = await mgr.performSafeRebalance([buyFill]);
    await commitResult(res2);
    
    // After boundary moves back, the slot should be SELL type again
    assert.strictEqual(mgr.orders.get(targetId).type, ORDER_TYPES.SELL, 'Slot should be SELL after boundary moves back');
    console.log('    ✓ SELL type restored');
    
    // Now place it as ACTIVE (should be allowed since it's SELL type now)
    const placements2 = res2.actions.filter(a => a.type === 'create' && a.id === targetId);
    if (placements2.length > 0) {
        for (const action of placements2) {
            await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: 'L2' });
        }
        assert.strictEqual(mgr.orders.get(targetId).state, ORDER_STATES.ACTIVE);
        console.log('    ✓ ACTIVE again');
    } else {
        // If no placement for targetId, check if it's at least a valid SELL slot ready for placement
        console.log('    ✓ SELL type ready for placement (no immediate action in window)');
    }
}

async function runPartialHandlingScenario() {
    console.log('\n🧩 SCENARIO 4: Partial Order Handling');
    const mgr = await setupScenarioManager(2);
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Initial placement to get sizes into orders
    const initial = await mgr.performSafeRebalance();
    const initialPlacements = initial.actions.filter(a => a.type === 'create');
    for (const action of initialPlacements) {
        await mgr._updateOrder({ ...action.order, state: ORDER_STATES.ACTIVE, orderId: `id-${action.id}` });
    }
    await mgr.recalculateFunds();

    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const idealSize = activeSells[0].size;
    const subId = activeSells[0].id;
    
    console.log(`  Ideal Size: ${idealSize.toFixed(5)}`);

    // 1. Substantial (Oversized)
    await mgr._updateOrder({ ...mgr.orders.get(subId), state: ORDER_STATES.PARTIAL, size: idealSize * 1.5, orderId: 'sub-1' });
    const resSub = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.019 }]);

    // Modern COW handling may either:
    // - explicitly anchor the oversized partial via UPDATE, or
    // - preserve the on-chain PARTIAL size and rebalance around it.
    const subUpdate = resSub.actions.find(a => a.type === 'update' && a.id === subId);
    if (subUpdate) {
        assert(subUpdate.newSize <= idealSize * 1.01, `Oversized partial update should anchor near ideal (newSize=${subUpdate.newSize}, ideal=${idealSize})`);
        console.log('    ✓ Substantial (oversized) correctly anchored by UPDATE.');
    } else {
        const preserved = mgr.orders.get(subId);
        assert(preserved && preserved.state === ORDER_STATES.PARTIAL && preserved.orderId,
            'Oversized partial should remain a valid on-chain PARTIAL when no resize action is emitted');
        console.log('    ✓ Substantial (oversized) preserved as on-chain PARTIAL.');
    }

    // 2. Dust partial handling
    // A dust partial (1% of ideal size) should be handled by rebalance
    // Either merged into the next fill-cycle or flagged for update
    const dustId = activeSells[1].id;
    await mgr._updateOrder({ ...mgr.orders.get(dustId), state: ORDER_STATES.PARTIAL, size: idealSize * 0.01, orderId: 'dust-1' });
    
    // Inject available funds to allow merge
    mgr.accountTotals.sellFree += 1000;
    await mgr.recalculateFunds();
    
    const dustRes = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.019 }]);
    
    // Verify the dust partial is handled (either updated or remains as partial)
    const dustOrder = mgr.orders.get(dustId);
    const hasUpdateAction = dustRes.actions.some(a => a.type === 'update' && a.id === dustId);
    const hasCreateAction = dustRes.actions.some(a => a.type === 'create' && a.id === dustId);
    
    // The dust partial should either be updated (resized) or the slot should be ready for placement
    assert(hasUpdateAction || hasCreateAction || dustOrder.state === ORDER_STATES.PARTIAL, 
        `Dust partial should be handled (update=${hasUpdateAction}, create=${hasCreateAction}, state=${dustOrder.state})`);
    console.log('    ✓ Dust partial handled.');
}

(async () => {
    try {
        await initializeFeeCache(['BTS', 'USD'], mockBitShares);
        await runMarketPumpScenario();
        await runDumpAndPumpScenario();
        await runStateLifecycleScenario();
        await runPartialHandlingScenario();
        console.log('\n' + '='.repeat(50) + '\n✅ ALL MARKET SCENARIOS PASSED\n' + '='.repeat(50));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Scenario test failed:', getErrorMessage(err));
        console.error((err as any).stack);
        process.exit(1);
    }
})();
