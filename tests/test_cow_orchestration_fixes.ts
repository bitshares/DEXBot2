const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM namespaces are frozen and require.cache injection cannot
// intercept static ESM imports, so chain_orders is replaced via loader hooks
// (same technique as test_cow_ops_per_broadcast). Swappable functions resolve
// per-test overrides at CALL time: assignments mutate the override map through
// the Proxy while consumers' captured named-export bindings stay valid.
esmMockEntry();

function makeSwappableModule(defaults: Record<string, any>) {
    const overrides = new Map<string, any>();
    const resolved = (key: string) => (overrides.has(key) ? overrides.get(key) : defaults[key]);
    const target: Record<string, any> = {};
    for (const key of Object.keys(defaults)) {
        target[key] = typeof defaults[key] === 'function'
            ? (...args: any[]) => resolved(key)(...args)
            : defaults[key];
    }
    return new Proxy(target, {
        set(_t: any, prop: string | symbol, value: any) {
            const key = String(prop);
            if (target[key] === value) {
                overrides.delete(key);
            } else {
                overrides.set(key, value);
            }
            return true;
        },
    });
}

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');

const chainOrders = makeSwappableModule({
    BroadcastUncertainError,
    selectAccount: async () => {},
    setPreferredAccount: async () => {},
    resolveAccountId: async () => null,
    resolveAccountName: async () => null,
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    readSingleOrder: async () => null,
    batchReadOrders: async () => [],
    listenForFills: async () => () => {},
    updateOrder: async () => { throw new Error('updateOrder not configured for this test'); },
    createOrder: async () => { throw new Error('createOrder not configured for this test'); },
    cancelOrder: async () => { throw new Error('cancelOrder not configured for this test'); },
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    buildUpdateOrderOp: async () => { throw new Error('buildUpdateOrderOp not configured for this test'); },
    buildCreateOrderOp: async () => { throw new Error('buildCreateOrderOp not configured for this test'); },
    buildCancelOrderOp: async () => { throw new Error('buildCancelOrderOp not configured for this test'); },
    buildLiquidityPoolExchangeOp: async () => { throw new Error('buildLiquidityPoolExchangeOp not configured for this test'); },
    executeBatch: async () => { throw new Error('executeBatch not configured for this test'); },
    findOverReducingUpdateOpError: async () => null,
    wasRecentlyOwnCancelled: () => false,
    recordOwnCancel: () => {},
    broadcastTxWithClassification: async () => ({})
});
defineEsmMockAbs(require.resolve('../modules/chain_orders'), [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], chainOrders);

const DEXBot = require('../modules/dexbot_class').default;
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

let testsComplete = false;

process.on('unhandledRejection', (reason) => {
    console.error('Test failed:', reason);
    process.exit(1);
});

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

function makeBot() {
    const bot = new DEXBot({
        botKey: 'test_cow_orchestration_fixes',
        dryRun: false,
        startPrice: 100,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    const logEntries = [];
    const orders = new Map();
    const manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders,
        logger: {
            log: (msg, level) => { logEntries.push({ msg: String(msg), level }); },
            logFundsStatus: () => {}
        },
        _logEntries: logEntries,
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => true,
        _clearWorkingGridRef: () => {},
        _clearPendingBroadcasts: () => {},
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _pendingBroadcasts: new Map(),
        persistGrid: async () => ({ isValid: true, skipped: false }),
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        synchronizeWithChain: async () => {},
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
    };
    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    return { bot, manager, logEntries };
}

/**
 * Pre-broadcast price drift must be REPORTED, never adopted.
 *
 * This test previously asserted the opposite: that a drifted live slot price
 * overrode the planned action price. That behaviour was the second link in the
 * off-grid-price chain — it re-broadcast whatever the slot happened to hold, so
 * a slot whose price had been mutated away from its genesis level propagated
 * that value to the chain. slot.price is derived from the genesis ladder, not
 * authoritative, so a divergence is a signal.
 *
 * The corrected contract, asserted here:
 *   - the op is built from the PLANNED price (not the drifted live one),
 *   - the drift is still surfaced, at warn (it was debug, and therefore
 *     invisible in production).
 */
async function testPreBroadcastPriceFreshnessRebuildsOp() {
    console.log(' - Pre-broadcast price drift is reported, not adopted...');
    const { bot, manager, logEntries } = makeBot();
    const plannedOrder = {
        id: 'sell-7',
        type: ORDER_TYPES.SELL,
        price: 100,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    };
    manager.orders.set('sell-7', {
        id: 'sell-7',
        type: ORDER_TYPES.SELL,
        price: 103.25,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    });

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    let capturedArgs: any = null;
    chainOrders.buildCreateOrderOp = async (account: any, amountToSell: any, sellAssetId: any, minToReceive: any, receiveAssetId: any) => {
        capturedArgs = { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        return {
            op: { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: amountToSell, asset_id: sellAssetId }, min_to_receive: { amount: minToReceive, asset_id: receiveAssetId } } },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-7', { ...plannedOrder });
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-7', order: plannedOrder }]
        });
        assert.strictEqual(result.executed, true, 'Drifted create should still execute');

        // The emitted amounts must reflect the PLANNED price. At a sell price
        // of 100 with size 10, min_to_receive is 1000; adopting the drifted
        // live=103.25 would inflate it by 3.25% (to 1032.5).
        assert.ok(capturedArgs, 'buildCreateOrderOp must have been called');
        const plannedMin = 10 * plannedOrder.price;
        assert.strictEqual(capturedArgs.minToReceive, plannedMin,
            `op must be built from the planned price (expected min_to_receive ${plannedMin}, got ${capturedArgs.minToReceive})`);
        assert.notStrictEqual(capturedArgs.minToReceive, 10 * 103.25,
            'op must NOT be built from the drifted live price');

        // The drift must still be surfaced, and at warn (it was debug before,
        // which is why this substitution went unnoticed in production).
        const driftLog = logEntries.find(l => l.msg.includes('Pre-broadcast price drift'));
        assert.ok(driftLog, 'Drift log line must be present');
        assert.ok(driftLog.msg.includes('planned=100'), 'Drift log should show planned=100');
        assert.ok(driftLog.msg.includes('live=103.25'), 'Drift log should show live=103.25');
        assert.strictEqual(driftLog.level, 'warn', 'drift must be reported at warn, not debug');
        assert.ok(driftLog.msg.includes('emitting planned price'), 'log must state that the planned price is emitted');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
}

async function testPreBroadcastNoDriftNoRebuild() {
    console.log(' - Pre-broadcast price freshness: matching price does not change the op...');
    const { bot, manager, logEntries } = makeBot();
    const plannedOrder = {
        id: 'sell-3',
        type: ORDER_TYPES.SELL,
        price: 100,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    };
    manager.orders.set('sell-3', { ...plannedOrder });

    let buildCallCount = 0;
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        buildCallCount += 1;
        return {
            op: { op_name: 'limit_order_create', op_data: {} },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-3', { ...plannedOrder });
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-3', order: plannedOrder }]
        });
        assert.strictEqual(buildCallCount, 1, 'Build should be called exactly once');
        const driftLog = logEntries.find(l => l.msg.includes('Pre-broadcast price freshness'));
        assert.ok(!driftLog, 'No drift log expected when prices match');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-FRESH-002 passed');
}

async function testPersistenceCommitGuardRetriesOnSkipped() {
    console.log(' - Persistence commit guard retries once and clears the warning on success...');
    const { bot, manager, logEntries } = makeBot();
    let persistCalls = 0;
    manager.persistGrid = async () => {
        persistCalls += 1;
        if (persistCalls === 1) {
            return { isValid: true, skipped: true, suspended: true, reason: 'unit-test' };
        }
        return { isValid: true, skipped: false };
    };

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    const plannedOrder = {
        id: 'sell-1', type: ORDER_TYPES.SELL, price: 100, size: 10,
        state: ORDER_STATES.VIRTUAL, orderId: ''
    };
    manager.orders.set('sell-1', { ...plannedOrder });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-1', { ...plannedOrder });
        manager._persistenceWarning = { isValid: true, skipped: true, reason: 'pre-existing' };
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-1', order: plannedOrder }]
        });
        assert.strictEqual(result.executed, true, 'Batch should execute normally');
        assert.strictEqual(persistCalls, 2, 'persistGrid should be retried exactly once');
        const guardLog = logEntries.find(l => l.msg.includes('First persist attempt was skipped'));
        assert.ok(guardLog, 'Guard log line should fire on first skipped persist');
        assert.strictEqual(manager._persistenceWarning, undefined, 'Warning should be cleared on successful retry');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-PERSIST-001 passed');
}

async function testPersistenceCommitGuardRequestsResyncOnRepeatedFailure() {
    console.log(' - Persistence commit guard requests structural resync on repeated failure...');
    const { bot, manager, logEntries } = makeBot();
    manager.persistGrid = async () => ({ isValid: false, skipped: false });

    const resyncCalls = [];
    (manager as any).requestStructuralGridResync = async (reason, opts) => {
        resyncCalls.push({ reason, opts });
        return { scheduled: true };
    };

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    const plannedOrder = {
        id: 'sell-2', type: ORDER_TYPES.SELL, price: 100, size: 10,
        state: ORDER_STATES.VIRTUAL, orderId: ''
    };
    manager.orders.set('sell-2', { ...plannedOrder });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-2', { ...plannedOrder });
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-2', order: plannedOrder }]
        });
        assert.strictEqual(result.executed, true, 'Batch should still execute; persistence failure is non-fatal');
        const errLog = logEntries.find(l => l.msg.includes('Retry also skipped/invalid'));
        assert.ok(errLog, 'Error log for retry failure should fire');
        assert.strictEqual(manager._recoveryState.structuralResyncRequested, true, 'Resync flag should be set');
        assert.strictEqual(resyncCalls.length, 1, 'requestStructuralGridResync should be called once');
        assert.strictEqual(resyncCalls[0].reason, 'persistence guard triggered after COW batch', 'Resync reason should mention the persistence guard');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-PERSIST-002 passed');
}

async function testPersistenceCommitGuardDefersOnSustainedSuspension() {
    console.log(' - Persistence commit guard defers (no structural resync) while persistence is suspended...');
    const { bot, manager, logEntries } = makeBot();
    let persistCalls = 0;
    manager.persistGrid = async () => {
        persistCalls += 1;
        return {
            isValid: true,
            skipped: true,
            suspended: true,
            reason: 'credential daemon watchdog failed: Daemon ping timeout'
        };
    };

    const resyncCalls = [];
    (manager as any).requestStructuralGridResync = async (reason, opts) => {
        resyncCalls.push({ reason, opts });
        return { scheduled: true };
    };
    let dirtyMarkCalls = 0;
    (manager as any)._markGridDirty = () => { dirtyMarkCalls += 1; };

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    const plannedOrder = {
        id: 'sell-4', type: ORDER_TYPES.SELL, price: 100, size: 10,
        state: ORDER_STATES.VIRTUAL, orderId: ''
    };
    manager.orders.set('sell-4', { ...plannedOrder });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-4', { ...plannedOrder });
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-4', order: plannedOrder }]
        });
        assert.strictEqual(result.executed, true, 'Batch should still execute; suspension is non-fatal');
        assert.strictEqual(persistCalls, 2, 'persistGrid should be attempted twice (first + one retry)');
        const deferLog = logEntries.find(l => l.msg.includes('Grid persistence is suspended'));
        assert.ok(deferLog, 'Deferral log should fire when the retry is still suspended');
        assert.strictEqual(resyncCalls.length, 0, 'A deliberate persistence suspension must NOT trigger a structural resync');
        assert.strictEqual(dirtyMarkCalls, 1, 'The un-persisted committed grid must be marked dirty so the flush safety net retries it');
        assert.strictEqual(manager._persistenceWarning, undefined, 'Warning should be cleared on the deferral path');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-PERSIST-003 passed');
}

async function run() {
    console.log('Running COW orchestration fix tests...');
    await testPreBroadcastPriceFreshnessRebuildsOp();
    await testPreBroadcastNoDriftNoRebuild();
    await testPersistenceCommitGuardRetriesOnSkipped();
    await testPersistenceCommitGuardRequestsResyncOnRepeatedFailure();
    await testPersistenceCommitGuardDefersOnSustainedSuspension();
    console.log('\n\u2713 All COW orchestration fix tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
}).finally(() => {
    testsComplete = true;
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
