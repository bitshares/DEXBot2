/**
 * test_sync_out_of_grid_defer.ts — sub/super-grid orphans must hold, never
 * adopt into edge slots or cancel as duplicates (issue #24).
 *
 * slotIndexForPrice clamps out-of-range prices onto slot-0 / slot-(N-1).
 * The genesis Pass-2 path must treat that clamp as no-match: below-grid
 * buys are not slot-0, above-grid sells are not slot-(N-1) — defer with
 * reason 'out-of-grid-deferred' (no adopt, no cancelOnly).
 *
 * Order ids below are synthetic (1.7.91xxxx); the shapes mirror the issue
 * (slot-0 live order plus orphans 14-20% below it).
 */
const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const AsyncLock = require('../modules/order/async_lock').default;
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const { buildGenesisFromPriceLevels, isChainPriceOutOfGrid } = require('../modules/order/utils/math');
const { validateCreateTargetSlots } = require('../modules/order/utils/validate');

const N_LEVELS = 51; // slot-0 .. slot-50
const LEVELS = Array.from({ length: N_LEVELS }, (_, i) => 100 * Math.pow(1.01, i));
const GENESIS = () => buildGenesisFromPriceLevels(100, 1, 4, LEVELS);

function makeMgr(opts = {}) {
    const orders = new Map();
    for (const o of (opts as any).orders || []) {
        orders.set(o.id, { ...o });
    }
    const assets = (opts as any).assets || {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const logEntries: any[] = [];
    return {
        orders,
        assets,
        config: (opts as any).config,
        boundaryIdx: (opts as any).boundaryIdx,
        _gapSlots: (opts as any).gapSlots,
        _genesis: (opts as any).genesis,
        logger: {
            log: (msg: string, level: string) => { logEntries.push({ msg, level }); }
        },
        _logEntries: logEntries,
        _gridPersistenceSuspendedReason: null,
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _syncLock: new AsyncLock(),
        _fillProcessingLock: new AsyncLock(),
        _gridLock: new AsyncLock(),
        ordersNeedingPriceCorrection: [],
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        lockOrders: () => {},
        unlockOrders: () => {},
        shadowOrderIds: new Map(),
        _applyOrderUpdate: async (order: any, _reason: string, _opts2: any) => {
            orders.set(order.id, { ...(orders.get(order.id) || {}), ...order });
            return orders.get(order.id);
        }
    };
}

function makeChainOrder(id: string, type: string, price: number, size: number) {
    // Mirror parseChainOrder: sell → base assetA / quote assetB;
    // buy → base assetB / quote assetA (price = base/quote * 10^delta).
    const isSell = type === 'sell';
    const baseAssetId = isSell ? '1.3.0' : '1.3.121';
    const quoteAssetId = isSell ? '1.3.121' : '1.3.0';
    const baseInt = Math.round(size * Math.pow(10, isSell ? 8 : 5));
    const quoteInt = isSell
        ? Math.round(size * price * Math.pow(10, 5))
        : Math.round(size * Math.pow(10, 8) / price);
    return {
        id,
        sell_price: {
            base: { amount: String(baseInt), asset_id: baseAssetId },
            quote: { amount: String(quoteInt), asset_id: quoteAssetId }
        },
        for_sale: String(baseInt),
        type,
        price,
        size
    };
}

function correctionsFor(mgr: any, chainOrderId: string) {
    return (mgr.ordersNeedingPriceCorrection || []).filter((c: any) => c.chainOrderId === chainOrderId);
}

async function testBelowGridBuysAreDeferredNotAdoptedOrCancelled() {
    console.log(' - Below-grid buys defer (occupied slot-0): no adopt, no duplicate cancel...');
    // Issue #24 shape: slot-0 @ 100, orphans 14-20% below it.
    const mgr = makeMgr({
        orders: [{
            id: 'slot-0',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: LEVELS[0],
            size: 5,
            orderId: '1.7.910001',
        }],
        genesis: GENESIS(),
        boundaryIdx: 40, // buy rail idx <= 40 → slot-0 is rail (clamp passes rail check pre-fix)
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const chain = [
        makeChainOrder('1.7.910001', ORDER_TYPES.BUY, LEVELS[0], 5),
        makeChainOrder('1.7.910002', ORDER_TYPES.BUY, 85, 5),
        makeChainOrder('1.7.910003', ORDER_TYPES.BUY, 80, 5),
    ];
    const result = await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    assert.strictEqual(result.unmatchedChainOrders.length, 2, 'Both below-grid orphans must stay unmatched');
    for (const id of ['1.7.910002', '1.7.910003']) {
        const unmatched = result.unmatchedChainOrders.find((u: any) => u.chainOrderId === id);
        assert.ok(unmatched, `${id} must be unmatched`);
        assert.strictEqual(unmatched.reason, 'out-of-grid-deferred', `${id} must defer, not duplicate/cancel`);
        assert.strictEqual(unmatched.candidateSlotId, 'slot-0', `${id} candidate stays slot-0 for diagnostics`);
        assert.strictEqual(correctionsFor(mgr, id).length, 0, `${id} must NOT be queued for cancellation`);
    }
    const slot0 = mgr.orders.get('slot-0');
    assert.strictEqual(slot0.orderId, '1.7.910001', 'slot-0 must keep its live order (no mis-adoption)');
    console.log('✓ OUT-OF-GRID-001 passed');
}

async function testBelowGridBuyDoesNotAdoptIntoFreeSlot0() {
    console.log(' - Below-grid buy defers (free slot-0): no mis-adoption...');
    const mgr = makeMgr({
        orders: [{
            id: 'slot-0',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: LEVELS[0],
            size: 5,
        }],
        genesis: GENESIS(),
        boundaryIdx: 40,
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const result = await engine.syncFromOpenOrders(
        [makeChainOrder('1.7.910004', ORDER_TYPES.BUY, 82, 5)],
        { skipAccounting: true }
    );

    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Below-grid orphan must stay unmatched');
    assert.strictEqual(result.unmatchedChainOrders[0].reason, 'out-of-grid-deferred', 'Must defer, not adopt');
    const slot0 = mgr.orders.get('slot-0');
    assert.ok(!slot0.orderId, 'Free slot-0 must NOT adopt the below-grid orphan');
    console.log('✓ OUT-OF-GRID-002 passed');
}

async function testAboveGridSellIsDeferredNotCancelled() {
    console.log(' - Above-grid sell defers (occupied top slot): symmetric hold...');
    const topIdx = N_LEVELS - 1;
    const mgr = makeMgr({
        orders: [{
            id: `slot-${topIdx}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: LEVELS[topIdx],
            size: 10,
            orderId: '1.7.910006',
        }],
        genesis: GENESIS(),
        boundaryIdx: 40, // sellStart = 45 → top slot is rail
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const result = await engine.syncFromOpenOrders(
        [
            makeChainOrder('1.7.910006', ORDER_TYPES.SELL, LEVELS[topIdx], 10),
            makeChainOrder('1.7.910007', ORDER_TYPES.SELL, LEVELS[topIdx] * 1.2, 10),
        ],
        { skipAccounting: true }
    );

    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Above-grid orphan must stay unmatched');
    assert.strictEqual(result.unmatchedChainOrders[0].reason, 'out-of-grid-deferred', 'Must defer, not duplicate/cancel');
    assert.strictEqual(correctionsFor(mgr, '1.7.910007').length, 0, 'Above-grid orphan must NOT be queued for cancellation');
    const top = mgr.orders.get(`slot-${topIdx}`);
    assert.strictEqual(top.orderId, '1.7.910006', 'Top slot must keep its live order');
    console.log('✓ OUT-OF-GRID-003 passed');
}

async function testInRailOrphanStillAdopts() {
    console.log(' - In-rail orphan still adopts (guard does not overreach)...');
    const idx = 10;
    const mgr = makeMgr({
        orders: [{
            id: `slot-${idx}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: LEVELS[idx],
            size: 10,
        }],
        genesis: GENESIS(),
        boundaryIdx: 40,
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const result = await engine.syncFromOpenOrders(
        [makeChainOrder('1.7.910008', ORDER_TYPES.BUY, LEVELS[idx], 10)],
        { skipAccounting: true }
    );

    assert.strictEqual(result.unmatchedChainOrders.length, 0, 'Exact in-rail orphan must adopt');
    const slot = mgr.orders.get(`slot-${idx}`);
    assert.strictEqual(slot.orderId, '1.7.910008', 'In-rail slot must bind the chain order');
    console.log('✓ OUT-OF-GRID-004 passed');
}

async function testHelperClassifiesEdges() {
    console.log(' - isChainPriceOutOfGrid classifies rail vs outside...');
    const g = GENESIS();
    const assetsBuy = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' },
    };
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[0], g, 5, ORDER_TYPES.BUY, assetsBuy), false, 'Edge price is in-grid');
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[10], g, 5, ORDER_TYPES.BUY, assetsBuy), false, 'Mid-rail price is in-grid');
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[0] * 0.8, g, 5, ORDER_TYPES.BUY, assetsBuy), true, 'Below-grid price is out');
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[N_LEVELS - 1] * 1.2, g, 5, ORDER_TYPES.SELL, assetsBuy), true, 'Above-grid price is out');
    // Fail-closed with no asset context: an unjudgeable outside price is out.
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[0] * 0.8, g), true, 'No asset context: outside price still deferred');
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[0] * (1 - 1e-12), g), false, 'No asset context: float dust at the edge still excused');

    // Low-precision rail (low-precision shape): assetB precision 4, edge ~2.3e-4.
    // The asset-precision integer of a below-edge price collapses onto the
    // edge's integer across a ~1e-4 band (dozens of 0.4% levels), which
    // previously excused a whole dip-protection band as in-grid. With the
    // chain tolerance, only true float dust is excused.
    const N_LOW = 60;
    const LOW_LEVELS = Array.from({ length: N_LOW }, (_, i) => 0.0002333 * Math.pow(1.004, i));
    const gLow = buildGenesisFromPriceLevels(LOW_LEVELS[0], 0.4, 4, LOW_LEVELS);
    const assetsLowBuy = {
        assetA: { id: '1.3.1', precision: 8, symbol: 'BASE' },
        assetB: { id: '1.3.2', precision: 4, symbol: 'QUOTE' },
    };
    assert.strictEqual(
        isChainPriceOutOfGrid(LOW_LEVELS[0], gLow, 1.5, ORDER_TYPES.BUY, assetsLowBuy),
        false, 'Low-precision edge price is in-grid'
    );
    assert.strictEqual(
        isChainPriceOutOfGrid(LOW_LEVELS[0] * 0.9, gLow, 1.5, ORDER_TYPES.BUY, assetsLowBuy),
        true, 'Below-edge level that rounds to the edge integer must be out-of-grid'
    );
    assert.strictEqual(
        isChainPriceOutOfGrid(LOW_LEVELS[N_LOW - 1] * 1.1, gLow, 1.5, ORDER_TYPES.SELL, assetsLowBuy),
        true, 'Above-edge level that rounds to the edge integer must be out-of-grid'
    );
    assert.strictEqual(
        isChainPriceOutOfGrid(LOW_LEVELS[0] * (1 - 1e-12), gLow, 1.5, ORDER_TYPES.BUY, assetsLowBuy),
        false, 'Sub-satoshi float dust at the edge is still excused'
    );
    console.log('✓ OUT-OF-GRID-005 passed');
}

async function testHoldDoesNotBlockRailRefill() {
    console.log(' - Out-of-grid hold does not collide with rail refill CREATE...');
    const assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const orders = new Map([['slot-0', {
        id: 'slot-0', type: ORDER_TYPES.BUY, price: LEVELS[0], size: 5,
        state: ORDER_STATES.VIRTUAL, orderId: '',
    }]]);
    const actions = [{
        type: COW_ACTIONS.CREATE, id: 'slot-0',
        order: { id: 'slot-0', price: LEVELS[0], type: ORDER_TYPES.BUY, size: 5 },
    }];
    // The hold lives below the grid; its candidateSlotId is the clamp, not
    // a real match — refilling slot-0 must stay valid.
    const holds = [{
        chainOrderId: '1.7.910002', candidateSlotId: 'slot-0',
        reason: 'out-of-grid-deferred', price: 82, size: 5, type: ORDER_TYPES.BUY,
    }];
    const resHold = validateCreateTargetSlots(actions, orders, assets, holds);
    assert.ok(!resHold.violations.some((v: any) => v.reason === 'chain_orphan_collision'),
        'Hold must not collide with the rail refill');
    assert.strictEqual(resHold.isValid, true, 'Refill CREATE stays valid alongside the hold');
    // Control: a real same-slot duplicate still collides (no overreach).
    const dups = [{
        chainOrderId: '1.7.910005', candidateSlotId: 'slot-0',
        reason: 'duplicate-price-level', price: LEVELS[0], size: 5, type: ORDER_TYPES.BUY,
    }];
    const resDup = validateCreateTargetSlots(actions, orders, assets, dups);
    assert.ok(resDup.violations.some((v: any) => v.reason === 'chain_orphan_collision'),
        'True same-slot duplicate must still collide');
    console.log('✓ OUT-OF-GRID-006 passed');
}

async function testBoundaryUnknownHoldDoesNotBlockRailRefill() {
    console.log(' - Boundary-unknown hold (a different -deferred reason) also does not collide...');
    const assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const orders = new Map([['slot-0', {
        id: 'slot-0', type: ORDER_TYPES.BUY, price: LEVELS[0], size: 5,
        state: ORDER_STATES.VIRTUAL, orderId: '',
    }]]);
    const actions = [{
        type: COW_ACTIONS.CREATE, id: 'slot-0',
        order: { id: 'slot-0', price: LEVELS[0], type: ORDER_TYPES.BUY, size: 5 },
    }];
    // Classification is by the shared `-deferred` suffix, not an exact reason
    // string: a boundary-unknown hold is a deliberate defer too and must not
    // be mistaken for a same-slot duplicate.
    const holds = [{
        chainOrderId: '1.7.910007', candidateSlotId: 'slot-0',
        reason: 'boundary-unknown-deferred', price: LEVELS[0], size: 5, type: ORDER_TYPES.BUY,
    }];
    const resHold = validateCreateTargetSlots(actions, orders, assets, holds);
    assert.ok(!resHold.violations.some((v: any) => v.reason === 'chain_orphan_collision'),
        'Boundary-unknown hold must not collide with the rail refill');
    assert.strictEqual(resHold.isValid, true, 'Refill CREATE stays valid alongside the hold');
    console.log('✓ OUT-OF-GRID-007 passed');
}


/**
 * ADOPT-001..002 — nearest-slot adoption keeps the slot's OWN ladder level.
 *
 * Adoption used to write `price: chainOrder.price` into the adopted slot (the
 * legacy no-genesis branch), so whatever price sat on the book BECAME the
 * slot's grid level. A slot whose price is set from the book is no longer a
 * ladder position, and the next plan that reads slot.price re-emits that value
 * as a plan price — the adoption-side route into the off-grid-price failure.
 * Adoption now mutates a COPY and never touches slot.price.
 */
async function testAdoptionKeepsOwnLevelNotChainPrice() {
    console.log(' - Nearest-slot adoption keeps the slot level, not the chain price...');
    const genesis = GENESIS();
    const slotPrice = LEVELS[0];
    // A resting price inside slot-0's basin but clearly off the level itself:
    // level 1 is 1% away, so 0.4% still maps to slot-0 while being a different
    // number (the assertion must not be vacuous).
    const chainPrice = slotPrice * 1.004;
    const mgr = makeMgr({
        orders: [{
            id: 'slot-0',
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            price: slotPrice,
            size: 0,
            orderId: null,
        }],
        genesis,
        boundaryIdx: 40,
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const chain = [makeChainOrder('1.7.920001', ORDER_TYPES.BUY, chainPrice, 5)];
    const result = await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    const adopted = mgr.orders.get('slot-0');
    assert.strictEqual(adopted.orderId, '1.7.920001', 'the orphan must be adopted into the slot');
    assert.strictEqual(adopted.size, 5, 'the chain size is real state and must be adopted');
    assert.ok(Math.abs(chainPrice - slotPrice) > 1e-6,
        `fixture must keep the two prices distinguishable; chain=${chainPrice} slot=${slotPrice}`);
    assert.strictEqual(adopted.price, slotPrice,
        `adoption must keep the slot's own level ${slotPrice}, got ${adopted.price} (chain price was ${chainPrice})`);
    assert.strictEqual(result.unmatchedChainOrders.length, 0, 'an in-rail orphan must still be adopted');
    console.log('   \u2713 ADOPT-001 passed');
}

async function testAdoptionRejectsOutOfRailSlot() {
    console.log(' - Adoption defers an orphan whose nearest slot is out of rail...');
    // boundaryIdx 0 means the buy rail does not reach idx 5, so a buy whose
    // nearest slot is slot-5 must not be adopted there. The chain price is the
    // exact level of slot-5 so `slotIndexForPrice` lands on it and the rail
    // check (not the missing-slot path) is what rejects the adoption.
    const mgr = makeMgr({
        orders: [{
            id: 'slot-5',
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            price: LEVELS[5],
            size: 0,
            orderId: null,
        }],
        genesis: GENESIS(),
        boundaryIdx: 0,
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const chain = [makeChainOrder('1.7.930001', ORDER_TYPES.BUY, LEVELS[5], 5)];
    const result = await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    const adopted = mgr.orders.get('slot-5');
    assert.strictEqual(adopted.orderId, null, 'a buy must not be adopted into an out-of-rail slot');
    const unmatched = result.unmatchedChainOrders.find((u: any) => u.chainOrderId === '1.7.930001');
    assert.ok(unmatched, 'the out-of-rail orphan must be reported as unmatched');
    assert.strictEqual(unmatched.reason, 'no-available-nearest-slot', 'out-of-rail must be reported, not silently dropped');
    console.log('   \u2713 ADOPT-002 passed');
}


/**
 * MATERIALIZE-001..002 — the unknown-id materialize path must derive the slot's
 * price from the GENESIS LADDER, not from the carried placement descriptor.
 *
 * When a CREATE lands but master no longer holds the slot, the slot is
 * materialized from the descriptor the caller passed. It used to take
 * `price: descriptorPrice`, so a slot's price became whatever price that object
 * happened to carry — which for a slot being materialized at a NEW index can be
 * a price belonging to a different grid. That is the same carried-price-into-
 * slot.price class as the adoption writer.
 *
 * The descriptor price is still used when genesis is unavailable (migration),
 * where there is no ladder to derive from.
 */
async function testMaterializeDerivesTypeFromLadderNotDescriptor() {
    console.log(' - Materialize derives the slot TYPE from the ladder, not a corrupt descriptor...');
    // MATERIALIZE-003: the type must be consistent with the price. The slot's
    // genesis level is authoritative for BOTH. Deriving the side from a corrupt
    // descriptor price while correcting the price to the ladder produced an
    // order object that disagreed with itself: e.g. SELL @ 95 when the slot's
    // level (95) is on the BUY side of startPrice.
    //
    // Existing tests pass an explicit `expectedType`, which is why this was
    // never caught -- the bug needs an UNKNOWN type plus a corrupt descriptor.
    const LEVELS_LOCAL = Array.from({ length: 51 }, (_, i) => 100 * Math.pow(1.01, i));
    const genesis = buildGenesisFromPriceLevels(100, 1, 4, LEVELS_LOCAL);

    // startPrice must be above the ladder so slot-5 (the lowest levels) is BUY.
    const startPrice = LEVELS_LOCAL[50];
    const mgr = makeMgr({ genesis, boundaryIdx: 40, gapSlots: 4, config: { startPrice } });
    const engine = new SyncEngine(mgr);
    const gridOrderId = 'slot-5';
    const ladderLevel = LEVELS_LOCAL[5];
    // startPrice for makeMgr is above the ladder, so any level below it is BUY.
    // A corrupt descriptor priced ABOVE startPrice would derive SELL.
    const corruptDescriptor = Number(mgr.config.startPrice) * 10;

    await engine.synchronizeWithChain({
        gridOrderId,
        chainOrderId: '1.7.960001',
        isPartialPlacement: false,
        // UNKNOWN type (neither BUY nor SELL) forces side derivation.
        expectedType: 'unknown' as any,
        fee: 0,
        order: { id: gridOrderId, type: 'unknown', price: corruptDescriptor, size: 5 },
    }, 'createOrder');

    const materialized = mgr.orders.get(gridOrderId);
    assert.ok(materialized, 'the slot must be materialized');
    assert.strictEqual(materialized.price, ladderLevel,
        `price must be the genesis level, got ${materialized.price}`);

    // The type must agree with the ladder level's side, not the descriptor's.
    const { resolveSpreadOrderSide } = require('../modules/order/utils/order');
    const correctSide = resolveSpreadOrderSide(ladderLevel, mgr.config.startPrice);
    assert.strictEqual(materialized.type, correctSide,
        `type must follow the ladder level (${correctSide}), got ${materialized.type}`);
    const descriptorSide = resolveSpreadOrderSide(corruptDescriptor, mgr.config.startPrice);
    assert.notStrictEqual(materialized.type, descriptorSide,
        `type must NOT follow the corrupt descriptor (${descriptorSide})`);
    console.log('   \u2713 MATERIALIZE-003 passed');
}

async function testMaterializeUsesGenesisPriceNotDescriptor() {
    console.log(' - Materialize derives the slot price from genesis, not the descriptor...');
    const LEVELS_LOCAL = Array.from({ length: 51 }, (_, i) => 100 * Math.pow(1.01, i));
    const genesis = buildGenesisFromPriceLevels(100, 1, 4, LEVELS_LOCAL);

    const mgr = makeMgr({ genesis, boundaryIdx: 40, gapSlots: 4 });
    const engine = new SyncEngine(mgr);
    const gridOrderId = 'slot-5';
    assert.strictEqual(mgr.orders.has(gridOrderId), false, 'fixture: slot must NOT be in master');

    // Descriptor carries a price that is NOT the ladder level for slot-5 —
    // simulating a descriptor from a different grid / a drifted plan.
    const descriptorPrice = LEVELS_LOCAL[5] * 1.25;
    await engine.synchronizeWithChain({
        gridOrderId,
        chainOrderId: '1.7.940001',
        isPartialPlacement: false,
        expectedType: ORDER_TYPES.BUY,
        fee: 0,
        order: { id: gridOrderId, type: ORDER_TYPES.BUY, price: descriptorPrice, size: 5 },
    }, 'createOrder');

    const materialized = mgr.orders.get(gridOrderId);
    assert.ok(materialized, 'the slot must be materialized');
    assert.strictEqual(materialized.orderId, '1.7.940001', 'the chain id must be linked');
    const expected = LEVELS_LOCAL[5];
    assert.strictEqual(materialized.price, expected,
        `materialized price must be the genesis level ${expected}, got ${materialized.price} (descriptor was ${descriptorPrice})`);
    assert.notStrictEqual(materialized.price, descriptorPrice, 'the descriptor price must not become the slot price');
    console.log('   \u2713 MATERIALIZE-001 passed');
}

async function testMaterializeFaultsOnUndefinedGrid() {
    console.log(' - Materialize on a ladder-less grid keeps the order tracked but faults loudly...');
    // INV-GRID-004: a `slot-N` id with no ladder is an UNDEFINED grid, not a
    // migration case. The live chain order must still be tracked (stranding it
    // would be worse), but the descriptor price is unverified, so the fault is
    // logged at ERROR and a structural resync is requested to re-derive the
    // ladder and re-price the slot.
    const LEVELS_LOCAL = Array.from({ length: 51 }, (_, i) => 100 * Math.pow(1.01, i));
    const mgr = makeMgr({ boundaryIdx: 40, gapSlots: 4 }); // no genesis
    let resyncReason: string | null = null;
    (mgr as any).requestStructuralGridResync = async (reason: string) => { resyncReason = reason; };
    const engine = new SyncEngine(mgr);
    const gridOrderId = 'slot-5';
    const descriptorPrice = LEVELS_LOCAL[5];

    await engine.synchronizeWithChain({
        gridOrderId,
        chainOrderId: '1.7.950001',
        isPartialPlacement: false,
        expectedType: ORDER_TYPES.BUY,
        fee: 0,
        order: { id: gridOrderId, type: ORDER_TYPES.BUY, price: descriptorPrice, size: 5 },
    }, 'createOrder');

    const materialized = mgr.orders.get(gridOrderId);
    assert.ok(materialized, 'the placed order must still be tracked (never stranded)');
    assert.strictEqual(materialized.price, descriptorPrice,
        'with no ladder the descriptor is the only price available');
    const faulted = mgr._logEntries.some((e: any) => e.level === 'error' && String(e.msg).includes('no price ladder'));
    assert.ok(faulted, 'the undefined grid must be reported as an error, not a silent fallback');
    assert.strictEqual(resyncReason, 'missing-genesis', 'a structural resync must be requested to re-derive the ladder');
    console.log('   \u2713 MATERIALIZE-002 passed');
}


/**
 * ADOPT-NAME-001 — adoption must keep the slot's OWN genesis level, and must
 * not warn when it does. A chain order resting at a slightly different price
 * (normal after a grid regeneration) must not become the slot's price.
 *
 * Both adoption paths keep the slot price by NOT assigning it (an absence of a
 * write), so this pins the behaviour and makes a regression visible.
 */
async function testAdoptionKeepsSlotPriceAndDoesNotWarn() {
    console.log(' - Adoption keeps the slot price when the chain order rests elsewhere...');
    const mgr = makeMgr({
        orders: [{
            id: 'slot-5',
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            price: LEVELS[5],
            size: 0,
            orderId: null,
        }],
        genesis: GENESIS(),
        boundaryIdx: 40,
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    // The chain order rests a fraction of a slot away from the slot's level —
    // exactly the post-regeneration case. Its price must NOT be adopted.
    const chain = [makeChainOrder('1.7.980001', ORDER_TYPES.BUY, LEVELS[5] * 1.004, 5)];
    await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    const after = mgr.orders.get('slot-5');
    assert.ok(after, 'the slot must still exist after adoption');
    assert.strictEqual(after.orderId, '1.7.980001', 'the chain id must be linked');
    assert.strictEqual(after.price, LEVELS[5],
        `adoption must keep the slot's genesis level ${LEVELS[5]}, got ${after.price} (chain rested at ${LEVELS[5] * 1.004})`);
    const warned = mgr._logEntries.filter((e: any) => String(e.msg).includes('is NOT the slot'));
    assert.strictEqual(warned.length, 0, 'a correct adoption must not warn about a wrong slot price');
    console.log('   \u2713 ADOPT-NAME-001 passed');
}

async function runTests() {
    console.log('Running Sync Engine Out-Of-Grid Defer Tests (issue #24)...');
    await testBelowGridBuysAreDeferredNotAdoptedOrCancelled();
    await testBelowGridBuyDoesNotAdoptIntoFreeSlot0();
    await testAboveGridSellIsDeferredNotCancelled();
    await testInRailOrphanStillAdopts();
    await testHelperClassifiesEdges();
    await testHoldDoesNotBlockRailRefill();
    await testBoundaryUnknownHoldDoesNotBlockRailRefill();
    await testAdoptionKeepsOwnLevelNotChainPrice();
    await testAdoptionRejectsOutOfRailSlot();
    await testMaterializeDerivesTypeFromLadderNotDescriptor();
    await testMaterializeUsesGenesisPriceNotDescriptor();
    await testMaterializeFaultsOnUndefinedGrid();
    await testAdoptionKeepsSlotPriceAndDoesNotWarn();
    console.log('✓ Sync engine out-of-grid defer tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('✗ Sync engine out-of-grid defer tests failed');
    console.error(err);
    process.exit(1);
});
