const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

// Import mergeSettings directly — no module mocking needed
const { mergeSettings } = require('../modules/settings_merge');

// =============================================================================
// Helpers
// =============================================================================

function _run(desc, fn) {
    try {
        fn();
        console.log(`  ✓ ${desc}`);
    } catch (e) {
        console.error(`  ✗ ${desc}`);
        console.error(`    ${getErrorMessage(e)}`);
        process.exitCode = 1;
    }
}

const DEFAULTS = Object.freeze({
    LOG_LEVEL: 'info',
    TIMING: { SYNC_DELAY_MS: 500, COMMIT_INTERVAL_MS: 3000 },
    GRID_LIMITS: {
        MIN_ORDER_COUNT: 2,
        MAX_ORDER_COUNT: 100,
        GRID_COMPARISON: { RMS_PERCENTAGE: 15, MEAN_PERCENTAGE: 10 },
    },
    FILL_PROCESSING: { MODE: 'history', RETRY_ATTEMPTS: 3 },
    PIPELINE_TIMING: { TIMEOUT_MS: 300000 },
    DEFAULT_CONFIG: { active: true },
    UPDATER: { ACTIVE: true, BRANCH: 'auto' },
    CREDENTIAL_PROMPTS: { MAX_MASTER_PASSWORD_ATTEMPTS: 5 },
    MAINTENANCE: { CLEANUP_PROBABILITY: 0.1 },
    COW_PERFORMANCE: { MAX_MEMORY_MB: 50 },
    INCREMENT_BOUNDS: { MIN_PERCENT: 0.01, MAX_PERCENT: 10 },
    FEE_PARAMETERS: { BTS_RESERVATION_MULTIPLIER: 5, TAKER_FEE_PERCENT: 1.0 },
    API_LIMITS: { MAX_ORDERS_PER_CALL: 100 },
    LOGGING_CONFIG: { rotation: { enabled: true, maxSize: 1e6 } },
    NATIVE_CLIENT: { CHAIN: { PRECISION: 100000 }, TRANSPORT: { RPC_TIMEOUT_MS: 15000 } },
    LAUNCHER: { MONOLITHIC: { maxRestarts: 13 }, SUPERVISOR: { MAX_RESTARTS: 13 } },
    NODE_MANAGEMENT: {
        DEFAULT_ENABLED: true,
        DEFAULT_NODES: ['wss://node1.example.com'],
        HEALTH_CHECK_INTERVAL_MS: 14400000,
        HEALTH_CHECK_TIMEOUT_MS: 5000,
        MAX_PING_MS: 3000,
        BLACKLIST_THRESHOLD: 3,
        SELECTION_STRATEGY: 'latency',
    },
    MARKET_ADAPTER: {
        AMA_DELTA_THRESHOLD_PERCENT: 1.0,
        KIBANA_REQUEST_TIMEOUT_MS: 180000,
        RUNTIME_DEFAULTS: { intervalSeconds: 3600 },
    },
});

// =============================================================================
// 1. No settings → passthrough unchanged
// =============================================================================

(function testNullSettings() {
    const r = mergeSettings(null, DEFAULTS);
    assert.strictEqual(r.LOG_LEVEL, 'info');
    assert.strictEqual(r.TIMING.SYNC_DELAY_MS, 500);
    assert.strictEqual(r.NODE_MANAGEMENT.DEFAULT_ENABLED, true);
    // NODES should be constructed when NODE_MANAGEMENT is in defaults
    assert.ok(r.NODES, 'NODES should be constructed');
    assert.strictEqual(r.NODES.enabled, true);
    assert.deepStrictEqual(r.NODES.list, ['wss://node1.example.com']);
    assert.strictEqual(r.NODES.healthCheck.intervalMs, 14400000);
})();

(function testUndefinedSettings() {
    const r = mergeSettings(undefined, DEFAULTS);
    assert.strictEqual(r.LOG_LEVEL, 'info');
    assert.ok(r.NODES);
})();

// =============================================================================
// 2. Replace strategy (LOG_LEVEL)
// =============================================================================

(function testReplaceStrategy() {
    const r = mergeSettings({ LOG_LEVEL: 'debug' }, DEFAULTS);
    assert.strictEqual(r.LOG_LEVEL, 'debug');
})();

(function testReplaceStrategyKeepsOtherDefaults() {
    const r = mergeSettings({ LOG_LEVEL: 'warn' }, DEFAULTS);
    assert.strictEqual(r.LOG_LEVEL, 'warn');
    assert.strictEqual(r.TIMING.SYNC_DELAY_MS, 500);
})();

// =============================================================================
// 3. Shallow merge (TIMING, FILL_PROCESSING, etc.)
// =============================================================================

(function testShallowMerge() {
    const r = mergeSettings({ TIMING: { SYNC_DELAY_MS: 999 } }, DEFAULTS);
    assert.strictEqual(r.TIMING.SYNC_DELAY_MS, 999);
    // Unchanged key preserved
    assert.strictEqual(r.TIMING.COMMIT_INTERVAL_MS, 3000);
})();

(function testShallowMergeIgnoresCommentKeys() {
    const r = mergeSettings({ TIMING: { SYNC_DELAY_MS: 777, _comment: 'ignored' } }, DEFAULTS);
    assert.strictEqual(r.TIMING.SYNC_DELAY_MS, 777);
    // _comment filtered (runtime check; return type is Record<string, any>)
    assert.strictEqual(r.TIMING._comment, undefined);
})();

// =============================================================================
// 4. Deep merge (NATIVE_CLIENT, LOGGING_CONFIG, LAUNCHER, NODE_MANAGEMENT, MARKET_ADAPTER)
// =============================================================================

(function testDeepMergeNested() {
    const r = mergeSettings({
        NATIVE_CLIENT: { CHAIN: { PRECISION: 1000 } }
    }, DEFAULTS);
    // Overridden key
    assert.strictEqual(r.NATIVE_CLIENT.CHAIN.PRECISION, 1000);
    // Unchanged nested key preserved
    assert.strictEqual(r.NATIVE_CLIENT.TRANSPORT.RPC_TIMEOUT_MS, 15000);
})();

(function testDeepMergeFullOverride() {
    const r = mergeSettings({
        NATIVE_CLIENT: { CHAIN: { PRECISION: 1000 }, TRANSPORT: { RPC_TIMEOUT_MS: 9999 } }
    }, DEFAULTS);
    assert.strictEqual(r.NATIVE_CLIENT.CHAIN.PRECISION, 1000);
    assert.strictEqual(r.NATIVE_CLIENT.TRANSPORT.RPC_TIMEOUT_MS, 9999);
})();

// =============================================================================
// 5. GRID_LIMITS with GRID_COMPARISON sub-object
// =============================================================================

(function testGridComparisonSubMerge() {
    const r = mergeSettings({
        GRID_LIMITS: { MIN_ORDER_COUNT: 5, GRID_COMPARISON: { RMS_PERCENTAGE: 99 } }
    }, DEFAULTS);
    assert.strictEqual(r.GRID_LIMITS.MIN_ORDER_COUNT, 5);
    assert.strictEqual(r.GRID_LIMITS.MAX_ORDER_COUNT, 100);
    assert.strictEqual(r.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE, 99);
    assert.strictEqual(r.GRID_LIMITS.GRID_COMPARISON.MEAN_PERCENTAGE, 10);
})();

(function testGridComparisonCommentFiltering() {
    const r = mergeSettings({
        GRID_LIMITS: { GRID_COMPARISON: { RMS_PERCENTAGE: 50, _note: 'test' } }
    }, DEFAULTS);
    assert.strictEqual(r.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE, 50);
    assert.strictEqual(r.GRID_LIMITS.GRID_COMPARISON.MEAN_PERCENTAGE, 10);
    // _note filtered (runtime check; return type is Record<string, any>)
    assert.strictEqual(r.GRID_LIMITS.GRID_COMPARISON._note, undefined);
})();

(function testDeepMergeRejectsProtoPollution() {
    // A crafted config file with prototype-dangerous own keys (as JSON.parse
    // produces them) must be skipped by the deep merge at every level instead
    // of being assigned onto the result and polluting Object.prototype.
    const evil = JSON.parse('{"LOGGING_CONFIG":{"__proto__":{"polluted":true},"rotation":{"__proto__":{"nestedPolluted":true},"enabled":false}}}');
    const r = mergeSettings(evil, DEFAULTS);

    const probe: any = {};
    assert.strictEqual(probe.polluted, undefined, "top-level '__proto__' key must not pollute Object.prototype");
    assert.strictEqual(probe.nestedPolluted, undefined, "nested '__proto__' key must not pollute Object.prototype");

    assert.strictEqual(r.LOGGING_CONFIG.rotation.enabled, false, 'legitimate sibling keys still merge');
    assert.strictEqual(r.LOGGING_CONFIG.rotation.maxSize, 1e6, 'untouched default siblings survive');
    assert.ok(!Object.keys(r.LOGGING_CONFIG).includes('__proto__'), 'result carries no own __proto__ key');
})();

// =============================================================================
// 6. NODES → NODE_MANAGEMENT mapping
// =============================================================================

(function testNodesMapsToNodeManagement() {
    const r = mergeSettings({
        NODES: {
            enabled: false,
            list: ['wss://custom.node/ws'],
            healthCheck: { intervalMs: 60000, timeoutMs: 10000, maxPingMs: 5000, blacklistThreshold: 5 },
            selection: { strategy: 'round-robin' },
        }
    }, DEFAULTS);
    assert.strictEqual(r.NODE_MANAGEMENT.DEFAULT_ENABLED, false);
    assert.deepStrictEqual(r.NODE_MANAGEMENT.DEFAULT_NODES, ['wss://custom.node/ws']);
    assert.strictEqual(r.NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS, 60000);
    assert.strictEqual(r.NODE_MANAGEMENT.HEALTH_CHECK_TIMEOUT_MS, 10000);
    assert.strictEqual(r.NODE_MANAGEMENT.MAX_PING_MS, 5000);
    assert.strictEqual(r.NODE_MANAGEMENT.BLACKLIST_THRESHOLD, 5);
    assert.strictEqual(r.NODE_MANAGEMENT.SELECTION_STRATEGY, 'round-robin');
})();

// =============================================================================
// 7. NODES passthrough of unmapped sub-keys
// =============================================================================

(function testNodesPassthroughUnmappedKeys() {
    const r = mergeSettings({
        NODES: {
            healthCheck: { enabled: false, someFutureField: 42 },
            selection: { preferredNode: 'wss://special.node/ws', experimental: 'xyz' },
        }
    }, DEFAULTS);
    // Mapped fields keep their defaults
    assert.strictEqual(r.NODES.healthCheck.intervalMs, 14400000);
    assert.strictEqual(r.NODES.selection.strategy, 'latency');
    // Unmapped fields pass through
    assert.strictEqual(r.NODES.healthCheck.enabled, false);
    assert.strictEqual(r.NODES.healthCheck.someFutureField, 42);
    assert.strictEqual(r.NODES.selection.preferredNode, 'wss://special.node/ws');
    assert.strictEqual(r.NODES.selection.experimental, 'xyz');
})();

// =============================================================================
// 8. MARKET_ADAPTER deep merge
// =============================================================================

(function testMarketAdapterDeepMerge() {
    const r = mergeSettings({
        MARKET_ADAPTER: { AMA_DELTA_THRESHOLD_PERCENT: 2.5, KIBANA_REQUEST_TIMEOUT_MS: 999999 }
    }, DEFAULTS);
    assert.strictEqual(r.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT, 2.5);
    assert.strictEqual(r.MARKET_ADAPTER.KIBANA_REQUEST_TIMEOUT_MS, 999999);
    // Nested default preserved
    assert.strictEqual(r.MARKET_ADAPTER.RUNTIME_DEFAULTS.intervalSeconds, 3600);
})();

// =============================================================================
// 10. Comment-key filtering across all strategies
// =============================================================================

(function testShallowMergeFiltersComments() {
    const r = mergeSettings({
        FILL_PROCESSING: { MODE: 'live', _comment: 'test', _deprecated: true },
    }, DEFAULTS);
    assert.strictEqual(r.FILL_PROCESSING.MODE, 'live');
    // _comment filtered (runtime check; return type is Record<string, any>)
    assert.strictEqual(r.FILL_PROCESSING._comment, undefined);
    // _deprecated filtered (runtime check; return type is Record<string, any>)
    assert.strictEqual(r.FILL_PROCESSING._deprecated, undefined);
})();

(function testDeepMergeFiltersComments() {
    const r = mergeSettings({
        LOGGING_CONFIG: { rotation: { enabled: false, _comment: 'test' } },
    }, DEFAULTS);
    assert.strictEqual(r.LOGGING_CONFIG.rotation.enabled, false);
    // _comment filtered (runtime check; return type is Record<string, any>)
    assert.strictEqual(r.LOGGING_CONFIG.rotation._comment, undefined);
})();

// =============================================================================
// 11. Section not in defaults is absent from result
// =============================================================================

(function testUnknownSectionIgnored() {
    const r = mergeSettings({ UNKNOWN_KEY: { something: 1 } }, DEFAULTS);
    assert.strictEqual((r as any).UNKNOWN_KEY, undefined);
})();

// =============================================================================
// 12. FEE_PARAMETERS shallow merge (flat structure)
// =============================================================================

(function testFeeParametersShallowOverride() {
    const r = mergeSettings({ FEE_PARAMETERS: { TAKER_FEE_PERCENT: 0.5 } }, DEFAULTS);
    assert.strictEqual(r.FEE_PARAMETERS.TAKER_FEE_PERCENT, 0.5);
    assert.strictEqual(r.FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER, 5);
})();

// =============================================================================
// Results
// =============================================================================

const failures = process.exitCode || 0;
console.log(`\nSettings merge tests ${failures ? 'FAILED' : 'PASSED'} (${failures} failure(s))`);
