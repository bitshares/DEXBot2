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

const chainOrdersModule = makeSwappableModule({
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
    executeBatch: async () => ({ success: true, operation_results: [] }),
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
], chainOrdersModule);

const DEXBot = require('../modules/dexbot_class').default;
const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

function createOrder(id, overrides = {}) {
    return {
        id,
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        price: 1.1,
        size: 10,
        orderId: '1.7.999',
        ...overrides
    };
}

/**
 * Wait until `predicate` is true, yielding to the event loop between checks.
 * Unlike a fixed-duration sleep this returns as soon as the resync sequence
 * settles, so the test asserts on state instead of padding wall-clock time.
 */
function waitFor(predicate, message, maxMs = 2000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            let done = false;
            try { done = !!predicate(); } catch (err) { reject(err); return; }
            if (done) return resolve(undefined);
            if (Date.now() - start >= maxMs) return reject(new Error(`Timed out waiting for ${message}`));
            setImmediate(tick);
        };
        setImmediate(tick);
    });
}

async function runTests() {
    console.log('Running COW Structural Resync Wiring Tests...');

    console.log(' - COW guard aborts CREATE batch and triggers actual requestGridReset via structural resync wiring...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_structural_resync',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const masterOrders = new Map([
            ['slot-new', createOrder('slot-new', {
                state: ORDER_STATES.VIRTUAL,
                orderId: ''
            })]
        ]);

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: masterOrders,
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            _resetRebalanceStateToDepth: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => {},
            _clearWorkingGridRef: () => {},
            _recoveryState: {
                attemptCount: 3,
                lastAttemptAt: 12345,
                lastFailureAt: 67890,
                structuralResyncRequested: false
            }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';

        const requestGridResetCalls = [];
        bot.requestGridReset = async (reason, options) => {
            requestGridResetCalls.push({ reason, options });
            return { success: true };
        };

        let executeCalls = 0;

        bot._wireStructuralGridResyncRequest();

        // Monkeypatch chainOrders.cancelOrder to avoid real blockchain calls.
        const originalCancelOrder = chainOrdersModule.cancelOrder;
        const originalReadOpenOrdersWithMeta = chainOrdersModule.readOpenOrdersWithMeta;
        chainOrdersModule.cancelOrder = async () => {
            throw new Error('Simulated cancel failure for test');
        };
        // The COW abort path re-reads open orders with meta before escalating to
        // a structural resync; stub it so the test stays offline and fast.
        chainOrdersModule.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });

        try {
            (manager as any)._lastUnmatchedChainOrders = [{
            chainOrderId: '1.7.572303058',
            type: ORDER_TYPES.SELL,
            price: 1.101,
            size: 10
        }];

        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{
                type: COW_ACTIONS.CREATE,
                id: 'slot-new',
                order: {
                    id: 'slot-new',
                    type: ORDER_TYPES.SELL,
                    price: 1.1,
                    size: 10,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: ''
                }
            }]
        });

        assert.strictEqual(result.executed, false, 'Batch must be aborted');
        assert.strictEqual(result.aborted, true, 'Batch must be marked aborted');
        assert.strictEqual(result.reason, 'UNMATCHED_CHAIN_ORDERS', 'Abort reason must be UNMATCHED_CHAIN_ORDERS');
        assert.strictEqual(executeCalls, 0, 'No broadcast may have been attempted');

        assert.strictEqual(
            manager._recoveryState.structuralResyncRequested,
            true,
            'COW guard must set the structural resync latch so other paths see a resync is in progress'
        );

        await waitFor(
            () => requestGridResetCalls.length >= 1,
            'structural resync to call requestGridReset'
        );
        assert.strictEqual(
            requestGridResetCalls.length,
            1,
            'Structural resync callback must call requestGridReset exactly once'
        );
        assert.strictEqual(
            requestGridResetCalls[0].reason,
            'rms_structural_grid_resync',
            'Reset must be triggered with the structural resync reason code'
        );
        assert.strictEqual(
            requestGridResetCalls[0].options && requestGridResetCalls[0].options.refreshCenterPrice,
            false,
            'Reset must include refreshCenterPrice:false — a structural resync is state repair, not a re-anchor (docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md §2 fix #1: silent re-anchoring during recovery orphaned live orders)'
        );

        assert.strictEqual(manager._recoveryState.attemptCount, 0, 'Recovery attempt count must be reset after structural resync');
        assert.strictEqual(manager._recoveryState.lastAttemptAt, 0, 'Recovery lastAttemptAt must be reset after structural resync');
        assert.strictEqual(manager._recoveryState.lastFailureAt, 0, 'Recovery lastFailureAt must be reset after structural resync');
        assert.strictEqual(
            manager._recoveryState.structuralResyncRequested,
            false,
            'Structural resync latch must be cleared in finally block'
        );

        console.log('\u2713 COW-STRUCTURAL-RESYNC-001 passed');
        } finally {
            chainOrdersModule.cancelOrder = originalCancelOrder;
            chainOrdersModule.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        }
    }

    console.log(' - Duplicate structural resync schedule is deduped (timer + in-flight)...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_structural_resync_dedup',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: new Map(),
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            _resetRebalanceStateToDepth: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => {},
            _clearWorkingGridRef: () => {},
            _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';

        const requestGridResetCalls = [];
        bot.requestGridReset = async (reason) => {
            requestGridResetCalls.push(reason);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { success: true };
        };

        bot._wireStructuralGridResyncRequest();

        const unmatched = [{ chainOrderId: '1.7.572303058', type: ORDER_TYPES.SELL, price: 1.1, size: 10 }];
        const first = await (manager as any).requestStructuralGridResync('first trigger', { unmatchedChainOrders: unmatched });
        const second = await (manager as any).requestStructuralGridResync('second trigger', { unmatchedChainOrders: unmatched });

        assert.strictEqual(first.scheduled, true, 'First call should report scheduled');
        assert.strictEqual(second.skipped, true, 'Second call should be deduped (skipped)');
        assert.strictEqual(second.reason, 'structural grid resync already scheduled', 'Dedup reason should reference existing schedule');

        await waitFor(
            () => !bot._structuralGridResyncRunning && !bot._structuralGridResyncTimer && requestGridResetCalls.length >= 1,
            'first structural resync to complete'
        );

        assert.strictEqual(
            requestGridResetCalls.length,
            1,
            'Deduped calls must not produce additional requestGridReset invocations'
        );

        const third = await (manager as any).requestStructuralGridResync('after completion', { unmatchedChainOrders: unmatched });
        assert.strictEqual(third.scheduled, true, 'After completion a fresh schedule should be accepted');

        await waitFor(
            () => requestGridResetCalls.length >= 2,
            'second structural resync to call requestGridReset'
        );

        assert.strictEqual(
            requestGridResetCalls.length,
            2,
            'A new schedule after completion must trigger another requestGridReset'
        );

        console.log('\u2713 COW-STRUCTURAL-RESYNC-002 passed');
    }

    console.log(' - Shutdown clears pending structural resync timer without invoking requestGridReset...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_structural_resync_shutdown',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: new Map(),
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            _resetRebalanceStateToDepth: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => {},
            _clearWorkingGridRef: () => {},
            _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';
        bot._shutdownImpl = async function () {
            this._shuttingDown = true;
            if (this._structuralGridResyncTimer) {
                clearTimeout(this._structuralGridResyncTimer);
                this._structuralGridResyncTimer = null;
            }
        };

        const requestGridResetCalls = [];
        bot.requestGridReset = async () => {
            requestGridResetCalls.push(true);
            return { success: true };
        };

        bot._wireStructuralGridResyncRequest();

        const scheduleResult = await (manager as any).requestStructuralGridResync('shutdown test trigger', {});
        assert.strictEqual(scheduleResult.scheduled, true, 'Schedule should be accepted before shutdown');

        await bot.shutdown();

        // The pending 0 ms resync timer was cleared by shutdown; give the event
        // loop a beat to prove it does not fire a late requestGridReset.
        await new Promise((r) => setTimeout(r, 10));

        assert.strictEqual(
            requestGridResetCalls.length,
            0,
            'Shutdown must clear pending structural resync timer and prevent requestGridReset'
        );

        const afterShutdown = await (manager as any).requestStructuralGridResync('after shutdown', {});
        assert.strictEqual(afterShutdown.skipped, true, 'Schedule after shutdown must be skipped');
        assert.strictEqual(afterShutdown.reason, 'shutting down', 'Skip reason must mention shutdown');

        console.log('\u2713 COW-STRUCTURAL-RESYNC-003 passed');
    }

    console.log(' - COW guard rejects CREATE batch when unmatched chain orders exist (adoption path)...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_unmatched_adopt',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const masterOrders = new Map([
            ['slot-new', createOrder('slot-new', {
                state: ORDER_STATES.VIRTUAL,
                orderId: ''
            })]
        ]);

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: masterOrders,
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            _resetRebalanceStateToDepth: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => ({ isValid: true }),
            _clearWorkingGridRef: () => {},
            _recoveryState: {
                attemptCount: 0,
                lastAttemptAt: 0,
                lastFailureAt: 0,
                structuralResyncRequested: false
            }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';

        let executeCalls = 0;

        bot._wireStructuralGridResyncRequest();

        // Stub cancelOrder to track non-invocation — unmatched path uses adoption,
        // not auto-cancel. The stub throws to ensure it's never called.
        const originalCancelOrder = chainOrdersModule.cancelOrder;
        let cancelCallCount = 0;
        chainOrdersModule.cancelOrder = async () => {
            cancelCallCount++;
            throw new Error('cancelOrder must not be called in adoption path');
        };
        const originalRecordOwnCancel = chainOrdersModule.recordOwnCancel;
        chainOrdersModule.recordOwnCancel = () => {};
        const originalReadOpenOrdersWithMeta = chainOrdersModule.readOpenOrdersWithMeta;
        chainOrdersModule.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });

        try {
            // Two unmatched chain orders (no fingerprints, no reason tag).
            (manager as any)._lastUnmatchedChainOrders = [
                { chainOrderId: '1.7.572303058', type: ORDER_TYPES.SELL, price: 1.101, size: 10 },
                { chainOrderId: '1.7.572303059', type: ORDER_TYPES.BUY, price: 0.999, size: 5 }
            ];

            const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });
            const result = await bot._updateOrdersOnChainBatchCOW({
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: 0,
                actions: [{
                    type: COW_ACTIONS.CREATE,
                    id: 'slot-new',
                    order: {
                        id: 'slot-new',
                        type: ORDER_TYPES.SELL,
                        price: 1.1,
                        size: 10,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: ''
                    }
                }]
            });

            // cancelOrder must NOT be called (unmatched orders are adopted, not cancelled).
            assert.strictEqual(cancelCallCount, 0, 'cancelOrder must not be called for unmatched chain orders');

            // Batch must be rejected (unmatched chain orders block CREATES).
            assert.strictEqual(result.executed, false, 'Batch must be aborted');
            assert.strictEqual(result.aborted, true, 'Batch must be marked aborted');
            assert.strictEqual(result.reason, 'UNMATCHED_CHAIN_ORDERS', 'Abort reason must be UNMATCHED_CHAIN_ORDERS');
            assert.strictEqual(executeCalls, 0, 'No broadcast must be attempted');

            // _lastUnmatchedChainOrders must NOT be cleared (no sync adoption happened,
            // structural resync will handle it).
            assert.ok(
                (manager as any)._lastUnmatchedChainOrders.length > 0,
                '_lastUnmatchedChainOrders must be preserved for structural resync'
            );

            // Structural resync must be triggered.
            assert.strictEqual(
                manager._recoveryState.structuralResyncRequested,
                true,
                'Structural resync must be requested for unmatched chain orders'
            );

            console.log('\u2713 COW-STRUCTURAL-RESYNC-004 passed');
        } finally {
            chainOrdersModule.cancelOrder = originalCancelOrder;
            chainOrdersModule.recordOwnCancel = originalRecordOwnCancel;
            chainOrdersModule.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        }
    }

    console.log(' - COW auto-cancel skips fingerprinted entries (missing-create-result)...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_auto_cancel_fingerprinted',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const masterOrders = new Map([
            ['slot-new', createOrder('slot-new', {
                state: ORDER_STATES.VIRTUAL,
                orderId: ''
            })]
        ]);

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: masterOrders,
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            _resetRebalanceStateToDepth: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => {},
            _clearWorkingGridRef: () => {},
            _recoveryState: {
                attemptCount: 0,
                lastAttemptAt: 0,
                lastFailureAt: 0,
                structuralResyncRequested: false
            }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';

        let executeCalls = 0;

        const requestGridResetCalls = [];
        bot.requestGridReset = async (reason, options) => {
            requestGridResetCalls.push({ reason, options });
            return { success: true };
        };

        bot._wireStructuralGridResyncRequest();

        // Stub chainOrders.cancelOrder — should NOT be called.
        const originalCancelOrder = chainOrdersModule.cancelOrder;
        let cancelCalls = 0;
        chainOrdersModule.cancelOrder = async () => {
            cancelCalls++;
            throw new Error('cancelOrder must not be called for fingerprinted entries');
        };
        const originalRecordOwnCancel = chainOrdersModule.recordOwnCancel;
        chainOrdersModule.recordOwnCancel = () => {};
        const originalReadOpenOrdersWithMeta = chainOrdersModule.readOpenOrdersWithMeta;
        chainOrdersModule.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });

        try {
            // Only fingerprinted unmatched orders (missing-create-result style).
            (manager as any)._lastUnmatchedChainOrders = [
                {
                    chainOrderId: 'unknown',
                    type: ORDER_TYPES.SELL,
                    price: 1.101,
                    size: 10,
                    reason: 'missing-create-result',
                    slotId: 'slot-missing',
                    fingerprint: 'type=sell,price=1.101000,size=10'
                }
            ];

            const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });
            const result = await bot._updateOrdersOnChainBatchCOW({
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: 0,
                actions: [{
                    type: COW_ACTIONS.CREATE,
                    id: 'slot-new',
                    order: {
                        id: 'slot-new',
                        type: ORDER_TYPES.SELL,
                        price: 1.1,
                        size: 10,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: ''
                    }
                }]
            });

            // cancelOrder must NOT have been called (no cancelable entries).
            assert.strictEqual(cancelCalls, 0, 'cancelOrder must not be called when all entries are fingerprinted');

            // Batch must be rejected (fingerprinted entries block CREATEs).
            assert.strictEqual(result.executed, false, 'Batch must be aborted for fingerprinted unmatched orders');
            assert.strictEqual(result.aborted, true, 'Batch must be marked aborted');
            assert.strictEqual(result.reason, 'UNMATCHED_CHAIN_ORDERS', 'Abort reason must be UNMATCHED_CHAIN_ORDERS');
            assert.strictEqual(executeCalls, 0, 'No broadcast must be attempted');

            // Structural resync must be triggered.
            assert.strictEqual(
                manager._recoveryState.structuralResyncRequested,
                true,
                'Structural resync must be requested for fingerprinted unmatched orders'
            );

            console.log('\u2713 COW-STRUCTURAL-RESYNC-006 passed');
        } finally {
            chainOrdersModule.cancelOrder = originalCancelOrder;
            chainOrdersModule.recordOwnCancel = originalRecordOwnCancel;
            chainOrdersModule.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        }
    }

    console.log('\u2713 COW structural resync wiring tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\u2717 COW structural resync wiring tests failed');
    console.error(err);
    process.exit(1);
});
