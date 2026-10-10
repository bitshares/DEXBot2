const assert = require('assert');
const { EventEmitter } = require('events');
const net = require('net');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { ensureFeeCache } = require('./helpers/fee_cache_init');

// Compiled ESM namespaces are frozen, so chain_orders / chain_keys /
// bitshares_client are replaced via loader hooks. Swappable functions resolve
// per-test overrides at CALL time (assignments mutate the override map — the
// named-export bindings consumers captured stay valid), and restoring the
// original wrapper clears the override.
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

class MasterPasswordErrorStub extends Error {}

const CHAIN_KEYS_DEFAULTS = {
    MasterPasswordError: MasterPasswordErrorStub,
    createDaemonSigningToken: (accountName: string, options: Record<string, any> = {}) => ({
        kind: 'dexbot-daemon-signing-token',
        accountName,
        socketPath: options.socketPath || null,
        sessionId: options.sessionId || null,
        botHmacSecret: options.botHmacSecret || null,
    }),
    isDaemonSigningToken: (value: any) => !!(value && typeof value === 'object' && value.kind === 'dexbot-daemon-signing-token' && typeof value.accountName === 'string'),
    isDaemonResponsive: async () => true,
    isDaemonReady: async () => true,
    waitForDaemon: async () => true,
    pingDaemon: async () => true,
    probeAccountInDaemon: async () => { throw new Error('probeAccountInDaemon not configured for this test'); },
};

const BITSHARES_CLIENT_NAMES = [
    'BitShares', 'createAccountClient', 'waitForConnected', 'getConnectionStatus',
    'disconnectClient', 'reconnectForCycle', 'setSuppressConnectionLog', 'onReconnect',
    'withTimeout', '_assessFailover', 'getNodeManager', 'getNodeStats', 'getNodeSummary',
    'getConnectionError', '_internal'
];

function makeBitsharesClientDefaults() {
    return {
        BitShares: { subscribe() {}, db: {} },
        createAccountClient: () => ({ sign: () => {}, broadcast: async () => ({}) }),
        waitForConnected: async () => {},
        getConnectionStatus: () => ({ connected: true }),
        disconnectClient: async () => {},
        reconnectForCycle: async () => {},
        setSuppressConnectionLog() {},
        onReconnect: () => () => {},
        withTimeout: (p: any) => p,
        _assessFailover: () => null,
        getNodeManager: () => ({
            getHealthyNodes: () => [
                'wss://primary.bitshares.org/ws',
                'wss://alt-1.bitshares.org/ws',
                'wss://alt-2.bitshares.org/ws',
            ],
        }),
        getNodeStats: () => null,
        getNodeSummary: () => null,
        getConnectionError: () => null,
        _internal: { get connected() { return false; } },
    };
}

const CHAIN_ORDERS_NAMES = [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
];

async function readWithMetaSafe(mod: any, accountId: any, timeoutMs?: number, _suppressLog?: boolean) {
    if (mod && typeof mod.readOpenOrdersWithMeta === 'function') {
        return mod.readOpenOrdersWithMeta(accountId, timeoutMs);
    }
    return { orders: await mod.readOpenOrders(accountId, timeoutMs), truncated: false };
}

async function readGuarded(mod: any, accountId: any, options: any = {}) {
    const read = await readWithMetaSafe(mod, accountId, options.timeoutMs);
    const truncated = read?.truncated === true;
    const orders = read?.orders;
    const empty = !Array.isArray(orders) || orders.length === 0;
    if (!truncated && !(options.deferEmpty && empty)) return Array.isArray(orders) ? orders : [];
    return null;
}

let testsComplete = false;
const { BroadcastUncertainError, executeOperationsViaCredentialDaemon } = require('../modules/dexbot_credential_client');
const { buildCreateOpFingerprint } = require('../modules/order/utils/order');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, DAEMON_CODES, DAEMON_ERRORS } = require('../modules/constants');
let chainOrders: any;
let chainKeys: any;
let _createStartupOrderWithHandling: any;

// grid_reconcile_internal statically imports chain_orders/chain_keys, so it
// may only be required after the loader-level mocks are registered (inside
// the stage callbacks); everything else at the top is mock-free.
function requireProdModules() {
    ({ _createStartupOrderWithHandling } = require('../modules/order/grid_reconcile_internal'));
}

process.on('unhandledRejection', (reason) => {
    const isPostTestWsErrorEvent = testsComplete &&
        reason &&
        (reason as any).type === 'error' &&
        (reason as any).error &&
        typeof (reason as any).error === 'object';

    if (isPostTestWsErrorEvent) {
        return;
    }

    console.error('Test failed:', reason);
    process.exit(1);
});

function makeFingerprint(side, assetA, assetB, sell, receive, slotId) {
    return `${side}:${assetA}:${assetB}:${sell}:${receive}:${slotId}`;
}

function makeChainOrder(id, type, sellInt, receiveInt) {
    const sellAssetId = type === 'sell' ? '1.3.0' : '1.3.121';
    const receiveAssetId = type === 'sell' ? '1.3.121' : '1.3.0';
    return {
        id,
        for_sale: String(sellInt),
        sell_price: {
            base: { amount: String(sellInt), asset_id: sellAssetId },
            quote: { amount: String(receiveInt), asset_id: receiveAssetId }
        }
    };
}

function installFakeCredentialDaemonTransport(handler) {
    const originalCreateConnection = net.createConnection;
    const socketPath = `/tmp/dexbot-fake-${process.pid}-${Date.now()}.sock`;
    net.createConnection = (requestedSocketPath, onConnect) => {
        assert.strictEqual(requestedSocketPath, socketPath);
        const socket = new EventEmitter();
        socket.destroyed = false;
        socket.write = (payload) => {
            const request = JSON.parse(String(payload).trim());
            handler(request, {
                writeLine: (response) => {
                    process.nextTick(() => socket.emit('data', Buffer.from(`${JSON.stringify(response)}\n`)));
                },
                endLine: (response) => {
                    process.nextTick(() => {
                        socket.emit('data', Buffer.from(`${JSON.stringify(response)}\n`));
                        socket.emit('end');
                    });
                },
                close: () => process.nextTick(() => socket.emit('end')),
            });
            return true;
        };
        socket.end = () => {
            socket.destroyed = true;
        };
        socket.destroy = () => {
            socket.destroyed = true;
            process.nextTick(() => socket.emit('close'));
        };
        process.nextTick(() => onConnect && onConnect());
        return socket;
    };
    return {
        socketPath,
        restore: () => {
            net.createConnection = originalCreateConnection;
        }
    };
}

async function testFingerprintDeterministic() {
    console.log('\n[UNC-001] buildCreateOpFingerprint is deterministic...');
    const fp1 = buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0',
        assetB: '1.3.121',
        sellInt: 100000000,
        receiveInt: 5000000,
        slotId: 'sell-3'
    });
    const fp2 = buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0',
        assetB: '1.3.121',
        sellInt: 100000000,
        receiveInt: 5000000,
        slotId: 'sell-3'
    });
    assert.strictEqual(fp1, fp2, 'same inputs must produce the same fingerprint');
    assert.strictEqual(
        fp1,
        makeFingerprint('sell', '1.3.0', '1.3.121', 100000000, 5000000, 'sell-3'),
        'fingerprint format must match expected pattern'
    );
    console.log('✓ UNC-001 passed');
}

async function testFingerprintRejectsBadInput() {
    console.log('\n[UNC-002] buildCreateOpFingerprint rejects malformed input...');
    assert.strictEqual(buildCreateOpFingerprint(null), null);
    assert.strictEqual(buildCreateOpFingerprint({}), null);
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'invalid',
        assetA: '1.3.0', assetB: '1.3.121',
        sellInt: 1, receiveInt: 1, slotId: 'x'
    }), null, 'invalid side must return null');
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'sell',
        assetA: null, assetB: '1.3.121',
        sellInt: 1, receiveInt: 1, slotId: 'x'
    }), null, 'missing asset must return null');
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0', assetB: '1.3.121',
        sellInt: 'NaN', receiveInt: 1, slotId: 'x'
    }), null, 'non-finite sell must return null');
    assert.strictEqual(buildCreateOpFingerprint({
        side: 'sell',
        assetA: '1.3.0', assetB: '1.3.121',
        sellInt: 1, receiveInt: 1, slotId: null
    }), null, 'missing slotId must return null');
    console.log('✓ UNC-002 passed');
}

async function testBroadcastUncertainErrorCarriesMetadata() {
    console.log('\n[UNC-003] BroadcastUncertainError carries operations, accountName, batchId...');
    const err = new BroadcastUncertainError('test', {
        operations: [{ op_name: 'limit_order_create' }],
        accountName: '1.2.x',
        batchId: 'batch-42',
        payload: { type: 'execute-operations' },
        timeoutMs: 30000
    });
    assert.strictEqual(err.name, 'BroadcastUncertainError');
    assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
    assert.strictEqual(err.accountName, '1.2.x');
    assert.strictEqual(err.batchId, 'batch-42');
    assert.strictEqual(err.timeoutMs, 30000);
    assert(Array.isArray(err.operations), 'operations should be carried on the error');
    assert(err instanceof Error, 'must be an Error subclass');
    console.log('✓ UNC-003 passed');
}

async function testExactChainOrderMatchIsAdopted() {
    console.log('\n[UNC-004] exact-fingerprint chain order is adopted (not duplicated)...');
    const bot = makeBot();
    const slotId = 'sell-3';
    const fingerprintSell = 100000000;
    const fingerprintReceive = 5000000;

    bot.manager._pendingBroadcasts.set(
        makeFingerprint('sell', '1.3.0', '1.3.121', fingerprintSell, fingerprintReceive, slotId),
        {
            fingerprint: makeFingerprint('sell', '1.3.0', '1.3.121', fingerprintSell, fingerprintReceive, slotId),
            slotId,
            orderType: 'sell',
            order: { id: slotId, type: 'sell', price: 0.05, size: 1 },
            finalInts: { sell: fingerprintSell, receive: fingerprintReceive },
            batchId: 'test-batch-1',
            recordedAt: Date.now()
        }
    );

    // Chain already has the order (we just couldn't see the broadcast reply).
    const chainOrders = [
        {
            id: '1.7.572311702',
            type: 'sell',
            sellInt: fingerprintSell,
            receiveInt: fingerprintReceive,
            sellAssetId: '1.3.0',
            receiveAssetId: '1.3.121',
            for_sale: fingerprintSell
        }
    ];

    const adopted = [];
    const discarded = [];
    for (const entry of bot.manager._pendingBroadcasts.values()) {
        const match = bot._findChainOrderForSlot(
            chainOrders,
            entry.slotId,
            { sell: entry.finalInts.sell, receive: entry.finalInts.receive }
        );
        if (match) {
            adopted.push({ slotId: entry.slotId, chainOrderId: match.id });
            bot.manager._pendingBroadcasts.delete(entry.fingerprint);
        } else {
            discarded.push({ slotId: entry.slotId });
        }
    }
    assert.strictEqual(adopted.length, 1, 'one planned CREATE should be adopted');
    assert.strictEqual(adopted[0].chainOrderId, '1.7.572311702', 'must adopt the chain order by id');
    assert.strictEqual(discarded.length, 0, 'no discard when exact match found');
    assert.strictEqual(bot.manager._pendingBroadcasts.size, 0, 'pending broadcasts should be cleared after adoption');
    console.log('✓ UNC-004 passed');
}

async function testRecordedPendingBroadcastStoresSlotId() {
    console.log('\n[UNC-004b] _recordPendingBroadcast stores runtime slotId for recovery...');
    const bot = makeBot();
    const slotId = 'sell-4';
    const plannedSell = 110000000;
    const plannedReceive = 5500000;

    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: slotId, type: 'sell', price: 0.05, size: 1.1 },
        finalInts: { sell: plannedSell, receive: plannedReceive }
    });

    assert.strictEqual(bot.manager._pendingBroadcasts.size, 1, 'pending broadcast should be recorded');
    const entry = Array.from(bot.manager._pendingBroadcasts.values())[0];
    assert.strictEqual((entry as any).slotId, slotId, 'runtime pending entry must carry slotId');

    const chainOrders = [
        {
            id: '1.7.572311703',
            type: 'sell',
            sellInt: plannedSell,
            receiveInt: plannedReceive,
            sellAssetId: '1.3.0',
            receiveAssetId: '1.3.121',
            for_sale: plannedSell
        }
    ];

    const match = bot._findChainOrderForSlot(
        chainOrders,
        (entry as any).slotId,
        { sell: (entry as any).finalInts.sell, receive: (entry as any).finalInts.receive, orderType: (entry as any).orderType }
    );
    assert(match, 'runtime-shaped pending entry should match chain order');
    assert.strictEqual(match.id, '1.7.572311703');
    console.log('✓ UNC-004b passed');
}

async function testNoChainMatchIsDiscarded() {
    console.log('\n[UNC-005] no-chain-match pending is discarded (not duplicated)...');
    const bot = makeBot();
    const slotId = 'sell-7';
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('sell', '1.3.0', '1.3.121', 200000000, 8000000, slotId),
        {
            fingerprint: makeFingerprint('sell', '1.3.0', '1.3.121', 200000000, 8000000, slotId),
            slotId,
            orderType: 'sell',
            order: { id: slotId, type: 'sell', price: 0.04, size: 2 },
            finalInts: { sell: 200000000, receive: 8000000 },
            batchId: 'test-batch-2',
            recordedAt: Date.now()
        }
    );

    // Chain has no matching order (the broadcast never made it through).
    const chainOrders = [];
    const adopted = [];
    const discarded = [];
    for (const entry of bot.manager._pendingBroadcasts.values()) {
        const match = bot._findChainOrderForSlot(
            chainOrders,
            entry.slotId,
            { sell: entry.finalInts.sell, receive: entry.finalInts.receive }
        );
        if (match) {
            adopted.push({ slotId: entry.slotId, chainOrderId: match.id });
            bot.manager._pendingBroadcasts.delete(entry.fingerprint);
        } else {
            discarded.push({ slotId: entry.slotId });
        }
    }
    assert.strictEqual(adopted.length, 0, 'no adoption when chain is empty');
    assert.strictEqual(discarded.length, 1, 'planned CREATE should be discarded');
    assert.strictEqual(discarded[0].slotId, 'sell-7');
    console.log('✓ UNC-005 passed');
}

async function testNearMatchWithinToleranceIsAdopted() {
    console.log('\n[UNC-006] near-tolerance chain match is adopted (precision drift)...');
    const bot = makeBot();
    const slotId = 'buy-2';
    const plannedSell = 10000000;
    const plannedReceive = 2000000;
    bot.manager.orders.set(slotId, { id: slotId, type: 'buy', price: 0.2, size: 0.1 });
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
        {
            fingerprint: makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
            slotId,
            orderType: 'buy',
            order: { id: slotId, type: 'buy', price: 0.2, size: 0.1 },
            finalInts: { sell: plannedSell, receive: plannedReceive },
            batchId: 'test-batch-3',
            recordedAt: Date.now()
        }
    );

    // Chain has the order but the receive int drifted by 1 (e.g. ±1 rounding).
    const chainOrders = [
        {
            id: '1.7.572311800',
            type: 'buy',
            sellInt: plannedSell,
            receiveInt: plannedReceive + 1,
            sellAssetId: '1.3.121',
            receiveAssetId: '1.3.0',
            for_sale: plannedSell
        }
    ];
    const match = bot._findChainOrderForSlot(
        chainOrders,
        slotId,
        { sell: plannedSell, receive: plannedReceive, orderType: 'buy' }
    );
    assert(match, 'within-tolerance chain order should be adopted');
    assert.strictEqual(match.id, '1.7.572311800');
    console.log('✓ UNC-006 passed');
}

async function testOutsideToleranceIsNotAdopted() {
    console.log('\n[UNC-007] outside-tolerance chain order is NOT adopted...');
    const bot = makeBot();
    const slotId = 'sell-9';
    const plannedSell = 100000000;
    const plannedReceive = 5000000;
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('sell', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
        {
            fingerprint: makeFingerprint('sell', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
            slotId,
            orderType: 'sell',
            order: { id: slotId, type: 'sell', price: 0.05, size: 1 },
            finalInts: { sell: plannedSell, receive: plannedReceive },
            batchId: 'test-batch-4',
            recordedAt: Date.now()
        }
    );

    // Chain has an order for a totally different price (50% off planned).
    const chainOrders = [
        {
            id: '1.7.572311999',
            type: 'sell',
            sellInt: plannedSell,
            receiveInt: plannedReceive * 2,  // 100% drift
            sellAssetId: '1.3.0',
            receiveAssetId: '1.3.121',
            for_sale: plannedSell
        }
    ];
    const match = bot._findChainOrderForSlot(
        chainOrders,
        slotId,
        { sell: plannedSell, receive: plannedReceive }
    );
    assert.strictEqual(match, null, 'outside-tolerance match must NOT be adopted');
    console.log('✓ UNC-007 passed');
}

async function testNearMatchUsesPendingSideWhenGridSlotMissing() {
    console.log('\n[UNC-007b] near-match uses pending side when live grid slot is missing...');
    const bot = makeBot();
    const slotId = 'buy-cleared';
    const plannedSell = 10000000;
    const plannedReceive = 2000000;
    bot.manager._pendingBroadcasts.set(
        makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
        {
            fingerprint: makeFingerprint('buy', '1.3.0', '1.3.121', plannedSell, plannedReceive, slotId),
            slotId,
            orderType: 'buy',
            order: { id: slotId, type: 'buy', price: 0.2, size: 0.1 },
            finalInts: { sell: plannedSell, receive: plannedReceive },
            batchId: 'test-batch-side',
            recordedAt: Date.now()
        }
    );

    assert.strictEqual(bot.manager.orders.has(slotId), false, 'test must cover cleared working/master slot');
    const match = bot._findChainOrderForSlot(
        [makeChainOrder('1.7.572311801', 'buy', plannedSell, plannedReceive + 1)],
        slotId,
        { sell: plannedSell, receive: plannedReceive, orderType: 'buy' }
    );
    assert(match, 'near-match should not depend on manager.orders retaining the slot type');
    assert.strictEqual(match.id, '1.7.572311801');
    console.log('✓ UNC-007b passed');
}

async function testBroadcastUncertainErrorIsNotRetried() {
    console.log('\n[UNC-008] BroadcastUncertainError is not retried by chain_orders...');
    // The retry path in executeViaDaemonToken must skip on BroadcastUncertainError.
    // We can't easily drive the daemon in a unit test, but we can verify the
    // error instance is recognized.
    const err = new BroadcastUncertainError('test', { operations: [], accountName: 'x' });
    // The shape check: chain_orders.executeBatch would `if (err instanceof BroadcastUncertainError) throw err;`
    assert(err instanceof BroadcastUncertainError);
    assert(err instanceof Error);
    console.log('✓ UNC-008 passed');
}

async function testReconcileAdoptsRuntimePendingBroadcast() {
    console.log('\n[UNC-008b] _reconcileAfterUncertainBroadcast adopts runtime pending CREATEs...');
    const bot = makeBot();
    const slotId = 'sell-11';
    const plannedSell = 120000000;
    const plannedReceive = 6000000;
    const chainSnapshot = [makeChainOrder('1.7.572312011', 'sell', plannedSell, plannedReceive)];
    let readCalls = 0;
    let syncCalls = 0;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 1.2 });
    bot.manager.synchronizeWithChain = async (params) => {
        syncCalls++;
        assert.strictEqual(params.gridOrderId, slotId);
        assert.strictEqual(params.chainOrderId, '1.7.572312011');
        assert.strictEqual(params.expectedType, 'sell');
    };
    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: slotId, type: 'sell', price: 0.05, size: 1.2 },
        finalInts: { sell: plannedSell, receive: plannedReceive }
    });
    chainOrders.readOpenOrdersWithMeta = async (accountRef) => {
        readCalls++;
        assert.strictEqual(accountRef, 'test-account');
        return { orders: chainSnapshot, truncated: false };
    };

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }],
                accountName: 'test-account',
                batchId: 'batch-adopt',
                timeoutMs: 30000
            }),
            [{ kind: 'create', id: slotId }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 1, 'matching chain order should be adopted');
        assert.strictEqual(result.discardedCount, 0);
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 0, 'pending broadcasts must be cleared after recovery');
        assert.strictEqual(readCalls, 1, 'uncertain broadcast recovery reads chain orders once');
        assert.strictEqual(syncCalls, 1, 'synchronizeWithChain must be called for each adopted CREATE');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-008b passed');
}

async function testReconcileReadFailureRequestsStructuralResync() {
    console.log('\n[UNC-008c] _reconcileAfterUncertainBroadcast requests structural resync on read failure...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let resyncReason = null;
    let resyncMeta = null;
    bot.manager.requestStructuralGridResync = async (reason, meta) => {
        resyncReason = reason;
        resyncMeta = meta;
    };
    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: 'sell-12', type: 'sell', price: 0.05, size: 1.2 },
        finalInts: { sell: 120000000, receive: 6000000 }
    });
    chainOrders.readOpenOrdersWithMeta = async () => {
        throw new Error('read failed');
    };

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', { batchId: 'batch-read-fail', timeoutMs: 30000 }),
            [{ kind: 'create', id: 'sell-12' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.executed, false);
        assert.strictEqual(resyncReason, 'broadcast uncertain — readOpenOrders failed');
        assert.strictEqual(resyncMeta.batchId, 'batch-read-fail');
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 0, 'pending broadcasts must clear on fallback resync');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-008c passed');
}

async function testReconcileAcquiresFillLock() {
    console.log('\n[UNC-008c2] _reconcileAfterUncertainBroadcast acquires fill lock before syncing...');
    const bot = makeBot();
    const slotId = 'sell-lock';
    const plannedSell = 120000000;
    const plannedReceive = 6000000;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let lockAcquireCalls = 0;
    let insideLock = false;
    let syncCalls = 0;

    bot.manager._fillProcessingLock = {
        acquire: async (fn) => {
            if (insideLock) return fn();
            lockAcquireCalls++;
            insideLock = true;
            try {
                return await fn();
            } finally {
                insideLock = false;
            }
        },
        isReentrant: () => insideLock,
    };
    bot.manager.synchronizeWithChain = async (params) => {
        syncCalls++;
        assert.strictEqual(insideLock, true, 'recovery sync must run while fill lock is held');
    };
    bot._recordPendingBroadcast({
        opIndex: 0,
        ctxIndex: 0,
        order: { id: slotId, type: 'sell', price: 0.05, size: 1.2 },
        finalInts: { sell: plannedSell, receive: plannedReceive }
    });
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.572312012', 'sell', plannedSell, plannedReceive)],
        truncated: false
    });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', { batchId: 'batch-lock', timeoutMs: 30000 }),
            [{ kind: 'create', id: slotId }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(lockAcquireCalls, 1, 'recovery should acquire the fill lock once');
        assert.strictEqual(syncCalls, 1, 'synchronizeWithChain must be called for each adopted CREATE');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-008c2 passed');
}

async function testCowBatchAdvancesCycleMarker() {
    console.log('\n[UNC-008d] COW batch attempts advance the auto-cancel cycle marker...');
    const bot = makeBot();
    bot.config.dryRun = true;
    const startCycle = bot._currentCycleId;
    const cowResult = {
        workingGrid: new WorkingGrid(bot.manager.orders, { baseVersion: 0 }),
        workingIndexes: {},
        workingBoundary: 0,
        actions: [{ type: COW_ACTIONS.CANCEL, id: 'sell-1', orderId: '1.7.1' }]
    };
    const r1 = await bot._updateOrdersOnChainBatchCOW(cowResult);
    const r2 = await bot._updateOrdersOnChainBatchCOW(cowResult);
    assert.strictEqual(r1.executed, true);
    assert.strictEqual(r2.executed, true);
    assert.strictEqual(bot._currentCycleId, startCycle + 2, 'each COW batch attempt must advance cycle id');
    console.log('✓ UNC-008d passed');
}

async function testCredentialClientDeadlineReplyBecomesUncertain() {
    console.log('\n[UNC-008e] credential client converts BROADCAST_DEADLINE replies to BroadcastUncertainError...');
    const operations = [{ op_name: 'limit_order_create', op_data: { amount_to_sell: 1 } }];
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        assert.strictEqual(request.type, 'execute-operations');
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner broadcast deadline exceeded' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                batchId: 'batch-deadline',
                timeoutMs: 1000
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
                assert.strictEqual(err.batchId, 'batch-deadline');
                assert.strictEqual(err.accountName, 'test-account');
                assert.deepStrictEqual(err.operations, operations);
                return true;
            }
        );
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008e passed');
}

async function testCredentialClientBroadcastTimeoutBecomesUncertain() {
    console.log('\n[UNC-008f] credential client broadcast socket timeout is uncertain...');
    const operations = [{ op_name: 'limit_order_create', op_data: { amount_to_sell: 1 } }];
    const transport = installFakeCredentialDaemonTransport(() => {
        // Intentionally keep the socket open so the client-side timeout fires.
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                batchId: 'batch-timeout',
                timeoutMs: 25
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.batchId, 'batch-timeout');
                assert.strictEqual(err.timeoutMs, 25);
                return true;
            }
        );
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008f passed');
}

async function testCredentialClientFallbackRetrySucceeds() {
    console.log('\n[UNC-008i-1] credential client DEADLINE → throws immediately, NO fallback re-send (duplicate-order protection)...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.1' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
                return true;
            }
        );
        assert.strictEqual(requestCount, 1, 'Must NOT re-send: the broadcast may have landed and re-sending duplicates on-chain orders');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-1 passed');
}

async function testCredentialClientFallbackRetryExhausted() {
    console.log('\n[UNC-008i-2] credential client DEADLINE → throws immediately after a single attempt...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.2' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.code, 'BROADCAST_UNCERTAIN');
                return true;
            }
        );
        assert.strictEqual(requestCount, 1, 'Single attempt only: recovery layers verify chain inclusion before any re-broadcast');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-2 passed');
}

async function testCredentialClientFallbackSkipsPlainError() {
    console.log('\n[UNC-008i-3] credential client: plain Error → no retry...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.3' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, error: DAEMON_ERRORS.SESSION_EXPIRED + ':session expired' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
            }),
            (err) => {
                assert(!(err instanceof BroadcastUncertainError));
                assert(err.message.includes(DAEMON_ERRORS.SESSION_EXPIRED));
                return true;
            }
        );
        assert.strictEqual(requestCount, 1, 'Should not retry on plain errors');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-3 passed');
}

async function testCredentialClientFallbackEmptyList() {
    console.log('\n[UNC-008i-4] credential client: single uncertain broadcast → no retry (regression guard)...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.4' } }];
    let requestCount = 0;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
            }),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                return true;
            }
        );
        assert.strictEqual(requestCount, 1, 'A single uncertain broadcast must not retry');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-4 passed');
}

async function testCredentialClientFallbackReportsFailedNode() {
    console.log('\n[UNC-008i-5] credential client DEADLINE → single attempt, onNodeFailed never fires without an explicit nodeUrl...');
    const operations = [{ op_name: 'limit_order_cancel', op_data: { order: '1.7.5' } }];
    let requestCount = 0;
    const failedNodes: string[] = [];
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner deadline' });
    });
    try {
        await assert.rejects(
            () => executeOperationsViaCredentialDaemon('test-account', operations, {
                socketPath: transport.socketPath,
                requestType: 'broadcast',
                timeoutMs: 100,
                onNodeFailed: (nodeUrl) => { failedNodes.push(nodeUrl); },
            }),
            (err) => err instanceof BroadcastUncertainError
        );
        assert.strictEqual(requestCount, 1, 'Single attempt: uncertain broadcasts must not be re-sent');
        assert.strictEqual(failedNodes.length, 0, 'onNodeFailed must never fire without an explicit nodeUrl (no fallback cycling to blame)');
    } finally {
        transport.restore();
    }
    console.log('✓ UNC-008i-5 passed');
}

async function testExecuteBatchDoesNotRetryUncertainDaemonBroadcast() {
    console.log('\n[UNC-008g] chain_orders.executeBatch does not retry uncertain daemon broadcasts...');
    let requestCount = 0;
    let probeCalls = 0;
    const origProbe = chainKeys.probeAccountInDaemon;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner broadcast deadline exceeded' });
    });
    const token = chainKeys.createDaemonSigningToken('test-account', {
        socketPath: transport.socketPath,
        sessionId: 'session-1'
    });

    chainKeys.probeAccountInDaemon = async () => {
        probeCalls++;
        return 'session-2';
    };

    try {
        await assert.rejects(
            () => chainOrders.executeBatch('test-account', token, [{ op_name: 'limit_order_create', op_data: {} }]),
            (err) => err instanceof BroadcastUncertainError
        );
        assert.strictEqual(requestCount, 1, 'uncertain broadcast must not be retried');
        assert.strictEqual(probeCalls, 0, 'uncertain broadcast must not renegotiate daemon session');
    } finally {
        chainKeys.probeAccountInDaemon = origProbe;
        transport.restore();
    }
    console.log('✓ UNC-008g passed');
}

async function testExecuteBatchRetriesExpiredDaemonSessionOnly() {
    console.log('\n[UNC-008h] chain_orders.executeBatch still retries expired daemon sessions...');
    let requestCount = 0;
    let probeCalls = 0;
    const origProbe = chainKeys.probeAccountInDaemon;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        if (requestCount === 1) {
            socket.endLine({ success: false, error: 'invalid or expired session' });
        } else {
            assert.strictEqual(request.sessionId, 'session-2', 'retry should use renegotiated session');
            socket.endLine({ success: true, raw: { ok: true }, operation_results: [['1', '1.7.1']] });
        }
    });
    const token = chainKeys.createDaemonSigningToken('test-account', {
        socketPath: transport.socketPath,
        sessionId: 'session-1'
    });

    chainKeys.probeAccountInDaemon = async (accountName) => {
        probeCalls++;
        assert.strictEqual(accountName, 'test-account');
        return 'session-2';
    };

    try {
        const result = await chainOrders.executeBatch('test-account', token, [{ op_name: 'limit_order_create', op_data: {} }]);
        assert.strictEqual(result.success, true);
        assert.strictEqual(requestCount, 2, 'expired session should retry exactly once');
        assert.strictEqual(probeCalls, 1, 'expired session should renegotiate once');
        assert.strictEqual(token.sessionId, 'session-2', 'token should be updated in place');
    } finally {
        chainKeys.probeAccountInDaemon = origProbe;
        transport.restore();
    }
    console.log('✓ UNC-008h passed');
}

async function testExecuteBatchRetryPreservesUncertainBroadcastHandling() {
    console.log('\n[UNC-008i] expired-session retry still treats BROADCAST_DEADLINE as uncertain...');
    let requestCount = 0;
    const origProbe = chainKeys.probeAccountInDaemon;
    const transport = installFakeCredentialDaemonTransport((request, socket) => {
        requestCount++;
        if (requestCount === 1) {
            socket.endLine({ success: false, error: 'invalid or expired session' });
        } else {
            assert.strictEqual(request.sessionId, 'session-2', 'retry should use renegotiated session');
            socket.endLine({ success: false, code: DAEMON_CODES.BROADCAST_DEADLINE, error: 'inner broadcast deadline exceeded on retry' });
        }
    });
    const token = chainKeys.createDaemonSigningToken('test-account', {
        socketPath: transport.socketPath,
        sessionId: 'session-1'
    });
    token.batchId = 'batch-retry-deadline';

    chainKeys.probeAccountInDaemon = async () => 'session-2';

    try {
        await assert.rejects(
            () => chainOrders.executeBatch('test-account', token, [{ op_name: 'limit_order_create', op_data: {} }]),
            (err) => {
                assert(err instanceof BroadcastUncertainError);
                assert.strictEqual(err.batchId, 'batch-retry-deadline');
                return true;
            }
        );
        assert.strictEqual(requestCount, 2, 'expired session should retry once before uncertain failure');
    } finally {
        chainKeys.probeAccountInDaemon = origProbe;
        transport.restore();
    }
    console.log('✓ UNC-008i passed');
}

function makeBot() {
    const DEXBot = require('../modules/dexbot_class').default;
    const bot = new DEXBot({
        botKey: 'test_uncertain_broadcast',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders: new Map(),
        _gridVersion: 0,
        _fundLock: { acquire: async (fn) => fn(), isLocked: () => false, isReentrant: () => false },
        logger: {
            log: (msg, level) => { /* noop */ },
            logFundsStatus: () => {}
        },
        requestStructuralGridResync: async () => {},
        _lastUnmatchedChainOrders: [],
        _pendingBroadcasts: new Map(),
        lockOrders: () => {},
        unlockOrders: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _clearWorkingGridRef: () => {},
        _throwOnIllegalState: false
    };
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    bot._currentCycleId = 1;
    return bot;
}

async function testCowCatchBlockPassesFillLockAlreadyHeld() {
    console.log('\n[UNC-012] _updateOrdersOnChainBatchCOW recovery path...');
    const bot = makeBot();
    const slotId = 'slot-unc-012';
    const actionOrderId = '1.7.999999';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origReadOpenOrders = chainOrders.readOpenOrders;
    const origExecuteBatch = chainOrders.executeBatch;

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId });
    bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 1000, chainFreeBuy: 1000 });
    bot.manager.synchronizeWithChain = async () => {};
    bot.manager.applyGridUpdateBatch = async () => {};
    bot.manager.persistGrid = async () => {};

    chainOrders.buildUpdateOrderOp = async (account, orderId, delta, rawOnChain) => ({
        op: { op_name: 'limit_order_update', op_data: { new_price: { base: { asset_id: '1.3.0', amount: 100 } } } },
        finalInts: { sell: 100, receive: 1 }
    });

    chainOrders.executeBatch = async () => {
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-012', timeoutMs: 30000 });
    };
    chainOrders.readOpenOrders = async () => [];

    const cowResult = {
        workingGrid: new WorkingGrid(bot.manager.orders, { baseVersion: 0 }),
        workingIndexes: {},
        workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: slotId,
            orderId: actionOrderId,
            newSize: 100,
            order: { type: 'sell', price: 0.05, size: 100 }
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert(result.uncertain === true, 'uncertain broadcast must trigger recovery path');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.readOpenOrders = origReadOpenOrders;
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-012 passed');
}

async function testExecuteWithRetryOnUncertainRetriesOnce() {
    console.log('\n[UNC-013] _executeWithRetryOnUncertain does NOT retry without verifiable absence (duplicate protection)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    let callCount = 0;

    chainOrders.executeBatch = async () => {
        callCount++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013', timeoutMs: 30000 });
    };

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([], []),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                // opContexts=[] carries no operations to verify absence for (and
                // the verification read fails in this environment anyway), so
                // the batch must NOT be re-broadcast — an uncertain broadcast
                // may have landed and a blind retry would duplicate on-chain
                // orders.
                assert.strictEqual(callCount, 1, 'must NOT re-broadcast without verified absence');
                return true;
            }
        );
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-013 passed');
}

async function testExecuteWithRetryOnVerifiedAbsence() {
    console.log('\n[UNC-013b] _executeWithRetryOnUncertain retries ONLY on authoritative absence (non-empty non-truncated read, no match)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const createCtx = {
        kind: 'create',
        id: 'slot-buy-1',
        order: { id: 'slot-buy-1', type: 'buy' },
        finalInts: { sell: 5000000, receive: 100000000 }
    };

    chainOrders.executeBatch = async () => {
        callCount++;
        if (callCount === 1) {
            throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013b', timeoutMs: 30000 });
        }
        return { success: true, operation_results: [] };
    };
    // Authoritative absence: a non-empty, non-truncated read that contains NONE
    // of the batch's creates (an unrelated order with far-off amounts).
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [{
            id: '1.7.700001',
            type: 'buy',
            sellInt: 999999999,
            receiveInt: 999999999
        }],
        truncated: false
    });

    try {
        const result = await bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_create' }], [createCtx]);
        assert.ok(result?.result?.success, 'retry after verified absence must succeed');
        assert.strictEqual(callCount, 2, 'must re-broadcast exactly once after verified absence');
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013b passed');
}

async function testExecuteWithRetryOnLandedCreate() {
    console.log('\n[UNC-013c] _executeWithRetryOnUncertain does NOT retry when a create is confirmed landed on chain...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const createCtx = {
        kind: 'create',
        id: 'slot-buy-1',
        order: { id: 'slot-buy-1', type: 'buy' },
        finalInts: { sell: 5000000, receive: 100000000 }
    };

    chainOrders.executeBatch = async () => {
        callCount++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013c', timeoutMs: 30000 });
    };
    // The create landed: the chain read contains the batch's own order
    // (matching sell/receive within tolerance).
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [{
            id: '1.7.700002',
            type: 'buy',
            sellInt: 5000000,
            receiveInt: 100000000
        }],
        truncated: false
    });

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_create' }], [createCtx]),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 1, 'must NOT re-broadcast a create that is already on chain');
                return true;
            }
        );
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013c passed');
}

async function testExecuteWithRetryOnTruncatedRead() {
    console.log('\n[UNC-013d] _executeWithRetryOnUncertain does NOT retry on a truncated read (capped result set is not authoritative absence)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const createCtx = {
        kind: 'create',
        id: 'slot-buy-1',
        order: { id: 'slot-buy-1', type: 'buy' },
        finalInts: { sell: 5000000, receive: 100000000 }
    };

    chainOrders.executeBatch = async () => {
        callCount++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013d', timeoutMs: 30000 });
    };
    // Truncated read (get_full_accounts capped limit_orders, e.g. default 500):
    // non-empty, but none of the batch's creates visible. Fresh creates sort
    // last in the by_account index and are the FIRST entries a capped read
    // omits — this must be 'unknown', NOT verified absence, or the
    // re-broadcast could duplicate orders that actually landed.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [{
            id: '1.7.700001',
            type: 'buy',
            sellInt: 999999999,
            receiveInt: 999999999
        }],
        truncated: true
    });

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_create' }], [createCtx]),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 1, 'must NOT re-broadcast on a truncated read (may be false absence)');
                return true;
            }
        );
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013d passed');
}

// ── Per-kind retry verification: CANCEL ─────────────────────────────────
// A cancel's absence on chain means the cancel LANDED — re-broadcasting is a
// guaranteed failure, so it must defer. An order still present means the
// cancel never landed — retry is safe.
async function testRetryVerificationForCancelLandedDefers() {
    console.log('\n[UNC-013h] _executeWithRetryOnUncertain does NOT re-broadcast a CANCEL whose order is absent (cancel landed)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const cancelCtx = { kind: 'cancel', order: { id: 'slot-sell-1', orderId: '1.7.500', type: 'sell' } };

    chainOrders.executeBatch = async () => {
        callCount++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013h', timeoutMs: 30000 });
    };
    // The cancelled order is ABSENT from a live non-empty snapshot → the cancel
    // landed → re-broadcasting would fail (order does not exist) → defer.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.401', 'buy', 4000000, 80000000)],
        truncated: false
    });

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_cancel' }], [cancelCtx]),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 1, 'must NOT re-broadcast a cancel that already landed');
                return true;
            }
        );
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013h passed');
}

async function testRetryVerificationForCancelStillPresentRetries() {
    console.log('\n[UNC-013i] _executeWithRetryOnUncertain retries a CANCEL whose order is still present (never landed)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const cancelCtx = { kind: 'cancel', order: { id: 'slot-sell-1', orderId: '1.7.500', type: 'sell' } };

    chainOrders.executeBatch = async () => {
        callCount++;
        if (callCount === 1) {
            throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013i', timeoutMs: 30000 });
        }
        return { success: true, operation_results: [] };
    };
    // The cancelled order is STILL on chain → the cancel never landed →
    // re-broadcasting the identical cancel is safe.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.500', 'sell', 100000000, 5000000)],
        truncated: false
    });

    try {
        const result = await bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_cancel' }], [cancelCtx]);
        assert.ok(result?.result?.success, 'retry after verified-unlanded cancel must succeed');
        assert.strictEqual(callCount, 2, 'must re-broadcast exactly once when the order is still present');
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013i passed');
}

// ── Per-kind retry verification: UPDATE (limit_order_update is a DELTA) ──
// Re-broadcasting a landed update double-applies the size change, so a retry
// is only safe when the chain order provably still matches the pre-update
// cache the delta was built from. Any other state defers.
function makeUpdateCtx(chainOrderId: any, cachedRaw: any) {
    return {
        kind: 'size-update',
        updateInfo: {
            partialOrder: { id: 'slot-sell-1', orderId: chainOrderId, type: 'sell', rawOnChain: cachedRaw },
            newSize: 5
        },
        finalInts: { sell: 50000000, receive: 2500000 }
    };
}

async function testRetryVerificationForUpdateUnchangedRetries() {
    console.log('\n[UNC-013j] _executeWithRetryOnUncertain retries an UPDATE whose chain order is provably unchanged (delta re-apply is safe)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const cachedRaw = {
        id: '1.7.600',
        for_sale: '100000000',
        sell_price: { base: { amount: '100000000', asset_id: '1.3.0' }, quote: { amount: '5000000', asset_id: '1.3.121' } }
    };
    const updateCtx = makeUpdateCtx('1.7.600', cachedRaw);

    chainOrders.executeBatch = async () => {
        callCount++;
        if (callCount === 1) {
            throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013j', timeoutMs: 30000 });
        }
        return { success: true, operation_results: [] };
    };
    // Chain order matches the pre-update cache exactly → the update never
    // applied → re-applying the identical delta reaches the same target.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.600', 'sell', 100000000, 5000000)],
        truncated: false
    });

    try {
        const result = await bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_update' }], [updateCtx]);
        assert.ok(result?.result?.success, 'retry after verified-unchanged update must succeed');
        assert.strictEqual(callCount, 2, 'must re-broadcast exactly once when the order is provably unchanged');
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013j passed');
}

async function testRetryVerificationForUpdateLandedDefers() {
    console.log('\n[UNC-013k] _executeWithRetryOnUncertain does NOT re-broadcast an UPDATE that already applied (delta would double-apply)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const cachedRaw = {
        id: '1.7.600',
        for_sale: '100000000',
        sell_price: { base: { amount: '100000000', asset_id: '1.3.0' }, quote: { amount: '5000000', asset_id: '1.3.121' } }
    };
    const updateCtx = makeUpdateCtx('1.7.600', cachedRaw);

    chainOrders.executeBatch = async () => {
        callCount++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013k', timeoutMs: 30000 });
    };
    // Chain order shows the TARGET state (finalInts) → the update landed →
    // re-broadcasting the delta would double-apply the size change → defer.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.600', 'sell', 50000000, 2500000)],
        truncated: false
    });

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_update' }], [updateCtx]),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 1, 'must NOT re-broadcast an update that already applied');
                return true;
            }
        );
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013k passed');
}

async function testRetryVerificationForUpdateMissingDefers() {
    console.log('\n[UNC-013l] _executeWithRetryOnUncertain does NOT re-broadcast an UPDATE whose order is missing from the snapshot (ambiguous)...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    let callCount = 0;

    const cachedRaw = {
        id: '1.7.600',
        for_sale: '100000000',
        sell_price: { base: { amount: '100000000', asset_id: '1.3.0' }, quote: { amount: '5000000', asset_id: '1.3.121' } }
    };
    const updateCtx = makeUpdateCtx('1.7.600', cachedRaw);

    chainOrders.executeBatch = async () => {
        callCount++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013l', timeoutMs: 30000 });
    };
    // The order is missing entirely — it may have filled or been cancelled
    // concurrently; a re-applied delta on a vanished order cannot be verified.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.401', 'buy', 4000000, 80000000)],
        truncated: false
    });

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([{ op_name: 'limit_order_update' }], [updateCtx]),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 1, 'must NOT re-broadcast an update whose order is missing (ambiguous)');
                return true;
            }
        );
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-013l passed');
}

async function testExecuteWithRetrySkipsPartialOnChainState() {
    console.log('\n[UNC-014] _executeWithRetryOnUncertain skips retry when partialOnChainState is set...');
    const bot = makeBot();
    const origExecuteBatch = chainOrders.executeBatch;
    let callCount = 0;

    chainOrders.executeBatch = async () => {
        callCount++;
        const err = new BroadcastUncertainError('uncertain', { batchId: 'unc-014', timeoutMs: 30000 });
        err.partialOnChainState = true;
        err.groupsBroadcast = 1;
        err.groupsTotal = 2;
        throw err;
    };

    try {
        await assert.rejects(
            () => bot._executeWithRetryOnUncertain([], []),
            (err) => {
                assert(err instanceof BroadcastUncertainError, 'must throw BroadcastUncertainError');
                assert.strictEqual(callCount, 1, 'must NOT retry when partialOnChainState is true');
                assert.strictEqual(err.partialOnChainState, true);
                return true;
            }
        );
    } finally {
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-014 passed');
}

// ── Startup create: verification-gated retry (duplicate protection) ─────
async function testStartupCreateDeferredOnTruncatedRead() {
    console.log('\n[UNC-013e] startup create defers re-broadcast when the verification read is truncated...');
    const bot = makeBot();
    const origCreateOrder = chainOrders.createOrder;
    const origReadMeta = chainOrders.readOpenOrdersWithMeta;
    let createCalls = 0;

    chainOrders.createOrder = async () => {
        createCalls++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013e', timeoutMs: 30000 });
    };
    // A truncated read may omit the just-landed create (by_account index order) —
    // absence in a capped snapshot is not authoritative.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.999999998', 'buy', 100000000, 5000000)],
        truncated: true
    });

    try {
        const result = await _createStartupOrderWithHandling({
            chainOrders,
            account: bot.account,
            privateKey: bot.privateKey,
            manager: bot.manager,
            gridOrder: { id: 'slot-unc-013e', price: 1000, size: 3.8179, type: 'sell', state: 'VIRTUAL', orderId: null },
            orderLabel: 'SELL:slot-unc-013e',
            dryRun: false,
            recovery: false
        });
        assert.strictEqual(result, null, 'must NOT return an order id on an unverifiable (truncated) read');
        assert.strictEqual(createCalls, 1, 'must NOT re-broadcast on a truncated read — a landed order would be duplicated');
    } finally {
        chainOrders.createOrder = origCreateOrder;
        chainOrders.readOpenOrdersWithMeta = origReadMeta;
    }
    console.log('✓ UNC-013e passed');
}

async function testStartupCreateRetriesOnAuthoritativeAbsence() {
    console.log('\n[UNC-013f] startup create re-broadcasts only on authoritative absence (non-empty, non-truncated read)...');
    const bot = makeBot();
    bot.manager._applySync = async () => {};
    const origCreateOrder = chainOrders.createOrder;
    const origReadMeta = chainOrders.readOpenOrdersWithMeta;
    let createCalls = 0;

    chainOrders.createOrder = async () => {
        createCalls++;
        if (createCalls === 1) {
            throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013f', timeoutMs: 30000 });
        }
        return { operation_results: [[1, '1.7.888888888']] };
    };
    // Non-truncated, non-empty read containing no matching SELL: authoritative absence.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.999999997', 'buy', 100000000, 5000000)],
        truncated: false
    });

    try {
        const result = await _createStartupOrderWithHandling({
            chainOrders,
            account: bot.account,
            privateKey: bot.privateKey,
            manager: bot.manager,
            gridOrder: { id: 'slot-unc-013f', price: 1000, size: 3.8179, type: 'sell', state: 'VIRTUAL', orderId: null },
            orderLabel: 'SELL:slot-unc-013f',
            dryRun: false,
            recovery: false
        });
        assert.strictEqual(createCalls, 2, 'must retry exactly once on authoritative absence');
        assert.strictEqual(result, '1.7.888888888', 'retry should return the chain order id');
    } finally {
        chainOrders.createOrder = origCreateOrder;
        chainOrders.readOpenOrdersWithMeta = origReadMeta;
    }
    console.log('✓ UNC-013f passed');
}

async function testStartupCreateAdoptsLandedOrder() {
    console.log('\n[UNC-013g] startup create adopts the landed order instead of re-broadcasting...');
    const bot = makeBot();
    bot.manager.syncFromOpenOrders = async () => {};
    bot.manager._applySync = async () => {};
    const origCreateOrder = chainOrders.createOrder;
    const origReadMeta = chainOrders.readOpenOrdersWithMeta;
    let createCalls = 0;

    chainOrders.createOrder = async () => {
        createCalls++;
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-013g', timeoutMs: 30000 });
    };
    // The create actually landed: 3.8179 BTS for 3817.9 USD → price 1000, size 3.8179.
    const landed = makeChainOrder('1.7.999999999', 'sell', 381790000, 381790000);
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [landed],
        truncated: false
    });

    try {
        const result = await _createStartupOrderWithHandling({
            chainOrders,
            account: bot.account,
            privateKey: bot.privateKey,
            manager: bot.manager,
            gridOrder: { id: 'slot-unc-013g', price: 1000, size: 3.8179, type: 'sell', state: 'VIRTUAL', orderId: null },
            orderLabel: 'SELL:slot-unc-013g',
            dryRun: false,
            recovery: false
        });
        assert.strictEqual(createCalls, 1, 'must NOT re-broadcast when the create is confirmed landed');
        assert.strictEqual(result, '1.7.999999999', 'must adopt the landed order id');
    } finally {
        chainOrders.createOrder = origCreateOrder;
        chainOrders.readOpenOrdersWithMeta = origReadMeta;
    }
    console.log('✓ UNC-013g passed');
}

async function main() {
    console.log('Running uncertain-broadcast recovery tests...');
    await testFingerprintDeterministic();
    await testFingerprintRejectsBadInput();
    await testBroadcastUncertainErrorCarriesMetadata();
    await testExactChainOrderMatchIsAdopted();
    await testRecordedPendingBroadcastStoresSlotId();
    await testNoChainMatchIsDiscarded();
    await testNearMatchWithinToleranceIsAdopted();
    await testOutsideToleranceIsNotAdopted();
    await testNearMatchUsesPendingSideWhenGridSlotMissing();
    await testBroadcastUncertainErrorIsNotRetried();
    await testReconcileAdoptsRuntimePendingBroadcast();
    await testReconcileReadFailureRequestsStructuralResync();
    await testReconcileAcquiresFillLock();
    await testCowBatchAdvancesCycleMarker();
    await testCredentialClientDeadlineReplyBecomesUncertain();
    await testCredentialClientBroadcastTimeoutBecomesUncertain();
    await testCredentialClientFallbackRetrySucceeds();
    await testCredentialClientFallbackRetryExhausted();
    await testCredentialClientFallbackSkipsPlainError();
    await testCredentialClientFallbackEmptyList();
    await testCredentialClientFallbackReportsFailedNode();
    await testCowCatchBlockPassesFillLockAlreadyHeld();
    await testExecuteWithRetryOnUncertainRetriesOnce();
    await testExecuteWithRetryOnVerifiedAbsence();
    await testExecuteWithRetryOnLandedCreate();
    await testExecuteWithRetryOnTruncatedRead();
    await testRetryVerificationForCancelLandedDefers();
    await testRetryVerificationForCancelStillPresentRetries();
    await testRetryVerificationForUpdateUnchangedRetries();
    await testRetryVerificationForUpdateLandedDefers();
    await testRetryVerificationForUpdateMissingDefers();
    await testExecuteWithRetrySkipsPartialOnChainState();
    await testStartupCreateDeferredOnTruncatedRead();
    await testStartupCreateRetriesOnAuthoritativeAbsence();
    await testStartupCreateAdoptsLandedOrder();
    await testUpdateToCreateFallbackOnNotFound();
    await testUpdateToCreateFallbackRotationBranch();
    await testUpdateToCreateFallbackCreateAlsoFails();
    await testRecoverFromPersistedGrid();
    await testRecoverFromPersistedGridNoGrid();
    await testRecoverFromPersistedGridBloated();
    await testRecoverFromPersistedGridUnmatchedRemain();
    await testRecoverFromPersistedGridOutOfGridHold();
    await testRecoverFromPersistedGridTruncatedRead();
    await testBoundaryShiftAllDiscarded();
    await testBoundaryShiftMixedAdoptedDiscarded();
    await testBoundaryShiftAllAdopted();
    await testBoundaryShiftTruncatedRead();
    await testReReadLateAdoptsDiscardedCreate();
    await testPollConfirmationAdoptsPlacedBatch();
    await testAdoptionZeroFeeFallbackWithoutFeeCache();
    testsComplete = true;
    console.log('\nAll uncertain-broadcast tests passed (incl. retry + deadlock regression guards).');
}

// ── daemon-path direct executeBatch tests (real chain_orders orchestration) ─
async function runDaemonStageTests() {
    await testExecuteBatchDoesNotRetryUncertainDaemonBroadcast();
    await testExecuteBatchRetriesExpiredDaemonSessionOnly();
    await testExecuteBatchRetryPreservesUncertainBroadcastHandling();
    testsComplete = true;
    console.log('\nAll daemon executeBatch tests passed.');
}

function registerStageMocks(stage: string) {
    defineEsmMockAbs(
        require.resolve('../modules/bitshares_client'),
        BITSHARES_CLIENT_NAMES,
        makeBitsharesClientDefaults()
    );
    chainKeys = makeSwappableModule(CHAIN_KEYS_DEFAULTS);
    defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
        'validatePrivateKey', 'loadAccounts', 'saveAccounts', 'checkKeysFileSecurity',
        'encrypt', 'decrypt', 'deriveVaultKey', 'createDaemonSigningToken',
        'createSessionSecret', 'createVaultSecret', 'isVaultSecret', 'isDaemonSigningToken',
        'unlockWithPassword', 'main', 'authenticate', 'getPrivateKey', 'resolvePrivateKey',
        'isMasterPasswordFailure', 'MasterPasswordError', 'isDaemonReady', 'isDaemonResponsive',
        'waitForDaemon', 'probeAccountInDaemon', 'pingDaemon'
    ], chainKeys);

    if (stage === 'cow') {
        // bot-level flows bind to this swappable stand-in; direct
        // chain_orders.executeBatch coverage lives in the daemon stage.
        chainOrders = makeSwappableModule({
            BroadcastUncertainError,
            selectAccount: async () => {},
            setPreferredAccount: async () => {},
            resolveAccountId: async () => null,
            resolveAccountName: async () => null,
            readOpenOrders: async () => [],
            readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
            readOpenOrdersWithMetaSafe: readWithMetaSafe,
            readOpenOrdersGuarded: readGuarded,
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
        defineEsmMockAbs(require.resolve('../modules/chain_orders'), CHAIN_ORDERS_NAMES, chainOrders);
    } else {
        chainOrders = require('../modules/chain_orders');
    }
}

runEsmMockStages(['cow', 'daemon'], async (stage) => {
    ensureFeeCache();
    registerStageMocks(stage);
    requireProdModules();
    if (stage === 'cow') {
        await main();
    } else {
        await runDaemonStageTests();
    }
});

/**
 * Ladder for the shared 2-slot recovery fixture (prices 0.04 / 0.06). Real
 * snapshots always persist their ladder and loadGrid refuses one that lacks it
 * (genesis invariant), so recovery fixtures must supply it.
 */
function recoveryFixtureLadder() {
    return require('../modules/order/utils/math').buildGenesisFromPriceLevels(0.05, 1, 1, [0.04, 0.06]);
}

// ── UPDATE→CREATE fallback: size-update branch ──────────────────────────
async function testUpdateToCreateFallbackOnNotFound() {
    console.log('\n[UNC-015] UPDATE→CREATE fallback on "not found" (size-update branch)...');
    const bot = makeBot();
    const slotId = 'slot-unc-015';
    const actionOrderId = '1.7.999015';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origBuildCreate = chainOrders.buildCreateOrderOp;
    const origExecuteBatch = chainOrders.executeBatch;
    let loggedWarn = null;
    let capturedCreateArgs = null;

    bot.manager.orders.set(slotId, {
        id: slotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId
    });
    bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 1000, chainFreeBuy: 1000 });
    bot.manager.synchronizeWithChain = async () => {};
    bot.manager.applyGridUpdateBatch = async () => {};
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._commitWorkingGrid = async () => true;
    // Capture ALL warns: the batch-level LAST-FILL-GUARD summary also warns
    // on a cold guard (intentional — disabled guard must say so) and fires
    // after the recovery line. Last-wins capture would hide the recovery
    // warning; assert on the full sequence instead (stub-class fix: the
    // production summary behavior is correct, the stub's lens was too narrow).
    const allWarns: string[] = [];
    bot.manager.logger.log = (msg, level) => {
        if (level === 'warn') { loggedWarn = msg; allWarns.push(String(msg)); }
    };

    chainOrders.buildUpdateOrderOp = async () => { throw new Error('Order 1.7.999015 not found'); };
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        capturedCreateArgs = { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        return {
            op: { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: Number(amountToSell), asset_id: sellAssetId } } },
            finalInts: { sell: Number(amountToSell), receive: Number(minToReceive), sellAssetId, receiveAssetId }
        };
    };
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[null, '1.7.999016']]
    });

    const cowResult = {
        workingGrid: new WorkingGrid(bot.manager.orders, { baseVersion: 0 }), workingIndexes: {}, workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: slotId, orderId: actionOrderId,
            newSize: 100,
            order: { type: 'sell', price: 0.05, size: 100 }
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert.strictEqual(result.executed, true, 'UPDATE→CREATE fallback should produce a valid CREATE op and execute it');
        assert(capturedCreateArgs, 'buildCreateOrderOp fallback must be called when UPDATE fails with "not found"');
        assert(allWarns.some((w) => w.includes('Recovered "not found"')),
            'should log the recovery warning');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.buildCreateOrderOp = origBuildCreate;
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-015 passed');
}

// ── UPDATE→CREATE fallback: rotation branch ─────────────────────────────
async function testUpdateToCreateFallbackRotationBranch() {
    console.log('\n[UNC-015b] UPDATE→CREATE fallback on "not found" (rotation branch, newGridId !== id)...');
    const bot = makeBot();
    const oldSlotId = 'slot-unc-015b-old';
    const newSlotId = 'slot-unc-015b-new';
    const actionOrderId = '1.7.999015b';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origBuildCreate = chainOrders.buildCreateOrderOp;
    const origExecuteBatch = chainOrders.executeBatch;
    let capturedCreateArgs = null;

    bot.manager.orders.set(oldSlotId, { id: oldSlotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId });
    bot.manager.orders.set(newSlotId, { id: newSlotId, type: 'sell', price: 0.06, size: 90 });
    bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 1000, chainFreeBuy: 1000 });
    bot.manager.synchronizeWithChain = async () => {};
    bot.manager.applyGridUpdateBatch = async () => {};
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._commitWorkingGrid = async () => true;

    chainOrders.buildUpdateOrderOp = async () => { throw new Error('Order 1.7.999015b not found'); };
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        capturedCreateArgs = { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        return {
            op: { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: Number(amountToSell), asset_id: sellAssetId } } },
            finalInts: { sell: Number(amountToSell), receive: Number(minToReceive), sellAssetId, receiveAssetId }
        };
    };
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[null, '1.7.999016']]
    });

    const cowResult = {
        workingGrid: new WorkingGrid(bot.manager.orders, { baseVersion: 0 }), workingIndexes: {}, workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: oldSlotId,
            orderId: actionOrderId,
            newGridId: newSlotId,
            newSize: 90,
            newPrice: 0.06,
            order: { type: 'sell', price: 0.06, size: 90 },
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert.strictEqual(result.executed, true);
        assert(capturedCreateArgs, 'buildCreateOrderOp fallback must be called for rotation UPDATE→CREATE');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.buildCreateOrderOp = origBuildCreate;
        chainOrders.executeBatch = origExecuteBatch;
    }
    console.log('✓ UNC-015b passed');
}

// ── UPDATE→CREATE fallback: CREATE also fails ───────────────────────────
async function testUpdateToCreateFallbackCreateAlsoFails() {
    console.log('\n[UNC-015c] UPDATE→CREATE fallback: CREATE also fails — fall through to error log...');
    const bot = makeBot();
    const slotId = 'slot-unc-015c';
    const actionOrderId = '1.7.999015c';
    const origBuildUpdate = chainOrders.buildUpdateOrderOp;
    const origBuildCreate = chainOrders.buildCreateOrderOp;
    let loggedError = null;
    let loggedWarn = null;

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 100, orderId: actionOrderId });
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._commitWorkingGrid = async () => true;
    // Same last-wins hazard as UNC-015: the cold-guard batch summary warns
    // after the fallback line. Assert on the full warn sequence.
    const allWarns15c: string[] = [];
    bot.manager.logger.log = (msg, level) => {
        if (level === 'error') loggedError = msg;
        if (level === 'warn') { loggedWarn = msg; allWarns15c.push(String(msg)); }
    };

    chainOrders.buildUpdateOrderOp = async () => { throw new Error('Order 1.7.999015c does not exist'); };
    chainOrders.buildCreateOrderOp = async () => { throw new Error('insufficient funds'); };

    const cowResult = {
        workingGrid: new WorkingGrid(bot.manager.orders, { baseVersion: 0 }), workingIndexes: {}, workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.UPDATE,
            id: slotId, orderId: actionOrderId,
            newSize: 100,
            order: { type: 'sell', price: 0.05, size: 100 }
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert.strictEqual(result.executed, false, 'no ops to broadcast when both UPDATE and CREATE fallback fail');
        assert(allWarns15c.some((w) => w.includes('CREATE fallback also failed')), 'CREATE failure should warn');
        assert(loggedError && loggedError.includes('Failed to prepare update op'), 'original error should also be logged');
    } finally {
        chainOrders.buildUpdateOrderOp = origBuildUpdate;
        chainOrders.buildCreateOrderOp = origBuildCreate;
    }
    console.log('✓ UNC-015c passed');
}

// ── _recoverFromPersistedGrid: success path ─────────────────────────────
async function testRecoverFromPersistedGrid() {
    console.log('\n[UNC-016] _recoverFromPersistedGrid loads grid from disk and re-syncs...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    const origPersist = bot.manager.persistGrid;
    let loadGridCalled = false;
    let loadBoundaryCalled = false;
    let syncCalledWith = null;
    let persistCalled = false;

    // _recoverFromPersistedGrid checks this.accountId first
    bot.accountId = 'test-account';

    // Add the properties that the real loadGrid and syncFromOpenOrders need
    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    bot.manager._applyOrderUpdate = async () => true;
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;
    bot.manager._restoreBoundary = (idx: any) => { bot.manager.boundaryIdx = idx; };

    const persistedGrid = [
        { id: 'slot-1', type: 'buy', price: 0.04, size: 200, orderId: '1.7.111' },
        { id: 'slot-2', type: 'sell', price: 0.06, size: 100, orderId: '1.7.222' }
    ];
    const chainState = [
        { id: '1.7.111', type: 'buy', price: 0.04, for_sale: 200 },
        { id: '1.7.222', type: 'sell', price: 0.06, for_sale: 100 }
    ];

    bot.accountOrders = {
        loadGrid: (force) => {
            if (force) loadGridCalled = true;
            return persistedGrid;
        },
        loadBoundaryIdx: (force) => {
            if (force) loadBoundaryCalled = true;
            // Valid dummy boundary for this 2-slot grid: both slots fall on
            // the BUY side of the geometry, so the persisted-boundary gate
            // (validatePersistedBoundary) accepts it.
            return 1;
        },
        // A real snapshot always carries its ladder; loadGrid refuses one
        // without (genesis invariant), so the fixture provides one.
        loadGenesis: () => recoveryFixtureLadder()
    };

    chainOrders.readOpenOrdersWithMeta = async (accountRef) => {
        assert.strictEqual(accountRef, 'test-account');
        return { orders: chainState, truncated: false };
    };

    bot.manager.syncFromOpenOrders = async (orders, options) => {
        syncCalledWith = { orders, options };
        return { filledOrders: [], updatedOrders: [] };
    };
    bot.manager.persistGrid = async () => {
        persistCalled = true;
        return { isValid: true };
    };

    try {

        const result = await bot._recoverFromPersistedGrid();
        assert.strictEqual(result.success, true);
        assert.strictEqual(loadGridCalled, true, 'loadGrid(true) must be called to force-reload from disk');
        assert.strictEqual(loadBoundaryCalled, true, 'loadBoundaryIdx(true) must be called');
        assert(syncCalledWith, 'syncFromOpenOrders must be called with chain data');
        assert.strictEqual(syncCalledWith.orders, chainState, 'sync must receive the chain state');
        assert.strictEqual(syncCalledWith.options.skipAccounting, true);
        // AsyncLock is re-entrant; fillLockAlreadyHeld flag eliminated
        assert.strictEqual(persistCalled, true, 'persistGrid must be called to save reconciled state');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
        bot.manager.persistGrid = origPersist;
    }
    console.log('✓ UNC-016 passed');
}

// ── _recoverFromPersistedGrid: truncated chain read must defer ──────────
async function testRecoverFromPersistedGridTruncatedRead() {
    console.log('\n[UNC-016e] _recoverFromPersistedGrid defers (fails cleanly) when the chain read is truncated...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

    bot.accountId = 'test-account';

    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    bot.manager._applyOrderUpdate = async () => true;
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;
    bot.manager._restoreBoundary = (idx: any) => { bot.manager.boundaryIdx = idx; };

    const persistedGrid = [
        { id: 'slot-1', type: 'buy', price: 0.04, size: 200, orderId: '1.7.111' },
        { id: 'slot-2', type: 'sell', price: 0.06, size: 100, orderId: '1.7.222' }
    ];

    bot.accountOrders = {
        loadGrid: () => persistedGrid,
        // Valid dummy boundary (42 would be rejected by the persisted-boundary
        // gate before the chain read this test exercises).
        loadBoundaryIdx: () => 1,
        loadGenesis: () => recoveryFixtureLadder(),
    };

    // Truncated read: the get_full_accounts window omitted the freshest
    // orders (exactly the CREATEs a reload would be looking for). The
    // recovery MUST NOT sync from this snapshot.
    let syncCalled = false;
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [
            { id: '1.7.111', type: 'buy', price: 0.04, for_sale: 200 }
        ],
        truncated: true
    });

    bot.manager.syncFromOpenOrders = async () => {
        syncCalled = true;
        return { filledOrders: [], updatedOrders: [] };
    };
    bot.manager.persistGrid = async () => ({ isValid: true });

    try {
        const result = await bot._recoverFromPersistedGrid();
        assert.strictEqual(result.success, false,
            'Recovery must defer on a truncated read: success=' + result.success +
            ' reason=' + (result.reason || 'none'));
        assert(result.reason, 'should provide a reason');
        assert(result.reason.includes('truncated'),
            `reason should mention truncated read, got: ${result.reason}`);
        assert.strictEqual(syncCalled, false,
            'syncFromOpenOrders must NOT run on a truncated read (would virtualize live ACTIVE slots)');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-016e passed');
}

// ── _recoverFromPersistedGrid: no persisted grid on disk ────────────────
async function testRecoverFromPersistedGridNoGrid() {
    console.log('\n[UNC-016b] _recoverFromPersistedGrid fails cleanly when no persisted grid exists...');
    const bot = makeBot();

    bot.accountOrders = {
        loadGrid: () => null,
        loadBoundaryIdx: () => null
    };

    const result = await bot._recoverFromPersistedGrid();
    assert.strictEqual(result.success, false);
    assert(result.reason, 'should provide a reason for failure');
    assert(result.reason.includes('no persisted grid'), `reason should mention missing grid, got: ${result.reason}`);
    console.log('✓ UNC-016b passed');
}

// ── _recoverFromPersistedGrid: rejects bloated grid after reload ────────
async function testRecoverFromPersistedGridBloated() {
    console.log('\n[UNC-016c] _recoverFromPersistedGrid rejects grid that is still bloated after reload...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    const origPersist = bot.manager.persistGrid;
    let loadGridCalled = false;

    bot.accountId = 'test-account';

    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    // _applyOrderUpdate must actually store orders so the post-reload
    // isGridBloated check sees non-empty data.
    bot.manager.orders = new Map();
    bot.manager._applyOrderUpdate = async (order: any) => {
        bot.manager.orders.set(order.id, { ...order });
    };
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;
    bot.manager._restoreBoundary = (idx: any) => { bot.manager.boundaryIdx = idx; };
    bot.manager.config = {
        incrementPercent: 0.3,
        targetSpreadPercent: 0.6,
    };

    // Bloated grid: 60 active at geometric prices → railEstimate ~60,
    // maxAllowed = 60 + gap + 5 ≈ 67. But we inject 100 extra VIRTUAL
    // slots at tightly clustered prices (all at 1.0), so gridSize=160
    // far exceeds the price-range estimate from min/max prices.
    const activeOrders = [];
    for (let i = 0; i < 30; i++) activeOrders.push({
        id: 'b' + i, type: 'buy', state: 'active',
        price: 1.0 * Math.pow(1.003, i), size: 10, orderId: '1.7.' + i,
    });
    for (let i = 0; i < 30; i++) activeOrders.push({
        id: 's' + i, type: 'sell', state: 'active',
        price: 1.0 * Math.pow(1.003, 100 + i), size: 10, orderId: '1.7.' + (100 + i),
    });
    const virtualExtra = [];
    for (let i = 0; i < 100; i++) virtualExtra.push({
        id: 'x' + i, type: 'spread', state: 'virtual',
        price: 1.0, size: 0, orderId: '',
    });
    const persistedGrid = [...activeOrders, ...virtualExtra];

    const chainState = activeOrders.map((o: any) => ({
        id: o.orderId, type: o.type, price: o.price, for_sale: o.size,
    }));

    bot.accountOrders = {
        loadGrid: (force) => {
            if (force) loadGridCalled = true;
            return persistedGrid;
        },
        loadBoundaryIdx: () => 0,
        loadGenesis: () => recoveryFixtureLadder(),
    };

    chainOrders.readOpenOrdersWithMeta = async () => ({ orders: chainState, truncated: false });

    bot.manager.syncFromOpenOrders = async () => ({ filledOrders: [], updatedOrders: [] });
    bot.manager.persistGrid = async () => ({ isValid: true });

    try {
        const result = await bot._recoverFromPersistedGrid();
        // loadGrid's inner bloat check may also fire requestStructuralGridResync
        // (async fire-and-forget), but the outer check must reject because the
        // grid is still oversized after reload.
        assert.strictEqual(result.success, false,
            'Recovery must reject bloated grid: success=' + result.success +
            ' reason=' + (result.reason || 'none'));
        assert(result.reason, 'should provide a reason');
        assert(result.reason.includes('still bloated'),
            `reason should mention bloat, got: ${result.reason}`);
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
        bot.manager.persistGrid = origPersist;
    }
    console.log('✓ UNC-016c passed');
}

// ── _recoverFromPersistedGrid: rejects when unmatched orders remain ─────
async function testRecoverFromPersistedGridUnmatchedRemain() {
    console.log('\n[UNC-016d] _recoverFromPersistedGrid rejects when unmatched chain orders remain after sync...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    const origPersist = bot.manager.persistGrid;

    bot.accountId = 'test-account';

    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    bot.manager._applyOrderUpdate = async () => true;
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;
    bot.manager._restoreBoundary = (idx: any) => { bot.manager.boundaryIdx = idx; };
    bot.manager.config = {
        incrementPercent: 0.3,
        targetSpreadPercent: 0.6,
    };

    // Simulate grid with 2 orders loaded from disk.
    const persistedGrid = [
        { id: 'slot-1', type: 'buy', price: 0.04, size: 200, orderId: '1.7.111' },
        { id: 'slot-2', type: 'sell', price: 0.06, size: 100, orderId: '1.7.222' }
    ];
    // Chain has 2 matching orders PLUS one extra orphan.
    const chainState = [
        { id: '1.7.111', type: 'buy', price: 0.04, for_sale: 200 },
        { id: '1.7.222', type: 'sell', price: 0.06, for_sale: 100 },
        { id: '1.7.333', type: 'sell', price: 0.09, for_sale: 50 }
    ];

    bot.accountOrders = {
        loadGrid: () => persistedGrid,
        // Valid dummy boundary: 0 would strand the placed SELL (idx 1) inside
        // the implied band (gapSlots=2) and the restore gate would reject the
        // snapshot before sync even runs — masking the unmatched-order path
        // this test exercises.
        loadBoundaryIdx: () => 1,
        loadGenesis: () => recoveryFixtureLadder(),
    };

    chainOrders.readOpenOrdersWithMeta = async () => ({ orders: chainState, truncated: false });

    // syncFromOpenOrders simulates finding the extra chain order as unmatched.
    // It sets _lastUnmatchedChainOrders to simulate the sync engine's behavior.
    bot.manager.syncFromOpenOrders = async (orders, options) => {
        bot.manager._lastUnmatchedChainOrders = [
            { chainOrderId: '1.7.333', type: 'sell', price: 0.09, size: 50, reason: 'duplicate-price-level' }
        ];
        bot.manager._lastUnmatchedChainOrdersAt = Date.now();
        return {
            filledOrders: [],
            updatedOrders: [],
            unmatchedChainOrders: [
                { chainOrderId: '1.7.333', type: 'sell', price: 0.09, size: 50, reason: 'duplicate-price-level' }
            ]
        };
    };
    bot.manager.persistGrid = async () => ({ isValid: true });

    try {
        const result = await bot._recoverFromPersistedGrid();
        // Must reject because persisted grid + sync did not resolve all unmatched.
        assert.strictEqual(result.success, false,
            'Recovery must reject when unmatched orders remain: success=' + result.success +
            ' reason=' + (result.reason || 'none'));
        assert(result.reason, 'should provide a reason');
        assert(result.reason.includes('unmatched'),
            `reason should mention unmatched, got: ${result.reason}`);
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
        bot.manager.persistGrid = origPersist;
    }
    console.log('✓ UNC-016d passed');
}
// ── _recoverFromPersistedGrid: out-of-grid holds do not reject ──────────
async function testRecoverFromPersistedGridOutOfGridHold() {
    console.log('\n[UNC-016f] _recoverFromPersistedGrid keeps out-of-grid holds without forcing a full reset...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    const origPersist = bot.manager.persistGrid;

    bot.accountId = 'test-account';

    bot.manager._gridLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
    };
    bot.manager._syncLock = {
        acquire: async (fn) => fn(),
        isLocked: () => false,
        isReentrant: () => false,
        forceRelease: () => 0,
    };
    bot.manager._fillProcessingLock = undefined;
    bot.manager._applyOrderUpdate = async () => true;
    bot.manager._initializeAssets = async () => {};
    bot.manager.resetFunds = () => {};
    bot.manager.pauseRecalcLogging = () => {};
    bot.manager.resumeRecalcLogging = () => {};
    bot.manager.funds = { btsFeesOwed: 0 };
    bot.manager.boundaryIdx = 0;
    bot.manager._restoreBoundary = (idx: any) => { bot.manager.boundaryIdx = idx; };
    bot.manager.config = {
        incrementPercent: 0.3,
        targetSpreadPercent: 0.6,
    };

    // Same grid as UNC-016d, but the extra chain order is a permanent
    // out-of-grid hold (live dip-protection below the frozen rail): it can
    // never be adopted, so it must not fail snapshot recovery — otherwise
    // every restart forces a full grid reset while a hold exists.
    const persistedGrid = [
        { id: 'slot-1', type: 'buy', price: 0.04, size: 200, orderId: '1.7.111' },
        { id: 'slot-2', type: 'sell', price: 0.06, size: 100, orderId: '1.7.222' }
    ];
    const chainState = [
        { id: '1.7.111', type: 'buy', price: 0.04, for_sale: 200 },
        { id: '1.7.222', type: 'sell', price: 0.06, for_sale: 100 },
        { id: '1.7.444', type: 'buy', price: 0.01, for_sale: 50 }
    ];

    bot.accountOrders = {
        loadGrid: () => persistedGrid,
        loadBoundaryIdx: () => 1,
        loadGenesis: () => recoveryFixtureLadder(),
    };

    chainOrders.readOpenOrdersWithMeta = async () => ({ orders: chainState, truncated: false });

    bot.manager.syncFromOpenOrders = async (orders, options) => {
        const hold = { chainOrderId: '1.7.444', type: 'buy', price: 0.01, size: 50, reason: 'out-of-grid-deferred', candidateSlotId: 'slot-0' };
        bot.manager._lastUnmatchedChainOrders = [hold];
        bot.manager._lastUnmatchedChainOrdersAt = Date.now();
        return { filledOrders: [], updatedOrders: [], unmatchedChainOrders: [hold] };
    };
    bot.manager.persistGrid = async () => ({ isValid: true });

    try {
        const result = await bot._recoverFromPersistedGrid();
        assert.strictEqual(result.success, true,
            'Recovery must keep out-of-grid holds without a full reset: success=' + result.success +
            ' reason=' + (result.reason || 'none'));
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
        bot.manager.persistGrid = origPersist;
    }
    console.log('✓ UNC-016f passed');
}

// ── Boundary shift: all CREATEs discarded → boundary must NOT shift ─────
async function testBoundaryShiftAllDiscarded() {
    console.log('\n[UNC-017] Boundary shift recovery: all CREATEs discarded → boundaryIdx unchanged...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

    const INITIAL_BOUNDARY = 5;
    bot.manager.boundaryIdx = INITIAL_BOUNDARY;
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    bot.manager.synchronizeWithChain = async () => {};

    for (let i = 0; i <= 9; i++) {
        const side = i <= INITIAL_BOUNDARY ? 'buy' : 'sell';
        bot.manager.orders.set(`slot-${i}`, { id: `slot-${i}`, type: side, price: 0.05 + i * 0.001, size: 1 });
    }

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'sell-1', type: 'sell', price: 0.06, size: 1 },
        finalInts: { sell: 100000000, receive: 5000000 }
    });

    chainOrders.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-discard', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'sell-1' }]
        );
        assert.strictEqual(result.uncertain, true);
        // Empty chain read is ambiguous (node may be lagging behind the
        // broadcast) — NOT authoritative absence. No discard decisions may be
        // made: discarding would clear the pending-broadcast protection and let
        // the next cycle re-CREATE slots whose orders may actually be on chain.
        assert.strictEqual(result.ambiguousRead, true, 'empty read must be reported as ambiguous');
        assert.strictEqual(result.adoptedCount, undefined, 'no adoption decisions on ambiguous read');
        assert.strictEqual(result.discardedCount, undefined, 'no discard decisions on ambiguous read');
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 2,
            'pending-broadcast protection must be KEPT on ambiguous (empty) read');
        assert.strictEqual(bot.manager.boundaryIdx, INITIAL_BOUNDARY,
            'boundaryIdx must NOT shift when the read is ambiguous');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-017 passed');
}

// ── Boundary shift: mixed adopted/discarded → boundary shifts for adopted only ─
async function testBoundaryShiftMixedAdoptedDiscarded() {
    console.log('\n[UNC-017b] Boundary shift recovery: mixed adopted/discarded → boundary shifts for adopted only...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

    const INITIAL_BOUNDARY = 5;
    bot.manager.boundaryIdx = INITIAL_BOUNDARY;
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    bot.manager.synchronizeWithChain = async () => {};

    for (let i = 0; i <= 9; i++) {
        const side = i <= INITIAL_BOUNDARY ? 'buy' : 'sell';
        bot.manager.orders.set(`slot-${i}`, { id: `slot-${i}`, type: side, price: 0.05 + i * 0.001, size: 1 });
    }

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'sell-1', type: 'sell', price: 0.06, size: 1 },
        finalInts: { sell: 100000000, receive: 5000000 }
    });

    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [
            makeChainOrder('1.7.300', 'buy', 5000000, 100000000)
        ],
        truncated: false
    });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-mixed', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'sell-1' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 1, '1 CREATE should be adopted');
        assert.strictEqual(result.discardedCount, 1, '1 CREATE should be discarded');
        assert.strictEqual(bot.manager.boundaryIdx, INITIAL_BOUNDARY,
            'boundaryIdx should remain unchanged after uncertain broadcast recovery (reconcile does not shift boundary)');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-017b passed');
}

// ── Boundary shift: all CREATEs adopted → boundary shifts for all ──────
async function testBoundaryShiftAllAdopted() {
    console.log('\n[UNC-017c] Boundary shift recovery: all CREATEs adopted → boundary shifts for all...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

    const INITIAL_BOUNDARY = 5;
    bot.manager.boundaryIdx = INITIAL_BOUNDARY;
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    bot.manager.synchronizeWithChain = async () => {};

    for (let i = 0; i <= 9; i++) {
        const side = i <= INITIAL_BOUNDARY ? 'buy' : 'sell';
        bot.manager.orders.set(`slot-${i}`, { id: `slot-${i}`, type: side, price: 0.05 + i * 0.001, size: 1 });
    }

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'buy-2', type: 'buy', price: 0.04, size: 1 },
        finalInts: { sell: 4000000, receive: 80000000 }
    });
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [
            makeChainOrder('1.7.400', 'buy', 5000000, 100000000),
            makeChainOrder('1.7.401', 'buy', 4000000, 80000000)
        ],
        truncated: false
    });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-adopt-all', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'buy-2' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 2, 'both CREATEs should be adopted');
        assert.strictEqual(result.discardedCount, 0, 'no CREATEs should be discarded');
        assert.strictEqual(bot.manager.boundaryIdx, INITIAL_BOUNDARY,
            'boundaryIdx should remain unchanged after uncertain broadcast recovery');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-017c passed');
}

// ── Truncated read: same ambiguity as empty → protection kept ────────────
async function testBoundaryShiftTruncatedRead() {
    console.log('\n[UNC-017d] Boundary shift recovery: truncated chain read → ambiguous (protection kept, no discard)...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

    const INITIAL_BOUNDARY = 5;
    bot.manager.boundaryIdx = INITIAL_BOUNDARY;
    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    bot.manager.synchronizeWithChain = async () => {};

    for (let i = 0; i <= 9; i++) {
        const side = i <= INITIAL_BOUNDARY ? 'buy' : 'sell';
        bot.manager.orders.set(`slot-${i}`, { id: `slot-${i}`, type: side, price: 0.05 + i * 0.001, size: 1 });
    }

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'sell-1', type: 'sell', price: 0.06, size: 1 },
        finalInts: { sell: 100000000, receive: 5000000 }
    });

    // Truncated read (get_full_accounts capped limit_orders): non-empty, but
    // none of the batch's creates visible. Fresh creates sort last in the
    // by_account index and are the FIRST entries a capped read omits — this
    // must be treated like an empty read: ambiguous, NOT authoritative
    // absence. Discarding would clear pending-broadcast protection and let
    // the next cycle re-CREATE slots whose orders may actually be on chain.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.900', 'sell', 999999999, 999999999)],
        truncated: true
    });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-truncated', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'sell-1' }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.ambiguousRead, true, 'truncated read must be reported as ambiguous');
        assert.strictEqual(result.adoptedCount, undefined, 'no adoption decisions on ambiguous read');
        assert.strictEqual(result.discardedCount, undefined, 'no discard decisions on ambiguous read');
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 2,
            'pending-broadcast protection must be KEPT on ambiguous (truncated) read');
        assert.strictEqual(bot.manager.boundaryIdx, INITIAL_BOUNDARY,
            'boundaryIdx must NOT shift when the read is ambiguous');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-017d passed');
}

// ── Re-read positive branch: late-adopted discarded CREATE ───────────────
// The initial snapshot misses a create (TOCTOU window), so it is discarded;
// the 3a re-read then reveals the create landed → late adoption. UNC-017b's
// mock returned the same snapshot twice, so only the negative branch ran.
async function testReReadLateAdoptsDiscardedCreate() {
    console.log('\n[UNC-017e] Re-read reveals a discarded CREATE landed → late adoption (create-uncertain restore NOT needed)...');
    const bot = makeBot();
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

    bot.manager.persistGrid = async () => ({ isValid: true });
    bot.manager._markGridDirty = () => {};
    let syncCalls = 0;
    bot.manager.synchronizeWithChain = async () => { syncCalls++; };
    bot.manager.applyGridUpdateBatch = async () => {};

    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: 'buy-1', type: 'buy', price: 0.05, size: 1 },
        finalInts: { sell: 5000000, receive: 100000000 }
    });
    bot._recordPendingBroadcast({
        opIndex: 1, ctxIndex: 1,
        order: { id: 'sell-1', type: 'sell', price: 0.06, size: 1 },
        finalInts: { sell: 100000000, receive: 5000000 }
    });

    // Stateful mock: the FIRST read misses the sell-1 create (node lag /
    // TOCTOU window); the 3a re-read reveals it landed.
    let readCalls = 0;
    chainOrders.readOpenOrdersWithMeta = async () => {
        readCalls++;
        if (readCalls === 1) {
            return { orders: [makeChainOrder('1.7.300', 'buy', 5000000, 100000000)], truncated: false };
        }
        return {
            orders: [
                makeChainOrder('1.7.300', 'buy', 5000000, 100000000),
                makeChainOrder('1.7.301', 'sell', 100000000, 5000000)
            ],
            truncated: false
        };
    };

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }, { op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-late-adopt', timeoutMs: 30000
            }),
            [{ kind: 'create', id: 'buy-1' }, { kind: 'create', id: 'sell-1' }]
        );
        assert.strictEqual(readCalls, 2, 'exactly one initial read + one re-read expected');
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 2, 're-read must late-adopt the discarded CREATE');
        assert.strictEqual(result.discardedCount, 0, 'no CREATE may be discarded once the re-read proves it landed');
        assert.strictEqual(syncCalls, 2, 'synchronizeWithChain must run for each adopted CREATE (incl. late-adopted)');
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 0,
            'pending-broadcast protection must clear after late adoption');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
    }
    console.log('✓ UNC-017e passed');
}

// ── Post-broadcast poll machinery: poll-confirmed uncertain commit ───────
// BroadcastUncertainError with a verifiable landed create → pollChainForConfirmation
// confirms → _commitWorkingGrid → adoptPlacedBatchFromChain adopts the placed
// orders from chain. Zero test references existed for this machinery
// (adoptPlacedBatchFromChain + poll-confirmed commit).
async function testPollConfirmationAdoptsPlacedBatch() {
    console.log('\n[UNC-018] Uncertain broadcast → poll confirms CREATE landed → commit + chain adoption...');
    const bot = makeBot();
    const slotId = 'slot-unc-018';
    const origBuildCreate = chainOrders.buildCreateOrderOp;
    const origExecuteBatch = chainOrders.executeBatch;
    const origReadMeta = chainOrders.readOpenOrdersWithMeta;
    const origBatchRead = chainOrders.batchReadOrders;

    bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 1000, chainFreeBuy: 1000 });
    bot.manager.synchronizeWithChain = async () => {};
    bot.manager.applyGridUpdateBatch = async () => {};
    bot.manager._commitWorkingGrid = async () => true;
    bot.manager.persistGrid = async () => ({ isValid: true });

    let syncFromOpenOrdersCalls = 0;
    let capturedAdoptionOrders = null;
    let capturedAdoptionOptions = null;
    bot.manager.syncFromOpenOrders = async (orders, options) => {
        syncFromOpenOrdersCalls++;
        capturedAdoptionOrders = orders;
        capturedAdoptionOptions = options;
        return { filledOrders: [], updatedOrders: [], unmatchedChainOrders: [] };
    };

    const assetA = bot.manager.assets.assetA;
    const assetB = bot.manager.assets.assetB;
    let landedFinalInts = null;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        landedFinalInts = {
            sell: Math.round(Number(amountToSell) * 10 ** assetA.precision),
            receive: Math.round(Number(minToReceive) * 10 ** assetB.precision),
            sellAssetId,
            receiveAssetId
        };
        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: landedFinalInts.sell, asset_id: sellAssetId },
                    min_to_receive: { amount: landedFinalInts.receive, asset_id: receiveAssetId }
                }
            },
            finalInts: landedFinalInts
        };
    };
    chainOrders.executeBatch = async () => {
        throw new BroadcastUncertainError('uncertain', { batchId: 'unc-018', timeoutMs: 30000 });
    };
    // The create landed on chain: the retry-verification read, the poll read
    // and the adoption read all see the batch's own order. Adoption re-reads
    // the poll-confirmed create BY ID (batchReadOrders) — the mock node is
    // consistent, so the by-id read sees the same landed order.
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.802', 'sell', landedFinalInts.sell, landedFinalInts.receive)],
        truncated: false
    });
    chainOrders.batchReadOrders = async (orderIds: string[]) => {
        const resultMap = new Map();
        for (const id of orderIds || []) {
            resultMap.set(id, id === '1.7.802'
                ? makeChainOrder('1.7.802', 'sell', landedFinalInts.sell, landedFinalInts.receive)
                : null);
        }
        return resultMap;
    };

    const cowResult = {
        workingGrid: new WorkingGrid(bot.manager.orders, { baseVersion: 0 }),
        workingIndexes: {},
        workingBoundary: {},
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: slotId,
            order: { id: slotId, type: 'sell', price: 0.005, size: 100 }
        }]
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW(cowResult);
        assert.strictEqual(result.uncertainResolved, true,
            'poll-confirmed commit must resolve as uncertainResolved');
        assert.strictEqual(result.executed, true, 'poll-confirmed commit counts as executed');
        assert.strictEqual(syncFromOpenOrdersCalls, 1,
            'adoptPlacedBatchFromChain must run the adoption sync exactly once');
        assert.strictEqual(capturedAdoptionOptions?.skipAccounting, false,
            'adoption sync must lock capital (skipAccounting: false)');
        assert(Array.isArray(capturedAdoptionOrders) && capturedAdoptionOrders.length === 1,
            'adoption sync must receive the fresh chain snapshot');
        assert.strictEqual(capturedAdoptionOrders[0].id, '1.7.802',
            'adoption must sync the batch\'s placed order');
        assert.strictEqual(bot.manager._pendingBroadcasts.size, 0,
            'pending-broadcast protection must clear after poll-confirmed adoption');
    } finally {
        chainOrders.buildCreateOrderOp = origBuildCreate;
        chainOrders.executeBatch = origExecuteBatch;
        chainOrders.readOpenOrdersWithMeta = origReadMeta;
        chainOrders.batchReadOrders = origBatchRead;
    }
    console.log('✓ UNC-018 passed');
}

// ── getAssetFeesSafe zero-fee fallback in the adoption path ──────────────
// Adoption sync at cow_runtime:740 must not throw when the BTS fee cache is
// unavailable (e.g. cleared); the zero-fee fallback (btsFeeData?.createFee || 0)
// keeps the adoption running and the optimistic balance close until the next
// fee fetch converges the residual.
async function testAdoptionZeroFeeFallbackWithoutFeeCache() {
    console.log('\n[UNC-019] Cleared fee cache → adoption sync runs with zero create fee, no throw...');
    const bot = makeBot();
    const slotId = 'sell-fee-fallback';
    const plannedSell = 120000000;
    const plannedReceive = 6000000;
    const origReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    const mathUtils = require('../modules/order/utils/math');
    let syncCalls = 0;
    let capturedFee = null;
    let capturedSource = null;

    mathUtils._setFeeCache({});

    bot.manager.orders.set(slotId, { id: slotId, type: 'sell', price: 0.05, size: 1.2 });
    bot.manager.synchronizeWithChain = async (params, source) => {
        syncCalls++;
        capturedFee = params.fee;
        capturedSource = source;
    };
    bot._recordPendingBroadcast({
        opIndex: 0, ctxIndex: 0,
        order: { id: slotId, type: 'sell', price: 0.05, size: 1.2 },
        finalInts: { sell: plannedSell, receive: plannedReceive }
    });
    chainOrders.readOpenOrdersWithMeta = async () => ({
        orders: [makeChainOrder('1.7.572312099', 'sell', plannedSell, plannedReceive)],
        truncated: false
    });

    try {
        const result = await bot._reconcileAfterUncertainBroadcast(
            new BroadcastUncertainError('timeout', {
                operations: [{ op_name: 'limit_order_create' }],
                accountName: 'test-account', batchId: 'batch-fee-fallback', timeoutMs: 30000
            }),
            [{ kind: 'create', id: slotId }]
        );
        assert.strictEqual(result.uncertain, true);
        assert.strictEqual(result.adoptedCount, 1, 'adoption must still succeed without a fee cache');
        assert.strictEqual(syncCalls, 1, 'adoption sync must run despite missing fee cache');
        assert.strictEqual(capturedSource, 'createOrder');
        assert.strictEqual(capturedFee, 0,
            'getAssetFeesSafe fallback must yield createFee 0 (null fee data), never throw');
    } finally {
        chainOrders.readOpenOrdersWithMeta = origReadOpenOrdersWithMeta;
        ensureFeeCache();
    }
    console.log('✓ UNC-019 passed');
}
