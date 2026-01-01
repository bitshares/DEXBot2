const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { buildCreateOrderArgs, floatToBlockchainInt, blockchainToFloat } = require('../modules/order/utils');

console.log('='.repeat(70));
console.log('Testing Precision Quantization Fix');
console.log('='.repeat(70));

/**
 * Test 1: Order sizing and quantization
 * Simulate the exact scenario from the logs
 */
function testOrderQuantization() {
    console.log('\n[Test 1] Order Quantization Before Placement');
    console.log('-'.repeat(70));

    const assetA = { id: '1.3.0', precision: 4 };    // BTS
    const assetB = { id: '1.3.121', precision: 5 };  // USD

    // This is the order that caused the issue
    const order = {
        id: 'buy-2',
        type: ORDER_TYPES.BUY,
        price: 1625.8845908116273,
        size: 8.62251000  // Float from calculateOrderSizes with rounding error
    };

    console.log(`  Original order size: ${order.size}`);
    console.log(`  Asset precisions: assetA=${assetA.precision}, assetB=${assetB.precision}`);

    // Test buildCreateOrderArgs quantization
    const args = buildCreateOrderArgs(order, assetA, assetB);

    console.log(`\n  After buildCreateOrderArgs quantization:`);
    console.log(`  Amount to sell: ${args.amountToSell}`);

    // Verify it's quantized properly
    const precision = assetB.precision;
    const quantizedManually = blockchainToFloat(floatToBlockchainInt(order.size, precision), precision);

    console.log(`\n  Verification:`);
    console.log(`  Manual quantization: ${quantizedManually}`);

    assert(args.amountToSell === quantizedManually,
        `Amount to sell (${args.amountToSell}) should match quantized value (${quantizedManually})`);

    // Convert back to blockchain int to verify exact match
    const originalInt = floatToBlockchainInt(order.size, precision);
    const quantizedInt = floatToBlockchainInt(args.amountToSell, precision);

    console.log(`\n  Blockchain integer representation:`);
    console.log(`  Original float 8.62251 → int: ${originalInt}`);
    console.log(`  Quantized float → int: ${quantizedInt}`);
    console.log(`  Match: ${originalInt === quantizedInt ? '✓' : '✗'}`);

    assert(originalInt === quantizedInt, 'Blockchain integers should match exactly');

    console.log(`\n  ✅ Order correctly quantized to blockchain precision`);
}

/**
 * Test 2: Fill with quantized order
 * Simulate filling an order that was quantized before placement
 */
function testFillWithQuantizedOrder() {
    console.log('\n[Test 2] Fill Detection with Quantized Order');
    console.log('-'.repeat(70));

    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 10000, sell: 10000 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return;
            console.log(`    [${level.toUpperCase()}] ${msg}`);
        }
    };

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 4 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    // Step 1: Create order with float size
    const originalSize = 8.62251000;
    const assetBPrecision = 5;

    // Step 2: Quantize it (as buildCreateOrderArgs would)
    const quantizedSize = blockchainToFloat(
        floatToBlockchainInt(originalSize, assetBPrecision),
        assetBPrecision
    );

    console.log(`  Original calculated size: ${originalSize}`);
    console.log(`  Quantized for blockchain:  ${quantizedSize}`);
    console.log(`  Blockchain precision: ${assetBPrecision}`);

    // Create grid order with QUANTIZED size (as it would be after placement)
    const gridOrder = {
        id: 'buy-2',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        orderId: '1.7.569640154',
        price: 1625.8845908116273,
        size: quantizedSize  // Use quantized size, not original
    };

    mgr.orders.set('buy-2', gridOrder);
    mgr._ordersByType[ORDER_TYPES.BUY] = new Set(['buy-2']);
    mgr._ordersByState[ORDER_STATES.ACTIVE] = new Set(['buy-2']);

    console.log(`\n  Grid order size in memory: ${gridOrder.size}`);

    // Step 3: Simulate fill from blockchain
    // Fill 8.6225 (slightly less than quantized size)
    const filledAmount = 8.6225;

    console.log(`\n  Simulating fill:`);
    console.log(`  Filled amount: ${filledAmount}`);

    const result = mgr.syncFromFillHistory({
        order_id: '1.7.569640154',
        pays: {
            amount: Math.round(filledAmount * Math.pow(10, assetBPrecision)),
            asset_id: mgr.assets.assetB.id
        },
        receives: {
            amount: Math.round(filledAmount * gridOrder.price * Math.pow(10, 4)),
            asset_id: mgr.assets.assetA.id
        }
    });

    console.log(`\n  Results:`);
    console.log(`  Filled orders: ${result.filledOrders.length}`);
    console.log(`  Updated orders: ${result.updatedOrders.length}`);

    // Calculate expected remaining
    const expectedRemaining = quantizedSize - filledAmount;
    const expectedRemainingInt = floatToBlockchainInt(expectedRemaining, assetBPrecision);

    console.log(`\n  Expected remaining: ${expectedRemaining}`);
    console.log(`  Expected remaining (int): ${expectedRemainingInt}`);

    if (expectedRemainingInt > 0) {
        console.log(`\n  ✅ Valid remaining amount - order should be PARTIAL`);
        assert(result.updatedOrders.length === 1, 'Should have 1 updated order');
        const partial = result.updatedOrders[0];
        console.log(`  Partial state: ${partial.state}`);
        console.log(`  Remaining size: ${partial.size}`);
    } else {
        console.log(`\n  ✅ Zero remaining amount - order should be FULLY_FILLED`);
        assert(result.filledOrders.length === 1, 'Should have 1 filled order');
    }
}

/**
 * Test 3: No spurious remainders with quantization
 * Test various order sizes to ensure quantization prevents off-by-one errors
 */
function testMultipleSizesQuantization() {
    console.log('\n[Test 3] Quantization with Various Order Sizes');
    console.log('-'.repeat(70));

    const testCases = [
        { size: 8.62251000, label: 'Original issue case' },
        { size: 10.123456, label: 'Random float' },
        { size: 5.00001, label: 'Potential edge case' },
        { size: 100.0, label: 'Round number' },
        { size: 0.123456789, label: 'Small amount' }
    ];

    const precision = 5;
    let passCount = 0;

    testCases.forEach(testCase => {
        const original = testCase.size;
        const quantized = blockchainToFloat(floatToBlockchainInt(original, precision), precision);
        const originalInt = floatToBlockchainInt(original, precision);
        const quantizedInt = floatToBlockchainInt(quantized, precision);

        const match = originalInt === quantizedInt;
        const status = match ? '✓' : '✗';

        console.log(`\n  ${status} ${testCase.label}:`);
        console.log(`     Original: ${original}`);
        console.log(`     Quantized: ${quantized}`);
        console.log(`     Original int: ${originalInt}`);
        console.log(`     Quantized int: ${quantizedInt}`);

        if (match) {
            passCount++;
        } else {
            assert(false, `Quantization mismatch for ${testCase.label}`);
        }
    });

    console.log(`\n  ✅ All ${passCount}/${testCases.length} sizes quantized correctly`);
}

/**
 * Test 4: Simulate the exact scenario from logs
 * Original: 8.62251, Filled: 8.6225, Expected remaining: 0.00001
 */
function testExactLogScenario() {
    console.log('\n[Test 4] Exact Scenario from Production Logs');
    console.log('-'.repeat(70));

    const assetBPrecision = 5;

    // The exact numbers from the logs
    const originalCalculated = 8.62251000;
    const filledAmount = 8.62250000;

    // Step 1: Quantize original (as buildCreateOrderArgs does now)
    const quantized = blockchainToFloat(
        floatToBlockchainInt(originalCalculated, assetBPrecision),
        assetBPrecision
    );

    console.log(`  Original calculated size: ${originalCalculated}`);
    console.log(`  Quantized size:           ${quantized}`);
    console.log(`  Filled amount:            ${filledAmount}`);

    // Step 2: Calculate remaining
    const remaining = quantized - filledAmount;
    const remainingInt = floatToBlockchainInt(remaining, assetBPrecision);

    console.log(`\n  Calculation:`);
    console.log(`  Remaining (float):  ${remaining}`);
    console.log(`  Remaining (int):    ${remainingInt}`);
    console.log(`  Remaining amount:   ${blockchainToFloat(remainingInt, assetBPrecision)}`);

    console.log(`\n  Analysis:`);
    if (remainingInt > 0) {
        const remainingFloat = blockchainToFloat(remainingInt, assetBPrecision);
        console.log(`  ✓ Remaining ${remainingFloat} is a valid blockchain amount`);
        console.log(`  ✓ Order should be marked PARTIAL (can still be traded)`);
        console.log(`  ✓ No spurious remainder error`);
    } else {
        console.log(`  ✓ Remaining is zero (or rounds to zero)`);
        console.log(`  ✓ Order should be marked FULLY_FILLED`);
    }

    assert(remainingInt > 0, 'Should have a valid remaining amount');
    assert(remaining > 0, 'Remaining should be positive');
}

// Run all tests
try {
    testOrderQuantization();
    testFillWithQuantizedOrder();
    testMultipleSizesQuantization();
    testExactLogScenario();

    console.log('\n' + '='.repeat(70));
    console.log('All Precision Quantization Tests Passed! ✅');
    console.log('='.repeat(70));
    console.log('\nSummary:');
    console.log('  ✅ Orders are quantized to blockchain precision before placement');
    console.log('  ✅ Fill detection works correctly with quantized sizes');
    console.log('  ✅ No spurious off-by-one remainder errors');
    console.log('  ✅ Exact log scenario produces valid remaining amounts');
    process.exit(0);
} catch (err) {
    console.error('\n❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
}
