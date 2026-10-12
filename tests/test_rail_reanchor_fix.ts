/**
 * tests/test_rail_reanchor_fix.ts
 *
 * Regression test for the "spread gap removed" bug (sell rail left behind
 * after a crawl-up).
 *
 * Scenario (mirrors the 08:29 aaa-bbb incident):
 * - gapSlots = 2, initial boundary = 5 -> sellStart = 8, sells at slots 8-13.
 * - Two sells (slots 8, 9) fill -> boundary crawls 5 -> 7 -> sellStart = 10,
 *   spread band becomes slots 8-9.
 * - The SPREAD GUARD (assignGridRoles) keeps the still-live on-chain sell at
 *   slot-8 typed SELL in the target grid.
 *
 * Bug: slot-8 stayed inside the active sell window, so reconcile treated the
 * stranded sell as correctly placed and never moved it (spread gap removed).
 *
 * Fix: stray slots outside the boundary geometry are excluded from the active
 * window (target state VIRTUAL), so reconcile relocates them back onto the rail.
 */
const assert = require('assert');
const StrategyModule = require('../modules/order/strategy').default;
const StrategyEngine = StrategyModule.default || StrategyModule.StrategyEngine || StrategyModule;
const { reconcileGrid } = require('../modules/order/utils/validate');
const { _pickVirtualSlotsToActivate } = require('../modules/order/grid_reconcile_internal');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

function buildSlots(startPrice = 100, incrementPercent = 1) {
    // slot-i price = startPrice * (1 + inc/100)^i  (ascending)
    const slots = [];
    for (let i = 0; i <= 15; i++) {
        slots.push({
            id: `slot-${i}`,
            price: startPrice * Math.pow(1 + incrementPercent / 100, i),
            type: null,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null,
            committedSide: null
        });
    }
    return slots;
}

function createManager(slots, { gapSlots = 2, coreOrders = { buy: 6, sell: 6 } } = {}) {
    return {
        _gapSlots: gapSlots,
        _boundaryShiftBudget: null,
        orders: new Map(slots.map(s => [s.id, { ...s }])),
        config: {
            startPrice: 100,
            incrementPercent: 1,
            targetSpreadPercent: 2,
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5 },
            coreOrders,
            weightDistribution: { buy: 0.5, sell: 0.5 },
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0,
            assetA: 'TEST',
            assetB: 'BTS'
        },
        assets: {
            assetA: { id: '1.3.0', precision: 6, symbol: 'TEST' },
            assetB: { id: '1.3.1', precision: 6, symbol: 'BTS' }
        },
        logger: { log: () => {} }
    };
}

async function run() {
    console.log('Running sell-rail re-anchor regression test...');

    // ---- Arrange: grid with boundary 5, gapSlots 2, sells 8-13 ----
    const slots = buildSlots();
    const setType = (id, type) => {
        const s = slots.find(x => x.id === id);
        s.type = type;
        return s;
    };
    for (let i = 0; i <= 5; i++) {
        setType(`slot-${i}`, ORDER_TYPES.BUY).state = ORDER_STATES.ACTIVE;
    }
    for (let i = 8; i <= 13; i++) {
        setType(`slot-${i}`, ORDER_TYPES.SELL).state = ORDER_STATES.ACTIVE;
    }
    // Stranded live on-chain sell at slot-8 (fills at 8,9 happened; 9 is now virtual)
    const stray = slots.find(s => s.id === 'slot-8');
    stray.orderId = 'o-stray';
    stray.size = 0.5;
    const filledPlaceholder = slots.find(s => s.id === 'slot-9');
    filledPlaceholder.type = ORDER_TYPES.SPREAD;
    filledPlaceholder.state = ORDER_STATES.VIRTUAL;
    filledPlaceholder.orderId = null;
    filledPlaceholder.size = 0;

    const manager = createManager(slots);
    // Fill two sells at slots 8,9 -> crawl +2 -> boundary 7, sellStart 10
    const fills = [
        { id: 'slot-8', type: ORDER_TYPES.SELL, orderId: 'o-stray', price: slots.find(s => s.id === 'slot-8').price, size: 0.5, isPartial: false },
        { id: 'slot-9', type: ORDER_TYPES.SELL, orderId: 'o-gone', price: slots.find(s => s.id === 'slot-9').price, size: 0.5, isPartial: false }
    ];

    const strategy = new StrategyEngine(manager);
    const funds = {
        allocatedBuy: 5000,
        allocatedSell: 500,
        chainFreeBuy: 5000,
        chainFreeSell: 500,
        btsBalance: { free: 100 }
    };

    const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
        frozenMasterGrid: manager.orders,
        config: manager.config,
        accountAssets: manager.assets,
        funds,
        fills,
        currentBoundaryIdx: 5
    });

    assert.strictEqual(boundaryIdx, 7, `Boundary should crawl to 7, got ${boundaryIdx}`);

    // ---- Bug guard: stray slot-8 must be excluded from the active window ----
    const targetStray = targetGrid.get('slot-8');
    assert(targetStray, 'target grid must contain slot-8');
    assert.strictEqual(
        targetStray.state,
        ORDER_STATES.VIRTUAL,
        `stray sell at slot-8 must be VIRTUAL in target (not active), got ${targetStray.state}`
    );

    // ---- Reconcile must relocate the stranded sell onto the rail ----
    const result = reconcileGrid(manager.orders, targetGrid, boundaryIdx, {
        logger: () => {},
        dustThresholdPercent: 5
    });

    const movesStray = result.actions.some(
        a => a.type === COW_ACTIONS.UPDATE &&
             a.isRotation === true &&
             a.orderId === 'o-stray' &&
             a.newGridId !== 'slot-8'
    );
    const cancelsStray = result.actions.some(
        a => a.type === COW_ACTIONS.CANCEL && a.orderId === 'o-stray'
    );
    const keepsStray = result.actions.some(
        a => (a.type === COW_ACTIONS.CREATE && a.id === 'slot-8') ||
             (a.type === COW_ACTIONS.UPDATE && a.newGridId === 'slot-8')
    );

    assert(
        movesStray || cancelsStray,
        `stray sell must be relocated or cancelled, got actions: ${JSON.stringify(result.actions)}`
    );
    assert.strictEqual(
        keepsStray,
        false,
        'target must NOT re-place an active order at stray slot-8 (would keep it in the gap)'
    );

    console.log('✓ Stray gap sell excluded from window and relocated back onto the rail');

    // ---- Second-order guard: startup reconcile must not re-pick the cleared
    // stray slot (now a VIRTUAL SPREAD placeholder) and place a new sell back
    // inside the gap ----
    console.log('  - startup reconcile slot picking respects boundary geometry...');
    const slots2 = [];
    for (let i = 120; i <= 155; i++) {
        const isBuy = i <= 129;
        const isSell = i >= 134;
        const isActive = i >= 134 && i <= 149;
        slots2.push({
            id: `slot-${i}`,
            price: 950 + i * 0.1,
            type: isBuy ? ORDER_TYPES.BUY : (isSell ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD),
            state: i === 130 ? ORDER_STATES.VIRTUAL : (isActive ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL),
            size: isActive ? 0.06 : 0,
            orderId: isActive ? `o-${i}` : null
        });
    }
    const mgr2 = {
        _gapSlots: 4,
        boundaryIdx: 129,
        orders: new Map(slots2.map(s => [s.id, { ...s }])),
        config: { incrementPercent: 0.3, targetSpreadPercent: 1.5, gridLimits: {} },
        assets: {}
    };
    const picked = _pickVirtualSlotsToActivate(mgr2, ORDER_TYPES.SELL, 4);
    const gapBand = /slot-1(3[0-3])/.test(picked.map(s => s.id).join(' '));
    assert.strictEqual(
        gapBand,
        false,
        `startup reconcile must not pick gap-band slots, got: ${picked.map(s => s.id).join(', ')}`
    );
    assert(
        picked.every(s => /slot-1(4[0-9]|5[0-5])/.test(s.id)),
        `picked slots should be on the sell rail, got: ${picked.map(s => s.id).join(', ')}`
    );
    assert(
        picked.every(s => s.type === ORDER_TYPES.SELL),
        `picked SPREAD placeholders must be re-typed SELL before activation, got: ${picked.map(s => `${s.id}:${s.type}`).join(', ')}`
    );
    console.log('✓ Startup reconcile slot picking stays on the sell rail (no gap re-placement)');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
