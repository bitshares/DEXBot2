/**
 * tests/test_cow_crossing_guard.ts
 *
 * Regression tests for findCrossedOrder — the crossing-placement guard
 * introduced after a production self-trade incident.
 *
 * Incident pattern: a startup buy order was re-priced in-place onto a
 * live sell ladder while the ladder was still being cancelled in later
 * broadcast chunks. The chain has no self-trade prevention, so the
 * re-priced buy matched our own sells during the chunked broadcast
 * window, producing multiple self-fills and a subsequent chain-side fund
 * assertion. A same-price check could not catch this; findCrossedOrder
 * catches crossings at ANY price overlap.
 *
 * These tests pin the crossing semantics the COW runtime depends on:
 * - BUY candidate crosses opposite-side orders priced at or below it.
 * - SELL candidate crosses opposite-side orders priced at or above it.
 * - Same-type orders never cross.
 * - The caller's isValid filter implements the exemption policy (orders
 *   already cancelled earlier in the same plan are excluded).
 */
const assert = require('assert');
const { findCrossedOrder, pricesOnSameLevel } = require('../modules/order/utils/math');
const { ORDER_TYPES } = require('../modules/constants');

const ASSETS = {
    assetA: { id: '1.3.0', precision: 6, symbol: 'ASSET_A' },
    assetB: { id: '1.3.1', precision: 6, symbol: 'ASSET_B' }
};

// Synthetic sell ladder at 1% price steps (generic incident-scale shape)
function buildSellLadder() {
    const ladder = [];
    for (let i = 0; i < 20; i++) {
        ladder.push({
            id: `slot-${112 + i}`,
            orderId: `1.7.9900000${i}`,
            price: 865.3848 * Math.pow(1.01, i),
            type: ORDER_TYPES.SELL,
            size: 0.06
        });
    }
    return ladder;
}

function run() {
    console.log('Running cow crossing guard (findCrossedOrder) tests...');

    // ---- 1. Re-priced buy lands ON the live sell ladder.
    // (A candidate price overlapping the ladder must be flagged as crossing;
    // a candidate below the ladder is a healthy book and must NOT be flagged.)
    const ladder = buildSellLadder();
    const crossed = findCrossedOrder(ladder, 865.378, ORDER_TYPES.BUY, ASSETS);
    assert(crossed, 'buy @865.378 must cross the live sell @865.3848');
    assert.strictEqual(crossed.type, ORDER_TYPES.SELL, 'crossed order must be a SELL');
    const { calculatePriceTolerance } = require('../modules/order/utils/math');
    const tol = calculatePriceTolerance(Math.min(865.3848, 865.378), 0.06, ORDER_TYPES.BUY, ASSETS);
    assert(Number(crossed.price) <= 865.378 + tol, `crossed sell price ${crossed.price} must be within tolerance of candidate price`);
    const belowLadder = findCrossedOrder(ladder, 862.81, ORDER_TYPES.BUY, ASSETS);
    assert.strictEqual(belowLadder, null, 'buy @862.81 below the ladder is a healthy book, not a crossing');
    console.log('  - incident vector: buy re-priced onto the ladder is flagged; below-ladder buys are not');

    // ---- 2. Clean gap: buy below every sell crosses nothing
    const clean = findCrossedOrder(ladder, 858.0, ORDER_TYPES.BUY, ASSETS);
    assert.strictEqual(clean, null, 'buy @858 below the whole ladder must not cross');
    console.log('  - clean gap: buy below ladder crosses nothing');

    // ---- 3. Same-type orders never cross (both directions)
    const sameTypeBuy = findCrossedOrder([
        { id: 'b1', orderId: '1.7.1', price: 805.198, type: ORDER_TYPES.BUY, size: 0.06 },
        { id: 'b2', orderId: '1.7.2', price: 852.1, type: ORDER_TYPES.BUY, size: 0.06 }
    ], 862.81, ORDER_TYPES.BUY, ASSETS);
    assert.strictEqual(sameTypeBuy, null, 'buy candidate must not cross buys');
    const sameTypeSell = findCrossedOrder(ladder, 900.0, ORDER_TYPES.SELL, ASSETS);
    assert.strictEqual(sameTypeSell, null, 'sell candidate must not cross sells');
    console.log('  - same-type candidates never cross');

    // ---- 4. Sell candidate crosses buys priced at or above it
    const buys = [
        { id: 'b1', orderId: '1.7.1', price: 905.0, type: ORDER_TYPES.BUY, size: 0.06 },
        { id: 'b2', orderId: '1.7.2', price: 910.0, type: ORDER_TYPES.BUY, size: 0.06 }
    ];
    const crossedSell = findCrossedOrder(buys, 900.0, ORDER_TYPES.SELL, ASSETS);
    assert(crossedSell, 'sell @900 must cross live buys @905+');
    assert.strictEqual(crossedSell.id, 'b1', 'must report the first (lowest) crossed buy');
    const cleanSell = findCrossedOrder(buys, 911.0, ORDER_TYPES.SELL, ASSETS);
    assert.strictEqual(cleanSell, null, 'sell @911 above all buys must not cross');
    console.log('  - sell candidate crosses buys at or above it');

    // ---- 5. Exact overlap counts as crossing (re-pricing to the same price
    // as an opposite-side live order self-trades immediately)
    const exact = findCrossedOrder(
        [{ id: 's1', orderId: '1.7.3', price: 865.3848, type: ORDER_TYPES.SELL, size: 0.06 }],
        865.3848, ORDER_TYPES.BUY, ASSETS
    );
    assert(exact, 'buy re-priced exactly onto a live sell price must be flagged');
    console.log('  - exact opposite-side price overlap flagged');

    // ---- 6. Full master set via Map.values() (manager.orders shape)
    const master = new Map();
    for (let i = 0; i < 6; i++) {
        master.set(`slot-${88 + i}`, {
            id: `slot-${88 + i}`,
            orderId: `1.7.9800000${i}`,
            price: 805.198 * Math.pow(1.01, i),
            type: ORDER_TYPES.BUY,
            size: 0.06
        });
    }
    for (const s of ladder) master.set(s.id, { ...s });
    const fromMap = findCrossedOrder(master.values(), 865.378, ORDER_TYPES.BUY, ASSETS);
    assert(fromMap, 'candidate buy must cross within the full incident master set');
    assert.strictEqual(fromMap.type, ORDER_TYPES.SELL);
    console.log('  - crossing detected through Map.values() iteration');

    // ---- 7. Exemption policy: orders cancelled earlier in the same plan are
    // excluded via the isValid filter (runtime semantics: orderId is in the
    // already-queued cancel-op set)
    const exempted = findCrossedOrder(
        master.values(),
        865.378,
        ORDER_TYPES.BUY,
        ASSETS,
        (o) => o.orderId !== fromMap.orderId
    );
    // Removing the lowest sell (@865.38) still leaves the ladder from @874.04
    // un-crossed by @865.378 -> must be null.
    assert.strictEqual(exempted, null, 'with the only crossing sell exempted, nothing else may cross');
    const exemptHighestOnly = findCrossedOrder(
        master.values(),
        865.378,
        ORDER_TYPES.BUY,
        ASSETS,
        (o) => o.orderId !== '1.7.990000019' // exempt a NON-crossing sell: no effect
    );
    assert(exemptHighestOnly, 'exempting an unrelated order must still detect the crossing');
    console.log('  - isValid filter implements the same-plan cancel exemption');

    // ---- 8. Nested order shape (item.order.price / item.order.type)
    const nested = findCrossedOrder(
        [{ id: 'n1', order: { orderId: '1.7.4', price: 865.3848, type: ORDER_TYPES.SELL }, size: 0.06 }],
        865.378, ORDER_TYPES.BUY, ASSETS
    );
    assert(nested, 'nested order shape must be supported');
    console.log('  - nested item.order shape supported');

    // ---- 9. Invalid inputs are rejected defensively
    assert.strictEqual(findCrossedOrder(ladder, null, ORDER_TYPES.BUY, ASSETS), null, 'null price');
    assert.strictEqual(findCrossedOrder(ladder, NaN, ORDER_TYPES.BUY, ASSETS), null, 'NaN price');
    assert.strictEqual(findCrossedOrder(ladder, 862.81, null, ASSETS), null, 'null type');
    assert.strictEqual(findCrossedOrder([], 862.81, ORDER_TYPES.BUY, ASSETS), null, 'empty items');
    assert.strictEqual(
        findCrossedOrder([{ id: 'x', orderId: '1.7.9', price: 860.0, type: ORDER_TYPES.SELL, size: 0 }],
            862.81, ORDER_TYPES.BUY, ASSETS),
        null,
        'size-0 placeholder must be skipped (matches the size-0 null-tolerance convention)'
    );
    console.log('  - invalid/placeholder inputs handled defensively');

    // ---- 10. Complementarity: every same-price collision between opposite
    // sides is also a crossing detection
    const items = [
        { id: 's1', orderId: '1.7.3', price: 865.3848, type: ORDER_TYPES.SELL, size: 0.06 },
        { id: 's2', orderId: '1.7.4', price: 869.44, type: ORDER_TYPES.SELL, size: 0.06 }
    ];
    const samePrice = pricesOnSameLevel(865.3848, 0.06, ORDER_TYPES.SELL, 865.3848, 0.06, ORDER_TYPES.BUY, ASSETS);
    const byCrossing = findCrossedOrder(items, 865.3848, ORDER_TYPES.BUY, ASSETS);
    assert(samePrice, 'same-price collision detected by pricesOnSameLevel');
    assert(byCrossing, 'same-price overlap also detected by findCrossedOrder');
    console.log('  - findCrossedOrder supersedes the same-price check for opposite-side overlap');

    console.log('PASS test_cow_crossing_guard');
}

try {
    run();
} catch (err) {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
}
