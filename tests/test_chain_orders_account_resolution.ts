'use strict';

/**
 * tests/test_chain_orders_account_resolution.ts
 *
 * Focused coverage for the two-way account name<->id resolver in
 * modules/chain_orders.ts. The resolver is the single cached entry point for
 * turning a human name into a `1.2.x` id (and back) under the resolution lock,
 * so a regression here silently mis-addresses every account-scoped chain call.
 *
 * It is exercised against the REAL chain_orders module with only
 * bitshares_client mocked (get_full_accounts + waitForConnected). Compiled ESM
 * namespaces are frozen, so each scenario runs in its own hooked child process
 * via runEsmMockStages with fresh module state.
 *
 * Asserted contract:
 *   1. Already-shaped refs pass through untouched (no chain call).
 *   2. id -> name resolves via the chain and is cached (forward + reverse).
 *   3. name -> id resolves via the chain and is cached (forward + reverse).
 *   4. Cache hits never re-hit the chain.
 *   5. Null / non-string refs return null without a chain call.
 *   6. A lookup miss or a thrown chain error returns null and is NOT cached
 *      (a later successful lookup still reaches the chain).
 */

const assert = require('assert');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const chainOrdersPath = path.resolve(__dirname, '../modules/chain_orders.ts');

const ACCOUNTS: Record<string, { id: string; name: string }> = {
  alice: { id: '1.2.100', name: 'alice' },
  '1.2.100': { id: '1.2.100', name: 'alice' },
  bob: { id: '1.2.200', name: 'bob' },
  '1.2.200': { id: '1.2.200', name: 'bob' },
  dave: { id: '1.2.999', name: 'dave' },
  '1.2.999': { id: '1.2.999', name: 'dave' },
};

interface StubState {
  calls: string[];
  throwFor: string | null;
  connected: number;
}

function installStubs(state: StubState) {
  defineEsmMockAbs(bitsharesClientPath, [
    'BitShares',
    'createAccountClient',
    'waitForConnected',
    'withTimeout',
  ], {
    BitShares: {
      db: {
        get_full_accounts: async ([ref]: [string], _subscribe: boolean) => {
          state.calls.push(ref);
          if (state.throwFor && state.throwFor === ref) {
            throw new Error(`simulated chain failure for ${ref}`);
          }
          const account = ACCOUNTS[ref];
          if (!account) return [];
          return [[ref, { account: { id: account.id, name: account.name } }]];
        },
      },
    },
    createAccountClient: () => ({}),
    waitForConnected: async () => { state.connected += 1; },
    withTimeout: async (promise: Promise<unknown>) => promise,
  });
}

async function resolutionAndCache() {
  const state: StubState = { calls: [], throwFor: null, connected: 0 };
  installStubs(state);
  const orders = require('../modules/chain_orders');

  // 1. Pass-through refs short-circuit before the lock or the chain.
  assert.strictEqual(await orders.resolveAccountName('alice'), 'alice', 'name passes through to-name');
  assert.strictEqual(await orders.resolveAccountId('1.2.100'), '1.2.100', 'id passes through to-id');
  assert.strictEqual(state.calls.length, 0, 'pass-through must not touch the chain');

  // 2. id -> name: one chain call, then cached (forward and reverse).
  assert.strictEqual(await orders.resolveAccountName('1.2.100'), 'alice', 'id resolves to name');
  assert.strictEqual(state.calls.length, 1, 'id->name reaches the chain once');
  assert.strictEqual(await orders.resolveAccountName('1.2.100'), 'alice', 'id->name cached');
  assert.strictEqual(state.calls.length, 1, 'cache hit skips the chain');

  // Reverse mapping was populated as a side effect of the id->name lookup.
  assert.strictEqual(await orders.resolveAccountId('alice'), '1.2.100', 'reverse cache hit for name->id');
  assert.strictEqual(state.calls.length, 1, 'reverse cache hit skips the chain');

  // 3. name -> id for a fresh account, then its reverse.
  assert.strictEqual(await orders.resolveAccountId('bob'), '1.2.200', 'name resolves to id');
  assert.strictEqual(state.calls.length, 2, 'name->id reaches the chain once');
  assert.strictEqual(await orders.resolveAccountId('bob'), '1.2.200', 'name->id cached');
  assert.strictEqual(state.calls.length, 2, 'name->id cache hit skips the chain');
  assert.strictEqual(await orders.resolveAccountName('1.2.200'), 'bob', 'reverse cache hit for id->name');
  assert.strictEqual(state.calls.length, 2, 'reverse cache hit skips the chain');

  // 5. Null / non-string refs never reach the chain.
  assert.strictEqual(await orders.resolveAccountName(null), null, 'null name -> null');
  assert.strictEqual(await orders.resolveAccountId(undefined), null, 'undefined id -> null');
  assert.strictEqual(await orders.resolveAccountName(123 as any), null, 'non-string ref -> null');
  assert.strictEqual(await orders.resolveAccountId(null), null, 'null id -> null');
  assert.strictEqual(state.calls.length, 2, 'null refs never touch the chain');

  console.log('  \u2713 pass-through, forward/reverse caching, and null handling');
}

async function missesAndErrors() {
  const state: StubState = { calls: [], throwFor: null, connected: 0 };
  installStubs(state);
  const orders = require('../modules/chain_orders');

  // 6a. Lookup miss returns null and is NOT cached (a retry re-queries).
  assert.strictEqual(await orders.resolveAccountName('1.2.777'), null, 'unknown id -> null');
  assert.strictEqual(state.calls.length, 1, 'unknown id reaches the chain');
  assert.strictEqual(await orders.resolveAccountName('1.2.777'), null, 'unknown id -> null again');
  assert.strictEqual(state.calls.length, 2, 'a miss must not be cached');

  // 6b. A thrown chain error is swallowed to null and is NOT cached.
  state.throwFor = '1.2.999';
  assert.strictEqual(await orders.resolveAccountName('1.2.999'), null, 'chain error -> null');
  assert.strictEqual(state.calls.length, 3, 'throwing ref reaches the chain');
  state.throwFor = null;
  assert.strictEqual(await orders.resolveAccountName('1.2.999'), 'dave', 'retry succeeds after transient error');
  assert.strictEqual(state.calls.length, 4, 'error was not cached; retry reaches the chain');
  assert.strictEqual(await orders.resolveAccountName('1.2.999'), 'dave', 'success is now cached');
  assert.strictEqual(state.calls.length, 4, 'cached success skips the chain');

  assert.ok(state.connected >= 4, 'each chain lookup waits for the connection first');

  console.log('  \u2713 misses and thrown errors stay uncached and retry');
}

const STAGES: Record<string, () => Promise<void>> = {
  resolution_and_cache: resolutionAndCache,
  misses_and_errors: missesAndErrors,
};

runEsmMockStages(Object.keys(STAGES), async (stage) => {
  await STAGES[stage]();
  console.log('chain_orders account resolution tests passed');
});
