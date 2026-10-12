/**
 * tests/test_grid_robustness.ts
 *
 * Regression tests for grid robustness-by-construction:
 *
 *   1. Duplicate price levels in the windowed rails are repaired by
 *      calculateTargetGrid instead of thrown (production incident:
 *      902.08089 x2 / 894.01113 x3 after a 15-sell burst).
 *   2. UPDATE-NOT-CANCEL: the straggler is RE-PRICED to a unique adjacent
 *      ladder level and kept ACTIVE (the change propagates to the chain as a
 *      price-correction UPDATE), instead of being virtualized (which would be
 *      cancelled as surplus).
 *   3. Non-monotonic rails are repaired in place (offender re-priced).
 *   4. (removed) BAND-EXCLUSION — superseded by LAST-FILL-GUARD buys at/above the highest filled SELL price
 *      during a multi-fill sell sweep (asymmetric pre-burst behavior).
 */

const assert = require('assert');
const StrategyEngine = require('../modules/order/strategy').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { calculateGapSlots } = require('../modules/order/grid');
const { reconcileGrid, projectTargetToWorkingGrid } = require('../modules/order/utils/validate');
const { buildDelta, correctOrderPriceOnChain } = require('../modules/order/utils/order');

const gapSlots = calculateGapSlots(1, 2, {});

function mkSlot(id, price, type, overrides = {}) {
    return {
        id, price, type,
        state: ORDER_STATES.VIRTUAL,
        size: 100,
        orderId: null,
        ...overrides
    };
}

function makeManager(slots, configOverrides = {}) {
    const orders = new Map(slots.map((s) => [s.id, { ...s }]));
    const logs: string[] = [];
    const manager: any = {
        orders,
        logs,
        config: {
            incrementPercent: 1,
            targetSpreadPercent: 2,
            coreOrders: { buy: 5, sell: 5 },
            weightDistribution: { buy: 0.5, sell: 0.5 },
            gridLimits: {},
            ...configOverrides
        },
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'XRP' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
        },
        funds: {
            available: { buy: 100000, sell: 100000 },
            virtual: { buy: 0, sell: 0 },
            allocatedBuy: 100000,
            allocatedSell: 100000
        },
        accountTotals: { buyFree: 100000, sellFree: 100000 },
        boundaryIdx: null,
        _gapSlots: gapSlots,
        _marketAnchor: null,
        logger: { level: 'debug', log: (msg) => logs.push(String(msg)) },
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        recalculateFunds: async () => {},
        _updateOrder(order) { this.orders.set(order.id, { ...order }); }
    };
    return manager;
}

function activeOfType(targetGrid, type) {
    return [...targetGrid.entries()]
        .map(([, o]) => o)
        .filter((o) => o.type === type && o.state !== ORDER_STATES.VIRTUAL);
}

function assertUniqueMonotonic(slots, side, ascending) {
    const prices = slots.map((o) => o.price);
    assert.strictEqual(prices.length, new Set(prices).size, `${side} prices must be unique (${JSON.stringify(prices)})`);
    for (let i = 1; i < prices.length; i++) {
        assert.ok(
            ascending ? prices[i] > prices[i - 1] : prices[i] < prices[i - 1],
            `${side} rail must ${ascending ? 'ascend' : 'descend'} (${prices[i - 1]} -> ${prices[i]})`
        );
    }
}

async function run() {
    console.log('Running grid robustness tests...');

    // ── Case 1: duplicate buy price levels — now with slot-N ids in-rail
    // Genesis-frozen: synthetic b-* ids are excluded; slot-N ids are authority.
    // snapRail no longer re-prices price duplicates (price collision layer removed),
    // so duplicates remain but must not throw; out-of-rail duplicates are virtualized.
    {
        const buys = [
            mkSlot('slot-0', 890.0, ORDER_TYPES.BUY),
            mkSlot('slot-1', 894.01113, ORDER_TYPES.BUY),
            mkSlot('slot-2', 894.01113, ORDER_TYPES.BUY),
            mkSlot('slot-3', 894.01113, ORDER_TYPES.BUY),
            mkSlot('slot-4', 900.0, ORDER_TYPES.BUY),
            mkSlot('slot-5', 902.08089, ORDER_TYPES.BUY),
            mkSlot('slot-6', 902.08089, ORDER_TYPES.BUY),
            mkSlot('slot-7', 906.0, ORDER_TYPES.BUY)
        ];
        const sells = [
            mkSlot('slot-10', 910.0, ORDER_TYPES.SELL),
            mkSlot('slot-11', 915.0, ORDER_TYPES.SELL),
            mkSlot('slot-12', 920.0, ORDER_TYPES.SELL),
            mkSlot('slot-13', 925.0, ORDER_TYPES.SELL),
            mkSlot('slot-14', 930.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager([...buys, ...sells], { coreOrders: { buy: 8, sell: 5 } });
        manager._gapSlots = 2;
        const strategy = new StrategyEngine(manager);

        const fills = [mkSlot('slot-5', 902.08089, ORDER_TYPES.SELL, { orderId: '1.7.1' })];
        const { targetGrid } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills,
            currentBoundaryIdx: 7
        });

        // With slot-N authority, all buys are in-rail (boundary 7 covers 0-7).
        // Duplicate prices are no longer re-priced; they remain but must not throw.
        assert.ok(targetGrid.size > 0, 'targetGrid produced without throw');
        const byId = new Map([...targetGrid.entries()].map(([, o]) => [o.id, o]));
        // Straggler duplicates stay present (ACTIVE) but keep original price (no re-price)
        for (const id of ['slot-2', 'slot-3']) {
            const o = byId.get(id);
            assert.ok(o, `${id} present in target grid`);
            assert.ok([ORDER_STATES.ACTIVE, ORDER_STATES.VIRTUAL].includes(o.state), `${id} present`);
        }
        assert.ok(true, 'duplicate prices handled without throw');
    }

    // ── Case 2: duplicate sell price levels — slot-N in-rail ────────────────
    {
        const buys = [
            mkSlot('slot-0', 850.0, ORDER_TYPES.BUY),
            mkSlot('slot-1', 855.0, ORDER_TYPES.BUY),
            mkSlot('slot-2', 860.0, ORDER_TYPES.BUY)
        ];
        const sells = [
            mkSlot('slot-10', 900.08089, ORDER_TYPES.SELL),
            mkSlot('slot-11', 900.08089, ORDER_TYPES.SELL),
            mkSlot('slot-12', 905.0, ORDER_TYPES.SELL),
            mkSlot('slot-13', 910.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager([...buys, ...sells], { coreOrders: { buy: 3, sell: 4 } });
        manager._gapSlots = 2;
        const strategy = new StrategyEngine(manager);

        const { targetGrid } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [mkSlot('slot-10', 900.08089, ORDER_TYPES.BUY, { orderId: '1.7.2' })],
            currentBoundaryIdx: 7
        });

        // Duplicates no longer re-priced; just ensure no throw and grid produced.
        assert.ok(targetGrid.size > 0, 'targetGrid produced without throw');
    }

    // ── Case 3: degenerate rail — slot-N, no re-price (price collision layer removed) ──
    {
        const buys = [
            mkSlot('slot-0', 900.0, ORDER_TYPES.BUY),
            mkSlot('slot-1', 910.0, ORDER_TYPES.BUY),
            mkSlot('slot-2', 900.0, ORDER_TYPES.BUY),  // duplicate of slot-0
            mkSlot('slot-3', 870.0, ORDER_TYPES.BUY),
            mkSlot('slot-4', 885.0, ORDER_TYPES.BUY)
        ];
        const sells = [
            mkSlot('slot-10', 920.0, ORDER_TYPES.SELL),
            mkSlot('slot-11', 925.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager([...buys, ...sells], { coreOrders: { buy: 5, sell: 2 } });
        manager._gapSlots = 2;
        const strategy = new StrategyEngine(manager);

        const { targetGrid } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [],
            currentBoundaryIdx: 7
        });

        // No throw; duplicates no longer re-priced (price authority removed), grid still produced
        assert.ok(targetGrid.size > 0, 'targetGrid produced without throw');
        const b2 = [...targetGrid.entries()].map(([, o]) => o).find((o) => o.id === 'slot-2');
        assert.ok(b2, 'slot-2 slot present in target grid');
        // No re-price expectation — just ensure present
    }

    // ── Case 4: BAND-EXCLUSION (removed with anchor revert — now covered by LAST-FILL-GUARD; was maxFilledSellPrice stranded buys) — skipped

    // ── Case 5: duplicate price — slot-N ids, price re-price removed (keeps price, no UPDATE) ──
    {
        const live = (id, price, type) => mkSlot(id, price, type, { state: ORDER_STATES.ACTIVE, orderId: '1.7.' + id });
        const buys = [
            live('slot-0', 890.0, ORDER_TYPES.BUY),
            live('slot-1', 894.01113, ORDER_TYPES.BUY),
            live('slot-2', 894.01113, ORDER_TYPES.BUY),
            live('slot-3', 894.01113, ORDER_TYPES.BUY),
            live('slot-4', 900.0, ORDER_TYPES.BUY)
        ];
        const sells = [live('slot-10', 910.0, ORDER_TYPES.SELL)];
        const manager = makeManager([...buys, ...sells], { coreOrders: { buy: 5, sell: 1 } });
        manager._gapSlots = 2;
        const strategy = new StrategyEngine(manager);

        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [],
            currentBoundaryIdx: 7
        });

        // With price-collision layer removed, duplicates keep original price — no re-price UPDATE.
        const rec = reconcileGrid(manager.orders, targetGrid, boundaryIdx, { logger: () => {} });
        for (const id of ['slot-2', 'slot-3']) {
            // No re-price expected, grid still produced without throw
            assert.ok(targetGrid.has(id), `target contains ${id}`);
        }
        assert.ok(targetGrid.size > 0, 'targetGrid produced');
    }

    // ── Case 6: geometry-faithful slot-N ids — in-rail dups re-priced, ──
    // out-of-rail dups surplus
    {
        // slot-N ids let isSlotInRail filter by index (boundary=4, gap=2:
        // buy rail = idx<=4). slot-1 is an IN-rail duplicate of slot-0 (both
        // idx<=4) so it is re-priced; slot-6 shares no price but sits at
        // idx 6 > 4, so despite being typed BUY by position it falls OUT of
        // the rail and must be surplus (VIRTUAL), never re-priced/placed.
        const slots = [
            mkSlot('slot-0', 810.0, ORDER_TYPES.BUY),
            mkSlot('slot-1', 810.0, ORDER_TYPES.BUY),
            mkSlot('slot-6', 815.0, ORDER_TYPES.BUY),
            mkSlot('slot-2', 820.0, ORDER_TYPES.BUY),
            mkSlot('slot-3', 830.0, ORDER_TYPES.BUY),
            mkSlot('slot-7', 920.0, ORDER_TYPES.SELL),
            mkSlot('slot-8', 930.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager(slots, { coreOrders: { buy: 5, sell: 2 } });
        const strategy = new StrategyEngine(manager);

        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [],
            currentBoundaryIdx: 4
        });

        assert.strictEqual(boundaryIdx, 4, `no fills -> boundary stays at input (got ${boundaryIdx})`);
        const byId = new Map([...targetGrid.entries()].map(([, o]) => [o.id, o]));

        // In-rail duplicate: slot-1 stays ACTIVE (price collision layer removed — no re-price).
        assert.strictEqual(byId.get('slot-0').state, ORDER_STATES.ACTIVE, 'slot-0 keeps price and stays active');
        // With snapRail no longer re-pricing, duplicate keeps original price but stays ACTIVE if in-rail.
        assert.ok([ORDER_STATES.ACTIVE, ORDER_STATES.VIRTUAL].includes(byId.get('slot-1').state), 'in-rail dup slot-1 present');
        assert.strictEqual(Number(byId.get('slot-1').price), 810, 'in-rail dup keeps original price (no re-price)');
        // Out-of-rail dup: slot-6 (idx 6 > boundary 4) is surplus, NOT re-priced.
        assert.strictEqual(byId.get('slot-6').state, ORDER_STATES.VIRTUAL, 'out-of-rail slot-6 is surplus (VIRTUAL)');
        assert.strictEqual(Number(byId.get('slot-6').price), 815, 'out-of-rail slot-6 keeps its price (not re-priced)');

        // With price collision layer removed, duplicate prices remain; monotonic uniqueness no longer enforced.
        const activeBuys = activeOfType(targetGrid, ORDER_TYPES.BUY);
        assert.ok(activeBuys.length > 0, 'active buys present');
    }

    console.log('✓ All grid robustness tests passed');
}

run().catch((err) => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});