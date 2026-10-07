const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// Regression test: spread correction must target the MARKET, not the rail.
//
// Production incident (a live market-pair bot, 292-slot rail, ~0.3%/slot):
// the live SELL window occupied slots 156-175 (best sell 1071.2) while 116
// empty sell slots lay above it, out to the grid ceiling at ~1605. Spread
// correction fired twice in one evening and created
//   1.7.574990982  sell slot-291 @ 1605.17
//   1.7.574991281  sell slot-290 @ 1600.36
// Neither order could narrow the spread by a single tick — both sat ~50%
// ABOVE bestSell — and the next full resync cancelled both as surplus
// ("Startup: Cancelled stale surplus SELL order"), so the resync existed only
// to clean up after the correction path.
//
// Two independent defects combined to produce this:
//
//   1. `sortCandidates` had two branches (windowFirst when the rail had live
//      orders, edgeFirst otherwise) that were written as exact OPPOSITES. The
//      SELL/windowed branch sorted DESCENDING and so resolved to the grid
//      ceiling. The two rails are not symmetric here: empty slots always sit
//      on the FAR side of the live window, so market-nearest and
//      window-adjacent are the SAME slot and one comparator serves both.
//
//   2. The merge order led with the rail-wide orphan pool, which was capped at
//      missingSlots on its own. With missingSlots=1 it consumed the entire
//      quota, so the gap-band promotion path — the only candidate kind that
//      can actually tighten the measured spread — was never even asked.
//
// The third guard (tightensSpread) is what makes the ceiling structurally
// unreachable rather than merely sorted last: sorting alone still resolves to
// the first empty slot PAST the window, which is on the wrong side of the
// live best price.
const INCREMENT = 0.3;
const price = (idx: number): number => 670.368 * Math.pow(1 + INCREMENT / 100, idx);

/**
 * Builds the manager with the production geometry:
 * BUY 0-150, gap band 151-155, SELL 156-291; live BUY 131-150 and live SELL
 * 156-175 (20 each), every other slot empty/virtual.
 */
async function buildProductionGeometry(
    manager: any,
    liveBuy: [number, number],
    liveSell: [number, number],
    totals: { buy: number; sell: number } = { buy: 0, sell: 500 }
) {
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    manager.config.weightDistribution = { buy: 0.5, sell: 0.5 };
    manager.btsBalance = { free: 1e9, total: 1e9, locked: 0 };

    const inRange = (i: number, r: [number, number]) => i >= r[0] && i <= r[1];
    for (let i = 0; i <= 291; i++) {
        const type = i <= 150
            ? ORDER_TYPES.BUY
            : (i >= 156 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        const live = inRange(i, liveBuy) || inRange(i, liveSell);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: price(i),
            type,
            state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: live ? 2 : 1.5,
            orderId: live ? `1.7.${500000 + i}` : ''
        });
    }
    manager.boundaryIdx = 150;
    manager._gapSlots = 5;
    await manager.setAccountTotals({
        buy: totals.buy, sell: totals.sell,
        buyFree: totals.buy, sellFree: totals.sell
    });
    await manager.recalculateFunds();
}

function newManager(funds: { buy: number; sell: number } = { buy: 0, sell: 500 }) {
    return new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1052.06,
        botFunds: { buy: funds.buy, sell: funds.sell },
        activeOrders: { buy: 20, sell: 20 },
        incrementPercent: INCREMENT,
        targetSpreadPercent: 1.5
    });
}

const idxOf = (id: string): number => Number(String(id).replace('slot-', ''));

// --- 1. SELL: the grid ceiling must be unreachable -------------------------
// Live sells stop at 165, so slots 156-164 are empty sell slots that sit BELOW
// bestSell and genuinely tighten the spread. 9 of them are candidates: the
// correction must take one of those, and must never reach up to the ceiling
// (slot-291) even though ~125 empty sell slots lie above the live window.
async function testSellNeverTargetsTheCeiling() {
    console.log('Running test: SELL correction never targets the grid ceiling');

    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [165, 175]);

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    const bestSell = price(165);
    assert.strictEqual(placed.length, 1, `Expected one correction slot, got ${JSON.stringify(placed)}`);
    for (const id of placed) {
        assert(
            price(idxOf(id)) < bestSell,
            `${id} @ ${price(idxOf(id)).toFixed(1)} must sit BELOW the best live sell ${bestSell.toFixed(1)} ` +
            'to narrow the spread; anything at or above it leaves the spread unchanged'
        );
    }
    assert(
        !placed.includes('slot-291') && !placed.includes('slot-290'),
        `Correction must never create at the grid ceiling; got ${JSON.stringify(placed)}`
    );
    // Window-contiguous: with the empty sells BELOW the live window, correction
    // must bridge from the window downward (the HIGHEST empty price), not start
    // at the far bottom of the gap — the latter leaves an interior hole between
    // the new order and the live window and over-tightens past the target.
    assert.strictEqual(
        placed[0], 'slot-164',
        `SELL correction must pick the empty closest to the live window (slot-165); got ${placed[0]}`
    );
    console.log(`  ✓ SELL targets a spread-tightening slot, not the ceiling (${JSON.stringify(placed)})`);
}

// --- 2. BUY: mirror of the same rule ---------------------------------------
// Live buys stop at 145, so slots 146-150 are empty buy slots ABOVE bestBuy.
async function testBuyNeverTargetsTheRailFloor() {
    console.log('Running test: BUY correction never targets the rail floor');

    const manager = newManager({ buy: 20000, sell: 0 });
    // Funded well above the per-slot dust floor: the buy rail carries 151
    // slots, so a thin budget would size every candidate below the minimum
    // order size and the assertion below would pass for the wrong reason.
    await buildProductionGeometry(manager, [131, 145], [156, 175], { buy: 20000, sell: 0 });

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    const bestBuy = price(145);
    assert.strictEqual(placed.length, 1, `Expected one correction slot, got ${JSON.stringify(placed)}`);
    for (const id of placed) {
        assert(
            price(idxOf(id)) > bestBuy,
            `${id} @ ${price(idxOf(id)).toFixed(1)} must sit ABOVE the best live buy ${bestBuy.toFixed(1)} ` +
            'to narrow the spread; anything at or below it leaves the spread unchanged'
        );
    }
    assert(
        !placed.includes('slot-0') && !placed.includes('slot-1'),
        `Correction must never create at the rail floor; got ${JSON.stringify(placed)}`
    );
    console.log(`  ✓ BUY targets a spread-tightening slot, not the floor (${JSON.stringify(placed)})`);
}

// --- 3. Gap band leads the merge -------------------------------------------
// With room in the band, the gap (the only kind of candidate that can tighten
// the spread) must be asked FIRST, before the rail-wide orphan pool.
async function testGapBandOutranksRailPool() {
    console.log('Running test: gap-band promotion outranks the rail pool');

    const manager = newManager();
    // Live buys stop at 148 (not 150), leaving stranding headroom (depth 2) so the band
    // can actually be entered; live sells start at 156 as before.
    await buildProductionGeometry(manager, [131, 148], [156, 175]);

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    assert(
        placed.length === 1,
        `Expected exactly one correction slot, got ${JSON.stringify(placed)}`
    );
    // Walk floor for SELL promotion = buyEndIdx + 1 + MIN_SPREAD_ORDERS(2) = 153.
    assert.strictEqual(
        placed[0], 'slot-155',
        'Gap-band slot (the band slot nearest the sell window) must win over any rail slot; the band is the only place a correction tightens the spread'
    );
    assert.strictEqual(
        correction.boundaryIdx, 149,
        'Boundary must slide one step to admit the promoted band slot'
    );
    console.log('  ✓ gap slot chosen over the rail pool, boundary slid 150 -> 149');
}

// --- 4. Locked gap: no-op with an explicit reason ---------------------------
// Both live windows flush against the band => promotion depth 0 => the spread
// is not correctable. The path must place NOTHING rather than a useless order,
// and must say why (silence is indistinguishable from "nothing was wrong").
async function testLockedGapPlacesNothing() {
    console.log('Running test: locked gap places nothing and explains why');

    const logs: string[] = [];
    const manager = newManager();
    await buildProductionGeometry(manager, [131, 150], [156, 175]);
    manager.logger = {
        log: (msg: string) => { logs.push(String(msg)); },
        logInfo: (msg: string) => { logs.push(String(msg)); }
    } as any;

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);

    assert.deepStrictEqual(
        correction.ordersToPlace, [],
        'With promotion depth 0 and no spread-tightening rail slot, the correction must place nothing'
    );
    const joined = logs.join('\n');
    assert(
        /no gap slot available on sell/.test(joined),
        `Expected an explicit "no gap slot" reason, got:\n${joined}`
    );
    assert(
        /stranding cap is 0/.test(joined),
        `The diagnostic must name the binding constraint (stranding cap); got:\n${joined}`
    );
    assert(
        /not correctable on this side this cycle/.test(joined),
        'The locked-gap log must state that the spread is not correctable'
    );
    console.log('  ✓ no placement, and the binding constraint is named');
}

// --- 5. Empty rail: guard must stay open ------------------------------------
// With no live order on the side there is no reference price to improve, so
// the market-nearest empty slot is by definition the best available and MUST
// still be creatable (a hard "must be below best" rule would strand the rail).
async function testEmptyRailStillPlaces() {
    console.log('Running test: empty rail still places market-nearest');

    const manager = newManager();
    // No live SELL anywhere on the rail: the whole sell side is empty.
    await buildProductionGeometry(manager, [131, 150], [292, 293]);
    await manager.setAccountTotals({ buy: 0, sell: 500, buyFree: 0, sellFree: 500 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    assert.strictEqual(
        placed.length, 1,
        `An empty rail must remain correctable; got ${JSON.stringify(placed)}`
    );
    assert.strictEqual(
        placed[0], 'slot-156',
        'With no live sell, the lowest empty sell slot is the best possible first order'
    );
    console.log('  ✓ empty rail places the market-nearest sell slot');
}

// --- 5. Every blocked-promotion reason is distinguishable -------------------
// Promotion can yield nothing for three operationally different reasons, and a
// config change fixes only one of them.  All three must be named, not collapsed
// into a bare "skipped".
async function testAllBlockedReasonsAreDistinguishable() {
    console.log('Running test: blocked-promotion reasons are distinguishable');

    const run = async (cfg: any) => {
        const logs: string[] = [];
        const manager = newManager({ buy: 0, sell: 20000 });
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
        };
        manager.config.weightDistribution = { buy: 0.5, sell: 0.5 };
        manager.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
        manager.logger = { log: (msg: string) => { logs.push(String(msg)); } } as any;
        for (let i = 0; i <= 60; i++) {
            const type = i <= 40
                ? ORDER_TYPES.BUY
                : (i >= 40 + cfg.gapSlots + 1 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
            const live = (i >= cfg.liveBuy[0] && i <= cfg.liveBuy[1])
                || (i >= cfg.liveSell[0] && i <= cfg.liveSell[1]);
            await manager._updateOrder({
                id: `slot-${i}`, price: price(i), type,
                state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                size: live ? 2 : 1.5,
                orderId: live ? `1.7.${500000 + i}` : ''
            });
        }
        // liveBuy stops at 38 (buyEndIdx is 40) so the stranding cap leaves
        // headroom; the intended constraint is the only thing that blocks.
        manager.boundaryIdx = 40;
        manager._gapSlots = cfg.gapSlots;
        await manager.setAccountTotals({ buy: 0, sell: 20000, buyFree: 0, sellFree: 20000 });
        await manager.recalculateFunds();
        const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
        return { placed: correction.ordersToPlace.map((o: any) => o.id), logs };
    };

    // bandSize (2) == MIN_SPREAD_ORDERS (2) -> reserve-blocked
    const reserved = await run({ gapSlots: 2, liveBuy: [36, 38], liveSell: [43, 50] });
    assert.deepStrictEqual(reserved.placed, [], 'Reserve-blocked band must place nothing');
    assert(
        /MIN_SPREAD_ORDERS reserve/.test(reserved.logs.join('\n')),
        'Reserve-blocked must be named as such (a config change is the fix)'
    );

    // bandSize (6) but the slot adjacent to the sell edge is placed -> walk breaks
    const noRun = await run({ gapSlots: 6, liveBuy: [36, 38], liveSell: [46, 50] });
    assert.deepStrictEqual(noRun.placed, [], 'Non-contiguous band must place nothing');
    assert(
        /no contiguous empty run/.test(noRun.logs.join('\n')),
        'Non-contiguous band must be named as such (a geometry change is the fix)'
    );
    console.log('  ✓ reserve-blocked and no-contiguous-run are both named');
}

(async () => {
    await testSellNeverTargetsTheCeiling();
    await testBuyNeverTargetsTheRailFloor();
    await testGapBandOutranksRailPool();
    await testLockedGapPlacesNothing();
    await testAllBlockedReasonsAreDistinguishable();
    await testEmptyRailStillPlaces();
    console.log('PASS test_spread_correction_market_nearest');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
