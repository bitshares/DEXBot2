/**
 * tests/test_bts_fee_accounting.ts
 * 
 * Verifies that BTS fees are not double-counted during fill processing and rebalancing.
 * UPDATED: Uses modern COW pipeline (performSafeRebalance).
 */

// Seed the fee cache so getAssetFees resolves deterministically (frozen ESM
// namespace — patching utils.getAssetFees is no longer possible).
const utils = require('../modules/order/utils/math');
utils._setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.01 },
        limitOrderUpdate: { bts: 0.0001 },
        limitOrderCancel: { bts: 0.0001 }
    },
    USD: {
        assetId: '1.3.121',
        chargesMarketFees: false,
        marketFee: { percent: 0 },
        takerFee: null,
        maxMarketFee: { raw: 0, float: 0 }
    }
});

const bsModule = require('../modules/bitshares_client');
if (bsModule.setSuppressConnectionLog) {
    bsModule.setSuppressConnectionLog(true);
}

 const assert = require('assert');
 const { OrderManager } = require('../modules/order/manager');
 const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
 const Format = require('../modules/order/format');

async function testFeeAccounting() {
    console.log('Testing BTS Fee Accounting (COW)...');

    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1
    });

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    let deductedAmount = 0;
    let directDeductedAmount = 0;

    // Mock synchronizeWithChain to record fees and avoid on-chain calls
    manager.synchronizeWithChain = async (data, src) => {
        if (src === 'createOrder' && data.fee) {
            directDeductedAmount += data.fee;
        }
        return { newOrders: [], ordersNeedingCorrection: [] };
    };

    manager.accountant.deductBtsFees = async () => {
        deductedAmount += manager.funds.btsFeesOwed;
        manager.funds.btsFeesOwed = 0;
    };

    const originalAdjust = manager.accountant.adjustTotalBalance.bind(manager.accountant);
    manager.accountant.adjustTotalBalance = (type, delta, op) => {
        if (delta < 0) directDeductedAmount += Math.abs(delta);
        return originalAdjust(type, delta, op);
    };

    console.log('\n  Simulating 1 fill...');
    const fill = { id: 'slot-6', type: ORDER_TYPES.SELL, price: 1.1, size: 10, isPartial: false };
    
    // Initialize fee cache for strategy.processFillsOnly (fee values match the
    // seeded cache: create 0.01 BTS = 1000 sats, update 0.0001 BTS = 10 sats)
    const { initializeFeeCache } = require('../modules/order/utils/system');
    const mockBitSharesForFees = {
        db: {
            getGlobalProperties: async () => ({
                parameters: { current_fees: { parameters: [[1, { fee: 1000 }], [2, { fee: 10 }], [77, { fee: 10 }]] } }
            }),
            lookup_asset_symbols: async (symbols) => symbols.map((s) => (
                s === 'USD'
                    ? { id: '1.3.121', symbol: 'USD', precision: 5, options: {} }
                    : null
            ))
        }
    };
    await initializeFeeCache(['BTS', 'USD'], mockBitSharesForFees);

    for (let i = 0; i < 10; i++) {
        await manager._updateOrder({
            id: `slot-${i}`,
            type: i < 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            state: i === 6 ? ORDER_STATES.VIRTUAL : ORDER_STATES.ACTIVE, 
            price: 0.9 + i * 0.02,
            size: 10,
            orderId: i === 6 ? null : `chain-${i}`
        });
    }

    await manager.strategy.processFillsOnly([fill]);
    const result = await manager.performSafeRebalance([fill]);

    // Simulate execution of planned updates/rotations (this is where updateFees are deducted)
    const updates = result.actions.filter(a => a.type === 'update');
    for (const action of updates) {
        const btsFeeData = utils.getAssetFees('BTS');
        await manager.synchronizeWithChain({
            gridOrderId: action.id,
            chainOrderId: action.orderId,
            isPartialPlacement: false,
            fee: btsFeeData.updateFee
        }, 'createOrder');
    }

    const totalFees = deductedAmount + directDeductedAmount + manager.funds.btsFeesOwed;
    console.log(`  Total BTS fees (deducted + remaining): ${Format.safeFormat(totalFees, 5)}`);

    const updateFee = utils.getAssetFees('BTS').updateFee;
    const expected = updates.length * updateFee;

    assert.ok(
        Math.abs(totalFees - expected) <= 1e-10,
        `Unexpected fee total: got ${totalFees.toFixed(8)}, expected ${expected.toFixed(8)} ` +
        `(updateFee=${updateFee}, updates=${updates.length})`
    );
    console.log(
        `  ✓ Fee accounting is correct: ${(updates.length * updateFee).toFixed(4)} ` +
        `(update operations only)`
    );
}

async function testFeeSettlementCorrectness() {
    console.log('\nTesting Fee Settlement Correctness...');

    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1
    });

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    manager.funds.btsFeesOwed = 0;

    const feesOwed = 50;
    const baseCapitalBefore = manager.accountTotals.sellFree;

    manager.funds.btsFeesOwed = feesOwed;

    console.log(`  Setup: ${feesOwed} BTS owed, ${baseCapitalBefore} base capital`);

    await manager.accountant.deductBtsFees('sell');

    const baseCapitalAfter = manager.accountTotals.sellFree;
    const baseCapitalReduction = baseCapitalBefore - baseCapitalAfter;

    console.log(`  Result: Base capital reduced by ${baseCapitalReduction}`);

    const expectedBaseCapitalReduction = feesOwed;

    assert.strictEqual(baseCapitalReduction, expectedBaseCapitalReduction);
    assert.strictEqual(manager.funds.btsFeesOwed, 0);

    console.log(`  ✓ Fee settlement is CORRECT`);
}

async function testInsufficientFundsDeferral() {
    console.log('\nTesting Insufficient Funds Deferral...');

    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        coreOrders: { buy: 5, sell: 5 },
        incrementPercent: 1
    });

    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 5 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 1000,
        sell: 40,  
        buyFree: 1000,
        sellFree: 40
    });

    manager.funds.btsFeesOwed = 50;

    const sellFreeBefore = manager.accountTotals.sellFree;

    console.log('  Setup: 50 BTS owed, 40 chainFree (insufficient)');

    await manager.accountant.deductBtsFees('sell');

    assert.strictEqual(manager.funds.btsFeesOwed, 50);
    assert.strictEqual(manager.accountTotals.sellFree, sellFreeBefore);

    console.log(`  ✓ Settlement correctly deferred`);
}

async function runAllTests() {
    try {
        await testFeeAccounting();
        await testFeeSettlementCorrectness();
        await testInsufficientFundsDeferral();
        console.log('\n✓ All tests passed!');
        process.exit(0);
    } catch (err) {
        console.error('\n✗ Tests failed!');
        console.error(err);
        process.exit(1);
    }
}

runAllTests();
