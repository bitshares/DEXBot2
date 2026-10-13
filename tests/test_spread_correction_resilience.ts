/**
 * tests/test_spread_correction_resilience.ts
 *
 * Regression coverage for the spread-correction resilience work (P0-P5 of the
 * stale/out-of-spread plan). The live failure was: a spread correction was
 * planned against master version V, a concurrent fill rebalance committed V+2,
 * the commit guard refused the batch (`executed !== true`), and nothing was
 * placed — so the out-of-spread watchdog eventually forced a structural
 * re-center (96 min in one observed incident). These tests pin the fixes:
 *
 *  - P0: refusal classification + counter-only recording.
 *  - P1/P3: checkSpreadCondition holds the broadcast region across a bounded
 *    re-plan retry, so a transient refusal heals in-cycle.
 *  - P2: a planned CREATE whose destination was taken after planning is
 *    detected (getOccupiedCorrectionSlots) and re-derived instead of shipped.
 *  - P3: an exhausted retry still reports transient:true (retryable), never a
 *    structural stall.
 *  - P4: trackOutOfSpreadStaleness tolerates transient refusals under the
 *    grace budget and only escalates past it.
 *  - P5: shouldCoalesceBacklogReplay precedence + single-reconcile backlog
 *    coalescing (opt-in).
 *
 * Synthetic geometry only — no real pair names or account identifiers.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const {
    classifySpreadRefusalCause,
    recordSpreadCorrectionRefusal,
    getOccupiedCorrectionSlots,
    resolveOccupiedCorrection,
    replanSpreadCorrectionFromFreshMaster,
    SPREAD_CORRECTION_REFUSAL,
    isTransientSpreadRefusal,
} = require('../modules/order/grid');
const { trackOutOfSpreadStaleness } = require('../modules/dexbot_maintenance_runtime');
const DEXBot = require('../modules/dexbot_class').default;
const { shouldCoalesceBacklogReplay } = require('../modules/dexbot_class');

/**
 * Mid-grid empty-rail layout (same recipe as test_spread_check_orchestration):
 * BUY 0-2 ACTIVE, gap 3-5 SPREAD VIRTUAL, SELL 6-7 SPREAD VIRTUAL, boundary 2.
 * Produces exactly one promotable slot (slot-3) on the BUY side.
 */
async function buildMidGridEmptyManager() {
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
    manager.requestStructuralGridResync = async () => { /* no-op for the retry tests */ };
    return manager;
}

function testRefusalClassification() {
    console.log('\n - classifySpreadRefusalCause labels the live failure shapes...');
    // Post-broadcast commit refusal wins over any reason string.
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, commitRefused: true, reason: 'x' }), SPREAD_CORRECTION_REFUSAL.COMMIT_REFUSED);
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, reason: 'UPDATE_TARGET_MISSING' }), SPREAD_CORRECTION_REFUSAL.UPDATE_TARGET_MISSING);
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, reason: 'UNMATCHED_CHAIN_ORDERS' }), SPREAD_CORRECTION_REFUSAL.UNMATCHED_CHAIN_ORDERS);
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, skippedStalePlan: true }), SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH);
    // Real commit-guard wording (order/utils/validate.ts) — no 'STALE'/'MISMATCH'
    // token, so it needs the 'BASE VERSION' match to bucket correctly.
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, reason: 'Refusing working grid commit: base version 626 != current 628' }), SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH);
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, reason: 'version mismatch during planning' }), SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH);
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, reason: 'STALE working grid' }), SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH);
    assert.strictEqual(classifySpreadRefusalCause(null), SPREAD_CORRECTION_REFUSAL.BATCH_NOT_EXECUTED);
    console.log('  PASS: refusal classification');
}

function testTransienceRegistry() {
    console.log('\n - the transient-refusal set is centralized and excludes commit-refused...');
    assert.strictEqual(isTransientSpreadRefusal(SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH), true);
    assert.strictEqual(isTransientSpreadRefusal(SPREAD_CORRECTION_REFUSAL.CREATE_COLLISION), true);
    assert.strictEqual(isTransientSpreadRefusal(SPREAD_CORRECTION_REFUSAL.BATCH_NOT_EXECUTED), true);
    assert.strictEqual(isTransientSpreadRefusal(SPREAD_CORRECTION_REFUSAL.COMMIT_REFUSED), false, 'commit-refused counts toward staleness');
    assert.strictEqual(isTransientSpreadRefusal(SPREAD_CORRECTION_REFUSAL.UPDATE_TARGET_MISSING), false);
    assert.strictEqual(isTransientSpreadRefusal(SPREAD_CORRECTION_REFUSAL.UNMATCHED_CHAIN_ORDERS), false);
    assert.strictEqual(isTransientSpreadRefusal(SPREAD_CORRECTION_REFUSAL.SHUTDOWN), false);
    console.log('  PASS: transience registry');
}

function testRecordRefusalCountsByCause() {
    console.log('\n - recordSpreadCorrectionRefusal counts total + cause...');
    const manager: any = { _metrics: {} };
    recordSpreadCorrectionRefusal(manager, SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH);
    recordSpreadCorrectionRefusal(manager, SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH);
    recordSpreadCorrectionRefusal(manager, SPREAD_CORRECTION_REFUSAL.CREATE_COLLISION);
    assert.strictEqual(manager._metrics.spreadCorrectionRefusedCount, 3);
    assert.strictEqual(manager._metrics.spreadCorrectionRefusalCauses[SPREAD_CORRECTION_REFUSAL.VERSION_MISMATCH], 2);
    assert.strictEqual(manager._metrics.spreadCorrectionRefusalCauses[SPREAD_CORRECTION_REFUSAL.CREATE_COLLISION], 1);
    // Never throws on a manager without metrics.
    recordSpreadCorrectionRefusal({}, SPREAD_CORRECTION_REFUSAL.COMMIT_REFUSED);
    console.log('  PASS: refusal counters');
}

function testOccupiedCorrectionSlots() {
    console.log('\n - getOccupiedCorrectionSlots flags only live occupied destinations...');
    const manager: any = {
        orders: new Map([
            ['slot-a', { id: 'slot-a', state: ORDER_STATES.VIRTUAL, orderId: '' }],
            ['slot-b', { id: 'slot-b', state: ORDER_STATES.ACTIVE, orderId: '1.7.1' }],
            ['slot-c', { id: 'slot-c', state: ORDER_STATES.ACTIVE, orderId: '' }],
        ]),
    };
    const correction = { ordersToPlace: [{ id: 'slot-a' }, { id: 'slot-b' }, { id: 'slot-c' }, { id: 'slot-missing' }] };
    assert.deepStrictEqual(getOccupiedCorrectionSlots(manager, correction), ['slot-b'],
        'only a live ACTIVE order with a chain id counts as occupied');
    // Defensive: non-Map store selects the empty set.
    assert.deepStrictEqual(getOccupiedCorrectionSlots({ orders: [] }, correction), []);
    assert.deepStrictEqual(getOccupiedCorrectionSlots(manager, null), []);
    console.log('  PASS: occupied-slot detection');
}

async function testTransientRefusalRetriesAndLands() {
    console.log('\n - checkSpreadCondition re-plans after a transient refusal and lands...');
    const manager = await buildMidGridEmptyManager();

    let calls = 0;
    const batchCb = async () => {
        calls++;
        if (calls === 1) return { executed: false, reason: 'STALE working grid' };
        return { executed: true };
    };

    const result = await manager.checkSpreadCondition({}, batchCb);
    assert.strictEqual(calls, 2, 'one bounded re-plan retry must follow the transient refusal');
    assert.strictEqual(result.ordersPlaced, 1, 'the retried correction must land');
    assert.strictEqual(result.transient, undefined, 'a landed correction is not transient');
    assert.strictEqual(manager._metrics.spreadCorrectionRetryCount, 1, 'the retry must be counted');
    assert.strictEqual(manager._metrics.spreadCorrectionRefusedCount, 1, 'the refusal must be counted');
    console.log('  PASS: transient refusal retried and landed');
}

async function testPlanTimeCollisionResolution() {
    console.log('\n - P2: resolveOccupiedCorrection re-derives or blocks a taken plan...');
    const manager = await buildMidGridEmptyManager();

    // A fresh plan targets the single promotable slot (slot-3).
    const planned = await replanSpreadCorrectionFromFreshMaster(manager);
    assert.ok(planned && planned.ordersToPlace && planned.ordersToPlace.length > 0, 'a promotable plan exists');
    const target = planned.ordersToPlace[0].id;

    // No collision -> ship.
    assert.strictEqual(
        (await resolveOccupiedCorrection(manager, planned, 1, 2)).action,
        'broadcast',
        'a free plan is broadcast'
    );

    // A concurrent commit takes the destination after planning. Master-grid
    // order objects are frozen, so replace the Map entry.
    const existing = manager.orders.get(target);
    manager.orders.set(target, { ...existing, state: ORDER_STATES.ACTIVE, orderId: '1.7.999999' } as any);

    // Collision detected; the contiguous promotion run is now broken, so no
    // fresh candidate exists -> blocked (caller refuses, never broadcasts).
    const resolution = await resolveOccupiedCorrection(manager, planned, 1, 2);
    assert.strictEqual(resolution.action, 'blocked', 'a taken plan with no substitute is blocked');
    assert.deepStrictEqual(resolution.occupied, [target], 'the taken slot is reported');

    // Bounded: the final attempt ships even when occupied (the COW build layer
    // is then the backstop), matching MAX_SPREAD_ATTEMPTS semantics.
    assert.strictEqual(
        (await resolveOccupiedCorrection(manager, planned, 2, 2)).action,
        'broadcast',
        'the final attempt is not re-derived'
    );
    console.log('  PASS: plan-time collision resolution');
}

async function testNonTransientRefusalNotRetried() {
    console.log('\n - a non-transient refusal is not retried and is reported non-transient...');
    const manager = await buildMidGridEmptyManager();
    let calls = 0;
    const batchCb = async () => { calls++; return { executed: false, commitRefused: true }; };
    const result = await manager.checkSpreadCondition({}, batchCb);
    assert.strictEqual(calls, 1, 'commit-refused must not trigger a re-plan retry');
    assert.strictEqual(result.ordersPlaced, 0);
    assert.strictEqual(result.stall, 'batch-not-executed');
    assert.strictEqual(result.transient, false, 'commit-refused must be reported non-transient');
    assert.strictEqual(manager._metrics.spreadCorrectionRefusalCauses[SPREAD_CORRECTION_REFUSAL.COMMIT_REFUSED], 1);
    assert.strictEqual(manager._metrics.spreadCorrectionRetryCount, 0, 'no retry counted');
    console.log('  PASS: non-transient refusal not retried');
}

async function testUncertainResultFlowsThroughRetry() {
    console.log('\n - an uncertain (executed:false, no commitRefused) result is retried...');
    // COW can return executed:false with no commitRefused (uncertain settlement).
    // It must classify as the transient fallback and flow through the re-plan,
    // which is the original stale-grid pathology this work fixes.
    assert.strictEqual(classifySpreadRefusalCause({ executed: false, uncertain: true }), SPREAD_CORRECTION_REFUSAL.BATCH_NOT_EXECUTED);
    const manager = await buildMidGridEmptyManager();
    let calls = 0;
    const batchCb = async () => {
        calls++;
        if (calls === 1) return { executed: false, uncertain: true };
        return { executed: true };
    };
    const result = await manager.checkSpreadCondition({}, batchCb);
    assert.strictEqual(calls, 2, 'the uncertain result must be re-planned once');
    assert.strictEqual(result.ordersPlaced, 1, 'the re-plan must land');
    assert.strictEqual(result.transient, undefined, 'a landed correction is not transient');
    assert.strictEqual(manager._metrics.spreadCorrectionRefusalCauses[SPREAD_CORRECTION_REFUSAL.BATCH_NOT_EXECUTED], 1);
    console.log('  PASS: uncertain result retried');
}

async function testExhaustedRetryIsTransient() {    console.log('\n - an exhausted retry reports transient (retryable), never structural...');
    const manager = await buildMidGridEmptyManager();

    let calls = 0;
    const batchCb = async () => {
        calls++;
        return { executed: false, reason: 'base version 1 != current 2' };
    };

    const result = await manager.checkSpreadCondition({}, batchCb);
    assert.strictEqual(calls, 2, 'bounded attempts: initial + one re-plan');
    assert.strictEqual(result.ordersPlaced, 0);
    assert.strictEqual(result.stall, 'batch-not-executed');
    assert.strictEqual(result.transient, true, 'refusal must be flagged retryable');
    console.log('  PASS: exhausted retry is transient');
}

async function testBroadcastRegionHeldAcrossRetry() {
    console.log('\n - the broadcast region is held across the retry and always released...');
    const manager = await buildMidGridEmptyManager();

    let starts = 0;
    let stops = 0;
    const origStart = manager.startBroadcasting.bind(manager);
    const origStop = manager.stopBroadcasting.bind(manager);
    manager.startBroadcasting = () => { starts++; return origStart(); };
    manager.stopBroadcasting = () => { stops++; return origStop(); };

    await manager.checkSpreadCondition({}, async () => ({ executed: false, reason: 'STALE' }));

    assert.strictEqual(starts, 1, 'the region is opened once for the whole attempt loop');
    assert.strictEqual(stops, 1, 'the region is released exactly once (finally)');
    assert.strictEqual(manager.isBroadcastingActive(), false, 'no leaked broadcast region');
    console.log('  PASS: region held + released');
}

async function testBroadcastRegionReleasedOnThrow() {
    console.log('\n - the broadcast region is released even when the batch throws...');
    const manager = await buildMidGridEmptyManager();

    let starts = 0;
    let stops = 0;
    const origStart = manager.startBroadcasting.bind(manager);
    const origStop = manager.stopBroadcasting.bind(manager);
    manager.startBroadcasting = () => { starts++; return origStart(); };
    manager.stopBroadcasting = () => { stops++; return origStop(); };

    const result = await manager.checkSpreadCondition({}, async () => { throw new Error('boom'); });

    assert.strictEqual(result.stall, 'apply-error', 'a throw maps to apply-error');
    assert.strictEqual(starts, 1, 'region opened');
    assert.strictEqual(stops, 1, 'region released in finally despite the throw');
    assert.strictEqual(manager.isBroadcastingActive(), false, 'no leaked broadcast region');
    console.log('  PASS: region released on throw');
}

function testCoalesceResolverPrecedence() {
    console.log('\n - P5: shouldCoalesceBacklogReplay override precedence + parsing...');
    assert.strictEqual(shouldCoalesceBacklogReplay({}, {}), false, 'default is off');
    assert.strictEqual(shouldCoalesceBacklogReplay({ fillProcessing: { COALESCE_BACKLOG_REPLAY: true } }, {}), true, 'bot config wins');
    assert.strictEqual(shouldCoalesceBacklogReplay({}, { fillProcessing: { COALESCE_BACKLOG_REPLAY: 'true' } }), true, "manager config 'true' parses");
    assert.strictEqual(shouldCoalesceBacklogReplay({}, { fillProcessing: { COALESCE_BACKLOG_REPLAY: 1 } }), true, '1 parses');
    assert.strictEqual(shouldCoalesceBacklogReplay({ fillProcessing: { COALESCE_BACKLOG_REPLAY: false } }, { fillProcessing: { COALESCE_BACKLOG_REPLAY: true } }), false, 'explicit false on bot config wins over manager');
    assert.strictEqual(shouldCoalesceBacklogReplay(null, null), false, 'null-safe');
    console.log('  PASS: coalesce resolver');
}

async function testBacklogCoalescingSingleReconcile() {
    console.log('\n - P5: backlog replay coalesces into one reconcile only when opted in...');
    const fills = Array.from({ length: 5 }, (_, i) => ({ id: `f-${i}`, orderId: `1.7.${i}` }));

    function makeFake(config: any, managerConfig: any) {
        const processCalls: number[] = [];
        const fake: any = {
            config,
            manager: {
                config: managerConfig,
                _genesis: {},
                pauseFundRecalc: () => {},
                resumeFundRecalc: async () => {},
                flushGridDirty: async () => {},
                recordLastFilledPrices: () => {},
                processFilledOrders: async (fillBatch: any[]) => {
                    processCalls.push(fillBatch.length);
                    return { actions: [], workingGrid: new Map(), boundaryIdx: 0 };
                },
            },
            _getMaxFillBatchSize: () => 2,
            _executeBatchIfNeeded: async () => ({ executed: true }),
        };
        return { fake, processCalls };
    }

    // Default (off): chunked into ceil(5/2) = 3 reconciles.
    {
        const { fake, processCalls } = makeFake({}, {});
        await DEXBot.prototype._processFillsWithBatching.call(fake, fills, new Set(), 'test');
        assert.deepStrictEqual(processCalls, [2, 2, 1], 'default chunked replay');
        assert.strictEqual(fake.manager._boundaryShiftBudget, undefined, 'budget cleaned up');
    }
    // Opted in via bot config: one reconcile with all 5 fills.
    {
        const { fake, processCalls } = makeFake({ fillProcessing: { COALESCE_BACKLOG_REPLAY: true } }, {});
        await DEXBot.prototype._processFillsWithBatching.call(fake, fills, new Set(), 'test');
        assert.deepStrictEqual(processCalls, [5], 'coalesced into one reconcile');
    }
    // Opted in via manager config: same.
    {
        const { fake, processCalls } = makeFake({}, { fillProcessing: { COALESCE_BACKLOG_REPLAY: true } });
        await DEXBot.prototype._processFillsWithBatching.call(fake, fills, new Set(), 'test');
        assert.deepStrictEqual(processCalls, [5], 'coalesced via manager config');
    }
    // Below the batch size the flag is irrelevant: always one reconcile.
    {
        const { fake, processCalls } = makeFake({ fillProcessing: { COALESCE_BACKLOG_REPLAY: true } }, {});
        await DEXBot.prototype._processFillsWithBatching.call(fake, fills.slice(0, 2), new Set(), 'test');
        assert.deepStrictEqual(processCalls, [2], 'small batch already unified');
    }
    console.log('  PASS: backlog coalescing');
}

function makeStaleBot() {
    const logs: Array<{ msg: string; level?: string }> = [];
    const bot: any = {
        _outOfSpreadSince: 0,
        _outOfSpreadStaleWarned: false,
        _outOfSpreadTransientCount: 0,
        _lastSpreadStaleResyncAt: 0,
        manager: {
            outOfSpread: 1,
            requestStructuralGridResync: () => { throw new Error('should not resync under grace'); },
            logger: { log: () => {} },
        },
        _log: (msg: string, level?: string) => logs.push({ msg: String(msg), level }),
        logs,
    };
    return bot;
}

function testTransientGraceAvoidsResync() {
    console.log('\n - P4: transient refusals under grace never force a structural resync...');
    const bot = makeStaleBot();
    // Repeated transient refusals restart the clock and stay under grace.
    for (let i = 0; i < 3; i++) {
        const r = trackOutOfSpreadStaleness(bot, true, 0, true);
        assert.strictEqual(r.escalated, false, 'transient under grace must not escalate');
        assert.strictEqual(r.staleMs, 0, 'transient refusal restarts the stale clock');
    }
    assert.strictEqual(bot._outOfSpreadTransientCount, 3);
    // A real placement heals: counters reset.
    trackOutOfSpreadStaleness(bot, true, 1, false);
    assert.strictEqual(bot._outOfSpreadTransientCount, 0);
    assert.strictEqual(bot._outOfSpreadSince, 0);
    console.log('  PASS: transient grace');
}

function testTransientPastGraceEscalates() {
    console.log('\n - P4: a deadlocked transient past grace still escalates...');
    const bot = makeStaleBot();
    let resyncs = 0;
    bot.manager.requestStructuralGridResync = () => { resyncs++; };
    // Past the escalate threshold AND past the transient grace budget.
    bot._outOfSpreadSince = Date.now() - (40 * 60 * 1000);
    bot._outOfSpreadTransientCount = 3; // grace default is 3 → next call is > grace
    const r = trackOutOfSpreadStaleness(bot, true, 0, true);
    assert.strictEqual(r.escalated, true, 'past grace the watchdog must escalate');
    assert.strictEqual(resyncs, 1, 'structural re-center must be requested');
    console.log('  PASS: transient past grace escalates');
}

async function runAll() {
    testRefusalClassification();
    testTransienceRegistry();
    testRecordRefusalCountsByCause();
    testOccupiedCorrectionSlots();
    await testTransientRefusalRetriesAndLands();
    await testPlanTimeCollisionResolution();
    await testNonTransientRefusalNotRetried();
    await testUncertainResultFlowsThroughRetry();
    await testExhaustedRetryIsTransient();
    await testBroadcastRegionHeldAcrossRetry();
    await testBroadcastRegionReleasedOnThrow();
    testTransientGraceAvoidsResync();
    testTransientPastGraceEscalates();
    testCoalesceResolverPrecedence();
    await testBacklogCoalescingSingleReconcile();
    console.log('\n✓ All spread-correction resilience tests passed');
}

runAll().catch((error) => {
    console.error('Test FAILED:', error);
    process.exit(1);
});
