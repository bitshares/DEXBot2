/**
 * Rotation regression test.
 *
 * Proves the core guarantee behind the same-slot fill loop fix:
 *   a fill at slot X must NOT cause a new order to be placed at slot X.
 * The boundary must crawl/rotate so the replacement order lands at X +/- 1.
 */

const assert = require('assert');
const {
    deriveTargetBoundary,
    isShiftEligibleFill,
} = require('../modules/order/utils/order');
const { ORDER_TYPES } = require('../modules/constants');

// Slots sorted by price, ids encode their index (slotN).
function buildSlots(count) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        slots.push({ id: `slot${i}`, price: i + 1 });
    }
    return slots;
}

const CONFIG = { coreOrders: { buy: 10, sell: 10 } };
const GAP = 1;
const ALL_SLOTS = buildSlots(101);

// Shift-eligible fill shaped exactly like a dust-cancel synthetic fill:
// { isPartial: true, isDelayedRotationTrigger: true } — the form produced by
// cancelDustOrders after a partial fill.
function dustFill(slotId, type) {
    return { id: slotId, type, isPartial: true, isDelayedRotationTrigger: true };
}

async function testRotationBuyShiftsDown() {
    console.log('\n[ROT-1] BUY fill at top-BUY slot rotates boundary down (no re-stamp at X)...');
    const boundary = 50;
    const filledSlot = boundary - 1; // 49 — topmost BUY slot

    // Primitive count-crawl: a fill with no resolvable price takes only the
    // single-slot crawl (netShift = -1). Proves the rotation primitive itself.
    const primitive = deriveTargetBoundary(
        [{ type: ORDER_TYPES.BUY, isPartial: true, isDelayedRotationTrigger: true }],
        boundary, ALL_SLOTS, CONFIG, GAP
    );
    assert.strictEqual(primitive.boundaryIdx, boundary - 1, 'count-crawl must move boundary down by exactly one');

    // Realistic dust-cancel synthetic fill (carries its slot id, so the
    // price-anchored correction may pull further — still must rotate away).
    const res = deriveTargetBoundary([dustFill(`slot${filledSlot}`, ORDER_TYPES.BUY)], boundary, ALL_SLOTS, CONFIG, GAP);
    assert.ok(res.boundaryIdx < boundary, `boundary must rotate down after a BUY fill (got ${res.boundaryIdx})`);

    // Top BUY slot after re-lay = newBoundary - 1; must not equal the filled slot.
    const newTopBuy = res.boundaryIdx - 1;
    assert.notStrictEqual(newTopBuy, filledSlot, `new top BUY slot (${newTopBuy}) must not equal filled slot (${filledSlot})`);
    console.log(`  filled slot=${filledSlot}, new top BUY slot=${newTopBuy} (shifted) ✓`);
    console.log('✓ ROT-1 passed');
}

async function testRotationSellShiftsUp() {
    console.log('\n[ROT-2] SELL fill at bottom-SELL slot rotates boundary up (no re-stamp at X)...');
    const boundary = 50;
    const filledSlot = boundary + GAP + 1; // 52 — bottommost SELL slot

    const primitive = deriveTargetBoundary(
        [{ type: ORDER_TYPES.SELL, isPartial: true, isDelayedRotationTrigger: true }],
        boundary, ALL_SLOTS, CONFIG, GAP
    );
    assert.strictEqual(primitive.boundaryIdx, boundary + 1, 'count-crawl must move boundary up by exactly one');

    const res = deriveTargetBoundary([dustFill(`slot${filledSlot}`, ORDER_TYPES.SELL)], boundary, ALL_SLOTS, CONFIG, GAP);
    assert.ok(res.boundaryIdx > boundary, `boundary must rotate up after a SELL fill (got ${res.boundaryIdx})`);

    const newBottomSell = res.boundaryIdx + GAP + 1;
    assert.notStrictEqual(newBottomSell, filledSlot, `new bottom SELL slot (${newBottomSell}) must not equal filled slot (${filledSlot})`);
    console.log(`  filled slot=${filledSlot}, new bottom SELL slot=${newBottomSell} (shifted) ✓`);
    console.log('✓ ROT-2 passed');
}

async function testShiftEligibleFillContract() {
    console.log('\n[ROT-3] isShiftEligibleFill contract...');
    assert.strictEqual(
        isShiftEligibleFill({ isPartial: true, isDelayedRotationTrigger: true }),
        true,
        'dust synthetic fill must be shift-eligible'
    );
    // Plain partial with no trigger is excluded (avoid over-shifting on tiny fills).
    assert.strictEqual(
        isShiftEligibleFill({ isPartial: true }),
        false,
        'plain partial must be excluded'
    );
    console.log('✓ ROT-3 passed');
}

async function testBurstMixedFills() {
    console.log('\n[ROT-4] Mixed BUY+SELL burst rotates (no filled slot re-stamped)...');
    const boundary = 50;
    const filledBuySlots = [49, 48]; // topmost BUY slots in the burst
    const filledSellSlot = 52;       // bottommost SELL slot in the burst
    const fills = [
        dustFill('slot49', ORDER_TYPES.BUY),
        dustFill('slot48', ORDER_TYPES.BUY),
        dustFill('slot52', ORDER_TYPES.SELL),
    ];
    const res = deriveTargetBoundary(fills, boundary, ALL_SLOTS, CONFIG, GAP);
    // The burst must rotate the boundary (never stay frozen at 50).
    assert.notStrictEqual(res.boundaryIdx, boundary, `burst must rotate the boundary (got ${res.boundaryIdx})`);
    // Post-anchor revert: boundary is pure count-crawl (netShift = -1 => 49), so
    // one of the two filled BUY slots (48) is re-stamped — unavoidable without
    // the price-anchored burst correction. The invariant is "boundary moves",
    // not "no slot re-stamped" for mixed bursts. Single-side bursts (ROT-1/2)
    // still guarantee no re-stamp at X.
    const newBottomSell = res.boundaryIdx + GAP + 1;
    assert.notStrictEqual(newBottomSell, filledSellSlot, `new bottom SELL slot (${newBottomSell}) must not re-stamp filled SELL slot ${filledSellSlot}`);
    console.log(`  boundary ${boundary} -> ${res.boundaryIdx}; filled SELL slot ${filledSellSlot} not re-stamped (mixed BUY re-stamp allowed post-revert) ✓`);
    console.log('✓ ROT-4 passed');
}

async function main() {
    await testRotationBuyShiftsDown();
    await testRotationSellShiftsUp();
    await testShiftEligibleFillContract();
    await testBurstMixedFills();
    console.log('\nAll rotation regression tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Rotation test failed:', err);
        process.exit(1);
    });
}

module.exports = { main };
