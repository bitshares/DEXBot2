'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getErrorMessage } = require('../modules/utils/errors');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM namespaces are frozen and require.cache injection cannot
// intercept static ESM imports, so bitshares_client / chain_orders are
// replaced through loader hooks (same technique as test_credit_runtime).
// Without this the mocks are inert and refreshState opens real WebSocket
// connections to the public node list (multi-second DNS/connect timeouts).
esmMockEntry();

// Mock dependencies
const BitSharesMock = {
    db: {
        call: async (method, args) => {
            if (method === 'get_assets') return args[0].map(id => ({ id, symbol: 'ASSET' + id.split('.')[2], precision: 5 }));
            if (method === 'lookup_asset_symbols') return args[0].map(sym => ({ id: '1.3.' + sym.length, symbol: sym, precision: 5 }));
            if (method === 'get_objects') return args[0].map(id => ({ id, type: 'object' }));
            return [];
        }
    }
};

global.BitShares = BitSharesMock;

/**
 * Register an ESM mock for a module. Only the names listed here become named
 * exports of the stub, so the list must match everything credit_runtime (and
 * its graph) imports from the module — the same set test_credit_runtime uses.
 * Do NOT require the real module first: that caches it in the ESM registry and
 * the loader hook would never fire for credit_runtime's import.
 */
function registerEsmMock(relPath, names, overrides) {
    defineEsmMockAbs(require.resolve(relPath), names, overrides);
}

registerEsmMock('../modules/bitshares_client', [
    'BitShares',
    'waitForConnected',
    'createAccountClient',
    'setSuppressConnectionLog',
    'getNodeManager',
    'getNodeStats',
    'getNodeSummary',
    '_internal',
], {
    BitShares: BitSharesMock,
    waitForConnected: async () => {},
    createAccountClient: () => ({}),
    setSuppressConnectionLog() {},
    getNodeManager: () => null,
    getNodeStats: () => null,
    getNodeSummary: () => null,
    _internal: { connected: true },
});

registerEsmMock('../modules/chain_orders', [
    'resolveAccountId',
    'resolveAccountName',
    'getOnChainAssetBalances',
    'executeBatch',
], {
    resolveAccountId: async (accountRef) => accountRef || '1.2.0',
    resolveAccountName: async (accountRef) => accountRef || 'account',
    getOnChainAssetBalances: async (accountRef, assets) => {
        const out = {};
        for (const asset of assets || []) {
            out[String(asset)] = { free: 0, locked: 0, total: 0 };
        }
        return out;
    },
    executeBatch: async () => ({ tx_id: 'noop', operation_results: [] }),
});

const CreditRuntime = require('../modules/credit_runtime').default;
const { readJSON } = require('../modules/storage').getStorage();

async function testCollateralDistribution() {
    console.log('Testing collateral distribution logic...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 3.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);

    // Mock internal methods
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime._resolveCreditConversionRate = async () => 1.0;

    await runtime._calculateCollateralDistribution();

    const usdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const cnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;

    console.log(`USD Budget: ${usdBudget}, CNY Budget: ${cnyBudget}`);

    // Total weight = (1 * 2.0) + (1 * 3.0) = 5.0
    // C_total = min(20000, 10000) = 10000
    // USD C_i = 10000 * 2.0 / 5.0 = 4000
    // CNY C_i = 10000 * 3.0 / 5.0 = 6000
    assert.strictEqual(usdBudget, 4000);
    assert.strictEqual(cnyBudget, 6000);

    console.log('Test passed!');
}

async function testCollateralDistributionWithCredit() {
    console.log('Testing collateral distribution with Credit...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 2, maxCollateralRatio: 2.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);

    // Mock internal methods
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime._resolveCreditConversionRate = async () => 1.0;

    await runtime._calculateCollateralDistribution();

    const usdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const cnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;

    console.log(`USD Budget: ${usdBudget}, CNY Budget: ${cnyBudget}`);

    // Total weight = (1 * 2.0) + (2 * 2.0) = 6.0
    // C_total = 10000
    // USD C_i = 10000 * 2.0 / 6.0 = 3333.333...
    // CNY C_i = 10000 * 4.0 / 6.0 = 6666.666...
    assert.ok(Math.abs(usdBudget - 3333.3333333333335) < 0.0001);
    assert.ok(Math.abs(cnyBudget - 6666.666666666667) < 0.0001);

    console.log('Test passed!');
}

async function testRefreshStateMulti() {
    console.log('Testing refreshState with multiple positions...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);

    // Mock internal methods
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime._resolveCreditConversionRate = async () => 1.0;

    runtime._getFullAccount = async () => ({
        call_orders: [
            { id: '1.18.1', call_price: { base: { asset_id: '1.3.0' }, quote: { asset_id: '1.3.1' } }, debt: { amount: 100000, asset_id: '1.3.1' }, collateral: { amount: 500000, asset_id: '1.3.0' } },
            { id: '1.18.2', call_price: { base: { asset_id: '1.3.0' }, quote: { asset_id: '1.3.2' } }, debt: { amount: 200000, asset_id: '1.3.2' }, collateral: { amount: 800000, asset_id: '1.3.0' } }
        ]
    });
    runtime._fetchBorrowerDeals = async () => [];
    runtime._resolveBitassetData = async (ref) => {
        const assetId = typeof ref === 'object' ? ref?.id : ref;
        return {
            current_feed: {
                settlement_price: {
                    base: { amount: 10, asset_id: '1.3.0' },
                    quote: { amount: 1, asset_id: assetId || '1.3.1' }
                }
            }
        };
    };
    runtime.persistState = async () => {};
    // Offline seams: this scenario covers multi-position refresh wiring, not
    // live collateral balances or deal discovery.
    runtime._resolveAccountId = async () => '1.2.3';
    (runtime as any)._fetchOwnedCreditOffers = async () => [];
    (runtime as any)._getOnChainAssetBalancesFn = async () => ({});
    await runtime.refreshState();

    const usdPos = runtime.state.positions['1.3.1:1.3.0'];
    const cnyPos = runtime.state.positions['1.3.2:1.3.0'];

    assert.ok(usdPos, 'USD position should exist');
    assert.ok(cnyPos, 'CNY position should exist');
    assert.strictEqual(usdPos.activeCallOrderId, '1.18.1');
    assert.strictEqual(cnyPos.activeCallOrderId, '1.18.2');
    assert.strictEqual(usdPos.assignedCollateralBudget, 5000);
    assert.strictEqual(cnyPos.assignedCollateralBudget, 5000);

    console.log('Test passed!');
}

async function testIsEnabledNewFormat() {
    console.log('Testing isEnabled with new collateralAsset + lending format...');

    const enabledBot = {
        config: {
            debtPolicy: {
                lending: [{ asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa' }]
            }
        }
    };
    const disabledBot = {
        config: {
            debtPolicy: {}
        }
    };

    const enabledRuntime = new CreditRuntime(enabledBot);
    const disabledRuntime = new CreditRuntime(disabledBot);

    assert.strictEqual(enabledRuntime.isEnabled(), true, 'should be enabled when collateralAsset and lending are present');
    assert.strictEqual(disabledRuntime.isEnabled(), false, 'should be disabled when lending is missing');

    console.log('Test passed!');
}

async function testIsEnabledLegacyFormat() {
    console.log('Testing isEnabled with legacy flat mpa/creditOffer format returns false...');

    const mpaBot = {
        config: {
            debtPolicy: { mpa: { targetCollateralRatio: 2.0 } }
        }
    };
    const creditBot = {
        config: {
            debtPolicy: { creditOffer: { maxCollateralRatio: 2.0 } }
        }
    };
    const emptyBot = {
        config: {}
    };

    assert.strictEqual(new CreditRuntime(mpaBot).isEnabled(), false, 'legacy mpa should be disabled');
    assert.strictEqual(new CreditRuntime(creditBot).isEnabled(), false, 'legacy creditOffer should be disabled');
    assert.strictEqual(new CreditRuntime(emptyBot).isEnabled(), false, 'empty config should be disabled');

    console.log('Test passed!');
}

async function testStatePersistenceWithPositions() {
    console.log('Testing state persistence includes positions...');

    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-multi-asset-'));
    const bot = {
        config: {
            botKey: 'persist-test',
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot, { stateDir: baseDir });
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        return null;
    };
    runtime._getCollateralPercentageBase = async () => 10000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime._resolveCreditConversionRate = async () => 1.0;

    await runtime._calculateCollateralDistribution();
    await runtime.persistState('test');

    const statePath = path.join(baseDir, 'persist-test.json');
    assert.ok(fs.existsSync(statePath), 'state file should be written');

    const persisted = readJSON(statePath);
    assert.ok(persisted.positions, 'persisted state should contain positions');
    assert.ok(persisted.positions['1.3.1:1.3.0'], 'USD position should be persisted');
    assert.strictEqual(persisted.positions['1.3.1:1.3.0'].assignedCollateralBudget, 10000);

    // Load back and verify
    const runtime2 = new CreditRuntime(bot, { stateDir: baseDir });
    await runtime2.loadState();
    assert.strictEqual(runtime2.state.positions['1.3.1:1.3.0'].assignedCollateralBudget, 10000, 'loaded state should restore positions');

    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    console.log('Test passed!');
}

async function testThreeAssetEqualSplit() {
    console.log('Testing collateral distribution with three equal-ratio assets...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 9000,
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'EUR',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        if (ref === 'EUR') return { id: '1.3.3', symbol: 'EUR', precision: 5 };
        return null;
    };
    runtime._getCollateralPercentageBase = async () => 30000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime._resolveCreditConversionRate = async () => 1.0;


    await runtime._calculateCollateralDistribution();

    const usd = runtime.state.positions['1.3.1:1.3.0']?.assignedCollateralBudget;
    const cny = runtime.state.positions['1.3.2:1.3.0']?.assignedCollateralBudget;
    const eur = runtime.state.positions['1.3.3:1.3.0']?.assignedCollateralBudget;

    // All weights equal (1 * 2.0) => each gets 1/3 of C_total = 9000
    assert.strictEqual(usd, 3000, 'USD should get one third');
    assert.strictEqual(cny, 3000, 'CNY should get one third');
    assert.strictEqual(eur, 3000, 'EUR should get one third');

    console.log('Test passed!');
}

async function testMaxCollateralCap() {
    console.log('Testing global maxCollateralAmount caps total collateral...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 5000,
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return null;
    };
    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime._resolveCreditConversionRate = async () => 1.0;


    await runtime._calculateCollateralDistribution();

    const usd = runtime.state.positions['1.3.1:1.3.0']?.assignedCollateralBudget;
    const cny = runtime.state.positions['1.3.2:1.3.0']?.assignedCollateralBudget;

    // C_total should be capped at 5000, not 20000
    assert.strictEqual(usd, 2500);
    assert.strictEqual(cny, 2500);

    console.log('Test passed!');
}

async function testBuildMpaPlanUsesAssignedBudget() {
    console.log('Testing _buildMpaPlanFromState uses assignedCollateralBudget when available...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.2, maxCollateralAmount: 9999, maxBorrowAmount: 110, minCollateralRatio: 2.0, maxCollateralRatio: 2.5 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime.state.positions['1.3.1:1.3.0'] = {
        currentCollateralAmount: 600,
        currentDebtAmount: 100,
        feedPrice: 2.0,
        currentCollateralFundsTotal: 1000,
        assignedCollateralBudget: 400,
        mpaSelectionConflict: null,
    };

    const usdPolicy = bot.config.debtPolicy.lending[0];
    const plan = await runtime._buildMpaPlanFromState(usdPolicy, '1.3.1');
    assert.ok(plan, 'plan should be generated');
    // CR = 600/(100*2) = 3.0 > maxCr 2.5 → increase debt (capped by maxBorrowAmount)
    assert.strictEqual(plan.action, 'increase_debt', 'should want to increase debt');
    // The assigned budget (400) is passed as maxCollateralAmount to the planner.
    // With the debt-first planner, collateralDelta is negative (withdrawal) when debt is capped,
    // so the budget cap on additions is not triggered here, but the budget is still wired correctly.
    assert.ok(plan.collateralDelta < 0, 'collateral should be withdrawn after capped debt increase');

    console.log('Test passed!');
}

async function testBuildMpaPlanFallsBackToPolicyMaxCollateral() {
    console.log('Testing _buildMpaPlanFromState uses policy maxCollateralAmount when no budget...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', maxCollateralAmount: 500, targetCollateralRatio: 2.0, maxBorrowAmount: 55 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime.state.positions['1.3.1:1.3.0'] = {
        currentCollateralAmount: 150,
        currentDebtAmount: 50,
        feedPrice: 1.0,
        currentCollateralFundsTotal: 1000,
        mpaSelectionConflict: null,
    };

    const lendingItem = bot.config.debtPolicy.lending[0];
    const plan = await runtime._buildMpaPlanFromState(lendingItem, '1.3.1');
    assert.ok(plan, 'plan should be generated');
    assert.strictEqual(plan.action, 'increase_debt');
    assert.ok(plan.collateralDelta < 0, 'collateral should be withdrawn when debt increase is capped');

    console.log('Test passed!');
}

async function testBackwardCompatibilityFlatMpa() {
    console.log('Testing new format MPA state populates positions...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', targetCollateralRatio: 2.0, maxCollateralAmount: 1000 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        return null;
    };
    runtime._getFullAccount = async () => ({
        call_orders: [
            { id: '1.18.1', call_price: { base: { asset_id: '1.3.0' }, quote: { asset_id: '1.3.1' } }, debt: { amount: 100000, asset_id: '1.3.1' }, collateral: { amount: 250000, asset_id: '1.3.0' } }
        ]
    });
    runtime._resolveBitassetData = async (ref) => {
        const assetId = typeof ref === 'object' ? ref?.id : ref;
        return {
            current_feed: {
                settlement_price: {
                    base: { amount: 10, asset_id: '1.3.0' },
                    quote: { amount: 1, asset_id: assetId || '1.3.1' }
                }
            }
        };
    };
    runtime.persistState = async () => {};
    // Offline seam: this scenario covers MPA position wiring, not live
    // collateral balances.
    runtime._resolveAccountId = async () => '1.2.3';
    (runtime as any)._getOnChainAssetBalancesFn = async () => ({});

    const lendingItem = bot.config.debtPolicy.lending[0];
    await runtime.refreshMpaState(lendingItem);

    const pos = runtime.state.positions['1.3.1:1.3.0'];
    assert.ok(pos, 'position should exist');
    assert.strictEqual(pos.activeCallOrderId, '1.18.1', 'position activeCallOrderId should be populated');
    assert.strictEqual(pos.debtAssetId, '1.3.1');
    assert.strictEqual(pos.currentCollateralAmount, 2.5, 'collateral should be in float units');

    console.log('Test passed!');
}

async function testRunMaintenanceIteratesLending() {
    console.log('Testing runMaintenance iterates over lending items in multi-asset mode...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    const mpaCalls = [];
    const creditCalls = [];

    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return null;
    };
    runtime.refreshState = async () => {};
    runtime._runMpaMaintenance = async (ctx, opts, policy, assetId) => {
        mpaCalls.push({ ctx, policy, assetId });
        return { executed: [] };
    };
    runtime._runCreditMaintenance = async (policy, assetId) => {
        creditCalls.push({ policy, assetId });
        return null;
    };
    runtime.persistState = async () => {};

    const result = await runtime.runMaintenance('periodic');

    assert.strictEqual(mpaCalls.length, 1, 'should call MPA maintenance once');
    assert.strictEqual(mpaCalls[0].assetId, '1.3.1', 'MPA maintenance should target USD');
    assert.strictEqual(creditCalls.length, 1, 'should call credit maintenance once');
    assert.strictEqual(creditCalls[0].assetId, '1.3.2', 'credit maintenance should target CNY');
    assert.ok(Array.isArray(result.mpa), 'result.mpa should be an array');
    assert.ok(Array.isArray(result.credit), 'result.credit should be an array');

    console.log('Test passed!');
}

async function testCreditMaintenanceUsesDealCollateral() {
    console.log('Testing credit maintenance reborrow uses deal collateral...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0, autoReborrow: true }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime.state.positions['1.3.2:1.3.0'] = {
        assignedCollateralBudget: 5000,
        creditDeals: [{
            id: '1.19.1',
            offerId: '1.18.1',
            debtAssetId: '1.3.2',
            debtAmount: 100,
            collateralAssetId: '1.3.0',
            collateralAmount: 250,
            feeRate: 30000,
            latestRepayTime: new Date(Date.now() + 3600_000).toISOString(),
            autoRepay: 0,
        }],
        activeDealIds: ['1.19.1'],
    };

    let capturedOps = null;
    runtime.buildCreditDealRepayOperation = async () => ({ op_name: 'credit_deal_repay', op_data: {} });
    runtime._getOfferById = async () => ({
        id: '1.18.1',
        asset_type: '1.3.2',
        fee_rate: 1,
        max_duration_seconds: 86400,
        enabled: true,
        acceptable_collateral: {
            '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.2' } }
        }
    });
    runtime._resolveAccountId = async () => '1.2.3';
    runtime.executeOperations = async (ops) => { capturedOps = ops; return { tx_id: 'tx-test' }; };
    runtime._fetchBorrowerDeals = async () => [];
    runtime.refreshCreditState = async () => {};
    // Offline seam: repayCreditDeal's post-repay refreshState would hit the
    // live chain; refreshCreditState above already covers the state update
    // this scenario asserts on (captured reborrow ops).
    runtime.refreshState = async () => {};
    runtime.persistState = async () => {};

    const specificPolicy = bot.config.debtPolicy.lending[0];
    await runtime._runCreditMaintenance(specificPolicy, '1.3.2');

    assert.ok(capturedOps, 'executeOperations should have been called');
    const acceptOp = capturedOps.find((op) => op.op_name === 'credit_offer_accept');
    assert.ok(acceptOp, 'reborrow should build a credit_offer_accept operation via real buildCreditOfferAcceptOperation');
    assert.strictEqual(acceptOp.op_data.collateral.amount, 250, 'reborrow collateral should be 250 (existingCollateralAmount 0.0025 → floatToBlockchainInt with BTS precision 5)');

    console.log('Test passed!');
}

async function testCreditMaintenanceResistsAssignedBudgetUnderflow() {
    console.log('Testing credit maintenance reborrow resists undersized assignedCollateralBudget...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0, autoReborrow: true }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime.state.positions['1.3.2:1.3.0'] = {
        assignedCollateralBudget: 0.0001,
        creditDeals: [{
            id: '1.19.2',
            offerId: '1.18.1',
            debtAssetId: '1.3.2',
            debtAmount: 100,
            collateralAssetId: '1.3.0',
            collateralAmount: 250,
            feeRate: 30000,
            latestRepayTime: new Date(Date.now() + 3600_000).toISOString(),
            autoRepay: 0,
        }],
        activeDealIds: ['1.19.2'],
    };

    let capturedOps = null;
    runtime.buildCreditDealRepayOperation = async () => ({ op_name: 'credit_deal_repay', op_data: {} });
    runtime._getOfferById = async () => ({
        id: '1.18.1',
        asset_type: '1.3.2',
        fee_rate: 1,
        max_duration_seconds: 86400,
        enabled: true,
        acceptable_collateral: {
            '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.2' } }
        }
    });
    runtime._resolveAccountId = async () => '1.2.3';
    runtime.executeOperations = async (ops) => { capturedOps = ops; return { tx_id: 'tx-test' }; };
    runtime._fetchBorrowerDeals = async () => [];
    runtime.refreshCreditState = async () => {};
    // Offline seam: repayCreditDeal's post-repay refreshState would hit the
    // live chain; refreshCreditState above already covers the state update
    // this scenario asserts on (captured reborrow ops).
    runtime.refreshState = async () => {};
    runtime.persistState = async () => {};

    const specificPolicy = bot.config.debtPolicy.lending[0];
    await runtime._runCreditMaintenance(specificPolicy, '1.3.2');

    assert.ok(capturedOps, 'executeOperations should have been called');
    const acceptOp = capturedOps.find((op) => op.op_name === 'credit_offer_accept');
    assert.ok(acceptOp, 'reborrow should build a credit_offer_accept operation');
    assert.strictEqual(acceptOp.op_data.collateral.amount, 250, 'reborrow collateral should use deal collateral (250), not the undersized assignedCollateralBudget (0.0001)');

    console.log('Test passed!');
}

async function testCreditAcceptUsesSpecificPolicy() {
    console.log('Testing buildCreditOfferAcceptOperation respects specificPolicy over looked-up policy...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 5.0, maxFeeRatePerDay: 0.05, autoReborrow: true }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        return null;
    };
    runtime._resolveAccountId = async () => '1.2.3';

    const offer = {
        id: '1.18.1',
        asset_type: '1.3.1',
        fee_rate: 30000,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
            '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.1' } }
        }
    };

    const strictPolicy = { ...bot.config.debtPolicy.lending[0], maxCollateralRatio: 1.5 };

    // With specificPolicy maxCollateralRatio=1.5, borrowAmount=50 and collateralValue=200 gives CR=2.0 > 1.5 → should reject
    try {
        await runtime.buildCreditOfferAcceptOperation({
            offer,
            borrowAmount: 50,
            collateralAmount: 200,
            specificPolicy: strictPolicy,
        });
        assert.fail('should have thrown because specificPolicy maxCollateralRatio is stricter');
    } catch (err) {
        assert.ok(getErrorMessage(err).includes('maxCollateralRatio'), 'error should mention maxCollateralRatio from specificPolicy');
    }

    // Without specificPolicy, looked-up lending policy maxCollateralRatio=5.0 should allow the operation
    const op = await runtime.buildCreditOfferAcceptOperation({
        offer,
        borrowAmount: 50,
        collateralAmount: 200,
    });
    assert.strictEqual(op.op_name, 'credit_offer_accept', 'looked-up lending policy should allow the operation');

    console.log('Test passed!');
}

async function testCreditMaintenancePassesSpecificPolicy() {
    console.log('Testing _runCreditMaintenance passes specificPolicy through reborrow...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                lending: [
                    { asset: 'EUR',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0, autoReborrow: true }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);
    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'EUR' || ref === '1.3.3') return { id: '1.3.3', symbol: 'EUR', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime.state.positions['1.3.3:1.3.0'] = {
        assignedCollateralBudget: 3000,
        creditDeals: [{
            id: '1.19.3',
            offerId: '1.18.3',
            debtAssetId: '1.3.3',
            debtAmount: 100,
            collateralAssetId: '1.3.0',
            collateralAmount: 250,
            feeRate: 30000,
            latestRepayTime: new Date(Date.now() + 3600_000).toISOString(),
            autoRepay: 0,
        }],
        activeDealIds: ['1.19.3'],
    };

    let capturedSpecificPolicy = null;
    runtime.repayCreditDeal = async (deal, amount, options) => {
        capturedSpecificPolicy = options.specificPolicy;
        return { tx_id: 'tx-test' };
    };
    runtime._getOfferById = async () => ({ id: '1.18.3', enabled: true });
    runtime.buildCreditOfferAcceptOperation = async () => ({
        op_name: 'credit_offer_accept',
        op_data: { collateral: { amount: 0, asset_id: '1.3.0' } }
    });
    runtime.executeOperations = async () => ({ tx_id: 'tx-test' });
    runtime.refreshCreditState = async () => {};
    runtime.persistState = async () => {};

    const specificPolicy = bot.config.debtPolicy.lending[0];
    await runtime._runCreditMaintenance(specificPolicy, '1.3.3');

    assert.ok(capturedSpecificPolicy, 'specificPolicy should be passed to repayCreditDeal');
    assert.strictEqual(capturedSpecificPolicy.maxCollateralRatio, 2.0, 'specificPolicy should contain the per-item maxCollateralRatio');

    console.log('Test passed!');
}

async function testMpaDistributionWithDifferentFeedPrices() {
    console.log('Testing MPA distribution with different feed prices...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);

    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };

    runtime._resolveMpaFeedPrice = async (debtAssetId, collateralAssetId) => {
        if (debtAssetId === '1.3.1') return 0.5;
        if (debtAssetId === '1.3.2') return 0.05;
        return null;
    };

    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveCreditConversionRate = async () => 1.0;

    await runtime._calculateCollateralDistribution();

    const usdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const cnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;

    // weight_USD = 1 * 0.5 * 2.0 = 1.0
    // weight_CNY = 1 * 0.05 * 2.0 = 0.1
    // totalWeight = 1.1
    // C_total = 10000
    // C_USD = 10000 * 1.0 / 1.1 = 9090.909...
    // C_CNY = 10000 * 0.1 / 1.1 = 909.090...
    const expectedUsdBudget = 10000 * 1.0 / 1.1;
    const expectedCnyBudget = 10000 * 0.1 / 1.1;

    console.log(`USD Budget: ${usdBudget}, CNY Budget: ${cnyBudget}`);

    assert.ok(Math.abs(usdBudget - expectedUsdBudget) < 0.0001, `USD budget ${usdBudget} should be ~${expectedUsdBudget}`);
    assert.ok(Math.abs(cnyBudget - expectedCnyBudget) < 0.0001, `CNY budget ${cnyBudget} should be ~${expectedCnyBudget}`);

    console.log('Test passed!');
}

async function testCreditDistributionWithDiscoveredPrice() {
    console.log('Testing credit distribution with discovered offer prices...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0, allowedOfferIds: ['1.18.1'] },
                    { asset: 'CNY',
                    collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0, allowedOfferIds: ['1.18.2'] }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);

    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };

    runtime._dbCall = async (method, args) => {
        if (method === 'get_objects') {
            return args[0].map((id) => {
                if (id === '1.18.1') {
                    // USD offer: 2 BTS = 1 USD  → conversionRate = 0.5 USD/BTS
                    return {
                        id: '1.18.1',
                        asset_type: '1.3.1',
                        enabled: true,
                        acceptable_collateral: {
                            '1.3.0': { base: { amount: 200000, asset_id: '1.3.0' }, quote: { amount: 100000, asset_id: '1.3.1' } }
                        }
                    };
                }
                if (id === '1.18.2') {
                    // CNY offer: 1 BTS = 20 CNY → conversionRate = 20 CNY/BTS
                    return {
                        id: '1.18.2',
                        asset_type: '1.3.2',
                        enabled: true,
                        acceptable_collateral: {
                            '1.3.0': { base: { amount: 100000, asset_id: '1.3.0' }, quote: { amount: 2000000, asset_id: '1.3.2' } }
                        }
                    };
                }
                return { id, type: 'object' };
            });
        }
        return [];
    };

    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveMpaFeedPrice = async () => 1.0;

    await runtime._calculateCollateralDistribution();

    const usdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const cnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;

    // conversionRate_USD = 100000/200000 = 0.5
    // conversionRate_CNY = 2000000/100000 = 20
    // weight_USD = (1 * 2.0) / 0.5 = 4.0
    // weight_CNY = (1 * 2.0) / 20 = 0.1
    // totalWeight = 4.1
    // C_total = 10000
    // C_USD = 10000 * 4.0 / 4.1 = 9756.09756...
    // C_CNY = 10000 * 0.1 / 4.1 = 243.90243...
    const expectedUsdBudget = 10000 * 4.0 / 4.1;
    const expectedCnyBudget = 10000 * 0.1 / 4.1;

    console.log(`USD Budget: ${usdBudget}, CNY Budget: ${cnyBudget}`);

    assert.ok(Math.abs(usdBudget - expectedUsdBudget) < 0.0001, `USD budget ${usdBudget} should be ~${expectedUsdBudget}`);
    assert.ok(Math.abs(cnyBudget - expectedCnyBudget) < 0.0001, `CNY budget ${cnyBudget} should be ~${expectedCnyBudget}`);

    console.log('Test passed!');
}

async function testCreditDistributionTreatsOfferPricingAsPairScoped() {
    console.log('Testing credit distribution treats offer pricing as pair-scoped...');

    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD', collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY', collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0, allowedOfferIds: ['1.18.999'] }
                ]
            }
        },
        _log: () => {},
        _warn: () => {}
    };

    const runtime = new CreditRuntime(bot);

    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime.state.positions['1.3.2:1.3.0'] = {
        creditDeals: [
            { id: '1.19.2', offerId: '1.18.2', debtAssetId: '1.3.2', collateralAssetId: '1.3.0' }
        ]
    };
    runtime._dbCall = async (method, args) => {
        if (method === 'get_objects') {
            return args[0].map((id) => {
                if (id === '1.18.2') {
                    return {
                        id: '1.18.2',
                        asset_type: '1.3.2',
                        enabled: true,
                        acceptable_collateral: {
                            '1.3.0': { base: { amount: 100000, asset_id: '1.3.0' }, quote: { amount: 2000000, asset_id: '1.3.2' } }
                        }
                    };
                }
                return null;
            });
        }
        return [];
    };

    await runtime._calculateCollateralDistribution();

    const usdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const cnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;
    const expectedUsdBudget = 10000 * 2.0 / 2.1;
    const expectedCnyBudget = 10000 * 0.1 / 2.1;

    assert.ok(Math.abs(usdBudget - expectedUsdBudget) < 0.0001, `USD budget ${usdBudget} should be ~${expectedUsdBudget}`);
    assert.ok(Math.abs(cnyBudget - expectedCnyBudget) < 0.0001, `CNY budget ${cnyBudget} should be ~${expectedCnyBudget}`);

    console.log('Test passed!');
}

async function testMpaDistributionUsesLastKnownFeedPrice() {
    console.log('Testing MPA distribution uses last known feed price when live feed is missing...');

    const warnings = [];
    let cnyFeedAvailable = true;
    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD', collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY', collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 3.0 }
                ]
            }
        },
        _log: () => {},
        _warn: (message) => warnings.push(message),
    };

    const runtime = new CreditRuntime(bot);

    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveBitassetData = async (ref) => {
        const assetId = typeof ref === 'object' ? ref?.id : ref;
        if (String(assetId) === '1.3.2' && !cnyFeedAvailable) {
            return { current_feed: { settlement_price: null } };
        }
        return {
            current_feed: {
                settlement_price: {
                    base: { amount: 10, asset_id: '1.3.0' },
                    quote: { amount: 10, asset_id: assetId || '1.3.1' }
                }
            }
        };
    };

    await runtime._calculateCollateralDistribution();
    const initialUsdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const initialCnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;
    assert.strictEqual(initialUsdBudget, 4000);
    assert.strictEqual(initialCnyBudget, 6000);

    warnings.length = 0;
    cnyFeedAvailable = false;
    await runtime._calculateCollateralDistribution();

    const cachedUsdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const cachedCnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;
    assert.strictEqual(cachedUsdBudget, 4000, 'USD budget should stay stable when another asset falls back to cached feed price');
    assert.strictEqual(cachedCnyBudget, 6000, 'CNY budget should stay stable when live feed is unavailable');
    assert(
        warnings.some((message) => message.includes('using last known feed price') && message.includes('CNY')),
        'runtime should warn when it falls back to the last known MPA feed price'
    );

    console.log('Test passed!');
}

async function testCreditDistributionUsesLastKnownOfferPrice() {
    console.log('Testing credit distribution uses last known offer price when live offer pricing is missing...');

    const warnings = [];
    let cnyOfferEnabled = true;
    const bot = {
        config: {
            preferredAccount: 'my-account',
            debtPolicy: {
                maxCollateralAmount: 10000,
                lending: [
                    { asset: 'USD', collateralAsset: 'BTS', type: 'mpa', outputWeight: 1, targetCollateralRatio: 2.0 },
                    { asset: 'CNY', collateralAsset: 'BTS', type: 'creditOffer', outputWeight: 1, maxCollateralRatio: 2.0, maxFeeRatePerDay: 0.05, allowedOfferIds: ['1.18.2'] }
                ]
            }
        },
        _log: () => {},
        _warn: (message) => warnings.push(message),
    };

    const runtime = new CreditRuntime(bot);

    runtime._resolveAsset = async (ref) => {
        if (ref === 'BTS' || ref === '1.3.0') return { id: '1.3.0', symbol: 'BTS', precision: 5 };
        if (ref === 'USD' || ref === '1.3.1') return { id: '1.3.1', symbol: 'USD', precision: 5 };
        if (ref === 'CNY' || ref === '1.3.2') return { id: '1.3.2', symbol: 'CNY', precision: 5 };
        return { id: '1.3.99', symbol: ref, precision: 5 };
    };
    runtime._getCollateralPercentageBase = async () => 20000;
    runtime._resolveMpaFeedPrice = async () => 1.0;
    runtime._dbCall = async (method, args = []) => {
        if (method === 'get_objects') {
            const ids = Array.isArray(args?.[0]) ? args[0] : [];
            return ids.map((id) => {
                if (id === '1.18.2') {
                    return {
                        id: '1.18.2',
                        asset_type: '1.3.2',
                        enabled: cnyOfferEnabled,
                        fee_rate: 30000,
                        acceptable_collateral: {
                            '1.3.0': { base: { amount: 100000, asset_id: '1.3.0' }, quote: { amount: 2000000, asset_id: '1.3.2' } }
                        }
                    };
                }
                return null;
            });
        }
        return [];
    };

    await runtime._calculateCollateralDistribution();
    const initialUsdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const initialCnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;
    const expectedUsdBudget = 10000 * 2.0 / 2.1;
    const expectedCnyBudget = 10000 * 0.1 / 2.1;
    assert.ok(Math.abs(initialUsdBudget - expectedUsdBudget) < 0.0001);
    assert.ok(Math.abs(initialCnyBudget - expectedCnyBudget) < 0.0001);

    warnings.length = 0;
    cnyOfferEnabled = false;
    await runtime._calculateCollateralDistribution();

    const cachedUsdBudget = runtime.state.positions['1.3.1:1.3.0'].assignedCollateralBudget;
    const cachedCnyBudget = runtime.state.positions['1.3.2:1.3.0'].assignedCollateralBudget;
    assert.ok(Math.abs(cachedUsdBudget - expectedUsdBudget) < 0.0001, 'USD budget should stay stable when credit pricing falls back to cache');
    assert.ok(Math.abs(cachedCnyBudget - expectedCnyBudget) < 0.0001, 'CNY budget should stay stable when live offer pricing is unavailable');
    assert(
        warnings.some((message) => message.includes('using last known price') && message.includes('CNY')),
        'runtime should warn when it falls back to the last known credit offer price'
    );

    console.log('Test passed!');
}

async function runTests() {
    try {
        await testCollateralDistribution();
        await testCollateralDistributionWithCredit();
        await testRefreshStateMulti();
        await testIsEnabledNewFormat();
        await testIsEnabledLegacyFormat();
        await testStatePersistenceWithPositions();
        await testThreeAssetEqualSplit();
        await testMaxCollateralCap();
        await testBuildMpaPlanUsesAssignedBudget();
        await testBuildMpaPlanFallsBackToPolicyMaxCollateral();
        await testBackwardCompatibilityFlatMpa();
        await testRunMaintenanceIteratesLending();
        await testCreditMaintenanceUsesDealCollateral();
        await testCreditMaintenanceResistsAssignedBudgetUnderflow();
        await testCreditAcceptUsesSpecificPolicy();
        await testCreditMaintenancePassesSpecificPolicy();
        await testMpaDistributionWithDifferentFeedPrices();
        await testCreditDistributionWithDiscoveredPrice();
        await testCreditDistributionTreatsOfferPricingAsPairScoped();
        await testMpaDistributionUsesLastKnownFeedPrice();
        await testCreditDistributionUsesLastKnownOfferPrice();
        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

runTests();
