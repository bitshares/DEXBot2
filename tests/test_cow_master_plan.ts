/**
 * Copy-on-Write Master Plan Test Suite
 * Tests all critical COW functionality
 */

const assert = require('assert');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ordersEqual, buildDelta, buildIndexes, validateIndexes } = require('../modules/order/utils/order');
const { projectTargetToWorkingGrid, reconcileGrid, optimizeRebalanceActions } = require('../modules/order/utils/validate');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function createTestOrder(id, type, state, price, amount, orderId = null) {
    return {
        id,
        type,
        state,
        price,
        amount,
        orderId,
        gridIndex: parseInt(id.replace(/\D/g, '')) || 0
    };
}

async function testCOW001_MasterUnchangedOnFailure() {
    console.log('\n[COW-001] Testing master grid unchanged on failure...');
    
    const masterGrid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10, 'chain1')],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20, 'chain2')]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    workingGrid.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 150, 10, 'chain1'));
    
    const masterOrder1 = masterGrid.get('order1');
    assert.strictEqual(masterOrder1.price, 100, 'Master should be unchanged after working copy modification');
    
    workingGrid.delete('order2');
    assert(masterGrid.has('order2'), 'Master should still have order2 after working copy delete');
    
    console.log('✓ COW-001 passed');
}

async function testCOW002_MasterUpdatedOnlyOnSuccess() {
    console.log('\n[COW-002] Testing master update on success only...');
    
    const masterGrid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10, 'chain1')]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    workingGrid.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 150, 10, 'chain1'));
    
    const actions = workingGrid.buildDelta(masterGrid);
    assert.strictEqual(actions.length, 1, 'Should have 1 update action');
    assert.strictEqual(actions[0].type, 'update', 'Action should be update');
    
    const newMasterGrid = workingGrid.toMap();
    assert.strictEqual(newMasterGrid.get('order1').price, 150, 'New grid should have updated price');
    assert.strictEqual(masterGrid.get('order1').price, 100, 'Original master should be unchanged');
    
    console.log('✓ COW-002 passed');
}

async function testCOW003_IndexTransfer() {
    console.log('\n[COW-003] Testing index transfer...');
    
    const masterGrid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10)],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20)],
        ['order3', createTestOrder('order3', ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, 150, 15)]
    ]);

    const masterIndexes = buildIndexes(masterGrid);
    
    const workingGrid = new WorkingGrid(masterGrid);
    workingGrid.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 120, 10));
    workingGrid.set('order4', createTestOrder('order4', ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, 180, 25));
    workingGrid.delete('order2');
    
    const workingIndexes = workingGrid.getIndexes();
    
    assert(workingIndexes[ORDER_TYPES.BUY].has('order1'), 'BUY should contain order1');
    assert(workingIndexes[ORDER_TYPES.BUY].has('order3'), 'BUY should contain order3');
    assert(workingIndexes[ORDER_TYPES.BUY].has('order4'), 'BUY should contain order4 (new)');
    assert(!workingIndexes[ORDER_TYPES.SELL].has('order2'), 'SELL should not contain order2 (deleted)');
    assert(workingIndexes[ORDER_STATES.ACTIVE].has('order1'), 'ACTIVE should contain order1');
    assert(workingIndexes[ORDER_STATES.VIRTUAL].has('order3'), 'VIRTUAL should contain order3');
    assert(workingIndexes[ORDER_STATES.VIRTUAL].has('order4'), 'VIRTUAL should contain order4');
    
    console.log('✓ COW-003 passed');
}

async function testCOW004_FundRecalculation() {
    console.log('\n[COW-004] Testing fund calculation from grid...');
    
    const workingGrid = new WorkingGrid(new Map());
    
    workingGrid.set('buy1', createTestOrder('buy1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10));
    workingGrid.set('buy2', createTestOrder('buy2', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 90, 20));
    workingGrid.set('sell1', createTestOrder('sell1', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 15));
    workingGrid.set('sell2', createTestOrder('sell2', ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 210, 25));
    
    let buyRequired = 0;
    let sellRequired = 0;
    
    for (const order of workingGrid.values()) {
        if (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.VIRTUAL) {
            if (order.type === ORDER_TYPES.BUY) {
                buyRequired += order.price * order.amount;
            } else if (order.type === ORDER_TYPES.SELL) {
                sellRequired += order.amount;
            }
        }
    }
    
    assert.strictEqual(buyRequired, 2800, 'Buy required should be 100*10 + 90*20 = 2800');
    assert.strictEqual(sellRequired, 40, 'Sell required should be 15 + 25 = 40');
    
    console.log('✓ COW-004 passed');
}

async function testCOW005_OrderComparison() {
    console.log('\n[COW-005] Testing order comparison...');
    
    const order1 = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100.0000011, 10, 'chain1');
    const order2 = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100.0000012, 10, 'chain1');
    
    assert.strictEqual(
        ordersEqual(order1, order2, { precisions: { buyPrecision: 8, sellPrecision: 8, priceRelativeTolerance: 0.0005 } }),
        true,
        'Should be equal within configured COW price tolerance'
    );
    
    const order3 = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100.2, 10, 'chain1');
    assert.strictEqual(ordersEqual(order1, order3), false, 'Should not be equal with large price diff');

    const tinySizeA = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 0.00000010, 'chain1');
    const tinySizeB = createTestOrder('1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 0.000000105, 'chain1');
    assert.strictEqual(
        ordersEqual(tinySizeA, tinySizeB, { precisions: { buyPrecision: 8, sellPrecision: 8 } }),
        true,
        'Should be equal when relative tolerance falls below buy precision quantum'
    );

    assert.strictEqual(
        ordersEqual(tinySizeA, tinySizeB, { precisions: { buyPrecision: 9, sellPrecision: 9 } }),
        false,
        'Should not be equal when configured precision quantum is tighter than diff'
    );
    
    const order4 = createTestOrder('1', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 100, 10, 'chain1');
    assert.strictEqual(ordersEqual(order1, order4), false, 'Should not be equal with different type');
    
    console.log('✓ COW-005 passed');
}

async function testCOW006_DeltaBuilding() {
    console.log('\n[COW-006] Testing delta building...');
    
    const master = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10, 'chain1')],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20, 'chain2')]
    ]);

    const working = new WorkingGrid(master);
    
    working.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 150, 10, 'chain1'));
    working.set('order3', createTestOrder('order3', ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL, 120, 15));
    working.delete('order2');
    
    const actions = buildDelta(master, working);
    
    assert.strictEqual(actions.length, 3, 'Should have 3 actions');
    assert.strictEqual(actions.filter(a => a.type === 'update').length, 1, 'Should have 1 update');
    assert.strictEqual(actions.filter(a => a.type === 'create').length, 1, 'Should have 1 create');
    assert.strictEqual(actions.filter(a => a.type === 'cancel').length, 1, 'Should have 1 cancel');
    
    const updateAction = actions.find(a => a.type === 'update');
    assert.strictEqual(updateAction.order.price, 150, 'Update should have new price');
    
    console.log('✓ COW-006 passed');
}

async function testCOW007_IndexValidation() {
    console.log('\n[COW-007] Testing index validation...');
    
    const grid = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10)],
        ['order2', createTestOrder('order2', ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 200, 20)]
    ]);

    const indexes = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(['order1', 'order2']),
        [ORDER_STATES.PARTIAL]: new Set(),
        [ORDER_TYPES.BUY]: new Set(['order1']),
        [ORDER_TYPES.SELL]: new Set(['order2']),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    const validation = validateIndexes(grid, indexes);
    assert(validation.valid, 'Indexes should be valid');
    
    const badIndexes = {
        ...indexes,
        [ORDER_STATES.ACTIVE]: new Set(['order1', 'order3'])
    };
    
    const badValidation = validateIndexes(grid, badIndexes);
    assert(!badValidation.valid, 'Indexes should be invalid');
    assert(badValidation.errors.length > 0, 'Should have errors');
    
    console.log('✓ COW-007 passed');
}

async function testCOW008_WorkingGridIndependence() {
    console.log('\n[COW-008] Testing working grid independence...');
    
    const original = new Map([
        ['order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100, 10)]
    ]);

    const wg1 = new WorkingGrid(original);
    const wg2 = new WorkingGrid(original);
    
    wg1.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 200, 10));
    wg2.set('order1', createTestOrder('order1', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 300, 10));
    
    assert.strictEqual(wg1.get('order1').price, 200, 'WG1 should have price 200');
    assert.strictEqual(wg2.get('order1').price, 300, 'WG2 should have price 300');
    assert.strictEqual(original.get('order1').price, 100, 'Original should be unchanged');
    
    console.log('✓ COW-008 passed');
}

async function testCOW009_EmptyGridHandling() {
    console.log('\n[COW-009] Testing empty grid handling...');
    
    const emptyMaster = new Map();
    const working = new WorkingGrid(emptyMaster);
    
    assert.strictEqual(working.size, 0, 'Working grid should be empty');
    assert(!working.isModified(), 'Should not be modified initially');
    
    const actions = working.buildDelta(emptyMaster);
    assert.strictEqual(actions.length, 0, 'Should have no actions');
    
    console.log('✓ COW-009 passed');
}

async function testCOW010_MemoryStats() {
    console.log('\n[COW-010] Testing memory stats...');
    
    const grid = new Map();
    for (let i = 0; i < 100; i++) {
        grid.set(`order${i}`, createTestOrder(`order${i}`, ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 100 + i, 10));
    }

    const working = new WorkingGrid(grid);
    const stats = working.getMemoryStats();
    
    assert.strictEqual(stats.size, 100, 'Size should be 100');
    assert(stats.estimatedBytes > 0, 'Estimated bytes should be positive');
    
    working.set('order0', createTestOrder('order0', ORDER_TYPES.BUY, ORDER_STATES.ACTIVE, 999, 10));
    const modifiedStats = working.getMemoryStats();
    assert(modifiedStats.modified > 0, 'Modified count should be positive');
    
    console.log('✓ COW-010 passed');
}

async function testCOW011_NoSpuriousUpdatesOnUnchangedGrid() {
    console.log('\n[COW-011] Testing unchanged grid emits no updates...');

    const master = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 1.2345,
            size: 10,
            orderId: '1.7.100',
            gridIndex: 1
        }],
        ['slot-2', {
            id: 'slot-2',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1.3456,
            size: 20,
            orderId: '1.7.101',
            gridIndex: 2
        }],
        ['slot-3', {
            id: 'slot-3',
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            price: 1.29,
            size: 0,
            orderId: null,
            gridIndex: 3
        }]
    ]);

    const working = new WorkingGrid(master);
    const actions = buildDelta(master, working);

    assert.strictEqual(actions.length, 0, 'Unchanged working grid must produce zero actions');
    assert.strictEqual(actions.filter(a => a.type === 'update').length, 0, 'Unchanged working grid must produce zero updates');

    console.log('✓ COW-011 passed');
}

/**
 * COW-012: Verify that projectTargetToWorkingGrid keeps NEW orders as VIRTUAL
 * 
 * REGRESSION TEST for invariant violation bug:
 * - Root cause: projectTargetToWorkingGrid was setting new orders to ACTIVE
 * - COW commit would then write ACTIVE orders without accounting deduction
 * - synchronizeWithChain saw ACTIVE->ACTIVE (no transition) = no fund deduction
 * - Result: Fund invariant violation (trackedTotal > blockchainTotal)
 * 
 * Fix: New orders must remain VIRTUAL until synchronizeWithChain confirms
 * blockchain placement, triggering proper VIRTUAL->ACTIVE transition with
 * fund deduction via updateOptimisticFreeBalance.
 */
async function testCOW012_NewOrdersRemainVirtualUntilSync() {
    console.log('\n[COW-012] Testing new orders remain VIRTUAL after projection (accounting invariant)...');
    
    // Simulate a master grid with one existing ACTIVE order
    const masterGrid = new Map([
        ['slot-50', {
            id: 'slot-50',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 50,
            orderId: '1.7.12345'  // Has chain ID = already on blockchain
        }]
    ]);
    
    // Create a target grid that wants to:
    // 1. Keep slot-50 active (existing order)
    // 2. Add slot-51 as a NEW order (should be placed on chain)
    // 3. Add slot-52 as a NEW order (should be placed on chain)
    const targetGrid = new Map([
        ['slot-50', {
            id: 'slot-50',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,  // Target wants it ACTIVE
            price: 100,
            size: 50
        }],
        ['slot-51', {
            id: 'slot-51',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,  // Target wants it ACTIVE (but it's NEW!)
            price: 95,
            size: 45
        }],
        ['slot-52', {
            id: 'slot-52',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,  // Target wants it ACTIVE (but it's NEW!)
            price: 105,
            size: 40
        }]
    ]);
    
    // Create working grid from master and project target onto it
    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid);
    
    // CRITICAL ASSERTION 1: Existing order with orderId should keep its state
    const slot50 = workingGrid.get('slot-50');
    assert(slot50, 'slot-50 should exist in working grid');
    assert.strictEqual(slot50.state, ORDER_STATES.ACTIVE, 
        'Existing order with orderId should remain ACTIVE');
    assert.strictEqual(slot50.orderId, '1.7.12345',
        'Existing order should keep its orderId');
    
    // CRITICAL ASSERTION 2: NEW orders (no orderId in master) must be VIRTUAL
    const slot51 = workingGrid.get('slot-51');
    assert(slot51, 'slot-51 should exist in working grid');
    assert.strictEqual(slot51.state, ORDER_STATES.VIRTUAL,
        'NEW order slot-51 must be VIRTUAL (not ACTIVE) to ensure accounting deduction happens in synchronizeWithChain');
    assert.strictEqual(slot51.orderId, null,
        'NEW order should have null orderId');
    
    const slot52 = workingGrid.get('slot-52');
    assert(slot52, 'slot-52 should exist in working grid');
    assert.strictEqual(slot52.state, ORDER_STATES.VIRTUAL,
        'NEW order slot-52 must be VIRTUAL (not ACTIVE) to ensure accounting deduction happens in synchronizeWithChain');
    assert.strictEqual(slot52.orderId, null,
        'NEW order should have null orderId');
    
    // CRITICAL ASSERTION 3: Verify sizes are preserved
    assert.strictEqual(slot51.size, 45, 'slot-51 size should be preserved');
    assert.strictEqual(slot52.size, 40, 'slot-52 size should be preserved');
    
    console.log('✓ COW-012 passed');
}

/**
 * COW-013: Verify orders transitioning type (e.g., rotation) remain VIRTUAL
 * 
 * When an order slot changes type (BUY->SELL or vice versa), it represents
 * a rotation where the old order will be cancelled and a new one placed.
 * The new order must be VIRTUAL until blockchain confirms.
 */
async function testCOW013_TypeChangeOrdersRemainVirtual() {
    console.log('\n[COW-013] Testing type-change orders remain VIRTUAL (rotation scenario)...');
    
    // Master grid has an active BUY order
    const masterGrid = new Map([
        ['slot-100', {
            id: 'slot-100',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 50,
            orderId: '1.7.99999'
        }]
    ]);
    
    // Target grid wants to change it to SELL (rotation)
    const targetGrid = new Map([
        ['slot-100', {
            id: 'slot-100',
            type: ORDER_TYPES.SELL,  // Type changed!
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 50
        }]
    ]);
    
    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid);
    
    const slot100 = workingGrid.get('slot-100');
    assert(slot100, 'slot-100 should exist');
    
    // When type changes, orderId should be cleared (different order on chain)
    // and state should be VIRTUAL until new order is placed
    assert.strictEqual(slot100.type, ORDER_TYPES.SELL, 'Type should be updated to SELL');
    assert.strictEqual(slot100.orderId, null, 
        'orderId should be cleared when type changes (old order will be cancelled)');
    assert.strictEqual(slot100.state, ORDER_STATES.VIRTUAL,
        'Order with cleared orderId must be VIRTUAL until synchronizeWithChain');
    
    console.log('✓ COW-013 passed');
}

/**
 * COW-014: Verify zero-size orders become VIRTUAL
 * 
 * Orders with size 0 represent cancelled/virtualized slots and must
 * always be VIRTUAL state, regardless of what target grid requests.
 */
async function testCOW014_ZeroSizeOrdersBecomeVirtual() {
    console.log('\n[COW-014] Testing zero-size orders become VIRTUAL...');
    
    const masterGrid = new Map([
        ['slot-200', {
            id: 'slot-200',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 50,
            orderId: '1.7.88888'
        }]
    ]);
    
    // Target grid sets size to 0 (order should be cancelled)
    const targetGrid = new Map([
        ['slot-200', {
            id: 'slot-200',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,  // Target might say ACTIVE, but size=0 overrides
            price: 100,
            size: 0  // Zero size = virtualized
        }]
    ]);
    
    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid);
    
    const slot200 = workingGrid.get('slot-200');
    assert(slot200, 'slot-200 should exist');
    assert.strictEqual(slot200.size, 0, 'Size should be 0');
    assert.strictEqual(slot200.state, ORDER_STATES.VIRTUAL,
        'Zero-size order must be VIRTUAL regardless of target state');
    assert.strictEqual(slot200.orderId, null,
        'Zero-size order should have null orderId');
    
    console.log('✓ COW-014 passed');
}

/**
 * COW-015: Full accounting flow simulation
 * 
 * Simulates the complete COW flow to verify that:
 * 1. Working grid has new orders as VIRTUAL
 * 2. After COW commit, orders are still VIRTUAL in the committed map
 * 3. synchronizeWithChain would see VIRTUAL->ACTIVE transition
 */
async function testCOW015_FullAccountingFlowSimulation() {
    console.log('\n[COW-015] Testing full accounting flow simulation...');
    
    // Initial state: empty grid
    const masterGrid = new Map();
    
    // Target wants to place a new order
    const targetGrid = new Map([
        ['slot-300', {
            id: 'slot-300',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,  // Target wants ACTIVE
            price: 100,
            size: 83.62424  // The exact size from the original bug
        }]
    ]);
    
    // Step 1: Create working grid and project
    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid);
    
    // Verify working grid has VIRTUAL state
    const workingOrder = workingGrid.get('slot-300');
    assert.strictEqual(workingOrder.state, ORDER_STATES.VIRTUAL,
        'Working grid order must be VIRTUAL before commit');
    
    // Step 2: Simulate COW commit (toMap)
    const committedGrid = workingGrid.toMap();
    const committedOrder = committedGrid.get('slot-300');
    
    assert.strictEqual(committedOrder.state, ORDER_STATES.VIRTUAL,
        'Committed grid order must still be VIRTUAL');
    assert.strictEqual(committedOrder.orderId, null,
        'Committed grid order must have null orderId');
    
    // Step 3: Verify the state transition that synchronizeWithChain would perform
    // (This is what triggers updateOptimisticFreeBalance with proper deduction)
    const oldState = committedOrder.state;
    const newState = ORDER_STATES.ACTIVE;  // What sync would set
    
    assert.strictEqual(oldState, ORDER_STATES.VIRTUAL, 'Old state must be VIRTUAL');
    assert.strictEqual(newState, ORDER_STATES.ACTIVE, 'New state would be ACTIVE');
    assert.notStrictEqual(oldState, newState, 
        'State transition must occur (VIRTUAL->ACTIVE) for accounting to work');
    
    // Calculate what the commitment delta would be
    const oldIsActive = (oldState === ORDER_STATES.ACTIVE || oldState === ORDER_STATES.PARTIAL);
    const newIsActive = (newState === ORDER_STATES.ACTIVE || newState === ORDER_STATES.PARTIAL);
    const oldCommitted = oldIsActive ? committedOrder.size : 0;
    const newCommitted = newIsActive ? committedOrder.size : 0;
    const commitmentDelta = newCommitted - oldCommitted;
    
    assert.strictEqual(oldCommitted, 0, 'Old committed should be 0 (VIRTUAL)');
    assert.strictEqual(newCommitted, 83.62424, 'New committed should be order size');
    assert.strictEqual(commitmentDelta, 83.62424, 
        'Commitment delta must equal order size for proper fund deduction');
    
    console.log('✓ COW-015 passed');
}

/**
 * COW-016: Fill-driven reconcile must be rotation-only for updates
 *
 * Regression guard for post-fill churn:
 * - Plain in-place ACTIVE size mismatches must NOT emit UPDATE actions.
 * - Rotation candidates (surplus -> hole) must still emit UPDATE with newGridId.
 */
async function testCOW016_RotationOnlyUpdatesInReconcile() {
    console.log('\n[COW-016] Testing reconcile emits rotation-only updates...');

    // Case A: Active size mismatch only -> no UPDATE action
    const masterA = new Map([
        ['slot-a', {
            id: 'slot-a',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 10,
            orderId: '1.7.1001'
        }]
    ]);
    const targetA = new Map([
        ['slot-a', {
            id: 'slot-a',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 12
        }]
    ]);

    const resultA = reconcileGrid(masterA, targetA, null);
    assert.strictEqual(resultA.actions.length, 0, 'In-place ACTIVE size mismatch should not emit actions');
    assert.strictEqual(resultA.actions.filter(a => a.type === 'update').length, 0, 'In-place ACTIVE size mismatch should not emit UPDATE');

    // Case B: Surplus + hole -> rotation UPDATE with newGridId
    const masterB = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 99,
            size: 10,
            orderId: '1.7.2001'
        }],
        ['slot-2', {
            id: 'slot-2',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 10,
            orderId: '1.7.2002'
        }]
    ]);
    const targetB = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 99,
            size: 10
        }],
        ['slot-2', {
            id: 'slot-2',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 10
        }],
        ['slot-3', {
            id: 'slot-3',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 101,
            size: 12
        }]
    ]);

    const resultB = reconcileGrid(masterB, targetB, null);
    const updatesB = resultB.actions.filter(a => a.type === 'update');
    assert.strictEqual(updatesB.length, 1, 'Surplus->hole pairing should emit exactly one rotation UPDATE');
    assert.strictEqual(updatesB[0].id, 'slot-1', 'Rotation source should be surplus slot');
    assert.strictEqual(updatesB[0].newGridId, 'slot-3', 'Rotation destination should be hole slot');
    assert.strictEqual(typeof updatesB[0].newGridId, 'string', 'Rotation UPDATE must carry newGridId');

    console.log('✓ COW-016 passed');
}

/**
 * COW-017: Dust holes must not be filled via rotation UPDATE
 *
 * Regression guard for double-dust prevention:
 * - If a target hole is below double-dust threshold, reconcile must not emit
 *   CREATE or rotation UPDATE for that slot.
 */
async function testCOW017_NoRotationIntoDustHole() {
    console.log('\n[COW-017] Testing reconcile skips rotation into dust-sized hole...');

    const master = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 99,
            size: 100,
            orderId: '1.7.3001'
        }],
        ['slot-2', {
            id: 'slot-2',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 100,
            size: 0
        }]
    ]);

    const target = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 99,
            size: 0
        }],
        ['slot-2', {
            id: 'slot-2',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 5,
            idealSize: 100
        }]
    ]);

    const result = reconcileGrid(master, target, null, { dustThresholdPercent: 5 });
    assert.strictEqual(result.actions.filter(a => a.type === 'update').length, 0, 'Dust hole must not receive rotation UPDATE');
    assert.strictEqual(result.actions.filter(a => a.type === 'create').length, 0, 'Dust hole must not receive CREATE');

    console.log('✓ COW-017 passed');
}

/**
 * COW-018: PARTIAL order size must be preserved in projectTargetToWorkingGrid
 *
 * REGRESSION TEST for fund-invariant violation bug:
 * - A partial buy fill leaves slot-N with state=PARTIAL, size=<remaining> on chain.
 * - calculateTargetGrid computes the ideal full size for that slot (ignoring the
 *   partial fill state) and places it in the target grid.
 * - projectTargetToWorkingGrid must NOT overwrite current.size with targetSize for
 *   PARTIAL orders that are still on-chain — no UPDATE action was emitted to resize
 *   the order, so the blockchain still holds current.size.
 * - Overwriting would cause recalculateFunds to count the ideal size as committed,
 *   inflating chainBuy by ~350 BTS and triggering a CRITICAL fund-invariant
 *   violation ("trackedTotal > blockchainTotal").
 *
 * Fix: preserve current.size when keepOrderId && current.state === PARTIAL.
 */
async function testCOW018_PartialOrderSizePreservedInProjection() {
    console.log('\n[COW-018] Testing PARTIAL order size preserved in projectTargetToWorkingGrid...');

    const partialRemainingSize = 3.68;    // What is actually on chain after a fill
    const idealTargetSize     = 354.41;  // What calculateTargetGrid computes

    // Master grid reflects the post-fill state: slot-157 is PARTIAL with the
    // actual remaining size.
    const masterGrid = new Map([
        ['slot-157', {
            id: 'slot-157',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            price: 0.00270,
            size: partialRemainingSize,
            orderId: '1.7.55555'   // Still on chain — same order, partially filled
        }]
    ]);

    // Target grid computed by calculateTargetGrid — uses the ideal geometric size,
    // unaware of the partial fill.
    const targetGrid = new Map([
        ['slot-157', {
            id: 'slot-157',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,  // Target wants a full-size active order
            price: 0.00270,
            size: idealTargetSize
        }]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid);

    const result = workingGrid.get('slot-157');
    assert(result, 'slot-157 should exist in working grid');

    // The orderId must be kept (same type, still on chain).
    assert.strictEqual(result.orderId, '1.7.55555',
        'PARTIAL order orderId must be preserved');

    // State must remain PARTIAL — the order is still on chain, partially filled.
    assert.strictEqual(result.state, ORDER_STATES.PARTIAL,
        'PARTIAL order state must remain PARTIAL');

    // CRITICAL: size must NOT be overwritten with the ideal target size.
    // recalculateFunds sums size for all ACTIVE/PARTIAL orders; if we wrote
    // idealTargetSize here, chainBuy would be inflated by ~350 BTS.
    assert.strictEqual(result.size, partialRemainingSize,
        'PARTIAL order must keep actual on-chain size, not overwritten with ideal target size');

    assert.notStrictEqual(result.size, idealTargetSize,
        'PARTIAL order size must NOT equal idealTargetSize (would cause fund-invariant violation)');

    console.log('✓ COW-018 passed');
}

/**
 * COW-018b: ACTIVE order size is preserved when no explicit UPDATE action exists.
 *
 * Prevents COW projection from committing synthetic target sizes for unchanged
 * on-chain orders. Size should only change if an UPDATE is explicitly planned.
 */
async function testCOW018b_ActiveOrderSizePreservedWithoutUpdateAction() {
    console.log('\n[COW-018b] Testing ACTIVE order size preserved without UPDATE action...');

    const masterGrid = new Map([
        ['slot-50', {
            id: 'slot-50',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 0.00270,
            size: 100,
            orderId: '1.7.11111'
        }]
    ]);

    const targetGrid = new Map([
        ['slot-50', {
            id: 'slot-50',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 0.00270,
            size: 120   // Target wants a different size
        }]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid);

    const result = workingGrid.get('slot-50');
    assert(result, 'slot-50 should exist');
    assert.strictEqual(result.orderId, '1.7.11111', 'orderId preserved');
    assert.strictEqual(result.state, ORDER_STATES.ACTIVE, 'state remains ACTIVE');
    assert.strictEqual(result.size, 100,
        'ACTIVE order size must remain unchanged without explicit UPDATE action');

    console.log('✓ COW-018b passed');
}

/**
 * COW-018d: ACTIVE order size follows target when explicit UPDATE action exists.
 */
async function testCOW018d_ActiveOrderSizeUpdatedWithUpdateAction() {
    console.log('\n[COW-018d] Testing ACTIVE order size updated with explicit UPDATE action...');

    const masterGrid = new Map([
        ['slot-50', {
            id: 'slot-50',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 0.00270,
            size: 100,
            orderId: '1.7.11111'
        }]
    ]);

    const targetGrid = new Map([
        ['slot-50', {
            id: 'slot-50',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 0.00270,
            size: 120
        }]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid, {
        actions: [{ type: 'update', id: 'slot-50', orderId: '1.7.11111', newSize: 120 }]
    });

    const result = workingGrid.get('slot-50');
    assert(result, 'slot-50 should exist');
    assert.strictEqual(result.orderId, '1.7.11111', 'orderId preserved');
    assert.strictEqual(result.state, ORDER_STATES.ACTIVE, 'state remains ACTIVE');
    assert.strictEqual(result.size, 120,
        'ACTIVE order size should follow target when UPDATE action is explicit');

    console.log('✓ COW-018d passed');
}

/**
 * COW-018c: PARTIAL preserve-path normalizes malformed current.size safely.
 *
 * If current.size is malformed/non-finite, projection should keep the order
 * on-chain identity/state but normalize size to a safe finite non-negative
 * value instead of propagating invalid data.
 */
async function testCOW018c_PartialPreservePathNormalizesMalformedSize() {
    console.log('\n[COW-018c] Testing PARTIAL preserve-path normalizes malformed size...');

    const idealTargetSize = 222.22;

    const masterGrid = new Map([
        ['slot-88', {
            id: 'slot-88',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            price: 0.00270,
            size: Number.NaN,
            orderId: '1.7.88888'
        }]
    ]);

    const targetGrid = new Map([
        ['slot-88', {
            id: 'slot-88',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 0.00270,
            size: idealTargetSize
        }]
    ]);

    const workingGrid = new WorkingGrid(masterGrid);
    projectTargetToWorkingGrid(workingGrid, targetGrid);

    const result = workingGrid.get('slot-88');
    assert(result, 'slot-88 should exist');
    assert.strictEqual(result.orderId, '1.7.88888', 'orderId preserved for PARTIAL on-chain order');
    assert.strictEqual(result.state, ORDER_STATES.PARTIAL, 'state remains PARTIAL');
    assert(Number.isFinite(result.size), 'size must be finite after normalization');
    assert(result.size >= 0, 'size must be non-negative after normalization');
    assert.strictEqual(result.size, 0, 'malformed PARTIAL size should normalize to 0');

    console.log('✓ COW-018c passed');
}

/**
 * COW-019: PARTIAL surplus rotation must clamp to booked remainder (no grid gap).
 *
 * PRODUCTION INCIDENT (<bot>, 2026-09-04): slot-103 filled and became a
 * spread placeholder (hole), while distant slot-123 sat PARTIAL with 3.314
 * remaining against a 4.84 hole target. The planner emitted rotation UPDATE
 * slot-123 -> slot-103 at the full hole size, and the COW executor's
 * post-fill growth guard correctly skipped every attempt (a partial must not
 * be grown in place) — but the skip stranded the hole, leaving a 7-slot gap
 * (945.55 -> 968.55) that never healed because the window counted slot-123
 * as one of its 20 actives.
 *
 * Fix: the planner clamps rotation UPDATEs from PARTIAL surpluses to the
 * booked remaining size (same policy as clampPostFillUpdateSize for plain
 * size UPDATEs), so the hole fills at remainder size and the grid stays
 * contiguous. Covers both pairing sites: reconcileGrid.pairRotations and
 * optimizeRebalanceActions.
 */
async function testCOW019_PartialRotationClampedToBookedRemainder() {
    console.log('\n[COW-019] Testing PARTIAL rotation clamps to booked remainder...');

    // Case A: reconcileGrid — PARTIAL surplus + larger hole
    const masterA = new Map([
        ['slot-103', {
            id: 'slot-103',
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            price: 912.07,
            size: 0,
            orderId: null
        }],
        ['slot-123', {
            id: 'slot-123',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            price: 968.56,
            size: 3.314,
            orderId: '1.7.4001'
        }]
    ]);
    const targetA = new Map([
        ['slot-103', {
            id: 'slot-103',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 912.07,
            size: 4.8455
        }],
        ['slot-123', {
            id: 'slot-123',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 968.56,
            size: 4.4612
        }]
    ]);

    const resultA = reconcileGrid(masterA, targetA, null);
    const updatesA = resultA.actions.filter(a => a.type === 'update');
    assert.strictEqual(updatesA.length, 1, 'PARTIAL surplus + hole must still emit one rotation UPDATE (no stranded hole)');
    assert.strictEqual(updatesA[0].id, 'slot-123', 'Rotation source should be the PARTIAL surplus slot');
    assert.strictEqual(updatesA[0].newGridId, 'slot-103', 'Rotation destination should be the hole slot');
    assert.strictEqual(updatesA[0].newSize, 3.314, 'Rotation size must clamp to booked remainder, not hole size');

    // Case B: reconcileGrid — ACTIVE surplus is NOT clamped
    const masterB = new Map([
        ['slot-103', {
            id: 'slot-103',
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            price: 912.07,
            size: 0,
            orderId: null
        }],
        ['slot-123', {
            id: 'slot-123',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 968.56,
            size: 4.4612,
            orderId: '1.7.4002'
        }]
    ]);
    const resultB = reconcileGrid(masterB, targetA, null);
    const updatesB = resultB.actions.filter(a => a.type === 'update');
    assert.strictEqual(updatesB.length, 1, 'ACTIVE surplus + hole must emit one rotation UPDATE');
    assert.strictEqual(updatesB[0].newSize, 4.8455, 'ACTIVE surplus rotation must keep the full hole size');

    // Case C: optimizeRebalanceActions — CANCEL(PARTIAL) + CREATE pairing clamps
    const actionsC = [
        { type: 'cancel', id: 'slot-123', orderId: '1.7.4001', reason: 'surplus-no-rotation-target' },
        { type: 'create', id: 'slot-103', order: { id: 'slot-103', type: ORDER_TYPES.SELL, price: 912.07, size: 4.8455 } }
    ];
    const masterC = new Map([
        ['slot-123', {
            id: 'slot-123',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            price: 968.56,
            size: 3.314,
            orderId: '1.7.4001'
        }]
    ]);
    const resultC = optimizeRebalanceActions(actionsC, masterC);
    const updatesC = resultC.filter(a => a.type === 'update');
    assert.strictEqual(updatesC.length, 1, 'CANCEL+CREATE pairing must fold into one rotation UPDATE');
    assert.strictEqual(updatesC[0].newGridId, 'slot-103', 'Rotation destination should be the CREATE slot');
    assert.strictEqual(updatesC[0].newSize, 3.314, 'Paired rotation from PARTIAL must clamp to booked remainder');

    console.log('✓ COW-019 passed');
}

async function runAllTests() {
    console.log('=== Copy-on-Write Master Plan Test Suite ===\n');
    
    await testCOW001_MasterUnchangedOnFailure();
    await testCOW002_MasterUpdatedOnlyOnSuccess();
    await testCOW003_IndexTransfer();
    await testCOW004_FundRecalculation();
    await testCOW005_OrderComparison();
    await testCOW006_DeltaBuilding();
    await testCOW007_IndexValidation();
    await testCOW008_WorkingGridIndependence();
    await testCOW009_EmptyGridHandling();
    await testCOW010_MemoryStats();
    await testCOW011_NoSpuriousUpdatesOnUnchangedGrid();
    await testCOW012_NewOrdersRemainVirtualUntilSync();
    await testCOW013_TypeChangeOrdersRemainVirtual();
    await testCOW014_ZeroSizeOrdersBecomeVirtual();
    await testCOW015_FullAccountingFlowSimulation();
    await testCOW016_RotationOnlyUpdatesInReconcile();
    await testCOW017_NoRotationIntoDustHole();
    await testCOW018_PartialOrderSizePreservedInProjection();
    await testCOW018b_ActiveOrderSizePreservedWithoutUpdateAction();
    await testCOW018c_PartialPreservePathNormalizesMalformedSize();
    await testCOW018d_ActiveOrderSizeUpdatedWithUpdateAction();
    await testCOW019_PartialRotationClampedToBookedRemainder();
    
    console.log('\n=== All COW tests passed! ===');
}

runAllTests().catch(console.error);
