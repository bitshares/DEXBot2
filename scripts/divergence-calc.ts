/**
 * Quadratic Divergence Calculator
 *
 * Analyzes order grid divergence between persisted and calculated values.
 * Calculates a quadratic divergence metric to measure grid consistency.
 *
 * Input: Order data in format: [Buy|Sell] [buy|sell]-[id] @ [price]: [persisted] → [calculated] [[state]]
 * Source: Can read from file (argument) or stdin
 *
 * Output: Divergence metrics including:
 * - Sum of squared relative differences
 * - Normalized metric in promille (‰) units
 * - Real average error percentage
 * - Min/max errors with order details
 * - Threshold comparison
 *
 * Order states:
 * - 'active': Normal grid orders
 * - 'virtual': Simulated orders
 * - 'partial': Temporarily filled orders (excluded from calculation)
 *
 * Usage: node dist/scripts/divergence-calc.js [file] or pipe: cat orders.txt | node dist/scripts/divergence-calc.js
 * Exit code: 0 on success, 1 on error
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const Format = require('../modules/order/format');
const { getErrorMessage } = require('../modules/utils/errors');

/**
 * readData: Read order data from file or stdin
 *
 * Supports two input modes:
 * 1. File argument: node dist/scripts/divergence-calc.js /path/to/file
 * 2. Stdin: cat file | node dist/scripts/divergence-calc.js or node dist/scripts/divergence-calc.js -
 *
 * @returns {string} Raw order data lines
 * @throws {Error} If file cannot be read
 */
function readData() {
  const args = process.argv.slice(2);

  if (args.length > 0 && args[0] !== '-') {
    // Read from file if argument provided
    const filePath = path.resolve(args[0]);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.error(`Error reading file "${filePath}":`, getErrorMessage(err) ?? String(err));
      process.exit(1);
    }
  }

  // Otherwise read from stdin
  return fs.readFileSync(0, 'utf-8');
}

const data = readData();

const lines = data.trim().split('\n');
interface DivergenceOrder { orderId: string; price: number; persisted: number; calculated: number; state: string; type?: string }
const orders: DivergenceOrder[] = [];

lines.forEach((line: string) => {
  // Parse orders in format: Buy/Sell order-id @ price: persisted → calculated [state]
  // State is optional and used to exclude partial orders
  const match = line.match(/(?:Buy|Sell) (?:buy|sell)-(\d+) @ ([\d.]+): ([\d.]+) → ([\d.]+)(?:\s+\[(\w+)\])?/);
  if (match) {
    const orderId = match[1];
    const price = parseFloat(match[2]);
    const persisted = parseFloat(match[3]);   // First value is persisted (old)
    const calculated = parseFloat(match[4]);  // Second value is calculated (new)
    const state = match[5] || 'active';       // Default to 'active' if no state specified
    orders.push({ orderId, price, calculated, persisted, state });
  }
});

// Filter out partial orders from divergence calculation
// Include: 'active' and 'virtual' orders - these represent the intended grid structure
// Exclude: 'partial' orders - these are temporarily filled and in transition
const nonPartialOrders = orders.filter((o) => o.state !== 'partial');
const partialOrdersCount = orders.length - nonPartialOrders.length;

// Calculate divergence metric: sum of ((calculated - persisted) / persisted)^2 / count
let sumSquaredDiff = 0;
nonPartialOrders.forEach((order) => {
  const relativeError = (order.calculated - order.persisted) / order.persisted;
  sumSquaredDiff += relativeError * relativeError;
});

const normalizedMetric = nonPartialOrders.length > 0 ? sumSquaredDiff / nonPartialOrders.length : 0;
const promille = normalizedMetric * 1000;

// Calculate real error as √(promille / 1000)
const realErrorPercent = Math.sqrt(promille / 1000) * 100;

console.log('=== QUADRATIC DIVERGENCE ANALYSIS ===\n');
console.log(`Total orders in input: ${orders.length}`);
console.log(`Orders analyzed: ${nonPartialOrders.length}`);
if (partialOrdersCount > 0) {
  console.log(`Partial orders excluded: ${partialOrdersCount}`);
}
console.log(`Sum of squared relative differences: ${Format.formatPrice4(sumSquaredDiff)}`);
console.log(`\nMetric: ${Format.formatPrice4(normalizedMetric)}`);
console.log(`In promille: ${Format.formatPrice4(promille)}`);
console.log(`Real average error: ${Format.formatMetric2(realErrorPercent)}%`);
console.log(`\nThreshold comparison (hardcoded):`);
console.log(`  Current: ${Format.formatPrice4(promille)} promille`);
console.log(`  Default threshold: 1 promille (3.2% avg error)`);
console.log(`  Status: ${promille <= 1 ? '✓ WITHIN THRESHOLD' : '✗ EXCEEDS THRESHOLD'}`);

// Show min/max errors
let minError = Infinity, maxError = -Infinity;
let minErrorOrder: (DivergenceOrder & { idx: number }) | null = null, maxErrorOrder: (DivergenceOrder & { idx: number }) | null = null;
nonPartialOrders.forEach((order, idx) => {
  const absError = Math.abs((order.calculated - order.persisted) / order.persisted);
  if (absError < minError) { minError = absError; minErrorOrder = { ...order, idx }; }
  if (absError > maxError) { maxError = absError; maxErrorOrder = { ...order, idx }; }
});

const minOrder = minErrorOrder!;
const maxOrder = maxErrorOrder!;
console.log(`\nMin error: ${Format.formatPrice4(minError * 100)}% at order-${minOrder.idx} (${minOrder.type || 'unknown'})`);
console.log(`  Calculated: ${Format.formatPrice(minOrder.calculated)}, Persisted: ${Format.formatPrice(minOrder.persisted)}`);
console.log(`Max error: ${Format.formatPrice4(maxError * 100)}% at order-${maxOrder.idx} (${maxOrder.type || 'unknown'})`);
console.log(`  Calculated: ${Format.formatPrice(maxOrder.calculated)}, Persisted: ${Format.formatPrice(maxOrder.persisted)}`);
export {};
