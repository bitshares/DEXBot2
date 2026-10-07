'use strict';

// Canonical credit-pricing math (modules/credit_pricing.ts): the single
// source of truth shared by the live credit runtime and dexbot credit.

const assert = require('assert');

const {
  normalizeCollateralMap,
  creditPriceOrientation,
  extractOfferConversionRate,
  collateralValueFromOfferPrice,
  requiredCollateralForBorrow,
  borrowAmountForCollateral,
  capBorrowToCollateral,
  creditDealCollateralRatio,
  averageCollateralRatio,
  dailyOfferFeeRate,
  creditDealFee,
} = require('../modules/credit_pricing');

function testNormalizeCollateralMap() {
  const price = { base: { amount: 1, asset_id: '1.3.10' }, quote: { amount: 2, asset_id: '1.3.0' } };
  assert.strictEqual(normalizeCollateralMap({ '1.3.0': price }).get('1.3.0'), price, 'plain object map');
  assert.strictEqual(normalizeCollateralMap([['1.3.0', price]]).get('1.3.0'), price, 'pair-array map');
  assert.strictEqual(normalizeCollateralMap([{ key: '1.3.0', value: price }]).get('1.3.0'), price, 'key/value-array map');
  assert.strictEqual(normalizeCollateralMap(new Map([['1.3.0', price]])).get('1.3.0'), price, 'Map input');
  assert.strictEqual(normalizeCollateralMap(null).size, 0, 'null input is empty');
}

function testPriceOrientation() {
  assert.strictEqual(creditPriceOrientation('1.3.10', '1.3.0', '1.3.10', '1.3.0'), 'core');
  assert.strictEqual(creditPriceOrientation('1.3.0', '1.3.10', '1.3.10', '1.3.0'), 'legacy-reversed');
  assert.strictEqual(creditPriceOrientation('1.3.5', '1.3.6', '1.3.10', '1.3.0'), 'core', 'unknown defaults to core');
}

function testExtractOfferConversionRate() {
  const precisionOf = () => 5;
  // Core: base 2.0 debt / quote 1.0 collateral -> 2 debt per collateral.
  const core = { '1.3.0': { base: { amount: 200000, asset_id: '1.3.10' }, quote: { amount: 100000, asset_id: '1.3.0' } } };
  assert.strictEqual(extractOfferConversionRate(core, '1.3.0', '1.3.10', precisionOf), 2, 'core orientation rate');
  // Legacy-reversed: base 1.0 collateral / quote 2.0 debt -> same rate.
  const reversed = { '1.3.0': { base: { amount: 100000, asset_id: '1.3.0' }, quote: { amount: 200000, asset_id: '1.3.10' } } };
  assert.strictEqual(extractOfferConversionRate(reversed, '1.3.0', '1.3.10', precisionOf), 2, 'legacy-reversed orientation rate');
  assert.strictEqual(extractOfferConversionRate({ '1.3.99': core['1.3.0'] }, '1.3.0', '1.3.10', precisionOf), null, 'missing collateral entry is null');
  assert.strictEqual(extractOfferConversionRate(core, '1.3.0', '1.3.10', () => null), null, 'missing precision is null');
  assert.strictEqual(extractOfferConversionRate(core, '1.3.0', '1.3.10', (id) => (id === '1.3.10' ? 5 : null)), null, 'partial precision is null');
}

function testCollateralValueFromOfferPrice() {
  const precisionOf = () => 5;
  // 3.0 collateral at 2 debt/collateral -> 6.0 debt value.
  const core = { base: { amount: 200000, asset_id: '1.3.10' }, quote: { amount: 100000, asset_id: '1.3.0' } };
  assert.strictEqual(
    collateralValueFromOfferPrice(300000, 5, core, '1.3.10', '1.3.0', precisionOf),
    6,
    'collateral value in debt asset',
  );
  const reversed = { base: { amount: 100000, asset_id: '1.3.0' }, quote: { amount: 200000, asset_id: '1.3.10' } };
  assert.strictEqual(
    collateralValueFromOfferPrice(300000, 5, reversed, '1.3.10', '1.3.0', precisionOf),
    6,
    'reversed orientation gives identical value',
  );
  assert.strictEqual(collateralValueFromOfferPrice(0, 5, core, '1.3.10', '1.3.0', precisionOf), null, 'zero collateral is null');
  assert.strictEqual(collateralValueFromOfferPrice(300000, 5, null, '1.3.10', '1.3.0', precisionOf), null, 'missing price is null');
}

function testRequiredAndBorrowRoundTrip() {
  // Core price: 2 debt-base / 1 collateral-quote (raw 200000/100000).
  const core = { base: { amount: 200000, asset_id: '1.3.10' }, quote: { amount: 100000, asset_id: '1.3.0' } };
  // Borrowing 1.0 debt (100000 raw) needs 0.5 collateral -> ceil to 50000 raw.
  assert.strictEqual(requiredCollateralForBorrow(100000, core, '1.3.10', '1.3.0'), 50000, 'core required collateral ceils');
  // 0.5 collateral (50000 raw) yields 1.0 debt (100000 raw).
  assert.strictEqual(borrowAmountForCollateral(50000, core, '1.3.10', '1.3.0'), 100000, 'core borrow amount floors');
  const reversed = { base: { amount: 100000, asset_id: '1.3.0' }, quote: { amount: 200000, asset_id: '1.3.10' } };
  assert.strictEqual(requiredCollateralForBorrow(100000, reversed, '1.3.10', '1.3.0'), 50000, 'reversed matches core');
  assert.strictEqual(borrowAmountForCollateral(50000, reversed, '1.3.10', '1.3.0'), 100000, 'reversed matches core');
  assert.strictEqual(requiredCollateralForBorrow(0, core, '1.3.10', '1.3.0'), null, 'zero borrow is null');
  assert.strictEqual(borrowAmountForCollateral(0, core, '1.3.10', '1.3.0'), null, 'zero collateral is null');
  assert.strictEqual(requiredCollateralForBorrow(100000, null, '1.3.10', '1.3.0'), null, 'missing price is null');
}

function testCapBorrowToCollateral() {
  // Core price: 2 debt-base / 1 collateral-quote. 50000 collateral yields 100000.
  const core = { base: { amount: 200000, asset_id: '1.3.10' }, quote: { amount: 100000, asset_id: '1.3.0' } };
  assert.strictEqual(capBorrowToCollateral(200000, null, core, '1.3.10', '1.3.0'), 200000, 'no budget keeps requested');
  assert.strictEqual(capBorrowToCollateral(200000, 50000, core, '1.3.10', '1.3.0'), 100000, 'budget clamps down to what collateral supports');
  assert.strictEqual(capBorrowToCollateral(80000, 50000, core, '1.3.10', '1.3.0'), 80000, 'sufficient budget keeps requested');
  assert.strictEqual(capBorrowToCollateral(200000, 0, core, '1.3.10', '1.3.0'), null, 'zero budget cannot support a borrow');
  assert.strictEqual(capBorrowToCollateral(0, 50000, core, '1.3.10', '1.3.0'), null, 'non-positive request is null');
  assert.strictEqual(capBorrowToCollateral(200000, 50000, null, '1.3.10', '1.3.0'), null, 'missing price is null');
  const reversed = { base: { amount: 100000, asset_id: '1.3.0' }, quote: { amount: 200000, asset_id: '1.3.10' } };
  assert.strictEqual(capBorrowToCollateral(200000, 50000, reversed, '1.3.10', '1.3.0'), 100000, 'reversed orientation matches core');
}

function testCreditDealCollateralRatio() {
  assert.strictEqual(creditDealCollateralRatio(10, 4, 2), 0.8, 'collateral value / debt');
  assert.strictEqual(creditDealCollateralRatio(10, 4, null), null, 'no rate is null');
  assert.strictEqual(creditDealCollateralRatio(0, 4, 2), null, 'zero debt is null');
  assert.strictEqual(creditDealCollateralRatio(10, 4, 0), null, 'zero rate is null');
}

function testAverageCollateralRatio() {
  assert.strictEqual(averageCollateralRatio([{ debt: 10, value: 8 }, { debt: 30, value: 36 }]), 1.1, 'value-weighted average');
  assert.strictEqual(averageCollateralRatio([]), null, 'empty is null');
  assert.strictEqual(averageCollateralRatio([{ debt: 0, value: 5 }]), null, 'zero debt is null');
}

function testDailyOfferFeeRate() {
  assert.strictEqual(dailyOfferFeeRate({ fee_rate: 10000, max_duration_seconds: 86400 }, 1000000), 0.01, 'flat fee prorated per day');
  assert.strictEqual(dailyOfferFeeRate({ fee_rate: 0, max_duration_seconds: 86400 }, 1000000), 0, 'zero fee is zero');
  assert.strictEqual(dailyOfferFeeRate({ fee_rate: 10000, max_duration_seconds: 0 }, 1000000), 0, 'zero duration is zero');
}

function testCreditDealFee() {
  // ceil(100000 * 1000 / 1000000) = 100.
  assert.strictEqual(creditDealFee(100000, 1000, 1000000), 100, 'proportional fee');
  // ceil(1 * 1 / 1000000) rounds up to 1.
  assert.strictEqual(creditDealFee(1, 1, 1000000), 1, 'dust rounds up');
  assert.strictEqual(creditDealFee(0, 1000, 1000000), 0, 'zero repay is zero');
  assert.strictEqual(creditDealFee(100000, 0, 1000000), 0, 'zero rate is zero');
}

function main() {
  testNormalizeCollateralMap();
  testPriceOrientation();
  testExtractOfferConversionRate();
  testCollateralValueFromOfferPrice();
  testRequiredAndBorrowRoundTrip();
  testCapBorrowToCollateral();
  testCreditDealCollateralRatio();
  testAverageCollateralRatio();
  testDailyOfferFeeRate();
  testCreditDealFee();
  console.log('credit-pricing helper tests passed');
}

main();
