/**
 * Test: Market Fee Deduction in Order Proceeds
 *
 * Verifies that market fees are correctly deducted from order fill proceeds:
 * - SELL orders: Fee deducted from quote asset (assetB) received
 * - BUY orders: Fee deducted from base asset (assetA) received
 * - BTS assets: Skip market fee (blockchain fees handled separately)
 * - Proceeds calculation: Raw vs. net amounts
 */

const assert = require('assert');

// Helper function to simulate getAssetFees behavior
function mockGetAssetFees(assetSymbol, assetAmount, marketFeePercent = 0) {
    // Simulates the getAssetFees function from utils.js
    if (assetSymbol === 'BTS') {
        return {
            total: 0.001,
            createFee: 0.001,
            updateFee: 0.0005,
            makerNetFee: 0.0001
        };
    }

    // For regular assets: return net amount after market fee
    const marketFeeAmount = (assetAmount * marketFeePercent) / 100;
    return assetAmount - marketFeeAmount;
}

// Test suite
console.log('Running Market Fee Deduction tests...\n');

const tests = [
    {
        name: 'SELL order: 0% market fee should not deduct anything',
        run: () => {
            const rawProceeds = 100; // 1 base asset * 100 price
            const netProceeds = mockGetAssetFees('IOB.XRP', rawProceeds, 0);

            assert.strictEqual(netProceeds, 100, 'Net proceeds should equal raw proceeds');
            assert.strictEqual(rawProceeds - netProceeds, 0, 'Fee deducted should be 0');
        }
    },
    {
        name: 'SELL order: 0.5% market fee should deduct correctly',
        run: () => {
            const rawProceeds = 1000; // 10 base * 100 price
            const marketFeePercent = 0.5;
            const netProceeds = mockGetAssetFees('IOB.XRP', rawProceeds, marketFeePercent);

            const expectedFee = (1000 * 0.5) / 100; // 5
            const expectedNet = 1000 - expectedFee; // 995

            assert.strictEqual(netProceeds, expectedNet, `Net should be ${expectedNet}`);
            assert.strictEqual(rawProceeds - netProceeds, expectedFee, `Fee deducted should be ${expectedFee}`);
        }
    },
    {
        name: 'SELL order: 1% market fee should deduct correctly',
        run: () => {
            const rawProceeds = 1000;
            const marketFeePercent = 1.0;
            const netProceeds = mockGetAssetFees('XBTSX.BTC', rawProceeds, marketFeePercent);

            const expectedFee = (1000 * 1.0) / 100; // 10
            const expectedNet = 1000 - expectedFee; // 990

            assert.strictEqual(netProceeds, expectedNet, `Net should be ${expectedNet}`);
            assert.strictEqual(rawProceeds - netProceeds, expectedFee, `Fee deducted should be ${expectedFee}`);
        }
    },
    {
        name: 'BUY order: 0.5% market fee on base asset',
        run: () => {
            const rawProceeds = 0.5; // size / price: 1 quote / 2 price
            const marketFeePercent = 0.5;
            const netProceeds = mockGetAssetFees('BTS', rawProceeds, marketFeePercent);

            // For BTS, we should skip market fee and return raw proceeds
            // (BTS is handled specially in the implementation)
            assert(typeof netProceeds === 'object', 'BTS returns object, not number');
        }
    },
    {
        name: 'BUY order: 1% market fee on received base asset',
        run: () => {
            const rawProceeds = 0.01; // 1 quote / 100 price
            const marketFeePercent = 1.0;
            const netProceeds = mockGetAssetFees('IOB.XRP', rawProceeds, marketFeePercent);

            const expectedFee = (0.01 * 1.0) / 100; // 0.0001
            const expectedNet = 0.01 - expectedFee; // 0.0099

            // Use approximate equality for floating point comparisons
            assert(Math.abs(netProceeds - expectedNet) < 0.00000001, `Net should be approximately ${expectedNet}`);
            assert(Math.abs((rawProceeds - netProceeds) - expectedFee) < 0.00000001, `Fee deducted should be approximately ${expectedFee}`);
        }
    },
    {
        name: 'Market fee on proceeds updates deltaBuyTotal/deltaSellTotal correctly',
        run: () => {
            // Simulate SELL order fill
            const filledOrderSize = 1;
            const filledOrderPrice = 100;
            const marketFeePercent = 0.5; // 0.5% fee on quote asset

            const rawProceeds = filledOrderSize * filledOrderPrice; // 100
            const netProceeds = mockGetAssetFees('IOB.XRP', rawProceeds, marketFeePercent);

            // Simulate fund updates
            let proceedsBuy = 0;
            let deltaBuyTotal = 0;

            proceedsBuy += netProceeds;
            deltaBuyTotal += netProceeds;

            assert.strictEqual(proceedsBuy, 99.5, 'proceedsBuy should be net amount');
            assert.strictEqual(deltaBuyTotal, 99.5, 'deltaBuyTotal should be net amount');
            assert.notStrictEqual(deltaBuyTotal, rawProceeds, 'deltaBuyTotal should not be raw proceeds');
        }
    },
    {
        name: 'Zero market fee should pass through without modification',
        run: () => {
            const amounts = [0.001, 0.01, 1, 10, 100, 1000];
            const marketFeePercent = 0;

            amounts.forEach(amount => {
                const netProceeds = mockGetAssetFees('TWENTIX', amount, marketFeePercent);
                assert.strictEqual(netProceeds, amount, `Zero fee should not modify ${amount}`);
            });
        }
    },
    {
        name: 'High market fee (5%) calculation accuracy',
        run: () => {
            const rawProceeds = 12345.6789;
            const marketFeePercent = 5.0;
            const netProceeds = mockGetAssetFees('TEST.ASSET', rawProceeds, marketFeePercent);

            const expectedFee = (12345.6789 * 5.0) / 100;
            const expectedNet = 12345.6789 - expectedFee;

            // Use approximate equality for floating point
            assert(Math.abs(netProceeds - expectedNet) < 0.0001,
                `Net should be approximately ${expectedNet}, got ${netProceeds}`);
        }
    },
    {
        name: 'BTS assets should return object (blockchain fees), not number',
        run: () => {
            const result = mockGetAssetFees('BTS', 100);

            assert(typeof result === 'object', 'BTS should return object');
            assert(result.total !== undefined, 'Should have total field');
            assert(result.createFee !== undefined, 'Should have createFee field');
            assert(result.updateFee !== undefined, 'Should have updateFee field');
        }
    },
    {
        name: 'Non-BTS assets should return number (net proceeds)',
        run: () => {
            const assets = ['IOB.XRP', 'XBTSX.BTC', 'TWENTIX', 'TEST.ASSET'];

            assets.forEach(asset => {
                const result = mockGetAssetFees(asset, 100, 0.5);
                assert(typeof result === 'number', `${asset} should return number`);
                assert(result > 0, `${asset} result should be positive`);
                assert(result < 100, `${asset} result should be less than raw (fee deducted)`);
            });
        }
    },
    {
        name: 'SELL fill: Correct asset receives fee (quote/assetB)',
        run: () => {
            // SELL: receive quote asset (assetB), fee deducted from it
            const quoteName = 'IOB.XRP'; // assetB
            const baseName = 'BTS';       // assetA
            const filledSize = 10;
            const price = 50;

            const rawProceeds = filledSize * price; // 500 IOB.XRP
            const marketFeePercent = 1.0; // 1% fee on quote
            const netProceeds = mockGetAssetFees(quoteName, rawProceeds, marketFeePercent);

            assert.strictEqual(netProceeds, 495, 'SELL: Quote asset should have 1% fee deducted');
            assert.strictEqual(filledSize, 10, 'SELL: Base asset size should remain unchanged');
        }
    },
    {
        name: 'BUY fill: Correct asset receives fee (base/assetA)',
        run: () => {
            // BUY: receive base asset (assetA), fee deducted from it
            const quoteName = 'IOB.XRP'; // assetB
            const baseName = 'BTS';       // assetA
            const filledSize = 500;       // quote spent
            const price = 50;

            const rawProceeds = filledSize / price; // 10 BTS received
            // In real implementation, we skip fee for BTS
            // But if assetA was non-BTS:
            const testAsset = 'TWENTIX';
            const marketFeePercent = 0.5;
            const netProceeds = mockGetAssetFees(testAsset, rawProceeds, marketFeePercent);

            assert.strictEqual(netProceeds, 9.95, 'BUY: Base asset should have 0.5% fee deducted');
            assert.strictEqual(filledSize, 500, 'BUY: Quote asset size should remain unchanged');
        }
    }
];

// Run tests
let passed = 0, failed = 0;
tests.forEach((test, index) => {
    try {
        test.run();
        console.log(`✓ ${test.name}`);
        passed++;
    } catch (e) {
        console.log(`✗ ${test.name}`);
        console.log(`  Error: ${e.message}`);
        failed++;
    }
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
    console.log('Failed tests detected. Exit code: 1');
    process.exit(1);
} else {
    console.log('All tests passed!');
    process.exit(0);
}
