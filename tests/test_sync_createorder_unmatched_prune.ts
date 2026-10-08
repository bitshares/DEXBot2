/**
 * tests/test_sync_createorder_unmatched_prune.ts
 *
 * Regression test: the `createOrder` linkage branch in
 * SyncEngine.synchronizeWithChain binds a chain order to a grid slot, so any
 * deferred-orphan record for that chain id must be pruned. Fund accounting
 * counts `_lastUnmatchedChainOrders` as committed on-chain funds, so a kept
 * record double-counts now that the slot loop also sees the order.
 *
 * Covers both dispositions:
 *   - successful linkage prunes the record;
 *   - a rejected linkage keeps it (the order really is still unmatched).
 */
const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');

function createManagerFixture() {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });

    manager.logger = {
        log: () => {},
        marketName: 'TEST/USD',
        logFundsStatus: () => {}
    };

    manager.accountant = {
        updateOptimisticFreeBalance: async () => {},
        recalculateFunds: async () => {},
        tryDeductFromChainFree: async () => ({ ok: true }),
        addToChainFree: async () => true
    };

    manager.assets = {
        assetA: { symbol: 'BTS', id: '1.3.0', precision: 5 },
        assetB: { symbol: 'USD', id: '1.3.121', precision: 4 }
    };

    manager.orders.set('grid-1', {
        id: 'grid-1', type: 'BUY', state: 'VIRTUAL', price: 1, size: 10, orderId: ''
    });
    manager._lastUnmatchedChainOrders = [
        { chainOrderId: '1.7.99', type: 'BUY', price: 1, size: 10, reason: 'no-available-nearest-slot' }
    ];
    return manager;
}

async function link(manager: any) {
    await manager.sync.synchronizeWithChain({
        gridOrderId: 'grid-1',
        chainOrderId: '1.7.99',
        isPartialPlacement: false,
        expectedType: 'BUY',
        fee: 0
    }, 'createOrder');
}

function hasUnmatched(manager: any) {
    return (manager._lastUnmatchedChainOrders || []).some((o: any) => o.chainOrderId === '1.7.99');
}

async function main() {
    console.log('Running createOrder unmatched-prune tests...');

    {
        const manager = createManagerFixture();
        await link(manager);
        assert.strictEqual(manager.orders.get('grid-1').orderId, '1.7.99', 'linkage must bind the chain id');
        assert.strictEqual(hasUnmatched(manager), false, 'successful linkage must prune the unmatched record');
        console.log('  ✓ successful linkage prunes the unmatched record');
    }

    {
        const manager = createManagerFixture();
        manager._applyOrderUpdate = async () => false;
        await link(manager);
        assert.strictEqual(hasUnmatched(manager), true, 'rejected linkage must keep the unmatched record');
        console.log('  ✓ rejected linkage keeps the unmatched record');
    }

    console.log('\n✓ createOrder unmatched-prune tests passed!');
}

main().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});
