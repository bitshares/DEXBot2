/**
 * Test for failed COW commit reason propagation in
 * applyGridDivergenceCorrections.
 *
 * Divergence never shifts the boundary (only fills move it; spread promotion
 * shifts only onto same-batch placements), so this drives
 * applyGridDivergenceCorrections with a failing batch and verifies a
 * RECOVERY_EXHAUSTED abort propagates { committed: false, reason } while
 * master stays unpatched.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { applyGridDivergenceCorrections } = require('../modules/order/utils/system');
const { updateGridFromBlockchainSnapshot } = require('../modules/order/grid');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

/**
 * Set up a 10-slot grid with boundaryIdx=3, gapSlots=2.
 *   slots 0-3: BUY  (prices 95-98)
 *   slots 4-5: SPREAD (prices 99-100)
 *   slots 6-9: SELL (prices 101-104)
 *
 * Places on-chain BUY orders at slots 0,1,2.
 * Then patches slot-4 directly (bypasses SPREAD→ACTIVE invariant)
 * to simulate a stale SPREAD-typed slot that still carries an order —
 * failed commits must leave such master state untouched.
 *
 * fund.available is set directly so resize sizing is deterministic
 * regardless of accounting internals.
 *
 * @param {number} [sellFunds=30]
 * @param {number} [buyFunds=5700]
 */
async function createDivergenceFixture(sellFunds = 30, buyFunds = 5700) {
    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        coreOrders: { buy: 5, sell: 2 },
        botFunds: { buy: 10000, sell: 5000 },
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 },
    };

    manager.boundaryIdx = 3;
    manager.outOfSpread = 1;
    manager._gridVersion = 1;

    for (let i = 0; i < 10; i++) {
        const type = i <= 3 ? ORDER_TYPES.BUY : (i <= 5 ? ORDER_TYPES.SPREAD : ORDER_TYPES.SELL);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 95 + i,
            type,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
        });
    }

    // Place on-chain BUY orders at slots 0,1,2
    await manager._updateOrder({ id: 'slot-0', price: 95,  type: ORDER_TYPES.BUY,    state: ORDER_STATES.ACTIVE, size: 100, orderId: 'chain-0' });
    await manager._updateOrder({ id: 'slot-1', price: 96,  type: ORDER_TYPES.BUY,    state: ORDER_STATES.ACTIVE, size: 100, orderId: 'chain-1' });
    await manager._updateOrder({ id: 'slot-2', price: 97,  type: ORDER_TYPES.BUY,    state: ORDER_STATES.ACTIVE, size: 100, orderId: 'chain-2' });

    // slot-4 (SPREAD) — must be patched directly because OrderManager rejects
    // moving a SPREAD slot to ACTIVE.  In a real bot this state arises when a
    // boundary shift reclassifies a previously-placed BUY/SELL slot as SPREAD.
    // We patch the frozen master map to inject the orderId and state.
    const patched = new Map(manager.orders);
    patched.set('slot-4', Object.freeze({
        id: 'slot-4',
        price: 99,
        type: ORDER_TYPES.SPREAD,
        state: ORDER_STATES.ACTIVE,
        size: 100,
        orderId: 'chain-4',
        rawOnChain: { for_sale: 100 },
    }));
    // Rebuild indexes by hand since we bypassed _updateOrder
    const byState: Record<string, Set<string>> = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set(),
    };
    const byType: Record<string, Set<string>> = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set(),
    };
    for (const [, o] of patched as Map<string, any>) {
        if (byState[o.state]) byState[o.state].add(o.id);
        if (byType[o.type]) byType[o.type].add(o.id);
    }
    manager.orders = Object.freeze(patched);
    manager._ordersByState = byState;
    manager._ordersByType = byType;

    // Set funds directly so resize sizing is deterministic regardless of
    // accounting internals.
    manager.funds = {
        available: { sell: sellFunds, buy: buyFunds },
        total: {},
        locked: { sell: 0, buy: 0 },
        virtual: { sell: 0, buy: 0 },
        committed: { grid: { sell: 0, buy: 0 }, chain: { sell: 0, buy: 0 } },
        btsFeesReservation: 0,
    };
    await manager.setAccountTotals({ buy: buyFunds, sell: sellFunds, buyFree: buyFunds, sellFree: sellFunds });

    manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY, ORDER_TYPES.SELL]);

    return manager;
}


async function testRecoveryExhaustedReasonPropagation() {
    console.log('\n=== Test: RECOVERY_EXHAUSTED abort propagates reason ===\n');

    const manager = await createDivergenceFixture();

    const mockUpdateFn = async () => ({
        executed: false,
        aborted: true,
        reason: 'RECOVERY_EXHAUSTED',
    });
    const mockAccountOrders = { storeMasterGrid: async () => {} };

    const result = await applyGridDivergenceCorrections(
        manager, mockAccountOrders, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot
    );

    // No immediate retry exists anymore (divergence never shifts the boundary),
    // so the reason is informational: the next fill/sync cycle re-plans.
    assert(result, 'Should return a result object');
    assert.strictEqual(result.committed, false, `committed should be false, got ${result.committed}`);
    assert.strictEqual(result.boundaryChanged, undefined, `boundaryChanged should be gone, got ${result.boundaryChanged}`);
    assert.strictEqual(result.reason, 'RECOVERY_EXHAUSTED',
        `reason should be RECOVERY_EXHAUSTED, got ${result.reason}`);

    // Master must remain unpatched (types stay stale).
    const slot4 = manager.orders.get('slot-4');
    assert.strictEqual(slot4.type, ORDER_TYPES.SPREAD,
        `slot-4 should remain SPREAD (master not patched), got ${slot4.type}`);

    console.log('  ✓ returned { committed: false, reason: RECOVERY_EXHAUSTED }');
    console.log('  ✓ master not patched\n');
}

async function main() {
    await testRecoveryExhaustedReasonPropagation();
    console.log('✓ Divergence abort-reason propagation test PASSED!\n');
}

if (require.main === module) {
    main().catch(err => {
        console.error('Test FAILED:', err);
        process.exit(1);
    });
}

module.exports = { testRecoveryExhaustedReasonPropagation };
