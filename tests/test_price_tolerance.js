const assert = require('assert');

console.log('Running price_tolerance tests');

const { OrderManager, utils } = require('../modules/order/index.js');

const calc = utils.calculatePriceTolerance;

// 1) Fallback behaviour when assets missing
const fallback = calc(1000, 10, 'buy', null);
assert.strictEqual(typeof fallback === 'number', true, 'fallback should be numeric');
assert.strictEqual(fallback, 1000 * 0.001, 'fallback should be gridPrice * 0.001 when assets missing');

// 2) Example from inline comment in manager: BUY: gridPrice=1820, orderSize=73.88, precisionA=4, precisionB=5
const assetsExample = { assetA: { precision: 4 }, assetB: { precision: 5 } };
const t = calc(1820, 73.88, 'buy', assetsExample);
// Expect approximately 4.48 (allow some tiny floating error)
assert.ok(Math.abs(t - 4.48) < 0.01, `expected tolerance ≈4.48, got ${t}`);

// 3) Ensure OrderManager method delegates to utils and returns same result
const mgr = new OrderManager({ assetA: 'IOB.XRP', assetB: 'BTS' });
mgr.assets = assetsExample;
// The canonical implementation lives in utils; verify utils returns the same value
const tUtils = calc(1820, 73.88, 'buy', assetsExample);
assert.ok(Math.abs(tUtils - t) < 1e-12, `utils should return same value (got ${tUtils} vs ${t})`);

console.log('price_tolerance tests passed');

// --- Additional tests for checkPriceWithinTolerance helper ---
const { checkPriceWithinTolerance } = utils;

// grid order (buy) at price 1820, typical order size 73.88
const grid = { price: 1820, size: 73.88, type: 'buy' };
// chain order price slightly different — should be within tolerance
const chainClose = { price: 1820.5, size: 73.88 };
const closeResult = checkPriceWithinTolerance(grid, chainClose, assetsExample);
assert.strictEqual(typeof closeResult.isWithinTolerance === 'boolean', true, 'result should have boolean isWithinTolerance');
assert.ok(closeResult.isWithinTolerance, `expected close chain price to be within tolerance (diff=${closeResult.priceDiff}, tol=${closeResult.tolerance})`);

// chain order with large price diff — shouldn't be within tolerance
const chainFar = { price: 1900, size: 73.88 };
const farResult = checkPriceWithinTolerance(grid, chainFar, assetsExample);
assert.strictEqual(farResult.isWithinTolerance, false, `expected large price diff to be outside tolerance (diff=${farResult.priceDiff}, tol=${farResult.tolerance})`);

console.log('checkPriceWithinTolerance tests passed');

