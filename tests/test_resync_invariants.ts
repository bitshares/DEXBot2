/**
 * tests/test_resync_invariants.ts
 * 
 * Verifies that the isBootstrapping flag correctly suppresses fund invariant warnings
 * during transient states like grid resync.
 */

const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { makeLadderFromPrices } = require('./helpers/order_test_helpers');

// Compiled ESM namespaces are frozen and require.cache injection cannot
// intercept static ESM imports, so chain_orders is replaced via loader hooks
// (same technique as tests/test_uncertain_broadcast.ts). The accountant's
// state-recovery path destructures readOpenOrdersGuarded at module load, so a
// faithful replica delegating to the swappable readOpenOrdersWithMeta keeps
// per-test fixtures effective.
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

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');

const chainOrders = makeSwappableModule({
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
    buildCancelOrderOp: async () => ({ op_name: 'limit_order_cancel', op_data: {} }),
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
], chainOrders);

const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 30000);
const testTimeoutHandle = setTimeout(() => {
    console.error(`✗ Resync invariant tests timed out after ${TEST_TIMEOUT_MS}ms`);
    process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof testTimeoutHandle.unref === 'function') testTimeoutHandle.unref();

async function runTests() {
    console.log('Running Resync Invariant Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            coreOrders: { buy: 5, sell: 5 }
        });
        await mgr.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 10000,
            sellFree: 100
        });
        // Genesis-frozen engine: a populated grid needs a price ladder or the
        // sync gate refuses the run (INV-GRID-004).
        mgr._genesis = makeLadderFromPrices([10, 100]);
        return mgr;
    };

    // Test 1: Invariant check runs when NOT bootstrapping
    console.log(' - Case 1: Invariant check runs when NOT bootstrapping...');
    {
        const manager = await createManager();
        manager.finishBootstrap(); // Set isBootstrapping = false

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: 'c1'
        });

        assert.strictEqual(invariantChecked, true, 'Invariant check should have run');
    }

    // Test 2: Invariant check is suppressed when bootstrapping
    console.log(' - Case 2: Invariant check is suppressed when bootstrapping...');
    {
        const manager = await createManager();
        manager.startBootstrap(); // Set isBootstrapping = true

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: 'c1'
        });

        assert.strictEqual(invariantChecked, false, 'Invariant check should be suppressed during bootstrap');
    }

    // Test 3: Resync simulation
    console.log(' - Case 3: Resync simulation (start -> clear -> finish)...');
    {
        const manager = await createManager();
        let invariantCallsDuringBootstrap = 0;
        let invariantCallsAfterBootstrap = 0;

        // Mock _verifyFundInvariants to count calls based on bootstrap state
        manager.accountant._verifyFundInvariants = async () => {
            if (manager.isBootstrapping()) {
                invariantCallsDuringBootstrap++;
            } else {
                invariantCallsAfterBootstrap++;
            }
        };

        // 1. Normal state - bootstrap already started in constructor; finish it
        manager.finishBootstrap();
        // _verifyFundInvariants should not be called during recalculateFunds while not bootstrapping
        // but the mock counting is what we care about during/after

        // 2. Start resync (bootstrap again)
        manager.startBootstrap();

        // 3. Recalculate during resync - invariant check should be suppressed
        await manager.recalculateFunds();
        assert.strictEqual(invariantCallsDuringBootstrap, 0, 'Invariant check should be suppressed during resync bootstrap');

        // 4. Finish resync (invariant check should resume)
        manager.finishBootstrap();
        await manager.recalculateFunds();

        assert(invariantCallsAfterBootstrap > 0, 'Invariant check should run now that bootstrap is finished');
    }

    // Test 4: Recovery validation must not be masked by bootstrap suppression
    console.log(' - Case 4: Recovery validation detects drift while bootstrapping...');
    {
        const manager = await createManager();
        manager.startBootstrap();
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TEST', precision: 5 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
        };
        manager._genesis = makeLadderFromPrices([10]);
        manager.boundaryIdx = 0; // slot-0 is on the BUY rail
        await manager.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 5000,
            sellFree: 100
        });
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: '1.7.1'
        });

        manager.accountId = '1.2.test';
        // Recovery verifies the fetch actually refreshed accountTotals
        // (_lastFetchedAt advanced) before trusting the balances — the fetch
        // stub must simulate the refresh stamp. +1 floors the stamp past any
        // same-millisecond collision with the setAccountTotals stamp above
        // (Date.now() granularity races under parallel-runner load).
        manager.fetchAccountTotals = async () => {
            const prev = manager.accountTotals?._lastFetchedAt || 0;
            manager.accountTotals = { ...(manager.accountTotals || {}), _lastFetchedAt: Math.max(Date.now(), prev + 1) };
        };
        manager.syncFromOpenOrders = async () => ({ filledOrders: [], updatedOrders: [] });
        // A NON-EMPTY, NON-TRUNCATED read is authoritative, so the recovery
        // sync runs and the drift check fires. (An empty/truncated read now
        // defers the sync — it is ambiguous, and syncFromOpenOrders on it
        // would let pass-1 phantom cleanup virtualize live ACTIVE slots.)
        const originalReadOpenOrders = chainOrders.readOpenOrders;
        const originalReadOpenOrdersMeta = chainOrders.readOpenOrdersWithMeta;
        const stubOrders = [{ id: '1.7.1', sell_price: { base: { amount: 100, asset_id: '1.3.0' }, quote: { amount: 100, asset_id: '1.3.1' } }, for_sale: 100, expiration: '2099-01-01T00:00:00' }];
        chainOrders.readOpenOrders = async () => stubOrders;
        chainOrders.readOpenOrdersWithMeta = async () => ({ orders: stubOrders, truncated: false });

        let validation;
        try {
            validation = await manager.accountant._performStateRecovery(manager);
        } finally {
            chainOrders.readOpenOrders = originalReadOpenOrders;
            chainOrders.readOpenOrdersWithMeta = originalReadOpenOrdersMeta;
        }

        assert.strictEqual(validation.isValid, false, 'Recovery validation should detect drift even during bootstrap');
        assert.match(validation.reason, /BUY drift/, 'Recovery validation should report buy drift');
    }

    // Test 5: Authoritative open-order sync must not double-deduct fetched free balances
    console.log(' - Case 5: Authoritative sync preserves fetched free balances...');
    {
        const manager = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            coreOrders: { buy: 1, sell: 0 }
        });
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TEST', precision: 5 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
        };
        manager._genesis = makeLadderFromPrices([10]);
        manager.boundaryIdx = 0; // slot-0 is on the BUY rail
        await manager.setAccountTotals({
            buy: 1000,
            sell: 0,
            buyFree: 900,
            sellFree: 0
        });

        // Slot id must be ladder-addressable: the chain order at price 10
        // adopts into its nearest slot (slotIndexForPrice), so the fund lock
        // this case asserts on actually happens.
        await manager._updateOrder({
            id: 'slot-0',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            price: 10,
            size: 100,
            orderId: ''
        }, 'seed', { skipAccounting: true });

        await manager.synchronizeWithChain([{
            id: '1.7.buy',
            for_sale: 10000000,
            sell_price: {
                base: { amount: 10000000, asset_id: '1.3.0' },
                quote: { amount: 1000000, asset_id: '1.3.1' }
            }
        }], 'periodicBlockchainFetch');

        assert.strictEqual(manager.accountTotals.buyFree, 900, 'authoritative sync should not deduct already-locked funds from fetched buyFree');
        const drift = manager.checkFundDriftAfterFills();
        assert.strictEqual(drift.isValid, true, `authoritative sync should remain drift-free: ${drift.reason}`);
    }

    console.log('✓ Resync invariant tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
}).finally(() => {
    clearTimeout(testTimeoutHandle);
});
