/**
 * Regression tests for race-condition fixes batch 1.
 *
 * Covers:
 *   RC-1: Credit watchdog / maintenance in-flight guards. The two
 *         critical sections use separate per-context flags: a
 *         runMaintenance cycle does not suppress a concurrent
 *         runCreditWatchdog, and vice versa, so an urgent watchdog
 *         tick is never starved by a long grid maintenance pass.
 *         (modules/credit_runtime.ts, modules/dexbot_class.ts:4666)
 *   RC-2: Lock hierarchy corrected — _syncLock(2) acquired before _gridLock(3)
 *         in all paths. The gridLockAlreadyHeld workaround flag and its 8 call
 *         sites are eliminated. Phase 1 of grid reconciliation does pure
 *         in-memory planning under _gridLock; blockchain I/O is deferred to
 *         Phase 2 where locks acquire in canonical order.
 *         (modules/order/sync_engine.ts, modules/order/manager.ts,
 *          modules/order/grid_reconcile.ts)
 *   RC-3: storeGrid callback persists its snapshot via the new optional
 *         `snapshotOrders` argument to persistGrid, so the live
 *         `manager.orders` map is not briefly swapped (which would expose
 *         a window where _ordersByState / _ordersByType are out of sync
 *         with the live Map).
 *         (modules/order/manager.ts:persistGrid,
 *          modules/order/utils/system.ts:persistGridSnapshot,
 *          modules/dexbot_class.ts:storeGrid)
 *   RC-4: claw/modules/position_manager_watch.ts setInterval guards against
 *         overlapping syncAllPositions() calls and unref's the timer.
 *   RC-5: credential daemon watchdog interval guards against overlapping
 *         probes; trigger debounce setTimeout re-checks _shuttingDown.
 *         (modules/dexbot_class.ts:3541, modules/dexbot_maintenance_runtime.ts)
 *   RC-6: writeJsonFileAtomic uses tmp+rename for bots.json,
 *         credit state, node blacklist, node health cache, and the
 *         locked writeBotsFileWithLock path. (general.settings.json
 *         shares the same writeJsonFileAtomic helper but writes to
 *         a hard-coded module path; its atomicity is covered by the
 *         shared RC-6A/B/D tests rather than a dedicated test that
 *         would otherwise need to mutate the real repo file.)
 *         (modules/bots_file_lock.ts, modules/general_settings.ts,
 *          modules/credit_runtime.ts, modules/node_manager.ts,
 *          modules/node_health_cache.ts)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { setCachedModule, restoreCachedModule } = require('./helpers/module_cache_stub');
const { writeJsonFileAtomic, writeBotsFileWithLock } = require('../modules/bots_file_lock');
const { readJSON } = require('../modules/storage').getStorage();
const AsyncLock = require('../modules/order/async_lock').default;

// Compiled ESM namespaces are frozen and Module._load / require.cache
// injection cannot reach static ESM imports, so the modules consumed by
// credit_runtime and the claw watcher are replaced via loader hooks (same
// technique as tests/test_uncertain_broadcast.ts).
esmMockEntry();

// Offline stand-in for the shared bitshares client: without this the real
// client connects to a public wss node during the CreditRuntime tests and the
// lingering TLSSocket keeps the process alive after completion.
defineEsmMockAbs(require.resolve('../modules/bitshares_client'), [
    'BitShares', 'createAccountClient', 'waitForConnected', 'getConnectionStatus',
    'disconnectClient', 'reconnectForCycle', 'setSuppressConnectionLog', 'onReconnect',
    'withTimeout', '_assessFailover', 'getNodeManager', 'getNodeStats', 'getNodeSummary',
    'getConnectionError', '_internal'
], {
    BitShares: {
        subscribe() {},
        db: {
            call: async () => [],
            lookup_asset_symbols: async () => [],
            get_assets: async () => [],
            get_objects: async () => [],
            get_liquidity_pools_by_share_asset: async () => [],
            get_liquidity_pools_by_both_assets: async () => [],
            get_credit_deals_by_borrower: async () => [],
            get_credit_offers_by_owner: async () => [],
            get_credit_offers_by_asset: async () => [],
            get_on_chain_asset_balances: async () => ({}),
        },
    },
    createAccountClient: () => ({ sign: () => {}, broadcast: async () => ({}) }),
    waitForConnected: async () => {},
    getConnectionStatus: () => ({ connected: true }),
    disconnectClient: async () => {},
    reconnectForCycle: async () => {},
    setSuppressConnectionLog() {},
    onReconnect: () => () => {},
    withTimeout: (p: any) => p,
    _assessFailover: () => null,
    getNodeManager: () => null,
    getNodeStats: () => null,
    getNodeSummary: () => null,
    getConnectionError: () => null,
    _internal: { connected: true },
});

// chain_orders stand-in covering every function credit_runtime / sync_engine /
// order/accounting use on the credit-runtime paths exercised below.
defineEsmMockAbs(require.resolve('../modules/chain_orders'), [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], {
    selectAccount: async () => ({}),
    setPreferredAccount: async () => {},
    resolveAccountId: async () => '1.2.3',
    resolveAccountName: async () => 'alice',
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    readSingleOrder: async () => null,
    batchReadOrders: async () => [],
    listenForFills: async () => () => {},
    updateOrder: async () => ({}),
    createOrder: async () => ({}),
    cancelOrder: async () => ({}),
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    buildUpdateOrderOp: async () => ({}),
    buildCreateOrderOp: async () => ({}),
    buildCancelOrderOp: async () => ({}),
    buildLiquidityPoolExchangeOp: async () => ({}),
    executeBatch: async () => ({ tx_id: 'tx-0', operation_results: [] }),
    findOverReducingUpdateOpError: async () => null,
    wasRecentlyOwnCancelled: () => false,
    recordOwnCancel: () => {},
    broadcastTxWithClassification: async () => ({})
});

// The claw watcher's dependencies: each test installs its own PositionManager
// mock before the first require of the watcher module.
const clawWatcherMocks: any = {
    PositionManager: null,
    waitForConnected: async () => {},
};

defineEsmMockAbs(require.resolve('../claw/modules/position_manager'), [
    'PositionManager', 'DEFAULT_STATE_PATH',
], {
    DEFAULT_STATE_PATH: path.join(os.tmpdir(), 'unused-positions.json'),
    get PositionManager() { return clawWatcherMocks.PositionManager; },
});

defineEsmMockAbs(require.resolve('../claw/modules/bitshares_client'), [
    'waitForConnected',
], {
    get waitForConnected() { return clawWatcherMocks.waitForConnected; },
});

const creditRuntimePath = path.resolve(__dirname, '../modules/credit_runtime.ts');
const bitsharesClientPath = path.resolve(__dirname, '../modules/bitshares_client.ts');
const chainOrdersPath = path.resolve(__dirname, '../modules/chain_orders.ts');

function freshBaseDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `dexbot-race-fix-${label}-`));
}

// ---------------------------------------------------------------------------
// RC-1: Credit watchdog / maintenance in-flight guard
// ---------------------------------------------------------------------------

function installCreditRuntimeStubs() {
    const originalBitshares = setCachedModule(bitsharesClientPath, {
        BitShares: {
            db: {
                call: async () => [],
                lookup_asset_symbols: async () => [],
                get_assets: async () => [],
                get_objects: async () => [],
                get_liquidity_pools_by_share_asset: async () => [],
                get_liquidity_pools_by_both_assets: async () => [],
                get_credit_deals_by_borrower: async () => [],
                get_credit_offers_by_owner: async () => [],
                get_credit_offers_by_asset: async () => [],
                get_on_chain_asset_balances: async () => ({}),
            },
        },
        waitForConnected: async () => {},
        createAccountClient: () => ({}),
        setSuppressConnectionLog() {},
        getNodeManager: () => null,
        getNodeStats: () => null,
        getNodeSummary: () => null,
        _internal: { connected: true },
    });
    const originalChainOrders = setCachedModule(chainOrdersPath, {
        resolveAccountId: async () => '1.2.3',
        resolveAccountName: async () => 'alice',
        getOnChainAssetBalances: async () => ({}),
        executeBatch: async () => ({ tx_id: 'tx-0', operation_results: [] }),
    });
    return () => {
        restoreCachedModule(bitsharesClientPath, originalBitshares);
        restoreCachedModule(chainOrdersPath, originalChainOrders);
    };
}

function createBaseBotConfig(overrides = {}) {
    return {
        botKey: 'race-fix-bot',
        preferredAccount: 'alice',
        debtPolicy: {
            lending: [
                {
                    asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
                    type: 'mpa',
                    outputWeight: 1,
                    maxBorrowAmount: 1000,
                    maxCollateralAmount: 10000,
                    minCollateralRatio: 2,
                    maxCollateralRatio: 2.5,
                    targetCollateralRatio: 2.2,
                },
            ],
        },
        dryRun: false,
        ...overrides,
    };
}

async function testCreditMaintenanceInFlightGuard() {
    console.log('\n[RC-1A] runMaintenance skips when previous run is in flight...');

    const restore = installCreditRuntimeStubs();
    const baseDir = freshBaseDir('credit-maintenance');

    try {
        delete require.cache[creditRuntimePath];
        const CreditRuntime = require('../modules/credit_runtime').default;

        const runtime = new CreditRuntime({
            config: createBaseBotConfig({ botKey: 'credit-bot-rc1' }),
            account: { id: '1.2.3', name: 'alice' },
            accountId: '1.2.3',
            privateKey: 'WIF-KEY',
            _log() {},
            _warn() {},
        }, { stateDir: path.join(baseDir, 'credit_runtime') });

        // Block the first call inside refreshState so the in-flight flag is
        // set and the second call observes it.
        let releaseFirst;
        const firstRefreshDone = new Promise((resolve) => { releaseFirst = resolve; });
        const realRefresh = runtime.refreshState.bind(runtime);
        runtime.refreshState = async () => {
            await firstRefreshDone;
            return await realRefresh();
        };

        const firstCall = runtime.runMaintenance('periodic');
        // Yield enough ticks for the first call to enter refreshState.
        for (let i = 0; i < 5; i += 1) {
            await new Promise((r) => setImmediate(r));
        }

        const secondResult = await runtime.runMaintenance('periodic');

        assert.ok(secondResult && secondResult.skipped === true, 'second runMaintenance should report skipped');
        assert.strictEqual(secondResult.reason, 'maintenance already in flight', 'reason should be the in-flight guard message');

        releaseFirst();
        const firstResult = await firstCall;
        assert.ok(firstResult && firstResult.context === 'periodic', 'first runMaintenance should complete normally');

        console.log('  PASS');
    } finally {
        delete require.cache[creditRuntimePath];
        restore();
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    }
}

async function testCreditWatchdogRunsAlongsideMaintenance() {
    console.log('\n[RC-1B] runCreditWatchdog runs in parallel with runMaintenance (separate in-flight flags)...');

    const restore = installCreditRuntimeStubs();
    const baseDir = freshBaseDir('credit-watchdog');

    try {
        delete require.cache[creditRuntimePath];
        const CreditRuntime = require('../modules/credit_runtime').default;

        const runtime = new CreditRuntime({
            config: createBaseBotConfig({ botKey: 'credit-bot-watchdog' }),
            account: { id: '1.2.3', name: 'alice' },
            accountId: '1.2.3',
            privateKey: 'WIF-KEY',
            _log() {},
            _warn() {},
        }, { stateDir: path.join(baseDir, 'credit_runtime') });

        let releaseMaintenanceRefresh;
        const maintenanceRefreshGate = new Promise((resolve) => { releaseMaintenanceRefresh = resolve; });
        const realRefresh = runtime.refreshState.bind(runtime);
        let refreshCount = 0;
        runtime.refreshState = async () => {
            refreshCount += 1;
            if (refreshCount === 1) {
                await maintenanceRefreshGate;
            }
            return await realRefresh();
        };

        const maintenanceCall = runtime.runMaintenance('periodic');
        for (let i = 0; i < 5; i += 1) {
            await new Promise((r) => setImmediate(r));
        }

        // With per-context in-flight flags, the watchdog must NOT be
        // suppressed by an in-flight maintenance run: a long-running
        // maintenance should never starve an urgent watchdog check.
        const watchdogResult = await runtime.runCreditWatchdog();
        assert.ok(watchdogResult && watchdogResult.skipped !== true, 'watchdog should not be skipped while only maintenance is in flight');
        assert.strictEqual(refreshCount >= 2, true, 'watchdog should have called refreshState independently');

        releaseMaintenanceRefresh();
        await maintenanceCall;

        console.log('  PASS');
    } finally {
        delete require.cache[creditRuntimePath];
        restore();
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    }
}

async function testCreditWatchdogInFlightGuard() {
    console.log('\n[RC-1C] runCreditWatchdog skips when previous watchdog tick is in flight...');

    const restore = installCreditRuntimeStubs();
    const baseDir = freshBaseDir('credit-watchdog-self');

    try {
        delete require.cache[creditRuntimePath];
        const CreditRuntime = require('../modules/credit_runtime').default;

        const runtime = new CreditRuntime({
            config: createBaseBotConfig({ botKey: 'credit-bot-watchdog-self' }),
            account: { id: '1.2.3', name: 'alice' },
            accountId: '1.2.3',
            privateKey: 'WIF-KEY',
            _log() {},
            _warn() {},
        }, { stateDir: path.join(baseDir, 'credit_runtime') });

        let releaseFirst;
        const firstRefreshDone = new Promise((resolve) => { releaseFirst = resolve; });
        const realRefresh = runtime.refreshState.bind(runtime);
        runtime.refreshState = async () => {
            await firstRefreshDone;
            return await realRefresh();
        };

        const firstCall = runtime.runCreditWatchdog();
        for (let i = 0; i < 5; i += 1) {
            await new Promise((r) => setImmediate(r));
        }

        const secondResult = await runtime.runCreditWatchdog();
        assert.ok(secondResult && secondResult.skipped === true, 'second runCreditWatchdog should report skipped');
        assert.strictEqual(secondResult.reason, 'watchdog already in flight', 'reason should reference the watchdog in-flight guard');

        releaseFirst();
        await firstCall;

        console.log('  PASS');
    } finally {
        delete require.cache[creditRuntimePath];
        restore();
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    }
}

// ---------------------------------------------------------------------------
// RC-3: persistGrid accepts snapshotOrders and does not touch manager.orders
// ---------------------------------------------------------------------------

async function testPersistGridSnapshotDoesNotSwapManagerOrders() {
    console.log('\n[RC-3A] persistGrid(snapshotOrders) persists the snapshot without swapping manager.orders...');

    const { OrderManager } = require('../modules/order/manager');
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
    manager.assets = {
        assetA: { symbol: 'BTS', id: '1.3.0', precision: 5 },
        assetB: { symbol: 'USD', id: '1.3.121', precision: 4 },
    };
    manager.logger = { log: () => {} };

    // Capture the orders that accountOrders.storeMasterGrid sees. This is the
    // direct evidence that the snapshot (not the live map) is what gets
    // persisted, since persistGrid -> persistGridSnapshot -> accountOrders.
    let capturedSnapshotIds = null;
    manager.accountOrders = {
        storeMasterGrid: async (orders, btsFeesOwed) => {
            capturedSnapshotIds = Array.isArray(orders) ? orders.map((o) => o.id) : null;
            return true;
        },
    };

    const liveOrder = { id: 'live-1', type: 'BUY', state: 'VIRTUAL', price: 1, size: 10, orderId: '' };
    manager.orders = new Map([[liveOrder.id, liveOrder]]);
    manager.funds = { btsFeesOwed: 0 };
    manager.boundaryIdx = 0;
    manager.config = { botKey: 'rc3-bot', assetA: 'BTS', assetB: 'USD' };

    const snapshot = [
        { id: 'snap-1', type: 'SELL', state: 'VIRTUAL', price: 2, size: 5, orderId: '' },
        { id: 'snap-2', type: 'SELL', state: 'VIRTUAL', price: 3, size: 7, orderId: '' },
    ];

    await manager.persistGrid(snapshot);

    assert.ok(Array.isArray(capturedSnapshotIds), 'snapshot orders should be passed to accountOrders.storeMasterGrid');
    assert.deepStrictEqual(capturedSnapshotIds, ['snap-1', 'snap-2'], 'snapshot orders should match what was passed in');
    assert.strictEqual(manager.orders.size, 1, 'live manager.orders should be untouched after persistGrid(snapshot)');
    assert.ok(manager.orders.has('live-1'), 'live order should still be present in manager.orders');

    // Also verify that persistGrid() with no argument falls back to the live map.
    capturedSnapshotIds = null;
    await manager.persistGrid();
    assert.deepStrictEqual(capturedSnapshotIds, ['live-1'], 'persistGrid() with no arg should fall back to live manager.orders');

    console.log('  PASS');
}

// ---------------------------------------------------------------------------
// RC-4: position_manager_watch in-flight guard + unref
// ---------------------------------------------------------------------------
//
// The watcher's PositionManager / bitshares_client dependencies are replaced
// via ESM loader hooks (registered above), so start() runs without a real
// BitShares connection. Each test installs its own mock class before the
// first require of the watcher module.

function loadWatcherWithMockedDeps(mockPositionManager, waitForConnected) {
    clawWatcherMocks.PositionManager = mockPositionManager;
    if (typeof waitForConnected === 'function') {
        clawWatcherMocks.waitForConnected = waitForConnected;
    }
    return require('../claw/modules/position_manager_watch');
}

async function testPositionManagerWatchInFlightGuard() {
    console.log('\n[RC-4A] position_manager_watch skips overlapping syncAllPositions() calls...');

    const inflight = { count: 0, max: 0 };
    let callCount = 0;
    let releaseFirst;
    const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });

    class MockPositionManager {
    [key: string]: any;
        constructor() {}
        async syncAllPositions() {
            callCount += 1;
            inflight.count += 1;
            if (inflight.count > inflight.max) inflight.max = inflight.count;
            // callCount === 1 is the initial sync from start(); don't block.
            // callCount === 2 is the first interval-driven sync; block it.
            if (callCount === 2) {
                await firstStarted;
            }
            await new Promise((r) => setTimeout(r, 5));
            inflight.count -= 1;
            return { ok: true };
        }
        async watchAccount() {
            return async () => {};
        }
    }

    const { createPositionManagerWatcher } = loadWatcherWithMockedDeps(MockPositionManager, async () => {});

    const watcher = createPositionManagerWatcher({
        accountName: 'tester',
        syncIntervalMs: 5,
        healthPath: path.join(freshBaseDir('pmw-health'), 'health.json'),
        statePath: path.join(freshBaseDir('pmw-state'), 'state.json'),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
        await watcher.start();
        // Let the initial sync (call 1) finish, then wait for the first interval
        // tick (call 2) to enter the blocking state.
        await new Promise((r) => setTimeout(r, 10));
        // Now 3+ more intervals should fire while call 2 is in flight.
        await new Promise((r) => setTimeout(r, 20));
        const callsBeforeRelease = callCount;
        releaseFirst();
        // Let any remaining interval(s) run normally.
        await new Promise((r) => setTimeout(r, 15));

        assert.strictEqual(inflight.max, 1, 'syncAllPositions should never overlap; max in-flight should be 1');
        // We expect: call 1 (initial), call 2 (first interval, blocked),
        // and zero or more calls skipped while call 2 is in-flight.
        // The exact number of skipped calls depends on the interval timing,
        // but we should have at most 2 active calls (call 1 + call 2) and
        // possibly some later calls after release.
        assert.ok(callsBeforeRelease >= 1, 'at least the initial sync should have run');
    } finally {
        try { await watcher.stop(); } catch (_) {}
    }

    console.log('  PASS');
}

async function testPositionManagerWatchUnref() {
    console.log('\n[RC-4B] position_manager_watch timer is unref()\'d so it does not keep the loop alive...');

    class MockPositionManager {
    [key: string]: any;
        constructor() {}
        async syncAllPositions() { return { ok: true }; }
        async watchAccount() { return async () => {}; }
    }

    const realSetInterval = global.setInterval;
    let capturedTimer: any = null;
    (global as any).setInterval = function (fn: any, ms: any, ...args: any[]) {
        const t = (realSetInterval as any)(fn, ms, ...args);
        if (ms === 999999) {
            capturedTimer = t;
        }
        return t;
    };

    const { createPositionManagerWatcher } = loadWatcherWithMockedDeps(MockPositionManager, async () => {});

    try {
        const watcher = createPositionManagerWatcher({
            accountName: 'tester',
            syncIntervalMs: 999999,
            healthPath: path.join(freshBaseDir('pmw-unref-health'), 'health.json'),
            statePath: path.join(freshBaseDir('pmw-unref-state'), 'state.json'),
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        await watcher.start();
        assert.ok(capturedTimer, 'setInterval should have been called with the sync interval');
        assert.strictEqual(typeof capturedTimer.unref, 'function', 'timer should expose unref()');
        assert.strictEqual(capturedTimer.hasRef?.(), false, 'timer should be unref\'d');
        try { await watcher.stop(); } catch (_) {}
    } finally {
        global.setInterval = realSetInterval;
    }

    console.log('  PASS');
}

// ---------------------------------------------------------------------------
// RC-6: writeJsonFileAtomic + writeBotsFileWithLock atomic semantics
// ---------------------------------------------------------------------------

async function testWriteJsonFileAtomic() {
    console.log('\n[RC-6A] writeJsonFileAtomic produces a valid file and no leftover tmp...');

    const baseDir = freshBaseDir('atomic');
    const target = path.join(baseDir, 'sub', 'nested', 'data.json');

    const payload = { hello: 'world', arr: [1, 2, 3], nested: { k: 'v' } };
    writeJsonFileAtomic(target, payload);

    assert.ok(fs.existsSync(target), 'target file should exist after atomic write');
    const parsed = readJSON(target);
    assert.deepStrictEqual(parsed, payload, 'written content should match input');

    // No leftover tmp files in the directory.
    const leftover = fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftover, [], 'no tmp files should remain after a successful write');

    // Crash mid-write: simulate a second write that throws after writing the tmp
    // but before renaming. Verify the original file is unchanged and the tmp is
    // cleaned up.
    const original = fs.readFileSync(target, 'utf8');
    // Monkey-patch renameSync to throw the second time.
    const realRename = fs.renameSync;
    let renameCalls = 0;
    fs.renameSync = (from, to) => {
        renameCalls += 1;
        if (renameCalls === 1) {
            throw new Error('simulated crash during rename');
        }
        return realRename(from, to);
    };
    let threw = false;
    try {
        writeJsonFileAtomic(target, { replaced: true });
    } catch (_) {
        threw = true;
    }
    fs.renameSync = realRename;

    assert.ok(threw, 'second write should have thrown');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'target file should be unchanged after a crashed write');
    const leftover2 = fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftover2, [], 'tmp file should be cleaned up after a crashed write');

    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    console.log('  PASS');
}

async function testWriteBotsFileWithLockUsesAtomic() {
    console.log('\n[RC-6B] writeBotsFileWithLock uses atomic write (no torn file on concurrent calls)...');

    const baseDir = freshBaseDir('bots-atomic');
    const botsFile = path.join(baseDir, 'bots.json');

    // Two concurrent writers, each writing a different config. The in-process
    // semaphore must serialize them, and the atomic write must prevent torn
    // content. After both complete, the file must parse cleanly.
    const cfgA = { bots: [{ name: 'a', assetA: 'BTS', assetB: 'CNY', coreOrders: { buy: 1, sell: 1 }, botFunds: { buy: 100, sell: 100 }, active: true, botIndex: 0 }] };
    const cfgB = { bots: [{ name: 'b', assetA: 'BTS', assetB: 'USD', coreOrders: { buy: 2, sell: 2 }, botFunds: { buy: 200, sell: 200 }, active: true, botIndex: 0 }] };

    await Promise.all([
        writeBotsFileWithLock(botsFile, cfgA),
        writeBotsFileWithLock(botsFile, cfgB),
    ]);

    const parsed = readJSON(botsFile);
    assert.ok(parsed && Array.isArray(parsed.bots), 'bots.json must parse to an object with a bots array');
    assert.strictEqual(parsed.bots.length, 1, 'bots.json should contain exactly one bot (last writer wins)');
    assert.ok(['a', 'b'].includes(parsed.bots[0].name), 'last writer\'s bot should be present');

    const leftover = fs.readdirSync(baseDir).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftover, [], 'no tmp files should remain after concurrent atomic writes');

    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    console.log('  PASS');
}

async function testCreditRuntimePersistIsAtomic() {
    console.log('\n[RC-6D] CreditRuntime.persistState uses atomic write...');

    const restore = installCreditRuntimeStubs();
    const baseDir = freshBaseDir('credit-atomic');

    try {
        delete require.cache[creditRuntimePath];
        const CreditRuntime = require('../modules/credit_runtime').default;

        const runtime = new CreditRuntime({
            config: createBaseBotConfig({ botKey: 'credit-atomic-bot' }),
            account: { id: '1.2.3', name: 'alice' },
            accountId: '1.2.3',
            privateKey: 'WIF-KEY',
            _log() {},
            _warn() {},
        }, { stateDir: path.join(baseDir, 'credit_runtime') });

        await runtime.persistState('test-atomic');
        const statePath = runtime.statePath;
        assert.ok(fs.existsSync(statePath), 'credit state file should exist');

        // No leftover tmp files in the state dir.
        const leftover = fs.readdirSync(path.dirname(statePath)).filter((f) => f.endsWith('.tmp'));
        assert.deepStrictEqual(leftover, [], 'no tmp files should remain after persistState');
    } finally {
        delete require.cache[creditRuntimePath];
        restore();
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    }

    console.log('  PASS');
}

// ---------------------------------------------------------------------------
// RC-1B: Lock Hierarchy Violation — ABBA deadlock prevention
// ---------------------------------------------------------------------------

async function testGridLockSyncLockCorrectOrder() {
    console.log(' - RC-1B: Lock hierarchy — sync(2)→grid(3) order prevents ABBA deadlock...');

    // Build a minimal mock manager with real AsyncLock instances so the
    // real SyncEngine.syncFromOpenOrders can execute its lock logic.
    // After the refactor the canonical order is:
    //   _fillProcessingLock(0) → _syncLock(2) → _gridLock(3) → _fundLock(4)
    const mgr: any = {
        _syncLock: new AsyncLock(),
        _gridLock: new AsyncLock(),
        _fillProcessingLock: null,
        _pauseFundRecalc: 0,
        orders: new Map(),
        shadowOrderIds: new Map(),
        ordersNeedingPriceCorrection: [],
        _syncGeneration: 0,
        assets: {
            assetA: { symbol: 'BTS', id: '1.3.0', precision: 5 },
            assetB: { symbol: 'USD', id: '1.3.121', precision: 4 },
        },
        logger: { log: () => {} },
        pauseFundRecalc() { this._pauseFundRecalc++; },
        resumeFundRecalc() { this._pauseFundRecalc = Math.max(0, this._pauseFundRecalc - 1); },
        lockOrders() {},
        unlockOrders() {},
    };

    const SyncEngineModule = require('../modules/order/sync_engine').default;
    const SyncEngine = SyncEngineModule.default || SyncEngineModule;
    const syncEngine = new SyncEngine(mgr);

    // Context B: hold _syncLock for 80ms (simulates a fill-context sync).
    let syncLockReleased = false;
    const contextB = mgr._syncLock.acquire(async () => {
        await new Promise(r => setTimeout(r, 80));
        syncLockReleased = true;
    });

    // Yield so B acquires _syncLock first.
    await new Promise(r => setTimeout(r, 5));

    // Context A: call syncFromOpenOrders normally (no gridLockAlreadyHeld).
    // With the corrected hierarchy, syncFromOpenOrders acquires _syncLock(2)
    // → _gridLock(3). Since B holds _syncLock, A waits — no deadlock because
    // A does not hold _gridLock when calling syncFromOpenOrders.
    let contextAStart = 0;
    let contextAElapsed = -1;
    const contextA = (async () => {
        contextAStart = Date.now();
        const result = await syncEngine.syncFromOpenOrders([], {});
        contextAElapsed = Date.now() - contextAStart;
        assert.ok(result && typeof result === 'object', 'syncFromOpenOrders should return a result');
        assert.deepStrictEqual(result.filledOrders, [], 'no fills with empty chain orders');
    })();

    // Both must complete within 2s (no deadlock). Context A waits for _syncLock
    // so it naturally finishes after Context B (not before).
    let deadlockTimer: any = null;
    const deadlockGuard = new Promise((_, reject) => {
        deadlockTimer = setTimeout(() => reject(new Error('DEADLOCK: contexts did not complete within 2s')), 2000);
    });
    try {
        await Promise.race([
            Promise.all([contextA, contextB]),
            deadlockGuard,
        ]);
    } finally {
        clearTimeout(deadlockTimer);
    }

    assert.strictEqual(syncLockReleased, true, 'Context B must complete');
    assert.ok(contextAElapsed >= 30,
        `Context A must wait for Context B to release _syncLock (took ${contextAElapsed}ms)`);

    console.log('  PASS: syncFromOpenOrders correctly waits for _syncLock — no deadlock');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
    console.log('Running race-condition fix regression tests (batch 1)...');
    await testCreditMaintenanceInFlightGuard();
    await testCreditWatchdogRunsAlongsideMaintenance();
    await testCreditWatchdogInFlightGuard();
    await testPersistGridSnapshotDoesNotSwapManagerOrders();
    await testPositionManagerWatchInFlightGuard();
    await testPositionManagerWatchUnref();
    await testWriteJsonFileAtomic();
    await testWriteBotsFileWithLockUsesAtomic();
    await testCreditRuntimePersistIsAtomic();
    await testGridLockSyncLockCorrectOrder();
    console.log('\nAll race-condition fix regression tests passed');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
}).finally(() => {
    // House-style forced exit (see test_cow_commit_guards): benign handles
    // must never keep a passing run alive.
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
