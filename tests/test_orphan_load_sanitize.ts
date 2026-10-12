const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');

/**
 * Ladder covering a legacy-id fixture grid. loadGrid refuses a non-empty
 * snapshot that carries no ladder (genesis invariant), so the snapshot hands
 * it one; legacy (non slot-N) ids are validated in 'log' mode, which is the
 * behaviour this sanitize test is about.
 */
const ladder = (levels) => buildGenesisFromPriceLevels(levels[Math.floor(levels.length / 2)], 1, 1, levels);

// Regression test for the load-time orphan heal (Layer 1 of the durable fix).
//
// A CREATE whose broadcast result was lost before its orderId was durably
// attached can be persisted as VIRTUAL + size>0 + no orderId. The legacy
// sanitizer (isPhantomOrder) only catches ACTIVE/PARTIAL without an id, so a
// VIRTUAL orphan survives reload and dilutes sizing / masks the real spread.
//
// loadGrid must neutralize any VIRTUAL slot with size>0 and no orderId by
// dropping the size to a clean empty. This test asserts that, and that legit
// placed slots (VIRTUAL/ACTIVE with an orderId) keep their size.
async function testOrphanLoadSanitize() {
    console.log('Running test: Orphan Load Sanitize (Layer 1)');

    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 100, sell: 100 },
        coreOrders: { buy: 1, sell: 1 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    mgr.btsBalance = { free: 1000, total: 1000, locked: 0 };

    const grid = [
        { id: 'b1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 0.80, size: 10, orderId: '1.7.101' },
        // Orphan with durable evidence: VIRTUAL, sized, NO orderId, CREATE
        // broadcast result lost (createUncertain flag — P2 sanitizer).
        { id: 'orphan', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1.00, size: 0.5, createUncertain: true },
        // Legit placed sell (must keep its size)
        { id: 's1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1.20, size: 10, orderId: '1.7.104' }
    ];

    await Grid.loadGrid(mgr, grid, 1, ladder([0.80, 1.00, 1.20]));

    console.log('  Scenario: createUncertain VIRTUAL + size>0 + no orderId is neutralized at load');
    const orphan = mgr.orders.get('orphan');
    assert(orphan, 'orphan slot must be present after load');
    assert.strictEqual(
        Number(orphan.size || 0),
        0,
        'Sized VIRTUAL orphan WITH createUncertain evidence must have its size dropped to a clean empty'
    );
    assert.strictEqual(orphan.createUncertain, false, 'createUncertain flag cleared after sanitize');

    console.log('  Scenario: unflagged sized VIRTUAL slot on a rail (planned-but-unplaced) keeps its size');
    const mgr2 = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 100, sell: 100 },
        coreOrders: { buy: 1, sell: 1 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    mgr2.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    mgr2.btsBalance = { free: 1000, total: 1000, locked: 0 };
    // Consistent 2-slot grid with boundary 1: both slots sit on the BUY rail,
    // so the unflagged sized VIRTUAL slot is a normal planned-but-unplaced
    // rail slot whose budgeted size must survive reload.
    const grid2 = [
        { id: 'b1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: 0.80, size: 10, orderId: '1.7.101' },
        { id: 'planned', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 1.10, size: 0.5 }
    ];
    await Grid.loadGrid(mgr2, grid2, 1, ladder([0.80, 1.10]));
    const planned = mgr2.orders.get('planned');
    assert.strictEqual(
        Number(planned.size || 0),
        0.5,
        'Unflagged sized VIRTUAL rail slot is the normal planned state — size must survive reload'
    );

    console.log('  Scenario: legit placed order keeps its size');
    const s1 = mgr.orders.get('s1');
    assert.strictEqual(Number(s1.size || 0), 10, 'Placed sell with orderId must keep its size');
    const b1 = mgr.orders.get('b1');
    assert.strictEqual(Number(b1.size || 0), 10, 'Placed buy with orderId must keep its size');

    console.log('  ✓ Load heal neutralizes sized VIRTUAL orphan without harming placed orders');
    console.log('✓ Orphan Load Sanitize (Layer 1) test PASSED\n');
}

testOrphanLoadSanitize().catch((err: any) => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
