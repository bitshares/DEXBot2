/**
 * Test for COW-based divergence correction
 * Verifies that surplus on-chain orders are cancelled,
 * and committed order updates preserve expected working-grid state.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { applyGridDivergenceCorrections } = require('../modules/order/utils/system');
const { updateGridFromBlockchainSnapshot, _recalculateGridOrderSizesFromBlockchain } = require('../modules/order/grid');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_STATES, ORDER_TYPES, COW_ACTIONS } = require('../modules/constants');

async function testCOWDivergenceCorrection() {
    console.log('\nRunning COW Divergence Correction Tests...\n');

    // Create manager with test configuration
    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        activeOrders: { buy: 3, sell: 3 },
        botFunds: { buy: 1000, sell: 1000 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    manager.boundaryIdx = 5; // Slots 0-5 = BUY, 6+ = SELL
    manager.outOfSpread = 0;
    manager._gridVersion = 1;

    // Initialize grid with 10 slots
    for (let i = 0; i < 10; i++) {
        const type = i <= 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 95 + i,
            type,
            state: ORDER_STATES.VIRTUAL,
            size: 0
        });
    }

    // Set account totals
    await manager.setAccountTotals({
        buy: 1000,
        sell: 100,
        buyFree: 1000,
        sellFree: 100
    });
    await manager.recalculateFunds();

    // Divergence mechanics tests operate on resting orders. `_updateOrder`
    // stamps every new chain binding as a fresh placement, and the
    // fresh-placement grace would otherwise defer the surplus cancels these
    // tests assert. Age the stamps so the correction runs unguarded here; the
    // guarded behavior has its own test
    // (tests/test_fresh_placement_cancel_grace_paths.ts).
    const applyAgedDivergence = (...args: any[]) => {
        manager._placedAt.clear();
        return (applyGridDivergenceCorrections as any)(...args);
    };

    // Test 1: Surplus orders never become size-to-zero updates
    console.log('Test 1: Surplus orders are cancelled or rotated, never updated to size=0');
    {
        // Create 5 active BUY orders (but target is 3)
        for (let i = 0; i < 5; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                size: 100,
                orderId: `chain-${i}`
            });
        }

        manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY]);
        manager.outOfSpread = 1;

        let capturedCowResult = null;
        const mockUpdateFn = async (cowResult) => {
            capturedCowResult = cowResult;
            return { executed: true };
        };

        const mockAccountOrders = { storeMasterGrid: async () => {} };

        await applyAgedDivergence(manager, mockAccountOrders, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

        // Verify COW result structure
        assert(capturedCowResult, 'Should have COW result');
        assert(capturedCowResult.workingGrid, 'Should have working grid');
        assert(capturedCowResult.actions, 'Should have actions array');

        // Check actions: surplus should be CANCEL actions
        const updateActions = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.UPDATE);
        const cancelActions = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.CANCEL);

        console.log(`  - UPDATE actions: ${updateActions.length}`);
        console.log(`  - CANCEL actions: ${cancelActions.length}`);

        assert(cancelActions.length >= 2, 'Should have CANCEL actions for surplus orders');

        // Check that no UPDATE-to-zero actions are emitted
        const surplusUpdates = updateActions.filter(a => a.newSize === 0);
        console.log(`  - Size-to-zero updates: ${surplusUpdates.length}`);
        assert(surplusUpdates.length === 0, 'Surplus should not be updated to size=0');

        // Verify cancelled slots are virtualized in working grid
        for (const action of cancelActions) {
            const workingOrder = capturedCowResult.workingGrid.get(action.id);
            assert(workingOrder, `Working grid should have slot ${action.id}`);
            assert(workingOrder.state === ORDER_STATES.VIRTUAL,
                `Cancelled slot ${action.id} should be VIRTUAL in working grid`);
            assert(workingOrder.orderId === null,
                `Cancelled slot ${action.id} should clear orderId in working grid`);
        }

        console.log('  ✓ Surplus orders are cancelled and virtualized\n');
    }

    // Test 2: Working grid preserves PARTIAL state for desired committed orders
    console.log('Test 2: Desired PARTIAL order should preserve state in working grid');
    {
        // Reset manager
        for (let i = 0; i < 10; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: i <= 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            });
        }

        // Create PARTIAL order in desired window (highest buy slot)
        await manager._updateOrder({
            id: 'slot-5',
            price: 100,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 50,
            orderId: 'chain-partial'
        });

        manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY]);

        let capturedCowResult = null;
        const mockUpdateFn = async (cowResult) => {
            capturedCowResult = cowResult;
            return { executed: true };
        };

        await applyAgedDivergence(manager, { storeMasterGrid: async () => {} }, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

        // Verify PARTIAL state is preserved
        const workingOrder = capturedCowResult.workingGrid.get('slot-5');
        assert(workingOrder.state === ORDER_STATES.PARTIAL,
            'PARTIAL order should preserve PARTIAL state in working grid');
        assert(workingOrder.orderId === 'chain-partial',
            'PARTIAL order should preserve orderId in working grid');

        console.log('  ✓ Working grid preserves PARTIAL states\n');
    }

    // Test 3: Orders within target window get size updates
    console.log('Test 3: Orders within target window get size updates');
    {
        // Reset and set up 3 active orders within target
        for (let i = 0; i < 10; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: i <= 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            });
        }

        // 3 active orders in desired window with old sizes
        await manager._updateOrder({
            id: 'slot-3', price: 98, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 50, orderId: 'chain-3'
        });
        await manager._updateOrder({
            id: 'slot-4', price: 99, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 50, orderId: 'chain-4'
        });
        await manager._updateOrder({
            id: 'slot-5', price: 100, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 50, orderId: 'chain-5'
        });

        manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY]);

        let capturedCowResult = null;
        const mockUpdateFn = async (cowResult) => {
            capturedCowResult = cowResult;
            return { executed: true };
        };

        await applyAgedDivergence(manager, { storeMasterGrid: async () => {} }, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

        // Check that active orders got UPDATE actions
        const updateActions = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.UPDATE);
        const activeUpdates = updateActions.filter(a => a.id === 'slot-3' || a.id === 'slot-4' || a.id === 'slot-5');

        console.log(`  - Active orders with size updates: ${activeUpdates.length}`);
        assert(activeUpdates.length === 3, 'All 3 active orders should have UPDATE actions');

        // Verify working grid has new sizes
        for (const action of activeUpdates) {
            const workingOrder = capturedCowResult.workingGrid.get(action.id);
            assert(workingOrder.size === action.newSize,
                `Order ${action.id} should have new size in working grid`);
        }

        console.log('  ✓ Orders within target window get size updates\n');
    }

    // Test 4: No order may have both UPDATE and CANCEL in same batch
    console.log('Test 4: No duplicate UPDATE+CANCEL for same order');
    {
        // Reset manager
        for (let i = 0; i < 10; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: i <= 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            });
        }

        // Create 5 active BUY orders while target is 3.
        // This can produce UPDATE plans from resize and CANCEL plans from divergence
        // for the same low-priority slots if dedupe is broken.
        for (let i = 0; i < 5; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                size: 100,
                orderId: `chain-dupe-${i}`
            });
        }

        manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY]);
        manager.outOfSpread = 1;

        let capturedCowResult = null;
        const mockUpdateFn = async (cowResult) => {
            capturedCowResult = cowResult;
            return { executed: true };
        };

        await applyAgedDivergence(manager, { storeMasterGrid: async () => {} }, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

        assert(capturedCowResult && Array.isArray(capturedCowResult.actions), 'Should have actions');

        const updates = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.UPDATE);
        const cancels = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.CANCEL);

        const updateKeys = new Set(updates.map(a => `${a.id}|${a.orderId || ''}`));
        let overlapCount = 0;
        for (const c of cancels) {
            if (updateKeys.has(`${c.id}|${c.orderId || ''}`)) overlapCount++;
        }

        console.log(`  - UPDATE actions: ${updates.length}`);
        console.log(`  - CANCEL actions: ${cancels.length}`);
        console.log(`  - UPDATE/CANCEL overlap: ${overlapCount}`);

        assert(overlapCount === 0, 'No order should be both UPDATE and CANCEL in same batch');
        console.log('  ✓ No duplicate UPDATE+CANCEL actions\n');
    }

    // Test 5: Surplus orders pair with hole slots into rotation UPDATEs (reprice
    // in place) instead of cancel+recreate. Mirrors a fill-driven boundary shift
    // where slots are re-typed: orders sit outside the desired window while
    // desired slots hold no orders.
    console.log('Test 5: Surplus + holes become rotation UPDATEs instead of cancel+create');
    {
        // Boundary 9: all 10 slots lie in the BUY rail (idx <= boundary), which
        // is the geometric invariant the divergence correction now enforces —
        // slots above the boundary would otherwise be gap-band strays excluded
        // by isSlotInRail.  Desired window is top-3 by price = slots 7/8/9.
        manager.boundaryIdx = 9;
        for (let i = 0; i < 10; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 90 + i,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            });
        }

        // 3 BUY orders outside the desired window (prices 90-92), target is 3,
        // desired window is top-3 = slots 7/8/9 (prices 97-99) with no orders.
        for (let i = 0; i < 3; i++) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 90 + i,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                size: 100,
                orderId: `chain-rot-${i}`
            });
        }

        manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY]);

        let capturedCowResult = null;
        const mockUpdateFn = async (cowResult) => {
            capturedCowResult = cowResult;
            return { executed: true };
        };

        await applyAgedDivergence(manager, { storeMasterGrid: async () => {} }, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

        assert(capturedCowResult && Array.isArray(capturedCowResult.actions), 'Should have actions');

        const updates = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.UPDATE);
        const cancels = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.CANCEL);
        const creates = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.CREATE);

        const rotations = updates.filter(a => a.newGridId && a.newGridId !== a.id);

        console.log(`  - CANCEL actions: ${cancels.length}`);
        console.log(`  - CREATE actions: ${creates.length}`);
        console.log(`  - Rotation UPDATEs: ${rotations.length}`);

        assert.strictEqual(cancels.length, 0,
            'All surplus orders should pair into rotations, leaving no CANCEL');
        assert.strictEqual(creates.length, 0,
            'All holes should be filled by rotations, leaving no CREATE');
        assert.strictEqual(rotations.length, 3,
            'Expected 3 rotation UPDATEs (one per surplus/hole pair)');

        // Each rotation reprices the surplus order (id) onto a hole slot (newGridId)
        const sourceIds = new Set(rotations.map(r => r.id));
        const targetIds = new Set(rotations.map(r => r.newGridId));
        for (let i = 0; i < 3; i++) {
            assert(sourceIds.has(`slot-${i}`), `Rotation source should include slot-${i}`);
            assert(targetIds.has(`slot-${7 + i}`), `Rotation target should include slot-${7 + i}`);
            const rotation = rotations.find(r => r.id === `slot-${i}`);
            assert.strictEqual(rotation.orderId, `chain-rot-${i}`,
                `Rotation should carry the source order's chain id`);
            assert.strictEqual(rotation.newGridId, `slot-${7 + i}`,
                `Rotation should target the hole slot slot-${7 + i}`);
            assert(rotation.newPrice === (90 + 7 + i),
                `Rotation should adopt the hole slot price ${90 + 7 + i}`);
        }

        // Source slots are virtualized in the working grid (orderId cleared)
        for (let i = 0; i < 3; i++) {
            const workingOrder = capturedCowResult.workingGrid.get(`slot-${i}`);
            assert(workingOrder && workingOrder.orderId === null,
                `Rotation source slot-${i} should be cleared in working grid`);
        }

        console.log('  ✓ Surplus orders repriced in place onto hole slots\n');
    }

    // Test 6: h-bts regression — a boundary shift leaves on-chain
    // SELL orders inside the new spread gap.  The SPREAD GUARD keeps them typed
    // SELL (never SPREAD+ACTIVE), so a type-only window would pick them as
    // "closest to market" and leave the rail parked across the gap (spread
    // collapsed to one step).  The geometric rail filter must exclude them and
    // cancel them as surplus, keeping only true in-rail sells in the window.
    console.log('Test 6: Gap-band SELL strays excluded from the desired window and cancelled');
    {
        // Ensure sufficient free balance for 4×100 SELL orders (previous sellFree=100 insufficient)
        await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
        await manager.recalculateFunds();
        // boundary 5, gap 2 → sellStart 8; gap band = slots 6,7.
        manager.boundaryIdx = 5;
        manager._gapSlots = 2;
        manager.config.activeOrders.sell = 2;

        for (let i = 0; i < 10; i++) {
            const type = i <= 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            }, 'seed-test6', { skipAccounting: true, fee: 0 });
        }

        // On-chain SELL orders: two strays inside the gap band (slots 6,7 —
        // kept typed SELL by the SPREAD GUARD) + two in-rail sells (slots 8,9).
        // Without the geometric filter, desired = 6,7 (lowest-priced SELLs) and
        // nothing is corrected; with it, desired = 8,9 and 6,7 are surplus.
        for (const i of [6, 7, 8, 9]) {
            await manager._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: ORDER_TYPES.SELL,
                state: ORDER_STATES.ACTIVE,
                size: 100,
                orderId: `chain-gap-${i}`
            }, 'seed-test6-active', { skipAccounting: true, fee: 0 });
        }

        manager._gridSidesUpdated = new Set([ORDER_TYPES.SELL]);

        let capturedCowResult = null;
        const mockUpdateFn = async (cowResult) => {
            capturedCowResult = cowResult;
            return { executed: true };
        };

        await applyAgedDivergence(manager, { storeMasterGrid: async () => {} }, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

        assert(capturedCowResult && Array.isArray(capturedCowResult.actions), 'Should have actions');

        const cancelActions = capturedCowResult.actions.filter(a => a.type === COW_ACTIONS.CANCEL);
        const cancelIds = cancelActions.map(a => a.id);
        console.log(`  - CANCEL actions: ${cancelIds.join(', ') || '(none)'}`);

        assert(cancelIds.includes('slot-6'), 'Gap-band stray slot-6 should be cancelled as surplus');
        assert(cancelIds.includes('slot-7'), 'Gap-band stray slot-7 should be cancelled as surplus');
        assert(!cancelIds.includes('slot-8'), 'In-rail sell slot-8 must NOT be cancelled');
        assert(!cancelIds.includes('slot-9'), 'In-rail sell slot-9 must NOT be cancelled');

        // Working grid: cancelled strays become VIRTUAL spread placeholders.
        for (const id of ['slot-6', 'slot-7']) {
            const workingOrder = capturedCowResult.workingGrid.get(id);
            assert(workingOrder, `Working grid should have ${id}`);
            assert(workingOrder.state === ORDER_STATES.VIRTUAL,
                `Cancelled gap-band stray ${id} should be VIRTUAL`);
            assert(workingOrder.orderId === null,
                `Cancelled gap-band stray ${id} should clear orderId`);
        }

        // In-rail sells keep their chain ids in the working grid.
        for (const id of ['slot-8', 'slot-9']) {
            const idx = id.split('-')[1];
            const workingOrder = capturedCowResult.workingGrid.get(id);
            assert(workingOrder && workingOrder.orderId === `chain-gap-${idx}`,
                `In-rail sell ${id} should keep its chain id`);
        }

        console.log('  ✓ Gap-band strays cancelled; in-rail sells kept\n');
    }

    // Test 7: shelf/manual orders (non-slot-N ids) are never resized by the
    // geometric recalc (issue #27 follow-up). The recalc distributes the
    // side budget over every slot carrying the side's type — without the
    // slot-N gate a fork-kept shelf below the rail takes curve ideals and
    // emits on-chain UPDATEs, melting manuals. Same gate as reserve
    // classification and startup cancel candidates; no-op upstream.
    console.log('Test 7: Shelf orders keep manual sizes through the geometric recalc');
    {
        const shelfMgr = new OrderManager({
            assetA: 'TESTA',
            assetB: 'TESTB',
            startPrice: 100,
            incrementPercent: 1,
            targetSpreadPercent: 2,
            activeOrders: { buy: 5, sell: 3 },
            botFunds: { buy: 1000, sell: 1000 }
        });
        shelfMgr.assets = {
            assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
        };
        shelfMgr.boundaryIdx = 6;
        shelfMgr.outOfSpread = 0;
        shelfMgr._gridVersion = 1;
        for (let i = 0; i < 10; i++) {
            await shelfMgr._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: i < 6 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                state: ORDER_STATES.VIRTUAL,
                size: 0
            });
        }
        await shelfMgr.setAccountTotals({
            buy: 1000,
            sell: 100,
            buyFree: 1000,
            sellFree: 100
        });
        await shelfMgr.recalculateFunds();
        // Rail actives at curve-agnostic sizes plus a live shelf with manual
        // sizes deliberately far from any geometric ideal (500 vs a ~1000
        // budget split across 8 buy-typed slots).
        for (const i of [3, 4, 5]) {
            await shelfMgr._updateOrder({
                id: `slot-${i}`,
                price: 95 + i,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                size: 100,
                orderId: `chain-shelf-rail-${i}`
            });
        }
        for (const [id, price] of [['deep-1', 70], ['deep-0', 71]]) {
            await shelfMgr._updateOrder({
                id,
                price,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.ACTIVE,
                size: 500,
                orderId: `chain-shelf-${id}`
            });
        }
        const workingGrid = new WorkingGrid(shelfMgr.orders, { baseVersion: shelfMgr._gridVersion });
        const result = await _recalculateGridOrderSizesFromBlockchain(shelfMgr, ORDER_TYPES.BUY, { workingGrid });
        assert(result, 'recalc should return a COW result');
        assert.strictEqual(result.changed, true, 'rail virtuals take ideals, so the recalc path demonstrably ran');
        const shelfActions = (result.actions || []).filter((a: any) => String(a.id || '').startsWith('deep-'));
        console.log(`  - UPDATE actions for shelf ids: ${shelfActions.length}`);
        assert.strictEqual(shelfActions.length, 0, 'shelf slots must never emit resize UPDATEs');
        for (const id of ['deep-1', 'deep-0']) {
            const workingOrder = workingGrid.get(id);
            assert(workingOrder, `working grid should still hold ${id}`);
            assert.strictEqual(Number(workingOrder.size), 500, `shelf ${id} keeps its manual size`);
            assert.strictEqual(workingOrder.orderId, `chain-shelf-${id}`, `shelf ${id} keeps its chain binding`);
        }
        console.log('  ✓ Shelf manuals untouched; rail ideals still applied\n');
    }

    console.log('✓ All COW Divergence Correction tests PASSED!\n');
}

// Run tests
if (require.main === module) {
    testCOWDivergenceCorrection().catch(err => {
        console.error('Test FAILED:', err);
        process.exit(1);
    });
}

module.exports = { testCOWDivergenceCorrection };
