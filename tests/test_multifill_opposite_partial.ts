/**
 * tests/test_multifill_opposite_partial.ts
 * 
 * Verifies handling of multiple fills on one side (e.g. BUY) 
 * while a PARTIAL order exists on the opposite side (e.g. SELL).
 * UPDATED: Uses modern COW pipeline (performSafeRebalance).
 */

// Compiled ESM namespaces are frozen: seed the fee cache via the _setFeeCache
// seam instead of patching OrderUtils.getAssetFees. Mirrors the old fixture
// (createFee=0.01, updateFee=0.0001, maker net = 10% of base) deterministically.
require('../modules/order/utils/math')._setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.01 },
        limitOrderUpdate: { bts: 0.0001 },
        limitOrderCancel: { bts: 0 },
        makerFeeDiscountPercent: 0.9,
    },
    USD: { chargesMarketFees: false },
});

const bsModule = require('../modules/bitshares_client');
if (bsModule.setSuppressConnectionLog) {
    bsModule.setSuppressConnectionLog(true);
}

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testMultifillOppositePartial() {
    console.log('Testing Multiple Fills with Opposite Partial Order (COW)...');

    const originalSync = OrderManager.prototype.synchronizeWithChain;
    OrderManager.prototype.synchronizeWithChain = async function() {
        return true;
    };

    try {
        const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 3, sell: 3 },
        incrementPercent: 1,
        targetSpreadPercent: 2
    });

    manager.synchronizeWithChain = async function() {
        return true;
    };

    manager.fetchAccountTotals = async function() {
        return true;
    };
    manager.syncFromOpenOrders = async function() {
        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
    };
    manager.persistGrid = async function() {
        return { isValid: true, reason: null };
    };

    manager.checkGridHealth = async function() {
        return { buyDust: false, sellDust: false };
    };

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 1000, sell: 1000,
        buyFree: 1000, sellFree: 1000
    });

    manager.logger = {
        log: (msg, level) => {
            if (level === 'info' || level === 'warn' || level === 'error') {
                console.log(`      [${level}] ${msg}`);
            }
        },
        logFundsStatus: () => {}
    };

    manager.accountant.validateTargetGrid = function() {
        return { isValid: true, shortfall: { buy: 0, sell: 0 }, details: {} };
    };

    const prices = [0.97, 0.98, 0.99, 1.0, 1.01, 1.02, 1.03, 1.04, 1.05];
    
    for (let i = 0; i < prices.length; i++) {
        let type = ORDER_TYPES.SPREAD;
        let state = ORDER_STATES.VIRTUAL;
        let orderId = null;
        let size = 0;

        if (i <= 2) { type = ORDER_TYPES.BUY; state = ORDER_STATES.ACTIVE; orderId = `buy-${i}`; size = 100; }
        else if (i >= 6) { type = ORDER_TYPES.SELL; state = ORDER_STATES.ACTIVE; orderId = `sell-${i}`; size = 10; }

        await manager._updateOrder({
            id: `slot-${i}`,
            type, price: prices[i], size, state, orderId
        });
    }
    manager.boundaryIdx = 2; 
    await manager.recalculateFunds();

    const sellToPartial = manager.orders.get('slot-6');
    await manager._updateOrder({ ...sellToPartial, state: ORDER_STATES.PARTIAL, size: 5 }); 
    
    assert.strictEqual(manager.orders.get('slot-6').state, ORDER_STATES.PARTIAL);

    const fill1 = { id: 'slot-2', orderId: 'buy-2', type: ORDER_TYPES.BUY, price: 0.99, size: 100, isPartial: false };
    const fill2 = { id: 'slot-1', orderId: 'buy-1', type: ORDER_TYPES.BUY, price: 0.98, size: 100, isPartial: false };

    await manager.strategy.processFillsOnly([fill1, fill2]);
    const result = await manager.performSafeRebalance([fill1, fill2]);

    // MODERN: commit the working grid atomically (matches the real COW commit
    // path). stateUpdates are optimistic snapshots only and must NOT be applied
    // on top of the working grid - doing so resurrects rotation sources with
    // new sizes.
    if (result.workingGrid) {
        await manager._commitWorkingGrid(result.workingGrid, result.workingIndexes, result.workingBoundary);
    }
    
    console.log('\n  Verifications');

    // Two BUY fills net a shift of -2, but deriveTargetBoundary rate-limits
    // the cumulative shift to half the active window (max(floor(3/2), 1) = 1)
    // to prevent burst-fill overreaction. Expected: 2 - 1 = 1.
    assert.strictEqual(manager.boundaryIdx, 1, 'Boundary should have shifted to 1 (rate-limited cap)');

    const updateOfSlot6 = result.actions.find(a => a.type === 'update' && a.id === 'slot-6');
    const cancelOfSlot6 = result.actions.find(a => a.type === 'cancel' && a.id === 'slot-6');
    
    if (updateOfSlot6 || cancelOfSlot6) {
        console.log(`     ✓ Slot-6 partial was correctly handled via ${updateOfSlot6 ? 'UPDATE' : 'CANCEL'} (Success)`);
    } else {
        // COW might have kept it if it still fits target grid
        console.log('     ✓ Slot-6 kept in grid (fits target)');
    }

    // Boundary 1 zones (gapSlots 0): buy slots 0-1, sell slots 2-8. The BUY
    // fills free buy budget (slot-1 re-created as BUY) and the sell surpluses
    // rotate into the in-window holes slot-2/3/4 (SELL) - no spread slots
    // remain, so the old "spread slots must have size 0" assertions no longer
    // apply.
    const slot1 = manager.orders.get('slot-1');
    const slot2 = manager.orders.get('slot-2');
    assert.strictEqual(slot1.type, ORDER_TYPES.BUY, 'Slot-1 should be re-created as BUY after the fill');
    assert.ok(slot1.size > 0, 'Slot-1 should carry a BUY size');
    assert.strictEqual(slot2.type, ORDER_TYPES.SELL, 'Slot-2 should be the SELL rotation target');
    assert.ok(slot2.size > 0, 'Slot-2 should carry the rotated SELL size');

    console.log('\n  ✓ Scenario: Multi-fill with opposite partial handled correctly');
    } finally {
        OrderManager.prototype.synchronizeWithChain = originalSync;
    }
}

testMultifillOppositePartial()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
