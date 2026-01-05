/**
 * tests/test_market_scenarios.js
 * 
 * Complex integration test simulating realistic market scenarios.
 * Focuses on StrategyEngine unified rebalancing logic.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils');

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

function setupScenarioManager(activeCount = 3) {
    const cfg = {
        name: 'scenario-bot', assetA: 'BTS', assetB: 'USD',
        startPrice: 0.02, minPrice: 0.01, maxPrice: 0.04,
        botFunds: { buy: 1000, sell: 50000 },
        activeOrders: { buy: activeCount, sell: activeCount },
        incrementPercent: 1, targetSpreadPercent: 2, weightDistribution: { buy: 0.5, sell: 0.5 }
    };
    const mgr = new OrderManager(cfg);
    mgr.logger = { 
        log: (msg, lvl) => { 
            if (lvl === 'error' || lvl === 'warn') console.log(`    [${lvl.toUpperCase()}] ${msg}`); 
        }, 
        logFundsStatus: () => {} 
    };
    mgr.assets = { 
        assetA: { id: '1.3.0', precision: 5, symbol: 'BTS' }, 
        assetB: { id: '1.3.1', precision: 8, symbol: 'USD' } 
    };
    mgr.setAccountTotals({ buy: 1000, buyFree: 1000, sell: 50000, sellFree: 50000 });
    return mgr;
}

// --- Scenarios ---

async function runMarketPumpScenario() {
    console.log('\n📈 SCENARIO 1: Market Pump');
    const mgr = setupScenarioManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Initial rebalance to place orders
    const res = await mgr.strategy.rebalance();
    res.ordersToPlace.forEach(o => mgr._updateOrder({ ...o, state: ORDER_STATES.ACTIVE, orderId: `id-${o.id}` }));
    mgr.recalculateFunds();

    console.log('  >>> Market PUMPS');
    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const fills = activeSells.slice(0, 2).map(o => ({ ...o, isPartial: false }));
    
    const result = await mgr.strategy.processFilledOrders(fills);
    assert(result.ordersToPlace.length > 0 || result.ordersToRotate.length > 0, 'Pump should trigger strategy actions');
    console.log('    ✓ Pump handled.');
}

async function runDumpAndPumpScenario() {
    console.log('\n📉 SCENARIO 2: Dump and Recovery');
    const mgr = setupScenarioManager();
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    const setup = await mgr.strategy.rebalance();
    setup.ordersToPlace.forEach(o => mgr._updateOrder({ ...o, state: ORDER_STATES.ACTIVE, orderId: `init-${o.id}` }));
    mgr.recalculateFunds();

    console.log('  >>> Flash DUMP');
    const activeBuys = mgr.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
    await mgr.strategy.processFilledOrders(activeBuys.map(o => ({ ...o, isPartial: false })));
    
    console.log('  >>> Fast RECOVERY');
    const currentSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const recoveryResult = await mgr.strategy.processFilledOrders(currentSells.slice(0, 1).map(o => ({ ...o, isPartial: false })));
    assert(recoveryResult, 'Recovery rebalance should return result');
    console.log('    ✓ V-Shape handled.');
}

async function runStateLifecycleScenario() {
    console.log('\n🔄 SCENARIO 3: Single Slot Lifecycle (V->A->S->A)');
    const mgr = setupScenarioManager(1);
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    const res1 = await mgr.strategy.rebalance();
    const target = res1.ordersToPlace.find(o => o.type === ORDER_TYPES.SELL);
    const targetId = target.id;
    
    res1.ordersToPlace.forEach(o => mgr._updateOrder({ ...o, state: ORDER_STATES.ACTIVE, orderId: 'L1' }));
    assert.strictEqual(mgr.orders.get(targetId).state, ORDER_STATES.ACTIVE);
    console.log('    ✓ ACTIVE');

    await mgr.strategy.processFilledOrders([{ ...mgr.orders.get(targetId), isPartial: false }]);
    
    // Move window past it
    const sellSlots = Array.from(mgr.orders.values()).filter(o => o.id.startsWith('sell-')).sort((a,b) => a.price - b.price);
    mgr._updateOrder({ ...sellSlots[10], state: ORDER_STATES.ACTIVE, orderId: 'force' });
    await mgr.strategy.rebalance();
    
    assert.strictEqual(mgr.orders.get(targetId).type, ORDER_TYPES.SPREAD);
    console.log('    ✓ SPREAD');

    mgr._updateOrder({ ...sellSlots[10], state: ORDER_STATES.VIRTUAL, orderId: null });
    const res2 = await mgr.strategy.rebalance([{ type: ORDER_TYPES.SELL, price: target.price * 0.99 }]);
    res2.ordersToPlace.forEach(o => mgr._updateOrder({ ...o, state: ORDER_STATES.ACTIVE, orderId: 'L2' }));
    
    assert.strictEqual(mgr.orders.get(targetId).state, ORDER_STATES.ACTIVE);
    console.log('    ✓ ACTIVE again');
}

async function runPartialHandlingScenario() {
    console.log('\n🧩 SCENARIO 4: Partial Order Handling');
    const mgr = setupScenarioManager(2);
    const grid = require('../modules/order/grid');
    await grid.initializeGrid(mgr, mgr.config);

    // Initial placement to get sizes into orders
    const initial = await mgr.strategy.rebalance();
    initial.ordersToPlace.forEach(o => mgr._updateOrder({ ...o, state: ORDER_STATES.ACTIVE, orderId: `id-${o.id}` }));
    mgr.recalculateFunds();

    const activeSells = mgr.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).sort((a,b) => a.price - b.price);
    const idealSize = activeSells[0].size;
    const subId = activeSells[0].id;
    
    console.log(`  Ideal Size: ${idealSize.toFixed(5)}`);

    // 1. Substantial (Oversized)
    // Anchoring only triggers if current size > ideal (releasing capital)
    mgr._updateOrder({ ...mgr.orders.get(subId), state: ORDER_STATES.PARTIAL, size: idealSize * 1.5, orderId: 'sub-1' });
    const resSub = await mgr.strategy.rebalance([{ type: ORDER_TYPES.BUY, price: 0.019 }]);
    assert(resSub.ordersToUpdate.some(u => u.partialOrder.id === subId), 'Oversized partial should be anchored down');
    console.log('    ✓ Substantial (oversized) correctly anchored.');

    // 2. Dust
    const dustId = activeSells[1].id;
    mgr._updateOrder({ ...mgr.orders.get(dustId), state: ORDER_STATES.PARTIAL, size: idealSize * 0.01, orderId: 'dust-1' });
    
    // Inject available funds to allow merge (StrategyEngine checks availableFunds > 0)
    mgr.funds.available.sell = 1000; 
    
    const resDust = await mgr.strategy.rebalance([{ type: ORDER_TYPES.BUY, price: 0.019 }]);
    
    // The dust order might be merged directly (if in window) or merged into a rotation (if out of window)
    const dustSlot = mgr.orders.get(dustId);
    const isMergedInRotation = resDust.ordersToRotate.some(r => r.oldOrder.id === dustId && r.newSize > idealSize);
    
    assert(dustSlot.isDoubleOrder || isMergedInRotation, 'Dust partial should be merged');
    console.log('    ✓ Dust correctly merged.');
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
        console.error('\n❌ Scenario test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();