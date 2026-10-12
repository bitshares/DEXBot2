/**
 * tests/test_null_boundary_reconcile.ts
 *
 * Verifies the Finding-3 fix: when boundaryIdx is null (unknown), the
 * boundaryKnown guard in _pickVirtualSlotsToActivate prevents SPREAD-typed
 * empty slots from being picked — only concrete BUY/SELL types are accepted.
 *
 * When boundary IS known, in-rail SPREAD-typed slots ARE accepted and re-typed
 * to the concrete side before activation.
 *
 * This is the riskiest new guard: without it, null boundary (Number(null)===0)
 * silently biases all slots to SELL, starving the BUY rail. The guard ensures
 * that when geometry can't classify an empty slot, the safe action is to not
 * activate it rather than guess a side.
 */
const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const {
    _pickVirtualSlotsToActivate,
} = require('../modules/order/grid_reconcile_internal');

function buildPrice(i: number, base = 100, step = 1) {
    return base + i * step;
}

function buildManager({
    boundaryIdx = null,
    gapSlots = 4,
    slots = [],
    funds = null,
    weightDistribution = { buy: 0.5, sell: 0.5 },
    coreOrders = { buy: 10, sell: 10 },
}) {
    const orders = new Map();
    for (const s of slots) {
        orders.set(s.id, {
            ...s,
            price: buildPrice(parseInt(String(s.id).split('-')[1], 10)),
        });
    }

    const manager: any = {
        _gapSlots: gapSlots,
        boundaryIdx,
        orders,
        config: {
            startPrice: 100,
            incrementPercent: 1,
            targetSpreadPercent: 2,
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5 },
            coreOrders,
            weightDistribution,
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0,
            assetA: 'XRP',
            assetB: 'BTS',
            market: 'XRP/BTS',
        },
        assets: {
            assetA: { id: '1.3.121', symbol: 'XRP', precision: 5 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        },
        getChainFundsSnapshot: () => funds,
    };
    return manager;
}

function makeSpread(id: string) {
    return {
        id,
        type: ORDER_TYPES.SPREAD,
        state: ORDER_STATES.VIRTUAL,
        size: 0,
        orderId: null,
    };
}

function makeBuy(id: string, size = 10, state = ORDER_STATES.ACTIVE) {
    return {
        id,
        type: ORDER_TYPES.BUY,
        state,
        size,
        orderId: state === ORDER_STATES.ACTIVE ? `1.7.${100 + parseInt(id.split('-')[1])}` : null,
    };
}

function makeSell(id: string, size = 10, state = ORDER_STATES.ACTIVE) {
    return {
        id,
        type: ORDER_TYPES.SELL,
        state,
        size,
        orderId: state === ORDER_STATES.ACTIVE ? `1.7.${200 + parseInt(id.split('-')[1])}` : null,
    };
}

// Funds that provide budget for both rails so _pickVirtualSlotsToActivate
// actually derives sizes and picks slots (not a trivial early-return).
const TEST_FUNDS = {
    allocatedBuy: 500,
    allocatedSell: 500,
    chainFreeBuy: 0,
    chainFreeSell: 0,
};

async function testNullBoundaryRejectsSpread() {
    console.log('Running test: null boundary rejects SPREAD-typed slots');

    // Layout: slot-0..7, all VIRTUAL. Mix of BUY, SELL, SPREAD types.
    // With boundary=null and funds available, _deriveBudgetedSideSizes
    // produces real sizes for BUY/SELL slots but NOT for SPREAD slots
    // (type filter excludes them). So BUY picks slot-0/1, SELL picks
    // slot-6/7, SPREAD slot-2..5 are never picked.
    const slots = [
        makeBuy('slot-0', 0, ORDER_STATES.VIRTUAL),
        makeBuy('slot-1', 0, ORDER_STATES.VIRTUAL),
        makeSpread('slot-2'),
        makeSpread('slot-3'),
        makeSpread('slot-4'),
        makeSpread('slot-5'),
        makeSell('slot-6', 0, ORDER_STATES.VIRTUAL),
        makeSell('slot-7', 0, ORDER_STATES.VIRTUAL),
    ];
    const manager = buildManager({ boundaryIdx: null, slots, funds: TEST_FUNDS });

    const pickedBuy = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.BUY, 4);
    const pickedSell = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.SELL, 4);

    // Concrete BUY/SELL slots must be picked (funds available, derived sizes)
    assert.ok(pickedBuy.length > 0,
        `BUY: concrete slots should be picked with funds, got ${pickedBuy.length}`);
    assert.ok(pickedSell.length > 0,
        `SELL: concrete slots should be picked with funds, got ${pickedSell.length}`);

    // SPREAD-typed slots must NOT be picked — the core Finding-3 guard
    const spreadPickedBuy = pickedBuy.filter((s: any) => s.type === ORDER_TYPES.SPREAD);
    const spreadPickedSell = pickedSell.filter((s: any) => s.type === ORDER_TYPES.SPREAD);
    assert.strictEqual(spreadPickedBuy.length, 0,
        `BUY: no SPREAD slots when boundary=null, got ${spreadPickedBuy.map((s: any) => s.id).join(',')}`);
    assert.strictEqual(spreadPickedSell.length, 0,
        `SELL: no SPREAD slots when boundary=null, got ${spreadPickedSell.map((s: any) => s.id).join(',')}`);

    console.log(`  PASS: ${pickedBuy.length} BUY, ${pickedSell.length} SELL picked; SPREAD excluded`);
}

async function testNullBoundaryWithoutFundsPicksNothing() {
    console.log('Running test: null boundary without funds picks nothing (trivial)');

    // Verify the trivial path: no funds → no picks for any type.
    // This is a sanity check, not the guard under test.
    const slots = [
        makeBuy('slot-0', 0, ORDER_STATES.VIRTUAL),
        makeSpread('slot-1'),
        makeSell('slot-2', 0, ORDER_STATES.VIRTUAL),
    ];
    const manager = buildManager({ boundaryIdx: null, slots, funds: null });

    const pickedBuy = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.BUY, 4);
    const pickedSell = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.SELL, 4);
    assert.strictEqual(pickedBuy.length, 0, 'No funds → no BUY picks');
    assert.strictEqual(pickedSell.length, 0, 'No funds → no SELL picks');
    console.log('  PASS: trivial path confirmed');
}

async function testKnownBoundaryAcceptsInRailSpread() {
    console.log('Running test: known boundary accepts in-rail SPREAD slots');

    // Layout: boundary=2, gapSlots=2, sellStartIdx=5.
    // BUY rail = indices 0-2, gap = 3-4, SELL = 5-7.
    // slot-1 is SPREAD (in-rail for BUY). With funds, it should be picked
    // and re-typed to BUY before activation.
    const slots = [
        makeBuy('slot-0', 0, ORDER_STATES.VIRTUAL),
        makeSpread('slot-1'),  // in-rail for BUY (idx 1 ≤ boundary 2)
        makeBuy('slot-2', 0, ORDER_STATES.VIRTUAL),
        makeSpread('slot-3'),  // gap band — should NOT be picked
        makeSpread('slot-4'),  // gap band — should NOT be picked
        makeSell('slot-5', 10, ORDER_STATES.ACTIVE),
        makeSell('slot-6', 10, ORDER_STATES.ACTIVE),
        makeSell('slot-7', 10, ORDER_STATES.ACTIVE),
    ];
    const manager = buildManager({ boundaryIdx: 2, gapSlots: 2, slots, funds: TEST_FUNDS });

    const pickedBuy = _pickVirtualSlotsToActivate(manager, ORDER_TYPES.BUY, 4);

    // In-rail SPREAD slot-1 should be picked
    const pickedIds = pickedBuy.map((s: any) => s.id);
    assert.ok(pickedIds.includes('slot-1'),
        `In-rail SPREAD slot-1 should be picked for BUY, got: ${pickedIds.join(',')}`);

    // Gap-band SPREAD slots should NOT be picked (inRail geometry excludes them)
    assert.ok(!pickedIds.includes('slot-3') && !pickedIds.includes('slot-4'),
        `Gap-band SPREAD slots must not be picked for BUY, got: ${pickedIds.join(',')}`);

    // Picked SPREAD slot should be re-typed to BUY (not remain SPREAD)
    const slot1Picked = pickedBuy.find((s: any) => s.id === 'slot-1');
    if (slot1Picked) {
        assert.strictEqual(slot1Picked.type, ORDER_TYPES.BUY,
            `In-rail SPREAD slot-1 must be re-typed to BUY before activation`);
    }

    console.log(`  PASS: ${pickedBuy.length} BUY picked including in-rail SPREAD slot-1`);
}

async function runAll() {
    await testNullBoundaryRejectsSpread();
    await testNullBoundaryWithoutFundsPicksNothing();
    await testKnownBoundaryAcceptsInRailSpread();
    console.log('\n✓ All null-boundary reconcile tests passed');
}

runAll().catch(error => {
    console.error('Test FAILED:', error);
    process.exit(1);
});
