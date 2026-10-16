/**
 * tests/test_fill_defer_retry.ts
 *
 * Regression tests for the 2026-09-13 <bot> incident (slot-86 /
 * 1.7.574247542): a lone fill deferred by consumeFillQueue's pre-lock gates
 * was parked with no wake-up — no region end (leaked flag), no second fill
 * (the 60s bound is edge-triggered), no maintenance tick (a non-empty queue
 * holds the maintenance idle gate shut, so the maintenance watchdog never
 * ran).
 *
 * RETRY-001..002 — deferral arms a level-triggered retry (P0):
 *   broadcast / pipeline deferral must leave a pending retry timer behind
 *   instead of returning with no reschedule (the incident shape).
 * RETRY-003 — the retry fires with no new fill and no region end (P0):
 *   it refreshes the watchdog and re-invokes the consumer on its own.
 * RETRY-004 — stale flag clears on the consume path (P1):
 *   a >120s-stale broadcast flag is cleared by consumeFillQueue itself, so
 *   the fill proceeds with no maintenance tick involved.
 * RETRY-005 — fresh flag still defers (P1 guard):
 *   the consume-path watchdog consults but never nukes a fresh flag.
 * RETRY-006 — COW final clears on the batch-end edge (coverage gap):
 *   the batch's finally must reschedule the fill consumer whenever
 *   _batchInFlight drops to 0 with a non-empty queue — the clearing-edge
 *   wake-up the defer gate relies on when no retry timer is armed yet.
 * RETRY-007 — a clean drain retires the retry counter:
 *   _deferredFillRetryWaits resets once the queue settles empty, so the
 *   deferral log cadence cannot stay elevated after the queue drained via
 *   another path.
 */

const assert = require('assert');
const { consumeFillQueue, scheduleDeferredFillRetry } = require('../modules/dexbot_fill_runtime');
const { updateOrdersOnChainBatchCOW } = require('../modules/dexbot_cow_runtime');
const { OrderManager } = require('../modules/order/manager');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function clearRetryTimer(bot: any) {
    if (bot && bot._deferredFillRetryTimer) {
        clearTimeout(bot._deferredFillRetryTimer);
        bot._deferredFillRetryTimer = null;
    }
}

function makeFakeBot(overrides: any = {}) {
    return {
        _incomingFillQueue: [{ order_id: '1.7.574247542' }],
        _shuttingDown: false,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _deferredFillsPending: false,
        _deferredFillRetryTimer: null,
        _deferredFillRetryWaits: 0,
        _consecutiveConsumeFailures: 0,
        _consumeFailureFirstAt: 0,
        _warn: () => {},
        manager: {
            isBroadcastingActive: () => true,
            // Any lock acquire during a deferral is a regression of the
            // lock-timeout cascade — the lock is fake-throwing to prove the
            // consumer returned BEFORE acquiring.
            _fillProcessingLock: { acquire: async () => { throw new Error('lock acquired during deferral'); } },
            _orphanFillsCreditedAt: null,
            logger: { log: () => {} },
        },
        ...overrides,
    };
}

function newTestManager() {
    const m: any = new OrderManager({
        startPrice: 100,
        incrementPercent: 0.3,
        targetSpreadPercent: 1.5,
        assetA: 'USD',
        assetB: 'TESTCOIN',
        minPrice: 50,
        maxPrice: 200,
    });
    m.logger.log = () => {};
    return m;
}

async function testRETRY001_BroadcastDeferralArmsRetry() {
    console.log('\n[RETRY-001] Broadcast deferral arms a level-triggered retry...');
    const bot: any = makeFakeBot();
    await consumeFillQueue(bot, {});
    assert.strictEqual(bot._deferredFillsPending, true, 'deferral must mark the drain-residue flag');
    assert.ok(bot._deferredFillRetryTimer != null, 'broadcast deferral must arm the retry timer (was: no reschedule)');
    const first = bot._deferredFillRetryTimer;
    // A second deferred fill must not stack a second timer.
    await consumeFillQueue(bot, {});
    assert.strictEqual(bot._deferredFillRetryTimer, first, 'at most one retry may be pending per bot');
    clearRetryTimer(bot);
    console.log('✓ RETRY-001 passed');
}

async function testRETRY002_PipelineDeferralArmsRetry() {
    console.log('\n[RETRY-002] Order-pipeline deferral arms a level-triggered retry...');
    const bot: any = makeFakeBot({ _batchInFlight: 1, manager: {
        isBroadcastingActive: () => false,
        _fillProcessingLock: { acquire: async () => { throw new Error('lock acquired during deferral'); } },
        _orphanFillsCreditedAt: null,
        logger: { log: () => {} },
    } });
    await consumeFillQueue(bot, {});
    assert.strictEqual(bot._deferredFillsPending, true, 'deferral must mark the drain-residue flag');
    assert.ok(bot._deferredFillRetryTimer != null, 'pipeline deferral must arm the retry timer (was: no reschedule)');
    clearRetryTimer(bot);
    console.log('✓ RETRY-002 passed');
}

async function testRETRY003_RetryFiresWithoutNewFillOrRegionEnd() {
    console.log('\n[RETRY-003] The retry fires with no new fill and no region end...');
    // Override the real derived retry delay (5s at the default 60s defer
    // bound) so the test does not sleep on wall-clock time; the assertion
    // is the retry behavior (watchdog refresh + consumer re-invoke), not
    // the derived delay value (covered by the retryMs unit math).
    let watchdogCalls = 0;
    let consumeCalls = 0;
    const bot: any = {
        _incomingFillQueue: [{ order_id: '1.7.574247542' }],
        _shuttingDown: false,
        _deferredFillRetryTimer: null,
        _deferredFillRetryWaits: 0,
        _warn: () => {},
        _consumeFillQueue: async () => { consumeCalls++; },
        manager: {
            _clearStaleBroadcastFlag: () => { watchdogCalls++; },
            logger: { log: () => {} },
        },
    };
    try {
        scheduleDeferredFillRetry(bot, {}, 'test', { retryDelayMs: 10 });
        assert.ok(bot._deferredFillRetryTimer != null, 'scheduler must arm the timer');
        assert.strictEqual(
            bot._deferredFillRetryDelayMs,
            10,
            'retryDelayMs: 10 must resolve to 10'
        );
        await sleep(40);
        assert.ok(watchdogCalls >= 1, 'retry must refresh the stale-broadcast watchdog outside maintenance');
        assert.ok(consumeCalls >= 1, 'retry must re-invoke the consumer with no new fill and no region end');
        assert.strictEqual(bot._deferredFillRetryTimer, null, 'timer must settle once fired');
    } finally {
        clearRetryTimer(bot);
    }
    console.log('✓ RETRY-003 passed');
}

async function testRETRY003b_ZeroRetryDelayIsHonored() {
    console.log('\n[RETRY-003b] An explicit retryDelayMs: 0 resolves to 0, not the derived default...');
    // The discriminating case for `??` vs `||`: a truthy seam (10) is
    // indistinguishable between the two, but 0 must NOT fall through to the
    // derived 5s default. The caller resolving with `||` would reintroduce
    // the original `> 0` semantics silently.
    const bot: any = {
        _incomingFillQueue: [{ order_id: '1.7.574247542' }],
        _shuttingDown: false,
        _deferredFillRetryTimer: null,
        _deferredFillRetryWaits: 0,
        _warn: () => {},
        _consumeFillQueue: async () => {},
        manager: {
            _clearStaleBroadcastFlag: () => {},
            logger: { log: () => {} },
        },
    };
    try {
        scheduleDeferredFillRetry(bot, {}, 'test', { retryDelayMs: 0 });
        assert.ok(bot._deferredFillRetryTimer != null, 'scheduler must arm the timer for a 0 delay too');
        assert.strictEqual(
            bot._deferredFillRetryDelayMs,
            0,
            'retryDelayMs: 0 must resolve to 0, not the derived default (caller must use ??, not ||)'
        );
    } finally {
        clearRetryTimer(bot);
    }
    console.log('✓ RETRY-003b passed');
}

async function testRETRY004_StaleFlagClearsOnConsumePath() {
    console.log('\n[RETRY-004] A stale broadcast flag clears on the consume path (no maintenance)...');
    const m = newTestManager();
    m.startBroadcasting();
    // Age the flag past the 120s watchdog threshold — the incident shape: a
    // leaked flag with a lone queued fill and no maintenance tick coming.
    m._broadcastingStartedAt = Date.now() - 121000;
    let acquired = false;
    m._fillProcessingLock = {
        isLocked: () => false,
        getQueueLength: () => 0,
        // Record reaching the lock WITHOUT running the body: the assertion
        // is the gate decision (proceed vs defer), not the full drain.
        acquire: async () => { acquired = true; },
    };
    const bot: any = {
        _incomingFillQueue: [{ order_id: '1.7.574247542' }],
        _shuttingDown: false,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _deferredFillsPending: false,
        _deferredFillRetryTimer: null,
        _consecutiveConsumeFailures: 0,
        _consumeFailureFirstAt: 0,
        _warn: () => {},
        manager: m,
    };
    await consumeFillQueue(bot, {});
    assert.strictEqual(m.isBroadcastingActive(), false, 'stale flag must be cleared by the consume path');
    assert.strictEqual(acquired, true, 'lone fill must reach the lock with no maintenance tick');
    assert.strictEqual(bot._deferredFillRetryTimer, null, 'no retry needed once the gate passes');
    console.log('✓ RETRY-004 passed');
}

async function testRETRY005_FreshFlagStillDefers() {
    console.log('\n[RETRY-005] A fresh broadcast flag still defers (watchdog consults, never nukes)...');
    let watchdogCalls = 0;
    let acquired = false;
    const bot: any = makeFakeBot({ manager: {
        isBroadcastingActive: () => true,
        _clearStaleBroadcastFlag: () => { watchdogCalls++; },
        _fillProcessingLock: { acquire: async () => { acquired = true; } },
        _orphanFillsCreditedAt: null,
        logger: { log: () => {} },
    } });
    await consumeFillQueue(bot, {});
    assert.ok(watchdogCalls >= 1, 'consume path must consult the watchdog');
    assert.strictEqual(acquired, false, 'fresh flag must still defer (no lock acquire)');
    assert.ok(bot._deferredFillRetryTimer != null, 'deferred fresh-flag fill must arm the retry');
    clearRetryTimer(bot);
    console.log('✓ RETRY-005 passed');
}

async function testRETRY006_CowFinallyDrainsOnBatchEndEdge() {
    console.log('\n[RETRY-006] The COW batch finally drains on the batch-end edge...');
    // Minimal bot reaching the COW try/finally: a no-op plan passes the
    // pre-broadcast guards, then _ensureCredentialDaemonWritable throws AFTER
    // _batchInFlight++ / heldBroadcastSlot are set. The COW layer converts
    // the throw into a handled abort result, so the finally is the only thing
    // that can reschedule the parked queue.
    let resumed = 0;
    const queuedFill = { order_id: '1.7.574247542' };
    const bot: any = {
        config: { dryRun: false, gridLimits: {} },
        _shuttingDown: false,
        _incomingFillQueue: [queuedFill],
        _batchInFlight: 0,
        _cowBroadcastInFlight: false,
        _currentCycleId: 0,
        _markGridActivity: () => {},
        _warn: () => {},
        _log: () => {},
        _scheduleFillConsumerRestart: () => { resumed++; },
        _ensureCredentialDaemonWritable: async () => { throw new Error('credential daemon unwritable'); },
        _handleBatchHardAbort: async () => null,
        account: {}, privateKey: '',
        manager: {
            assets: { assetA: {}, assetB: {} },
            orders: new Map(),
            logger: { log: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: () => {},
            _setRebalanceState: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            isBroadcastingActive: () => false,
            _recoveryState: {},
        },
    };
    const result: any = await updateOrdersOnChainBatchCOW(bot, {
        workingGrid: new Map(), workingIndexes: new Map(), workingBoundary: null, actions: [],
    });
    assert.strictEqual(result?.executed, false, 'the injected credential failure must abort the batch');
    assert.strictEqual(bot._batchInFlight, 0, 'the finally must release the in-flight counter');
    assert.strictEqual(bot._cowBroadcastInFlight, false, 'the finally must release the broadcast slot');
    assert.strictEqual(resumed, 1, 'batch-end with a non-empty queue must reschedule the fill consumer (clearing-edge drain)');
    console.log('✓ RETRY-006 passed');
}

async function testRETRY007_CleanDrainRetiresRetryCounter() {
    console.log('\n[RETRY-007] A clean drain retires the deferred-retry counter...');
    const bot: any = makeFakeBot({
        _deferredFillRetryWaits: 7,
        // Empty queue => the consumer settles immediately without a timer.
        _incomingFillQueue: [],
    });
    await consumeFillQueue(bot, {});
    assert.strictEqual(bot._deferredFillRetryWaits, 0, 'settling with an empty queue must reset the deferral counter');
    assert.strictEqual(bot._deferredFillRetryTimer, null, 'no retry may be armed for an empty queue');
    console.log('✓ RETRY-007 passed');
}

async function runTests() {
    console.log('Running test_fill_defer_retry.js...\n');
    await testRETRY001_BroadcastDeferralArmsRetry();
    await testRETRY002_PipelineDeferralArmsRetry();
    await testRETRY003_RetryFiresWithoutNewFillOrRegionEnd();
    await testRETRY003b_ZeroRetryDelayIsHonored();
    await testRETRY004_StaleFlagClearsOnConsumePath();
    await testRETRY005_FreshFlagStillDefers();
    await testRETRY006_CowFinallyDrainsOnBatchEndEdge();
    await testRETRY007_CleanDrainRetiresRetryCounter();
    console.log('\nAll fill defer retry tests passed.\n');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
