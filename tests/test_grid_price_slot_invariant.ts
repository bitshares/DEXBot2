/**
 * tests/test_grid_price_slot_invariant.ts
 * Plan §12/§15: genesis price-slot determinism invariants
 * Covers: priceForSlot round-trip, midpoint tie-break, out-of-bounds,
 * non-finite throw, priceSlotEqual, assertSlotPriceInvariant, log/enforce modes,
 * hash mismatch, geometric migration, unparseable-id handling, createUncertain preservation
 */
const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

let math: any;
let gridMod: any;
try { math = require('../modules/order/utils/math'); } catch { math = require('../dist/modules/order/utils/math.js'); }
try { gridMod = require('../modules/order/grid'); } catch { gridMod = require('../dist/modules/order/grid.js'); }

const {
    buildGenesisFromPriceLevels, priceForSlot, slotIndexForPrice, slotIdForPrice,
    assertSlotPriceInvariant, priceSlotEqual, hashPriceLevels, isSlotInRail, calculateGapSlots
} = math;
const { createOrderGrid, loadGrid } = gridMod;
// Needed for the repaired-slot emittability assertion (step 8b).
const { checkGridPriceInvariant } = require('../modules/order/utils/order');

function makeGenesis() {
    // Use createOrderGrid to get a realistic genesis (dedupe consistent)
    const cfg = { startPrice: 100, minPrice: 80, maxPrice: 120, incrementPercent: 1, targetSpreadPercent: 2, gridLimits: {} };
    const { genesis } = createOrderGrid(cfg);
    return genesis;
}

function makeManagerForLoad(overrides: any = {}) {
    const logs: string[] = [];
    const manager: any = {
        config: { startPrice: 100, minPrice: 80, maxPrice: 120, incrementPercent: 1, targetSpreadPercent: 2, gridLimits: {}, coreOrders: { buy: 5, sell: 5 } },
        assets: { assetA: { id: '1.3.0', precision: 5, symbol: 'BTS' }, assetB: { id: '1.3.1', precision: 5, symbol: 'USD' } },
        funds: { btsFeesOwed: 0 },
        orders: new Map(),
        boundaryIdx: null,
        _genesis: null,
        _gridVersion: 0,
        _gridLock: { acquire: async (fn: any) => fn() },
        _fundLock: { acquire: async (fn: any) => fn() },
        _initializeAssets: async () => {},
        resetFunds: async () => {},
        _restoreBoundary: function(idx: any) { this.boundaryIdx = idx; },
        pauseRecalcLogging: () => {}, resumeRecalcLogging: () => {},
        pauseFundRecalc: () => {}, resumeFundRecalc: async () => {},
        _applyOrderUpdate: async function(order: any) { this.orders.set(order.id, order); },
        logger: { log: (msg: any) => logs.push(String(msg)) },
        ...overrides,
        get logs() { return logs; }
    };
    return manager;
}

async function run() {
    console.log('Running grid price-slot invariant tests...');

    // 1. Genesis build + hash determinism
    {
        const g = makeGenesis();
        assert.ok(Array.isArray(g.priceLevels) && g.priceLevels.length > 0, 'genesis has priceLevels');
        assert.ok(typeof g.priceLevelsHash === 'string' && g.priceLevelsHash.length === 8, 'hash 8 hex');
        const g2 = buildGenesisFromPriceLevels(g.startPrice, g.incrementPercent, g.gapSlots, [...g.priceLevels]);
        assert.strictEqual(g2.priceLevelsHash, g.priceLevelsHash, 'hash deterministic');
        assert.strictEqual(g2.priceLevelsHash, hashPriceLevels(g.priceLevels), 'hash matches helper');
    }

    // 2. priceForSlot round-trip
    {
        const g = makeGenesis();
        for (let i = 0; i < g.priceLevels.length; i++) {
            assert.strictEqual(priceForSlot(i, g), g.priceLevels[i], `round-trip idx ${i}`);
            assert.strictEqual(slotIdForPrice(g.priceLevels[i], g), `slot-${i}`, `slotIdForPrice exact ${i}`);
            assert.strictEqual(slotIndexForPrice(g.priceLevels[i], g), i, `slotIndexForPrice exact ${i}`);
        }
    }

    // 3. Midpoint tie-break → lower wins
    {
        const genesis = buildGenesisFromPriceLevels(100, 10, 2, [90, 100, 110]);
        const mid = (100 + 110) / 2; // 105 exactly midpoint
        assert.strictEqual(slotIndexForPrice(mid, genesis), 1, 'midpoint tie lower wins');
        // Slightly above midpoint → upper wins
        assert.strictEqual(slotIndexForPrice(105.01, genesis), 2, 'above midpoint upper wins');
    }

    // 4. Out-of-bounds → nearest edge
    {
        const g = makeGenesis();
        assert.strictEqual(slotIndexForPrice(g.priceLevels[0] - 1000, g), 0, 'below min → 0');
        assert.strictEqual(slotIndexForPrice(g.priceLevels[g.priceLevels.length - 1] + 1000, g), g.priceLevels.length - 1, 'above max → N-1');
    }

    // 5. Non-finite throws (plan §14)
    {
        const g = makeGenesis();
        assert.throws(() => slotIndexForPrice(NaN, g), /non-finite/, 'NaN throws');
        assert.throws(() => slotIndexForPrice(Infinity, g), /non-finite/, 'Infinity throws');
    }

    // 6. assertSlotPriceInvariant + priceSlotEqual
    {
        const g = makeGenesis();
        const okSlot = { id: 'slot-0', price: g.priceLevels[0] };
        assert.doesNotThrow(() => assertSlotPriceInvariant(okSlot, g), 'valid slot passes');
        const badSlot = { id: 'slot-0', price: g.priceLevels[0] * 1.1 };
        assert.throws(() => assertSlotPriceInvariant(badSlot, g), /invariant violated/, 'price mismatch throws');
        const unparseable = { id: 'legacy-0', price: g.priceLevels[0] };
        assert.throws(() => assertSlotPriceInvariant(unparseable, g), /unparseable/, 'unparseable id throws');

        // priceSlotEqual via floatToBlockchainInt
        assert.strictEqual(priceSlotEqual(1.00001, 1.00001, 5), true, 'equal via precision');
        assert.strictEqual(priceSlotEqual(1.00001, 1.00002, 5), false, 'different sat at 1e-5');
        assert.strictEqual(priceSlotEqual(1.000001, 1.000002, 5), true, 'within same sat truncates');
    }

    // 7. isSlotInRail fail-open for legacy ids — unparseable admitted, geometry intact
    {
        assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.BUY, { id: 'slot-x' }), true, 'unparseable admitted (legacy fail-open)');
        assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, { id: 'slot-11' }), false, 'gap excluded');
        assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.BUY, { id: 'slot-11' }), false, 'parseable out-of-rail still excluded');
        assert.strictEqual(isSlotInRail(null, 3, ORDER_TYPES.SELL, { id: 'slot-11' }), true, 'boundary-null still admitted');
    }

    // 8. loadGrid log vs enforce mode for price mismatch — use actual genesis rail price
    //
    // A mismatched price is REPAIRED from the genesis ladder in BOTH modes.
    // The slot id determines its price, so a divergent value is corruption:
    // left in place it re-activates, the emission guard rejects it every cycle,
    // and nothing heals the slot short of a full reset (permanent stall).
    // Enforce mode additionally virtualizes (zeroes size/orderId).
    for (const mode of ['log', 'enforce'] as const) {
        const g = makeGenesis();
        // Pick a slot and corrupt its price to guarantee invariant failure
        const badPrice = g.priceLevels[1] * 1.05; // 5% off, well beyond 1e-9 epsilon
        const persistedGrid = [
            { id: 'slot-0', price: g.priceLevels[0], type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' },
            { id: 'slot-1', price: badPrice, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' },
        ];
        const origEnv = process.env.GRID_PRICE_SLOT_VALIDATION;
        process.env.GRID_PRICE_SLOT_VALIDATION = mode;
        const manager = makeManagerForLoad({ _genesis: null });
        // boundary 0 to keep both slots in buy rail
        await loadGrid(manager, persistedGrid, 0, g);
        const loaded = [...manager.orders.values()] as any[];
        const slot1 = loaded.find((s: any) => s.id === 'slot-1');
        // Both modes: the price is repaired to the slot's own ladder level.
        assert.strictEqual(slot1.price, g.priceLevels[1],
            `${mode} mode must repair the mismatched price to the genesis level, got ${slot1.price}`);
        assert.notStrictEqual(slot1.price, badPrice, `${mode} mode must not keep the corrupted price`);
        assert.ok(manager.logs.some(l => l.includes('Repaired')),
            `${mode} mode must log the repair so the corruption is visible`);
        if (mode === 'log') {
            assert.strictEqual(slot1.state, ORDER_STATES.VIRTUAL, 'log mode keeps state');
            assert.ok(manager.logs.some(l => l.includes('price repaired from genesis')),
                'log mode logs the repair (not merely log-only)');
        } else {
            assert.strictEqual(slot1.state, ORDER_STATES.VIRTUAL, 'enforce mode keeps VIRTUAL');
            assert.strictEqual(slot1.size, 0, 'enforce mode zeroes size');
            assert.ok(manager.logs.some(l => l.includes('virtualize')), 'enforce logs virtualize');
        }
        process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
        delete process.env.GRID_PRICE_SLOT_VALIDATION;
        if (origEnv !== undefined) process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
    }

    // 8b. A repaired slot must be emittable again (the stall is actually healed).
    // This is the regression guard for the permanent-stall hole: before the
    // repair, the guard rejected this slot on every cycle forever.
    {
        const g = makeGenesis();
        const badPrice = g.priceLevels[1] * 1.05;
        const persistedGrid = [
            { id: 'slot-1', price: badPrice, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' },
        ];
        const origEnv = process.env.GRID_PRICE_SLOT_VALIDATION;
        process.env.GRID_PRICE_SLOT_VALIDATION = 'log';
        const manager = makeManagerForLoad({ _genesis: null });
        await loadGrid(manager, persistedGrid, 0, g);
        const loaded = [...manager.orders.values()] as any[];
        const slot1 = loaded.find((s: any) => s.id === 'slot-1');
        // The post-repair price must satisfy the emission guard's check, or the
        // slot is still stuck (which is the whole point of repairing it).
        const inv = checkGridPriceInvariant(slot1.id, slot1.price, manager._genesis || g);
        assert.strictEqual(inv.ok, true,
            `a repaired slot must pass the emission guard (else it stalls forever): ${inv.reason}`);
        process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
        if (origEnv === undefined) delete process.env.GRID_PRICE_SLOT_VALIDATION;
    }

    // 9. Hash mismatch warning (still uses persisted genesis)
    {
        const g = makeGenesis();
        const tampered = { ...g, priceLevelsHash: 'deadbeef' };
        const persistedGrid = g.priceLevels.slice(0, 2).map((p: any, i: number) => ({ id: `slot-${i}`, price: p, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' }));
        const manager = makeManagerForLoad();
        const origEnv = process.env.GRID_PRICE_SLOT_VALIDATION;
        process.env.GRID_PRICE_SLOT_VALIDATION = 'log';
        await loadGrid(manager, persistedGrid, 0, tampered);
        assert.ok(manager.logs.some(l => l.includes('hash mismatch')), 'hash mismatch warned');
        assert.ok(manager._genesis && manager._genesis.priceLevelsHash === 'deadbeef', 'tampered genesis still adopted (warn-only)');
        process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
        if (origEnv === undefined) delete process.env.GRID_PRICE_SLOT_VALIDATION;
    }

    // 10. Migration geometric vs truncated + cross-check
    {
        // Simulate legacy snapshot with truncated persisted prices (only 2 slots) but config expects full rail
        const cfg = { startPrice: 100, minPrice: 80, maxPrice: 120, incrementPercent: 1, targetSpreadPercent: 2, gridLimits: {} };
        const full = createOrderGrid(cfg);
        const truncatedGrid = full.orders.slice(0, 2); // truncated persisted array
        const manager = makeManagerForLoad({ config: cfg });
        const origEnv = process.env.GRID_PRICE_SLOT_VALIDATION;
        process.env.GRID_PRICE_SLOT_VALIDATION = 'log';
        await loadGrid(manager, truncatedGrid as any, full.boundaryIdx, null); // no genesis → migration
        assert.ok(manager._genesis, 'migration builds genesis');
        // Migration builds full geometric rail, not truncated 2-level rail
        assert.ok(manager._genesis.priceLevels.length > 2, `migration rail > truncated (${manager._genesis.priceLevels.length} vs 2)`);
        assert.ok(manager._genesis.priceLevels.length === full.priceLevels.length, 'migration rail matches full geometric rail length');
        process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
        if (origEnv === undefined) delete process.env.GRID_PRICE_SLOT_VALIDATION;

        // Cross-check: config edited across restarts (startPrice changed) → most slots mismatch → REFUSED.
        // The fail-closed migration policy (docs/GRID_PRICE_INVARIANT.md) no longer
        // "keeps the grid as-is without a ladder": loadGrid throws MissingGenesisError
        // before it mutates anything, so the caller rebuilds (or halts).
        const editedCfg = { ...cfg, startPrice: 200 };
        const manager2 = makeManagerForLoad({ config: editedCfg });
        let thrown: any = null;
        try {
            await loadGrid(manager2, truncatedGrid as any, full.boundaryIdx, null);
        } catch (e: any) { thrown = e; }
        assert.ok(thrown, 'edited config must refuse the snapshot');
        assert.strictEqual(thrown.name, 'MissingGenesisError', 'refusal is a MissingGenesisError');
        assert.strictEqual(thrown.reason, 'slot_mismatch', 'refusal reason is slot_mismatch');
        assert.strictEqual(thrown.policy, 'rebuild', 'default policy is rebuild');
        assert.ok(manager2.logs.some(l => l.includes('NOT adopting')), 'edited config triggers NOT adopting warning');
        assert.ok(manager2.logs.some(l => l.includes('[GENESIS] No usable price ladder')), 'refusal is logged');
        assert.ok(!manager2._genesis, 'refused snapshot never adopts the mismatched genesis');
        assert.strictEqual(manager2.orders.size, 0, 'refused snapshot leaves the manager untouched');
        assert.ok(manager2._missingGenesis && manager2._missingGenesis.reason === 'slot_mismatch',
            'fault recorded on the manager for observability');
    }

    // 11. Unparseable-id handling in loadGrid type reassignment
    for (const mode of ['log', 'enforce'] as const) {
        const g = makeGenesis();
        const persistedGrid = [
            { id: 'legacy-0', price: g.priceLevels[0], type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' },
            { id: 'slot-0', price: g.priceLevels[0], type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' },
        ];
        const origEnv = process.env.GRID_PRICE_SLOT_VALIDATION;
        process.env.GRID_PRICE_SLOT_VALIDATION = mode;
        const manager = makeManagerForLoad();
        await loadGrid(manager, persistedGrid, 0, g);
        const loaded = [...manager.orders.values()] as any[];
        const legacy = loaded.find((s: any) => s.id === 'legacy-0');
        // In both modes legacy id forced to SPREAD (log claims SPREAD placeholder, enforce virtualizes but type SPREAD)
        assert.strictEqual(legacy.type, ORDER_TYPES.SPREAD, `${mode} mode legacy id → SPREAD`);
        if (mode === 'enforce') assert.strictEqual(legacy.size, 0, 'enforce virtualizes');
        process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
        if (origEnv === undefined) delete process.env.GRID_PRICE_SLOT_VALIDATION;
    }

    // 12. createUncertain preservation (normal sized VIRTUAL must survive, flagged sized VIRTUAL zeroed)
    {
        const g = makeGenesis();
        const persistedGrid = [
            { id: 'slot-0', price: g.priceLevels[0], type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 100, orderId: '', createUncertain: true },
            { id: 'slot-1', price: g.priceLevels[1], type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 100, orderId: '' }, // normal sized VIRTUAL, no flag
        ];
        const manager = makeManagerForLoad();
        const origEnv = process.env.GRID_PRICE_SLOT_VALIDATION;
        process.env.GRID_PRICE_SLOT_VALIDATION = 'log';
        await loadGrid(manager, persistedGrid, 0, g);
        const loaded = [...manager.orders.values()] as any[];
        const flagged = loaded.find((s: any) => s.id === 'slot-0');
        const normal = loaded.find((s: any) => s.id === 'slot-1');
        assert.strictEqual(flagged.size, 0, 'flagged createUncertain sized VIRTUAL zeroed');
        assert.strictEqual(normal.size, 100, 'normal sized VIRTUAL preserved');
        process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
        if (origEnv === undefined) delete process.env.GRID_PRICE_SLOT_VALIDATION;
    }

    // 13. Re-sort gate: shuffled array with misaligned ids but unsorted prices must still re-sort
    {
        const g = makeGenesis();
        const ordered = g.priceLevels.slice(0, 3).map((p: any, i: number) => ({ id: `slot-${i}`, price: p, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0, orderId: '' }));
        const shuffled = [ordered[2], ordered[0], ordered[1]]; // ids 2,0,1 out of order, prices shuffled unsorted
        const manager = makeManagerForLoad();
        const origEnv = process.env.GRID_PRICE_SLOT_VALIDATION;
        process.env.GRID_PRICE_SLOT_VALIDATION = 'log';
        await loadGrid(manager, shuffled as any, 1, g);
        // After load, manager._genesis set and grid re-sorted to slot-N order
        assert.ok(manager.logs.some(l => l.includes('Re-sorted')), 'shuffled unsorted with misaligned ids triggers re-sort');
        process.env.GRID_PRICE_SLOT_VALIDATION = origEnv;
        if (origEnv === undefined) delete process.env.GRID_PRICE_SLOT_VALIDATION;
    }

    console.log('✓ All grid price-slot invariant tests passed');
}

if (require.main === module) {
    run().catch((err) => {
        console.error('✗ Test failed');
        console.error(err);
        process.exit(1);
    });
} else {
    module.exports = { run };
}
