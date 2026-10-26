/**
 * FUND-TRUTH: chain-truth funding of a known candidate set.
 *
 * `available = chainFree - virtualReservation - fees` is circular when the
 * caller funds exactly the slots the reservation describes: an over-sized
 * projection (rail sized from a bigger balance, from inventory locked in
 * resting orders, or from optimistic proceeds) reads 0 forever and can never
 * shrink, because nothing may be placed. Live symptom (2026-10-24, 84 min):
 * free 454560.80 vs virtual 456046.21, `planned 3, placing 0` every cycle.
 *
 * The budget therefore falls back to chain truth, capped by the candidates'
 * ideal sizes and by the real free balance — never more than the chain holds.
 */

const assert = require('assert');
const MathUtils = require('../modules/order/utils/math');

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    ${msg}`);
    }
}

console.log('=== FUND-TRUTH: chain-truth funding budget ===');

const budget = (args: any) => MathUtils.deriveChainTruthFundBudget(args);

run('FUND-TRUTH-1 healthy cycle keeps the accounting budget untouched', () => {
    // 19:22 live figures: available 577.48, virtual 454209.01, free 454786.49.
    const r = budget({ availableFund: 577.48347077, virtualIntent: 454209.01315043, chainFree: 454786.4966212, candidateIdeals: 1435.9 });
    assert.strictEqual(r.eroded, false, 'a funded side must not be re-derived');
    assert.strictEqual(r.budget, 577.48347077, 'the accounting budget is authoritative while it is positive');
    assert.strictEqual(r.oversubscribed, 0, 'projection is below chain free => not oversubscribed');
});

run('FUND-TRUTH-2 oversubscribed cycle funds the candidates from chain truth', () => {
    // 2026-10-24 live figures: free 454560.80 vs virtual 456046.21 (deficit 1485.41).
    const r = budget({ availableFund: 0, virtualIntent: 456046.21352294, chainFree: 454560.8025932, candidateIdeals: 2171.2 });
    assert.strictEqual(r.eroded, true, 'the projection must be recognised as stale');
    assert.ok(Math.abs(r.oversubscribed - 1485.41092974) < 1e-6, `expected the 1485.41 deficit, got ${r.oversubscribed}`);
    assert.strictEqual(r.budget, 2171.2, 'the three holes were fundable all along — place them');
});

run('FUND-TRUTH-3 never commits more than the chain actually holds free', () => {
    const r = budget({ availableFund: 0, virtualIntent: 900, chainFree: 500, candidateIdeals: 4000 });
    assert.strictEqual(r.budget, 500, 'the free balance is the hard ceiling');
});

run('FUND-TRUTH-4 the add-back is capped by the candidates themselves', () => {
    // A huge stale projection must not let the planner spend beyond its own plan.
    const r = budget({ availableFund: 0, virtualIntent: 12000, chainFree: 10000, candidateIdeals: 120 });
    assert.strictEqual(r.budget, 120, 'only the planned candidates are funded');
});

run('FUND-TRUTH-5 no projection, no candidates, or zero free => unchanged (0)', () => {
    assert.strictEqual(budget({ availableFund: 0, virtualIntent: 0, chainFree: 100, candidateIdeals: 50 }).budget, 0);
    assert.strictEqual(budget({ availableFund: 0, virtualIntent: 100, chainFree: 100, candidateIdeals: 0 }).budget, 0);
    assert.strictEqual(budget({ availableFund: 0, virtualIntent: 100, chainFree: 0, candidateIdeals: 50 }).budget, 0);
    assert.strictEqual(budget({ availableFund: 0, virtualIntent: 100, chainFree: 0, candidateIdeals: 50 }).eroded, false);
});

run('FUND-TRUTH-7 a zero caused by fees (projection FITS) is a real constraint', () => {
    // chainFree 1000, projection 900 => the rail fits; available is 0 because of
    // the fee reservation. Funding "from chain truth" here would spend fee money.
    const r = budget({ availableFund: 0, virtualIntent: 900, chainFree: 1000, candidateIdeals: 300 });
    assert.strictEqual(r.oversubscribed, 0, 'the projection fits in the free balance');
    assert.strictEqual(r.eroded, false, 'only an oversubscription may re-derive the budget');
    assert.strictEqual(r.budget, 0, 'a fee-constrained zero must be honoured');
});

run('FUND-TRUTH-6 absent/garbage inputs fail closed to the accounting budget', () => {
    assert.strictEqual(budget(null).budget, 0);
    assert.strictEqual(budget({ availableFund: NaN, virtualIntent: 'x', chainFree: undefined, candidateIdeals: 10 } as any).budget, 0);
});

console.log(`\nFUND-TRUTH summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
