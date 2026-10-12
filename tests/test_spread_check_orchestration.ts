const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

/**
 * Drives the FULL checkSpreadCondition orchestration (not the leaf
 * prepareSpreadCorrectionOrders) for the "mid-grid empty rail" scenario:
 * one rail has zero on-chain orders but the boundary is mid-grid, so the
 * boundary-at-rail-edge structural resync guard (buySideCount < 2 ||
 * sellSideCount < 2) must NOT fire — spread correction via boundary
 * promotion is the only remedy.  Asserts the decision layer routes to
 * promotion instead of resync, and that the on-chain batch executes.
 */
async function testMidGridEmptyPromotesInsteadOfResync() {
    console.log('Running test: mid-grid empty rail promotes instead of resync');

    // Layout: BUY 0-2 ACTIVE (funded, full), gap 3-5 SPREAD VIRTUAL,
    // SELL zone 6-7 SPREAD VIRTUAL (empty rail, zero on-chain orders).
    // Boundary mid-grid at 2 → both rails have >= 2 slots → NO resync.
    // gapSlots=3 keeps one promotable slot above the MIN_SPREAD_ORDERS=2
    // reserve (bandSize 3 − reserve 2 = 1).
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 0 },
        coreOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isBuy = i <= 2;
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SPREAD,
            state: isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: isBuy ? 10 : 0,
            orderId: isBuy ? `1.7.${100 + i}` : ''
        });
    }
    manager.boundaryIdx = 2;
    manager._gapSlots = 3;
    await manager.setAccountTotals({ buy: 1000, sell: 0, buyFree: 1000, sellFree: 0 });
    await manager.recalculateFunds();

    let resyncCalls = 0;
    manager.requestStructuralGridResync = async (reason) => { resyncCalls++; };

    let capturedCorrection = null;
    const batchCb = async (correction) => {
        capturedCorrection = correction;
        return { executed: true };
    };

    const result = await manager.checkSpreadCondition({}, batchCb);

    assert.strictEqual(resyncCalls, 0,
        'Mid-grid empty rail must NOT request a structural resync');
    assert.strictEqual(result.ordersPlaced, 1,
        'Spread correction must place exactly 1 promoted order via orchestration');
    assert.ok(capturedCorrection, 'Batch callback must receive the correction plan');
    const placedIds = capturedCorrection.ordersToPlace?.map((o) => o.id) || [];
    assert.deepStrictEqual(placedIds, ['slot-3'],
        'Promotion must target the gap slot adjacent to the BUY edge');
    assert.strictEqual(capturedCorrection.boundaryIdx, 3,
        'Promoted boundary must move 2 → 3');
    assert.strictEqual(capturedCorrection.ordersToPlace[0].type, ORDER_TYPES.BUY,
        'Promoted slot must be re-typed BUY for activation');

    console.log('  PASS: mid-grid empty rail promoted boundary slots without resync');
}

/**
 * Contrast: boundary at the rail edge (boundaryIdx=0 → BUY rail has 1 slot)
 * with the opposite rail empty DOES request the structural resync.  Verifies
 * the guard the mid-grid case must bypass actually fires when appropriate.
 */
async function testRailEdgeEmptyRequestsResync() {
    console.log('Running test: rail-edge empty rail requests structural resync');

    // Layout: BUY 0 (only 1 slot, boundary at edge 0), gap 1-2, SELL 3-7
    // all VIRTUAL.  oneSideEmpty (no on-chain sells) + buySideCount=1 < 2
    // → structural resync must be requested to re-center the grid.
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 0 },
        coreOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isBuy = i === 0;
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SPREAD,
            state: isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: isBuy ? 10 : 0,
            orderId: isBuy ? '1.7.200' : ''
        });
    }
    manager.boundaryIdx = 0;
    manager._gapSlots = 2;
    await manager.setAccountTotals({ buy: 1000, sell: 0, buyFree: 1000, sellFree: 0 });
    await manager.recalculateFunds();

    let resyncCalls = 0;
    let resyncReason = null;
    manager.requestStructuralGridResync = async (reason) => { resyncCalls++; resyncReason = reason; };

    const batchCb = async () => ({ executed: true });

    await manager.checkSpreadCondition({}, batchCb);

    assert.strictEqual(resyncCalls, 1,
        'Rail-edge empty rail must request exactly one structural resync');
    assert.strictEqual(resyncReason, 'boundary-at-rail-edge',
        'Resync reason must identify the rail-edge boundary');

    console.log('  PASS: rail-edge empty rail requested structural resync');
}

async function runAll() {
    await testMidGridEmptyPromotesInsteadOfResync();
    await testRailEdgeEmptyRequestsResync();
    console.log('✓ All spread-check orchestration tests passed');
}

runAll().catch(error => {
    console.error('Test FAILED:', error);
    process.exit(1);
});
