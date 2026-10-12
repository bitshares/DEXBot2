const assert = require('assert');
const { reconcileGrid } = require('../modules/order/utils/validate');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

function createManager(slots) {
    return {
        orders: new Map(slots.map(s => [s.id, { ...s }])),
        config: {
            incrementPercent: 1,
            coreOrders: { buy: 2, sell: 2 },
            weightDistribution: { buy: 0.5, sell: 0.5 }
        },
        assets: {
            assetA: { precision: 6 },
            assetB: { precision: 6 }
        },
        logger: {
            level: 'warn',
            log: () => {}
        }
    };
}

async function run() {
    console.log('Running self-rotation prevention test...');

    // In COW reconcileGrid, a surplus is master ACTIVE -> target VIRTUAL.
    // A hole is master VIRTUAL -> target ACTIVE.
    // Set up: s0 (edge) and s2 (inner) are surpluses; s1 is a hole.
    const allSlots = [
        { id: 's0', price: 1.0, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 100, orderId: 'o0' },
        { id: 's1', price: 1.1, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null },
        { id: 's2', price: 1.2, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 90, orderId: 'o2' }
    ];

    const manager = createManager(allSlots);

    const targetGrid = new Map([
        ['s0', { id: 's0', price: 1.0, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 }],
        ['s1', { id: 's1', price: 1.1, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 100, idealSize: 100 }],
        ['s2', { id: 's2', price: 1.2, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 }]
    ]);

    const result = reconcileGrid(manager.orders, targetGrid, 1, {
        logger: () => {},
        dustThresholdPercent: 5
    });

    // The edge surplus (s0) should be paired with the hole (s1) as a rotation
    const rotation = result.actions.find(
        a => a.type === COW_ACTIONS.UPDATE && a.isRotation && a.id === 's0' && a.newGridId === 's1'
    );
    assert(rotation, 'Edge-First: Should rotate s0 (furthest) to s1 (shortage)');

    // Inner surplus s2 should be canceled after edge s0 consumed the shortage
    const canceledS2 = result.actions.some(
        a => a.type === COW_ACTIONS.CANCEL && a.id === 's2'
    );
    assert.strictEqual(canceledS2, true, 'Inner surplus s2 should be canceled after edge s0 consumed the shortage');

    console.log('✓ Edge surplus used for rotation, inner surplus canceled (Edge-First)');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
