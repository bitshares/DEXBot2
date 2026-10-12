/**
 * tests/test_cow_boundary_slot_replacement.ts
 *
 * Regression test for the "boundary slot not re-placed after stale cleanup"
 * bug (08:49 aaa-bbb incident).
 *
 * Root cause chain:
 * 1. A COW batch dies on a stale order (atomic executeBatch) → rotations lost.
 * 2. recoverExplicitStaleOrders converts the consumed slot to a zero-sized
 *    SPREAD placeholder.
 * 3. Reconcile's _pickVirtualSlotsToActivate filters in-rail VIRTUAL slots by
 *    `size >= effectiveMin` → the zeroed boundary-adjacent sell slots (136-138)
 *    are skipped.
 * 4. Reconcile backfills far-end slots (slot-158) instead → sell rail parked far
 *    from the boundary → wide spread. Out-of-spread detection never fires because
 *    it is gated behind divergence detection (see dexbot_maintenance_runtime).
 *
 * Fix: _pickVirtualSlotsToActivate re-derives the budgeted size for in-rail
 * VIRTUAL slots whose stored size is below the effective minimum (via
 * getSideBudget + calculateBudgetedSizes over the live fund snapshot), making
 * boundary-adjacent slots pickable again with a real funded size.
 *
 * This test asserts:
 * - A size-0 VIRTUAL SPREAD placeholder sitting boundary-adjacent
 *   (slots 136-138) is picked
 *   with a re-derived size >= effectiveMin (previously skipped).
 * - Far-end virtual slots are NOT preferred when boundary-adjacent zeroed slots
 *   can be funded (pick order respects boundary geometry + price sorting).
 * - _reconcileStartupSide (planOnly) plans a CREATE for the boundary slot using
 *   the re-derived size, not the stored size 0.
 * - When a budget cannot be derived (no funds snapshot / weight distribution),
 *   the legacy fallback still applies (size-0 slots remain unpickable).
 */
const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const {
    _pickVirtualSlotsToActivate,
    _reconcileStartupSide,
    _countActiveOnGrid,
} = require('../modules/order/grid_reconcile_internal');

function buildPrice(i: number, base = 950, step = 3) {
    // Monotonic ascending price per slot index (mirrors a geometric grid).
    return base + i * step;
}

function buildManager({
    boundaryIdx = 131,
    gapSlots = 4,
    sellSlots = [],
    buySlots = [],
    spreadSlots = [],
    funds = null,
    weightDistribution = { buy: 0.5, sell: 0.5 },
    coreOrders = { buy: 20, sell: 20 },
    config = {},
}) {
    const orders = new Map();
    const addSlot = (id, { type, state, size, orderId = null, committedSide = null }) => {
        const idx = parseInt(String(id).split('-')[1], 10);
        orders.set(id, {
            id,
            type,
            state,
            price: buildPrice(idx),
            size,
            orderId,
            committedSide,
        });
    };
    for (const s of buySlots) addSlot(s.id, s);
    for (const s of spreadSlots) addSlot(s.id, s);
    for (const s of sellSlots) addSlot(s.id, s);

    const manager: any = {
        _gapSlots: gapSlots,
        boundaryIdx,
        orders,
        config: {
            startPrice: buildPrice(boundaryIdx),
            incrementPercent: 0.3,
            targetSpreadPercent: 1.5,
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5 },
            coreOrders,
            weightDistribution,
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0,
            assetA: 'XRP',
            assetB: 'BTS',
            ...config,
        },
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        },
        accountTotals: { sellFree: 0, buyFree: 0 },
        logger: { log: () => {} },
        getOrdersByTypeAndState: (type: any, state: any) =>
            Array.from(orders.values()).filter((o: any) => o && o.type === type && o.state === state),
    };

    if (funds) {
        manager.getChainFundsSnapshot = () => funds;
    }
    return manager;
}

function makeSell(id: string, { state = ORDER_STATES.VIRTUAL, size = 0, orderId = null } = {}) {
    return { id, type: ORDER_TYPES.SELL, state, size, orderId };
}

function makeBuy(id: string, { state = ORDER_STATES.ACTIVE, size = 1, orderId = null } = {}) {
    return { id, type: ORDER_TYPES.BUY, state, size, orderId };
}

function makeSpread(id: string) {
    return { id, type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 0, orderId: null };
}

async function testBoundaryZeroedSlotsArePicked() {
    console.log('\n[COW-BOUNDARY-001] size-0 VIRTUAL boundary sells are picked with a re-derived size...');

    // Incident mirror: boundary 131, gap 4 → sellStart 136. Slots 136-138 are
    // VIRTUAL size 0 (stale-cleaned), slots 139+ are ACTIVE, far virtuals 156-158
    // carry stored sizes (old behavior backfilled these instead of the boundary).
    const sellSlots = [];
    for (let i = 136; i <= 138; i++) {
        sellSlots.push(makeSpread(`slot-${i}`)); // stale-zeroed SPREAD placeholders
    }
    for (let i = 139; i <= 155; i++) {
        sellSlots.push(makeSell(`slot-${i}`, { state: ORDER_STATES.ACTIVE, size: 3.3, orderId: `1.7.${i}` }));
    }
    for (let i = 156; i <= 158; i++) {
        sellSlots.push(makeSell(`slot-${i}`, { size: 3.2 })); // stored-size far virtuals
    }
    const buySlots = [];
    for (let i = 128; i <= 131; i++) {
        buySlots.push(makeBuy(`slot-${i}`, { size: 3575 }));
    }
    const spreadSlots = [132, 133, 134, 135].map((i) => makeSpread(`slot-${i}`));

    const funds = {
        allocatedBuy: 140000,
        allocatedSell: 70, // enough to fund a few boundary sells
        chainFreeBuy: 140000,
        chainFreeSell: 70,
        btsBalance: { free: 500 },
    };

    const manager = buildManager({ boundaryIdx: 131, gapSlots: 4, sellSlots, buySlots, spreadSlots, funds });

    const effectiveMin = 50 * Math.pow(10, -5); // MIN_ORDER_SIZE_FACTOR * 10^-precision = 0.0005
    const picked = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.SELL, 3);

    assert.strictEqual(picked.length, 3, `expected 3 picked sells, got ${picked.length}: ${picked.map((p: any) => p.id).join(',')}`);

    // Boundary-adjacent slots must be preferred over far-end stored-size slots.
    const pickedIds = picked.map((p: any) => p.id).join(' ');
    assert(
        pickedIds.includes('slot-136'),
        `boundary slot-136 must be picked (boundary-first ordering), got: ${pickedIds}`
    );
    assert(
        pickedIds.includes('slot-137'),
        `boundary slot-137 must be picked (boundary-first ordering), got: ${pickedIds}`
    );

    // Re-derived sizes must be real and placeable.
    for (const p of picked) {
        assert(
            Number(p.size) >= effectiveMin,
            `picked slot ${p.id} must carry a re-derived size >= effectiveMin (${effectiveMin}), got ${p.size}`
        );
        assert.notStrictEqual(Number(p.size), 0, `picked slot ${p.id} must not remain size 0`);
    }

    // No gap-band (spread) slots may be picked.
    const gapBand = /slot-1(3[2-5])/.test(pickedIds);
    assert.strictEqual(gapBand, false, `gap-band slots must not be picked, got: ${pickedIds}`);

    console.log(`✓ COW-BOUNDARY-001 passed (picked: ${pickedIds}; sizes: ${picked.map((p: any) => p.size).join(',')})`);
}

async function testBudgetDerivationCreatesBoundarySlot() {
    console.log('\n[COW-BOUNDARY-002] _reconcileStartupSide plans a CREATE for the boundary slot with the re-derived size...');

    const sellSlots = [];
    for (let i = 136; i <= 138; i++) {
        sellSlots.push(makeSpread(`slot-${i}`));
    }
    for (let i = 139; i <= 155; i++) {
        sellSlots.push(makeSell(`slot-${i}`, { state: ORDER_STATES.ACTIVE, size: 3.3, orderId: `1.7.${i}` }));
    }
    const buySlots = [];
    for (let i = 128; i <= 131; i++) {
        buySlots.push(makeBuy(`slot-${i}`, { size: 3575 }));
    }
    const spreadSlots = [132, 133, 134, 135].map((i) => makeSpread(`slot-${i}`));

    const funds = {
        allocatedBuy: 140000,
        allocatedSell: 70,
        chainFreeBuy: 140000,
        chainFreeSell: 70,
        btsBalance: { free: 500 },
    };
    const manager = buildManager({ boundaryIdx: 131, gapSlots: 4, sellSlots, buySlots, spreadSlots, funds });
    manager.accountTotals.sellFree = 70;

    // Need 3 more sells to reach target 20 (17 active). Boundary slots 136-138 are the holes.
    assert.strictEqual(_countActiveOnGrid(manager, ORDER_TYPES.SELL), 17, 'fixture should start with 17 active sells');

    const plannedCreates: any[] = [];
    const plannedUpdates: any[] = [];
    const plannedCancels: any[] = [];

    await _reconcileStartupSide({
        orderType: ORDER_TYPES.SELL,
        targetCount: 20,
        chainSideOrders: [],
        unmatchedSideOrders: [],
        manager,
        chainOrders: {},
        account: 'acct',
        privateKey: 'pk',
        dryRun: true,
        plannedCreates,
        plannedUpdates,
        plannedCancels,
        planOnly: true,
    });

    const boundaryCreates = plannedCreates.filter((c: any) =>
        /slot-1(3[6-8])/.test(c.gridOrder?.id)
    );
    assert(
        boundaryCreates.length > 0,
        `expected a boundary-adjacent CREATE, got creates: ${plannedCreates.map((c: any) => c.gridOrder?.id).join(',')}`
    );
    assert(
        boundaryCreates.some((c: any) => c.gridOrder.id === 'slot-136'),
        `slot-136 must be the first boundary create, got: ${boundaryCreates.map((c: any) => c.gridOrder.id).join(',')}`
    );

    const effectiveMin = 50 * Math.pow(10, -5);
    for (const c of boundaryCreates) {
        assert(
            Number(c.gridOrder.size) >= effectiveMin,
            `boundary create ${c.gridOrder.id} must use a re-derived size >= effectiveMin (${effectiveMin}), got ${c.gridOrder.size}`
        );
    }

    console.log(`✓ COW-BOUNDARY-002 passed (boundary creates: ${boundaryCreates.map((c: any) => c.gridOrder.id).join(',')})`);
}

async function testLegacyFallbackWithoutBudget() {
    console.log('\n[COW-BOUNDARY-003] no funds snapshot → legacy behavior preserved (size-0 slots stay unpickable)...');

    const sellSlots = [];
    for (let i = 136; i <= 138; i++) {
        sellSlots.push(makeSpread(`slot-${i}`));
    }
    for (let i = 139; i <= 155; i++) {
        sellSlots.push(makeSell(`slot-${i}`, { state: ORDER_STATES.ACTIVE, size: 3.3, orderId: `1.7.${i}` }));
    }
    for (let i = 156; i <= 158; i++) {
        sellSlots.push(makeSell(`slot-${i}`, { size: 3.2 }));
    }
    const buySlots = [];
    for (let i = 128; i <= 131; i++) {
        buySlots.push(makeBuy(`slot-${i}`, { size: 3575 }));
    }
    const spreadSlots = [132, 133, 134, 135].map((i) => makeSpread(`slot-${i}`));

    // No getChainFundsSnapshot → re-derivation unavailable.
    const manager = buildManager({ boundaryIdx: 131, gapSlots: 4, sellSlots, buySlots, spreadSlots });

    const picked = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.SELL, 3);

    // Boundary zeroed holes must remain unpickable (stored size 0 < effectiveMin),
    // and far-end stored-size virtuals are picked as before.
    const pickedIds = picked.map((p: any) => p.id).join(' ');
    assert(
        !pickedIds.includes('slot-136') && !pickedIds.includes('slot-137') && !pickedIds.includes('slot-138'),
        `without a fund snapshot, zeroed boundary slots must stay unpickable, got: ${pickedIds}`
    );
    assert(
        pickedIds.includes('slot-156'),
        `without a fund snapshot, far-end stored-size virtuals are the fallback, got: ${pickedIds}`
    );

    console.log(`✓ COW-BOUNDARY-003 passed (fallback picked: ${pickedIds})`);
}

async function run() {
    await testBoundaryZeroedSlotsArePicked();
    await testBudgetDerivationCreatesBoundarySlot();
    await testLegacyFallbackWithoutBudget();
    console.log('\nAll COW boundary-slot replacement tests passed.');
}

run().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});
