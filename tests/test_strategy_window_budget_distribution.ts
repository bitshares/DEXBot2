const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function run() {
    console.log('Running strategy window budget distribution tests...');

    const manager = new OrderManager({
        assetA: 'XRP',
        assetB: 'USD',
        startPrice: 1,
        incrementPercent: 0.4,
        targetSpreadPercent: 2,
        coreOrders: { buy: 3, sell: 3 },
        weightDistribution: { buy: 0.5, sell: 0.5 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'XRP', precision: 4 },
        assetB: { id: '1.3.2', symbol: 'USD', precision: 5 }
    };

    const frozenMasterGrid = new Map();
    for (let i = 0; i < 40; i++) {
        frozenMasterGrid.set(`slot-${i}`, {
            id: `slot-${i}`,
            price: 0.8 + (i * 0.01),
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null
        });
    }

    const { targetGrid } = manager.strategy.calculateTargetGrid({
        frozenMasterGrid,
        config: manager.config,
        accountAssets: manager.assets,
        funds: {
            allocatedBuy: 6000,
            allocatedSell: 6
        },
        fills: [],
        currentBoundaryIdx: 19
    });

    // All buy slots should have sizes (grid integrity)
    const allBuySlots = Array.from(targetGrid.values()).filter(o => (o as any).type === ORDER_TYPES.BUY);
    const buyTargetsWithSize = allBuySlots.filter(o => Number((o as any).size || 0) > 0);
    
    // Window discipline controls which orders are ACTIVE, not which have sizes.
    // All buy slots should have sizes to maintain fund accounting integrity.
    assert.strictEqual(buyTargetsWithSize.length, allBuySlots.length, 'all buy slots should retain their calculated sizes');
    
    // Window discipline: only 3 closest buy slots should be marked for placement (ACTIVE state)
    const activeBuySlots = allBuySlots.filter(o => (o as any).state === ORDER_STATES.ACTIVE);
    assert.strictEqual(activeBuySlots.length, 3, 'window discipline should mark 3 buy slots as ACTIVE');

    const maxBuySize = Math.max(...buyTargetsWithSize.map(o => Number((o as any).size || 0)));

    // Regression guard: sizing must be based on full side topology, not only 3-window slots.
    // If concentrated into 3 slots, sizes jump near ~2000 for this budget.
    assert(maxBuySize < 1000, `buy size should not be absurdly concentrated (max=${maxBuySize})`);

    console.log('✓ strategy window budget distribution tests passed');
}

run().catch((err) => {
    console.error('✗ strategy window budget distribution tests failed');
    console.error(err);
    process.exit(1);
});
