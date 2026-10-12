/**
 * Vacated-rail refill test suite (Phase 4, vacate+create atomic) — VRR-1..7.
 *
 * Incident class: a startup reconcile re-map UPDATE points an unmatched
 * chain order onto a chosen rail slot, vacating the price level the order
 * was created for. When the vacated price EXACTLY matches an empty rail
 * slot of the same side, the reconcile pass must queue a refill CREATE in
 * the same plan so the level does not linger as a hole. Ghost levels
 * (price matches no current slot), in-band vacates, insufficient-balance
 * skips, and already-desired slots must NOT produce a refill.
 *
 * Synthetic geometry: boundary 141, gap 4 (sellStart 146). No real pair names.
 */

const assert = require('assert');
const { _reconcileStartupSide } = require('../modules/order/grid_reconcile_internal');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { _setFeeCache } = require('../modules/order/utils/math');

_setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 }
    }
});

const BOUNDARY = 141;
const GAP = 4;

function slot(id, type, state, price, size, orderId = null) {
    return { id, type, state, price, size, orderId, rawOnChain: orderId ? {} : null };
}

function chainSell(id, price, size) {
    const scale = Math.pow(10, 5);
    return {
        id,
        sell_price: {
            base: { amount: Math.round(size * scale), asset_id: '1.3.1' },
            quote: { amount: Math.round(price * size * scale), asset_id: '1.3.0' },
        },
        for_sale: Math.round(size * scale),
    };
}

function createManager(overrides: any = {}) {
    const orders = new Map();
    return {
        orders,
        logger: { log: () => {} },
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'AAA' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BBB' },
        },
        accountTotals: { sellFree: 0, buyFree: 0 },
        boundaryIdx: BOUNDARY,
        _gapSlots: GAP,
        config: { coreOrders: { buy: 20, sell: 20 }, assetA: 'AAA', assetB: 'BBB' },
        _gridLock: { acquire: async (fn: any) => await fn() },
        getOrdersByTypeAndState: (type: any, state: any) =>
            Array.from(orders.values()).filter((o: any) => o && o.type === type && o.state === state),
        ...overrides,
    };
}

async function runSide(manager: any, chainOrder: any) {
    const plannedCreates: any[] = [];
    const plannedUpdates: any[] = [];
    const plannedCancels: any[] = [];
    const result = await _reconcileStartupSide({
        orderType: ORDER_TYPES.SELL,
        targetCount: 2,
        chainSideOrders: [chainOrder],
        unmatchedSideOrders: [chainOrder],
        manager,
        chainOrders: {},
        account: 'acct',
        privateKey: 'pk',
        dryRun: false,
        plannedCreates,
        plannedUpdates,
        plannedCancels,
        planOnly: false,
    });
    return { plannedCreates, plannedUpdates, plannedCancels, result };
}

async function testVRR1_RefillPlannedForVacatedRailSlot() {
    console.log('\n[VRR-1] Re-map onto slot-147 vacates exact-price slot-148 -> refill create queued...');
    const manager = createManager();
    // slot-146 matched on grid; empties 147 (@100) and 148 (@101) both sized.
    manager.orders.set('slot-146', slot('slot-146', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 99, 10, '1.7.146'));
    manager.orders.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 100, 10));
    manager.orders.set('slot-148', slot('slot-148', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 101, 10));
    // Unmatched chain order sits exactly at slot-148's price; desired slot
    // selection (ascending) picks 147, so the re-map vacates 101 = slot-148.
    const chain = chainSell('1.7.100', 101, 10);
    const { plannedCreates, plannedUpdates } = await runSide(manager, chain);
    assert.strictEqual(plannedUpdates.length, 1, 're-map update planned');
    assert.strictEqual(plannedUpdates[0].gridOrderId, 'slot-147');
    assert.strictEqual(plannedCreates.length, 1, `exactly one refill create, got ${JSON.stringify(plannedCreates)}`);
    assert.strictEqual(plannedCreates[0].gridOrder.id, 'slot-148', 'refill targets the vacated rail slot');
    assert.strictEqual(plannedCreates[0].recovery.source, 'startupVacatedRailRefill', 'refill create carries the vacate source');
    console.log('✓ VRR-1 passed');
}

async function testVRR2_SkippedUpdateVacatesNothing() {
    console.log('\n[VRR-2] Insufficient-balance update skip must NOT queue a refill...');
    const manager = createManager();
    manager.orders.set('slot-146', slot('slot-146', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 99, 10, '1.7.146'));
    manager.orders.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 100, 10));
    manager.orders.set('slot-148', slot('slot-148', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 101, 10));
    // Chain order smaller than the grid size -> sizeIncrease > 0 with zero
    // free balance -> the update is skipped; the chain order stays at 101,
    // so nothing is vacated and a refill would double-place the level.
    const chain = chainSell('1.7.100', 101, 5);
    const { plannedCreates, plannedUpdates } = await runSide(manager, chain);
    assert.strictEqual(plannedUpdates.length, 0, 'update skipped for insufficient balance');
    assert.strictEqual(plannedCreates.length, 0, 'skipped update must not queue a refill');
    console.log('✓ VRR-2 passed');
}

async function testVRR3_GhostPriceGetsNoRefill() {
    console.log('\n[VRR-3] Ghost vacated price (matches no current slot) gets no refill...');
    const manager = createManager();
    manager.orders.set('slot-146', slot('slot-146', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 99, 10, '1.7.146'));
    manager.orders.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 100, 10));
    // Chain order at a price that belongs to no slot (post-shift ghost).
    const chain = chainSell('1.7.100', 100.5, 10);
    const { plannedCreates, plannedUpdates } = await runSide(manager, chain);
    assert.strictEqual(plannedUpdates.length, 1, 're-map onto slot-147 proceeds');
    assert.strictEqual(plannedCreates.length, 0, 'ghost levels are not re-created (lattice moved)');
    console.log('✓ VRR-3 passed');
}

async function testVRR4_InBandVacateGetsNoRefill() {
    console.log('\n[VRR-4] In-band vacated slot (gap-band geometry) gets no refill...');
    const manager = createManager();
    manager.orders.set('slot-146', slot('slot-146', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 99, 10, '1.7.146'));
    manager.orders.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 100, 10));
    // slot-143 sits inside the gap band (141 < 143 < 146): band holes are
    // SPREAD semantics — the evacuation/adoption paths own them, not refill.
    manager.orders.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 98.5, 10));
    const chain = chainSell('1.7.100', 98.5, 10);
    const { plannedCreates, plannedUpdates } = await runSide(manager, chain);
    assert.strictEqual(plannedUpdates.length, 1, 're-map onto slot-147 proceeds');
    assert.strictEqual(plannedUpdates[0].gridOrderId, 'slot-147', 'pin the re-map target: lowest-price empty rail slot');
    assert.strictEqual(plannedCreates.length, 0, 'in-band vacates must not be refilled as rail orders');
    console.log('✓ VRR-4 passed');
}

async function testVRR5_VacatedSlotAlreadyDesiredGetsNoDouble() {
    console.log('\n[VRR-5] Vacated slot already picked for activation is not double-filled...');
    // Two slots needed (targetCount 3): desired = [147, 148]; the re-map
    // vacates 101 = slot-148, which is already queued for the generic
    // create path — a refill would double-place it.
    const manager = createManager();
    manager.orders.set('slot-146', slot('slot-146', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 99, 10, '1.7.146'));
    manager.orders.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 100, 10));
    manager.orders.set('slot-148', slot('slot-148', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 101, 10));
    const plannedCreates: any[] = [];
    const plannedUpdates: any[] = [];
    const plannedCancels: any[] = [];
    await _reconcileStartupSide({
        orderType: ORDER_TYPES.SELL,
        targetCount: 3,
        chainSideOrders: [chainSell('1.7.100', 101, 10)],
        unmatchedSideOrders: [chainSell('1.7.100', 101, 10)],
        manager,
        chainOrders: {},
        account: 'acct',
        privateKey: 'pk',
        dryRun: false,
        plannedCreates,
        plannedUpdates,
        plannedCancels,
        planOnly: false,
    });
    assert.strictEqual(plannedUpdates.length, 1, 're-map onto slot-147 planned');
    const refillCreates = plannedCreates.filter((c: any) => c.recovery?.source === 'startupVacatedRailRefill');
    assert.strictEqual(refillCreates.length, 0, 'no refill create for a slot the generic path already fills');
    assert.strictEqual(plannedCreates.length, 1, 'exactly the generic create remains');
    assert.strictEqual(plannedCreates[0].gridOrder.id, 'slot-148');
    console.log('✓ VRR-5 passed');
}

async function testVRR6_CancelInFlightSlotStaysMatched() {
    console.log('\n[VRR-6] Cancel-in-flight slot (ACTIVE + orderId) stays matched — no re-map, no refill...');
    const manager = createManager();
    manager.orders.set('slot-146', slot('slot-146', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 99, 10, '1.7.146'));
    manager.orders.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 100, 10));
    // slot-148: ACTIVE with an orderId whose cancel is still in flight — the
    // level is occupied, so the chain order at 101 must NOT trigger a re-map
    // onto slot-147 plus a refill CREATE (that would double-place 101).
    // Reachable mechanics: _countActiveOnGrid counts slot-148 (ACTIVE with
    // orderId) → matchedOnGrid=2 → neededSlots=0 → no re-map → the refill
    // scan never runs.
    manager.orders.set('slot-148', slot('slot-148', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 101, 10, '1.7.148'));
    const chain = chainSell('1.7.100', 101, 10);
    const { plannedCreates, plannedUpdates } = await runSide(manager, chain);
    assert.strictEqual(plannedUpdates.length, 0, 'level still occupied → no re-map');
    const refillCreates = plannedCreates.filter((c: any) => c.recovery?.source === 'startupVacatedRailRefill');
    assert.strictEqual(refillCreates.length, 0, 'no startupVacatedRailRefill create (no double-place at 101)');
    console.log('✓ VRR-6 passed');
}

async function testVRR7_PhantomOrderIdNotRefilled() {
    console.log('\n[VRR-7] VIRTUAL slot with stale orderId (phantom) is not a refill target...');
    const manager = createManager();
    manager.orders.set('slot-146', slot('slot-146', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 99, 10, '1.7.146'));
    manager.orders.set('slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 100, 10));
    // VIRTUAL with a stale orderId: isOrderPlaced is false for VIRTUAL state,
    // so the phantom must be excluded by an explicit orderId check.
    manager.orders.set('slot-148', slot('slot-148', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 101, 10, '1.7.999'));
    const chain = chainSell('1.7.100', 101, 10);
    const { plannedCreates, plannedUpdates } = await runSide(manager, chain);
    assert.strictEqual(plannedUpdates.length, 1, 're-map onto slot-147 proceeds');
    assert.strictEqual(plannedCreates.length, 0, 'phantom VIRTUAL+orderId slot must not be refilled');
    console.log('✓ VRR-7 passed');
}

async function runAllTests() {
    console.log('=== Vacated-Rail Refill Test Suite ===\n');
    await testVRR1_RefillPlannedForVacatedRailSlot();
    await testVRR2_SkippedUpdateVacatesNothing();
    await testVRR3_GhostPriceGetsNoRefill();
    await testVRR4_InBandVacateGetsNoRefill();
    await testVRR5_VacatedSlotAlreadyDesiredGetsNoDouble();
    await testVRR6_CancelInFlightSlotStaysMatched();
    await testVRR7_PhantomOrderIdNotRefilled();
    console.log('\n=== All vacated-rail refill tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });
