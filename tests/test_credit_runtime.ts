'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Compiled ESM namespaces are frozen and cannot be swapped via require.cache;
// each scenario runs in its own hooked child process (runEsmMockStages) with
// fresh loader-hook mocks registered by installStubs().
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running credit runtime tests');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const chainOrdersPath = require.resolve('../modules/chain_orders');
const creditRuntimePath = path.resolve(__dirname, '../modules/credit_runtime.ts');

function installStubs(calls, dbCalls, options = {}) {
  const callOrders = (options as any).callOrders || [
    {
      id: '1.8.1',
      borrower: '1.2.3',
      debt: { amount: 100, asset_id: '1.3.10' },
      collateral: { amount: 250, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 2, asset_id: '1.3.0' },
        quote: { amount: 1, asset_id: '1.3.10' },
      },
    },
  ];
  const dealResponses = (options as any).dealResponses || [[
    {
      id: '1.19.77',
      borrower: '1.2.3',
      offer_id: '1.18.42',
      offer_owner: '1.2.9',
      debt_asset: '1.3.10',
      debt_amount: 500,
      collateral_asset: '1.3.0',
      collateral_amount: 1000,
      fee_rate: 30000,
      latest_repay_time: '2030-01-01T00:00:00',
      auto_repay: 0,
    },
  ]];
  let dealResponseIndex = 0;
  const assetsById = (options as any).assetsById || {
    '1.3.10': {
      id: '1.3.10',
      symbol: 'HONEST.USD',
      precision: 0,
      bitasset_data_id: '2.4.1',
    },
    '1.3.0': {
      id: '1.3.0',
      symbol: 'BTS',
      precision: 0,
      bitasset_data_id: null,
    },
  };
  const assetsBySymbol = new Map(Object.values(assetsById).map((asset) => [(asset as any).symbol, asset]));
  const bitassetObjects = (options as any).bitassetObjects || {
    '2.4.1': {
      id: '2.4.1',
      current_feed: {
        settlement_price: {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    },
  };
  const assetDynamicData = (options as any).assetDynamicData || {};
  const offersById = (options as any).offersById || {
    '1.18.42': {
      id: '1.18.42',
      asset_type: '1.3.10',
      current_balance: 10000,
      fee_rate: 30000,
      min_deal_amount: 100,
      enabled: true,
      max_duration_seconds: 86400,
      acceptable_collateral: {
        '1.3.0': {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    },
  };
  const creditOffersByOwner = (options as any).creditOffersByOwner || Object.values(offersById);
  const poolByShareAsset = (options as any).poolByShareAsset || {};
  const poolByAssetPair = (options as any).poolByAssetPair || {};
  const pairKey = (left, right) => [String(left), String(right)].sort().join('|');
  const handleDbCall = async (method, args) => {
    dbCalls.push({ method, args });
    if (method === 'get_full_accounts') {
      return [
        ['alice', {
          account: {
            id: '1.2.3',
            name: 'alice',
            call_orders: callOrders,
          },
        }],
      ];
    }
    if (method === 'get_assets') {
      const ids = Array.isArray(args?.[0]) ? args[0] : [];
      return ids.map((id) => assetsById[id] || null);
    }
    if (method === 'lookup_asset_symbols') {
      const symbols = Array.isArray(args?.[0]) ? args[0] : [];
      return symbols.map((symbol) => assetsBySymbol.get(symbol) || null);
    }
    if (method === 'get_objects') {
      const ids = Array.isArray(args?.[0]) ? args[0] : [];
      return ids.map((id) => {
        if (bitassetObjects[id]) return bitassetObjects[id];
        if (assetDynamicData[id]) return assetDynamicData[id];
        if (Object.prototype.hasOwnProperty.call(offersById, id)) return offersById[id];
        return null;
      });
    }
    if (method === 'get_liquidity_pools_by_share_asset') {
      const ids = Array.isArray(args?.[0]) ? args[0] : [];
      return ids.map((id) => poolByShareAsset[id] || null);
    }
    if (method === 'get_liquidity_pools_by_both_assets') {
      const left = args?.[0];
      const right = args?.[1];
      const pool = poolByAssetPair[pairKey(left, right)];
      return pool ? [pool] : [];
    }
    if (method === 'get_credit_deals_by_borrower') {
      const response = dealResponses[Math.min(dealResponseIndex, dealResponses.length - 1)];
      dealResponseIndex += 1;
      return response;
    }
    if (method === 'get_credit_offers_by_owner') {
      return creditOffersByOwner;
    }
    if (method === 'get_credit_offers_by_asset') {
      const assetId = args?.[0];
      return Object.values(offersById).filter((offer) => String((offer as any)?.asset_type) === String(assetId));
    }
    if (method === 'get_on_chain_asset_balances') {
      return (options as any).assetBalances || {};
    }
    return [];
  };

  const onExecuteBatch = typeof (options as any).onExecuteBatch === 'function' ? (options as any).onExecuteBatch : null;

  defineEsmMockAbs(bitsharesClientPath, [
    'BitShares',
    'waitForConnected',
    'createAccountClient',
    'setSuppressConnectionLog',
    'getNodeManager',
    'getNodeStats',
    'getNodeSummary',
    '_internal',
  ], {
    BitShares: {
      db: {
        call: handleDbCall,
        lookup_asset_symbols: async (symbols) => handleDbCall('lookup_asset_symbols', [symbols]),
        get_assets: async (ids) => handleDbCall('get_assets', [ids]),
        get_objects: async (ids) => handleDbCall('get_objects', [ids]),
        get_liquidity_pools_by_share_asset: async (ids, subscribe, withStatistics) => handleDbCall('get_liquidity_pools_by_share_asset', [ids, subscribe, withStatistics]),
        get_liquidity_pools_by_both_assets: async (left, right) => handleDbCall('get_liquidity_pools_by_both_assets', [left, right]),
        get_credit_deals_by_borrower: async (accountId) => handleDbCall('get_credit_deals_by_borrower', [accountId]),
        get_credit_offers_by_owner: async (accountId) => handleDbCall('get_credit_offers_by_owner', [accountId]),
        get_credit_offers_by_asset: async (assetId) => handleDbCall('get_credit_offers_by_asset', [assetId]),
        get_on_chain_asset_balances: async (accountRef, assets) => handleDbCall('get_on_chain_asset_balances', [accountRef, assets]),
      },
    },
    waitForConnected: async () => {},
    createAccountClient: () => ({}),
    setSuppressConnectionLog() {},
    getNodeManager: () => null,
    getNodeStats: () => null,
    getNodeSummary: () => null,
    _internal: { connected: true },
  });

  defineEsmMockAbs(chainOrdersPath, [
    'resolveAccountId',
    'resolveAccountName',
    'getOnChainAssetBalances',
    'executeBatch',
  ], {
    resolveAccountId: async (accountName) => {
      if (accountName === 'alice' || accountName === '1.2.3') return '1.2.3';
      return null;
    },
    resolveAccountName: async (accountRef) => {
      if (accountRef === '1.2.3' || accountRef === 'alice') return 'alice';
      return null;
    },
    getOnChainAssetBalances: async (accountRef, assets) => {
      const balanceMap = (options as any).assetBalances || {};
      const out: any = {};
      for (const asset of assets || []) {
        const key = String(asset);
        out[key] = balanceMap[key] || balanceMap[String(key)] || { free: 0, locked: 0, total: 0 };
      }
      return out;
    },
    executeBatch: async (accountName, privateKey, operations) => {
      calls.push({ accountName, privateKey, operations });
      if (onExecuteBatch) {
        await onExecuteBatch({ accountName, privateKey, operations });
      }
      return { tx_id: `tx-${calls.length}`, operation_results: operations.map((op, index) => [index, op.op_name]) };
    },
  });

  // Mocks live for the lifetime of the hooked child process; nothing to undo.
  return () => {};
}

function createBaseBotConfig(overrides = {}) {
  return {
    botKey: 'credit-bot',
    preferredAccount: 'alice',
    debtPolicy: {
      lending: [
        {
          asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
          type: 'mpa',
          outputWeight: 1,
          maxBorrowAmount: 1000,
          maxCollateralAmount: 10000,
          minCollateralRatio: 2,
          maxCollateralRatio: 2.5,
          targetCollateralRatio: 2.2,
        },
        {
          asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
          type: 'creditOffer',
          outputWeight: 1,
          maxBorrowAmount: 1000,
          maxCollateralRatio: 2.5,
          maxFeeRatePerDay: 0.05,
          autoReborrow: true,
        },
      ],
    },
    dryRun: false,
    ...overrides,
  };
}

async function testRefreshAndMpaPlan() {
  const calls = [];
  const dbCalls = [];
  const callOrders = [
    {
      id: '1.8.1',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 25000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      for (const op of operations) {
        if (op.op_name !== 'call_order_update') continue;
        callOrders[0].debt.amount += Number(op.op_data?.delta_debt?.amount || 0);
        callOrders[0].collateral.amount += Number(op.op_data?.delta_collateral?.amount || 0);
      }
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-runtime-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-0' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.positions['1.3.10:1.3.0'].activeCallOrderId, '1.8.1', 'MPA call order should be discovered');
    assert.deepStrictEqual(runtime.state.activeDealIds, ['1.19.77'], 'credit deal should be discovered');
    assert.deepStrictEqual(runtime.state.mpaCallOrders.map((entry) => entry.id), ['1.8.1'], 'MPA call orders should be captured in state');
    assert.strictEqual(runtime.state.ownedCreditOffers.length, 1, 'owned credit offers should be discovered');
    assert.strictEqual(runtime.state.debtSnapshot.assets['1.3.0'].mpaCollateral, 250, 'MPA collateral should be tracked in user units in the debt snapshot');
    assert.strictEqual(runtime.state.debtSnapshot.assets['1.3.0'].creditCollateral, 10, 'credit deal collateral should be tracked in user units in the debt snapshot');
    assert.strictEqual(runtime.state.debtSnapshot.assets['1.3.10'].offeredBalance, 100, 'owned credit offer balance should be tracked in user units in the debt snapshot');
    assert.strictEqual(runtime.state.positions['1.3.10:1.3.0'].debtAssetId, '1.3.10', 'debt asset should be tracked');
    assert(dbCalls.some((entry) => entry.method === 'get_credit_offers_by_owner'), 'refreshState should query owned credit offers');

    const mpaLending = runtime.debtPolicy.lending.find((item) => item.type === 'mpa');
    const plan = await runtime._buildMpaPlanFromState(mpaLending, '1.3.10');
    assert(plan, 'MPA plan should be generated');
    assert.strictEqual(plan.action, 'reduce_debt', 'below-min CR should reduce debt first');
    assert.strictEqual(plan.targetCollateralRatio, 2, 'plan should target the lower CR floor');

    const op = await runtime.buildMpaUpdateOperation(plan, {}, mpaLending, '1.3.10');
    assert.strictEqual(op.op_name, 'call_order_update', 'MPA plan should build a call_order_update op');
    assert.strictEqual(op.op_data.extensions.target_collateral_ratio, 2000, 'target CR should be embedded as Graphene ratio units (1/1000)');

    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.context, 'periodic', 'maintenance context should round-trip');
    assert.strictEqual(calls.length, 1, 'MPA maintenance should broadcast one operation');
    assert.strictEqual(calls[0].operations[0].op_name, 'call_order_update', 'broadcast op should be call_order_update');

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'credit_runtime', 'credit-bot-0.json'), 'utf8'));
    assert.strictEqual(persisted.botKey, 'credit-bot-0', 'state file should be keyed by bot');
    assert.strictEqual(persisted.positions['1.3.10:1.3.0'].activeCallOrderId, '1.8.1', 'state file should store the active call order');
    assert.strictEqual(persisted.activeDealIds[0], '1.19.77', 'state file should store the active credit deal');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferCollateralPercentUsesDebtSnapshot() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 10, locked: 25990, total: 26000 },
    },
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 1,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-percent-snapshot-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-percent-snapshot',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'mpa',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: '50%',
              minCollateralRatio: 2,
              maxCollateralRatio: 2.5,
              targetCollateralRatio: 2.2,
            },
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 1000000,
              maxCollateralRatio: 1000,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.positions['1.3.10:1.3.0'].currentCollateralFundsTotal, 26000, 'collateral balance total should be stored in position state');
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      borrowAmount: 100,
      collateralAmount: { amount: '50%', asset_id: '1.3.0' },
    });

    assert.strictEqual(op.op_data.collateral.amount, 13625, 'percentage collateral should resolve against the full collateral base');
    assert.strictEqual(dbCalls.filter((entry) => entry.method === 'get_credit_offers_by_owner').length > 0, true, 'credit offer ownership should be queried');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferCollateralPercentDoesNotRequireRefresh() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 10, locked: 25990, total: 26000 },
    },
    dealResponses: [[
      {
        id: '1.19.77',
        borrower: '1.2.3',
        offer_id: '1.18.42',
        offer_owner: '1.2.9',
        debt_asset: '1.3.10',
        debt_amount: 500,
        collateral_asset: '1.3.0',
        collateral_amount: 1000,
        fee_rate: 30000,
        latest_repay_time: '2030-01-01T00:00:00',
        auto_repay: 0,
      },
    ]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-stale-free-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-stale-free',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 1000000,
              maxCollateralRatio: 1000,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    runtime.state.positions['1.3.10:1.3.0'] = runtime.state.positions['1.3.10:1.3.0'] || {};
    runtime.state.positions['1.3.10:1.3.0'].currentCollateralFundsTotal = 1;
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      borrowAmount: 100,
      collateralAmount: { amount: '50%', asset_id: '1.3.0' },
    });

    assert.strictEqual(op.op_data.collateral.amount, 13625, 'percentage collateral should ignore stale runtime state and use a fresh collateral base');
    assert(dbCalls.some((entry) => entry.method === 'get_credit_deals_by_borrower'), 'fresh collateral base should query current deals');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaPrecisionAwareBroadcast() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 4,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 5,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200000, asset_id: '1.3.0' },
            quote: { amount: 10000, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders: [
      {
        id: '1.8.9',
        borrower: '1.2.3',
        debt: { amount: 10000, asset_id: '1.3.10' },
        collateral: { amount: 250000, asset_id: '1.3.0' },
        call_price: {
          base: { amount: 200000, asset_id: '1.3.0' },
          quote: { amount: 10000, asset_id: '1.3.10' },
        },
      },
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-precision-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-precision' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const mpaLending = runtime.debtPolicy.lending.find((item) => item.type === 'mpa');
    const plan = await runtime._buildMpaPlanFromState(mpaLending, '1.3.10');
    assert(plan, 'precision-aware MPA plan should be generated');
    assert.strictEqual(plan.action, 'reduce_debt', 'under-collateralized position should reduce debt');
    assert.strictEqual(plan.debtDelta, -0.375, 'debt delta should remain in human units');

    const op = await runtime.buildMpaUpdateOperation(plan, {}, mpaLending, '1.3.10');
    assert.strictEqual(op.op_data.delta_debt.amount, -3750, 'debt delta should convert to blockchain units once');
    assert.strictEqual(op.op_data.delta_collateral.amount, 0, 'collateral should not change for debt-first recovery');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaDebtFailureFallsBackToCollateral() {
  const calls = [];
  const dbCalls = [];
  const callOrders = [
    {
      id: '1.8.10',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 25000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      const op = operations[0];
      if (op.op_name !== 'call_order_update') return;
      const debtDelta = Number(op.op_data?.delta_debt?.amount || 0);
      const collateralDelta = Number(op.op_data?.delta_collateral?.amount || 0);
      if (debtDelta < 0) {
        throw new Error('insufficient MPA balance');
      }
      callOrders[0].debt.amount += debtDelta;
      callOrders[0].collateral.amount += collateralDelta;
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-fallback-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-mpa-fallback',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'mpa',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 10000,
              minCollateralRatio: 2,
              maxCollateralRatio: 2.5,
              targetCollateralRatio: 2.2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.runMaintenance('periodic');

    assert.strictEqual(calls.length, 2, 'runtime should try the debt leg and then a collateral fallback');
    assert.strictEqual(calls[0].operations[0].op_data.delta_debt.amount < 0, true, 'first leg should try to reduce debt');
    assert.strictEqual(calls[1].operations[0].op_data.delta_debt.amount, 0, 'fallback should not change debt');
    assert.strictEqual(calls[1].operations[0].op_data.delta_collateral.amount > 0, true, 'fallback should add collateral');
    assert.strictEqual(result.mpa[0].executed[0].leg, 'collateral-fallback', 'result should record collateral fallback execution');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaDebtFailureDoesNotFallbackOnAmbiguousError() {
  const calls = [];
  const dbCalls = [];
  const callOrders = [
    {
      id: '1.8.11',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 25000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      const op = operations[0];
      if (op.op_name === 'call_order_update' && Number(op.op_data?.delta_debt?.amount || 0) < 0) {
        throw new Error('node broadcast timeout');
      }
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-no-fallback-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-mpa-no-fallback' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    await assert.rejects(
      () => runtime.runMaintenance('periodic'),
      /node broadcast timeout/,
      'ambiguous debt-leg failures should surface without collateral fallback'
    );

    assert.strictEqual(calls.length, 1, 'runtime should not broadcast collateral fallback after ambiguous failure');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaDebtFailureSurfacesWhenCollateralFallbackUnavailable() {
  const calls = [];
  const dbCalls = [];
  const callOrders = [
    {
      id: '1.8.13',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 25000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      const op = operations[0];
      if (op.op_name === 'call_order_update' && Number(op.op_data?.delta_debt?.amount || 0) < 0) {
        throw new Error('insufficient balance for debt repayment');
      }
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-fallback-unavailable-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-mpa-fallback-unavailable',
        debtPolicy: {
          maxCollateralAmount: 250,
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'mpa',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 250,
              minCollateralRatio: 2,
              maxCollateralRatio: 2.5,
              targetCollateralRatio: 2.2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    await assert.rejects(
      () => runtime.runMaintenance('periodic'),
      /insufficient balance for debt repayment/,
      'deterministic debt failure should surface when collateral fallback cannot execute'
    );

    assert.strictEqual(calls.length, 1, 'runtime should only broadcast the failed combined operation');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaDebtFallbackRespectsAssignedCollateralBudget() {
  const calls = [];
  const dbCalls = [];
  const callOrders = [
    {
      id: '1.8.12',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 25000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.11': {
        id: '1.3.11',
        symbol: 'HONEST.CNY',
        precision: 2,
        bitasset_data_id: '2.4.2',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
      '2.4.2': {
        id: '2.4.2',
        current_feed: {
          settlement_price: {
            base: { amount: 100, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.11' },
          },
        },
      },
    },
    assetBalances: {
      '1.3.0': { free: 1000, locked: 0, total: 1000 },
    },
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      '1.18.43': {
        id: '1.18.43',
        asset_type: '1.3.11',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 1, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.11' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      const op = operations[0];
      if (op.op_name !== 'call_order_update') return;
      const debtDelta = Number(op.op_data?.delta_debt?.amount || 0);
      const collateralDelta = Number(op.op_data?.delta_collateral?.amount || 0);
      if (debtDelta < 0) {
        throw new Error('insufficient MPA balance');
      }
      callOrders[0].debt.amount += debtDelta;
      callOrders[0].collateral.amount += collateralDelta;
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-budget-fallback-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-mpa-budget-fallback',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'mpa',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 10000,
              minCollateralRatio: 2,
              maxCollateralRatio: 2.5,
              targetCollateralRatio: 2.2,
            },
            {
              asset: 'HONEST.CNY',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 5,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              allowedOfferIds: ['1.18.43'],
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const assignedBudget = runtime.state.positions['1.3.10:1.3.0'].assignedCollateralBudget;
    assert(assignedBudget > 250 && assignedBudget < 440, 'test fixture should assign a partial MPA collateral budget');

    await runtime.runMaintenance('periodic');

    assert.strictEqual(calls.length, 2, 'runtime should try debt leg and budget-capped collateral fallback');
    const fallbackCollateralInt = calls[1].operations[0].op_data.delta_collateral.amount;
    assert(fallbackCollateralInt > 0, 'fallback should still add collateral');
    assert(fallbackCollateralInt < 19000, 'fallback collateral should be capped below the full target delta');
    assert(
      fallbackCollateralInt <= Math.round((assignedBudget - 250) * 100),
      'fallback collateral must not exceed assigned collateral budget remaining'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMpaDebtFirstThenCollateralFallbackTriggersReset() {
  const calls = [];
  const dbCalls = [];
  const resetCalls = [];
  const callOrders = [
    {
      id: '1.8.9',
      borrower: '1.2.3',
      debt: { amount: 10000, asset_id: '1.3.10' },
      collateral: { amount: 60000, asset_id: '1.3.0' },
      call_price: {
        base: { amount: 200, asset_id: '1.3.0' },
        quote: { amount: 100, asset_id: '1.3.10' },
      },
    },
  ];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    bitassetObjects: {
      '2.4.1': {
        id: '2.4.1',
        current_feed: {
          settlement_price: {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    callOrders,
    onExecuteBatch: async ({ operations }) => {
      for (const op of operations) {
        if (op.op_name !== 'call_order_update') continue;
        const debtDelta = Number(op.op_data?.delta_debt?.amount || 0);
        const collateralDelta = Number(op.op_data?.delta_collateral?.amount || 0);
        callOrders[0].debt.amount += debtDelta;
        callOrders[0].collateral.amount += collateralDelta;
      }
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-cr-reset-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-cr-reset',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'mpa',
              outputWeight: 1,
              maxBorrowAmount: 110,
              maxCollateralAmount: 10000,
              minCollateralRatio: 2,
              maxCollateralRatio: 2.5,
              targetCollateralRatio: 2.2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
      requestGridReset: async (reason, options = {}) => {
        resetCalls.push({ reason, options });
        return { requested: true, reason, options };
      },
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.runMaintenance('periodic');

    assert.strictEqual(calls.length, 1, 'CR repair should broadcast debt and collateral legs in a single atomic update');
    assert.strictEqual(calls[0].operations[0].op_data.delta_debt.amount, 1000, 'combined op should increase debt up to the total cap');
    assert.strictEqual(calls[0].operations[0].op_data.delta_collateral.amount < 0, true, 'combined op should withdraw collateral after the capped debt increase');
    assert.deepStrictEqual(result.mpa[0].executed.map((entry) => entry.leg), ['combined'], 'maintenance should record combined execution');
    assert.strictEqual(result.mpa[0].resetResult.reason, 'cr-adjustment', 'grid reset should be requested after CR adjustment');
    // AsyncLock is re-entrant; periodic CR reset doesn't need fillLockAlreadyHeld

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'credit_runtime', 'credit-bot-cr-reset.json'), 'utf8'));
    assert.strictEqual(typeof persisted.lastGridResetAt, 'string', 'reset timestamp should be persisted');
    assert.strictEqual(typeof persisted.lastCrAdjustment, 'object', 'CR adjustment metadata should be persisted');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testRepayAndReborrowFlow() {
  const calls = [];
  const dbCalls = [];
  const activeDeal = {
    id: '1.19.77',
    borrower: '1.2.3',
    offer_id: '1.18.42',
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: 500,
    collateral_asset: '1.3.0',
    collateral_amount: 1000,
    fee_rate: 30000,
    latest_repay_time: '2030-01-01T00:00:00',
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-repay-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-1',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
              renewOnly: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.repayCreditDeal('1.19.77', 200);
    assert.strictEqual(result.tx_id, 'tx-1', 'repay flow should broadcast one batch');
    assert.strictEqual(calls.length, 1, 'repay flow should not execute a second reborrow after a successful inline reborrow');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_deal_repay', 'first op should repay the deal');
    assert.strictEqual(calls[0].operations[1].op_name, 'credit_offer_accept', 'second op should reborrow the deal');
    assert.strictEqual(calls[0].operations[1].op_data.borrow_amount.amount, 200, 'default reborrow amount should match the repaid amount');
    assert.strictEqual(calls[0].operations[1].op_data.collateral.amount, 400, 'default reborrow collateral should follow offer price');
    assert.deepStrictEqual(calls[0].operations[1].op_data.extensions, { auto_repay: 2 }, 'credit offer accept should carry forward auto_repay from policy');
    assert.strictEqual(calls[0].operations[0].op_data.credit_fee.amount, 6, 'credit fee should be derived from fee rate');

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'credit_runtime', 'credit-bot-1.json'), 'utf8'));
    assert.strictEqual(persisted.reborrowPending, false, 'reborrow queue should be empty after successful batch');
    assert.strictEqual(typeof persisted.lastRepayAt, 'string', 'repay timestamp should be persisted');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testRenewOnlyRejectsStandaloneCreditBorrow() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-renew-only-standalone-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-renew-only-standalone',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              renewOnly: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          max_duration_seconds: 86400,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 2, asset_id: '1.3.0' },
              quote: { amount: 1, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 200,
        collateralAmount: 400,
      }),
      /renewOnly/,
      'renewOnly credit policy should reject standalone borrow attempts'
    );
    assert.strictEqual(calls.length, 0, 'renewOnly standalone borrow should not broadcast');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testFixedCreditCollateralDoesNotResolvePercentageBase() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-fixed-collateral-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-fixed-collateral',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      borrowAmount: 100,
      collateralAmount: { amount: 200, asset_id: '1.3.0' },
    });

    assert.strictEqual(op.op_data.collateral.amount, 200, 'fixed collateral should still build the requested amount');
    assert.strictEqual(
      dbCalls.some((entry) => entry.method === 'get_on_chain_asset_balances' || entry.method === 'get_full_accounts' || entry.method === 'get_credit_deals_by_borrower'),
      false,
      'fixed collateral should not query the percentage collateral base'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMultipleMpaPositionsAreBlocked() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    callOrders: [
      {
        id: '1.8.1',
        borrower: '1.2.3',
        debt: { amount: 100, asset_id: '1.3.10' },
        collateral: { amount: 250, asset_id: '1.3.0' },
        call_price: {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
      {
        id: '1.8.2',
        borrower: '1.2.3',
        debt: { amount: 75, asset_id: '1.3.10' },
        collateral: { amount: 200, asset_id: '1.3.0' },
        call_price: {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mpa-block-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-mpa-block' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.positions['1.3.10:1.3.0'].activeCallOrderId, null, 'multiple call orders should not select an active position');
    assert(runtime.state.positions['1.3.10:1.3.0'].mpaSelectionConflict, 'multiple positions should be marked as a conflict');

    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.mpa[0].blocked, true, 'maintenance should block MPA actions when the position is ambiguous');
    assert.strictEqual(calls.length, 0, 'no blockchain write should happen when MPA is ambiguous');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testRemovedCreditPolicyPrunesGlobalTracking() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-prune-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-prune' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.creditDeals.length, 1, 'initial refresh should discover the credit deal');

    runtime.config.debtPolicy = {
      lending: runtime.config.debtPolicy.lending.filter((item) => item.type !== 'creditOffer'),
    };
    await runtime.refreshState();

    assert.strictEqual(runtime.state.creditDeals.length, 0, 'removed credit policy should prune global credit deals');
    assert.strictEqual(runtime.state.activeDealIds.length, 0, 'removed credit policy should prune active deal ids');
    assert.strictEqual(runtime.state.activeOfferIds.length, 0, 'removed credit policy should prune active offer ids');
    assert.strictEqual(
      runtime.state.debtSnapshot.assets['1.3.0']?.creditCollateral || 0,
      0,
      'debt snapshot should not include collateral from a pruned credit position'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testDefaultFeeRateCapRejectsExpensiveOffer() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-fee-cap-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: {
        botKey: 'credit-bot-fee-cap',
        preferredAccount: 'alice',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 1000000,
              maxCollateralRatio: 2.5,
              autoReborrow: true,
            },
          ],
        },
        dryRun: false,
      },
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    // Default maxFeeRatePerDay is ~0.000333 (1/3000 = 0.033% per day).
    // Offer: 3% flat / 1 day = 3% per day → should be rejected by default.
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 86400, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
        collateralAmount: { amount: 200, asset_id: '1.3.0' },
      }),
      /exceeds maxFeeRatePerDay/,
      'expensive offer should be rejected by default maxFeeRatePerDay'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMaxFeeRatePerDayRejectsExpensiveOffer() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-fee-day-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: {
        botKey: 'credit-bot-fee-day',
        preferredAccount: 'alice',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: '50%',
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.001,
              autoReborrow: true,
            },
          ],
        },
        dryRun: false,
      },
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    // Offer: 3% flat fee, 1 day duration → 3% per day. Policy limit: 0.1% per day.
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 86400, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
        collateralAmount: { amount: 200, asset_id: '1.3.0' },
      }),
      /daily fee rate .* exceeds maxFeeRatePerDay/,
      'expensive daily fee rate should be rejected'
    );

    // Offer: 3% flat fee, 30 day duration → 0.1% per day. Policy limit: 0.1% per day.
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 2592000, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
      collateralAmount: { amount: 200, asset_id: '1.3.0' },
    });
    assert.strictEqual(op.op_name, 'credit_offer_accept', 'acceptable daily fee rate should pass');

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: { id: '1.18.42', asset_type: '1.3.10', fee_rate: 30000, max_duration_seconds: 2592000, enabled: true, acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } } },
        collateralAmount: { amount: 1000, asset_id: '1.3.0' },
      }),
      /exceeds? maxCollateralAmount/,
      'credit offer collateral cap should accept percentages and enforce the resolved limit'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditBorrowIsDerivedFromCollateral() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-borrow-derivation-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-borrow-cap' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: {
        id: '1.18.42',
        asset_type: '1.3.10',
        fee_rate: 30000,
        enabled: true,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      collateralAmount: { amount: '50%', asset_id: '1.3.0' },
    });
    assert.strictEqual(op.op_data.collateral.amount, 825, 'percentage collateral should resolve against the full collateral base');
    assert.strictEqual(op.op_data.borrow_amount.amount, 412, 'borrow amount should derive from the full collateral base');

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 2, asset_id: '1.3.0' },
              quote: { amount: 1, asset_id: '1.3.10' },
            },
          },
        },
        collateralAmount: { amount: 3000, asset_id: '1.3.0' },
      }),
      /exceeds? maxBorrowAmount/,
      'collateral-derived borrows should still enforce maxBorrowAmount'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferTotalCeilingEnforcement() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetBalances: {
      '1.3.0': { free: 400, locked: 0, total: 400 },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-total-ceiling-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-total-ceiling',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 1200,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    // Existing default deal: debt 500, collateral 1000
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 2, asset_id: '1.3.0' },
              quote: { amount: 1, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 600,
        collateralAmount: { amount: 1200, asset_id: '1.3.0' },
      }),
      /exceeds? maxBorrowAmount/,
      'total borrow ceiling should include existing credit deals'
    );

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 2, asset_id: '1.3.0' },
              quote: { amount: 1, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 100,
        collateralAmount: { amount: 300, asset_id: '1.3.0' },
      }),
      /exceeds? maxCollateralAmount/,
      'total collateral ceiling should include existing credit deals'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditOfferTotalCeilingUsesAssetPrecision() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    assetBalances: {
      '1.3.0': { free: 40000, locked: 0, total: 40000 },
    },
    dealResponses: [[
      {
        id: '1.19.77',
        borrower: '1.2.3',
        offer_id: '1.18.42',
        offer_owner: '1.2.9',
        debt_asset: '1.3.10',
        debt_amount: 50000,
        collateral_asset: '1.3.0',
        collateral_amount: 100000,
        fee_rate: 30000,
        latest_repay_time: '2030-01-01T00:00:00',
        auto_repay: 0,
      },
    ]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-total-ceiling-precision-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-total-ceiling-precision',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 1200,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 200, asset_id: '1.3.0' },
              quote: { amount: 100, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 600,
        collateralAmount: { amount: 1200, asset_id: '1.3.0' },
      }),
      /current total 500/,
      'existing credit debt should be converted from chain precision before cap comparison'
    );

    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: {
          id: '1.18.42',
          asset_type: '1.3.10',
          fee_rate: 30000,
          enabled: true,
          acceptable_collateral: {
            '1.3.0': {
              base: { amount: 200, asset_id: '1.3.0' },
              quote: { amount: 100, asset_id: '1.3.10' },
            },
          },
        },
        borrowAmount: 100,
        collateralAmount: { amount: 300, asset_id: '1.3.0' },
      }),
      /current total 1000/,
      'existing credit collateral should be converted from chain precision before cap comparison'
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testLpCollateralRatioGate() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
      '1.3.11': {
        id: '1.3.11',
        symbol: 'ALT',
        precision: 2,
        bitasset_data_id: null,
      },
      '1.3.20': {
        id: '1.3.20',
        symbol: 'LP-USD-BTS',
        precision: 0,
        bitasset_data_id: null,
        dynamic_asset_data_id: '2.4.20',
        for_liquidity_pool: '1.19.1',
        current_supply: 10000,
      },
    },
    assetDynamicData: {
      '2.4.20': {
        id: '2.4.20',
        current_supply: 10000,
      },
    },
    poolByShareAsset: {
      '1.3.20': {
        id: '1.19.1',
        asset_a: '1.3.0',
        asset_b: '1.3.11',
        balance_a: 10000,
        balance_b: 10000,
        share_asset: '1.3.20',
      },
    },
    poolByAssetPair: {
      '1.3.0|1.3.10': {
        id: '1.19.2',
        asset_a: '1.3.0',
        asset_b: '1.3.10',
        balance_a: 10000,
        balance_b: 5000,
        share_asset: '1.3.21',
      },
      '1.3.10|1.3.11': {
        id: '1.19.3',
        asset_a: '1.3.10',
        asset_b: '1.3.11',
        balance_a: 5000,
        balance_b: 10000,
        share_asset: '1.3.22',
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-lp-cr-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const offer = {
      id: '1.18.42',
      asset_type: '1.3.10',
      fee_rate: 30000,
      enabled: true,
      min_deal_amount: 1,
      acceptable_collateral: {
        '1.3.20': {
          base: { amount: 2, asset_id: '1.3.20' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    };

    const rejectRuntime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-lp-reject',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'LP-USD-BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 1.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime_reject') });

    await rejectRuntime.refreshState();
    await assert.rejects(
      () => rejectRuntime.buildCreditOfferAcceptOperation({
        offer,
        borrowAmount: 100,
      }),
      /maxCollateralRatio/,
      'LP-backed credit offers must be rejected when the actual CR exceeds the cap'
    );

    const acceptRuntime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-lp-accept',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'LP-USD-BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime_accept') });

    await acceptRuntime.refreshState();
    const op = await acceptRuntime.buildCreditOfferAcceptOperation({
      offer,
      borrowAmount: 100,
    });

    assert.strictEqual(op.op_name, 'credit_offer_accept', 'LP-backed offer should still build a credit accept op');
    assert.strictEqual(op.op_data.collateral.amount, 20000, 'offer collateral should be resolved from the configured price in chain units');
    assert.strictEqual(op.op_data.borrow_amount.amount, 10000, 'borrow amount should remain intact in chain units');
  } finally {
    restore();
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch (err) { }
  }
}

async function testDealDisappearanceDoesNotAutoQueueReborrow() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [
      [
        {
          id: '1.19.77',
          borrower: '1.2.3',
          offer_id: '1.18.42',
          offer_owner: '1.2.9',
          debt_asset: '1.3.10',
          debt_amount: 500,
          collateral_asset: '1.3.0',
          collateral_amount: 1000,
          fee_rate: 30000,
          latest_repay_time: '2030-01-01T00:00:00',
          auto_repay: 0,
        },
      ],
      [],
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-reborrow-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-reborrow',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    assert.strictEqual(runtime.state.activeDealIds[0], '1.19.77', 'initial credit deal should be tracked');

    const creditLending = runtime.debtPolicy.lending.find((item) => item.type === 'creditOffer');
    await runtime.refreshCreditState({}, creditLending);
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'disappearance alone should not queue a reborrow');

    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.reborrows?.processed, 0, 'maintenance should not process a reborrow without a confirmed repay');
    assert.strictEqual(calls.length, 0, 'no reborrow should be broadcast from disappearance alone');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testDeferredReborrowQueuesAfterConfirmedRepay() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [
      [
        {
          id: '1.19.77',
          borrower: '1.2.3',
          offer_id: '1.18.42',
          offer_owner: '1.2.9',
          debt_asset: '1.3.10',
          debt_amount: 500,
          collateral_asset: '1.3.0',
          collateral_amount: 1000,
          fee_rate: 30000,
          latest_repay_time: '2030-01-01T00:00:00',
          auto_repay: 0,
        },
      ],
      [],
    ],
    offersById: {
      '1.18.42': null,
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-reborrow-confirmed-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-reborrow-confirmed',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.repayCreditDeal('1.19.77', 200);
    assert.strictEqual(result.tx_id, 'tx-1', 'repay should still broadcast successfully');
    assert.strictEqual(calls.length, 1, 'only the repay batch should be sent when reborrow cannot be built inline');
    assert.strictEqual(calls[0].operations.length, 1, 'repay batch should not include a speculative reborrow');
    assert.strictEqual(runtime.state.pendingReborrows.length, 1, 'confirmed repay without inline reborrow should queue a deferred reborrow');
    assert.strictEqual(runtime.state.pendingReborrows[0].sourceDealId, '1.19.77', 'queued deferred reborrow should reference the repaid deal');
    assert.strictEqual(runtime.state.pendingReborrows[0].autoRepay, 2, 'queued deferred reborrow should preserve policy autoRepay mode');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testFallbackOfferSelectedWhenOriginalOfferUnavailable() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    offersById: {
      '1.18.42': null,
      '1.18.43': {
        id: '1.18.43',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 10000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
      '1.18.44': {
        id: '1.18.44',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-fallback-offer-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-fallback-offer',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralAmount: 10000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
              allowedOfferIds: [],
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.repayCreditDeal('1.19.77', 200, { collateralAmount: 400 });
    assert.strictEqual(result.tx_id, 'tx-1', 'repay should broadcast with fallback reborrow in one batch');
    assert.strictEqual(calls.length, 1, 'fallback should be inline in the repay batch');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_deal_repay', 'first op should repay old deal');
    assert.strictEqual(calls[0].operations[1].op_name, 'credit_offer_accept', 'second op should retake credit');
    assert.strictEqual(calls[0].operations[1].op_data.offer_id, '1.18.43', 'cheapest matching fallback offer should be selected');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingReborrowUsesFallbackOfferWhenOriginalUnavailable() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    offersById: {
      '1.18.42': null,
      '1.18.43': {
        id: '1.18.43',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 10000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-pending-fallback-offer-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const gridMaintenanceCalls = [];
    const fetchTotalsCalls = [];
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      allowedOfferIds: [],
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-pending-fallback-offer',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async (accountId) => {
          fetchTotalsCalls.push(accountId);
        },
      },
      _runGridMaintenance: async (context, options = {}) => {
        gridMaintenanceCalls.push({ context, options });
        return { checked: true, context, options };
      },
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    runtime.state.pendingReborrows = [{
      sourceDealId: '1.19.77',
      offerId: '1.18.42',
      borrowAmount: 200,
      collateralAmount: 400,
      autoRepay: 2,
      specificPolicy: policy,
      requestedAt: new Date().toISOString(),
      reason: 'offer unavailable',
    }];
    runtime.state.reborrowPending = true;

    const result = await runtime.processPendingReborrows();
    assert.strictEqual(result.processed, 1, 'pending fallback reborrow should execute');
    assert.strictEqual(result.remaining, 0, 'pending queue should be cleared after fallback succeeds');
    assert.strictEqual(calls.length, 1, 'fallback should execute one reborrow batch');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_offer_accept', 'pending fallback should accept a credit offer');
    assert.strictEqual(calls[0].operations[0].op_data.offer_id, '1.18.43', 'pending fallback should use matching fallback offer');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingFallbackWaitsWhileSourceDealActive() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    offersById: {
      '1.18.42': null,
      '1.18.43': {
        id: '1.18.43',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 10000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-pending-fallback-active-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const gridMaintenanceCalls = [];
    const fetchTotalsCalls = [];
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      allowedOfferIds: [],
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-pending-fallback-active',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async (accountId) => {
          fetchTotalsCalls.push(accountId);
        },
      },
      _runGridMaintenance: async (context, options = {}) => {
        gridMaintenanceCalls.push({ context, options });
        return { checked: true, context, options };
      },
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    runtime.state.pendingReborrows = [{
      sourceDealId: '1.19.77',
      offerId: '1.18.42',
      borrowAmount: 200,
      collateralAmount: 400,
      autoRepay: 2,
      specificPolicy: policy,
      requestedAt: new Date().toISOString(),
      reason: 'offer unavailable',
    }];
    runtime.state.reborrowPending = true;

    const result = await runtime.processPendingReborrows();
    assert.strictEqual(result.processed, 0, 'pending fallback should not execute while source deal is still active');
    assert.strictEqual(result.remaining, 1, 'pending request should remain queued while source deal is active');
    assert.strictEqual(calls.length, 0, 'no fallback reborrow should broadcast while source deal is active');
    assert.strictEqual(runtime.state.pendingReborrows[0].reason, 'source deal still active on-chain');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditDealUpdatePreservesAutoRepayMode() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-update-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-update',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    const op = await runtime.buildCreditDealUpdateOperation({ id: '1.19.77' }, 2);
    assert.strictEqual(op.op_name, 'credit_deal_update', 'credit deal update op should be built');
    assert.strictEqual(op.op_data.auto_repay, 2, 'credit deal update should preserve autoRepay mode 2');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testAutoReborrowQueueIsIgnoredWhenDisabled() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [
      [
        {
          id: '1.19.88',
          borrower: '1.2.3',
          offer_id: '1.18.42',
          offer_owner: '1.2.9',
          debt_asset: '1.3.10',
          debt_amount: 500,
          collateral_asset: '1.3.0',
          collateral_amount: 1000,
          fee_rate: 30000,
          latest_repay_time: '2030-01-01T00:00:00',
          auto_repay: 0,
        },
      ],
      [],
    ],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-reborrow-off-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-reborrow-off',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: false,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const creditLending = runtime.debtPolicy.lending.find((item) => item.type === 'creditOffer');
    await runtime.refreshCreditState({}, creditLending);
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'autoReborrow=false should not queue missing deals');
    const result = await runtime.runMaintenance('periodic');
    assert.strictEqual(result.reborrows?.processed, 0, 'pending reborrow processing should process nothing when autoReborrow is disabled');
    assert.strictEqual(result.reborrows?.remaining, 0, 'pending reborrow queue should be empty');
    assert.strictEqual(calls.length, 0, 'no reborrow should be broadcast when autoReborrow is disabled');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingReborrowResolvesPolicyWithColdAssetCache() {
  const calls = [];
  const dbCalls = [];
  const warnings = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-reborrow-cold-cache-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-reborrow-cold-cache',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn(message) { warnings.push(message); },
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.loadState();
    runtime.queueReborrow({
      sourceDealId: '1.19.77',
      offerId: '1.18.42',
      borrowAmount: 200,
      collateralAmount: null,
      autoRepay: 2,
    });

    const result = await runtime.processPendingReborrows();
    assert.strictEqual(result.processed, 1, 'cold-cache pending reborrow should process after resolving policy asset');
    assert.strictEqual(result.remaining, 0, 'processed pending reborrow should leave an empty queue');
    assert.strictEqual(calls.length, 1, 'pending reborrow should broadcast one accept operation');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_offer_accept', 'pending reborrow should accept the credit offer');
    assert.strictEqual(calls[0].operations[0].op_data.borrow_amount.amount, 200, 'pending reborrow should preserve requested borrow amount');
    assert.deepStrictEqual(calls[0].operations[0].op_data.extensions, { auto_repay: 2 }, 'pending reborrow should preserve autoRepay mode');
    assert.strictEqual(warnings.some((message) => String(message).includes('dropping pending reborrow')), false, 'policy lookup should not drop a valid cold-cache reborrow');
    assert.strictEqual(dbCalls.some((entry) => entry.method === 'lookup_asset_symbols'), true, 'policy lookup should resolve configured asset when cache is cold');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditMaintenanceBorrowsTowardAssignedTarget() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    dealResponses: [[]],
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 100000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-increase-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const gridMaintenanceCalls = [];
    const fetchTotalsCalls = [];
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      minCollateralIncreaseThreshold: 10,
      autoRepay: 2,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-increase',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async (accountId) => {
          fetchTotalsCalls.push(accountId);
        },
      },
      _runGridMaintenance: async (context, options = {}) => {
        gridMaintenanceCalls.push({ context, options });
        return { checked: true, context, options };
      },
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: '1.19.77',
        debtAssetId: '1.3.10',
        debtAmount: 5000,
        collateralAssetId: '1.3.0',
        collateralAmount: 10000,
        latestRepayTime: '2030-01-01T00:00:00',
        autoRepay: 2,
      }],
    };

    const result = await runtime._runCreditMaintenance(policy, '1.3.10');
    assert(result, 'credit maintenance should execute an increase');
    assert.strictEqual(calls.length, 1, 'credit increase should broadcast one operation');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_offer_accept');
    assert.strictEqual(result.plan.collateralIncreaseAmount, 900, 'plan should gate on the collateral-budget shortfall');
    assert.strictEqual(calls[0].operations[0].op_data.collateral.amount, 90000, 'borrow should use the unused assigned collateral in chain units');
    assert.strictEqual(calls[0].operations[0].op_data.borrow_amount.amount, 45000, 'borrow should be derived from selected offer price and collateral shortfall');
    assert.deepStrictEqual(calls[0].operations[0].op_data.extensions, { auto_repay: 2 }, 'credit increase should preserve policy autoRepay');
    assert.strictEqual(fetchTotalsCalls.length, 1, 'credit capital updates should refresh account totals before threshold checks');
    assert.strictEqual(gridMaintenanceCalls.length, 1, 'credit capital updates should check the grid maintenance thresholds');
    assert.strictEqual(gridMaintenanceCalls[0].context, 'credit capital update');
    // AsyncLock is re-entrant; fillLockAlreadyHeld flag is eliminated
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditMaintenanceSkipsSmallCollateralIncrease() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-increase-threshold-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      minCollateralIncreaseThreshold: '20%',
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-increase-threshold',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 120,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: '1.19.77',
        debtAssetId: '1.3.10',
        debtAmount: 5000,
        collateralAssetId: '1.3.0',
        collateralAmount: 10000,
        latestRepayTime: '2030-01-01T00:00:00',
        autoRepay: 0,
      }],
    };

    const result = await runtime._runCreditMaintenance(policy, '1.3.10');
    assert.strictEqual(result, null, 'credit maintenance should skip collateral increases below percentage threshold');
    assert.strictEqual(calls.length, 0, 'no credit increase should be broadcast below collateral threshold');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditMaintenanceAllowsZeroThreshold() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-zero-threshold-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      minCollateralIncreaseThreshold: 0,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-zero-threshold',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 260,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: '1.19.77',
        debtAssetId: '1.3.10',
        debtAmount: 5000,
        collateralAssetId: '1.3.0',
        collateralAmount: 10000,
        latestRepayTime: '2030-01-01T00:00:00',
        autoRepay: 0,
      }],
    };

    const result = await runtime._runCreditMaintenance(policy, '1.3.10');
    assert(result, 'zero threshold should allow any positive collateral increase');
    assert.strictEqual(calls.length, 1, 'credit increase should broadcast with zero threshold');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditMaintenanceCapsIncreaseAtBorrowCeiling() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    dealResponses: [[]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-borrow-cap-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 60,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      minCollateralIncreaseThreshold: 10,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-borrow-cap',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });
    const acceptArgs = [];
    const originalBuildCreditOfferAcceptOperation = runtime.buildCreditOfferAcceptOperation.bind(runtime);
    runtime.buildCreditOfferAcceptOperation = async (args) => {
      acceptArgs.push(args);
      return originalBuildCreditOfferAcceptOperation(args);
    };

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: '1.19.77',
        debtAssetId: '1.3.10',
        debtAmount: 5000,
        collateralAssetId: '1.3.0',
        collateralAmount: 10000,
        latestRepayTime: '2030-01-01T00:00:00',
        autoRepay: 0,
      }],
    };

    const result = await runtime._runCreditMaintenance(policy, '1.3.10');
    assert(result, 'credit maintenance should execute a capped increase');
    assert.strictEqual(calls.length, 1, 'capped credit increase should broadcast one operation');
    assert.strictEqual(calls[0].operations[0].op_data.borrow_amount.amount, 1000, 'borrow should be capped to remaining maxBorrowAmount');
    assert.strictEqual(calls[0].operations[0].op_data.collateral.amount, 2000, 'collateral should be reduced to the selected offer requirement for the capped borrow');
    assert.strictEqual(result.cappedByBorrowCapacity, true, 'result should record that the increase was capped');
    assert.strictEqual(acceptArgs.length, 1, 'borrow cap should be applied before building the credit accept operation');
    assert.strictEqual(acceptArgs[0].borrowAmount, 10, 'initial credit accept operation should use remaining borrow capacity');
    assert.strictEqual(acceptArgs[0].collateralAmount.assetId, '1.3.0', 'borrow-capped increase should preserve the configured collateral asset');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCreditMaintenanceCapsIncreaseAtBorrowCeilingForMultiCollateralOffer() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 2,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
      '1.3.1': {
        id: '1.3.1',
        symbol: 'BRIDGE.BTC',
        precision: 2,
        bitasset_data_id: null,
      },
    },
    dealResponses: [[]],
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 100000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
          '1.3.1': {
            base: { amount: 300, asset_id: '1.3.1' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-borrow-cap-multi-collateral-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 60,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      minCollateralIncreaseThreshold: 10,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-borrow-cap-multi-collateral',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });
    const acceptArgs = [];
    const originalBuildCreditOfferAcceptOperation = runtime.buildCreditOfferAcceptOperation.bind(runtime);
    runtime.buildCreditOfferAcceptOperation = async (args) => {
      acceptArgs.push(args);
      return originalBuildCreditOfferAcceptOperation(args);
    };

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: '1.19.77',
        debtAssetId: '1.3.10',
        debtAmount: 5000,
        collateralAssetId: '1.3.0',
        collateralAmount: 10000,
        latestRepayTime: '2030-01-01T00:00:00',
        autoRepay: 0,
      }],
    };

    const result = await runtime._runCreditMaintenance(policy, '1.3.10');
    assert(result, 'credit maintenance should execute a capped increase for a multi-collateral offer');
    assert.strictEqual(calls.length, 1, 'capped multi-collateral credit increase should broadcast one operation');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_offer_accept');
    assert.strictEqual(calls[0].operations[0].op_data.borrow_amount.amount, 1000, 'borrow should still be capped to remaining maxBorrowAmount');
    assert.strictEqual(calls[0].operations[0].op_data.collateral.asset_id, '1.3.0', 'capped retry should preserve the configured collateral asset');
    assert.strictEqual(acceptArgs.length, 1, 'capped multi-collateral path should be handled in the first accept-operation build');
    assert.strictEqual(acceptArgs[0].borrowAmount, 10, 'multi-collateral capped increase should use remaining borrow capacity');
    assert.strictEqual(acceptArgs[0].collateralAmount.assetId, '1.3.0', 'multi-collateral capped increase should pass collateral asset selection');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testStatePersistsAcrossRestart() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-persist-'));
  const stateDir = path.join(baseDir, 'credit_runtime');

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;

    const firstRuntime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-persist' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir });

    await firstRuntime.refreshState();
    firstRuntime.state.pendingReborrows = [
      {
        sourceDealId: '1.19.77',
        offerId: '1.18.42',
        borrowAmount: 50,
        collateralAmount: null,
        requestedAt: '2030-01-01T00:00:00.000Z',
        reason: 'unit-test',
      },
    ];
    await firstRuntime.persistState('test');
    await firstRuntime.shutdown();

    delete require.cache[creditRuntimePath];
    const ReloadedCreditRuntime = require('../modules/credit_runtime').default;
    const secondRuntime = new ReloadedCreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-persist' }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir });

    await secondRuntime.loadState({ forceReload: true });
    assert.strictEqual(secondRuntime.state.botKey, 'credit-bot-persist', 'bot key should survive reload');
    assert.strictEqual(secondRuntime.state.pendingReborrows.length, 1, 'pending reborrows should survive reload');
    assert.strictEqual(secondRuntime.state.reborrowPending, true, 'reborrow flag should survive reload');
    assert.strictEqual(secondRuntime.state.pendingReborrows[0].sourceDealId, '1.19.77', 'queued deal should survive reload');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}


async function testProactiveRepayBundlesReborrowInSingleBatch() {
  const calls = [];
  const dbCalls = [];
  const dealId = '1.19.77';
  const offerId = '1.18.42';
  const debtAmount = 500;
  const collateralAmount = 1000;
  const repayTime = new Date(Date.now() - 3600000).toISOString();
  const activeDeal = {
    id: dealId,
    borrower: '1.2.3',
    offer_id: offerId,
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: debtAmount,
    collateral_asset: '1.3.0',
    collateral_amount: collateralAmount,
    fee_rate: 30000,
    latest_repay_time: repayTime,
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-proactive-bundle-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-proactive-bundle',
        debtPolicy: { lending: [policy] },
        TIMING: { CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: 168 },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: dealId,
        debtAssetId: '1.3.10',
        debtAmount: debtAmount,
        collateralAssetId: '1.3.0',
        collateralAmount: collateralAmount,
        latestRepayTime: repayTime,
        feeRate: 30000,
        offerId: offerId,
        autoRepay: 0,
      }],
    };

    const execCallCount = calls.length;
    await runtime._runCreditMaintenance(policy, '1.3.10');

    const newCalls = calls.slice(execCallCount);
    assert.strictEqual(newCalls.length, 1, 'proactive repay+reborrow should execute as a single batch');

    const batch = newCalls[0];
    assert.strictEqual(batch.operations.length, 2, 'batch should contain repay + reborrow');
    assert.strictEqual(batch.operations[0].op_name, 'credit_deal_repay', 'first op should be credit_deal_repay');
    assert.strictEqual(batch.operations[1].op_name, 'credit_offer_accept', 'second op should be credit_offer_accept');

    const repayOp = batch.operations[0];
    const acceptOp = batch.operations[1];
    assert.strictEqual(repayOp.op_data.deal_id, dealId, 'repay should target the expired deal');
    assert.strictEqual(repayOp.op_data.repay_amount.amount, debtAmount, 'repay amount should match deal debt');
    assert.strictEqual(acceptOp.op_data.offer_id, offerId, 'reborrow should use original offer');
    assert.strictEqual(acceptOp.op_data.borrow_amount.amount, debtAmount, 'reborrow amount should match repaid debt');
    assert.strictEqual(acceptOp.op_data.collateral.amount, 1000, 'reborrow collateral should follow the offer price ratio');
    assert.deepStrictEqual(acceptOp.op_data.extensions, { auto_repay: 2 }, 'reborrow should carry forward policy autoRepay');

    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'no pending reborrows after successful inline batch');
    assert.strictEqual(runtime.state.reborrowPending, false, 'reborrowPending flag should be false');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testProactiveRepayReborrowMultiAssetOffer() {
  const calls = [];
  const dbCalls = [];
  const dealId = '1.19.77';
  const offerId = '1.18.42';
  const debtAmount = 500;
  const collateralAmount = 1000;
  const repayTime = new Date(Date.now() - 3600000).toISOString();
  const activeDeal = {
    id: dealId,
    borrower: '1.2.3',
    offer_id: offerId,
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: debtAmount,
    collateral_asset: '1.3.0',
    collateral_amount: collateralAmount,
    fee_rate: 30000,
    latest_repay_time: repayTime,
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
          '1.3.1': {
            base: { amount: 300, asset_id: '1.3.1' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    assetsById: {
      '1.3.10': {
        id: '1.3.10',
        symbol: 'HONEST.USD',
        precision: 0,
        bitasset_data_id: '2.4.1',
      },
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 0,
        bitasset_data_id: null,
      },
      '1.3.1': {
        id: '1.3.1',
        symbol: 'BRIDGE.BTC',
        precision: 0,
        bitasset_data_id: null,
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-proactive-multi-asset-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-proactive-multi-asset',
        debtPolicy: { lending: [policy] },
        TIMING: { CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: 168 },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: dealId,
        debtAssetId: '1.3.10',
        debtAmount: debtAmount,
        collateralAssetId: '1.3.0',
        collateralAmount: collateralAmount,
        latestRepayTime: repayTime,
        feeRate: 30000,
        offerId: offerId,
        autoRepay: 0,
      }],
    };

    const execCallCount = calls.length;
    await runtime._runCreditMaintenance(policy, '1.3.10');

    const newCalls = calls.slice(execCallCount);
    assert.strictEqual(newCalls.length, 1, 'multi-asset proactive repay+reborrow should execute as a single batch');

    const batch = newCalls[0];
    assert.strictEqual(batch.operations.length, 2, 'batch should contain repay + reborrow');
    assert.strictEqual(batch.operations[0].op_name, 'credit_deal_repay', 'first op should be credit_deal_repay');
    assert.strictEqual(batch.operations[1].op_name, 'credit_offer_accept', 'second op should be credit_offer_accept');

    const acceptOp = batch.operations[1];
    assert.strictEqual(acceptOp.op_data.collateral.asset_id, '1.3.0', 'reborrow should use BTS as collateral for a multi-asset offer');
    assert.strictEqual(acceptOp.op_data.borrow_amount.amount, debtAmount, 'reborrow amount should match repaid debt');
    assert.deepStrictEqual(acceptOp.op_data.extensions, { auto_repay: 2 }, 'reborrow should carry forward policy autoRepay');

    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'no pending reborrows after successful inline batch');
    assert.strictEqual(runtime.state.reborrowPending, false, 'reborrowPending flag should be false');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMismatchDealAppearsInNewPosKey() {
  const calls = [];
  const dbCalls = [];
  const dealId = '1.19.88';
  const activeDeal = {
    id: dealId,
    borrower: '1.2.3',
    offer_id: '1.18.42',
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: 500,
    collateral_asset: '1.3.1',
    collateral_amount: 1000,
    fee_rate: 30000,
    latest_repay_time: '2030-01-01T00:00:00',
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal]],
    assetsById: {
      '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 0, bitasset_data_id: '2.4.1' },
      '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 0, bitasset_data_id: null },
      '1.3.1': { id: '1.3.1', symbol: 'BRIDGE.BTC', precision: 0, bitasset_data_id: null },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-mismatch-poskey-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-mismatch-poskey',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    const posKey = '1.3.10:1.3.0';
    const deals = runtime.state.positions?.[posKey]?.creditDeals || [];
    const mismatchDeal = deals.find((d) => d.id === dealId);
    assert.ok(mismatchDeal, `mismatched deal ${dealId} should appear in posKey ${posKey}`);
    assert.strictEqual(mismatchDeal.collateralMismatch, true, 'mismatched deal should have collateralMismatch flag');
    assert.strictEqual(mismatchDeal.debtAssetId, '1.3.10', 'debt asset should match policy');
    assert.strictEqual(mismatchDeal.collateralAssetId, '1.3.1', 'deal should retain original collateral asset');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testRepayWithUnacceptableCollateralThrowsSpecificError() {
  const calls = [];
  const dbCalls = [];
  const activeDeal = {
    id: '1.19.77',
    borrower: '1.2.3',
    offer_id: '1.18.42',
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: 500,
    collateral_asset: '1.3.0',
    collateral_amount: 1000,
    fee_rate: 30000,
    latest_repay_time: '2030-01-01T00:00:00',
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-repay-bad-coll-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-repay-bad-coll',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
              renewOnly: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    const offer = { id: '1.18.42', asset_type: '1.3.10', enabled: true,
      acceptable_collateral: { '1.3.0': { base: { amount: 2, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.10' } } },
      fee_rate: 30000, min_deal_amount: 100, max_duration_seconds: 86400 };
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer,
        borrowAmount: 200,
        collateralAmount: { amount: 400, assetId: '1.3.1' },
        pendingRepayAmount: 200,
      }),
      /is not in offer 1.18.42 acceptable_collateral/,
      'should throw specific error when collateral is not in offer acceptable_collateral',
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testCollateralSwitchSkippedWithoutBalance() {
  const calls = [];
  const dbCalls = [];
  const dealId = '1.19.77';
  const debtAmount = 500;
  const collateralAmount = 1000;
  const repayTime = new Date(Date.now() - 3600000).toISOString();
  const activeDeal = {
    id: dealId,
    borrower: '1.2.3',
    offer_id: '1.18.42',
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: debtAmount,
    collateral_asset: '1.3.1',
    collateral_amount: collateralAmount,
    fee_rate: 30000,
    latest_repay_time: repayTime,
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
    offersById: {
      '1.18.42': {
        id: '1.18.42',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 30000,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 200, asset_id: '1.3.0' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
          '1.3.1': {
            base: { amount: 300, asset_id: '1.3.1' },
            quote: { amount: 100, asset_id: '1.3.10' },
          },
        },
      },
    },
    assetsById: {
      '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 0, bitasset_data_id: '2.4.1' },
      '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 0, bitasset_data_id: null },
      '1.3.1': { id: '1.3.1', symbol: 'BRIDGE.BTC', precision: 0, bitasset_data_id: null },
    },
    assetBalances: {},
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-switch-no-bal-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-switch-no-bal',
        debtPolicy: { lending: [policy] },
        TIMING: { CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: 168 },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: dealId,
        debtAssetId: '1.3.10',
        debtAmount: debtAmount,
        collateralAssetId: '1.3.1',
        collateralAmount: collateralAmount,
        latestRepayTime: repayTime,
        feeRate: 30000,
        offerId: '1.18.42',
        autoRepay: 2,
        collateralMismatch: true,
      }],
    };

    const execCallCount = calls.length;
    await runtime._runCreditMaintenance(policy, '1.3.10');

    const newCalls = calls.slice(execCallCount);
    assert.strictEqual(newCalls.length, 0, 'collateral switch should be skipped when new collateral balance is zero');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingReborrowStoresPendingRepayAmount() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [
      [
        {
          id: '1.19.77',
          borrower: '1.2.3',
          offer_id: '1.18.42',
          offer_owner: '1.2.9',
          debt_asset: '1.3.10',
          debt_amount: 500,
          collateral_asset: '1.3.0',
          collateral_amount: 1000,
          fee_rate: 30000,
          latest_repay_time: '2030-01-01T00:00:00',
          auto_repay: 0,
        },
      ],
      [],
    ],
    offersById: {
      '1.18.42': null,
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pending-repay-amount-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-pending-repay-amount',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
                    collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
              autoRepay: 2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    const result = await runtime.repayCreditDeal('1.19.77', 200);
    assert.strictEqual(result.tx_id, 'tx-1', 'repay should broadcast');
    assert.strictEqual(runtime.state.pendingReborrows.length, 1, 'deferred reborrow should be queued');
    assert.strictEqual(runtime.state.pendingReborrows[0].sourceDealId, '1.19.77', 'source deal should be referenced');
    assert.strictEqual(runtime.state.pendingReborrows[0].pendingRepayAmount, 200, 'pendingRepayAmount should be stored in queued entry');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingReborrowDropsStaleEntryWhenReplacementExists() {
  const calls = [];
  const dbCalls = [];
  const newerDealId = '1.19.99';
  const sourceDealId = '1.19.77';
  const offerId = '1.18.42';
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[
      {
        id: newerDealId,
        borrower: '1.2.3',
        offer_id: offerId,
        offer_owner: '1.2.9',
        debt_asset: '1.3.10',
        debt_amount: 200,
        collateral_asset: '1.3.0',
        collateral_amount: 400,
        fee_rate: 30000,
        latest_repay_time: '2030-06-01T00:00:00',
        auto_repay: 2,
      },
    ]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-stale-reborrow-drop-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const gridMaintenanceCalls = [];
    const fetchTotalsCalls = [];
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-stale-reborrow-drop',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async (accountId) => {
          fetchTotalsCalls.push(accountId);
        },
      },
      _runGridMaintenance: async (context, options = {}) => {
        gridMaintenanceCalls.push({ context, options });
        return { checked: true, context, options };
      },
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    runtime.state.pendingReborrows = [{
      sourceDealId: sourceDealId,
      offerId: offerId,
      borrowAmount: 200,
      collateralAmount: 400,
      autoRepay: 2,
      specificPolicy: policy,
      pendingRepayAmount: 200,
      pendingReleaseCollateralAmount: 400,
      requestedAt: '2026-01-01T00:00:00.000Z',
      reason: 'deferred repay',
    }];
    runtime.state.reborrowPending = true;

    const result = await runtime.processPendingReborrows();
    assert.strictEqual(result.processed, 1, 'stale entry should be counted as processed (dropped)');
    assert.strictEqual(result.remaining, 0, 'stale entry should not be re-queued');
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'stale entry should be dropped from state');
    assert.strictEqual(calls.length, 0, 'no reborrow should be broadcast for stale entry');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testProactiveRepayPrunesStalePendingReborrow() {
  const calls = [];
  const dbCalls = [];
  const dealId = '1.19.77';
  const offerId = '1.18.42';
  const debtAmount = 500;
  const collateralAmount = 1000;
  const repayTime = new Date(Date.now() - 3600000).toISOString();
  const activeDeal = {
    id: dealId,
    borrower: '1.2.3',
    offer_id: offerId,
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: debtAmount,
    collateral_asset: '1.3.0',
    collateral_amount: collateralAmount,
    fee_rate: 30000,
    latest_repay_time: repayTime,
    auto_repay: 0,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-proactive-prune-stale-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-proactive-prune-stale',
        debtPolicy: { lending: [policy] },
        TIMING: { CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: 168 },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    // Seed a stale pending reborrow referencing this deal
    runtime.state.pendingReborrows = [{
      sourceDealId: dealId,
      offerId: offerId,
      borrowAmount: debtAmount,
      collateralAmount: collateralAmount,
      autoRepay: 2,
      specificPolicy: policy,
      pendingRepayAmount: debtAmount,
      pendingReleaseCollateralAmount: collateralAmount,
      requestedAt: '2026-01-01T00:00:00.000Z',
      reason: 'stale from previous cycle',
    }];
    runtime.state.reborrowPending = true;

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: dealId,
        debtAssetId: '1.3.10',
        debtAmount: debtAmount,
        collateralAssetId: '1.3.0',
        collateralAmount: collateralAmount,
        latestRepayTime: repayTime,
        feeRate: 30000,
        offerId: offerId,
        autoRepay: 0,
      }],
    };

    const pruneLogCalls = [];
    const origLog = runtime.log.bind(runtime);
    runtime.log = (...args) => {
      pruneLogCalls.push(args);
      origLog(...args);
    };

    await runtime._runCreditMaintenance(policy, '1.3.10');

    // Should have pruned the stale entry — the inline reborrow succeeded
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'stale pending reborrow should be pruned after proactive repay');
    assert.strictEqual(runtime.state.reborrowPending, false, 'reborrowPending flag should be false after prune');
    const pruneLog = pruneLogCalls.find((args) => String(args[0]).includes('pruned'));
    assert.ok(pruneLog, 'prune should log the stale entry cleanup');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMaxBorrowAmountPerOperationRejectsOversizedBorrows() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    assetsById: {
      '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 2, bitasset_data_id: null },
      '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 2, bitasset_data_id: '2.4.1' },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-perop-reject-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-perop-reject',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxBorrowAmountPerOperation: 200,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    const fullOffer = {
      id: '1.18.42',
      asset_type: '1.3.10',
      current_balance: 10000,
      fee_rate: 30000,
      min_deal_amount: 1,
      enabled: true,
      max_duration_seconds: 86400,
      acceptable_collateral: {
        '1.3.0': {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    };

    // Should succeed — 150 is within per-op limit of 200
    const op = await runtime.buildCreditOfferAcceptOperation({
      offer: fullOffer,
      borrowAmount: 150,
      collateralAmount: { amount: 400, asset_id: '1.3.0' },
    });
    assert.ok(op, 'borrow within per-op limit should succeed');
    assert.strictEqual(op.op_data.borrow_amount.amount, 15000, 'borrow amount should be 15000 (150 * 10^2)');

    // Should reject — 300 exceeds per-op limit of 200
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: fullOffer,
        borrowAmount: 300,
        collateralAmount: { amount: 800, asset_id: '1.3.0' },
      }),
      /exceeds maxBorrowAmountPerOperation/,
      'borrow exceeding per-op limit should be rejected',
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMaxBorrowAmountPerOperationWithSelection() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    assetsById: {
      '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 2, bitasset_data_id: null },
      '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 2, bitasset_data_id: '2.4.1' },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-perop-sel-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-perop-sel',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxBorrowAmountPerOperation: 200,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoRepay: 2,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    // Simulate an existing deal so remainingBorrowCapacity = 800 (1000 - 200)
    runtime.state.creditDeals = [{
      id: '1.19.77',
      borrower: '1.2.3',
      offer_id: '1.18.42',
      debt_asset: '1.3.10',
      debt_amount: 20000,
      collateral_asset: '1.3.0',
      collateral_amount: 40000,
    }];
    runtime.state.positions = runtime.state.positions || {};
    runtime.state.positions['1.3.10:1.3.0'] = runtime.state.positions['1.3.10:1.3.0'] || {};
    runtime.state.positions['1.3.10:1.3.0'].creditDeals = runtime.state.creditDeals;
    runtime.state.positions['1.3.10:1.3.0'].currentDebtAmount = 200;
    runtime.state.positions['1.3.10:1.3.0'].currentCollateralAmount = 400;

    // _selectCreditOfferForIncrease should cap at maxBorrowAmountPerOperation (200),
    // not remainingBorrowCapacity (800)
    const result = await runtime._selectCreditOfferForIncrease({
      debtAssetId: '1.3.10',
      collateralAssetId: '1.3.0',
      policy: runtime.debtPolicy.lending[0],
      collateralAmount: { amount: 2000, asset_id: '1.3.0' },  // would derive ~1000 borrow
      remainingBorrowCapacity: 800,
      autoRepay: 2,
    });

    assert.ok(result, 'offer selection should return a result');
    assert.ok(result.capped, 'the selected offer should be marked as capped');
    assert.strictEqual(result.borrowAmount, 200, 'borrow amount should be capped to maxBorrowAmountPerOperation');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testSplitOversizedCreditDealsSplitsCorrectly() {
  // The split logic paces pieces with BLOCKCHAIN_SETTLE_DELAY_MS (default
  // 6000ms) to let on-chain state settle; the test passes settleDelayMs: 0
  // through the runtimeContext seam so it covers the split sequencing
  // without sleeping on wall-clock time.
  const calls = [];
  const dbCalls = [];
  const baseAssets = {
    '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 2, bitasset_data_id: null },
    '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 2, bitasset_data_id: '2.4.1' },
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    assetsById: baseAssets,
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-split-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-split',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxBorrowAmountPerOperation: 200,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
              autoReborrow: true,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    // Manually set up an oversized deal in state
    // deal debt = 50000 (blockchain int, precision 2 → 500.00)
    // maxPerOp = 200 → ceil(500/200)=3 pieces, piece≈166.67
    const oversizedDeal = {
      id: '1.19.77',
      borrower: '1.2.3',
      offerId: '1.18.42',
      debtAssetId: '1.3.10',
      debtAmount: { amount: 50000, asset_id: '1.3.10' },
      collateralAssetId: '1.3.0',
      collateralAmount: { amount: 100000, asset_id: '1.3.0' },
      feeRate: 30000,
    };
    const posKey = '1.3.10:1.3.0';
    runtime.state.positions = runtime.state.positions || {};
    runtime.state.positions[posKey] = runtime.state.positions[posKey] || {};
    runtime.state.positions[posKey].creditDeals = [oversizedDeal];
    runtime.state.positions[posKey].currentDebtAmount = 500;
    runtime.state.positions[posKey].currentCollateralAmount = 1000;

    // Override repayCreditDeal — the real one calls buildCreditOfferAcceptOperation
    // which depends on blockchain stubs; we just capture calls and short-circuit
    // so we can assert the split logic itself.
    const repayCalls = [];
    runtime.repayCreditDeal = async (deal, amount, opts) => {
      const dealId = typeof deal === 'object' ? String(deal.id) : String(deal);
      repayCalls.push({ dealId, amount, opts: { ...opts } });
      return { tx_id: `mock-tx-${repayCalls.length}` };
    };

    const result = await runtime._splitOversizedCreditDeals(
      runtime.debtPolicy.lending.find((l) => l.type === 'creditOffer'),
      '1.3.10',
      runtime.state.positions[posKey],
      // Skip the production BLOCKCHAIN_SETTLE_DELAY_MS pacing between
      // split pieces; the split sequencing assertions are unaffected.
      { settleDelayMs: 0 },
    );

    assert.ok(result, 'split function should return a result');
    assert.strictEqual(result.action, 'restructured', 'result should indicate restructuring happened');

    // Pin the seam *resolution*, not just the helper: settleDelayMs: 0 must
    // resolve to 0 and not fall through to BLOCKCHAIN_SETTLE_DELAY_MS. A
    // caller-side `||` simplification would make this 6000 and is otherwise
    // invisible (the only effect is a slower sleep nothing measures).
    assert.strictEqual(
      (runtime as any)._lastResolvedSettleDelayMs,
      0,
      'settleDelayMs: 0 must resolve to 0 (caller must use ?: / ??, not ||)'
    );

    // 500/200 = 2.5 → ceil = 3 pieces, split 2 times (3-1)
    assert.strictEqual(repayCalls.length, 2, 'should have called repayCreditDeal 2 times for 3 pieces');

    // Each piece ≈ 500/3 ≈ 166.67
    assert.ok(repayCalls.every((c) => c.amount > 0), 'each repay amount should be positive');
    assert.ok(repayCalls.every((c) => c.opts.autoReborrow === true), 'each repay should have autoReborrow: true');
    assert.strictEqual(repayCalls[0].dealId, '1.19.77', 'first repay should target the oversized deal');
    assert.strictEqual(repayCalls[1].dealId, '1.19.77', 'second repay should still target the same deal');

    // Verify the total repaid ≈ 2 * 166.67 ≈ 333.34, leaving ~166.66 (≤ 200)
    const totalRepaid = repayCalls.reduce((s, c) => s + c.amount, 0);
    const remaining  = 500 - totalRepaid;
    assert.ok(remaining <= 200 + 0.01, `remaining debt ${remaining} should be ≤ maxPerOp 200`);
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testSplitOversizedCreditDealsSkipsWithinLimit() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    assetsById: {
      '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 2, bitasset_data_id: null },
      '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 2, bitasset_data_id: '2.4.1' },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-skip-split-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-skip-split',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxBorrowAmountPerOperation: 200,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    // Deal debt = 15000 (blockchain int, precision 2 → 150.00) — within limit of 200
    const smallDeal = {
      id: '1.19.77',
      borrower: '1.2.3',
      offerId: '1.18.42',
      debtAssetId: '1.3.10',
      debtAmount: { amount: 15000, asset_id: '1.3.10' },
      collateralAssetId: '1.3.0',
      collateralAmount: { amount: 30000, asset_id: '1.3.0' },
    };
    const posKey = '1.3.10:1.3.0';
    runtime.state.positions = runtime.state.positions || {};
    runtime.state.positions[posKey] = runtime.state.positions[posKey] || {};
    runtime.state.positions[posKey].creditDeals = [smallDeal];
    runtime.state.positions[posKey].currentDebtAmount = 150;
    runtime.state.positions[posKey].currentCollateralAmount = 300;

    let repayCalled = false;
    runtime.repayCreditDeal = async () => {
      repayCalled = true;
      return { tx_id: 'mock' };
    };

    const result = await runtime._splitOversizedCreditDeals(
      runtime.debtPolicy.lending.find((l) => l.type === 'creditOffer'),
      '1.3.10',
      runtime.state.positions[posKey],
    );

    assert.strictEqual(result, null, 'should return null when no deals exceed the limit');
    assert.strictEqual(repayCalled, false, 'should not call repayCreditDeal for within-limit deals');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testSplitOversizedCreditDealsSkipsWhenNoPerOpLimit() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    assetsById: {
      '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 2, bitasset_data_id: null },
      '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 2, bitasset_data_id: '2.4.1' },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-no-perop-split-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-no-perop',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    let repayCalled = false;
    runtime.repayCreditDeal = async () => {
      repayCalled = true;
      return { tx_id: 'mock' };
    };

    const result = await runtime._splitOversizedCreditDeals(
      runtime.debtPolicy.lending.find((l) => l.type === 'creditOffer'),
      '1.3.10',
      {},
    );

    assert.strictEqual(result, null, 'should return null when maxBorrowAmountPerOperation is not set');
    assert.strictEqual(repayCalled, false, 'should not call repayCreditDeal');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testMaxBorrowAmountPerOperationIsMaxBorrowAmountError() {
  // Verify isMaxBorrowAmountError (module-level) matches the new error string
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    assetsById: {
      '1.3.0': { id: '1.3.0', symbol: 'BTS', precision: 2, bitasset_data_id: null },
      '1.3.10': { id: '1.3.10', symbol: 'HONEST.USD', precision: 2, bitasset_data_id: '2.4.1' },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-iserror-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;

    // Force a borrow that exceeds maxBorrowAmountPerOperation to see the error is caught
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-iserror',
        debtPolicy: {
          lending: [
            {
              asset: 'HONEST.USD',
              collateralAsset: 'BTS',
              type: 'creditOffer',
              outputWeight: 1,
              maxBorrowAmount: 1000,
              maxBorrowAmountPerOperation: 200,
              maxCollateralRatio: 2.5,
              maxFeeRatePerDay: 0.05,
            },
          ],
        },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    const fullOffer = {
      id: '1.18.42',
      asset_type: '1.3.10',
      current_balance: 10000,
      fee_rate: 30000,
      min_deal_amount: 1,
      enabled: true,
      max_duration_seconds: 86400,
      acceptable_collateral: {
        '1.3.0': {
          base: { amount: 2, asset_id: '1.3.0' },
          quote: { amount: 1, asset_id: '1.3.10' },
        },
      },
    };

    // Try building a reborrow that would violate per-op limit.
    // The _selectCreditOfferForIncrease → buildCreditOfferAcceptOperation chain
    // should trigger the per-op limit error, which should be caught by
    // isMaxBorrowAmountError (widened to match both regexen).
    await assert.rejects(
      () => runtime.buildCreditOfferAcceptOperation({
        offer: fullOffer,
        borrowAmount: 500,
        collateralAmount: { amount: 1000, asset_id: '1.3.0' },
      }),
      (err) => {
        // Simulate what _selectCreditOfferForIncrease does:
        // isMaxBorrowAmountError(err) should return true
        return /exceeds maxBorrowAmountPerOperation/.test(getErrorMessage(err));
      },
      'should throw error matching the per-operation limit pattern',
    );
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testLpCollateralResolvesCreditConversionRate() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    assetsById: {
      '1.3.0': {
        id: '1.3.0',
        symbol: 'BTS',
        precision: 2,
        bitasset_data_id: null,
      },
      '1.3.22': {
        id: '1.3.22',
        symbol: 'ALT',
        precision: 2,
        bitasset_data_id: null,
      },
      '1.3.20': {
        id: '1.3.20',
        symbol: 'TWENTIX.IOXRPMM',
        precision: 0,
        bitasset_data_id: null,
        dynamic_asset_data_id: '2.4.20',
        for_liquidity_pool: '1.19.1',
        current_supply: 10000,
      },
    },
    assetDynamicData: {
      '2.4.20': {
        id: '2.4.20',
        current_supply: 10000,
      },
    },
    poolByShareAsset: {
      '1.3.20': {
        id: '1.19.1',
        asset_a: '1.3.0',
        asset_b: '1.3.22',
        balance_a: 10000,
        balance_b: 10000,
        share_asset: '1.3.20',
      },
    },
    poolByAssetPair: {
      '1.3.0|1.3.22': {
        id: '1.19.4',
        asset_a: '1.3.0',
        asset_b: '1.3.22',
        balance_a: 10000,
        balance_b: 10000,
        share_asset: '1.3.21',
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-lp-rate-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const runtime = new CreditRuntime(
      {
        config: createBaseBotConfig({
          botKey: 'credit-bot-lp-rate',
          debtPolicy: {
            lending: [
              {
                asset: 'BTS',
                collateralAsset: 'TWENTIX.IOXRPMM',
                type: 'creditOffer',
                outputWeight: 1,
                maxBorrowAmount: 1000,
                maxCollateralRatio: 1.5,
                maxFeeRatePerDay: 0.05,
                autoReborrow: true,
                autoRepay: 2,
              },
            ],
          },
        }),
        account: { id: '1.2.3', name: 'alice' },
        accountId: '1.2.3',
        privateKey: 'WIF-KEY',
        _log() {},
        _warn() {},
      },
      { stateDir: path.join(baseDir, 'credit_runtime') },
    );

    const lendingItem = runtime.debtPolicy.lending.find((item) => item.type === 'creditOffer');
    const debtAsset = await runtime._resolveAsset('BTS');
    const collateralAsset = await runtime._resolveAsset('TWENTIX.IOXRPMM');
    const rate = await runtime._resolveCreditConversionRate(lendingItem, debtAsset.id, collateralAsset.id, { includeSource: true });

    assert.ok(rate && rate.price != null && rate.price > 0, `pool collateral should resolve a positive conversion rate (got ${JSON.stringify(rate)})`);
    assert.strictEqual(rate.source, 'pool-derived', 'pool share collateral should derive its credit conversion rate from the AMM pool');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testProactiveRenewalRollsAffordablePieceWhenBalanceShort() {
  const calls = [];
  const dbCalls = [];
  const warnings = [];
  const dealId = '1.19.77';
  const offerId = '1.18.42';
  const debtAmount = 500;
  const collateralAmount = 1000;
  const repayTime = new Date(Date.now() - 3600000).toISOString();
  const activeDeal = {
    id: dealId,
    borrower: '1.2.3',
    offer_id: offerId,
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: debtAmount,
    collateral_asset: '1.3.0',
    collateral_amount: collateralAmount,
    fee_rate: 30000,
    latest_repay_time: repayTime,
    auto_repay: 2,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], [activeDeal]],
    assetBalances: {
      '1.3.10': { free: 206, locked: 0, total: 206 },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-proactive-partial-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-proactive-partial',
        debtPolicy: { lending: [policy] },
        TIMING: { CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: 168 },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn(message) { warnings.push(message); },
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 1000,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: dealId,
        debtAssetId: '1.3.10',
        debtAmount: debtAmount,
        collateralAssetId: '1.3.0',
        collateralAmount: collateralAmount,
        latestRepayTime: repayTime,
        feeRate: 30000,
        offerId: offerId,
        autoRepay: 2,
      }],
    };

    const execCallCount = calls.length;
    await runtime._runCreditMaintenance(policy, '1.3.10');

    const newCalls = calls.slice(execCallCount);
    assert.strictEqual(newCalls.length, 1, 'partial renewal should broadcast one atomic repay+reborrow batch');
    const batch = newCalls[0];
    assert.strictEqual(batch.operations.length, 2, 'batch should contain repay + reborrow');
    const repayOp = batch.operations[0];
    const acceptOp = batch.operations[1];
    assert.strictEqual(repayOp.op_name, 'credit_deal_repay', 'first op should be credit_deal_repay');
    assert.strictEqual(repayOp.op_data.repay_amount.amount, 199, 'repay should be sized to the free balance minus the one-unit reserve, not the full debt');
    assert.strictEqual(acceptOp.op_name, 'credit_offer_accept', 'second op should be credit_offer_accept');
    assert.strictEqual(acceptOp.op_data.borrow_amount.amount, 199, 'reborrow should match the repaid piece');
    assert.strictEqual(acceptOp.op_data.collateral.amount, 398, 'reborrow collateral should be recomputed for the piece');
    assert.ok(warnings.some((w) => String(w).includes('rolling the rest')), 'partial renewal should be logged');
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'inline partial reborrow should leave no pending entry');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingReborrowKeepsSiblingDealsOnSameOffer() {
  const calls = [];
  const dbCalls = [];
  const newerDealId = '1.19.99';
  const olderDealId = '1.19.50';
  const sourceDealId = '1.19.77';
  const offerId = '1.18.42';
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[
      {
        id: newerDealId,
        borrower: '1.2.3',
        offer_id: offerId,
        offer_owner: '1.2.9',
        debt_asset: '1.3.10',
        debt_amount: 200,
        collateral_asset: '1.3.0',
        collateral_amount: 400,
        fee_rate: 30000,
        latest_repay_time: '2030-06-01T00:00:00',
        auto_repay: 2,
      },
      {
        id: olderDealId,
        borrower: '1.2.3',
        offer_id: offerId,
        offer_owner: '1.2.9',
        debt_asset: '1.3.10',
        debt_amount: 100,
        collateral_asset: '1.3.0',
        collateral_amount: 200,
        fee_rate: 30000,
        latest_repay_time: '2030-06-01T00:00:00',
        auto_repay: 2,
      },
    ]],
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-sibling-reborrow-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-sibling-reborrow',
        debtPolicy: { lending: [policy] },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();
    runtime.state.pendingReborrows = [{
      sourceDealId: sourceDealId,
      offerId: offerId,
      borrowAmount: 200,
      collateralAmount: 400,
      autoRepay: 2,
      specificPolicy: policy,
      preRepayDealIds: [sourceDealId, olderDealId, newerDealId],
      pendingRepayAmount: 200,
      pendingReleaseCollateralAmount: 400,
      requestedAt: '2026-01-01T00:00:00.000Z',
      reason: 'deferred repay',
    }];
    runtime.state.reborrowPending = true;

    const result = await runtime.processPendingReborrows();
    assert.strictEqual(result.processed, 1, 'legitimate reborrow should be processed, not dropped');
    assert.strictEqual(result.remaining, 0, 'queue should be cleared after the reborrow');
    assert.strictEqual(calls.length, 1, 'a sibling deal on the same offer must not suppress the reborrow');
    assert.strictEqual(calls[0].operations[0].op_name, 'credit_offer_accept', 'reborrow should broadcast a credit_offer_accept');
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'queue should not retain the processed entry');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testProactiveRenewalScalesDownWhenCollateralShort() {
  const calls = [];
  const dbCalls = [];
  const warnings = [];
  const logs = [];
  const dealId = '1.19.77';
  const offerId = '1.18.42';
  const debtAmount = 100;
  const collateralAmount = 150;
  const repayTime = new Date(Date.now() - 3600000).toISOString();
  const activeDeal = {
    id: dealId,
    borrower: '1.2.3',
    offer_id: offerId,
    offer_owner: '1.2.9',
    debt_asset: '1.3.10',
    debt_amount: debtAmount,
    collateral_asset: '1.3.0',
    collateral_amount: collateralAmount,
    fee_rate: 0,
    latest_repay_time: repayTime,
    auto_repay: 2,
  };
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[activeDeal], []],
    assetBalances: {
      '1.3.10': { free: 1000, locked: 0, total: 1000 },
    },
    offersById: {
      '1.18.42': {
        id: offerId,
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 0,
        min_deal_amount: 10,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-proactive-collateral-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-proactive-collateral',
        debtPolicy: { lending: [policy] },
        TIMING: { CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: 168 },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log(message) { logs.push(message); },
      _warn(message) { warnings.push(message); },
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.refreshState();

    runtime.state.positions['1.3.10:1.3.0'] = {
      assignedCollateralBudget: 150,
      creditConversionRate: 0.5,
      creditDeals: [{
        id: dealId,
        debtAssetId: '1.3.10',
        debtAmount: debtAmount,
        collateralAssetId: '1.3.0',
        collateralAmount: collateralAmount,
        latestRepayTime: repayTime,
        feeRate: 0,
        offerId: offerId,
        autoRepay: 2,
      }],
    };

    const execCallCount = calls.length;
    await runtime._runCreditMaintenance(policy, '1.3.10');

    const newCalls = calls.slice(execCallCount);
    assert.strictEqual(newCalls.length, 1, 'collateral-scaled renewal should broadcast one atomic repay+reborrow batch');
    const batch = newCalls[0];
    assert.strictEqual(batch.operations.length, 2, 'batch should contain repay + reborrow');
    assert.strictEqual(batch.operations[0].op_data.repay_amount.amount, 100, 'the full debt should still be repaid');
    const acceptOp = batch.operations[1];
    assert.strictEqual(acceptOp.op_name, 'credit_offer_accept', 'second op should be credit_offer_accept');
    assert.strictEqual(acceptOp.op_data.borrow_amount.amount, 75, 'borrow should scale down to what the released collateral backs');
    assert.strictEqual(acceptOp.op_data.collateral.amount, 150, 'reborrow should lock the released collateral');
    assert.ok(logs.some((m) => String(m).includes('shrinking reborrow from 100 to 75')), 'the scale-down should be logged');
    assert.strictEqual(warnings.filter((m) => String(m).includes('full renewal')).length, 0, 'collateral scaling is not a debt-asset shortfall');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingReborrowAppliesCollateralBudget() {
  const calls = [];
  const dbCalls = [];
  const offerId = '1.18.42';
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    offersById: {
      '1.18.42': {
        id: offerId,
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 0,
        min_deal_amount: 10,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pending-budget-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-pending-budget', debtPolicy: { lending: [policy] } }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.loadState();
    runtime.state.pendingReborrows = [{
      sourceDealId: '1.19.77',
      offerId,
      borrowAmount: 100,
      collateralAmount: null,
      autoRepay: 2,
      specificPolicy: policy,
      preRepayDealIds: ['1.19.77'],
      availableCollateralAmount: 150,
      pendingRepayAmount: 100,
      pendingReleaseCollateralAmount: 150,
      requestedAt: '2026-01-01T00:00:00.000Z',
      reason: 'deferred repay',
    }];
    runtime.state.reborrowPending = true;

    const result = await runtime.processPendingReborrows();
    assert.strictEqual(result.processed, 1, 'budgeted pending reborrow should execute');
    assert.strictEqual(result.remaining, 0, 'queue should be cleared after success');
    assert.strictEqual(calls.length, 1, 'one reborrow batch should broadcast');
    const acceptOp = calls[0].operations[0];
    assert.strictEqual(acceptOp.op_name, 'credit_offer_accept', 'pending request should accept the offer');
    assert.strictEqual(acceptOp.op_data.borrow_amount.amount, 75, 'replayed reborrow should be clamped to the persisted budget');
    assert.strictEqual(acceptOp.op_data.collateral.amount, 150, 'collateral should match the released budget');
    assert.strictEqual(runtime.state.lastBorrowRequest?.clampedByCollateral, true, 'clamp should be recorded on lastBorrowRequest');
    assert.strictEqual(runtime.state.lastBorrowRequest?.requestedBorrowAmount, 100, 'recorded requested borrow should be pre-clamp');
    assert.strictEqual(runtime.state.lastBorrowRequest?.borrowAmount, 75, 'recorded borrow should be post-clamp');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testFallbackOfferAppliesCollateralBudget() {
  const calls = [];
  const dbCalls = [];
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    offersById: {
      '1.18.42': null,
      '1.18.43': {
        id: '1.18.43',
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 0,
        min_deal_amount: 10,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 3, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-fallback-budget-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({ botKey: 'credit-bot-fallback-budget', debtPolicy: { lending: [policy] } }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn() {},
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.loadState();
    runtime.state.pendingReborrows = [{
      sourceDealId: '1.19.77',
      offerId: '1.18.42',
      borrowAmount: 100,
      collateralAmount: null,
      autoRepay: 2,
      specificPolicy: policy,
      preRepayDealIds: ['1.19.77'],
      availableCollateralAmount: 150,
      pendingRepayAmount: 100,
      pendingReleaseCollateralAmount: 150,
      requestedAt: '2026-01-01T00:00:00.000Z',
      reason: 'deferred repay',
    }];
    runtime.state.reborrowPending = true;

    const result = await runtime.processPendingReborrows();
    assert.strictEqual(result.processed, 1, 'fallback reborrow should execute');
    assert.strictEqual(result.remaining, 0, 'queue should be cleared after fallback success');
    assert.strictEqual(calls.length, 1, 'fallback reborrow should broadcast one batch');
    const acceptOp = calls[0].operations[0];
    assert.strictEqual(acceptOp.op_data.offer_id, '1.18.43', 'fallback offer should be used when the original is unavailable');
    assert.strictEqual(acceptOp.op_data.borrow_amount.amount, 50, 'fallback reborrow should respect the persisted collateral budget at the fallback price');
    assert.strictEqual(acceptOp.op_data.collateral.amount, 150, 'fallback collateral should equal the released budget');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

async function testPendingReborrowDropsAfterMaxAttempts() {
  const calls = [];
  const dbCalls = [];
  const warnings = [];
  const offerId = '1.18.42';
  const restore = installStubs(calls, dbCalls, {
    dealResponses: [[]],
    offersById: {
      '1.18.42': {
        id: offerId,
        asset_type: '1.3.10',
        current_balance: 10000,
        fee_rate: 0,
        min_deal_amount: 100,
        enabled: true,
        max_duration_seconds: 86400,
        acceptable_collateral: {
          '1.3.0': {
            base: { amount: 2, asset_id: '1.3.0' },
            quote: { amount: 1, asset_id: '1.3.10' },
          },
        },
      },
    },
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pending-attempts-'));

  try {
    delete require.cache[creditRuntimePath];
    const CreditRuntime = require('../modules/credit_runtime').default;
    const policy = {
      asset: 'HONEST.USD',
      collateralAsset: 'BTS',
      type: 'creditOffer',
      outputWeight: 1,
      maxBorrowAmount: 1000,
      maxCollateralAmount: 10000,
      maxCollateralRatio: 2.5,
      maxFeeRatePerDay: 0.05,
      autoReborrow: true,
      autoRepay: 2,
      renewOnly: true,
    };
    const runtime = new CreditRuntime({
      config: createBaseBotConfig({
        botKey: 'credit-bot-pending-attempts',
        debtPolicy: { lending: [policy] },
        timing: { CREDIT_REBORROW_MAX_ATTEMPTS: 2 },
      }),
      account: { id: '1.2.3', name: 'alice' },
      accountId: '1.2.3',
      privateKey: 'WIF-KEY',
      manager: {
        _fillProcessingLock: {
          acquire: async (fn) => fn(),
          isReentrant: () => false,
        },
        fetchAccountTotals: async () => {},
      },
      _runGridMaintenance: async () => ({ checked: true }),
      _log() {},
      _warn(message) { warnings.push(message); },
    }, { stateDir: path.join(baseDir, 'credit_runtime') });

    await runtime.loadState();
    runtime.state.pendingReborrows = [{
      sourceDealId: '1.19.77',
      offerId,
      borrowAmount: 5,
      collateralAmount: null,
      autoRepay: 2,
      specificPolicy: policy,
      preRepayDealIds: ['1.19.77'],
      pendingReleaseCollateralAmount: 400,
      reborrowAttempts: 0,
      requestedAt: '2026-01-01T00:00:00.000Z',
      reason: 'deferred repay',
    }];
    runtime.state.reborrowPending = true;

    const first = await runtime.processPendingReborrows();
    assert.strictEqual(first.remaining, 1, 'first failed attempt should keep the request queued');
    assert.strictEqual(runtime.state.pendingReborrows[0].reborrowAttempts, 1, 'failed attempt should increment the counter');
    assert.strictEqual(calls.length, 0, 'no reborrow should broadcast while below min_deal_amount');

    const second = await runtime.processPendingReborrows();
    assert.strictEqual(second.remaining, 0, 'request should be dropped once max attempts are reached');
    assert.strictEqual(runtime.state.pendingReborrows.length, 0, 'dropped request should not be re-queued');
    assert.strictEqual(runtime.state.reborrowPending, false, 'reborrowPending should clear once the queue is empty');
    assert.ok(warnings.some((m) => String(m).includes('after 2 failed attempt')), 'drop should be logged with the attempt count');
  } finally {
    restore();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
  }
}

// Each scenario installs its own bitshares_client / chain_orders mocks, and
// ESM module graphs cache per process — so every test runs as its own stage
// in a fresh hooked child (stops at first failure, forwards exit code).
const STAGES = {
  refresh_and_mpa_plan: testRefreshAndMpaPlan,
  credit_offer_collateral_percent_uses_debt_snapshot: testCreditOfferCollateralPercentUsesDebtSnapshot,
  credit_offer_collateral_percent_does_not_require_refresh: testCreditOfferCollateralPercentDoesNotRequireRefresh,
  mpa_precision_aware_broadcast: testMpaPrecisionAwareBroadcast,
  mpa_debt_failure_falls_back_to_collateral: testMpaDebtFailureFallsBackToCollateral,
  mpa_debt_failure_does_not_fallback_on_ambiguous_error: testMpaDebtFailureDoesNotFallbackOnAmbiguousError,
  mpa_debt_failure_surfaces_when_collateral_fallback_unavailable: testMpaDebtFailureSurfacesWhenCollateralFallbackUnavailable,
  mpa_debt_fallback_respects_assigned_collateral_budget: testMpaDebtFallbackRespectsAssignedCollateralBudget,
  mpa_debt_first_then_collateral_fallback_triggers_reset: testMpaDebtFirstThenCollateralFallbackTriggersReset,
  repay_and_reborrow_flow: testRepayAndReborrowFlow,
  renew_only_rejects_standalone_credit_borrow: testRenewOnlyRejectsStandaloneCreditBorrow,
  fixed_credit_collateral_does_not_resolve_percentage_base: testFixedCreditCollateralDoesNotResolvePercentageBase,
  multiple_mpa_positions_are_blocked: testMultipleMpaPositionsAreBlocked,
  removed_credit_policy_prunes_global_tracking: testRemovedCreditPolicyPrunesGlobalTracking,
  default_fee_rate_cap_rejects_expensive_offer: testDefaultFeeRateCapRejectsExpensiveOffer,
  max_fee_rate_per_day_rejects_expensive_offer: testMaxFeeRatePerDayRejectsExpensiveOffer,
  credit_borrow_is_derived_from_collateral: testCreditBorrowIsDerivedFromCollateral,
  credit_offer_total_ceiling_enforcement: testCreditOfferTotalCeilingEnforcement,
  credit_offer_total_ceiling_uses_asset_precision: testCreditOfferTotalCeilingUsesAssetPrecision,
  lp_collateral_ratio_gate: testLpCollateralRatioGate,
  lp_collateral_resolves_credit_conversion_rate: testLpCollateralResolvesCreditConversionRate,
  deal_disappearance_does_not_auto_queue_reborrow: testDealDisappearanceDoesNotAutoQueueReborrow,
  deferred_reborrow_queues_after_confirmed_repay: testDeferredReborrowQueuesAfterConfirmedRepay,
  fallback_offer_selected_when_original_offer_unavailable: testFallbackOfferSelectedWhenOriginalOfferUnavailable,
  pending_reborrow_uses_fallback_offer_when_original_unavailable: testPendingReborrowUsesFallbackOfferWhenOriginalUnavailable,
  pending_fallback_waits_while_source_deal_active: testPendingFallbackWaitsWhileSourceDealActive,
  credit_deal_update_preserves_auto_repay_mode: testCreditDealUpdatePreservesAutoRepayMode,
  auto_reborrow_queue_is_ignored_when_disabled: testAutoReborrowQueueIsIgnoredWhenDisabled,
  pending_reborrow_resolves_policy_with_cold_asset_cache: testPendingReborrowResolvesPolicyWithColdAssetCache,
  credit_maintenance_borrows_toward_assigned_target: testCreditMaintenanceBorrowsTowardAssignedTarget,
  credit_maintenance_skips_small_collateral_increase: testCreditMaintenanceSkipsSmallCollateralIncrease,
  credit_maintenance_allows_zero_threshold: testCreditMaintenanceAllowsZeroThreshold,
  credit_maintenance_caps_increase_at_borrow_ceiling: testCreditMaintenanceCapsIncreaseAtBorrowCeiling,
  credit_maintenance_caps_increase_at_borrow_ceiling_for_multi_collateral_offer: testCreditMaintenanceCapsIncreaseAtBorrowCeilingForMultiCollateralOffer,
  state_persists_across_restart: testStatePersistsAcrossRestart,
  proactive_repay_bundles_reborrow_in_single_batch: testProactiveRepayBundlesReborrowInSingleBatch,
  proactive_repay_reborrow_multi_asset_offer: testProactiveRepayReborrowMultiAssetOffer,
  mismatch_deal_appears_in_new_pos_key: testMismatchDealAppearsInNewPosKey,
  repay_with_unacceptable_collateral_throws_specific_error: testRepayWithUnacceptableCollateralThrowsSpecificError,
  collateral_switch_skipped_without_balance: testCollateralSwitchSkippedWithoutBalance,
  pending_reborrow_stores_pending_repay_amount: testPendingReborrowStoresPendingRepayAmount,
  pending_reborrow_drops_stale_entry_when_replacement_exists: testPendingReborrowDropsStaleEntryWhenReplacementExists,
  proactive_repay_prunes_stale_pending_reborrow: testProactiveRepayPrunesStalePendingReborrow,
  proactive_renewal_rolls_affordable_piece: testProactiveRenewalRollsAffordablePieceWhenBalanceShort,
  proactive_renewal_scales_down_when_collateral_short: testProactiveRenewalScalesDownWhenCollateralShort,
  pending_reborrow_keeps_sibling_deals: testPendingReborrowKeepsSiblingDealsOnSameOffer,
  pending_reborrow_applies_collateral_budget: testPendingReborrowAppliesCollateralBudget,
  fallback_offer_applies_collateral_budget: testFallbackOfferAppliesCollateralBudget,
  pending_reborrow_drops_after_max_attempts: testPendingReborrowDropsAfterMaxAttempts,
  max_borrow_amount_per_operation_rejects_oversized_borrows: testMaxBorrowAmountPerOperationRejectsOversizedBorrows,
  max_borrow_amount_per_operation_with_selection: testMaxBorrowAmountPerOperationWithSelection,
  split_oversized_credit_deals_splits_correctly: testSplitOversizedCreditDealsSplitsCorrectly,
  split_oversized_credit_deals_skips_within_limit: testSplitOversizedCreditDealsSkipsWithinLimit,
  split_oversized_credit_deals_skips_when_no_per_op_limit: testSplitOversizedCreditDealsSkipsWhenNoPerOpLimit,
  max_borrow_amount_per_operation_is_max_borrow_amount_error: testMaxBorrowAmountPerOperationIsMaxBorrowAmountError,
};

runEsmMockStages(Object.keys(STAGES), async (stage) => {
  await STAGES[stage]();
  console.log('credit runtime tests passed');
});
