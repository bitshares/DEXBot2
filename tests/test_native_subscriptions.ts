/**
 * tests/test_native_subscriptions.js - Native subscription regression tests.
 */

const assert = require('assert');
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');

console.log('=== Native Subscription Tests ===\n');

function makeAccountRecord(account) {
    const name = account === '1.2.200' ? 'bob' : account === '1.2.100' ? 'alice' : account;
    return [account, {
        account: {
            id: name === 'bob' ? '1.2.200' : '1.2.100',
            name,
            statistics: name === 'bob' ? '2.6.200' : '2.6.100',
        },
    }];
}

(async () => {
    console.log(' - Testing delivered fill shape matches downstream expectations...');
    {
        let noticeHandler = null;
        const dbCalls = [];
        const historyCalls = [];
        const delivered = [];

        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account], subscribe) => {
                    dbCalls.push(['get_full_accounts', account, subscribe]);
                    return [makeAccountRecord(account)];
                },
                call: async (method, args) => {
                    dbCalls.push([method, args]);
                    assert.strictEqual(method, 'set_subscribe_callback');
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async (accountId, opType, start, stop, limit) => {
                    historyCalls.push([accountId, opType, start, stop, limit]);
                    if (accountId !== '1.2.100') return [];
                    if (limit === 1) {
                        // Prime reports the same head the direct-fill notice below
                        // carries (501), so the decremented cursor is 500 and the
                        // notice advance 500 -> 501 is contiguous (gap 1): no eager
                        // gap-recovery lookback is armed. A gap > 1 WOULD arm one
                        // by design — see test_fill_gap_recovery for that path.
                        return [{ id: '1.11.501', block_num: 10, trx_in_block: 1, op: [4, { order_id: '1.7.1' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', (fills) => {
            delivered.push(['alice', fills]);
        });
        await manager.subscribe('bob', () => {
            throw new Error('bob should not receive alice notices');
        });

        assert.strictEqual(typeof noticeHandler, 'function', 'notice handler should be registered');

        // Notice with direct fill object should be dispatched immediately to matching account.
        // Gap is contiguous here (cursor 500 -> fill 501): no eager lookback scan
        // is armed, so no extra alice history call lands after the assertion point.
        // (A gap > 1 WOULD arm a lookback scan by design — see test_fill_gap_recovery
        // for that path. With coalesce=0 in this test the eager scan would run
        // detached; asserting zero extra scans here pins the contiguous-fill fast path.)
        await noticeHandler([1, [{ id: '1.11.501', block_num: 12, trx_in_block: 3, op: [4, { order_id: '1.7.3', account_id: '1.2.100' }] }]]);

        assert.strictEqual(delivered.length, 1, 'matching account should receive direct notice delivery');
        assert.strictEqual(delivered[0][0], 'alice');
        assert.strictEqual(delivered[0][1].length, 1);
        assert.strictEqual(delivered[0][1][0].id, '1.11.501');
        assert.strictEqual(delivered[0][1][0].block_num, 12, 'fill payload should expose block_num');
        assert.strictEqual(delivered[0][1][0].trx_in_block, 3, 'fill payload should expose trx_in_block');
        assert.strictEqual(delivered[0][1][0].block, undefined, 'legacy block alias should not leak through');
        assert.strictEqual(delivered[0][1][0].trx, undefined, 'legacy trx alias should not leak through');
        const aliceHistoryCalls = historyCalls.filter(([account]) => account === '1.2.100');
        const bobHistoryCalls = historyCalls.filter(([account]) => account === '1.2.200');
        assert.deepStrictEqual(
            aliceHistoryCalls[0],
            ['1.2.100', 4, '1.11.0', '1.11.0', 1],
            'subscription bootstrap should prime from the latest delivered fill id'
        );
        assert.strictEqual(aliceHistoryCalls.length, 1, 'direct fill notice should not add an alice history scan');
        assert.strictEqual(bobHistoryCalls.length, 1, 'bob should only prime history in this direct-fill test');
        assert.ok(dbCalls.some(([method]) => method === 'set_subscribe_callback'), 'subscription RPC should be registered');
        assert.strictEqual(
            dbCalls.some(([method, account, subscribe]) => method === 'get_full_accounts' && account === 'alice' && subscribe === true),
            true,
            'subscription setup should subscribe the account on-chain'
        );
    }

    console.log(' - Testing first subscribe wires local callback and notice handler before remote activation...');
    {
        let noticeHandler = null;
        let callbackCountDuringRegister = -1;
        let noticeHandlerPresentDuringRegister = false;
        let manager = null;
        const delivered = [];

        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async (method) => {
                    assert.strictEqual(method, 'set_subscribe_callback');
                    const entry = manager.getSubscriptions().get('alice');
                    callbackCountDuringRegister = entry?.callbacks?.size ?? -1;
                    noticeHandlerPresentDuringRegister = typeof noticeHandler === 'function';
                    await noticeHandler([1, [{ id: '2.5.511', owner: '1.2.100' }]]);
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.510', block_num: 10, trx_in_block: 1, op: [4, { order_id: '1.7.510' }] }];
                    }
                    if (stop === '1.11.509') {
                        return [{ id: '1.11.511', block_num: 11, trx_in_block: 2, op: [4, { order_id: '1.7.511' }] }];
                    }
                    return [];
                },
            },
        };

        manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });
        // With noticeCoalesceMs: 0 the activation-window scan runs
        // synchronously inside subscribe(); a microtask drain suffices.
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(callbackCountDuringRegister, 1, 'initial subscribe should attach the local callback before remote activation');
        assert.strictEqual(noticeHandlerPresentDuringRegister, true, 'initial subscribe should install the local notice handler before remote activation');
        assert.strictEqual(delivered.length, 1, 'initial subscribe should catch up fills from the activation window');
        assert.strictEqual(delivered[0][0].id, '1.11.511', 'bounded catch-up should deliver fills newer than the overlap cursor');
    }

    console.log(' - Testing reconnect reattaches notice handler after transport cleanup...');
    {
        let handlers = [];
        const delivered = [];
        const dbCalls = [];
        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    handlers.push(handler);
                    const unsubscribe = () => {
                        const idx = handlers.indexOf(handler);
                        if (idx !== -1) handlers.splice(idx, 1);
                    };
                    unsubscribe.isActive = () => handlers.includes(handler);
                    return unsubscribe;
                },
                dropHandlersForReconnect() {
                    handlers = [];
                },
            },
            db: {
                get_full_accounts: async ([account], subscribe) => {
                    dbCalls.push(['get_full_accounts', account, subscribe]);
                    return [makeAccountRecord(account)];
                },
                call: async (method, args) => {
                    dbCalls.push([method, args]);
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.900', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (stop === '1.11.899') {
                        return [{ id: '1.11.900', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (stop === '1.11.900') {
                        return [{ id: '1.11.901', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.901' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });
        delivered.length = 0;

        assert.strictEqual(handlers.length, 1, 'initial subscription should register one notice handler');

        chainClient.transport.dropHandlersForReconnect();
        assert.strictEqual(handlers.length, 0, 'transport cleanup should detach the old notice handler');

        await manager.resubscribeAll();

        assert.strictEqual(handlers.length, 1, 'resubscribe should reattach a live notice handler after reconnect cleanup');
        assert.strictEqual(delivered.length, 1, 'resubscribe should catch up fills missed during the reconnect gap');
        assert.strictEqual(delivered[0][0].id, '1.11.900');

        await handlers[0]([1, [{ id: '2.5.4000', owner: '1.2.100' }]]);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(delivered.length, 2, 'reattached object-change notice should scan and deliver newer fills');
        assert.strictEqual(delivered[1][0].id, '1.11.901');
        assert.ok(
            dbCalls.filter(([method]) => method === 'set_subscribe_callback').length >= 2,
            'subscription callback should be registered again during reconnect'
        );
    }

    console.log(' - Testing account/statistics notices stay account-scoped...');
    {
        let noticeHandler = null;
        const historyAccounts = [];
        const accountNoticeDelivered = [];
        let subscriptionComplete = false;

        const accountNoticeClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, _opType, _start, stop, limit) => {
                    historyAccounts.push(accountId);
                    if (accountId !== '1.2.100') return [];
                    if (limit === 1) {
                        return [{ id: '1.11.650', block_num: 9, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (subscriptionComplete && stop === '1.11.649') {
                        return [{ id: '1.11.700', block_num: 12, trx_in_block: 3, op: [4, { order_id: '1.7.3' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(accountNoticeClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', (fills) => {
            accountNoticeDelivered.push(fills);
        });
        await manager.subscribe('bob', () => {});
        subscriptionComplete = true;
        accountNoticeDelivered.length = 0;
        historyAccounts.length = 0;

        // Non-fill notice (statistics object) triggers a history scan because BitShares Core
        // may notify impacted accounts with changed object IDs rather than full 1.11.x fill objects.
        // The scan finds the fill at 1.11.700 from the mock.
        await noticeHandler([1, [{ id: '2.6.100' }]]);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(accountNoticeDelivered.length, 1, 'object-change notice should trigger history scan and deliver fill');
        assert.strictEqual(accountNoticeDelivered[0][0].id, '1.11.700', 'history scan should deliver fill 1.11.700');

        // Fill object in notice should also be dispatched directly to matching account
        // (handleNotice does not deduplicate against cursor — the downstream bot's fill
        // deduplication layer handles that).
        await noticeHandler([1, [{ id: '1.11.701', block_num: 13, trx_in_block: 3, op: [4, { order_id: '1.7.3', account_id: '1.2.100' }] }]]);
        assert.strictEqual(accountNoticeDelivered.length, 2, 'direct fill notice should add a second delivery');
        assert.strictEqual(accountNoticeDelivered[1][0].id, '1.11.701', 'direct notice should deliver fill 1.11.701');

        // Bob's callback should not fire for alice's fill.
        accountNoticeDelivered.length = 0;
        await noticeHandler([1, [{ id: '1.11.702', block_num: 14, trx_in_block: 4, op: [4, { order_id: '1.7.4', account_id: '1.2.200' }] }]]);
        assert.strictEqual(accountNoticeDelivered.length, 0, 'bob fill should not deliver to alice callback');
    }

    console.log(' - Testing multiple fill objects in a single notice are dispatched together...');
    {
        let noticeHandler = null;
        const delivered = [];
        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.900', block_num: 900, trx_in_block: 900, op: [4, { order_id: '1.7.900' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });

        // Send multiple fill objects in a single WebSocket notice.
        await noticeHandler([1, [
            { id: '1.11.901', block_num: 901, trx_in_block: 901, op: [4, { order_id: '1.7.901', account_id: '1.2.100' }] },
            { id: '1.11.902', block_num: 902, trx_in_block: 902, op: [4, { order_id: '1.7.902', account_id: '1.2.100' }] },
            { id: '1.11.903', block_num: 903, trx_in_block: 903, op: [4, { order_id: '1.7.903', account_id: '1.2.100' }] },
        ]]);

        assert.strictEqual(delivered.length, 1, 'fills in a single notice should batch into one delivery');
        assert.strictEqual(delivered[0].length, 3, 'all three fills should be in the same batch');
        assert.strictEqual(delivered[0][0].id, '1.11.901', 'first fill should match');
        assert.strictEqual(delivered[0][1].id, '1.11.902', 'second fill should match');
        assert.strictEqual(delivered[0][2].id, '1.11.903', 'third fill should match');
    }

    console.log(' - Testing direct fill notice with full account_id dispatches correctly...');
    {
        let noticeHandler = null;
        const delivered = [];
        let subscriptionComplete = false;
        const originalWarn = console.warn;
        console.warn = (...args) => {};

        try {
            const chainClient = {
                transport: {
                    addMessageHandler(handler) {
                        noticeHandler = handler;
                        return () => { noticeHandler = null; };
                    },
                },
                db: {
                    get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                        if (limit === 1) {
                            return [{ id: '1.11.800', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });

            // Direct fill notice — no get_full_accounts call, no history scan.
            await noticeHandler([1, [{ id: '1.11.801', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.801', account_id: '1.2.100' }] }]]);
            assert.strictEqual(delivered.length, 1, 'direct fill notice should deliver');
            assert.strictEqual(delivered[0][0].id, '1.11.801');
            assert.strictEqual(delivered[0][0].op[1].account_id, '1.2.100', 'fill should have matching account_id');
        } finally {
            console.warn = originalWarn;
        }
    }

    console.log(' - Testing callback failures retry the same fill until success...');
    {
        let noticeHandler = null;
        let failedOnce = false;
        let retryDeliveries = 0;
        let callbackErrors = 0;
        const retryChainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, _stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.600', block_num: 11, trx_in_block: 2, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(retryChainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', () => {
            retryDeliveries += 1;
            if (!failedOnce) {
                failedOnce = true;
                throw new Error('transient callback failure');
            }
        });
        failedOnce = false;
        retryDeliveries = 0;

        // First fill notice: callback throws (logged, not retried — btsdex parity)
        await noticeHandler([1, [{ id: '1.11.601', block_num: 12, trx_in_block: 3, op: [4, { order_id: '1.7.2', account_id: '1.2.100' }] }]]);
        // Second fill notice: callback succeeds
        await noticeHandler([1, [{ id: '1.11.602', block_num: 13, trx_in_block: 4, op: [4, { order_id: '1.7.3', account_id: '1.2.100' }] }]]);

        assert.strictEqual(retryDeliveries, 2, 'first callback fails (logged), second succeeds');
    }

    console.log(' - Testing reconnect catch-up scans back to the last delivered cursor...');
    {
        let reconnectHistoryPages = 0;
        let subscriptionComplete = false;
        const delivered = [];
        const chainClient = {
            transport: {
                addMessageHandler() {
                    return () => {};
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.900', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (!subscriptionComplete) return [];
                    reconnectHistoryPages += 1;
                    const startInstance = Number(String(start).split('.').pop());
                    const newest = startInstance === 0 ? 2000 : startInstance;
                    const stopInstance = Number(String(stop).split('.').pop());
                    return Array.from({ length: limit }, (_, idx) => ({
                        id: `1.11.${newest - idx}`,
                        block_num: newest - idx,
                        trx_in_block: idx,
                        op: [4, { order_id: `1.7.${newest - idx}` }],
                    })).filter(entry => Number(String(entry.id).split('.').pop()) > stopInstance);
                },
            },
        };

        const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', (fills) => {
            delivered.push(fills);
        });
        subscriptionComplete = true;
        delivered.length = 0;

        await manager.resubscribeAll();

        assert.strictEqual(reconnectHistoryPages, 23, 'reconnect catch-up should keep scanning until the previous cursor is reached (1101 entries / 50 per page = 22 full + 1 short)');
        assert.strictEqual(delivered.length, 1, 'reconnect catch-up should deliver recovered fills once');
        assert.strictEqual(delivered[0].length, 1101, 'all missed fills newer than the previous cursor should be delivered');
        assert.strictEqual(delivered[0][0].id, '1.11.900', 'oldest missed fill should be preserved');
        assert.strictEqual(delivered[0][1100].id, '1.11.2000', 'newest missed fill should be preserved');
    }

    console.log(' - Testing async callback failures keep reconnect cursor retryable...');
    {
        let subscriptionComplete = false;
        let failOnce = false;
        let deliveries = 0;
        let callbackErrors = 0;
        const historyStops = [];
        const chainClient = {
            transport: {
                addMessageHandler() {
                    return () => {};
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.300', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    if (!subscriptionComplete) return [];
                    historyStops.push(stop);
                    if (stop === '1.11.299') {
                        return [{ id: '1.11.301', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.async-retry' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', async () => {
            deliveries += 1;
            if (failOnce) {
                failOnce = false;
                throw new Error('async delivery failed');
            }
        }, () => {
            callbackErrors += 1;
        });
        subscriptionComplete = true;
        failOnce = true;
        deliveries = 0;
        callbackErrors = 0;

        await manager.resubscribeAll();
        await manager.resubscribeAll();

        assert.strictEqual(callbackErrors, 1, 'async callback failure should be reported once');
        assert.strictEqual(deliveries, 2, 'async callback failure should redeliver the same fill on retry');
        assert.deepStrictEqual(
            historyStops,
            ['1.11.299', '1.11.299'],
            'cursor must not advance after failed async callback delivery'
        );
    }

    console.log(' - Testing failed reconnect catch-up schedules an automatic retry...');
    {
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        const retryDelays = [];
        let retryCallback = null;
        const liveTimers = new Set<any>();
        (global as any).setTimeout = (fn: any, delay: any) => {
            const handle = { retryTimer: true, delay };
            liveTimers.add(handle);
            retryDelays.push(delay);
            retryCallback = fn;
            return handle;
        };
        global.clearTimeout = (handle: any) => {
            if (handle) {
                liveTimers.delete(handle);
                const idx = retryDelays.lastIndexOf(handle.delay);
                if (idx !== -1) retryDelays.splice(idx, 1);
            }
        };

        try {
            let subscriptionComplete = false;
            let failReconnectDelivery = false;
            let deliveredCount = 0;
            let callbackErrors = 0;
            const chainClient = {
                transport: {
                    addMessageHandler() {
                        return () => {};
                    },
                },
                db: {
                    get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                        if (limit === 1) {
                            return [{ id: '1.11.700', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        if (!subscriptionComplete) return [];
                        if (stop === '1.11.699') {
                            return [{ id: '1.11.701', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.retry' }] }];
                        }
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
            await manager.subscribe('alice', () => {
                deliveredCount += 1;
                if (failReconnectDelivery) {
                    failReconnectDelivery = false;
                    throw new Error('transient reconnect delivery failure');
                }
            }, () => {
                callbackErrors += 1;
            });
            subscriptionComplete = true;
            failReconnectDelivery = true;
            deliveredCount = 0;
            callbackErrors = 0;

            await manager.resubscribeAll();
            assert.strictEqual(callbackErrors, 1, 'failed reconnect delivery should report callback error');
            assert.strictEqual(retryDelays.length, 1, 'failed reconnect catch-up should schedule one retry');
            assert.strictEqual(typeof retryCallback, 'function', 'retry callback should be scheduled');

            retryCallback();
            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(deliveredCount, 2, 'retry should redeliver the unacknowledged reconnect fill');
        } finally {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    }

    console.log(' - Testing live notice callback failure is logged without retry...');
    {
        let noticeHandler = null;
        let deliveries = 0;
        let failOnce = false;
        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.400', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        await manager.subscribe('alice', async (fills) => {
            deliveries += fills.length;
            if (failOnce) {
                failOnce = false;
                throw new Error('transient callback error');
            }
        });
        failOnce = true;
        deliveries = 0;

        // A failing callback increments deliveries (before throw) but doesn't block future deliveries
        await noticeHandler([1, [{ id: '1.11.401', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.live-fail', account_id: '1.2.100' }] }]]);
        assert.strictEqual(deliveries, 1, 'failing callback increments before throw');

        // Next fill notice dispatches normally
        await noticeHandler([1, [{ id: '1.11.402', block_num: 3, trx_in_block: 3, op: [4, { order_id: '1.7.live-ok', account_id: '1.2.100' }] }]]);
        assert.strictEqual(deliveries, 2, 'next fill should dispatch normally after previous failure');
    }

    console.log(' - Testing reconnect missing account data remains retryable...');
    {
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        const retryDelays = [];
        let retryCallback = null;
        const liveTimers = new Set<any>();
        (global as any).setTimeout = (fn: any, delay: any) => {
            const handle = { retryTimer: true, delay };
            liveTimers.add(handle);
            retryDelays.push(delay);
            retryCallback = fn;
            return handle;
        };
        global.clearTimeout = (handle: any) => {
            if (handle) {
                liveTimers.delete(handle);
                const idx = retryDelays.lastIndexOf(handle.delay);
                if (idx !== -1) retryDelays.splice(idx, 1);
            }
        };

        try {
            let subscriptionComplete = false;
            let reconnectAttempts = 0;
            const delivered = [];
            const chainClient = {
                transport: {
                    addMessageHandler() {
                        return () => {};
                    },
                },
                db: {
                    get_full_accounts: async ([account], subscribe) => {
                        if (subscribe || !subscriptionComplete) return [makeAccountRecord(account)];
                        reconnectAttempts += 1;
                        if (reconnectAttempts <= 2) return [];
                        return [makeAccountRecord(account)];
                    },
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                        if (limit === 1) {
                            return [{ id: '1.11.500', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        if (!subscriptionComplete) return [];
                        if (stop === '1.11.499') {
                            return [{ id: '1.11.501', block_num: 2, trx_in_block: 2, op: [4, { order_id: '1.7.account-retry' }] }];
                        }
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            subscriptionComplete = true;

            await manager.resubscribeAll();

            // get_full_accounts is skipped when accountId is already known (set during
            // subscribe or the resubscribeAll preamble), so the history scan proceeds
            // without needing redundant account data verification.
            assert.strictEqual(delivered.length, 1, 'catch-up should succeed without re-fetching account data');
            assert.strictEqual(delivered[0][0].id, '1.11.501', 'history fill ID should match');
        } finally {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    }

    console.log(' - Testing no-fill notice coalesce: back-to-back notices within NOTICE_COALESCE_MS trigger one history scan...');
    {
        // The coalesce window is fixed at construction time from NATIVE_CLIENT.SUBSCRIPTIONS.NOTICE_COALESCE_MS.
        // We override global.setTimeout to capture the coalesce timers without actually firing them,
        // then manually fire one and assert that a single history scan was scheduled.
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        const coalesceTimers = [];
        let noticeHandler = null;
        let subscriptionComplete = false;
        const historyCalls = [];
        const delivered = [];

        global.setTimeout = ((fn, delay) => {
            coalesceTimers.push({ fn, delay });
            return { coalesceTimer: true };
        }) as any;
        global.clearTimeout = (() => {}) as any;

        try {
            const chainClient = {
                transport: {
                    addMessageHandler(handler) {
                        noticeHandler = handler;
                        return () => { noticeHandler = null; };
                    },
                },
                db: {
                    get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async (accountId, _opType, _start, stop, limit) => {
                        historyCalls.push([accountId, stop, limit]);
                        if (accountId !== '1.2.100') return [];
                        if (limit === 1) {
                            return [{ id: '1.11.200', block_num: 2, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                        }
                        if (subscriptionComplete) {
                            // The cursor is at 1.11.200 at subscription time and the
                            // fill at 1.11.201 is always returned in the head page so
                            // the test does not need to track cursor advancement.
                            return [{ id: '1.11.201', block_num: 3, trx_in_block: 2, op: [4, { order_id: '1.7.coalesce' }] }];
                        }
                        return [];
                    },
                },
            };

            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', (fills) => {
                delivered.push(fills);
            });
            subscriptionComplete = true;
            delivered.length = 0;
            historyCalls.length = 0;
            coalesceTimers.length = 0;

            // First no-fill notice within the coalesce window. The per-sub cursor is at
            // 1.11.200, but the notice carries no 1.11.x id, so noticeMaxInstance stays
            // at -1 and the cursor check falls through. The first notice schedules
            // the coalesced scan but does not run a synchronous history scan.
            await noticeHandler([1, [{ id: '2.5.5000', owner: '1.2.100' }]]);
            const scansAfterFirst = historyCalls.filter(([, , limit]) => limit !== 1).length;
            assert.strictEqual(scansAfterFirst, 0, 'first no-fill notice should not trigger an immediate history scan');
            assert.strictEqual(coalesceTimers.length, 1, 'first no-fill notice should schedule one coalesce timer');

            // Second no-fill notice within the coalesce window should NOT trigger a new
            // scan. The existing pending scan timer is updated with the new lastNoticeAt.
            await noticeHandler([1, [{ id: '2.6.100' }]]);
            const scansAfterSecond = historyCalls.filter(([, , limit]) => limit !== 1).length;
            assert.strictEqual(scansAfterSecond, 0, 'second no-fill notice within window should not trigger an immediate scan');
            assert.strictEqual(coalesceTimers.length, 1, 'coalesce timer should be reused, not duplicated');

            // Fire the scheduled scan. This should be the only history scan for the
            // two notices above.
            coalesceTimers[0].fn();
            await new Promise(resolve => originalSetTimeout(resolve, 10));
            const scansAfterTimer = historyCalls.filter(([, , limit]) => limit !== 1).length;
            assert.strictEqual(scansAfterTimer, 1, 'coalesced timer should trigger exactly one history scan');
            assert.strictEqual(delivered.length, 1, 'coalesced scan should deliver the fill');
            assert.strictEqual(delivered[0][0].id, '1.11.201', 'coalesced scan should deliver 1.11.201');

            historyCalls.length = 0;
            coalesceTimers.length = 0;

            await noticeHandler([1, [{ id: '2.5.5001', owner: '1.2.100' }]]);
            const scansAfterThird = historyCalls.filter(([, , limit]) => limit !== 1).length;
            assert.strictEqual(scansAfterThird, 0, 'a fresh no-fill notice should schedule, not immediately run, a new scan');
            assert.strictEqual(coalesceTimers.length, 1, 'fresh no-fill notice should schedule a new coalesce timer');
        } finally {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    }

    console.log(' - Testing resubscribeAll clears coalesced pending scans from the pre-reconnect era...');
    {
        // Verifies fix #1: pendingScans cleared on resubscribeAll so a deferred
        // timer from before the reconnect cannot race the catch-up scan.
        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        let noticeHandler = null;
        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async (_accountId, _opType, _start, stop, limit) => {
                    if (limit === 1) {
                        return [{ id: '1.11.5000', block_num: 1, trx_in_block: 1, op: [4, { order_id: '1.7.bootstrap' }] }];
                    }
                    return [];
                },
            },
        };

        // Capture the coalesce timer handle so we can assert it gets cleared.
        let capturedTimer: any = null;
        global.setTimeout = ((fn, delay) => {
            const handle = { fn, delay, cleared: false };
            capturedTimer = handle;
            return handle as any;
        }) as any;
        global.clearTimeout = ((handle: any) => {
            if (handle && typeof handle === 'object') handle.cleared = true;
        }) as any;

        try {
            // Production coalesce path (no override): with NOTICE_COALESCE_MS
            // at 250ms the no-fill notice schedules a real timer. This test
            // pins that behavior, so it must NOT pass noticeCoalesceMs: 0
            // (that seam collapses the window and scans synchronously).
            const manager = createSubscriptionManager(chainClient);
            await manager.subscribe('alice', () => {});
            capturedTimer = null;

            // Schedule a coalesce timer via a no-fill notice.
            await noticeHandler([1, [{ id: '2.5.9999', owner: '1.2.100' }]]);
            assert.ok(capturedTimer, 'no-fill notice should schedule a coalesce timer');
            assert.strictEqual(capturedTimer.cleared, false, 'timer should not be cleared before reconnect');

            // resubscribeAll should clear the pending timer.
            await manager.resubscribeAll();
            assert.strictEqual(capturedTimer.cleared, true, 'resubscribeAll should clear pending coalesce timer');
        } finally {
            global.setTimeout = originalSetTimeout;
            global.clearTimeout = originalClearTimeout;
        }
    }

    // ── lastNoticeAt state tracking ───────────────────────────────────
    {
        console.log('\n - Testing lastNoticeAt state tracking...');
        let noticeHandler = null;
        const dbCalls = [];
        const historyCalls = [];

        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => {
                    dbCalls.push(['get_full_accounts', account]);
                    return [makeAccountRecord(account)];
                },
                call: async (method, args) => {
                    dbCalls.push([method, args]);
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async () => [],
                get_account_history: async () => [],
            },
        };

        const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
        const unsub = await manager.subscribe('alice', () => {});

        const subs = manager.getSubscriptions();
        const aliceSub = subs.get('alice');
        assert.ok(aliceSub, 'alice subscription should exist');
        assert.strictEqual(aliceSub.reconnecting, false, 'reconnecting should be false initially');
        assert.ok(aliceSub.lastNoticeAt > 0, 'lastNoticeAt should be initialized');

        // Fill notice should advance lastNoticeAt for the matching account
        const beforeFill = aliceSub.lastNoticeAt;
        await noticeHandler([1, [{ id: '1.11.600', block_num: 13, trx_in_block: 1, op: [4, { order_id: '1.7.4', account_id: '1.2.100' }] }]]);
        assert.ok(aliceSub.lastNoticeAt >= beforeFill, 'lastNoticeAt should advance on matching fill notice');

        // Non-fill notice should advance lastNoticeAt for eligible subs
        const beforeNonFill = aliceSub.lastNoticeAt;
        await noticeHandler([1, [{ id: '2.6.100', owner: '1.2.100' }]]);
        assert.ok(aliceSub.lastNoticeAt >= beforeNonFill, 'lastNoticeAt should advance on non-fill notice');

        // Fill notice for a DIFFERENT account should NOT advance alice's lastNoticeAt
        const beforeOtherFill = aliceSub.lastNoticeAt;
        await noticeHandler([1, [{ id: '1.11.601', block_num: 14, trx_in_block: 1, op: [4, { order_id: '1.7.5', account_id: '1.2.200' }] }]]);
        assert.strictEqual(aliceSub.lastNoticeAt, beforeOtherFill, 'lastNoticeAt should NOT advance on other-account fill');

        // Clean up
        unsub();
        console.log('   lastNoticeAt tests passed');
    }

    // ── Fill polling regression test ─────────────────────────────────
    {
        console.log('\n - Testing fill polling invokes processObjects per active subscription...');
        const NATIVE_CLIENT = require('../modules/constants').NATIVE_CLIENT;
        const FILL_POLL_INTERVAL_MS = NATIVE_CLIENT.SUBSCRIPTIONS.FILL_POLL_INTERVAL_MS;

        const originalSetInterval = global.setInterval;
        const originalClearInterval = global.clearInterval;

        let noticeHandler = null;
        let pollTimerHandle: any = null;
        const getAccountHistoryCalls: any[][] = [];
        const dbCalls: any[][] = [];

        const chainClient = {
            transport: {
                addMessageHandler(handler) {
                    noticeHandler = handler;
                    return () => { noticeHandler = null; };
                },
            },
            db: {
                get_full_accounts: async ([account]) => {
                    dbCalls.push(['get_full_accounts', account]);
                    return [makeAccountRecord(account)];
                },
                call: async (method, args) => {
                    dbCalls.push([method, args]);
                    return null;
                },
            },
            history: {
                getAccountHistoryOperations: async () => [],
                get_account_history: async (...args: any[]) => {
                    getAccountHistoryCalls.push(args);
                    return [];
                },
            },
        };

        try {
            global.setInterval = ((fn: any, interval: number) => {
                pollTimerHandle = { fn, interval };
                return pollTimerHandle as any;
            }) as any;
            global.clearInterval = ((_handle: any) => {}) as any;

            const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0 });
            const unsub = await manager.subscribe('alice', () => {});

            assert.ok(pollTimerHandle, 'fill poll timer should be created on first subscribe');
            assert.strictEqual(pollTimerHandle.interval, FILL_POLL_INTERVAL_MS,
                `poll interval should be ${FILL_POLL_INTERVAL_MS}ms`);

            // Run the poll callback — should trigger processObjects for the active sub.
            await pollTimerHandle.fn();

            assert.ok(getAccountHistoryCalls.length > 0,
                'processObjects should call get_account_history during fill poll');

            // Verify it was for alice's account
            const aliceSub = manager.getSubscriptions().get('alice');
            assert.ok(aliceSub, 'alice subscription should still exist');
            assert.ok(aliceSub.lastNoticeAt > 0, 'lastNoticeAt should be stamped by processObjects');

            // Clean up
            unsub();
        } finally {
            global.setInterval = originalSetInterval;
            global.clearInterval = originalClearInterval;
        }

        console.log('   fill polling test passed');
    }

    // ── Fill-channel watchdog regression tests ─────────────────────────

    const NATIVE_CLIENT_WD = require('../modules/constants').NATIVE_CLIENT;
    const WD_THRESHOLD = Number(NATIVE_CLIENT_WD.SUBSCRIPTIONS.CHANNEL_DEGRADED_FAILURE_THRESHOLD) || 3;
    const WD_ALERT_AFTER = Number(NATIVE_CLIENT_WD.SUBSCRIPTIONS.CHANNEL_RECOVERY_ALERT_AFTER) || 3;

    const staleApiError = () => new Error('Execution error: Assert Exception: _local_apis.size() > api_id: ');

    /** Build a subscription manager whose history channel always fails. */
    const makeFailingManager = (overrides: any) => {
        const forceReconnectCalls: string[] = [];
        const chainClient: any = {
            transport: { addMessageHandler() { return () => {}; } },
            // Stands in for chain_client.forceReconnect, which now owns the
            // shared cooldown and reports whether it actually issued one.
            forceReconnect: (reason: string) => { forceReconnectCalls.push(reason); return true; },
            db: {
                get_full_accounts: async ([account]: any) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                getAccountHistoryOperations: async () => { throw staleApiError(); },
                get_account_history: async () => { throw staleApiError(); },
            },
        };
        return { chainClient, forceReconnectCalls };
    };

    const withFakePollTimer = async <T>(fn: (poll: () => Promise<void>) => Promise<T>): Promise<T> => {
        const originalSetInterval = global.setInterval;
        const originalClearInterval = global.clearInterval;
        let pollTimerHandle: any = null;
        global.setInterval = ((handler: any) => {
            pollTimerHandle = { fn: handler };
            return pollTimerHandle as any;
        }) as any;
        global.clearInterval = ((_h: any) => {}) as any;
        try {
            return await fn(async () => { await pollTimerHandle.fn(); });
        } finally {
            global.setInterval = originalSetInterval;
            global.clearInterval = originalClearInterval;
        }
    };

    // The logger routes by level: info/debug -> console.log, warn -> console.warn,
    // error -> console.error. All three must be captured.
    const captureLogs = async (fn: () => Promise<void>): Promise<string[]> => {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        const lines: string[] = [];
        const collect = (...args: any[]) => { lines.push(args.join(' ')); };
        console.log = collect;
        console.warn = collect;
        console.error = collect;
        try { await fn(); } finally {
            console.log = originalLog;
            console.warn = originalWarn;
            console.error = originalError;
        }
        return lines;
    };

    // The watchdog must keep escalating while a channel stays dead. The old code
    // latched on _channelDegraded, so a forced reconnect that failed to clear the
    // channel left the account silently degraded forever — the exact "missed
    // fills for hours" failure the watchdog exists to prevent.
    {
        console.log('\n - Testing fill-channel watchdog re-arms while the channel stays dead...');
        await withFakePollTimer(async (poll) => {
            const { chainClient, forceReconnectCalls } = makeFailingManager({});
            // Fast retries disabled so the poll tick alone drives the failure run.
            const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0, channelRetryLadderMs: [] });
            const unsub = await manager.subscribe('alice', () => {});

            for (let i = 0; i < WD_THRESHOLD; i++) await poll();
            assert.strictEqual(forceReconnectCalls.length, 1,
                `expected one forced reconnect after ${WD_THRESHOLD} consecutive failures`);
            assert.ok(/fill channel degraded/i.test(forceReconnectCalls[0]),
                'reconnect reason should identify the degraded fill channel');

            // The degraded latch is gone: further failures while still dead must
            // keep asking for recovery. The client-level cooldown (not this
            // layer) is what bounds the rate.
            await poll();
            await poll();
            assert.strictEqual(forceReconnectCalls.length, 3,
                'watchdog must keep requesting recovery while the channel stays dead (no degraded latch)');

            const aliceSub = manager.getSubscriptions().get('alice');
            assert.strictEqual(aliceSub._channelDegraded, true, 'account should still be marked degraded');

            // A successful scan clears the whole run, including the cycle counter.
            chainClient.history.get_account_history = async () => [];
            chainClient.history.getAccountHistoryOperations = async () => [];
            await poll();
            assert.strictEqual(aliceSub._channelFailures, 0, 'successful scan must reset the failure run');
            assert.strictEqual(aliceSub._channelDegraded, false, 'successful scan must clear the degraded flag');
            assert.strictEqual(aliceSub._channelRecoveryCycles, 0, 'successful scan must reset the recovery cycle counter');

            unsub();
        });
        console.log('   fill-channel re-arm test passed');
    }

    // Recovery looping is invisible unless it is logged: after N forced
    // reconnects without recovery, the watchdog must say so.
    {
        console.log('\n - Testing unrecoverable-channel escalation alert...');
        await withFakePollTimer(async (poll) => {
            const { chainClient } = makeFailingManager({});
            const manager = createSubscriptionManager(chainClient, { noticeCoalesceMs: 0, channelRetryLadderMs: [] });
            const unsub = await manager.subscribe('alice', () => {});

            const lines = await captureLogs(async () => {
                // The threshold costs the first WD_THRESHOLD-1 polls before any
                // escalation, and the alert lands on the WD_ALERT_AFTER-th
                // escalation, so drive well past both.
                for (let i = 0; i < WD_THRESHOLD + WD_ALERT_AFTER + 3; i++) await poll();
            });

            const alerts = lines.filter(l => /did NOT recover after/.test(l));
            assert.strictEqual(alerts.length, 1,
                `expected exactly one unrecoverable-channel alert, got ${alerts.length}`);
            assert.ok(/fills may be missed/i.test(alerts[0]), 'alert should state the operational impact');
            assert.ok(/restart/i.test(alerts[0]), 'alert should recommend operator action');
            assert.ok(/\[ERROR\]/.test(alerts[0]), 'alert should be logged at error level');
            unsub();
        });
        console.log('   unrecoverable-channel alert test passed');
    }

    // A single failed scan proves nothing; a channel still dead seconds later is
    // wedged. The retry ladder must reach the threshold and escalate WITHOUT any
    // further 60s poll tick — that is the whole point of the ladder.
    {
        console.log('\n - Testing retry ladder detects a wedge without waiting for poll ticks...');
        const { chainClient, forceReconnectCalls } = makeFailingManager({});
        let pollTimerHandle: any = null;
        const originalSetInterval = global.setInterval;
        const originalClearInterval = global.clearInterval;
        global.setInterval = ((handler: any) => { pollTimerHandle = { fn: handler }; return pollTimerHandle as any; }) as any;
        global.clearInterval = ((_h: any) => {}) as any;
        let unsub: any = null;
        try {
            // Production ladder shape (5s/10s/15s), collapsed to milliseconds.
            const manager = createSubscriptionManager(chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: [5, 10, 15],
            });
            unsub = await manager.subscribe('alice', () => {});

            // ONE failing poll tick. Everything after this must be ladder-driven.
            await pollTimerHandle.fn();
            const aliceSub = manager.getSubscriptions().get('alice');
            assert.strictEqual(aliceSub._channelFailures, 1, 'the failing poll should record one failure');
            assert.ok(aliceSub._channelRetryTimer, 'a failure must schedule a fast retry');
            assert.strictEqual(aliceSub._channelRetryStep, 1, 'a scheduled retry must consume the first rung');

            // A pending retry makes the regular poll skip the account rather than
            // duplicating the request and burning a failure against the threshold.
            const failuresBefore = aliceSub._channelFailures;
            await pollTimerHandle.fn();
            assert.strictEqual(aliceSub._channelFailures, failuresBefore,
                'the fill poll must skip an account with a fast retry already pending');

            // The ladder alone must reach the threshold and escalate.
            const start = Date.now();
            while (forceReconnectCalls.length === 0 && Date.now() - start < 2000) {
                await new Promise(r => setTimeout(r, 5));
            }
            assert.ok(forceReconnectCalls.length >= 1,
                'the retry ladder must escalate to a forced reconnect without any further poll tick');
            assert.ok(Date.now() - start < 2000,
                'escalation must happen on the ladder cadence, not the 60s poll cadence');
            assert.ok(aliceSub._channelFailures >= WD_THRESHOLD,
                `the ladder should have reached the failure threshold, saw ${aliceSub._channelFailures}`);
        } finally {
            if (unsub) await unsub();
            global.setInterval = originalSetInterval;
            global.clearInterval = originalClearInterval;
        }
        console.log('   retry ladder test passed');
    }

    // The ladder must never index past its configured rungs, and opting out must
    // schedule nothing.
    {
        console.log('\n - Testing retry ladder stays within its rungs and can be disabled...');
        await withFakePollTimer(async (poll) => {
            const rungs = [1, 1, 1];
            // A coalesced forced reconnect (another escalation source already
            // issued it) must not refill the ladder, so this phase exercises the
            // rung bound on its own: with no refill the step must stop climbing
            // at the last rung.
            const coalesced = makeFailingManager({});
            coalesced.chainClient.forceReconnect = () => 'coalesced';
            const manager = createSubscriptionManager(coalesced.chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: rungs,
            });
            const unsub = await manager.subscribe('alice', () => {});
            const aliceSub = manager.getSubscriptions().get('alice');

            for (let i = 0; i < 15; i++) {
                await poll();
                assert.ok(aliceSub._channelRetryStep >= 0 && aliceSub._channelRetryStep <= rungs.length,
                    `ladder step ${aliceSub._channelRetryStep} must stay within the configured rungs`);
                await new Promise(r => setTimeout(r, 3));
            }
            assert.strictEqual(aliceSub._channelRetryStep, rungs.length,
                'with no refill the ladder must stop at its last rung, not keep climbing');
            assert.strictEqual(aliceSub._channelRetryTimer, null,
                'an exhausted ladder must not schedule another fast retry');
            unsub();

            // Opt-out: an empty ladder must never schedule a fast retry, leaving
            // detection entirely on the 60s poll cadence.
            const disabled = makeFailingManager({});
            const manager2 = createSubscriptionManager(disabled.chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: [],
            });
            const unsub2 = await manager2.subscribe('bob', () => {});
            await poll();
            const bobSub = manager2.getSubscriptions().get('bob');
            assert.strictEqual(bobSub._channelRetryTimer, null,
                'an empty retry ladder must schedule nothing');
            assert.strictEqual(bobSub._channelRetryStep, 0,
                'an empty retry ladder must not advance its step');
            unsub2();
        });
        console.log('   retry ladder bound test passed');
    }

    // An issued reconnect refills the ladder: a fresh recovery attempt deserves a
    // fresh verification ladder, without raising the reconnect rate itself (the
    // per-client cooldown still floors that).
    {
        console.log('\n - Testing an issued reconnect refills the retry ladder...');
        await withFakePollTimer(async (poll) => {
            const { chainClient, forceReconnectCalls } = makeFailingManager({});
            // A single rung keeps the ladder exhausted between polls, so the
            // threshold-crossing failure deterministically finds it empty.
            const manager = createSubscriptionManager(chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: [1],
            });
            const unsub = await manager.subscribe('alice', () => {});
            const aliceSub = manager.getSubscriptions().get('alice');

            // Drain the ladder between polls so the failure that crosses the
            // threshold is always poll-driven, never a fast retry, then stop the
            // instant the first reconnect is issued so the assertion below sees
            // exactly that failure's state.
            let guard = 0;
            while (forceReconnectCalls.length === 0 && guard++ < 10) {
                await poll();
                if (forceReconnectCalls.length > 0) break;
                await new Promise(r => setTimeout(r, 15));
            }
            assert.ok(forceReconnectCalls.length >= 1, 'expected at least one issued reconnect');

            // The refill happens BEFORE the retry is scheduled, so the escalation
            // failure itself consumes the first rung again: step 1, timer pending.
            // Scheduling the retry first would find the ladder exhausted, schedule
            // nothing, and idle until the next 60s poll.
            assert.strictEqual(aliceSub._channelRetryStep, 1,
                'an issued reconnect must restart the verification ladder at its first rung');
            assert.ok(aliceSub._channelRetryTimer,
                'the escalation failure must schedule a fresh first-rung retry');
            unsub();
        });
        console.log('   ladder refill test passed');
    }

    // The refill is bounded per failure run. Without the cap, a client that keeps
    // issuing reconnects faster than the ladder completes would chain the ladder
    // forever and a permanently dead channel would scan at the first rung (5s in
    // production) indefinitely instead of settling back to the 60s poll.
    {
        console.log('\n - Testing retry-ladder refills are capped per failure run...');
        await withFakePollTimer(async (poll) => {
            const maxRefills = 3;
            const { chainClient, forceReconnectCalls } = makeFailingManager({});
            // A client that always issues a reconnect is the worst case for the
            // refill loop — the cooldown that normally spaces these out is absent.
            const manager = createSubscriptionManager(chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: [1, 1, 1],
                channelRetryMaxRefills: maxRefills,
            });
            const unsub = await manager.subscribe('alice', () => {});
            const aliceSub = manager.getSubscriptions().get('alice');

            const start = Date.now();
            // Poll (yielding to the 1 ms retry ladder) until the runaway has
            // issued more reconnects than the refill cap. Condition-driven rather
            // than a fixed 800 ms burn, with a bounded budget so a regression
            // fails an assertion instead of hanging.
            while (forceReconnectCalls.length <= maxRefills && Date.now() - start < 2000) {
                await poll();
                await new Promise(r => setTimeout(r, 2));
            }

            assert.ok(forceReconnectCalls.length > maxRefills,
                'precondition: the runaway case issues more reconnects than the refill cap');
            assert.ok(aliceSub._channelRetryRefills <= maxRefills,
                `refills must be capped, saw ${aliceSub._channelRetryRefills}`);
            // Let any in-flight 1 ms fast retry fire and settle before sampling
            // the steady state. Once the cap is reached no new fast retry is
            // scheduled, so a second short window must see no further growth.
            await new Promise(r => setTimeout(r, 30));
            const settledFailures = aliceSub._channelFailures;
            await new Promise(r => setTimeout(r, 30));
            assert.strictEqual(aliceSub._channelFailures, settledFailures,
                'a capped, dead channel must stop self-driving scans and fall back to the poll cadence');
            assert.strictEqual(aliceSub._channelRetryTimer, null,
                'no fast retry may be pending once the refill cap is reached');

            // A recovery must restore the fast-retry capability, otherwise the
            // NEXT outage would silently get no fast retries at all.
            chainClient.history.get_account_history = async () => [];
            chainClient.history.getAccountHistoryOperations = async () => [];
            await poll();
            assert.strictEqual(aliceSub._channelRetryRefills, 0,
                'a successful scan must restore the refill budget');
            assert.strictEqual(aliceSub._channelFailures, 0,
                'a successful scan must reset the failure run');

            chainClient.history.get_account_history = async () => { throw new Error('stale again'); };
            chainClient.history.getAccountHistoryOperations = async () => { throw new Error('stale again'); };
            for (let i = 0; i < WD_THRESHOLD; i++) { await poll(); await new Promise(r => setTimeout(r, 3)); }
            assert.ok(aliceSub._channelRetryRefills >= 1,
                'after a recovery the ladder must be refillable again');
            unsub();
        });
        console.log('   retry refill cap test passed');
    }

    // A forced reconnect must not cost a healthy node a persistent strike. The
    // transport's in-memory deprioritization still rotates away from the node
    // (that is what makes the reconnect useful), but strikes survive restarts
    // and are only cleared by consecutive successful health probes 4h apart — so
    // a node that merely had a session-level wedge must not be blacklisted for
    // 24h. This asserts the real consequence against the real failure ledger.
    {
        console.log('\n - Testing node strikes are only recorded when recovery fails...');
        const { createFailureLedger } = require('../modules/node_failure_ledger');
        const { NODE_MANAGEMENT } = require('../modules/constants');
        const { shouldCountNodeStrike } = require('../modules/bitshares_client');
        const STRIKE_NODE = 'wss://strike-target.invalid/ws';

        // The rule itself: the transport's forced-reconnect report must not
        // count, every other source must.
        assert.strictEqual(shouldCountNodeStrike('forced-reconnect'), false,
            'a forced reconnect must not count as a persistent node strike');
        for (const src of ['connection', 'keep-alive', 'broadcast', 'fee-cache',
                           'blockchain-op', 'health-check', 'fill-channel-unrecoverable', undefined]) {
            assert.strictEqual(shouldCountNodeStrike(src), true,
                `source ${String(src)} must still count as a strike`);
        }

        const makeLedger = () => createFailureLedger({
            threshold: NODE_MANAGEMENT.BLACKLIST_THRESHOLD,
            cooldownMs: NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS,
            // Production rate-limits strikes to one per second, but in production
            // the 30s forced-reconnect cooldown already spaces recovery cycles
            // far beyond that, so the rate limit never binds. Disabled here so
            // the escalation can be driven in milliseconds; the threshold and
            // 24h blacklist semantics under test are the real ones.
            reportCooldownMs: 0,
            resetCountOnBlacklist: false,
            resetCountAfterCooldown: false,
            skipWhileBlacklisted: false,
        });

        // Build a client whose forced reconnects are NOT strikes (the real
        // wiring, via shouldCountNodeStrike) but which counts escalation strikes.
        const makeStrikeTrackingManager = (overrides: any, failBudget: number) => {
            const ledger = makeLedger();
            const strikes: string[] = [];
            let remainingFailures = failBudget;
            const chainClient: any = {
                transport: {
                    addMessageHandler() { return () => {}; },
                    getNodeUrl: () => STRIKE_NODE,
                },
                forceReconnect: (reason: string) => {
                    // Mirrors the real client: a forced reconnect does NOT strike.
                    if (!shouldCountNodeStrike('forced-reconnect')) return true;
                    strikes.push('forced-reconnect');
                    return true;
                },
                reportNodeFailure: (url: string, _msg: string, source: string) => {
                    if (url !== STRIKE_NODE) return;
                    strikes.push(source);
                    ledger.recordFailure(url);
                },
                db: {
                    get_full_accounts: async ([account]: any) => [makeAccountRecord(account)],
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async () => {
                        if (remainingFailures > 0) { remainingFailures--; throw staleApiError(); }
                        return [];
                    },
                    get_account_history: async () => {
                        if (remainingFailures > 0) { remainingFailures--; throw staleApiError(); }
                        return [];
                    },
                },
            };
            const manager = createSubscriptionManager(chainClient, overrides);
            return { manager, ledger, strikes, chainClient };
        };

        // Scenario A: the wedge clears after two recovery cycles (a session-level
        // problem). The node must come out of it with zero strikes.
        await withFakePollTimer(async (poll) => {
            // Budget: 1 scan is consumed by primeLastDeliveredHistoryId during
            // subscribe, then threshold (3) + 1 more gives two escalation cycles
            // before the channel recovers.
            const { manager, ledger, strikes } = makeStrikeTrackingManager(
                { noticeCoalesceMs: 0, channelRetryLadderMs: [] }, 5);
            const unsub = await manager.subscribe('alice', () => {});
            const aliceSub = manager.getSubscriptions().get('alice');
            // The cycle counter resets on recovery, so sample the peak while the
            // channel is still dead.
            let peakCycles = 0;
            for (let i = 0; i < 8; i++) {
                await poll();
                peakCycles = Math.max(peakCycles, Number(aliceSub._channelRecoveryCycles) || 0);
                await new Promise(r => setTimeout(r, 2));
            }
            assert.ok(peakCycles >= 2,
                `precondition: expected at least 2 recovery cycles, saw ${peakCycles}`);
            assert.strictEqual(aliceSub._channelFailures, 0, 'precondition: the channel should have recovered');
            assert.deepStrictEqual(strikes, [],
                'a channel that recovers within the recovery cycles must cost the node no strikes');
            assert.strictEqual(ledger.isBlacklisted(STRIKE_NODE), false,
                'a recovered channel must never blacklist the node');
            unsub();
        });

        // Scenario B: the channel never recovers. The node must still be
        // blacklisted — on escalation strikes, not on the forced reconnects.
        await withFakePollTimer(async (poll) => {
            const { manager, ledger, strikes } = makeStrikeTrackingManager(
                { noticeCoalesceMs: 0, channelRetryLadderMs: [] }, Number.MAX_SAFE_INTEGER);
            const unsub = await manager.subscribe('alice', () => {});
            for (let i = 0; i < 14; i++) { await poll(); await new Promise(r => setTimeout(r, 2)); }
            const aliceSub = manager.getSubscriptions().get('alice');
            assert.ok(aliceSub._channelRecoveryCycles >= WD_ALERT_AFTER,
                `precondition: expected >= ${WD_ALERT_AFTER} recovery cycles, saw ${aliceSub._channelRecoveryCycles}`);
            assert.ok(strikes.length >= NODE_MANAGEMENT.BLACKLIST_THRESHOLD,
                `an unrecoverable channel must strike the node enough to blacklist it, got ${strikes.length}`);
            assert.ok(strikes.every(s => s === 'fill-channel-unrecoverable'),
                `every strike must come from the escalation path, got: ${JSON.stringify([...new Set(strikes)])}`);
            assert.strictEqual(ledger.isBlacklisted(STRIKE_NODE), true,
                'a node that survives repeated failed recovery must be blacklisted');
            // The first (WD_ALERT_AFTER - 1) cycles are attempts, not evidence.
            assert.strictEqual(strikes.length, aliceSub._channelRecoveryCycles - (WD_ALERT_AFTER - 1),
                'strikes must start only once recovery has demonstrably failed');
            unsub();
        });
        console.log('   node strike escalation test passed');
    }

    // Callback errors are downstream bugs, not channel failures. They must be
    // logged without counting toward the watchdog — and they must be throttled
    // like every other per-account warn, which is the gap this fixes: the
    // per-callback warn used to bypass warnSubscription entirely.
    {
        console.log('\n - Testing callback errors are throttled and never trip the watchdog...');
        await withFakePollTimer(async (poll) => {
            const forceReconnectCalls: string[] = [];
            const boom = () => { throw new Error('downstream bug'); };
            const chainClient: any = {
                transport: { addMessageHandler() { return () => {}; } },
                forceReconnect: (reason: string) => { forceReconnectCalls.push(reason); return true; },
                db: {
                    get_full_accounts: async ([account]: any) => [makeAccountRecord(account)],
                    call: async () => null,
                },
                history: {
                    getAccountHistoryOperations: async () => ([{
                        id: '1.11.900', op: [4, { fee: { amount: 0, asset_id: '1.3.0' } }, {}]}]),
                    get_account_history: async () => ([{
                        id: '1.11.900', op: [4, { fee: { amount: 0, asset_id: '1.3.0' } }, {}]}]),
                },
            };
            // A 50ms throttle window stands in for the production 60s one so the
            // "next emitted line reports the suppressed count" half of the
            // contract is observable without a wall-clock wait. Wide enough that
            // the five polls below reliably collapse into one window even on a
            // loaded machine.
            const manager = createSubscriptionManager(chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: [],
                channelErrorLogIntervalMs: 50,
            });
            const unsub = await manager.subscribe('alice', boom);

            const lines = await captureLogs(async () => {
                for (let i = 0; i < 5; i++) await poll();          // all suppressed after the first
                await new Promise(r => setTimeout(r, 80));          // let the window expire
                await poll();                                       // re-emits with the count
            });

            assert.strictEqual(forceReconnectCalls.length, 0,
                'callback errors must never trip the fill-channel watchdog');
            const aliceSub = manager.getSubscriptions().get('alice');
            assert.strictEqual(aliceSub._channelFailures, 0,
                'callback errors must not count as channel failures');

            const callbackWarns = lines.filter(l => /processObjects: callback error/.test(l));
            assert.strictEqual(callbackWarns.length, 2,
                `callback-error warns must be throttled per account, got ${callbackWarns.length} for 6 polls`);
            assert.ok(!/\(\+\d+ suppressed\)/.test(callbackWarns[0]),
                'the first warn in a window must not carry a suppressed count');
            assert.ok(/\(\+4 suppressed\)/.test(callbackWarns[1]),
                `the re-emitted warn must report the suppressed count, got: ${callbackWarns[1]}`);
            unsub();
        });
        console.log('   callback error throttling test passed');
    }

    // A legacy/mock forceReconnect that returns void must not be mistaken for an
    // issued reconnect: the `=== true` gate in requestChannelReconnect keeps the
    // recovery-cycle and refill counters from advancing on a no-op.
    {
        console.log('\n - Testing a void forceReconnect is not counted as issued...');
        await withFakePollTimer(async (poll) => {
            const { chainClient } = makeFailingManager({});
            chainClient.forceReconnect = () => undefined;
            const manager = createSubscriptionManager(chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: [],
            });
            const unsub = await manager.subscribe('alice', () => {});
            for (let i = 0; i < WD_THRESHOLD + 2; i++) await poll();
            const aliceSub = manager.getSubscriptions().get('alice');
            assert.strictEqual(aliceSub._channelRecoveryCycles, 0,
                'a void forceReconnect must not advance the recovery-cycle counter');
            unsub();
        });
        console.log('   void forceReconnect test passed');
    }

    // A coalesced reconnect (the shared cooldown was spent by another escalation
    // source — canonically the stale api_id path, which runs inside the RPC
    // catch before this failure reaches the watchdog) must still advance the
    // recovery-cycle counter, or the operator alert / node strike would be
    // starved in exactly the wedge this feature targets.
    {
        console.log('\n - Testing a coalesced reconnect still counts as a recovery cycle...');
        await withFakePollTimer(async (poll) => {
            const { chainClient } = makeFailingManager({});
            chainClient.forceReconnect = () => 'coalesced';
            chainClient.transport.getNodeUrl = () => 'wss://coalesce-target.invalid/ws';
            const strikes: string[] = [];
            chainClient.reportNodeFailure = (_url: string, _msg: string, source: string) => { strikes.push(source); };
            const manager = createSubscriptionManager(chainClient, {
                noticeCoalesceMs: 0,
                channelRetryLadderMs: [],
            });
            const unsub = await manager.subscribe('alice', () => {});
            const lines = await captureLogs(async () => {
                for (let i = 0; i < WD_THRESHOLD + WD_ALERT_AFTER; i++) await poll();
            });
            const aliceSub = manager.getSubscriptions().get('alice');
            assert.ok(aliceSub._channelRecoveryCycles >= WD_ALERT_AFTER,
                `a coalesced reconnect must still advance the cycle counter, saw ${aliceSub._channelRecoveryCycles}`);
            assert.strictEqual(lines.filter(l => /did NOT recover after/.test(l)).length, 1,
                'the operator alert must fire even when the cooldown is spent by another escalation source');
            assert.ok(strikes.length >= 1 && strikes.every(s => s === 'fill-channel-unrecoverable'),
                `the coalesced path must still escalate a real node strike, got ${JSON.stringify(strikes)}`);
            unsub();
        });
        console.log('   coalesced reconnect accounting test passed');
    }

    console.log('\n=== All subscription tests passed ===');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
