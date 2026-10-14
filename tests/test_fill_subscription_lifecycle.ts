/**
 * tests/test_fill_subscription_lifecycle.ts
 *
 * End-to-end simulation of the fill subscription lifecycle:
 * 1. subscribe() with no initial catch-up (main+btsdex parity)
 * 2. Live fill delivery via handleNotice (WebSocket push)
 * 3. Reconnect catch-up via resubscribeAll → processObjects
 * 4. Account-scoped fill routing (only matching accounts receive fills)
 * 5. Cursor advancement after live fills and reconnect scans
 *
 * Uses the real createSubscriptionManager with a mocked chain client
 * that mimics the BitShares Core get_account_history API:
 *   get_account_history(accountId, stop, limit, start)
 */

const assert = require('assert');
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');
const { getErrorMessage } = require('../modules/utils/errors');

const OP_FILL_ORDER = 4;
const ALICE_ID = '1.2.100';
const BOB_ID = '1.2.200';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccountRecord(account) {
    const name = account === '1.2.200' ? 'bob' : account === '1.2.100' ? 'alice' : account;
    return [account, {
        account: {
            id: name === 'bob' ? BOB_ID : ALICE_ID,
            name,
            statistics: name === 'bob' ? '2.6.200' : '2.6.100',
        },
    }];
}

function makeFill(id, blockNum, trxInBlock, orderId, accountId) {
    return {
        id,
        block_num: blockNum,
        trx_in_block: trxInBlock,
        op: [OP_FILL_ORDER, {
            order_id: orderId,
            account_id: accountId,
            pays: { amount: 1000, asset_id: '1.3.0' },
            receives: { amount: 500, asset_id: '1.3.1' },
            fill_price: { base: { amount: 1000, asset_id: '1.3.0' }, quote: { amount: 500, asset_id: '1.3.1' } },
            is_maker: true,
        }],
    };
}

function makeNotice(noticeHandler, callbackId, items) {
    return noticeHandler([callbackId, items]);
}

function instance(id) {
    if (typeof id !== 'string') return -1;
    const m = id.match(/\.(\d+)$/);
    return m ? Number(m[1]) : -1;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

(async () => {
    let total = 0;
    let passed = 0;

    function test(name, fn) {
        total++;
        return fn().then(() => {
            console.log(`  \u2713 ${name}`);
            passed++;
        }).catch(err => {
            console.log(`  \u2717 ${name}: ${getErrorMessage(err) || err}`);
        });
    }

    function assertEqual(actual, expected, msg) {
        if (actual !== expected) {
            throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    }

    function assertMatch(actual, expected, msg) {
        const a = Array.isArray(actual) ? actual.map(f => ({ id: f.id, op: f.op })) : actual;
        const e = Array.isArray(expected) ? expected.map(f => ({ id: f.id, op: f.op })) : expected;
        try { assert.deepStrictEqual(a, e); }
        catch (err) { throw new Error(`${msg}: ${getErrorMessage(err)}`); }
    }

    console.log('=== Fill Subscription Lifecycle Test ===\n');

    // -----------------------------------------------------------------------
    // Test 1: subscribe() primes cursor, registers callback, NO catch-up
    // -----------------------------------------------------------------------
    await test('subscribe primes cursor and does NOT call processObjects', async () => {
        const historyCalls = [];
        let noticeHandler = null;
        let delivered = [];

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    historyCalls.push({ accountId, stop, limit, start });
                    if (limit === 1) {
                        // primeLastDeliveredHistoryId: get single most recent entry
                        return [{ id: '1.11.500', block_num: 10, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.1' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(client);
        await manager.subscribe('alice', (fills) => { delivered.push(fills); });

        // Should have 2 history calls: one for priming (limit=1), none for catch-up
        assertEqual(historyCalls.length, 1, 'should only have prime call, no catch-up');
        assertEqual(historyCalls[0].limit, 1, 'prime call should have limit=1');

        // No initial delivery
        assertEqual(delivered.length, 0, 'should not deliver fills during subscribe');

        // Cursor should be primed (decremented from latest)
        const subs = manager.getSubscriptions();
        const aliceSub = subs.get('alice');
        assertEqual(aliceSub.lastDeliveredHistoryId, '1.11.499', 'cursor should be decremented latest');
    });

    // -----------------------------------------------------------------------
    // Test 2: handleNotice dispatches live fills directly
    // -----------------------------------------------------------------------
    await test('handleNotice dispatches live fill to matching account', async () => {
        let noticeHandler = null;
        let delivered = [];

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    if (limit === 1) {
                        return [{ id: '1.11.100', block_num: 1, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.0' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(client);
        await manager.subscribe('alice', (fills) => { delivered.push(fills); });

        // Send a live fill notice
        const fillObj = makeFill('1.11.101', 11, 2, '1.7.1', ALICE_ID);
        await makeNotice(noticeHandler, 1, [fillObj]);

        assertEqual(delivered.length, 1, 'should deliver 1 fill');
        assertEqual(delivered[0].length, 1, 'should contain 1 fill object');
        assertEqual(delivered[0][0].id, '1.11.101', 'fill ID should match');
        assertEqual(delivered[0][0].op[1].order_id, '1.7.1', 'order ID should match');
        assertEqual(delivered[0][0].block_num, 11, 'block number should match');

        // Cursor should advance to latest delivered fill
        const subs = manager.getSubscriptions();
        const aliceSub = subs.get('alice');
        const cursorInst = instance(aliceSub.lastDeliveredHistoryId);
        assertEqual(cursorInst >= 101, true, 'cursor should be >= 101 after live fill');
    });

    await test('handleNotice scans history for BitShares Core object-change notices', async () => {
        let noticeHandler = null;
        let delivered = [];
        const historyCalls = [];

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    historyCalls.push({ accountId, stop, limit, start });
                    if (limit === 1) {
                        return [{ id: '1.11.500', block_num: 1, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.0', account_id: ALICE_ID }] }];
                    }
                    return [
                        makeFill('1.11.501', 50, 1, '1.7.501', ALICE_ID),
                    ];
                },
            },
        };

        // Collapse the production 250 ms coalesce window so the test asserts on
        // scan delivery without sleeping a full notice window.
        const manager = createSubscriptionManager(client, { noticeCoalesceMs: 20 });
        await manager.subscribe('alice', (fills) => { delivered.push(fills); });
        historyCalls.length = 0;

        // BitShares Core account subscriptions may notify with changed/removed
        // object IDs or ordinary full objects, not the 1.11.x fill object itself.
        await makeNotice(noticeHandler, 1, ['1.7.501']);

        // Wait for the collapsed coalesced history scan.
        await new Promise(r => setTimeout(r, 30));

        assertEqual(delivered.length, 1, 'object-change notice should trigger a history scan delivery');
        assertEqual(delivered[0].length, 1, 'history scan should deliver one fill');
        assertEqual(delivered[0][0].id, '1.11.501', 'history fill ID should match');
        assertEqual(historyCalls.length, 1, 'notice should perform one catch-up history scan');
        assertEqual(historyCalls[0].stop, '1.11.499', 'scan should start from current exclusive cursor');
    });

    // -----------------------------------------------------------------------
    // Test 3: handleNotice routes fills only to matching account
    // -----------------------------------------------------------------------
    await test('handleNotice routes fills only to matching account', async () => {
        let noticeHandler = null;
        const aliceDelivered = [];
        const bobDelivered = [];

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    if (limit === 1) {
                        return [{ id: '1.11.200', block_num: 1, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.0' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(client);
        await manager.subscribe('alice', (fills) => { aliceDelivered.push(fills); });
        await manager.subscribe('bob', (fills) => { bobDelivered.push(fills); });

        // Alice's fill — should only go to alice
        await makeNotice(noticeHandler, 1, [makeFill('1.11.201', 5, 1, '1.7.a', ALICE_ID)]);
        assertEqual(aliceDelivered.length, 1, 'alice should receive her fill');
        assertEqual(bobDelivered.length, 0, 'bob should not receive alice fill');

        // Bob's fill — should only go to bob
        await makeNotice(noticeHandler, 1, [makeFill('1.11.202', 6, 2, '1.7.b', BOB_ID)]);
        assertEqual(aliceDelivered.length, 1, 'alice should not receive bob fill');
        assertEqual(bobDelivered.length, 1, 'bob should receive his fill');
    });

    // -----------------------------------------------------------------------
    // Test 4: Multiple fills in a single notice are dispatched together
    // -----------------------------------------------------------------------
    await test('multiple fills in single notice dispatch as one batch', async () => {
        let noticeHandler = null;
        let delivered = [];

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    if (limit === 1) {
                        return [{ id: '1.11.300', block_num: 1, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.0' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(client);
        await manager.subscribe('alice', (fills) => { delivered.push(fills); });

        // Three fills in one notice
        await makeNotice(noticeHandler, 1, [
            makeFill('1.11.301', 10, 1, '1.7.1', ALICE_ID),
            makeFill('1.11.302', 10, 2, '1.7.2', ALICE_ID),
            makeFill('1.11.303', 11, 1, '1.7.3', ALICE_ID),
        ]);

        assertEqual(delivered.length, 1, 'fills should batch into single delivery');
        assertEqual(delivered[0].length, 3, 'all 3 fills should be in the batch');
        assertEqual(delivered[0][0].id, '1.11.301', 'first fill ID matches');
        assertEqual(delivered[0][1].id, '1.11.302', 'second fill ID matches');
        assertEqual(delivered[0][2].id, '1.11.303', 'third fill ID matches');
    });

    // -----------------------------------------------------------------------
    // Test 5: Live fill advances cursor; reconnect catch-up finds newer fills
    // -----------------------------------------------------------------------
    await test('live fill advances cursor and reconnect catches newer fills', async () => {
        let noticeHandler = null;
        const historyCalls = [];
        let delivered = [];

        let latestHistoryId = '1.11.400';

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    historyCalls.push({ accountId, stop: instance(stop), limit, start: instance(start) });
                    if (limit === 1) {
                        // prime: return latest known
                        return [{ id: '1.11.400', block_num: 5, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.0' }] }];
                    }
                    // catch-up: return fills newer than stop (exclusive), newest first
                    const stopInst = instance(stop);
                    const result = [];
                    // Return up to `limit` entries with IDs > stopInst
                    const newest = Math.max(stopInst + 1, 401);
                    const count = Math.min(limit, 5);
                    for (let i = 0; i < count; i++) {
                        const id = `1.11.${newest + i}`;
                        if (instance(id) > stopInst) {
                            result.push(makeFill(id, 10 + i, i, `1.7.${newest + i}`, ALICE_ID));
                        }
                    }
                    return result.reverse(); // newest first
                },
            },
        };

        const manager = createSubscriptionManager(client);
        await manager.subscribe('alice', (fills) => { delivered.push(fills); });
        delivered.length = 0;

        // Live fill arrives (cursor at 1.11.399 from prime)
        await makeNotice(noticeHandler, 1, [makeFill('1.11.401', 11, 1, '1.7.401', ALICE_ID)]);
        assertEqual(delivered.length, 1, 'live fill delivered');
        assertEqual(delivered[0][0].id, '1.11.401', 'live fill ID matches');

        // Cursor should now be at 1.11.401
        let subs = manager.getSubscriptions();
        assertEqual(subs.get('alice').lastDeliveredHistoryId, '1.11.401', 'cursor advanced to 401');

        // Simulate reconnect: more fills arrived while disconnected
        delivered.length = 0;
        await manager.resubscribeAll();

        // reconnect catch-up should find fills > 401
        // processObjects in resubscribeAll calls get_account_history with stop=401
        // It should return fills 402, 403, ...
        const reconnectDeliveries = delivered.reduce((acc, batch) => acc.concat(batch), []);
        const reconnectIds = reconnectDeliveries.map(f => f.id);
        assertEqual(reconnectDeliveries.length >= 3, true, `reconnect should catch fills > 401, got: ${reconnectIds.join(',')}`);

        // Cursor should advance past the reconnect fills
        subs = manager.getSubscriptions();
        const cursorAfter = instance(subs.get('alice').lastDeliveredHistoryId);
        assertEqual(cursorAfter >= 404, true, `cursor should advance past reconnect fills, got ${cursorAfter}`);
    });

    // -----------------------------------------------------------------------
    // Test 6: Non-fill notice items are silently skipped
    // -----------------------------------------------------------------------
    await test('non-fill notice items are silently skipped', async () => {
        let noticeHandler = null;
        let delivered = [];

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    if (limit === 1) {
                        return [{ id: '1.11.600', block_num: 1, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.0' }] }];
                    }
                    return [];
                },
            },
        };

        const manager = createSubscriptionManager(client);
        await manager.subscribe('alice', (fills) => { delivered.push(fills); });

        // Balance object notice (2.5.x) — no op field
        await makeNotice(noticeHandler, 1, [{ id: '2.5.100', owner: ALICE_ID }]);
        assertEqual(delivered.length, 0, 'balance notice should not dispatch');

        // Statistics object notice (2.6.x) — no op field
        await makeNotice(noticeHandler, 1, [{ id: '2.6.100' }]);
        assertEqual(delivered.length, 0, 'statistics notice should not dispatch');

        // Thin 1.11.x without op field (partial object notification)
        await makeNotice(noticeHandler, 1, [{ id: '1.11.601' }]);
        assertEqual(delivered.length, 0, 'thin 1.11 notice without op should not dispatch');
    });

    // -----------------------------------------------------------------------
    // Test 7: resubscribeAll catch-up after disconnect
    // -----------------------------------------------------------------------
    await test('resubscribeAll catches fills missed during disconnect', async () => {
        let noticeHandler = null;
        const historyCalls = [];
        let delivered = [];

        const client = {
            transport: {
                addMessageHandler: h => { noticeHandler = h; return () => { noticeHandler = null; }; },
            },
            db: {
                get_full_accounts: async ([account]) => [makeAccountRecord(account)],
                call: async () => null,
            },
            history: {
                get_account_history: async (accountId, stop, limit, start) => {
                    historyCalls.push({ accountId, stop: instance(stop), limit, start: instance(start) });
                    if (limit === 1) {
                        return [{ id: '1.11.700', block_num: 1, trx_in_block: 1, op: [OP_FILL_ORDER, { order_id: '1.7.0' }] }];
                    }
                    const stopInst = instance(stop);
                    // Return fills newer than stop (exclusive)
                    const result = [];
                    for (let i = 1; i <= Math.min(limit, 3); i++) {
                        const idNum = stopInst + i;
                        result.push(makeFill(`1.11.${idNum}`, 10 + i, i, `1.7.${idNum}`, ALICE_ID));
                    }
                    return result.reverse();
                },
            },
        };

        const manager = createSubscriptionManager(client);
        await manager.subscribe('alice', (fills) => { delivered.push(fills); });
        delivered.length = 0;
        historyCalls.length = 0;

        // Simulates a reconnect after disconnect
        await manager.resubscribeAll();

        // Should have fetched fills since cursor (1.11.699)
        const catchUpCalls = historyCalls.filter(c => c.limit > 1);
        assertEqual(catchUpCalls.length >= 1, true, 'should have at least one catch-up history call');

        const allFills = delivered.reduce((acc, batch) => acc.concat(batch), []);
        assertEqual(allFills.length >= 1, true, `should catch at least 1 fill, got ${allFills.length}`);
        allFills.forEach(f => {
            const inst = instance(f.id);
            assertEqual(inst > 699, true, `reconnect fill ${f.id} should be newer than cursor 699`);
        });
    });

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    // Wait for all async tests to complete
    await new Promise(resolve => setImmediate(resolve));

    console.log(`\n=== Results: ${passed}/${total} passed ===`);
    if (passed !== total) {
        process.exitCode = 1;
    }
})().catch(err => {
    console.error('Test suite error:', getErrorMessage(err) || err);
    process.exitCode = 1;
});
