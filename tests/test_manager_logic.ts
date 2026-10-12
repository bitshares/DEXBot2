/**
 * tests/test_manager_logic.ts
 * 
 * Ported from tests/unit/manager.test.js
 * Comprehensive unit tests for manager.js - Order management and state machine
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// Seed the fee cache so getAssetFees resolves deterministically (frozen ESM
// namespace — patching OrderUtils.getAssetFees is no longer possible).
const { _setFeeCache } = require('../modules/order/utils/math');
_setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 }
    }
});

async function runTests() {
    console.log('Running OrderManager Logic Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            coreOrders: { buy: 5, sell: 5 }
        });
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        return mgr;
    };

    console.log(' - Testing Index Consistency...');
    {
        const manager = await createManager();
        const order = { id: 't-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 };
        await manager._updateOrder(order);

        assert(manager._ordersByState[ORDER_STATES.VIRTUAL].has('t-1'));
        assert(manager._ordersByType[ORDER_TYPES.BUY].has('t-1'));
        assert(manager.orders.has('t-1'));

        // Transition
        await manager._updateOrder({ id: 't-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 100, orderId: 'c-1' });
        assert(!manager._ordersByState[ORDER_STATES.VIRTUAL].has('t-1'));
        assert(manager._ordersByState[ORDER_STATES.ACTIVE].has('t-1'));
    }

    // Index repair test removed: lazy getters compute indices from manager.orders,
    // so indices are always consistent by construction. No corruption possible.

    console.log(' - Testing SPREAD state restriction...');
    {
        const manager = await createManager();
        let loggedError = false;
        const originalLog = manager.logger.log;
        manager.logger.log = (msg, level) => { if (level === 'error' && msg.includes('SPREAD')) loggedError = true; };

        await manager._updateOrder({ id: 's-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SPREAD, size: 0 });
        await manager._updateOrder({ id: 's-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SPREAD, size: 0 });

        manager.logger.log = originalLog;
        assert(loggedError, 'Should log error when trying to move SPREAD to ACTIVE');
    }

    console.log(' - Testing boundary clamping during reconcile...');
    {
        const manager = await createManager();
        await manager._updateOrder({ id: 'bc-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 10, price: 100 });

        const targetGrid = new Map([
            ['bc-1', { id: 'bc-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 10, price: 100 }]
        ]);

        const result = manager.reconcileGrid(targetGrid, 999);
        assert.strictEqual(result.aborted, false, 'Out-of-range boundary should be clamped, not aborted');
    }

    console.log(' - Testing Order Locking...');
    {
        const manager = await createManager();
        const id = 'l-1';
        assert(!manager.isOrderLocked(id));
        manager.lockOrders([id]);
        assert(manager.isOrderLocked(id));
        manager.unlockOrders([id]);
        assert(!manager.isOrderLocked(id));
    }

    console.log(' - Testing Fund Recalc Pausing...');
    {
        const manager = await createManager();
        let recalcCount = 0;
        const originalRecalc = manager.accountant.recalculateFunds;
        manager.accountant.recalculateFunds = () => { recalcCount++; };

        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'p-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
        assert.strictEqual(recalcCount, 0);

        await manager.resumeFundRecalc();
        assert(recalcCount > 0);
        manager.accountant.recalculateFunds = originalRecalc;
    }

    console.log('✓ OrderManager logic tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
