/**
 * Integration tests for concurrent fill + rebalance scenarios.
 *
 * Tests the COW (Copy-on-Write) pipeline behavior when fills arrive
 * during different rebalance phases (REBALANCING, BROADCASTING).
 */

const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function createOrder(id, overrides = {}) {
    return {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1.0,
        size: 100,
        orderId: `1.7.${id.replace(/\D/g, '')}`,
        ...overrides
    };
}

function createManagerFixture(orders = []) {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
    const logs = [];

    manager.logger = {
        log: (msg, level) => logs.push({ msg, level }),
        marketName: 'TEST/USD',
        logFundsStatus: () => {}
    };

    manager.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Disable accounting for unit tests
    manager.accountant = {
        updateOptimisticFreeBalance: async () => {},
        recalculateFunds: async () => {},
        tryDeductFromChainFree: async () => ({ ok: true }),
        addToChainFree: async () => true
    };

    // Build initial master grid
    const master = new Map();
    for (const order of orders) {
        master.set(order.id, order);
    }
    manager.orders = Object.freeze(master);
    manager._gridVersion = 1;
    manager.boundaryIdx = 0;

    // Rebuild indexes
    for (const [id, order] of master) {
        if (manager._ordersByState[order.state]) manager._ordersByState[order.state].add(id);
        if (manager._ordersByType[order.type]) manager._ordersByType[order.type].add(id);
    }

    return { manager, logs };
}

// ============================================================================
// TEST 1: syncFromMaster updates working grid during REBALANCING
// ============================================================================
async function testFillDuringRebalancingSyncsToWorkingGrid() {
    console.log('\n[COW-FILL-001] Fill during REBALANCING syncs to working grid...');

    const orders = [
        createOrder('slot-1', { price: 1.0, size: 100, type: ORDER_TYPES.BUY }),
        createOrder('slot-2', { price: 2.0, size: 200, type: ORDER_TYPES.SELL, orderId: '1.7.200' })
    ];
    const { manager, logs } = createManagerFixture(orders);

    // Simulate entering REBALANCING state
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    (manager as any)._currentWorkingGridStack.push(workingGrid);
    manager._setRebalanceState('REBALANCING');

    // Simulate a fill arriving (master mutation via _applyOrderUpdate)
    await manager._applyOrderUpdate(
        { id: 'slot-1', state: ORDER_STATES.VIRTUAL, orderId: null, size: 0, type: ORDER_TYPES.SPREAD },
        'handle-fill-full'
    );

    // Verify working grid was marked stale
    assert.strictEqual(workingGrid.isStale(), true, 'working grid should be stale');
    assert.ok(
        workingGrid.getStaleReason().includes('rebalancing'),
        `stale reason should mention rebalancing, got: ${workingGrid.getStaleReason()}`
    );

    // Verify working grid was synced from master
    const syncedOrder = workingGrid.get('slot-1');
    assert.ok(syncedOrder, 'order should exist in working grid after sync');
    assert.strictEqual(syncedOrder.state, ORDER_STATES.VIRTUAL, 'synced order should be VIRTUAL');
    assert.strictEqual(syncedOrder.size, 0, 'synced order size should be 0');

    // Verify baseVersion was updated
    assert.strictEqual(workingGrid.baseVersion, manager._gridVersion, 'baseVersion should match master');

    manager._clearWorkingGridRef();
    console.log('  PASS');
}

// ============================================================================
// TEST 2: syncFromMaster updates working grid during BROADCASTING
// ============================================================================
async function testFillDuringBroadcastingSyncsToWorkingGrid() {
    console.log('\n[COW-FILL-002] Fill during BROADCASTING syncs to working grid...');

    const orders = [
        createOrder('slot-1', { price: 1.0, size: 100, type: ORDER_TYPES.BUY }),
        createOrder('slot-2', { price: 2.0, size: 200, type: ORDER_TYPES.SELL, orderId: '1.7.200' })
    ];
    const { manager, logs } = createManagerFixture(orders);

    // Simulate entering BROADCASTING state (matching production pattern in dexbot_class.ts)
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    (manager as any)._currentWorkingGridStack.push(workingGrid);
    manager._setRebalanceState('BROADCASTING');
    manager.startBroadcasting();

    // Simulate a fill arriving during broadcast
    await manager._applyOrderUpdate(
        { id: 'slot-2', state: ORDER_STATES.PARTIAL, size: 150, type: ORDER_TYPES.SELL },
        'handle-fill-partial'
    );

    // Verify working grid was marked stale
    assert.strictEqual(workingGrid.isStale(), true, 'working grid should be stale');
    assert.ok(
        workingGrid.getStaleReason().includes('broadcasting'),
        `stale reason should mention broadcasting, got: ${workingGrid.getStaleReason()}`
    );

    // Verify working grid was synced from master
    const syncedOrder = workingGrid.get('slot-2');
    assert.ok(syncedOrder, 'order should exist in working grid after sync');
    assert.strictEqual(syncedOrder.state, ORDER_STATES.PARTIAL, 'synced order should be PARTIAL');
    assert.strictEqual(syncedOrder.size, 150, 'synced order size should be 150');

    manager._clearWorkingGridRef();
    console.log('  PASS');
}

// ============================================================================
// TEST 3: Commit rejected when fill arrives during broadcast
// ============================================================================
async function testCommitRejectedAfterFillDuringBroadcast() {
    console.log('\n[COW-FILL-003] Commit rejected after fill during broadcast...');

    const orders = [
        createOrder('slot-1', { price: 1.0, size: 100, type: ORDER_TYPES.BUY })
    ];
    const { manager, logs } = createManagerFixture(orders);
    const originalVersion = manager._gridVersion;

    // Create working grid and enter BROADCASTING
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: originalVersion });
    workingGrid.set('slot-1', createOrder('slot-1', { price: 1.5, size: 120 }));
    (manager as any)._currentWorkingGridStack.push(workingGrid);
    manager._setRebalanceState('BROADCASTING');
    manager.startBroadcasting();

    // Simulate fill arriving during broadcast (increments version)
    await manager._applyOrderUpdate(
        { id: 'slot-1', state: ORDER_STATES.VIRTUAL, orderId: null, size: 0, type: ORDER_TYPES.SPREAD },
        'handle-fill-full'
    );

    // Attempt commit -- should be rejected because working grid is stale
    await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0);

    // Verify master was NOT changed by the commit
    const masterOrder = manager.orders.get('slot-1');
    assert.strictEqual(masterOrder.state, ORDER_STATES.VIRTUAL, 'master should reflect the fill, not the working grid plan');
    assert.strictEqual(masterOrder.size, 0, 'master order size should be 0 from fill');

    // Verify state was cleaned up
    assert.strictEqual(manager._peekWorkingGrid(), null, 'working grid ref should be cleared');
    assert.strictEqual(manager._rebalanceState, 'NORMAL', 'rebalance state should be reset');

    // Verify stale commit was logged
    assert.ok(
        logs.some(l => String(l.msg).includes('Refusing stale')),
        'should log stale refusal'
    );

    console.log('  PASS');
}

// ============================================================================
// TEST 4: No working grid mutation when in NORMAL state
// ============================================================================
async function testNoSyncWhenNormalState() {
    console.log('\n[COW-FILL-004] No working grid sync during NORMAL state...');

    const orders = [
        createOrder('slot-1', { price: 1.0, size: 100, type: ORDER_TYPES.BUY })
    ];
    const { manager } = createManagerFixture(orders);

    // Simulate having a stale working grid reference but NORMAL state
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    (manager as any)._currentWorkingGridStack.push(workingGrid);
    manager._rebalanceState = 'NORMAL';

    // Apply an update -- should NOT touch working grid
    await manager._applyOrderUpdate(
        { id: 'slot-1', size: 50 },
        'some-update'
    );

    assert.strictEqual(workingGrid.isStale(), false, 'working grid should NOT be stale in NORMAL state');
    assert.strictEqual(workingGrid.modified.size, 0, 'working grid should have no modifications');

    manager._clearWorkingGridRef();
    console.log('  PASS');
}

// ============================================================================
// TEST 6: _cloneOrder handles missing rawOnChain gracefully
// ============================================================================
function testCloneOrderHandlesMissingRawOnChain() {
    console.log('\n[COW-FILL-006] _cloneOrder handles missing rawOnChain...');

    const workingGrid = new WorkingGrid(new Map());

    const order = {
        id: 'slot-1',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: 1.0,
        size: 0
    };

    const cloned = workingGrid._cloneOrder(order);
    assert.strictEqual(cloned.rawOnChain, undefined, 'rawOnChain should remain undefined');
    assert.strictEqual(cloned.id, 'slot-1');

    console.log('  PASS');
}

// ============================================================================
// TEST 7: Staleness marking includes phase context
// ============================================================================
async function testStalenessIncludesPhaseContext() {
    console.log('\n[COW-FILL-007] Staleness reason includes phase context...');

    // Test REBALANCING phase
    const orders = [createOrder('slot-1')];
    const { manager: mgr1 } = createManagerFixture(orders);
    const wg1 = new WorkingGrid(mgr1.orders, { baseVersion: mgr1._gridVersion });
    (mgr1 as any)._currentWorkingGridStack.push(wg1);
    mgr1._setRebalanceState('REBALANCING');
    await mgr1._applyOrderUpdate({ id: 'slot-1', size: 50 }, 'test');
    assert.ok(wg1.getStaleReason().includes('rebalancing'), 'should include rebalancing');
    mgr1._clearWorkingGridRef();

    // Test BROADCASTING phase
    const { manager: mgr2 } = createManagerFixture(orders);
    const wg2 = new WorkingGrid(mgr2.orders, { baseVersion: mgr2._gridVersion });
    (mgr2 as any)._currentWorkingGridStack.push(wg2);
    mgr2._setRebalanceState('BROADCASTING');
    mgr2.startBroadcasting();
    await mgr2._applyOrderUpdate({ id: 'slot-1', size: 50 }, 'test');
    assert.ok(wg2.getStaleReason().includes('broadcasting'), 'should include broadcasting');
    mgr2._clearWorkingGridRef();

    console.log('  PASS');
}

// ============================================================================
// Runner
// ============================================================================
async function run() {
    console.log('Running COW concurrent fill integration tests...');

    await testFillDuringRebalancingSyncsToWorkingGrid();
    await testFillDuringBroadcastingSyncsToWorkingGrid();
    await testCommitRejectedAfterFillDuringBroadcast();
    await testNoSyncWhenNormalState();
    testCloneOrderHandlesMissingRawOnChain();
    await testStalenessIncludesPhaseContext();

    console.log('\nAll COW concurrent fill integration tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
