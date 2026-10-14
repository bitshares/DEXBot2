process.env.OPEN_ORDERS_SYNC_LOOP_MS = '20';
const assert = require('assert');
const DEXBot = require('../modules/dexbot_class').default;
const { withDynamicWeightFiles } = require('./helpers/dynamic_weight_files');

class MockAsyncLock {
    [key: string]: any;
    constructor() {
        this.locked = false;
    }

    async acquire(fn) {
        this.locked = true;
        try {
            return await fn();
        } finally {
            this.locked = false;
        }
    }

    isLocked() {
        return this.locked;
    }

    getQueueLength() {
        return 0;
    }
}

async function runTests() {
    console.log('Running Main Loop Sync Fill Rebalance Test...');

    const originalLoopMs = process.env.OPEN_ORDERS_SYNC_LOOP_MS;
    const unhandledRejectionHandler = (reason) => {
        const isWsErrorEvent = reason &&
            (
                reason.constructor?.name === 'ErrorEvent' ||
                (reason.type === 'error' && reason.error && typeof reason.error === 'object')
            );

        if (isWsErrorEvent) {
            return;
        }

        console.error('✗ Main loop sync fill rebalance test failed');
        console.error(reason);
        process.exit(1);
    };

    process.on('unhandledRejection', unhandledRejectionHandler);
    const weightFiles = withDynamicWeightFiles('test_main_loop_sync_fill_rebalance');

    try {
        let syncCalls = 0;
        let processCalls = 0;
        let batchCalls = 0;
        let persistCalls = 0;
        const unhandledRejectionListenersBefore = process.listeners('unhandledRejection').length;
        weightFiles.writeSnapshot({
            isReady: true,
            effectiveWeights: { sell: 0.42, buy: 0.22 },
        });

        const bot = new DEXBot({
            botKey: 'test_main_loop_sync_fill_rebalance',
            dryRun: false,
            startPrice: 1,
            assetA: 'XRP',
            assetB: 'BTS',
            incrementPercent: 0.5,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        });

        const syntheticFilledOrder = {
            id: 'slot-174',
            orderId: '1.7.999999',
            type: 'sell',
            state: 'partial',
            size: 0.0001,
            price: 1357.58,
            isPartial: false
        };

        bot.accountId = '1.2.999';
        bot.manager = {
            _fillProcessingLock: new MockAsyncLock(),
            logger: { log: () => {} },
            pauseFundRecalc() {},
            resumeFundRecalc() {},
            synchronizeWithChain: async () => {
                syncCalls++;
                if (syncCalls === 1) {
                    return { filledOrders: [syntheticFilledOrder] };
                }
                return { filledOrders: [] };
            },
            processFilledOrders: async (filledOrders) => {
                processCalls++;
                assert.strictEqual(filledOrders.length, 1, 'Expected one sync-detected filled order');
                assert.strictEqual(filledOrders[0].orderId, '1.7.999999', 'Expected detected order to flow into strategy');
                return {
                    actions: [{ type: 'create', id: 'slot-174', order: { id: 'slot-174', type: 'buy', size: 1, price: 100 } }],
                    ordersToPlace: [],
                    ordersToRotate: [],
                    ordersToUpdate: [],
                    ordersToCancel: [],
                    stateUpdates: [],
                    hadRotation: false
                };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        };

        bot._runGridMaintenance = async () => {};

        bot.updateOrdersOnChainBatch = async () => {
            batchCalls++;
            return { executed: false, hadRotation: false };
        };

        // Compiled ESM exports cannot be patched; the bot-level hook feeds
        // the sync loop a clean (non-truncated) open-orders window.
        bot._readOpenOrdersHook = async () => [];

        bot._startOpenOrdersSyncLoop();
        assert.strictEqual(
            process.listeners('unhandledRejection').length,
            unhandledRejectionListenersBefore,
            'Open-orders sync loop must not install global unhandledRejection handlers'
        );
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert(syncCalls >= 1, 'Main loop should run synchronizeWithChain at least once');
        assert.strictEqual(processCalls, 1, 'Main loop should process sync-detected fills');
        assert.strictEqual(batchCalls, 1, 'Main loop should execute rebalance batch pipeline');
        assert.strictEqual(persistCalls, 1, 'Main loop should persist grid after rebalance pipeline');

        console.log('✓ Main loop processes sync-detected fills through rebalance pipeline');

        // Phase 2: a TRUNCATED read must defer the sync (pass-1 phantom
        // cleanup on a partial window would virtualize live slots) while the
        // loop keeps ticking for a clean read.
        syncCalls = 0;
        processCalls = 0;
        batchCalls = 0;
        persistCalls = 0;
        // Hook returns null — the same defer signal the truncated-read guard
        // produces — so the sync must never reach synchronizeWithChain.
        bot._readOpenOrdersHook = async () => null;
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.strictEqual(syncCalls, 0, 'Truncated reads must never reach synchronizeWithChain');
        assert.strictEqual(processCalls, 0, 'Truncated reads must not trigger fill processing');
        console.log('✓ Main loop defers synchronizeWithChain on truncated reads');

        await bot._stopOpenOrdersSyncLoop();
        assert.strictEqual(
            process.listeners('unhandledRejection').length,
            unhandledRejectionListenersBefore,
            'Open-orders sync loop shutdown must leave global unhandledRejection handlers unchanged'
        );
    } finally {
        weightFiles.cleanup();
        process.off('unhandledRejection', unhandledRejectionHandler);
        if (originalLoopMs === undefined) {
            delete process.env.OPEN_ORDERS_SYNC_LOOP_MS;
        } else {
            process.env.OPEN_ORDERS_SYNC_LOOP_MS = originalLoopMs;
        }
    }
}

runTests()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('✗ Main loop sync fill rebalance test failed');
        console.error(err);
        process.exit(1);
    });
