const assert = require('assert');
const StrategyEngine = require('../modules/order/strategy').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { getErrorMessage } = require('../modules/utils/errors');

function buildSlots() {
    const slots = [];
    for (let i = 0; i < 12; i++) {
        const type = i < 5 ? ORDER_TYPES.BUY : (i < 7 ? ORDER_TYPES.SPREAD : ORDER_TYPES.SELL);
        slots.push({
            id: `slot-${i}`,
            price: 100 + i,
            type,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null
        });
    }
    return slots;
}

function createManager(slots) {
    return {
        orders: new Map(slots.map(s => [s.id, { ...s }])),
        config: {
            assetA: 'XRP',
            assetB: 'BTS',
            startPrice: 105,
            incrementPercent: 1,
            targetSpreadPercent: 2,
            coreOrders: { buy: 2, sell: 2 },
            weightDistribution: { buy: 0.5, sell: 0.5 }
        },
        assets: {
            assetA: { id: '1.3.0', precision: 6, symbol: 'XRP' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
        },
        funds: {
            available: { buy: 1000, sell: 1000 },
            virtual: { buy: 0, sell: 0 }
        },
        accountTotals: { buyFree: 1000, sellFree: 1000 },
        boundaryIdx: undefined,
        logger: {
            level: 'warn',
            log: () => {}
        },
        pauseFundRecalc: () => {},
        resumeFundRecalc: () => {},
        recalculateFunds: async () => {},
        _updateOrder(order) {
            this.orders.set(order.id, { ...order });
        }
    };
}

async function run() {
    console.log('Running malformed fill type handling test...');

    const slots = buildSlots();
    const manager = createManager(slots);
    const strategy = new StrategyEngine(manager);

    // Test that processFillsOnly handles malformed fill types gracefully
    const malformedFills = [
        { type: ORDER_TYPES.SELL, isPartial: false, id: 'slot-10', orderId: '1.7.1', price: 110, size: 10 },
        { type: ORDER_TYPES.BUY, isPartial: false, id: 'slot-0', orderId: '1.7.2', price: 100, size: 10 },
        { type: 'MALFORMED', isPartial: false, id: 'slot-99', orderId: '1.7.3', price: 105, size: 10 },
        { isPartial: false, id: 'slot-98', orderId: '1.7.4', price: 105, size: 10 }
    ];

    // Should not throw on malformed types
    let threw = false;
    try {
        await strategy.processFillsOnly(malformedFills, new Set());
    } catch (err) {
        threw = true;
        console.error('Unexpected error:', getErrorMessage(err));
    }

    assert.strictEqual(threw, false, 'processFillsOnly should not throw on malformed fill types');

    // Valid fills should still be processed: their slots should be virtualized
    const sellSlot = manager.orders.get('slot-10');
    const buySlot = manager.orders.get('slot-0');

    assert.strictEqual((sellSlot as any).state, ORDER_STATES.VIRTUAL, 'Valid SELL fill should be virtualized');
    assert.strictEqual((buySlot as any).state, ORDER_STATES.VIRTUAL, 'Valid BUY fill should be virtualized');

    console.log('✓ Malformed fill types are ignored, valid fills processed correctly');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
