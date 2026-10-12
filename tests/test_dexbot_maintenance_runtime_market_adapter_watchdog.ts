const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
const { Config } = require('../modules/config');

console.log('Running dexbot maintenance runtime market adapter watchdog tests');

const runtimePath = require.resolve('../modules/dexbot_maintenance_runtime');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const chainOrdersPath = require.resolve('../modules/chain_orders');
const gridPath = require.resolve('../modules/order/grid');
const constantsPath = require.resolve('../modules/constants');
const systemPath = require.resolve('../modules/order/utils/system');
const formatPath = require.resolve('../modules/order/format');
const orderUtilsPath = require.resolve('../modules/order/utils/order');
const accountBotsPath = require.resolve('../modules/account_bots');
const marketAdapterRuntimePath = require.resolve('../modules/launcher/market_adapter_runtime');
const loggerPath = require.resolve('../modules/order/logger');

const originals = new Map([
    [runtimePath, require.cache[runtimePath]],
    [bitsharesClientPath, require.cache[bitsharesClientPath]],
    [chainOrdersPath, require.cache[chainOrdersPath]],
    [gridPath, require.cache[gridPath]],
    [constantsPath, require.cache[constantsPath]],
    [systemPath, require.cache[systemPath]],
    [formatPath, require.cache[formatPath]],
    [orderUtilsPath, require.cache[orderUtilsPath]],
    [accountBotsPath, require.cache[accountBotsPath]],
    [marketAdapterRuntimePath, require.cache[marketAdapterRuntimePath]],
    [loggerPath, require.cache[loggerPath]],
]);

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;

function loadRuntimeWithStubs({ marketAdapterRuntimeStub }: any = {}) {
    delete require.cache[runtimePath];
    delete require.cache[loggerPath];

    setCachedModule(bitsharesClientPath, { BitShares: {} });
    setCachedModule(chainOrdersPath, {
        readOpenOrders: async () => [],
    });
    setCachedModule(gridPath, {
        recalculateGrid: async () => {},
    });
    setCachedModule(constantsPath, {
        ORDER_STATES: {},
        TIMING: {},
        MAINTENANCE: {},
        GRID_LIMITS: {},
        LOGGING_CONFIG: {},
    });
    setCachedModule(systemPath, {
        retryPersistenceIfNeeded: async () => {},
        applyGridDivergenceCorrections: async (_1: any, _2: any, _3: any, _4: any, _5: any) => {},
        loadAmaCenterSnapshot: () => null,
        parseJsonWithComments: (text) => JSON.parse(text),
    });
    setCachedModule(formatPath, {});
    setCachedModule(orderUtilsPath, {
        virtualizeOrder: (order) => order,
        convertToSpreadPlaceholder: (order) => ({ ...order, type: 'spread', size: 0, state: 'virtual', orderId: null }),
    });
    setCachedModule(accountBotsPath, {});
    setCachedModule(marketAdapterRuntimePath, marketAdapterRuntimeStub || {
        getSharedMarketAdapterRuntime: () => ({
            syncBot: async () => ({ running: false, started: false, stopped: false }),
            releaseBot: async () => ({ running: false, stopped: false }),
        }),
    });

    return require(runtimePath);
}

async function testSnapshotReaderDetectsAMAConfig() {
    const botsFile = require('../modules/paths').PATHS.PROFILES.BOTS_JSON;

    fs.existsSync = (filePath) => String(filePath) === botsFile;
    fs.readFileSync = (filePath, encoding) => {
        if (String(filePath) === botsFile) {
            return JSON.stringify({
                bots: [
                    { name: 'AMA Bot', active: true, gridPrice: 'ama3' },
                    { name: 'Book Bot', active: true, gridPrice: 'book' },
                ],
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    const { loadBotsConfigSnapshot } = loadRuntimeWithStubs();
    const snapshot = loadBotsConfigSnapshot();

    assert.strictEqual(snapshot.exists, true, 'bots.json should be detected');
    assert.strictEqual(snapshot.activeBots.length, 2, 'all active bots should be returned');
    assert.strictEqual(snapshot.needsMarketAdapter, true, 'AMA grid pricing should require the market adapter');
    assert.ok(snapshot.fingerprint, 'fingerprint should be populated');
}

async function testWatchdogStartsAdapterWhenMissing() {
    Config.pm_exec_path = '/usr/bin/pm2';
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let started = false;
    let queried = false;
    const logs = [];

    const self = {
        _marketAdapterWatchdogFingerprint: null,
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-1',
            activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
            needsMarketAdapter: true,
        }),
        _getPm2ProcessNames: async () => {
            queried = true;
            return ['AMA Bot'];
        },
        _startMarketAdapterPm2: async () => {
            started = true;
        },
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.strictEqual(queried, true, 'watchdog should query PM2 when AMA pricing is active');
    assert.strictEqual(started, true, 'watchdog should start the adapter when it is missing');
    assert.strictEqual(result.changed, true, 'first snapshot should be treated as a change');
    assert.strictEqual(result.required, true, 'AMA pricing should require the adapter');
    assert.strictEqual(result.started, true, 'watchdog should report a successful start');
    assert.ok(
        logs.some((msg) => String(msg).includes('Started dexbot-adapter')),
        'watchdog should log the adapter start'
    );
}

async function testWatchdogSkipsLaunchWhenAdapterNotNeeded() {
    Config.pm_exec_path = '/usr/bin/pm2';
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let queried = false;
    let started = false;
    let stopped = false;

    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'new-fingerprint',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _getPm2ProcessNames: async () => {
            queried = true;
            return ['dexbot-adapter'];
        },
        _startMarketAdapterPm2: async () => {
            started = true;
        },
        _stopMarketAdapterPm2: async () => {
            stopped = true;
        },
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.strictEqual(result.changed, true, 'config fingerprint changes should still be detected');
    assert.strictEqual(result.required, false, 'non-AMA config should not require the adapter');
    assert.strictEqual(queried, true, 'PM2 should be queried so stale adapter processes can be stopped');
    assert.strictEqual(started, false, 'adapter start should be skipped when not needed');
    assert.strictEqual(stopped, true, 'running adapter should be stopped when it is no longer needed');
    assert.strictEqual(result.stopped, true, 'watchdog should report the adapter stop');
}

async function testWatchdogLeavesAdapterStoppedWhenAlreadyAbsent() {
    Config.pm_exec_path = '/usr/bin/pm2';
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let stopped = false;

    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'new-fingerprint',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _getPm2ProcessNames: async () => [],
        _stopMarketAdapterPm2: async () => {
            stopped = true;
        },
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.strictEqual(result.required, false, 'non-AMA config should not require the adapter');
    assert.strictEqual(result.stopped, false, 'watchdog should not stop an adapter that is already absent');
    assert.strictEqual(stopped, false, 'stop should not be attempted when the adapter is already absent');
}

async function testWatchdogUsesDirectRuntimeWithoutPm2() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const releaseCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return shouldRun
                ? { running: true, owned: true, started: true }
                : { running: false, owned: false, stopped: true };
        },
        releaseBot: async (botId) => {
            releaseCalls.push(botId);
            return { running: false, stopped: true };
        },
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const logs = [];
    const self = {
        _marketAdapterWatchdogFingerprint: null,
        config: {
            botKey: 'aaa-bbb-0',
            name: 'AAA-BBB',
            gridPrice: 'ama',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-2',
            activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
            needsMarketAdapter: true,
        }),
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'aaa-bbb-0', shouldRun: true },
    ], 'direct runtime should be used when PM2 is not active');
    assert.strictEqual(result.mode, 'direct', 'watchdog should report direct mode');
    assert.strictEqual(result.started, true, 'direct runtime should start the adapter when needed');
    assert.strictEqual(releaseCalls.length, 0, 'direct runtime should not release during AMA startup');
    assert.ok(
        logs.some((msg) => String(msg).includes('Started dexbot-adapter')),
        'direct runtime should log the adapter start'
    );
}

async function testWatchdogDoesNotRegisterNonAmaBotInDirectRuntime() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return { running: true, owned: true, started: false, stopped: false };
        },
        releaseBot: async () => ({ running: true, stopped: false }),
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const self = {
        _marketAdapterWatchdogFingerprint: null,
        config: {
            botKey: 'book-bot-0',
            name: 'Book Bot',
            gridPrice: 'book',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-ama-elsewhere',
            activeBots: [
                { name: 'AMA Bot', active: true, gridPrice: 'ama' },
                { name: 'Book Bot', active: true, gridPrice: 'book' },
            ],
            needsMarketAdapter: true,
        }),
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'book-bot-0', shouldRun: false },
    ], 'non-AMA direct bot should not be registered as requiring the adapter');
    assert.strictEqual(result.mode, 'direct', 'watchdog should report direct mode');
    assert.strictEqual(result.required, true, 'global snapshot can still require the adapter for another AMA bot');
    assert.strictEqual(result.started, false, 'non-AMA bot should not start the adapter');
}

async function testWatchdogUsesSnapshotEntryWhenRuntimeConfigIsStale() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return { running: false, owned: false, started: false, stopped: true };
        },
        releaseBot: async () => ({ running: false, stopped: false }),
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const self = {
        _marketAdapterWatchdogFingerprint: null,
        config: {
            botKey: 'aaa-bbb-0',
            name: 'AAA-BBB',
            gridPrice: 'ama',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-runtime-stale',
            activeBots: [{ botKey: 'aaa-bbb-0', name: 'AAA-BBB', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'aaa-bbb-0', shouldRun: false },
    ], 'live snapshot entry should override stale runtime AMA config');
    assert.strictEqual(result.required, false, 'adapter should no longer be required after current bot leaves AMA pricing');
    assert.strictEqual(result.stopped, true, 'direct runtime should stop after current bot leaves AMA pricing');
}

async function testWatchdogReleasesDirectRuntimeWithoutPm2() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const releaseCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return { running: false, owned: false, stopped: !shouldRun };
        },
        releaseBot: async (botId) => {
            releaseCalls.push(botId);
            return { running: false, stopped: true };
        },
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const logs = [];
    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        config: {
            botKey: 'aaa-bbb-0',
            name: 'AAA-BBB',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-3',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'aaa-bbb-0', shouldRun: false },
    ], 'direct runtime should receive the no-AMA stop request');
    assert.strictEqual(result.mode, 'direct', 'watchdog should report direct mode');
    assert.strictEqual(result.stopped, true, 'direct runtime should stop the adapter when AMA is disabled');
    assert.ok(
        logs.some((msg) => String(msg).includes('Stopped dexbot-adapter')),
        'direct runtime should log the adapter stop'
    );
    assert.strictEqual(releaseCalls.length, 0, 'syncBot should handle the direct stop path');
}

async function testSetupBlockchainFetchIntervalRunsWatchdogBeforeDisabledReturn() {
    Config.pm_exec_path = undefined;
    const { setupBlockchainFetchInterval } = loadRuntimeWithStubs();
    let snapshotChecks = 0;
    const logs = [];

    const self = {
        config: { blockchainFetchIntervalMinutes: 0 },
        manager: null,
        accountId: null,
        _blockchainFetchInterval: null,
        _loadBotsConfigSnapshot: async () => {
            snapshotChecks += 1;
            return {
                exists: true,
                fingerprint: 'startup-fingerprint',
                activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
                needsMarketAdapter: true,
            };
        },
        _getPm2ProcessNames: async () => ['dexbot-adapter'],
        _startMarketAdapterPm2: async () => {
            throw new Error('should not start when already running');
        },
        _stopBlockchainFetchInterval: () => {},
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    setupBlockchainFetchInterval(self);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(snapshotChecks, 1, 'startup path should run the market adapter watchdog immediately');
    assert.ok(
        logs.some((msg) => String(msg).includes('Blockchain fetch interval disabled')),
        'disabled interval should still log the disabled state after the startup watchdog check'
    );
}

async function testWrapperOwnedSkipsAdapterSyncWithoutReadingConfig() {
    // Wrapper-owned bots skip the ADAPTER drive, but the live bot-config
    // check (Issue #27 follow-up) still runs: one shared bots.json read per
    // tick, adapter untouched.
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    process.env.DEXBOT_ADAPTER_OWNER = 'wrapper';
    Config.pm_exec_path = undefined;
    try {
        const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
        let snapshotReads = 0;
        const self = {
            config: { botKey: 'wrapper-owned-bot', name: 'Wrapper Owned Bot' },
            _appliedBotConfigFingerprint: null,
            _loadBotsConfigSnapshot: async () => {
                snapshotReads += 1;
                return {
                    exists: true,
                    fingerprint: '',
                    activeBots: [{ botKey: 'wrapper-owned-bot', name: 'Wrapper Owned Bot', active: true, gridPrice: 'book' }],
                    needsMarketAdapter: false,
                };
            },
            _log: () => {},
            _warn: () => {},
        };

        const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test-wrapper-owned');

        assert.strictEqual(result.skipped, true, 'wrapper-owned bot should skip adapter sync');
        assert.strictEqual(result.reason, 'wrapper-owned', 'skip reason should name the wrapper owner');
        assert.strictEqual(snapshotReads, 1, 'live bot-config check needs exactly one shared snapshot read');
        assert.ok(
            typeof self._appliedBotConfigFingerprint === 'string',
            'wrapper-owned tick must still seed the live bot-config baseline'
        );
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testSemanticFingerprintIgnoresNonAmaEdits() {
    const botsFile = require('../modules/paths').PATHS.PROFILES.BOTS_JSON;
    const base = {
        bots: [
            { name: 'AMA Bot', active: true, gridPrice: 'ama3', botFunds: { buy: 100, sell: 1 } },
            { name: 'Book Bot', active: true, gridPrice: 'book', botFunds: { buy: 50, sell: 2 } },
        ],
    };
    const nonAmaEdit = JSON.parse(JSON.stringify(base));
    nonAmaEdit.bots[1].botFunds.buy = 999;
    const amaEdit = JSON.parse(JSON.stringify(base));
    amaEdit.bots[1].gridPrice = 'ama1';

    let content = JSON.stringify(base);
    const savedExistsSync = fs.existsSync;
    const savedReadFileSync = fs.readFileSync;
    fs.existsSync = (filePath) => String(filePath) === botsFile;
    fs.readFileSync = (filePath, encoding) => {
        if (String(filePath) === botsFile) return content;
        return originalReadFileSync(filePath, encoding);
    };

    try {
        const { loadBotsConfigSnapshot } = loadRuntimeWithStubs();
        const before = loadBotsConfigSnapshot();
        assert.ok(before.fingerprint, 'fingerprint should be populated');

        content = JSON.stringify(nonAmaEdit);
        const afterNonAmaEdit = loadBotsConfigSnapshot();
        assert.strictEqual(
            afterNonAmaEdit.fingerprint, before.fingerprint,
            'non-AMA edits (funds, comments) must not reset the adapter fingerprint'
        );

        content = JSON.stringify(amaEdit);
        const afterAmaEdit = loadBotsConfigSnapshot();
        assert.notStrictEqual(
            afterAmaEdit.fingerprint, before.fingerprint,
            'AMA-relevant edits (gridPrice book->ama) must reset the adapter fingerprint'
        );
        assert.strictEqual(afterAmaEdit.needsMarketAdapter, true, 'new AMA bot should require the adapter');
    } finally {
        fs.existsSync = savedExistsSync;
        fs.readFileSync = savedReadFileSync;
    }
}

async function testEmptyFingerprintSteadyStateReportsNoChange() {
    // Regression: the semantic fingerprint is legitimately '' when no active
    // AMA bot exists. `'' || null` coerced that to null, so every tick saw
    // '' !== null and re-drove the adapter with a "changes detected" log.
    const botsFile = require('../modules/paths').PATHS.PROFILES.BOTS_JSON;
    const content = JSON.stringify({
        bots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
    });
    const savedExistsSync = fs.existsSync;
    const savedReadFileSync = fs.readFileSync;
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        fs.existsSync = (filePath) => String(filePath) === botsFile;
        fs.readFileSync = (filePath, encoding) => {
            if (String(filePath) === botsFile) return content;
            return savedReadFileSync(filePath, encoding);
        };
        const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
        const logs = [];
        const self = {
            config: { name: 'Book Bot' },
            _marketAdapterWatchdogFingerprint: '', // matches DEXBot constructor init
            _log: (msg) => logs.push(String(msg)),
            _warn: (msg) => logs.push(`WARN:${msg}`),
        };
        const first = await syncMarketAdapterOnPeriodicConfigCheck(self, 'test tick 1');
        const second = await syncMarketAdapterOnPeriodicConfigCheck(self, 'test tick 2');
        assert.strictEqual(first.changed, false, 'steady empty fingerprint must not report change (tick 1)');
        assert.strictEqual(second.changed, false, 'steady empty fingerprint must not report change (tick 2)');
        assert.strictEqual(self._marketAdapterWatchdogFingerprint, '', 'empty fingerprint must be stored as-is');
        assert.ok(
            !logs.some((msg) => msg.includes('Detected bots.json changes')),
            'steady state must not log change detection'
        );
    } finally {
        fs.existsSync = savedExistsSync;
        fs.readFileSync = savedReadFileSync;
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testCorruptBotsConfigSkipsSyncWithoutTouchingAdapter() {
    // A transient partial write must leave the adapter alone (pre-refactor the
    // parse throw aborted the check) and must not clobber the stored
    // fingerprint, so the next tick re-evaluates once the file is valid.
    const botsFile = require('../modules/paths').PATHS.PROFILES.BOTS_JSON;
    const savedExistsSync = fs.existsSync;
    const savedReadFileSync = fs.readFileSync;
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        fs.existsSync = (filePath) => String(filePath) === botsFile;
        fs.readFileSync = (filePath, encoding) => {
            if (String(filePath) === botsFile) return '{ corrupt json {{{';
            return savedReadFileSync(filePath, encoding);
        };
        let syncBotCalls = 0;
        const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
            marketAdapterRuntimeStub: {
                getSharedMarketAdapterRuntime: () => ({
                    syncBot: async () => { syncBotCalls += 1; return { running: false, started: false, stopped: false }; },
                    releaseBot: async () => ({ running: false, stopped: false }),
                }),
            },
        });
        const logs = [];
        const self = {
            config: { name: 'AMA Bot' },
            _marketAdapterWatchdogFingerprint: 'AMA Bot:ama3', // last known good
            _log: (msg) => logs.push(String(msg)),
            _warn: (msg) => logs.push(`WARN:${msg}`),
        };
        const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'test corrupt tick');
        assert.deepStrictEqual(result, { skipped: true, reason: 'corrupt-config' });
        assert.strictEqual(syncBotCalls, 0, 'corrupt config must not drive the adapter runtime');
        assert.strictEqual(
            self._marketAdapterWatchdogFingerprint, 'AMA Bot:ama3',
            'corrupt config must preserve the previous fingerprint'
        );
        assert.ok(
            logs.some((msg) => msg.includes('corrupt')),
            'corrupt config should warn instead of silently skipping'
        );
    } finally {
        fs.existsSync = savedExistsSync;
        fs.readFileSync = savedReadFileSync;
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testUnreadableBotsConfigSkipsSyncWithoutTouchingAdapter() {
    // A stat/read failure (transient I/O error) must behave like a corrupt
    // file: previously the read throw aborted the check and left a running
    // adapter alone instead of treating the file as missing (which would
    // take the stop-adapter branch).
    const botsFile = require('../modules/paths').PATHS.PROFILES.BOTS_JSON;
    const savedExistsSync = fs.existsSync;
    const savedReadFileSync = fs.readFileSync;
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        fs.existsSync = (filePath) => String(filePath) === botsFile;
        fs.readFileSync = (filePath, encoding) => {
            if (String(filePath) === botsFile) throw new Error('EIO: transient read failure');
            return savedReadFileSync(filePath, encoding);
        };
        let syncBotCalls = 0;
        const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
            marketAdapterRuntimeStub: {
                getSharedMarketAdapterRuntime: () => ({
                    syncBot: async () => { syncBotCalls += 1; return { running: true, started: false, stopped: false }; },
                    releaseBot: async () => ({ running: false, stopped: false }),
                }),
            },
        });
        const logs = [];
        const self = {
            config: { name: 'AMA Bot' },
            _marketAdapterWatchdogFingerprint: 'AMA Bot:ama3', // last known good
            _log: (msg) => logs.push(String(msg)),
            _warn: (msg) => logs.push(`WARN:${msg}`),
        };
        const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'test unreadable tick');
        assert.deepStrictEqual(result, { skipped: true, reason: 'unreadable-config' });
        assert.strictEqual(syncBotCalls, 0, 'unreadable config must not drive the adapter runtime');
        assert.strictEqual(
            self._marketAdapterWatchdogFingerprint, 'AMA Bot:ama3',
            'unreadable config must preserve the previous fingerprint'
        );
    } finally {
        fs.existsSync = savedExistsSync;
        fs.readFileSync = savedReadFileSync;
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testBotsConfigPollPreseedsOnlyWhenUnchecked() {
    // '' is a valid checked steady-state (no AMA bots) and must not re-fire
    // the startup pre-seed sync; only null/undefined (never checked) may.
    const botsFile = require('../modules/paths').PATHS.PROFILES.BOTS_JSON;
    const content = JSON.stringify({
        bots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
    });
    const savedExistsSync = fs.existsSync;
    const savedReadFileSync = fs.readFileSync;
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        fs.existsSync = (filePath) => String(filePath) === botsFile;
        fs.readFileSync = (filePath, encoding) => {
            if (String(filePath) === botsFile) return content;
            return savedReadFileSync(filePath, encoding);
        };
        let syncBotCalls = 0;
        const { setupBotsConfigPollInterval, stopBotsConfigPollInterval } = loadRuntimeWithStubs({
            marketAdapterRuntimeStub: {
                getSharedMarketAdapterRuntime: () => ({
                    syncBot: async () => { syncBotCalls += 1; return { running: false, started: false, stopped: false }; },
                    releaseBot: async () => ({ running: false, stopped: false }),
                }),
            },
        });
        const makeSelf = (fingerprint) => ({
            config: { name: 'Book Bot', timing: { BOTS_CONFIG_POLL_INTERVAL_MS: 60000 } },
            _botsConfigPollInterval: null,
            _marketAdapterWatchdogFingerprint: fingerprint,
            _log: () => {},
            _warn: () => {},
        });
        const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

        const checkedEmpty = makeSelf('');
        setupBotsConfigPollInterval(checkedEmpty);
        await flush();
        assert.strictEqual(syncBotCalls, 0, 'checked-empty fingerprint must not re-fire the pre-seed sync');
        stopBotsConfigPollInterval(checkedEmpty);

        const neverChecked = makeSelf(null);
        setupBotsConfigPollInterval(neverChecked);
        await flush();
        assert.strictEqual(syncBotCalls, 1, 'never-checked (null) fingerprint must fire the pre-seed sync once');
        stopBotsConfigPollInterval(neverChecked);
    } finally {
        fs.existsSync = savedExistsSync;
        fs.readFileSync = savedReadFileSync;
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testBotsConfigPollRunsWhenWrapperOwned() {
    // The per-bot poll now runs in ALL modes: wrapper-owned bots skip only
    // the adapter drive, the live bot-config check still ticks (Issue #27).
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    process.env.DEXBOT_ADAPTER_OWNER = 'wrapper';
    Config.pm_exec_path = undefined;
    try {
        const { setupBotsConfigPollInterval, stopBotsConfigPollInterval } = loadRuntimeWithStubs();
        const logs = [];
        const self = {
            config: { timing: { BOTS_CONFIG_POLL_INTERVAL_MS: 60000 } },
            _botsConfigPollInterval: null,
            _marketAdapterWatchdogFingerprint: null,
            _log: (msg) => logs.push(String(msg)),
            _warn: (msg) => logs.push(`WARN:${msg}`),
        };

        setupBotsConfigPollInterval(self);

        assert.ok(self._botsConfigPollInterval, 'poll timer must exist even when the wrapper owns the adapter');
        assert.ok(
            logs.some((msg) => msg.includes('live bot-config check')),
            'poll start should mention the live bot-config check'
        );
        stopBotsConfigPollInterval(self);
        assert.strictEqual(self._botsConfigPollInterval, null, 'poll timer should stop cleanly');

        // Wrapper-less fallback still polls.
        delete process.env.DEXBOT_ADAPTER_OWNER;
        setupBotsConfigPollInterval(self);
        assert.ok(self._botsConfigPollInterval, 'fallback poll timer should exist without a wrapper');
        stopBotsConfigPollInterval(self);
        assert.strictEqual(self._botsConfigPollInterval, null, 'fallback poll timer should stop cleanly');
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveBotConfigAppliesAllowlistedKeys() {
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const logs = [];
        const warns = [];
        const fileEntry: any = {
            name: 'Live Bot',
            active: true,
            gridPrice: 'book',
            coreOrders: { buy: 5, sell: 5 },
            edgeOrders: { buy: 0, sell: 0 },
            botFunds: { buy: '100%', sell: '100%' },
            weightDistribution: { sell: 1, buy: 1 },
        };
        const self: any = {
            config: {
                name: 'Live Bot',
                gridPrice: 'book',
                coreOrders: { buy: 5, sell: 5 },
                edgeOrders: { buy: 0, sell: 0 },
                botFunds: { buy: '100%', sell: '100%' },
                weightDistribution: { sell: 1, buy: 1 },
            },
            manager: { config: {} },
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [JSON.parse(JSON.stringify(fileEntry))],
                needsMarketAdapter: false,
            }),
            _log: (msg) => logs.push(String(msg)),
            _warn: (msg) => warns.push(String(msg)),
        };
        self.manager.config = { ...self.config };

        const baseline = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(baseline.reason, 'baseline', 'first check seeds the baseline silently');
        assert.strictEqual(typeof self._appliedBotConfigFingerprint, 'string', 'baseline fingerprint stored');

        // Simulate a user edit: buy-window 5->7, reserve sell 0->2.
        fileEntry.coreOrders.buy = 7;
        fileEntry.edgeOrders.sell = 2;
        const applied = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(applied.applied, true, 'allowlisted edits must apply live');
        assert.deepStrictEqual(applied.liveChanges.sort(), ['coreOrders', 'edgeOrders'], 'changed keys reported');
        assert.strictEqual(self.config.coreOrders.buy, 7, 'bot.config merged');
        assert.strictEqual(self.manager.config.coreOrders.buy, 7, 'manager.config merged');
        assert.strictEqual(self.manager.config.edgeOrders.sell, 2, 'reserve toggle merged');
        assert.ok(
            logs.some((msg) => msg.includes('no restart needed') && msg.includes('Live Bot')),
            'live apply must log what changed with a no-restart note'
        );

        // Unchanged tick stays quiet.
        logs.length = 0;
        const quiet = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(quiet.reason, 'unchanged', 'steady state must not re-apply');
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveBotConfigHintsNonLiveChanges() {
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges, buildBotConfigFingerprint } = loadRuntimeWithStubs();
        const warns = [];
        const fileEntry: any = {
            name: 'Geo Bot',
            active: true,
            gridPrice: 'book',
            incrementPercent: 0.3,
            coreOrders: { buy: 5, sell: 5 },
        };
        const self: any = {
            config: { name: 'Geo Bot', gridPrice: 'book', incrementPercent: 0.3, coreOrders: { buy: 5, sell: 5 } },
            manager: { config: { name: 'Geo Bot' } },
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [JSON.parse(JSON.stringify(fileEntry))],
                needsMarketAdapter: false,
            }),
            _log: () => {},
            _warn: (msg) => warns.push(String(msg)),
        };

        await checkAndApplyBotConfigChanges(self, 'unit-test');
        // Geometry edit: incrementPercent is outside the live allowlist.
        fileEntry.incrementPercent = 0.9;
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.applied, false, 'geometry edits must NOT apply live');
        assert.ok(
            (result.otherKeys || []).includes('incrementPercent'),
            'geometry key must be reported for reset/restart'
        );
        assert.strictEqual(self.config.incrementPercent, 0.3, 'running config must keep the old geometry');
        assert.ok(
            warns.some((msg) => msg.includes('dexbot reset Geo Bot')),
            'hint must name the reset command for geometry changes'
        );
        // Funds-only edits DO move the live fingerprint while the adapter
        // fingerprint stays put (documents why the 1min adapter check alone
        // could never pick them up).
        assert.notStrictEqual(
            buildBotConfigFingerprint({ ...fileEntry, coreOrders: { buy: 9, sell: 5 } }),
            buildBotConfigFingerprint({ ...fileEntry, coreOrders: { buy: 5, sell: 5 } }),
            'live fingerprint must cover buy-window counts'
        );
        // Legacy keys canonicalize before hashing, so a pre-rename bots.json
        // fingerprints identically to its rewritten form (no spurious resync).
        assert.strictEqual(
            buildBotConfigFingerprint({ name: 'L', activeOrders: { buy: 5, sell: 5 }, reserveOrders: 1 }),
            buildBotConfigFingerprint({ name: 'L', coreOrders: { buy: 5, sell: 5 }, edgeOrders: 1 }),
            'legacy activeOrders/reserveOrders fingerprint identically to canonical keys'
        );
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveBotConfigSkipsCorruptWithoutClobbering() {
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const self: any = {
            config: { name: 'Live Bot', coreOrders: { buy: 5, sell: 5 } },
            manager: { config: {} },
            _appliedBotConfigFingerprint: 'good-fingerprint',
            _appliedBotConfigEntry: { name: 'Live Bot', coreOrders: { buy: 5, sell: 5 } },
            _loadBotsConfigSnapshot: async () => ({ corrupt: true }),
            _log: () => {},
            _warn: () => {},
        };
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.skipped, true, 'corrupt file must skip');
        assert.strictEqual(self._appliedBotConfigFingerprint, 'good-fingerprint', 'stored fingerprint preserved');
        assert.strictEqual(self.config.coreOrders.buy, 5, 'running config untouched');
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveBotConfigBaselineConvergesStartupRace() {
    // File edited between process config load and the first check: the
    // baseline must converge the running config, not silently absorb the edit.
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const logs: string[] = [];
        const self: any = {
            config: { name: 'Race Bot', coreOrders: { buy: 15, sell: 15 } },
            manager: { config: { name: 'Race Bot', coreOrders: { buy: 15, sell: 15 } } },
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [{ name: 'Race Bot', active: true, coreOrders: { buy: 20, sell: 20 } }],
                needsMarketAdapter: false,
            }),
            _log: (msg: any) => logs.push(String(msg)),
            _warn: () => {},
        };
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.reason, 'baseline', 'first check still reports baseline');
        assert.strictEqual(result.applied, true, 'startup race edit must converge');
        assert.strictEqual(self.config.coreOrders.buy, 20, 'bot.config converged to file');
        assert.strictEqual(self.manager.config.coreOrders.sell, 20, 'manager.config converged to file');
        assert.ok(
            logs.some((msg) => msg.includes('startup check')),
            'race convergence must be logged'
        );
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveDebtPolicyTweakAppliesAndReconciles() {
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const logs: string[] = [];
        const calls: string[] = [];
        const fileEntry: any = {
            name: 'Credit Bot',
            active: true,
            debtPolicy: {
                lending: [{
                    type: 'creditOffer', asset: 'BTS', collateralAsset: 'X',
                    outputWeight: 1, maxCollateralRatio: 1.5,
                }],
            },
        };
        const self: any = {
            config: { name: 'Credit Bot', debtPolicy: JSON.parse(JSON.stringify(fileEntry.debtPolicy)) },
            manager: { config: {} },
            _creditRuntime: { config: null },
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [JSON.parse(JSON.stringify(fileEntry))],
                needsMarketAdapter: false,
            }),
            _setupCreditRuntime: async () => { calls.push('setup'); },
            _setupCreditWatchdogInterval: () => { calls.push('watchdog-start'); },
            _stopCreditWatchdogInterval: () => { calls.push('watchdog-stop'); },
            _log: (msg: any) => logs.push(String(msg)),
            _warn: () => {},
        };
        self.manager.config = { ...self.config };
        self._creditRuntime.config = self.config;

        await checkAndApplyBotConfigChanges(self, 'unit-test');
        fileEntry.debtPolicy.lending[0].maxCollateralRatio = 1.8;
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.applied, true, 'debtPolicy tweak must apply live');
        assert.ok((result.liveChanges || []).includes('debtPolicy'), 'debtPolicy reported as live change');
        assert.strictEqual(self.config.debtPolicy.lending[0].maxCollateralRatio, 1.8, 'bot.config merged');
        assert.strictEqual(self.manager.config.debtPolicy.lending[0].maxCollateralRatio, 1.8, 'manager.config merged');
        assert.ok(calls.includes('setup'), 'credit runtime setup must run');
        assert.ok(calls.includes('watchdog-start'), 'watchdog must rebind to current runtime');
        assert.ok(!calls.includes('watchdog-stop'), 'watchdog must not stop while enabled');
        assert.ok(
            logs.some((msg) => msg.includes('debtPolicy') && msg.includes('no restart needed')),
            'live apply must log debtPolicy with a no-restart note'
        );
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveDebtPolicyMalformedIsHintedNotMerged() {
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const warns: string[] = [];
        const calls: string[] = [];
        const fileEntry: any = {
            name: 'Credit Bot',
            active: true,
            debtPolicy: {
                lending: [{ type: 'creditOffer', asset: 'BTS', collateralAsset: 'X' }],
            },
        };
        const self: any = {
            config: { name: 'Credit Bot', debtPolicy: JSON.parse(JSON.stringify(fileEntry.debtPolicy)) },
            manager: { config: {} },
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [JSON.parse(JSON.stringify(fileEntry))],
                needsMarketAdapter: false,
            }),
            _setupCreditRuntime: async () => { calls.push('setup'); },
            _setupCreditWatchdogInterval: () => { calls.push('watchdog-start'); },
            _stopCreditWatchdogInterval: () => { calls.push('watchdog-stop'); },
            _log: () => {},
            _warn: (msg: any) => warns.push(String(msg)),
        };
        await checkAndApplyBotConfigChanges(self, 'unit-test');
        // Break the shape: collateralAsset is required by the enable gate.
        delete fileEntry.debtPolicy.lending[0].collateralAsset;
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.applied, false, 'malformed policy must NOT apply live');
        assert.ok((result.otherKeys || []).includes('debtPolicy'), 'debtPolicy must be hinted for reset/restart');
        assert.strictEqual(
            self.config.debtPolicy.lending[0].collateralAsset, 'X',
            'running config must keep the last good policy'
        );
        assert.strictEqual(calls.length, 0, 'no credit reconcile on rejected shape');
        assert.ok(
            warns.some((msg) => msg.includes('debtPolicy')),
            'hint must name debtPolicy'
        );
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveDebtPolicyRemovalDisablesWatchdog() {
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const calls: string[] = [];
        const fileEntry: any = {
            name: 'Credit Bot',
            active: true,
            debtPolicy: {
                lending: [{ type: 'creditOffer', asset: 'BTS', collateralAsset: 'X' }],
            },
        };
        const self: any = {
            config: { name: 'Credit Bot', debtPolicy: JSON.parse(JSON.stringify(fileEntry.debtPolicy)) },
            manager: { config: {} },
            _creditRuntime: {},
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [JSON.parse(JSON.stringify(fileEntry))],
                needsMarketAdapter: false,
            }),
            // Mirror _getCreditRuntime: invalid/absent policy nulls the ref.
            _setupCreditRuntime: async () => {
                calls.push('setup');
                self._creditRuntime = null;
            },
            _setupCreditWatchdogInterval: () => { calls.push('watchdog-start'); },
            _stopCreditWatchdogInterval: () => { calls.push('watchdog-stop'); },
            _log: () => {},
            _warn: () => {},
        };
        await checkAndApplyBotConfigChanges(self, 'unit-test');
        delete fileEntry.debtPolicy;
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.applied, true, 'policy removal applies (disable path)');
        assert.strictEqual(self.config.debtPolicy, null, 'running policy cleared');
        assert.ok(calls.includes('watchdog-stop'), 'watchdog interval must stop when disabled');
        assert.ok(!calls.includes('watchdog-start'), 'watchdog must not start when disabled');
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testLiveMinBtsValueApplies() {
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const fileEntry: any = { name: 'Fee Bot', active: true, min_BTS_value: 10 };
        const self: any = {
            config: { name: 'Fee Bot', min_BTS_value: 10 },
            manager: { config: { name: 'Fee Bot', min_BTS_value: 10 } },
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [JSON.parse(JSON.stringify(fileEntry))],
                needsMarketAdapter: false,
            }),
            _log: () => {},
            _warn: () => {},
        };
        await checkAndApplyBotConfigChanges(self, 'unit-test');
        fileEntry.min_BTS_value = 25;
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.applied, true, 'min_BTS_value must apply live');
        assert.strictEqual(self.config.min_BTS_value, 25, 'bot.config merged');
        assert.strictEqual(self.manager.config.min_BTS_value, 25, 'manager.config merged');
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function testBaselineDebtPolicyTweakReconciles() {
    // Startup race: file changed between process load and the first check.
    // A valid tweak must merge AND reconcile (previously merged without
    // reconcile, so enable-from-zero in the race window never took effect).
    const previousOwner = process.env.DEXBOT_ADAPTER_OWNER;
    delete process.env.DEXBOT_ADAPTER_OWNER;
    Config.pm_exec_path = undefined;
    try {
        const { checkAndApplyBotConfigChanges } = loadRuntimeWithStubs();
        const calls: string[] = [];
        const fileEntry: any = {
            name: 'Credit Bot',
            active: true,
            debtPolicy: {
                lending: [{
                    type: 'creditOffer', asset: 'BTS', collateralAsset: 'X',
                    maxCollateralRatio: 1.8,
                }],
            },
        };
        const self: any = {
            // Startup config still holds the old threshold.
            config: { name: 'Credit Bot', debtPolicy: { lending: [{
                type: 'creditOffer', asset: 'BTS', collateralAsset: 'X',
                maxCollateralRatio: 1.5,
            }] } },
            manager: { config: {} },
            _appliedBotConfigFingerprint: null,
            _appliedBotConfigEntry: null,
            _loadBotsConfigSnapshot: async () => ({
                exists: true,
                fingerprint: '',
                activeBots: [JSON.parse(JSON.stringify(fileEntry))],
                needsMarketAdapter: false,
            }),
            _setupCreditRuntime: async () => { calls.push('setup'); },
            _setupCreditWatchdogInterval: () => { calls.push('watchdog-start'); },
            _stopCreditWatchdogInterval: () => { calls.push('watchdog-stop'); },
            _log: () => {},
            _warn: () => {},
        };
        self.manager.config = { ...self.config };
        const result = await checkAndApplyBotConfigChanges(self, 'unit-test');
        assert.strictEqual(result.reason, 'baseline');
        assert.strictEqual(self.config.debtPolicy.lending[0].maxCollateralRatio, 1.8, 'race tweak merged');
        assert.ok(calls.includes('setup'), 'credit runtime must reconcile on baseline merge');
    } finally {
        if (previousOwner === undefined) delete process.env.DEXBOT_ADAPTER_OWNER;
        else process.env.DEXBOT_ADAPTER_OWNER = previousOwner;
    }
}

async function main() {
    try {
        await testSnapshotReaderDetectsAMAConfig();
        await testWrapperOwnedSkipsAdapterSyncWithoutReadingConfig();
        await testSemanticFingerprintIgnoresNonAmaEdits();
        await testEmptyFingerprintSteadyStateReportsNoChange();
        await testCorruptBotsConfigSkipsSyncWithoutTouchingAdapter();
        await testUnreadableBotsConfigSkipsSyncWithoutTouchingAdapter();
        await testBotsConfigPollPreseedsOnlyWhenUnchecked();
        await testBotsConfigPollRunsWhenWrapperOwned();
        await testLiveBotConfigAppliesAllowlistedKeys();
        await testLiveBotConfigHintsNonLiveChanges();
        await testLiveBotConfigSkipsCorruptWithoutClobbering();
        await testLiveBotConfigBaselineConvergesStartupRace();
        await testLiveDebtPolicyTweakAppliesAndReconciles();
        await testLiveDebtPolicyMalformedIsHintedNotMerged();
        await testLiveDebtPolicyRemovalDisablesWatchdog();
        await testLiveMinBtsValueApplies();
        await testBaselineDebtPolicyTweakReconciles();
        await testWatchdogStartsAdapterWhenMissing();
        await testWatchdogSkipsLaunchWhenAdapterNotNeeded();
        await testWatchdogLeavesAdapterStoppedWhenAlreadyAbsent();
        await testWatchdogUsesDirectRuntimeWithoutPm2();
        await testWatchdogDoesNotRegisterNonAmaBotInDirectRuntime();
        await testWatchdogUsesSnapshotEntryWhenRuntimeConfigIsStale();
        await testWatchdogReleasesDirectRuntimeWithoutPm2();
        await testSetupBlockchainFetchIntervalRunsWatchdogBeforeDisabledReturn();
        console.log('dexbot maintenance runtime market adapter watchdog tests passed');
    } finally {
        Config.pm_exec_path = undefined;
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        for (const [modulePath, original] of originals.entries()) {
            restoreCachedModule(modulePath, original);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
