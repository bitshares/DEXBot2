/**
 * Gap-evacuation + rail-typed hole test suite (EVAC-001..EVAC-011).
 *
 * Covers the incident-replay batch:
 * - Phase 1: pure isEvacuationRotationAllowed decision (bit-exact size, no
 *   float epsilon; outward repricing only; rail types only).
 * - Phase 2: rail-typed holes (toRailHolePlaceholder, load/assignGridRoles
 *   geometry typing, validateOrder preservation).
 * - Phase 3: geometry-only detection (parse slot idx vs boundary/gapSlots,
 *   never stored type) + in-memory per-slot streak counter + cancel-only
 *   evacuation teeth (queue-once at the cancel threshold, geometry/live-slot
 *   re-verification, marker release on resolve).
 * - Plan-build B-stamp: reconcileGrid stamps gap-evacuation rotations with
 *   the frozen boundary/gapSlots; rail-to-rail rotations stay unstamped.
 * - Incident replay uses synthetic geometry only (boundary 141, sells
 *   143/144/145, holes 147/149/151) — no real pair names.
 */

const assert = require('assert');
const {
    isEvacuationRotationAllowed,
    isEvacuationSizeStillValid,
    isSlotIndexInGapBand,
    getSellStartIdx
} = require('../modules/order/utils/math');
const {
    toRailHolePlaceholder,
    geometryTypeForSlotIndex,
    detectGapEvacuationCandidates,
    updateGapEvacuationStreaks,
    assignGridRoles
} = require('../modules/order/utils/order');
const { reconcileGrid, validateOrder, stampGapEvacuationRotation, optimizeRebalanceActions } = require('../modules/order/utils/validate');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, GRID_LIMITS } = require('../modules/constants');
const { OrderManager } = require('../modules/order/index').default;

// Synthetic incident geometry: boundary 141, gap 2 => sellStart 144.
// Band = {142, 143}; SELL rail starts at 144.
const BOUNDARY = 141;
const GAP_SLOTS = 2;

function slot(id, type, state, price, size, orderId = null) {
    return { id, type, state, price, size, orderId, rawOnChain: orderId ? {} : null };
}

// Padded synthetic grid: reconcileGrid clamps the target boundary into
// [0, gridSize-1], so the grid must be larger than the incident boundary
// (141). Fillers are empty VIRTUAL holes; overrides carry the scenario.
function paddedGrid(overrides) {
    const grid = new Map();
    for (let i = 0; i < 160; i++) {
        const id = `slot-${i}`;
        const price = 800 + i;
        const type = i <= BOUNDARY ? ORDER_TYPES.BUY : (i >= getSellStartIdx(BOUNDARY, GAP_SLOTS) ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        grid.set(id, slot(id, type, ORDER_STATES.VIRTUAL, price, 0));
    }
    for (const [id, order] of overrides) grid.set(id, order);
    return grid;
}

// Lightweight manager for teeth tests (same construction as test_manager_logic).
const { _setFeeCache } = require('../modules/order/utils/math');
_setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 }
    }
});

async function createEvacManager() {
    const mgr = new OrderManager({
        market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
        activeOrders: { buy: 5, sell: 5 }
    });
    mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    return mgr;
}

async function testEVAC001_AllowsSellOutwardNonGrowing() {
    console.log('\n[EVAC-001] Helper allows SELL evacuation (outward, same size)...');
    const r = isEvacuationRotationAllowed(950, 100, 960, 100, ORDER_TYPES.SELL);
    assert.strictEqual(r.allowed, true, `expected allow, got ${r.reason}`);
    console.log('✓ EVAC-001 passed');
}

async function testEVAC002_BlocksSellTowardGap() {
    console.log('\n[EVAC-002] Helper blocks SELL repricing toward the gap...');
    const r = isEvacuationRotationAllowed(960, 100, 950, 100, ORDER_TYPES.SELL);
    assert.strictEqual(r.allowed, false, 'inward SELL repricing must not bypass');
    assert.ok(/gap/i.test(r.reason), `reason should name the gap, got: ${r.reason}`);
    console.log('✓ EVAC-002 passed');
}

async function testEVAC003_AllowsBuyOutwardShrinking() {
    console.log('\n[EVAC-003] Helper allows BUY evacuation (outward, shrinking)...');
    const r = isEvacuationRotationAllowed(100, 100, 99, 60, ORDER_TYPES.BUY);
    assert.strictEqual(r.allowed, true, `expected allow, got ${r.reason}`);
    const inward = isEvacuationRotationAllowed(99, 100, 100, 100, ORDER_TYPES.BUY);
    assert.strictEqual(inward.allowed, false, 'inward BUY repricing must not bypass');
    console.log('✓ EVAC-003 passed');
}

async function testEVAC004_BitExactSizeNoEpsilon() {
    console.log('\n[EVAC-004] Size is bit-exact (blockchain ints), never float epsilon...');
    // Quantum trap at precision 5: floats differ by 1e-6 but land in adjacent
    // quanta — growth must block even though the floats look "almost equal".
    const grew = isEvacuationRotationAllowed(950, 10.000004, 960, 10.000005, ORDER_TYPES.SELL, 5);
    assert.strictEqual(grew.allowed, false, 'quantum growth must block');
    // Same quantum: int-equal sizes allow (no epsilon tuning involved).
    const sameQuantum = isEvacuationRotationAllowed(950, 10.0000049, 960, 10.0000048, ORDER_TYPES.SELL, 5);
    assert.strictEqual(sameQuantum.allowed, true, `same-quantum shrink must allow, got ${sameQuantum.reason}`);
    // Non-rail types never qualify (CREATEs carry no source slot).
    const spread = isEvacuationRotationAllowed(950, 100, 960, 100, ORDER_TYPES.SPREAD);
    assert.strictEqual(spread.allowed, false, 'SPREAD must never qualify');
    // Unresolvable inputs fail closed.
    assert.strictEqual(isEvacuationRotationAllowed(null, 100, 960, 100, ORDER_TYPES.SELL).allowed, false);
    assert.strictEqual(isEvacuationRotationAllowed(950, 0, 960, 100, ORDER_TYPES.SELL).allowed, false);
    assert.strictEqual(isEvacuationRotationAllowed(950, 100, 960, 0, ORDER_TYPES.SELL).allowed, false);
    console.log('✓ EVAC-004 passed');
}

async function testEVAC005_GeometryTyping() {
    console.log('\n[EVAC-005] Geometry typing at boundary 141 / gap 2...');
    assert.strictEqual(getSellStartIdx(BOUNDARY, GAP_SLOTS), 144);
    assert.strictEqual(geometryTypeForSlotIndex(141, BOUNDARY, GAP_SLOTS), ORDER_TYPES.BUY);
    assert.strictEqual(geometryTypeForSlotIndex(142, BOUNDARY, GAP_SLOTS), ORDER_TYPES.SPREAD);
    assert.strictEqual(geometryTypeForSlotIndex(143, BOUNDARY, GAP_SLOTS), ORDER_TYPES.SPREAD);
    assert.strictEqual(geometryTypeForSlotIndex(144, BOUNDARY, GAP_SLOTS), ORDER_TYPES.SELL);
    assert.strictEqual(isSlotIndexInGapBand(143, BOUNDARY, GAP_SLOTS), true);
    assert.strictEqual(isSlotIndexInGapBand(141, BOUNDARY, GAP_SLOTS), false);
    assert.strictEqual(isSlotIndexInGapBand(144, BOUNDARY, GAP_SLOTS), false);
    assert.strictEqual(geometryTypeForSlotIndex(null, BOUNDARY, GAP_SLOTS), null, 'unusable index fails closed');
    assert.strictEqual(geometryTypeForSlotIndex(BOUNDARY, null, GAP_SLOTS), null, 'null boundary fails closed');
    // Unknown gap width must fail closed too: Number(null)/Number('') === 0
    // would collapse the gap band and misclassify in-band slot 142 as a rail
    // slot instead of SPREAD.
    assert.strictEqual(geometryTypeForSlotIndex(142, BOUNDARY, null), null, 'null gap fails closed');
    assert.strictEqual(geometryTypeForSlotIndex(142, BOUNDARY, ''), null, "'' gap fails closed");
    assert.strictEqual(geometryTypeForSlotIndex(142, BOUNDARY, undefined), null, 'undefined gap fails closed');
    assert.strictEqual(geometryTypeForSlotIndex(BOUNDARY, BOUNDARY, 0), ORDER_TYPES.BUY, 'genuine gap 0 still types');
    console.log('✓ EVAC-005 passed');
}

async function testEVAC006_RailHolePlaceholder() {
    console.log('\n[EVAC-006] toRailHolePlaceholder keeps rail type + booked size...');
    const src = slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 960, 80, '1.7.1');
    const hole = toRailHolePlaceholder(src, ORDER_TYPES.SELL);
    assert.strictEqual(hole.type, ORDER_TYPES.SELL);
    assert.strictEqual(hole.size, 80, 'booked size must survive');
    assert.strictEqual(hole.state, ORDER_STATES.VIRTUAL);
    assert.strictEqual(hole.orderId, null);
    assert.strictEqual(hole.rawOnChain, null);
    const emptied = toRailHolePlaceholder(src, ORDER_TYPES.SELL, 0);
    assert.strictEqual(emptied.size, 0);
    assert.strictEqual(emptied.type, ORDER_TYPES.SELL);
    console.log('✓ EVAC-006 passed');
}

async function testEVAC007_GeometryOnlyDetection() {
    console.log('\n[EVAC-007] Detection is geometry-only (rail-typed stray still found)...');
    const master = new Map([
        // Below boundary 0's fake band (idx 1..2): makes the null-boundary
        // assertion non-vacuous — Number(null) === 0 would select it.
        ['slot-1', slot('slot-1', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 100, 10, '1.7.1')],
        // In-band stray typed SELL (Phase 2 retype) — type-based detection
        // would miss it; geometry must still flag it.
        ['slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143')],
        // In-band stray typed SPREAD (legacy) — also flagged.
        ['slot-142', slot('slot-142', ORDER_TYPES.SPREAD, ORDER_STATES.ACTIVE, 945, 50, '1.7.142')],
        // Rail actives are not candidates.
        ['slot-144', slot('slot-144', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 955, 100, '1.7.144')],
        ['slot-145', slot('slot-145', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 957, 100, '1.7.145')],
        // VIRTUAL holes are not candidates (not on-chain).
        ['slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 960, 0)],
        // Unparseable ids are skipped, never crash.
        ['planned', slot('planned', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 900, 10, '1.7.9')],
    ]);
    const cands = detectGapEvacuationCandidates(master, BOUNDARY, GAP_SLOTS);
    const ids = cands.map((c: any) => c.id).sort();
    assert.deepStrictEqual(ids, ['slot-142', 'slot-143'], `only in-band on-chain slots, got ${ids}`);
    // Null/'' boundary/gap fails closed (no candidates, no throw). The
    // Number(null)===0 / Number('')===0 trap must not select slot 1..2.
    assert.deepStrictEqual(detectGapEvacuationCandidates(master, null, GAP_SLOTS), [], 'null boundary fails closed');
    assert.deepStrictEqual(detectGapEvacuationCandidates(master, '', GAP_SLOTS), [], "'' boundary fails closed");
    assert.deepStrictEqual(detectGapEvacuationCandidates(master, BOUNDARY, null), [], 'null gapSlots fails closed');
    assert.deepStrictEqual(detectGapEvacuationCandidates(master, BOUNDARY, ''), [], "'' gapSlots fails closed");
    console.log('✓ EVAC-007 passed');
}

async function testEVAC008_StreakCounter() {
    console.log('\n[EVAC-008] Per-slot streak counter (in-memory, resets on resolve)...');
    const streaks = new Map();
    const cands = [{ id: 'slot-143' }, { id: 'slot-142' }];
    let tick = updateGapEvacuationStreaks(streaks, cands, 2);
    assert.deepStrictEqual(tick.streaks, { 'slot-143': 1, 'slot-142': 1 });
    assert.deepStrictEqual(tick.ready, [], 'threshold 2 needs two consecutive cycles');
    tick = updateGapEvacuationStreaks(streaks, [{ id: 'slot-143' }], 2);
    assert.deepStrictEqual(tick.streaks, { 'slot-143': 2 }, 'resolved slot drops out');
    assert.strictEqual(tick.ready.length, 1, 'stuck slot surfaces as ready');
    assert.strictEqual(tick.ready[0].id, 'slot-143');
    tick = updateGapEvacuationStreaks(streaks, [], 2);
    assert.deepStrictEqual(tick.streaks, {}, 'empty scan clears all streaks');
    console.log('✓ EVAC-008 passed');
}

async function testEVAC009_ReconcileStampsEvacuation() {
    console.log('\n[EVAC-009] reconcileGrid stamps gap-evacuation with frozen B-stamp...');
    const master = paddedGrid([
        ['slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143')],
        ['slot-144', slot('slot-144', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 955, 100, '1.7.144')],
    ]);
    const target = paddedGrid([
        ['slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 950, 0)],
        ['slot-144', slot('slot-144', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 955, 100, '1.7.144')],
        // slot-147 hole: empty in master, ACTIVE target with size.
        ['slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 960, 100)],
    ]);
    const streaks = new Map();
    const res = reconcileGrid(master, target, BOUNDARY, {
        logger: () => {},
        gapSlots: GAP_SLOTS,
        evacStreaks: streaks
    });
    const rotations = res.actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId && a.newGridId !== a.id);
    assert.strictEqual(rotations.length, 1, `expected one rotation, got ${JSON.stringify(res.actions)}`);
    const rot = rotations[0];
    assert.strictEqual(rot.id, 'slot-143');
    assert.strictEqual(rot.newGridId, 'slot-147');
    assert.strictEqual(rot.origin, 'gap-evacuation', 'in-band surplus -> rail hole must stamp');
    assert.strictEqual(rot.evacBoundary, BOUNDARY, 'B-stamp freezes the plan-build boundary');
    assert.strictEqual(rot.evacGapSlots, GAP_SLOTS, 'B-stamp freezes the plan-build gap width');
    assert.ok(streaks.get('slot-143') >= 1, 'streak ticks for the in-band slot');
    console.log('✓ EVAC-009 passed');
}

async function testEVAC010_RailToRailUnstamped() {
    console.log('\n[EVAC-010] Rail-to-rail rotations stay unstamped (guarded default)...');
    const master = paddedGrid([
        ['slot-145', slot('slot-145', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 957, 100, '1.7.145')],
    ]);
    const target = paddedGrid([
        ['slot-145', slot('slot-145', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 957, 0)],
        ['slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 960, 100)],
    ]);
    const res = reconcileGrid(master, target, BOUNDARY, { logger: () => {}, gapSlots: GAP_SLOTS });
    const rotations = res.actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId && a.newGridId !== a.id);
    assert.strictEqual(rotations.length, 1);
    assert.strictEqual(rotations[0].origin, undefined, 'rail source must not claim evacuation');
    // And without geometry options, even in-band rotations stay unstamped.
    const masterB = paddedGrid([
        ['slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143')],
    ]);
    const targetB = paddedGrid([
        ['slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 950, 0)],
        ['slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 960, 100)],
    ]);
    const resB = reconcileGrid(masterB, targetB, BOUNDARY, { logger: () => {} });
    const rotB = resB.actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId !== a.id);
    assert.strictEqual(rotB.length, 1);
    assert.strictEqual(rotB[0].origin, undefined, 'missing B-stamp inputs must fail closed to guarded');
    console.log('✓ EVAC-010 passed');
}

async function testEVAC011_RailHoleSurvivesValidationAndRoles() {
    console.log('\n[EVAC-011] Rail holes survive validateOrder + assignGridRoles...');
    // Sized SELL VIRTUAL hole: valid, size untouched (only SPREAD normalizes).
    const hole = slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 960, 80);
    const v = validateOrder(hole, null, 'evac-test');
    assert.strictEqual(v.isValid, true, `rail hole must validate: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(v.normalizedOrder.size, 80, 'rail hole size must not normalize to 0');
    assert.strictEqual(v.normalizedOrder.type, ORDER_TYPES.SELL);
    // assignGridRoles (non-assignOnChain): empty in-rail hole keeps rail
    // type; empty band slot becomes SPREAD.
    const slots = [
        slot('slot-145', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 957, 0),
        slot('slot-143', ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL, 950, 0),
        slot('slot-141', ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, 940, 0),
    ];
    const typed = assignGridRoles(slots, BOUNDARY, GAP_SLOTS, ORDER_TYPES, ORDER_STATES);
    const byId: any = {};
    for (const s of typed) byId[s.id] = s.type;
    assert.strictEqual(byId['slot-145'], ORDER_TYPES.SELL, 'in-rail hole keeps rail type');
    assert.strictEqual(byId['slot-143'], ORDER_TYPES.SPREAD, 'band slot stays SPREAD');
    assert.strictEqual(byId['slot-141'], ORDER_TYPES.BUY, 'buy-rail hole keeps rail type');
    console.log('✓ EVAC-011 passed');
}

async function testEVAC012_TeethHoldBelowCancelThreshold() {
    console.log('\n[EVAC-012] Teeth hold below the cancel threshold (warn-only zone)...');
    const mgr = await createEvacManager();
    mgr.boundaryIdx = BOUNDARY;
    mgr._gapSlots = GAP_SLOTS;
    mgr.orders.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143'));
    mgr._gapEvacStreaks.set('slot-143', Number(GRID_LIMITS.GAP_EVACUATION_CANCEL_THRESHOLD) - 1);
    const queued = mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]);
    assert.strictEqual(queued, 0, 'streak below cancel threshold must not queue');
    assert.strictEqual(mgr.ordersNeedingPriceCorrection.length, 0);
    console.log('✓ EVAC-012 passed');
}

async function testEVAC013_TeethQueueOnceAtThreshold() {
    console.log('\n[EVAC-013] Teeth queue a cancel-only correction once at the threshold...');
    const mgr = await createEvacManager();
    mgr.boundaryIdx = BOUNDARY;
    mgr._gapSlots = GAP_SLOTS;
    mgr.orders.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143'));
    mgr._gapEvacStreaks.set('slot-143', Number(GRID_LIMITS.GAP_EVACUATION_CANCEL_THRESHOLD));
    const queued = mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143', price: 950 }]);
    assert.strictEqual(queued, 1, 'threshold crossing must queue exactly one correction');
    const entry = mgr.ordersNeedingPriceCorrection[0];
    assert.strictEqual(entry.chainOrderId, '1.7.143');
    assert.strictEqual(entry.isSurplus, true, 'surplus semantics: cancel + settle slot to SPREAD placeholder');
    assert.strictEqual(entry.gapEvacuation, true, 'entry carries the gap-evacuation reason');
    assert.strictEqual(entry.gridOrder.id, 'slot-143', 'gridOrder must be the live slot copy');
    // Queued-once: a repeat call must not duplicate (marker + dedup).
    const queuedAgain = mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143', price: 950 }]);
    assert.strictEqual(queuedAgain, 0, 'queued-once guard must prevent re-queueing');
    assert.strictEqual(mgr.ordersNeedingPriceCorrection.length, 1, 'no duplicate correction entries');
    console.log('✓ EVAC-013 passed');
}

async function testEVAC014_TeethRecheckGeometryAndLiveSlot() {
    console.log('\n[EVAC-014] Teeth re-verify CURRENT geometry + live slot before queuing...');
    const mgr = await createEvacManager();
    mgr.boundaryIdx = BOUNDARY;
    mgr._gapSlots = GAP_SLOTS;
    mgr._gapEvacStreaks.set('slot-143', 10);
    // Boundary moved up: slot-143 is now BUY-rail geometry — not in-band anymore.
    mgr.boundaryIdx = 144;
    let queued = mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]);
    assert.strictEqual(queued, 0, 'stale plan geometry must not queue: re-check against committed boundary');
    // Restore boundary; slot vanished from the master grid (cancelled mid-flight).
    mgr.boundaryIdx = BOUNDARY;
    queued = mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]);
    assert.strictEqual(queued, 0, 'missing live slot must skip');
    // Live slot exists but was replaced with a different chain order id.
    mgr.orders.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.999'));
    queued = mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]);
    assert.strictEqual(queued, 0, 'chain-order ownership mismatch must skip');
    assert.strictEqual(mgr.ordersNeedingPriceCorrection.length, 0, 'nothing queued in any skip case');
    console.log('✓ EVAC-014 passed');
}

async function testEVAC015_TeethMarkerReleasesOnResolve() {
    console.log('\n[EVAC-015] Queued-once marker releases when the slot resolves...');
    const mgr = await createEvacManager();
    mgr.boundaryIdx = BOUNDARY;
    mgr._gapSlots = GAP_SLOTS;
    const thr = Number(GRID_LIMITS.GAP_EVACUATION_CANCEL_THRESHOLD);
    mgr.orders.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143'));
    mgr._gapEvacStreaks.set('slot-143', thr);
    assert.strictEqual(mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]), 1);
    // Slot resolves (runner executed the cancel: entry consumed from the
    // corrections queue, streak entry dropped by the next tick).
    mgr._gapEvacStreaks.delete('slot-143');
    mgr.ordersNeedingPriceCorrection = mgr.ordersNeedingPriceCorrection.filter(
        (e: any) => e.chainOrderId !== '1.7.143'
    );
    assert.strictEqual(mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]), 0,
        'resolved slot must not re-queue');
    assert.strictEqual(mgr._gapEvacCancelQueued.size, 0, 'marker must be released on resolve');
    // A future return to the band re-queues (marker is free).
    mgr.orders.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143'));
    mgr._gapEvacStreaks.set('slot-143', thr);
    assert.strictEqual(mgr._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]), 1,
        'returning to the band must be actionable again');
    // A foreign correction entry for the same chain order blocks duplicates
    // without consuming the marker.
    const mgr2 = await createEvacManager();
    mgr2.boundaryIdx = BOUNDARY;
    mgr2._gapSlots = GAP_SLOTS;
    mgr2.orders.set('slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143'));
    mgr2._gapEvacStreaks.set('slot-143', thr);
    mgr2.ordersNeedingPriceCorrection.push({ chainOrderId: '1.7.143', isSurplus: true });
    assert.strictEqual(mgr2._processGapEvacuationTeeth([{ id: 'slot-143', orderId: '1.7.143' }]), 0,
        'existing correction for the chain order must not duplicate');
    console.log('✓ EVAC-015 passed');
}

async function testEVAC016_StampStillValidFreshGeometry() {
    console.log('\n[EVAC-016] Stamped bypass survives when live geometry matches the stamp...');
    const { isEvacuationStampStillValid } = require('../modules/dexbot_cow_runtime');
    // Source 143 in band (142..145), dest 147 rail (>= 146): stamp valid.
    assert.strictEqual(isEvacuationStampStillValid(BOUNDARY, GAP_SLOTS, 'slot-143', 'slot-147', ORDER_TYPES.SELL), true);
    // Boundary shift that KEEPS the evacuation legal keeps the bypass:
    // live boundary 142 -> sellStart 145 -> band 143..144 (143 in-band),
    // dest 147 >= 145 rail.
    assert.strictEqual(isEvacuationStampStillValid(142, GAP_SLOTS, 'slot-143', 'slot-147', ORDER_TYPES.SELL), true);
    // Unparseable ids fail closed (re-prove live rather than bypass blind).
    assert.strictEqual(isEvacuationStampStillValid(BOUNDARY, GAP_SLOTS, 'planned', 'slot-147', ORDER_TYPES.SELL), false);
    // Non-rail types fail closed explicitly (never fall into the BUY branch).
    assert.strictEqual(isEvacuationStampStillValid(BOUNDARY, GAP_SLOTS, 'slot-143', 'slot-147', ORDER_TYPES.SPREAD), false);
    // Unknown live geometry keeps the plan-build stamp (fail-open): null/''
    // must NOT collapse to boundary 0 via Number(null) === 0 and void it.
    assert.strictEqual(isEvacuationStampStillValid(null, GAP_SLOTS, 'slot-143', 'slot-147', ORDER_TYPES.SELL), true, 'null live boundary fail-open');
    assert.strictEqual(isEvacuationStampStillValid(undefined, GAP_SLOTS, 'slot-143', 'slot-147', ORDER_TYPES.SELL), true, 'undefined live boundary fail-open');
    assert.strictEqual(isEvacuationStampStillValid('', GAP_SLOTS, 'slot-143', 'slot-147', ORDER_TYPES.SELL), true, "'' live boundary fail-open");
    assert.strictEqual(isEvacuationStampStillValid(BOUNDARY, null, 'slot-143', 'slot-147', ORDER_TYPES.SELL), true, 'null live gapSlots fail-open');
    console.log('✓ EVAC-016 passed');
}

async function testEVAC017_StampStaleUnderLiveGeometry() {
    console.log('\n[EVAC-017] Stamped bypass downgrades when live geometry moved past the stamp...');
    const { isEvacuationStampStillValid } = require('../modules/dexbot_cow_runtime');
    // Live boundary 144 -> sellStart 149 -> band 145..148: source 143 is no
    // longer in-band AND dest 147 is no longer rail. The stamp is stale and
    // the rotation must be re-proven by the live probe, not bypassed.
    assert.strictEqual(isEvacuationStampStillValid(144, GAP_SLOTS, 'slot-143', 'slot-147', ORDER_TYPES.SELL), false);
    // Dest fell into the widened band while source stayed in it:
    // live boundary 138, gap 6 -> sellStart 145 -> band 139..144 (143 in-band),
    // dest 147 >= 145 rail... widening the band the other way instead:
    // live boundary 141, gap 8 -> sellStart 150 -> band 142..149: dest 147
    // is inside the band -> stale.
    assert.strictEqual(isEvacuationStampStillValid(141, 8, 'slot-143', 'slot-147', ORDER_TYPES.SELL), false);
    // BUY variant: source 143 in band, dest 141 rail (<= 141) is valid.
    assert.strictEqual(isEvacuationStampStillValid(BOUNDARY, GAP_SLOTS, 'slot-143', 'slot-141', ORDER_TYPES.BUY), true);
    // BUY dest that fell into a widened band is stale:
    // live boundary 137, gap 6 -> sellStart 144 -> band 138..143: source 143
    // still in-band but dest 141 is inside the band now.
    assert.strictEqual(isEvacuationStampStillValid(137, 6, 'slot-143', 'slot-141', ORDER_TYPES.BUY), false);
    console.log('✓ EVAC-017 passed');
}

async function testEVAC018_StampUsesPrecisionBitExactSize() {
    console.log('\n[EVAC-018] Stamping threads side precision: bit-exact on-chain size semantics...');
    const assets = { assetA: { precision: 5 }, assetB: { precision: 5 } };
    const baseTarget = (destSize: number) => paddedGrid([
        ['slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 950, 0)],
        ['slot-144', slot('slot-144', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 955, 100, '1.7.144')],
        ['slot-147', slot('slot-147', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 960, destSize)],
    ]);
    const master = paddedGrid([
        ['slot-143', slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143')],
        ['slot-144', slot('slot-144', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 955, 100, '1.7.144')],
    ]);
    const run = (destSize: number, withAssets: boolean) => {
        const res = reconcileGrid(master, baseTarget(destSize), BOUNDARY, {
            logger: () => {},
            gapSlots: GAP_SLOTS,
            evacStreaks: new Map(),
            assets: withAssets ? assets : null
        });
        const rot = res.actions.find((a: any) => a.type === COW_ACTIONS.UPDATE && a.newGridId === 'slot-147');
        return rot?.origin;
    };
    // A full-quantum size growth (100 -> 100.00001 at precision 5) grows the
    // on-chain int: the stamp must refuse it, with or without assets.
    assert.strictEqual(run(100.00001, true), undefined, 'int growth must not stamp (assets present)');
    assert.strictEqual(run(100.00001, false), undefined, 'int growth must not stamp (assets absent, float fallback)');
    // Sub-quantum growth (100 -> 100.000000001) is invisible on chain: the
    // precision-aware int check allows it, consistent with the live probe.
    assert.strictEqual(run(100.000000001, true), 'gap-evacuation', 'sub-quantum delta stamps (int semantics, matches live probe)');
    // Without assets the float fallback is stricter (any growth refused).
    assert.strictEqual(run(100.000000001, false), undefined, 'sub-quantum delta refused under float fallback');
    console.log('✓ EVAC-018 passed');
}

async function testEVAC019_PlanLevelOriginRoutesThroughProof() {
    console.log('\n[EVAC-019] Plan-level gap-evacuation origin must PROVE, never stamp blind...');
    const { buildActionsFromPlan } = require('../modules/dexbot_cow_runtime');
    const bot = {
        manager: {
            orders: new Map(),
            boundaryIdx: BOUNDARY,
            _gapSlots: GAP_SLOTS,
            assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
            logger: { log: () => {} },
        },
    };
    const qualifying = {
        id: 'slot-143', orderId: '1.7.143', newGridId: 'slot-146',
        newPrice: 960, newSize: 100, type: ORDER_TYPES.SELL,
        oldOrder: slot('slot-143', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 950, 100, '1.7.143'),
    };
    const growing = {
        ...qualifying, id: 'slot-144', orderId: '1.7.144', newPrice: 962, newSize: 100.00001,
        oldOrder: slot('slot-144', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 955, 100, '1.7.144'),
    };
    const noSource = { id: 'slot-145', orderId: '1.7.145', newGridId: 'slot-148', newPrice: 964, newSize: 100, type: ORDER_TYPES.SELL };
    const actions = buildActionsFromPlan(bot, {
        origin: 'gap-evacuation', boundaryIdx: BOUNDARY, gapSlots: GAP_SLOTS,
        ordersToRotate: [qualifying, growing, noSource],
    });
    const byId = new Map<string, any>(actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE).map((a: any) => [a.id, a]));
    const ok = byId.get('slot-143');
    assert.strictEqual(ok.origin, 'gap-evacuation', 'proven rotation keeps the plan-level origin');
    assert.strictEqual(ok.evacBoundary, BOUNDARY, 'stamped geometry rides the action');
    const bad = byId.get('slot-144');
    assert.ok(!bad.origin, 'size-growing rotation must lose the origin entirely (falsy)');
    assert.strictEqual(bad.evacBoundary, undefined, 'no B-stamp without proof');
    const missing = byId.get('slot-145');
    assert.ok(!missing.origin, 'rotation without a source master cannot prove (falsy)');
    assert.strictEqual(missing.evacBoundary, undefined, 'no B-stamp without a source');
    // Gap-plan CREATEs carry no per-action origin (dead weight — the
    // spread-correction fallback reads the batch origin instead).
    const creates = actions.filter((a: any) => a.type === COW_ACTIONS.CREATE);
    if (creates.length > 0) assert.ok(creates.every((c: any) => !c.origin), 'gap-plan CREATE origin is dead — not minted');
    console.log('✓ EVAC-019 passed');
}

async function testEVAC020_StampedSizeReproof() {
    console.log('\n[EVAC-020] Stamped-size re-proof covers the plan-vs-booked TOCTOU...');
    // Grown int size (an unprocessed fill shrank the booking below the plan)
    // invalidates the stamp → live probe.
    assert.strictEqual(isEvacuationSizeStillValid(100.00001, 100, 5), false, 'grown int size must re-prove live');
    // Equal and shrunken sizes keep the stamp usable.
    assert.strictEqual(isEvacuationSizeStillValid(100, 100, 5), true, 'equal size keeps the stamp');
    assert.strictEqual(isEvacuationSizeStillValid(99.5, 100, 5), true, 'shrunken size keeps the stamp');
    // Sub-quantum delta is invisible on chain: int-equal keeps the stamp
    // (consistent with the live probe), while the float fallback stays strict.
    assert.strictEqual(isEvacuationSizeStillValid(100.000000001, 100, 5), true, 'sub-quantum delta keeps the stamp (int semantics)');
    assert.strictEqual(isEvacuationSizeStillValid(100.000000001, 100, null), false, 'sub-quantum delta refused under float fallback');
    // Fail closed: a non-finite (or non-positive) booked remaining can never
    // cover the plan → live probe.
    assert.strictEqual(isEvacuationSizeStillValid(100, NaN, 5), false, 'non-finite booked must re-prove live');
    assert.strictEqual(isEvacuationSizeStillValid(100, 0, 5), false, 'zero booked must re-prove live');
    assert.strictEqual(isEvacuationSizeStillValid(100, -5, 5), false, 'negative booked must re-prove live');
    assert.strictEqual(isEvacuationSizeStillValid(NaN, 100, 5), false, 'non-finite planned size fails closed');
    console.log('✓ EVAC-020 passed');
}

async function testEVAC021_UnknownPlanGeometryDoesNotStamp() {
    console.log('\n[EVAC-021] Unknown plan geometry never stamps a boundary-0 evacuation...');
    // Source slot-1 sits inside the FAKE band (0, 3) that Number(null) === 0
    // would select. A genuine boundary 0 legitimately stamps it; null/undefined/''
    // (unknown geometry) must not.
    const srcMaster = slot('slot-1', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 100, 100, '1.7.1');
    const buildAction = () => ({
        type: COW_ACTIONS.UPDATE,
        id: 'slot-1',
        orderId: '1.7.1',
        newGridId: 'slot-4',
        newSize: 100,
        newPrice: 104,
        order: slot('slot-4', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 104, 100),
        isRotation: true
    });

    const genuineZero = stampGapEvacuationRotation(
        buildAction(), srcMaster, 104, 100, ORDER_TYPES.SELL, 0, GAP_SLOTS
    );
    assert.strictEqual(genuineZero.origin, 'gap-evacuation', 'genuine boundary 0 still stamps');
    assert.strictEqual(genuineZero.evacBoundary, 0, 'genuine boundary 0 is preserved, not treated as unknown');

    for (const unknown of [null, undefined, '']) {
        const stamped = stampGapEvacuationRotation(
            buildAction(), srcMaster, 104, 100, ORDER_TYPES.SELL, unknown as any, GAP_SLOTS
        );
        assert.ok(!stamped.origin, `unknown boundary (${String(unknown)}) must not stamp`);
        assert.strictEqual(stamped.evacBoundary, undefined, `unknown boundary (${String(unknown)}) leaves no B-stamp`);
    }
    // Unknown gapSlots with a real boundary must not stamp either.
    const noGap = stampGapEvacuationRotation(
        buildAction(), srcMaster, 104, 100, ORDER_TYPES.SELL, 0, null as any
    );
    assert.ok(!noGap.origin, 'unknown gapSlots must not stamp');

    // The optimizeRebalanceActions fold must honor the same contract.
    const actions = [
        { type: COW_ACTIONS.CANCEL, id: 'slot-1', orderId: '1.7.1' },
        { type: COW_ACTIONS.CREATE, id: 'slot-4', order: slot('slot-4', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 104, 100) }
    ];
    const optMaster = new Map([['slot-1', srcMaster]]);
    const optUnknown = optimizeRebalanceActions(actions, optMaster, { boundaryIdx: null, gapSlots: GAP_SLOTS });
    const rotUnknown = optUnknown.find((a: any) => a.type === COW_ACTIONS.UPDATE);
    assert.ok(rotUnknown && !rotUnknown.origin, 'unknown boundary must not stamp via optimizeRebalanceActions');
    const optZero = optimizeRebalanceActions(actions, optMaster, { boundaryIdx: 0, gapSlots: GAP_SLOTS });
    const rotZero = optZero.find((a: any) => a.type === COW_ACTIONS.UPDATE);
    assert.strictEqual(rotZero.origin, 'gap-evacuation', 'genuine boundary 0 still stamps via optimizeRebalanceActions');
    console.log('✓ EVAC-021 passed');
}

async function runAllTests() {
    console.log('=== Gap-Evacuation Test Suite ===\n');
    await testEVAC001_AllowsSellOutwardNonGrowing();
    await testEVAC002_BlocksSellTowardGap();
    await testEVAC003_AllowsBuyOutwardShrinking();
    await testEVAC004_BitExactSizeNoEpsilon();
    await testEVAC005_GeometryTyping();
    await testEVAC006_RailHolePlaceholder();
    await testEVAC007_GeometryOnlyDetection();
    await testEVAC008_StreakCounter();
    await testEVAC009_ReconcileStampsEvacuation();
    await testEVAC010_RailToRailUnstamped();
    await testEVAC011_RailHoleSurvivesValidationAndRoles();
    await testEVAC012_TeethHoldBelowCancelThreshold();
    await testEVAC013_TeethQueueOnceAtThreshold();
    await testEVAC014_TeethRecheckGeometryAndLiveSlot();
    await testEVAC015_TeethMarkerReleasesOnResolve();
    await testEVAC016_StampStillValidFreshGeometry();
    await testEVAC017_StampStaleUnderLiveGeometry();
    await testEVAC018_StampUsesPrecisionBitExactSize();
    await testEVAC019_PlanLevelOriginRoutesThroughProof();
    await testEVAC020_StampedSizeReproof();
    await testEVAC021_UnknownPlanGeometryDoesNotStamp();
    console.log('\n=== All gap-evacuation tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });
