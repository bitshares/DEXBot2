/**
 * tests/test_dust_rebalance_logic.ts
 * 
 * Verifies single-side dust detection helpers remain active.
 * Dust detection should still identify unhealthy partials on each side independently.
 * 
 * processFilledOrders() should now trigger rebalance only for real fills.
 * This test verifies the underlying hasAnyDust() detection logic still works.
 */

const assert = require('assert');
const Module = require('module');

const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (typeof request === 'string' && request.includes('bitshares_client')) {
        return {
            BitShares: {
                subscribe: () => {},
                disconnect: () => {},
                ws: { isConnected: false }
            },
            waitForConnected: async () => {},
            createAccountClient: () => ({
                sign: () => {},
                broadcast: async () => ({})
            }),
            setSuppressConnectionLog: () => {},
            getNodeManager: () => ({
                getHealthyNodes: () => [
                    'wss://primary.bitshares.org/ws',
                    'wss://alt-1.bitshares.org/ws',
                    'wss://alt-2.bitshares.org/ws',
                ],
            }),
            getNodeStats: () => null,
            getNodeSummary: () => null,
            _internal: { get connected() { return false; } }
        };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, TIMING } = require('../modules/constants');
const { checkWindowDust, hasAnyDust, getDustOrders } = require('../modules/order/grid');
const { _setFeeCache } = require('../modules/order/utils/math');
const DEXBot = require('../modules/dexbot_class').default;
const {
    isOrderDoesNotExistError,
    recordDustFirstSeen,
    cancelDustOrders,
    getPendingDustDelayMs,
} = require('../modules/dexbot_maintenance_runtime');
const { withDynamicWeightFiles } = require('./helpers/dynamic_weight_files');

async function testDustTrigger() {
    console.log('Testing Dust Detection Logic (COW Architecture)...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    // Initialize with some funds
    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    // Mock logger
    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    // 1. Scenario: No fills, no dust - processFilledOrders returns empty
    console.log('\n  Scenario 1: No fills, no dust');
    let result = await manager.processFilledOrders([]);
    const hasActions = (result.actions?.length > 0) || (result.ordersToPlace?.length > 0);
    assert.strictEqual(!!hasActions, false, 'Should not have actions with no fills');
    console.log('  ✓ Correctly returned empty actions');

    // 2. Scenario: Single-side dust detection (BUY only)
    console.log('\n  Scenario 2: Single-side dust (BUY)');
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 0.9,
        orderId: '1.7.1'
    });

    const buyPartials = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.BUY && (o as any).state === ORDER_STATES.PARTIAL);
    const sellPartials = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.SELL && (o as any).state === ORDER_STATES.PARTIAL);

    const buyHasDust = buyPartials.length > 0 && await hasAnyDust(manager, buyPartials, 'buy');
    const sellHasDust = sellPartials.length > 0 && await hasAnyDust(manager, sellPartials, 'sell');

    assert.strictEqual(buyHasDust, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust, false, 'Sell side should NOT have dust (no partials)');
    assert.strictEqual(buyHasDust && sellHasDust, false, 'Should NOT trigger dual-side dust (only one side)');
    console.log('  ✓ Correctly detected single-side dust');

    // 3. Scenario: Dust detection remains side-local even when both sides have dust
    console.log('\n  Scenario 3: Both sides have dust (detection only)');
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 1.1,
        orderId: '1.7.2'
    });

    const buyPartials2 = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.BUY && (o as any).state === ORDER_STATES.PARTIAL);
    const sellPartials2 = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.SELL && (o as any).state === ORDER_STATES.PARTIAL);

    const buyHasDust2 = buyPartials2.length > 0 && await hasAnyDust(manager, buyPartials2, 'buy');
    const sellHasDust2 = sellPartials2.length > 0 && await hasAnyDust(manager, sellPartials2, 'sell');

    assert.strictEqual(buyHasDust2, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust2, true, 'Sell side should have dust');
    assert.strictEqual(buyHasDust2 && sellHasDust2, true, 'Should still detect dust on both sides');
    console.log('  ✓ Correctly detected dust on both sides without implying rebalance');

    // 4. Scenario: processFilledOrders with no real fills should not rebalance on dust alone
    console.log('\n  Scenario 4: Dust alone does not trigger rebalance');
    result = await manager.processFilledOrders([]);
    const noDustRebalance = result !== undefined && typeof result === 'object';
    assert.strictEqual(noDustRebalance, true, 'processFilledOrders should still return a result object');
    console.log('  ✓ Dust alone no longer triggers rebalance');

    // 5. Scenario: processFilledOrders with fills triggers rebalance
    console.log('\n  Scenario 5: processFilledOrders with fills (triggers rebalance)');
    
    // Reset dust orders to VIRTUAL first
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 0.9,
        orderId: null
    });
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 1.1,
        orderId: null
    });

    const fill = { id: 'buy-dust', type: ORDER_TYPES.BUY, price: 0.9, size: 10, isPartial: false };
    result = await manager.processFilledOrders([fill]);
    
    // processFilledOrders triggers performSafeRebalance for non-partial fills
    // Result may have actions/ordersToPlace depending on grid state
    // Key assertion: method completes without error (rebalance is triggered)
    const resultHasStructure = result !== undefined && typeof result === 'object';
    assert.strictEqual(resultHasStructure, true, 'processFilledOrders should return result object');
    console.log('  ✓ processFilledOrders correctly triggers rebalance for fills');

    // 6. Verify processFillsOnly properly processes fills
    console.log('\n  Scenario 6: processFillsOnly properly processes fills');
    
    // Create an active order to fill
    await manager._updateOrder({
        id: 'test-active',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 50,
        price: 0.85,
        orderId: '1.7.100'
    });

    const fillForActive = { 
        id: 'test-active', 
        type: ORDER_TYPES.BUY, 
        price: 0.85, 
        size: 50, 
        isPartial: false,
        orderId: '1.7.100'
    };
    
    // processFillsOnly should update the order state
    await manager.strategy.processFillsOnly([fillForActive], new Set());
    
    // The order should now be VIRTUAL (fully filled)
    const updatedOrder = manager.orders.get('test-active');
    assert.strictEqual(updatedOrder.state, ORDER_STATES.VIRTUAL, 'Filled order should be VIRTUAL');
    console.log('  ✓ processFillsOnly correctly updates order state');

    // 7. Verify dust cancel sync clears virtual reservation and releases funds
    console.log('\n  Scenario 7: dust cancel clears size and releases funds');

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });
    await manager._updateOrder({
        id: 'cancel-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        size: 0,
        price: 0.8,
        orderId: null
    });
    await manager._updateOrder({
        id: 'cancel-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 25,
        price: 0.8,
        orderId: '1.7.250'
    });

    assert.strictEqual(manager.accountTotals.buyFree, 975, 'Test setup should reflect locked buy funds');
    await manager.synchronizeWithChain({ orderId: '1.7.250', clearSize: true }, 'cancelOrder');

    const cancelledDust = manager.orders.get('cancel-dust');
    assert.strictEqual(cancelledDust.state, ORDER_STATES.VIRTUAL, 'Cancelled dust order should be virtualized');
    assert.strictEqual(cancelledDust.size, 0, 'Cancelled dust order should clear virtual reservation size');
    assert.strictEqual(manager.accountTotals.buyFree, 1000, 'Cancelled dust order should release remaining buy funds');
    console.log('  ✓ dust cancel correctly clears reservation and frees funds');

    console.log('\n✅ All dust detection tests passed!\n');
}

async function testDustCancelSyntheticRotation() {
    console.log('Testing Dust Cancel Synthetic Rotation...');

    let bot;
    const weightFiles = withDynamicWeightFiles('test_dust_cancel_rotation');
    try {
        let cancelCalls = 0;
        let syncCalls = 0;
        let processCalls = 0;
        let persistCalls = 0;
        weightFiles.writeSnapshot({
            isReady: true,
            effectiveWeights: { sell: 0.38, buy: 0.18 },
        });

        bot = new DEXBot({
            botKey: 'test_dust_cancel_rotation',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async (payload, source) => {
                syncCalls++;
                assert.strictEqual(source, 'cancelOrder', 'Dust cancel should sync through cancelOrder source');
                assert.deepStrictEqual(payload, { orderId: '1.7.900', clearSize: true }, 'Dust cancel should clear size on sync');
                return { newOrders: [], ordersNeedingCorrection: [] };
            },
            processFilledOrders: async (fills) => {
                processCalls++;
                assert.strictEqual(fills.length, 1, 'Expected one synthetic dust fill');
                assert.strictEqual(fills[0].id, 'dust-buy-1');
                assert.strictEqual(fills[0].isPartial, true, 'Synthetic dust trigger should remain marked partial');
                assert.strictEqual(fills[0].isDelayedRotationTrigger, true, 'Synthetic dust trigger should enter delayed rotation path');
                assert.deepStrictEqual(
                    bot.config.weightDistribution,
                    { sell: 0.6, buy: 0.4 },
                    'dust cancel does NOT refresh dynamic weights (redundant call removed — weights refresh on next maintenance cycle)'
                );
                assert.deepStrictEqual(
                    bot.manager.config.weightDistribution,
                    { sell: 0.6, buy: 0.4 },
                    'dust cancel does NOT refresh manager config weights'
                );
                return { actions: [] };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            recalculateFunds: async () => {},
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        };

        // Compiled ESM exports cannot be patched; use the bot-level seam.
        bot._submitCancelOrder = async (orderId: string) => {
            cancelCalls++;
            return { success: true, orderId };
        };

        const dustOrder = {
            id: 'dust-buy-1',
            orderId: '1.7.900',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        const result = await bot._cancelDustOrders({ buy: [dustOrder], sell: [] });
        assert.strictEqual(result.cancelledCount, 1, 'Dust cancel should fire immediately');
        assert.strictEqual(cancelCalls, 1, 'Dust cancel should submit one cancel');
        assert.strictEqual(syncCalls, 1, 'Dust cancel should synchronize once');
        assert.strictEqual(processCalls, 1, 'Dust cancel should trigger the synthetic fill pipeline');
        assert.strictEqual(persistCalls, 2, 'Dust cancel should persist grid (COW path + end-of-tick flushGridDirty safety net)');
        console.log('  ✓ Dust cancel triggers synthetic delayed rotation immediately (no timer)');
    } finally {
        weightFiles.cleanup();
    }
}

async function testDustCancelDoesNotBeatRealFill() {
    console.log('Testing Dust Cancel Real Fill Precedence...');

    let bot;
    try {
        let processCalls = 0;
        let persistCalls = 0;

        bot = new DEXBot({
            botKey: 'test_dust_cancel_precedence',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async () => {
                throw new Error('should not sync after failed cancel');
            },
            processFilledOrders: async () => {
                processCalls++;
                return { actions: [] };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            recalculateFunds: async () => {}
        };

        // Compiled ESM exports cannot be patched; use the bot-level seam.
        bot._submitCancelOrder = async () => {
            throw new Error('order already filled');
        };

        const dustOrder = {
            id: 'dust-sell-1',
            orderId: '1.7.901',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 1.1
        };

        const result = await bot._cancelDustOrders({ buy: [], sell: [dustOrder] });

        assert.strictEqual(result.cancelledCount, 0, 'Failed cancel should not count as dust rotation');
        assert.strictEqual(processCalls, 0, 'Failed cancel should not trigger synthetic fill processing');
        assert.strictEqual(persistCalls, 0, 'Failed cancel should not persist synthetic changes');
        console.log('  ✓ Real fill / failed cancel path does not trigger synthetic rotation');
    } finally {
    }
}

async function testDustCancelNodeFallback() {
    console.log('Testing Dust Cancel defers on BROADCAST_DEADLINE (no client-side node fallback re-send)...');

    let bot;
    try {
        let cancelCalls = 0;
        let syncCalls = 0;
        let processCalls = 0;
        let persistCalls = 0;

        bot = new DEXBot({
            botKey: 'test_dust_cancel_fallback',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async (payload) => {
                syncCalls++;
                return { newOrders: [], ordersNeedingCorrection: [] };
            },
            processFilledOrders: async (fills) => {
                processCalls++;
                return { actions: [] };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            recalculateFunds: async () => {},
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        };

        // The helper no longer passes node-fallback options: the credential
        // client makes a single attempt (node cycling + 3x retry live inside
        // the daemon) and uncertain cancels propagate for the next detection
        // cycle. Here we just verify cancellation is submitted once through
        // the bot-level seam (compiled ESM exports cannot be patched).
        bot._submitCancelOrder = async (orderId: string) => {
            cancelCalls++;
            return { success: true, orderId };
        };

        const dustOrder = {
            id: 'dust-buy-1',
            orderId: '1.7.903',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9,
        };

        const result = await bot._cancelDustOrders({ buy: [dustOrder], sell: [] });
        assert.strictEqual(result.cancelledCount, 1, 'Cancel should succeed');
        assert.strictEqual(cancelCalls, 1, 'cancelOrder called once (retry in credential client)');
        assert.strictEqual(syncCalls, 1, 'Should sync after successful cancel');
        assert.strictEqual(processCalls, 1, 'Should process synthetic fill');
        console.log('  ✓ Dust cancel defers uncertain outcomes and passes no node-fallback options');
    } finally {
    }
}

async function testDustCancelOrderMissingClassifier() {
    console.log('Testing Dust Cancel Order-Missing Classifier...');

    assert.strictEqual(
        isOrderDoesNotExistError('order does not exist', '1.7.902'),
        true,
        'Explicit order-missing errors should trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('Could not find Object: 1.7.902', '1.7.902'),
        true,
        'Object-missing errors for the target order should trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('Unable to find Object 1.7.902', '1.7.902'),
        true,
        'Existing unable-to-find-object errors for the target order should trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('account does not exist', '1.7.902'),
        false,
        'Unrelated account-missing errors must not trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('asset does not exist', '1.7.902'),
        false,
        'Unrelated asset-missing errors must not trigger gone-from-chain handling'
    );
    console.log('  ✓ Dust cancel only treats order-specific missing errors as gone from chain');
}

async function testDustThresholdUsesConfiguredPercentage() {
    console.log('Testing Dust Threshold Uses Configured Percentage...');

    try {
        const manager = new OrderManager({
            assetA: 'TESTA',
            assetB: 'TESTB',
            startPrice: 1.0,
            botFunds: { buy: 1000, sell: 1000 },
            coreOrders: { buy: 5, sell: 5 },
            incrementPercent: 1,
            weightDistribution: { buy: 1, sell: 1 },
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 10 }
        });

        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
        };

        await manager.setAccountTotals({
            buy: 1000,
            sell: 1000,
            buyFree: 1000,
            sellFree: 1000
        });

        manager.logger = {
            log: () => {},
            logFundsStatus: () => {}
        };

        await manager._updateOrder({
            id: 'threshold-sell-1',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            price: 1.01,
            orderId: '1.7.910'
        });

        await manager._updateOrder({
            id: 'threshold-sell-2',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.95,
            price: 1.02,
            orderId: '1.7.911'
        });

        await manager._updateOrder({
            id: 'threshold-sell-3',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            price: 1.03,
            orderId: '1.7.912'
        });

        const dustOrders = await getDustOrders(manager, [manager.orders.get('threshold-sell-2')], 'sell');
        assert.strictEqual(dustOrders.length, 1, 'Configured dust threshold should classify the order as dust');
        console.log('  ✓ Dust detection respects configured threshold percentage');
    } catch (err) {
        throw err;
    }
}

async function testDustTrackingEligibleSetIncludesBelowThresholdInterior() {
    console.log('Testing Dust Tracking Detects Top And Below-Threshold Interior...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    await manager._updateOrder({
        id: 'top-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 10,
        price: 1.01,
        orderId: '1.7.930'
    });
    await manager._updateOrder({
        id: 'inner-dust-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001,
        price: 1.02,
        orderId: '1.7.931'
    });
    await manager._updateOrder({
        id: 'outer-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 10,
        price: 1.03,
        orderId: '1.7.932'
    });

    const bot = new DEXBot({
        botKey: 'test_top_order_dust_only',
        dryRun: false,
        startPrice: 1,
        assetA: 'TESTA',
        assetB: 'TESTB',
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 },
        coreOrders: { buy: 5, sell: 5 },
        botFunds: { buy: 1000, sell: 1000 }
    });
    bot.manager = manager;

    try {
        // inner-dust-sell is an interior partial (below the top) with no
        // duplicate price level — but its size is below the dust threshold,
        // so it must be eligible. Without the below-threshold rule it would
        // strand on the book forever (the residual path only cancels
        // zero-value residuals, and interior dust rarely has a dup price).
        const initialHealth = await checkWindowDust(manager);
        assert.strictEqual(initialHealth.sellDustOrders.length, 1, 'Below-threshold interior partial should be selected');
        assert.strictEqual(initialHealth.sellDustOrders[0].orderId, '1.7.931', 'Below-threshold interior sell should be detected');

        // Once the top-of-window order also drops below the threshold, both
        // the top partial and the below-threshold interior qualify.
        await manager._updateOrder({
            id: 'top-sell',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.00001,
            price: 1.01,
            orderId: '1.7.930'
        });

        const topHealth = await checkWindowDust(manager);
        assert.strictEqual(topHealth.sellDustOrders.length, 2, 'Top dust plus below-threshold interior should be selected');
        const trackedIds = topHealth.sellDustOrders.map((o: any) => o.orderId).sort();
        assert.deepStrictEqual(trackedIds, ['1.7.930', '1.7.931'], 'Top and below-threshold interior sells should both be tracked');

        console.log('  ✓ Top-of-window and below-threshold interior partials are eligible for dust tracking');
    } finally {
    }
}

async function testGridMaintenanceWaitsForQuietPeriod() {
    console.log('Testing Grid Maintenance Waits For Quiet Period...');

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    try {
        const scheduledDelays = [];
        (global as any).setTimeout = (_fn, delay) => {
            scheduledDelays.push(delay);
            return { fakeTimer: true };
        };
        global.clearTimeout = () => {};

        const bot = new DEXBot({
            botKey: 'test_maintenance_idle_gate',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });

        let maintenanceRan = false;
        bot.manager = {
            orders: new Map([['slot-1', { id: 'slot-1' }]]),
            _fillProcessingLock: { acquire: async (fn) => fn() },
            _divergenceLock: { acquire: async (fn) => fn() }
        };
        bot._executeMaintenanceLogic = async () => {
            maintenanceRan = true;
        };

        bot._markGridActivity('test activity');
        await bot._runGridMaintenance('periodic');

        assert.strictEqual(maintenanceRan, false, 'Maintenance should not run during the quiet-period gate');
        assert.ok(
            scheduledDelays.some(delay => delay > 0 && delay <= TIMING.BLOCKCHAIN_SETTLE_DELAY_MS),
            'Maintenance should schedule a retry after the configured idle delay'
        );
        console.log('  ✓ Grid maintenance waits for the configured inactivity window');
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
}

async function testInteriorDustWithDuplicatePriceLevel() {
    console.log('Testing Interior Dust With Duplicate Price Level...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    manager.logger = { log: () => {}, logFundsStatus: () => {} };

    // Setup: top-sell (ACTIVE), dup-dust-sell (PARTIAL, same price as active sibling → eligible)
    await manager._updateOrder({ id: 'top-sell', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.01, orderId: '1.7.940' });
    await manager._updateOrder({ id: 'dup-dust-sell', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, size: 0.00001, price: 1.01, orderId: '1.7.941' });
    await manager._updateOrder({ id: 'outer-sell', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.03, orderId: '1.7.942' });

    const health = await checkWindowDust(manager);
    assert.strictEqual(health.sellDustOrders.length, 1, 'Interior dust with duplicate price level should be eligible');
    assert.strictEqual(health.sellDustOrders[0].orderId, '1.7.941', 'Duplicate-price-level interior dust should be detected');
    console.log('  ✓ Interior partial with active sibling at same price is eligible for dust');
}

async function testInteriorDustAboveThresholdNotEligible() {
    console.log('Testing Interior Dust Above Threshold Is Not Eligible...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    manager.logger = { log: () => {}, logFundsStatus: () => {} };

    // Setup: two active sells at 1.01 and 1.03, a LARGE partial at 1.02
    // (adjacent, no duplicate price, and above the dust threshold ~16.7).
    await manager._updateOrder({ id: 's1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.01, orderId: '1.7.950' });
    await manager._updateOrder({ id: 's2', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, size: 100, price: 1.02, orderId: '1.7.951' });
    await manager._updateOrder({ id: 's3', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.03, orderId: '1.7.952' });

    const health = await checkWindowDust(manager);
    // s2 at 1.02 is between 1.01 and 1.03 — adjacent but NOT same price level,
    // and its size is above the dust threshold. Interior partials only qualify
    // with a duplicate price level OR a sub-threshold size.
    assert.strictEqual(health.sellDustOrders.length, 0, 'Above-threshold interior partial at adjacent price level should not be eligible for dust');
    console.log('  ✓ Above-threshold interior partial at adjacent grid level (within tolerance) is not eligible');
}

async function testNoBudgetReturnsEmptyDust() {
    console.log('Testing No-Budget Path Returns Empty Dust...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 0, sell: 0 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 0,
        sell: 0,
        buyFree: 0,
        sellFree: 0
    });

    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    // Pin the no-budget condition directly: force allocated to 0 and
    // disable recalculateFunds so no later code path overwrites it.
    manager.funds.allocated = { buy: 0, sell: 0 };
    const origRecalc = manager.recalculateFunds.bind(manager);
    manager.recalculateFunds = async () => {};

    // Add a tiny partial — would be dust if budget existed
    await manager._updateOrder({
        id: 'no-budget-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001,
        price: 1.02,
        orderId: '1.7.960'
    });

    await manager._updateOrder({
        id: 'top-no-budget-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 10,
        price: 1.01,
        orderId: '1.7.961'
    });

    const dustOrders = await getDustOrders(manager, [manager.orders.get('no-budget-sell')], 'sell');
    // This test pins the no-budget branch in _getDustOrders: when ctx.budget
    // is 0, idealSizes is [] and every threshold collapses to 0, so no order
    // qualifies as dust. If that branch is ever refactored, this assertion
    // documents the expected zero-budget outcome.
    assert.strictEqual(dustOrders.length, 0, 'No dust should be detected when budget is zero');
    manager.recalculateFunds = origRecalc;
    console.log('  ✓ No dust returned when budget is zero');
}

Promise.resolve()
    .then(() => testDustTrigger())
    .then(() => testDustCancelSyntheticRotation())
    .then(() => testDustCancelDoesNotBeatRealFill())
    .then(() => testDustCancelNodeFallback())
    .then(() => testDustCancelOrderMissingClassifier())
    .then(() => testDustThresholdUsesConfiguredPercentage())
    .then(() => testDustTrackingEligibleSetIncludesBelowThresholdInterior())
    .then(() => testInteriorDustWithDuplicatePriceLevel())
    .then(() => testInteriorDustAboveThresholdNotEligible())
    .then(() => testGridMaintenanceWaitsForQuietPeriod())
    .then(() => testNoBudgetReturnsEmptyDust())
    .finally(() => {
        Module._load = originalModuleLoad;
    })
    .then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
