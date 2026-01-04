const assert = require('assert');

async function testConditionalRotation() {
    console.log('Running Conditional Rotation Edge Case Tests...\n');

    // Clear module cache for fresh imports
    delete require.cache[require.resolve('../modules/order/utils')];
    delete require.cache[require.resolve('../modules/order/manager')];

    const utils = require('../modules/order/utils');
    utils.getAssetFees = (asset, amount) => {
        if (asset === 'BTS') return { total: 0.5, updateFee: 0.1 };
        return amount;
    };

    const { OrderManager, constants } = require('../modules/order/index.js');
    const { ORDER_TYPES, ORDER_STATES } = constants;

    // ============================================================
    // TEST 1: Grid at lower edge (insufficient BUY orders)
    // ============================================================
    console.log('TEST 1: Grid at Lower Edge (Insufficient BUY Orders)');
    console.log('======================================================');

    const mgr1 = new OrderManager({
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 1800,
        minPrice: 1750,  // Set min price close to market
        maxPrice: 1850,
        botFunds: { buy: 10000, sell: 10000 },
        activeOrders: { buy: 20, sell: 20 }  // Target: 20 each
    });

    mgr1.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Simulate grid at lower edge: only 5 BUY orders can be placed
    // Create 5 active BUY orders
    for (let i = 0; i < 5; i++) {
        mgr1._updateOrder({
            id: `buy-edge-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 1750 + (i * 5),
            size: 100,
            orderId: `1.7.${1000 + i}`
        });
    }

    // Create many SELL orders (not at edge)
    for (let i = 0; i < 15; i++) {
        mgr1._updateOrder({
            id: `sell-normal-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1800 + (i * 5),
            size: 100,
            orderId: `1.7.${2000 + i}`
        });
    }

    // Create VIRTUAL BUY orders (available to activate)
    for (let i = 5; i < 20; i++) {
        mgr1._updateOrder({
            id: `buy-virtual-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 1750 + (i * 5),
            size: 100
        });
    }

    const activeBuysBefore = mgr1.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length;
    console.log(`  Active BUY orders before: ${activeBuysBefore} (target: 20)`);
    assert.strictEqual(activeBuysBefore, 5, 'Should have 5 active BUY orders at edge');

    // Trigger SELL fill - should create new BUY orders instead of rotating
    console.log(`  Triggering 1 SELL fill...`);
    const filledSells = [
        { id: 'sell-normal-0', type: ORDER_TYPES.SELL, size: 100, price: 1800 }
    ];

    const result1 = await mgr1.processFilledOrders(filledSells);
    const newBuysCreated = result1.ordersToPlace.filter(o => o.type === ORDER_TYPES.BUY).length;
    const buysRotated = result1.ordersToRotate.filter(o => o.type === ORDER_TYPES.BUY).length;

    console.log(`  Orders to place (new BUYs): ${newBuysCreated}`);
    console.log(`  Orders to rotate: ${buysRotated}`);

    // Verification 1: Should create new BUY orders, not rotate
    assert(newBuysCreated > 0, 'Should create new BUY orders when below target');
    assert.strictEqual(buysRotated, 0, 'Should NOT rotate BUY orders when below target');
    console.log(`  ✓ Created ${newBuysCreated} new BUY order(s) instead of rotating`);

    // ============================================================
    // TEST 2: Grid at upper edge (insufficient SELL orders)
    // ============================================================
    console.log('\nTEST 2: Grid at Upper Edge (Insufficient SELL Orders)');
    console.log('======================================================');

    const mgr2 = new OrderManager({
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 1800,
        minPrice: 1750,
        maxPrice: 1850,  // Set max price close to market
        botFunds: { buy: 10000, sell: 10000 },
        activeOrders: { buy: 20, sell: 20 }  // Target: 20 each
    });

    mgr2.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Simulate grid at upper edge: only 5 SELL orders can be placed
    for (let i = 0; i < 5; i++) {
        mgr2._updateOrder({
            id: `sell-edge-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1850 - (i * 5),
            size: 100,
            orderId: `1.7.${3000 + i}`
        });
    }

    // Create many BUY orders (not at edge)
    for (let i = 0; i < 15; i++) {
        mgr2._updateOrder({
            id: `buy-normal-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 1800 - (i * 5),
            size: 100,
            orderId: `1.7.${4000 + i}`
        });
    }

    // Create VIRTUAL SELL orders (available to activate)
    for (let i = 5; i < 20; i++) {
        mgr2._updateOrder({
            id: `sell-virtual-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 1850 - (i * 5),
            size: 100
        });
    }

    const activeSellsBefore = mgr2.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).length;
    console.log(`  Active SELL orders before: ${activeSellsBefore} (target: 20)`);
    assert.strictEqual(activeSellsBefore, 5, 'Should have 5 active SELL orders at edge');

    // Trigger BUY fill - should create new SELL orders instead of rotating
    console.log(`  Triggering 1 BUY fill...`);
    const filledBuys = [
        { id: 'buy-normal-0', type: ORDER_TYPES.BUY, size: 100, price: 1795 }
    ];

    const result2 = await mgr2.processFilledOrders(filledBuys);
    const newSellsCreated = result2.ordersToPlace.filter(o => o.type === ORDER_TYPES.SELL).length;
    const sellsRotated = result2.ordersToRotate.filter(o => o.type === ORDER_TYPES.SELL).length;

    console.log(`  Orders to place (new SELLs): ${newSellsCreated}`);
    console.log(`  Orders to rotate: ${sellsRotated}`);

    // Verification 2: Should create new SELL orders, not rotate
    assert(newSellsCreated > 0, 'Should create new SELL orders when below target');
    assert.strictEqual(sellsRotated, 0, 'Should NOT rotate SELL orders when below target');
    console.log(`  ✓ Created ${newSellsCreated} new SELL order(s) instead of rotating`);

    // ============================================================
    // TEST 3: Normal operation (at target coverage)
    // ============================================================
    console.log('\nTEST 3: Normal Operation (At Target Coverage)');
    console.log('==============================================');

    const mgr3 = new OrderManager({
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 1800,
        minPrice: 1700,
        maxPrice: 1900,
        botFunds: { buy: 10000, sell: 10000 },
        activeOrders: { buy: 5, sell: 5 }  // Target: 5 each (easier to reach in test)
    });

    mgr3.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Create full grid coverage: 5 BUY + 5 SELL active
    for (let i = 0; i < 5; i++) {
        mgr3._updateOrder({
            id: `buy-full-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 1800 - (i * 10),
            size: 100,
            orderId: `1.7.${5000 + i}`
        });
    }

    for (let i = 0; i < 5; i++) {
        mgr3._updateOrder({
            id: `sell-full-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1800 + (i * 10),
            size: 100,
            orderId: `1.7.${6000 + i}`
        });
    }

    // Add some virtual orders for rotation
    for (let i = 5; i < 10; i++) {
        mgr3._updateOrder({
            id: `buy-virtual-full-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 1800 - (i * 10),
            size: 100
        });
        mgr3._updateOrder({
            id: `sell-virtual-full-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 1800 + (i * 10),
            size: 100
        });
    }

    // Initialize funds structure for Test 3
    mgr3.funds = {
        chainFree: { buy: 10000, sell: 10000 },
        virtual: 0,
        committed: { grid: 0, chain: 0 },
        cacheFunds: { buy: 0, sell: 0 },
        btsFeesOwed: 0,
        available: { buy: 10000, sell: 10000 },
        total: { chain: 10000, grid: 0 }
    };

    const activeBuysFull = mgr3.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length;
    const activeSellsFull = mgr3.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE).length;
    console.log(`  Active BUY orders: ${activeBuysFull} (target: 5)`);
    console.log(`  Active SELL orders: ${activeSellsFull} (target: 5)`);
    assert.strictEqual(activeBuysFull, 5, 'Should have 5 active BUY orders');
    assert.strictEqual(activeSellsFull, 5, 'Should have 5 active SELL orders');

    // Trigger SELL fill - should rotate BUY orders (normal behavior)
    console.log(`  Triggering 1 SELL fill...`);
    const filledSellsFull = [
        { id: 'sell-full-0', type: ORDER_TYPES.SELL, size: 100, price: 1800 }
    ];

    const result3 = await mgr3.processFilledOrders(filledSellsFull);
    const newBuysFull = result3.ordersToPlace.filter(o => o.type === ORDER_TYPES.BUY).length;
    const buysFull = result3.ordersToRotate.filter(o => o.type === ORDER_TYPES.BUY).length;

    console.log(`  Orders to place (new BUYs): ${newBuysFull}`);
    console.log(`  Orders to rotate (BUYs): ${buysFull}`);

    // Verification 3: Should rotate BUY orders (normal behavior, not create)
    // Note: may not rotate if no funds available, but should NOT create new ones
    assert.strictEqual(newBuysFull, 0, 'Should NOT create new BUY orders when at target');
    console.log(`  ✓ Did not create new orders (normal rotation behavior)`);

    // ============================================================
    // TEST 4: Gradual recovery from edge
    // ============================================================
    console.log('\nTEST 4: Gradual Recovery from Edge');
    console.log('===================================');

    const mgr4 = new OrderManager({
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 1800,
        minPrice: 1750,
        maxPrice: 1850,
        botFunds: { buy: 50000, sell: 50000 },
        activeOrders: { buy: 10, sell: 10 }
    });

    mgr4.assets = {
        assetA: { id: '1.3.5537', symbol: 'IOB.XRP', precision: 5 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };

    // Start with only 3 BUY orders (7 short of target 10)
    for (let i = 0; i < 3; i++) {
        mgr4._updateOrder({
            id: `buy-recovery-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: 1750 + (i * 10),
            size: 100,
            orderId: `1.7.${7000 + i}`
        });
    }

    // Create 10 SELL orders
    for (let i = 0; i < 10; i++) {
        mgr4._updateOrder({
            id: `sell-recovery-${i}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1800 + (i * 5),
            size: 100,
            orderId: `1.7.${8000 + i}`
        });
    }

    // Create many VIRTUAL BUYs for recovery
    for (let i = 3; i < 20; i++) {
        mgr4._updateOrder({
            id: `buy-recovery-virt-${i}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 1750 + (i * 5),
            size: 100
        });
    }

    // Initialize funds structure for Test 4
    mgr4.funds = {
        chainFree: { buy: 50000, sell: 50000 },
        virtual: 0,
        committed: { grid: 0, chain: 0 },
        cacheFunds: { buy: 0, sell: 0 },
        btsFeesOwed: 0,
        available: { buy: 50000, sell: 50000 },
        total: { chain: 50000, grid: 0 }
    };

    const buysBefore4 = mgr4.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE).length;
    console.log(`  Active BUY orders before: ${buysBefore4} (target: 10, shortage: ${10 - buysBefore4})`);

    // Trigger 2 SELL fills - should create new BUYs gradually
    console.log(`  Triggering 2 SELL fills...`);
    const filledSells4 = [
        { id: 'sell-recovery-0', type: ORDER_TYPES.SELL, size: 100, price: 1800 },
        { id: 'sell-recovery-1', type: ORDER_TYPES.SELL, size: 100, price: 1805 }
    ];

    const result4a = await mgr4.processFilledOrders([filledSells4[0]]);
    const newBuys4a = result4a.ordersToPlace.filter(o => o.type === ORDER_TYPES.BUY).length;
    console.log(`  After fill 1: Created ${newBuys4a} new BUY order(s)`);

    // Process second fill
    const result4b = await mgr4.processFilledOrders([filledSells4[1]]);
    const newBuys4b = result4b.ordersToPlace.filter(o => o.type === ORDER_TYPES.BUY).length;
    console.log(`  After fill 2: Created ${newBuys4b} new BUY order(s)`);

    // Verification 4: Gradual recovery
    assert(newBuys4a > 0, 'Should create BUY orders on first fill');
    assert(newBuys4b > 0, 'Should create BUY orders on second fill');
    console.log(`  ✓ Gradual recovery: creating orders over multiple fills`);

    // ============================================================
    // Summary
    // ============================================================
    console.log('\n' + '='.repeat(60));
    console.log('ALL CONDITIONAL ROTATION TESTS PASSED ✓');
    console.log('='.repeat(60));
    console.log('\nSummary:');
    console.log('  ✓ Test 1: Grid at lower edge creates BUY orders (not rotate)');
    console.log('  ✓ Test 2: Grid at upper edge creates SELL orders (not rotate)');
    console.log('  ✓ Test 3: Normal operation preserves rotation behavior');
    console.log('  ✓ Test 4: Gradual recovery rebuilds coverage over fills');
}

testConditionalRotation().catch(err => {
    console.error('\n❌ TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
});
