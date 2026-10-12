/**
 * tests/test_hold_and_center_guards.ts
 *
 * Guards for the boundary-recovery center and the deferred-hold ledger:
 *
 *  - isNonBlockingUnmatchedOrder classifies every `*-deferred` reason as a
 *    deliberate hold, so a new defer reason cannot silently re-freeze the
 *    CREATE pipeline (finding 5b).
 *  - deriveTargetBoundary refuses a Tier-2/Tier-3 center that falls outside
 *    the live rail instead of pinning the boundary to an edge slot (finding 3).
 *  - StrategyEngine's pending-crawl ledger is capped at exactly 500 and does
 *    not record under dryRun (finding 4).
 *  - initializeGrid folds owed fill crawls into a static rebuild center
 *    instead of dropping their direction (finding 2).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../modules/paths');
const { setDerivePriceTestHook } = require('../modules/order/utils/system');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const {
    deriveTargetBoundary,
    isNonBlockingUnmatchedOrder,
} = require('../modules/order/utils/order');
const StrategyEngine = require('../modules/order/strategy').default;

const N = 51;
const GAP = 4;
const STEP = 1.01;
const CENTER_IDX = Math.max(0, Math.floor((N - 1 - GAP) / 2));

function buildSlots(count = N) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        slots.push({ id: `slot-${i}`, price: 100 * Math.pow(STEP, i) });
    }
    return slots;
}

function testHoldClassification() {
    console.log('\n[HOLD-001] every *-deferred reason is non-blocking; others still block...');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'out-of-grid-deferred' }), true,
        'out-of-grid holds must not block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'boundary-unknown-deferred' }), true,
        'boundary-unknown holds must not block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'future-reason-deferred' }), true,
        'a new -deferred reason must default to non-blocking');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'no-available-nearest-slot' }), false,
        'adoptable/cancellable orphans still block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'duplicate-price-level' }), false,
        'duplicate orphans still block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({}), false, 'missing reason blocks');
    assert.strictEqual(isNonBlockingUnmatchedOrder(null), false, 'null blocks');
    console.log('✓ HOLD-001 passed');
}

/**
 * HOLD-002..005 - the [HOLD] summary must be actionable and self-announcing.
 *
 * Fix 4 (detail) and fix 5 (slow re-warn) exist because "N orders held" is
 * ambiguous: it reads the same whether a deliberate deferral is being handled
 * or the loop has silently stopped progressing. These pin the detail fields
 * (why + how far off-grid) and the warn cadence.
 */
function testDeferredHoldSummary() {
    const { _internalDeferredHold } = require('../modules/dexbot_maintenance_runtime').default;
    const { logDeferredHoldSummary, describeDeferredHolds } = _internalDeferredHold;
    const genesis = { priceLevels: [100, 101, 102, 103, 104, 105] };

    // HOLD-002: detail names side, price, size, reason and the off-grid distance.
    console.log('\n[HOLD-002] detail names why a hold is held and how far off-grid...');
    const detail = describeDeferredHolds(
        { manager: { _genesis: genesis } },
        [{ chainOrderId: '1.7.11', type: ORDER_TYPES.BUY, price: 95, size: 3, reason: 'out-of-grid-deferred' }]
    );
    assert.ok(detail.includes('1.7.11'), 'detail must name the chain order id');
    assert.ok(detail.includes('buy'), 'detail must name the side');
    assert.ok(detail.includes('price=95'), 'detail must name the price');
    assert.ok(detail.includes('size=3'), 'detail must name the size');
    assert.ok(detail.includes('out-of-grid-deferred'), 'detail must name the reason');
    assert.ok(/below-grid by 5\.0000%/.test(detail), `expected a below-grid distance, got: ${detail}`);
    console.log('✓ HOLD-002 passed');

    // HOLD-003: an above-grid sell reports above-grid distance, not below.
    console.log('\n[HOLD-003] an above-grid hold reports an above-grid distance...');
    const above = describeDeferredHolds(
        { manager: { _genesis: genesis } },
        [{ chainOrderId: '1.7.12', type: ORDER_TYPES.SELL, price: 110, size: 1, reason: 'out-of-grid-deferred' }]
    );
    assert.ok(/above-grid by 4\.7619%/.test(above), `expected an above-grid distance, got: ${above}`);
    assert.ok(!above.includes('below-grid'), 'an above-grid hold must not be reported as below-grid');
    console.log('✓ HOLD-003 passed');

    // HOLD-004: logs once on a change, then stays quiet, then re-warns after
    // the rate limit -- it must not be silent forever.
    console.log('\n[HOLD-004] logs on change, goes quiet, then slowly re-warns...');
    const logs: string[] = [];
    const bot: any = {
        manager: { _genesis: genesis, _lastUnmatchedChainOrdersAt: Date.now() - 5 * 60000 },
        _log: (m: string) => logs.push(m),
    };
    bot.manager._lastUnmatchedChainOrders = [
        { chainOrderId: '1.7.13', type: ORDER_TYPES.BUY, price: 95, size: 2, reason: 'out-of-grid-deferred' }
    ];

    logDeferredHoldSummary(bot);
    assert.strictEqual(logs.length, 1, 'first observation must log');
    assert.ok(logs[0].includes('[HOLD]'), 'must carry the [HOLD] prefix');
    assert.ok(logs[0].includes('1.7.13'), 'detail must be inlined into the summary');

    logDeferredHoldSummary(bot);
    assert.strictEqual(logs.length, 1, 'an unchanged hold must not re-log every tick');

    bot._lastHeldChainOrderWarnAt = Date.now() - 120000;
    logDeferredHoldSummary(bot);
    assert.strictEqual(logs.length, 2, 'a long-unchanged hold must eventually re-warn');
    assert.ok(/still holding 1 deferred/.test(logs[1]), `expected a re-warn, got: ${logs[1]}`);
    console.log('✓ HOLD-004 passed');

    // HOLD-005: same-count churn must re-log (count-only gating hid this).
    console.log('\n[HOLD-005] same-count churn re-logs...');
    bot.manager._lastUnmatchedChainOrders = [
        { chainOrderId: '1.7.99', type: ORDER_TYPES.BUY, price: 96, size: 2, reason: 'out-of-grid-deferred' }
    ];
    bot._lastHeldChainOrderWarnAt = Date.now();
    logDeferredHoldSummary(bot);
    assert.strictEqual(logs.length, 3, 'a different order at the same count must re-log');
    assert.ok(logs[2].includes('1.7.99'), 'the new hold must be named');

    // Clearing holds resets the cadence state.
    bot.manager._lastUnmatchedChainOrders = [];
    logDeferredHoldSummary(bot);
    assert.strictEqual(bot._lastHeldChainOrderSignature, '', 'clearing holds must reset the signature');
    assert.strictEqual(bot._lastHeldChainOrderWarnAt, 0, 'clearing holds must reset the warn timer');
    assert.strictEqual(logs.length, 3, 'clearing holds must not log');
    console.log('✓ HOLD-005 passed');
}

/**
 * HOLD-006..009 - an indefinitely-held deferred hold must have an EXIT.
 *
 * Out-of-rail orphans hold locked funds and are never auto-cancelled per cycle;
 * that default is correct (cancelling on ambiguous evidence is irreversible).
 * The gap was that "held indefinitely" had no exit at all: the bot held, warned
 * and warned forever. A hold that survives unchanged for DEFERRED_HOLD_ESCALATE_MS
 * is no longer ambiguous, so it escalates to the structural resync whose
 * reconcile is update-first (funds released by price-updating onto rail slots,
 * only true surplus cancelled).
 *
 * The clock MUST be the signature-stable timestamp, not
 * manager._lastUnmatchedChainOrdersAt: the latter is refreshed on every sync
 * that observes ANY unmatched order, so it records "when we last looked" and an
 * age gate on it could never fire. HOLD-007 pins exactly that.
 */
function testDeferredHoldEscalation() {
    const { _internalDeferredHold } = require('../modules/dexbot_maintenance_runtime').default;
    const { logDeferredHoldSummary } = _internalDeferredHold;
    const { TIMING } = require('../modules/constants');
    const genesis = { priceLevels: [100, 101, 102, 103, 104, 105] };
    const ESCALATE_MS = TIMING.DEFERRED_HOLD_ESCALATE_MS;
    assert.ok(ESCALATE_MS > 0, 'fixture: DEFERRED_HOLD_ESCALATE_MS must be configured');

    // Age every currently-tracked stranded hold by `ms`. The runtime tracks age
    // PER STRANDED ORDER (keyed id@price/size:reason), so tests must age that
    // map rather than a single timestamp.
    const backdateStranded = (bot: any, ms: number) => {
        assert.ok(bot._strandedHoldSince instanceof Map, 'fixture: bot must track per-order hold ages');
        assert.ok(bot._strandedHoldSince.size > 0, 'fixture: expected at least one tracked stranded hold');
        const strandedAges = bot._strandedHoldSince as Map<string, number>;
        for (const [k, v] of strandedAges) {
            strandedAges.set(k, Number(v) - ms);
        }
    };

    const makeBot = () => {
        const logs: Array<{ msg: string; level?: string }> = [];
        const resyncs: any[] = [];
        const bot: any = {
            manager: {
                _genesis: genesis,
                _lastUnmatchedChainOrders: [
                    { chainOrderId: '1.7.21', type: ORDER_TYPES.BUY, price: 95, size: 2, reason: 'out-of-grid-deferred' }
                ],
                requestStructuralGridResync: (reason: any, details: any) => { resyncs.push({ reason, details }); return { scheduled: true }; },
            },
            _log: (m: string, level?: string) => logs.push({ msg: m, level }),
        };
        return { bot, logs, resyncs };
    };

    // HOLD-006: a hold younger than the threshold must NOT escalate.
    console.log('\n[HOLD-006] a fresh hold does not escalate...');
    {
        const { bot, resyncs } = makeBot();
        logDeferredHoldSummary(bot);   // first sighting starts the per-order clock
        logDeferredHoldSummary(bot);   // still ~0s old
        assert.strictEqual(resyncs.length, 0, 'a fresh hold must not escalate');
    }
    console.log('\u2713 HOLD-006 passed');

    // HOLD-007: age is measured from the per-order stranded clock, NOT from
    // manager._lastUnmatchedChainOrdersAt (which is "now" on every sync).
    console.log('\n[HOLD-007] the age clock is per-order, not the sync-refreshed one...');
    {
        const { bot, resyncs } = makeBot();
        bot.manager._lastUnmatchedChainOrdersAt = Date.now(); // refreshed this sync
        logDeferredHoldSummary(bot);                          // starts the per-order clock
        backdateStranded(bot, ESCALATE_MS + 60000);
        // The sync-refreshed clock still says "just now"; only the per-order clock is old.
        bot.manager._lastUnmatchedChainOrdersAt = Date.now();
        logDeferredHoldSummary(bot);
        assert.strictEqual(resyncs.length, 1,
            'must escalate on the per-order age even though _lastUnmatchedChainOrdersAt is fresh');
        assert.strictEqual(resyncs[0].reason, 'deferred-hold-stale', 'must use the deferred-hold reason');
    }
    console.log('\u2713 HOLD-007 passed');

    // HOLD-008: escalation is fire-and-forget, logs at error, and carries detail.
    console.log('\n[HOLD-008] escalation logs at error with the held detail...');
    {
        const { bot, logs, resyncs } = makeBot();
        logDeferredHoldSummary(bot);
        backdateStranded(bot, ESCALATE_MS + 3600000);
        logDeferredHoldSummary(bot);
        assert.strictEqual(resyncs.length, 1, 'a long-stale hold must escalate');
        const err = logs.find(l => l.level === 'error');
        assert.ok(err, `expected an error-level escalation log, got: ${JSON.stringify(logs)}`);
        assert.ok(err!.msg.includes('1.7.21'), 'the escalation log must name the held order');
        assert.ok(/held unchanged for ~\d+h/.test(err!.msg), `expected an age in hours, got: ${err!.msg}`);
    }
    console.log('\u2713 HOLD-008 passed');

    // HOLD-009: the cooldown suppresses repeats of the SAME escalation, and a
    // signature change restarts the clock (a new hold is not "stale").
    console.log('\n[HOLD-009] cooldown suppresses repeats; a signature change restarts the clock...');
    {
        const { bot, resyncs } = makeBot();
        logDeferredHoldSummary(bot);
        backdateStranded(bot, ESCALATE_MS + 60000);
        logDeferredHoldSummary(bot);
        logDeferredHoldSummary(bot);
        logDeferredHoldSummary(bot);
        assert.strictEqual(resyncs.length, 1, 'repeats inside the cooldown window must be suppressed');

        // A DIFFERENT stranded order is a new hold with its own fresh clock, so
        // even with the cooldown expired it must not immediately escalate.
        bot.manager._lastUnmatchedChainOrders = [
            { chainOrderId: '1.7.22', type: ORDER_TYPES.SELL, price: 110, size: 1, reason: 'out-of-grid-deferred' }
        ];
        bot._lastDeferredHoldResyncAt = 0; // clear cooldown: isolate the age effect
        const before = resyncs.length;
        logDeferredHoldSummary(bot);
        logDeferredHoldSummary(bot);
        assert.strictEqual(resyncs.length, before, 'a freshly-seen stranded hold must not escalate');
    }
    console.log('\u2713 HOLD-009 passed');

    // HOLD-010: unrelated transient churn must NOT starve a stranded hold.
    //
    // The whole-held-set signature includes each entry's reason, so an
    // unrelated hold flapping in and out changes the signature every cycle.
    // Ageing off that signature resets the clock forever and the stranded
    // order never escalates (verified by simulation before this test existed:
    // a 6-hourly flap produced CLOCK RESET on every tick). Per-order age is
    // immune, and this pins it.
    console.log('\n[HOLD-010] unrelated flapping holds do not starve a stranded hold...');
    {
        const { bot, resyncs } = makeBot();
        const stranded = { chainOrderId: '1.7.21', type: ORDER_TYPES.BUY, price: 95, size: 2, reason: 'out-of-grid-deferred' };
        const flap = { chainOrderId: '1.7.99', type: ORDER_TYPES.SELL, price: 150, size: 5, reason: 'broadcast-active-deferred' };

        // Cycle 1: stranded order first seen.
        bot.manager._lastUnmatchedChainOrders = [stranded];
        logDeferredHoldSummary(bot);

        // Simulate many cycles of a transient hold appearing and disappearing
        // while the stranded order persists. Backdate only by real elapsed
        // simulation time, never resetting the stranded clock.
        const cycleMs = 6 * 3600 * 1000;
        let elapsed = 0;
        for (let i = 0; i < 5; i++) {
            elapsed += cycleMs;
            backdateStranded(bot, cycleMs - 0); // time passes for the stranded order
            bot.manager._lastUnmatchedChainOrders = [stranded, flap];
            logDeferredHoldSummary(bot);
            bot.manager._lastUnmatchedChainOrders = [stranded];
            logDeferredHoldSummary(bot);
        }

        // Escalation must happen, and must be driven by the stranded order's
        // own age. It may fire on a flap-in or flap-out cycle, so assert the
        // count reflects the STRANDED subset (always 1), never the transient
        // flapper.
        assert.strictEqual(resyncs.length, 1,
            `a stranded hold must still escalate despite unrelated churn (elapsed ${elapsed / 3600000}h)`);
        assert.strictEqual(resyncs[0].details.heldCount, 1,
            'the escalation must count only the stranded hold, not the transient flapper');
        assert.ok(resyncs[0].details.heldMs >= ESCALATE_MS,
            'escalation must be driven by the stranded order age, not the churn');
    }
    console.log('\u2713 HOLD-010 passed');

    // HOLD-011: transient/actively-owned holds are not escalation triggers at
    // all. A resync cannot end a broadcast region or re-evaluate an uncommitted
    // boundary, so escalating on those spends a grid reload on something the
    // owning machinery already resolves.
    console.log('\n[HOLD-011] transient holds are never escalation triggers...');
    {
        for (const reason of ['broadcast-active-deferred', 'boundary-hold-trailing-market',
                              'held-plan-unchanged-deferred', 'boundary-unknown-deferred',
                              'fingerprinted-handle-via-recovery']) {
            const { bot, resyncs } = makeBot();
            bot.manager._lastUnmatchedChainOrders = [
                { chainOrderId: '1.7.5', type: ORDER_TYPES.BUY, price: 95, size: 1, reason }
            ];
            logDeferredHoldSummary(bot);
            logDeferredHoldSummary(bot);
            assert.strictEqual(resyncs.length, 0,
                `${reason} must NOT trigger a structural resync (it is not stranded)`);
        }
        // Sanity: a genuinely stranded hold in the same shape DOES escalate.
        const { bot, resyncs } = makeBot();
        logDeferredHoldSummary(bot);
        backdateStranded(bot, ESCALATE_MS + 60000);
        logDeferredHoldSummary(bot);
        assert.strictEqual(resyncs.length, 1, 'a genuinely stranded hold must escalate');
    }
    console.log('\u2713 HOLD-011 passed');
}

function testOutOfRailCenterFallsBackToRailCenter() {
    console.log('\n[CENTER-001] stale numeric startPrice outside the rail falls back to rail center...');
    const slots = buildSlots();
    const railCenterBoundary = CENTER_IDX - Math.floor(GAP / 2) - 1;
    const edgeBoundary = N - Math.floor(GAP / 2) - 1;
    assert.notStrictEqual(railCenterBoundary, edgeBoundary, 'fixture must distinguish center from edge');

    const stale = deriveTargetBoundary([], null, slots, {
        startPrice: 1e9,
        coreOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.strictEqual(stale.boundaryIdx, railCenterBoundary,
        'an out-of-rail numeric center must not pin the boundary to the top edge');
    assert.notStrictEqual(stale.boundaryIdx, edgeBoundary, 'must not be the rail-edge fabrication');

    // Control: an in-rail numeric center keeps the honest boundary math.
    const honest = deriveTargetBoundary([], null, slots, {
        startPrice: slots[10].price,
        coreOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.strictEqual(honest.boundaryIdx, 10 - Math.floor(GAP / 2) - 1,
        'an in-rail center still resolves the honest boundary');
    console.log('✓ CENTER-001 passed');
}

function testOutOfRailGenesisFallsBackToRailCenter() {
    console.log('\n[CENTER-002] out-of-rail genesis center falls back to rail center...');
    const slots = buildSlots();
    const railCenterBoundary = CENTER_IDX - Math.floor(GAP / 2) - 1;
    const res = deriveTargetBoundary([], null, slots, {
        startPrice: 'pool',
        genesisStartPrice: 1e9,
        coreOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.strictEqual(res.boundaryIdx, railCenterBoundary,
        'an out-of-rail genesis center must not pin the boundary to an edge');
    console.log('✓ CENTER-002 passed');
}

function testOutOfRailFillAnchorStillWins() {
    console.log('\n[CENTER-003] Tier-1 fill anchor is exempt (live market wins)...');
    const slots = buildSlots();
    // A fill above the rail is still real market position — the guard must not
    // override Tier-1 the way it drops a stale config center.
    const res = deriveTargetBoundary([
        { id: 'slot-x', type: ORDER_TYPES.SELL, price: 1e9, isPartial: false },
    ], null, slots, {
        startPrice: 'pool',
        coreOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.ok(res.boundaryIdx > CENTER_IDX,
        `out-of-rail fill anchor must still drive the boundary high (got ${res.boundaryIdx})`);
    console.log('✓ CENTER-003 passed');
}

async function testPendingCrawlLedgerCapAndDryRun() {
    console.log('\n[PEND-CAP-001] ledger capped at exactly 500; dryRun records nothing...');
    const mgr = {
        orders: new Map(),
        logger: { log() {} },
        config: {},
        _pendingFillCrawls: [],
        _markGridDirty() {},
        recalculateFunds() {},
    };
    for (let i = 0; i < 500; i++) {
        mgr._pendingFillCrawls.push({ slotId: `pre-${i}`, side: ORDER_TYPES.BUY, ts: 1 });
    }
    const strategy = new StrategyEngine(mgr);
    await strategy.processFillsOnly([
        { id: 'slot-fresh', type: ORDER_TYPES.BUY, price: 1, size: 1, isPartial: false },
    ]);
    assert.strictEqual(mgr._pendingFillCrawls.length, 500,
        'in-memory length must match the persisted slice(-500) cap exactly');
    assert.strictEqual(mgr._pendingFillCrawls[mgr._pendingFillCrawls.length - 1].slotId, 'slot-fresh',
        'newest entry survives the cap');

    const dryMgr = {
        orders: new Map(),
        logger: { log() {} },
        config: { dryRun: true },
        _pendingFillCrawls: [],
        _markGridDirty() {},
        recalculateFunds() {},
    };
    const dryStrategy = new StrategyEngine(dryMgr);
    await dryStrategy.processFillsOnly([
        { id: 'slot-dry', type: ORDER_TYPES.BUY, price: 1, size: 1, isPartial: false },
    ]);
    assert.strictEqual(dryMgr._pendingFillCrawls.length, 0,
        'dryRun never commits a boundary, so it must not record crawls');
    console.log('✓ PEND-CAP-001 passed');
}

async function testRebuildFoldsOwedCrawlsIntoStaticCenter() {
    console.log('\n[REBUILD-FOLD-001] owed crawls shift a static rebuild center...');
    const { OrderManager, grid: Grid } = require('../modules/order').default;
    const baseCfg = {
        name: 'fold-test',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 150,
        minPrice: 100,
        maxPrice: 200,
        incrementPercent: 1,
        targetSpreadPercent: 4,
        coreOrders: { buy: 3, sell: 3 },
        logging: { level: 'error' },
    };

    const buildManager = async (overrides = {}) => {
        const manager = new OrderManager({ ...baseCfg, ...overrides });
        manager.assets = {
            assetA: { id: '1.3.100', symbol: 'BTS', precision: 3 },
            assetB: { id: '1.3.101', symbol: 'USD', precision: 3 },
        };
        await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });
        return manager;
    };
    const owedSell = [{ slotId: 'slot-x', side: ORDER_TYPES.SELL, ts: 1 }];
    const foldedCenter = 150 * STEP;

    // Control: no owed crawls -> the static center is unchanged.
    const control = await buildManager();
    await Grid.initializeGrid(control);
    assert.strictEqual(Number(control.config.startPrice), 150,
        'a rebuild with no owed crawls keeps the static center');

    // One net sell crawl -> the static center shifts up by one ladder step.
    const manager = await buildManager();
    manager._pendingFillCrawls = [...owedSell];
    await Grid.initializeGrid(manager);
    assert.ok(Math.abs(Number(manager.config.startPrice) - foldedCenter) < 1e-9,
        `static center must fold the net crawl (expected ~${foldedCenter}, got ${manager.config.startPrice})`);
    assert.ok(Math.abs(Number(manager._genesis?.startPrice) - foldedCenter) < 1e-9,
        'the generated genesis center must match the folded center');
    assert.deepStrictEqual(manager._pendingFillCrawls, [],
        'a rebuild consumes the owed ledger once folded');
    console.log('✓ REBUILD-FOLD-001 passed');

    // Mixed mode: numeric startPrice + live gridPrice. The CENTER is still the
    // static config value (gridPrice only feeds the bounds reference), so the
    // owed crawl must still fold. The test hook also resolves the pool gp
    // offline (the gp source must not mask the static center).
    setDerivePriceTestHook(async () => 150);
    try {
        {
            const mixed = await buildManager({ gridPrice: 'pool' });
            mixed._pendingFillCrawls = [...owedSell];
            await Grid.initializeGrid(mixed);
            assert.ok(Math.abs(Number(mixed.config.startPrice) - foldedCenter) < 1e-9,
                `numeric center + pool gridPrice must still fold (got ${mixed.config.startPrice})`);
            console.log('✓ REBUILD-FOLD-002 passed');
        }

        // Mixed mode: derived startPrice + numeric gridPrice. The center was
        // resolved from live market data, so it already contains the movement —
        // the owed crawl must be dropped, not double-counted.
        {
            const derived = await buildManager({ startPrice: 'book', gridPrice: 150 });
            derived._pendingFillCrawls = [...owedSell];
            await Grid.initializeGrid(derived);
            assert.ok(Math.abs(Number(derived.config.startPrice) - 150) < 1e-9,
                `derived live center must not fold (got ${derived.config.startPrice})`);
            assert.deepStrictEqual(derived._pendingFillCrawls, [],
                'a live-center rebuild drops the owed ledger');
            console.log('✓ REBUILD-FOLD-003 passed');
        }
    } finally {
        setDerivePriceTestHook(null);
    }

    // Mixed mode: numeric startPrice + AMA gridPrice. Per the stated intent the
    // AMA snapshot offsets the center live, so the crawl is dropped.
    {
        const amaBotKey = 'fold-ama-test';
        const amaFile = path.join(PATHS.ORDERS_DIR, `${amaBotKey}.dynamicgrid.json`);
        fs.writeFileSync(amaFile, JSON.stringify({ gridCenterPrice: 150, source: 'test', updatedAt: new Date().toISOString() }));
        try {
            const ama = await buildManager({ botKey: amaBotKey, gridPrice: 'ama' });
            ama._pendingFillCrawls = [...owedSell];
            await Grid.initializeGrid(ama);
            assert.ok(Math.abs(Number(ama.config.startPrice) - 150) < 1e-9,
                `numeric center + ama gridPrice must not fold (got ${ama.config.startPrice})`);
            assert.deepStrictEqual(ama._pendingFillCrawls, [],
                'an ama-center rebuild drops the owed ledger');
        } finally {
            try { fs.unlinkSync(amaFile); } catch { /* absent */ }
        }
        console.log('✓ REBUILD-FOLD-004 passed');
    }
}

async function testInitialActivationRailGate() {
    console.log('\n[RAIL-GATE-001] getInitialOrdersToActivate drops a slot whose stored rail is stale...');
    const { OrderManager } = require('../modules/order').default;
    const manager = new OrderManager({
        name: 'rail-gate-test',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 1,
        coreOrders: { buy: 2, sell: 2 },
        logging: { level: 'error' },
    });
    manager.assets = {
        assetA: { id: '1.3.100', symbol: 'BTS', precision: 3 },
        assetB: { id: '1.3.101', symbol: 'USD', precision: 3 },
    };
    manager.boundaryIdx = 5;
    manager._gapSlots = 4; // SELL rail starts at slot-10

    const orders = new Map();
    for (let i = 0; i <= 15; i++) {
        orders.set(`slot-${i}`, {
            id: `slot-${i}`, price: 50 + i, type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL, size: 1, orderId: '',
        });
    }
    // Stale rail: stored SELL but geometrically below the boundary. It sorts
    // closest-to-market and would be picked without the geometry gate.
    orders.set('slot-3', {
        id: 'slot-3', price: 53, type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL, size: 1, orderId: '',
    });
    // Genuine in-rail sell (>= sellStart 10) that must still activate.
    orders.set('slot-12', {
        id: 'slot-12', price: 62, type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL, size: 1, orderId: '',
    });
    manager.orders = orders;

    const picked = manager.getInitialOrdersToActivate();
    const sellIds = picked.filter((o: any) => o.type === ORDER_TYPES.SELL).map((o: any) => o.id);
    assert.ok(!sellIds.includes('slot-3'),
        'a SELL stored below the boundary must be gated out of the sell rail');
    assert.ok(sellIds.includes('slot-12'),
        'an in-rail sell must still activate');
    console.log('✓ RAIL-GATE-001 passed');
}

async function runTests() {
    console.log('Running hold + boundary-center guard tests...');
    testHoldClassification();
    testDeferredHoldSummary();
    testDeferredHoldEscalation();
    testOutOfRailCenterFallsBackToRailCenter();
    testOutOfRailGenesisFallsBackToRailCenter();
    testOutOfRailFillAnchorStillWins();
    await testPendingCrawlLedgerCapAndDryRun();
    await testRebuildFoldsOwedCrawlsIntoStaticCenter();
    await testInitialActivationRailGate();
    console.log('\n✓ All hold + boundary-center guard tests passed.');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\n✗ Hold + boundary-center guard tests failed');
    console.error(err);
    process.exit(1);
});
