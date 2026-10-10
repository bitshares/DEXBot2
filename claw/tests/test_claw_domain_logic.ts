'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('../../tests/helpers/esm_mocks');

// Compiled ESM graphs cannot be mocked via require.cache; the helper installs
// loader hooks (one child process per stage so fresh module instances load).
function clearModule(_modulePath: string) {
  /* no-op under ESM hooks */
}

function registerMock(modulePath: string, exports: any) {
  defineEsmMockAbs(modulePath, Object.keys(exports), exports);
}

const { clone } = require('../modules/utils');

function createHonestHarness(options: any = {}) {
  const ecosystemPath = require.resolve('../modules/honest_ecosystem');
  const queriesPath = require.resolve('../modules/chain_queries');
  const poolsPath = require.resolve('../modules/liquidity_pools');

  const calls = {
    derivePoolPrice: [] as any[],
    getAsset: [] as string[],
    getBackingAsset: [] as string[],
    getBitassetData: [] as string[],
    getCallOrders: [] as any[],
    listAssets: [] as any[]
  };

  const coreAsset = { id: '1.3.0', precision: 5, symbol: 'BTS' };
  const referenceAsset = {
    bitasset_data_id: '2.4.100',
    id: '1.3.100',
    precision: 5,
    symbol: 'HONEST.MONEY'
  };
  const honestUsd = {
    bitasset_data_id: '2.4.101',
    id: '1.3.101',
    precision: 5,
    symbol: 'HONEST.USD'
  };
  const honestEur = {
    bitasset_data_id: '2.4.102',
    id: '1.3.102',
    precision: 5,
    symbol: 'HONEST.EUR'
  };
  const ordinary = { id: '1.3.200', precision: 5, symbol: 'ABC' };
  const listAssetPages = Array.isArray((options as any).listAssetPages)
    ? (options as any).listAssetPages
    : [
        [referenceAsset, honestUsd, ordinary],
        [referenceAsset, honestUsd, ordinary]
      ];

  registerMock(queriesPath, {
    getAsset: async (symbolOrId: string) => {
      calls.getAsset.push(symbolOrId);
      if (symbolOrId === 'BTS' || symbolOrId === '1.3.0') {
        return coreAsset;
      }
      if (symbolOrId === 'HONEST.MONEY' || symbolOrId === '1.3.100') {
        return referenceAsset;
      }
      if (symbolOrId === 'HONEST.USD' || symbolOrId === '1.3.101') {
        return honestUsd;
      }
      if (symbolOrId === 'HONEST.EUR' || symbolOrId === '1.3.102') {
        return honestEur;
      }
      return null;
    },
    getBackingAsset: async (assetId: string) => {
      calls.getBackingAsset.push(assetId);
      return coreAsset;
    },
    getBitassetData: async (assetId: string) => {
      calls.getBitassetData.push(assetId);
      return {
        current_feed_publication_time: `2026-03-31T00:00:0${assetId === '1.3.100' ? '1' : assetId === '1.3.101' ? '2' : '3'}`,
        current_feed: {
          settlement_price: {
            base: { asset_id: '1.3.0', amount: 200000 },
            quote: { asset_id: assetId, amount: 100000 }
          }
        }
      };
    },
    getCallOrders: async (assetId: string, limit: any) => {
      calls.getCallOrders.push({ assetId, limit });
      return [{ id: `${assetId}-call-1` }];
    },
    getObjects: async () => [],
    listAssets: async (lowerBound: string, limit: any) => {
      calls.listAssets.push({ lowerBound, limit });
      return listAssetPages.shift() || [];
    }
  });

  registerMock(poolsPath, {
    derivePoolPrice: async (assetA: any, assetB: any, options: any) => {
      calls.derivePoolPrice.push({ assetA, assetB, options: clone(options) });
      if (typeof options.failPair === 'string' && `${assetA}/${assetB}` === options.failPair) {
        throw new Error('pair unavailable');
      }
      return 0.42;
    }
  });

  clearModule(ecosystemPath);
  const ecosystem = require('../modules/honest_ecosystem');

  return {
    calls,
    cleanup() {
      clearModule(ecosystemPath);
      clearModule(queriesPath);
      clearModule(poolsPath);
    },
    coreAsset,
    ecosystem,
    honestEur,
    honestUsd,
    ordinary,
    referenceAsset
  };
}

async function testHonestEcosystem() {
  console.log('  honest_ecosystem...');

  const { calls, cleanup, coreAsset, ecosystem, honestUsd, referenceAsset } = createHonestHarness();

  try {
    const bridge = ecosystem.getHardcodedHonestMoneyBridge();
    const hardcodedPrice = await ecosystem.resolveHardcodedHonestMoneyPrice('HONEST.MONEY', 'BTS');
    const inversePrice = await ecosystem.resolveHardcodedHonestMoneyPrice('BTS', 'HONEST.MONEY');

    assert.ok(hardcodedPrice > 0);
    assert.ok(Math.abs(hardcodedPrice * inversePrice - 1) < 1e-12);
    assert.strictEqual(bridge.liquidityPool.poolSymbol, 'honest.BTSMONEY');

    const hardcodedContext = await ecosystem.resolveHonestPairContext('HONEST.MONEY', 'BTS');
    assert.strictEqual(hardcodedContext.source, 'hardcoded-liquidity-pool');
    assert.strictEqual(hardcodedContext.pool.poolSymbol, 'honest.BTSMONEY');

    const derivedPrice = await ecosystem.resolveHonestPairPrice('HONEST.USD', 'BTS');
    assert.strictEqual(derivedPrice, 0.42);
    assert.strictEqual(calls.derivePoolPrice.length, 1);

    const derivedContext = await ecosystem.resolveHonestPairContext('HONEST.USD', 'BTS');
    assert.strictEqual(derivedContext.source, 'dexbot2-derivePoolPrice');
    assert.strictEqual(derivedContext.priceBPerA, 0.42);

    const adapter = ecosystem.createHonestEcosystemAdapter({
      batchSize: 10,
      maxPages: 2,
      prefix: 'HONEST.'
    });

    const loaded = await adapter.loadAssets();
    assert.strictEqual(loaded.assets.length, 2);
    assert.strictEqual(loaded.mpas.length, 2);
    assert.deepStrictEqual(calls.listAssets[0], { limit: 10, lowerBound: 'HONEST.' });
    assert.strictEqual(loaded.mpas[0].backingAsset.symbol, 'BTS');

    const context = await adapter.buildContext({
      discoverPairs: [
        ['HONEST.MONEY', 'BTS'],
        ['HONEST.USD', 'BTS']
      ]
    });

    assert.strictEqual(context.scope.prefix, 'HONEST.');
    assert.strictEqual(context.referenceAsset.symbol, 'HONEST.MONEY');
    assert.strictEqual(context.summary.assetCount, 2);
    assert.strictEqual(context.summary.mpaCount, 2);
    assert.strictEqual(context.pairContexts.length, 2);
    assert.strictEqual(context.pairContexts[0].source, 'hardcoded-liquidity-pool');
    assert.strictEqual(context.pairContexts[1].source, 'dexbot2-derivePoolPrice');
    assert.strictEqual(context.bridge.source, 'hardcoded-liquidity-pool');
    assert.strictEqual(context.assets[0].type, 'MPA');
    assert.strictEqual(context.assets[0].symbol, referenceAsset.symbol);
    assert.strictEqual(context.assets[1].symbol, honestUsd.symbol);
    assert.strictEqual(context.assets[1].type, 'MPA');
    assert.strictEqual(context.pairContexts[0].priceBPerA > 0, true);
    assert.strictEqual(calls.getAsset.includes('BTS'), true);
    assert.strictEqual(calls.getBackingAsset.includes(referenceAsset.id), true);
    assert.strictEqual(calls.getCallOrders.some((entry) => entry.assetId === honestUsd.id), true);

    const bridgePair = await ecosystem.resolveHardcodedHonestMoneyPrice(coreAsset, referenceAsset);
    assert.ok(bridgePair > 0);
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

async function testHonestEcosystemPaginationAndUnresolvedPair() {
  console.log('  honest_ecosystem pagination + unresolved pair...');

  const { calls, cleanup, ecosystem } = createHonestHarness({
    listAssetPages: [
      [
        { bitasset_data_id: '2.4.100', id: '1.3.100', precision: 5, symbol: 'HONEST.MONEY' },
        { bitasset_data_id: '2.4.101', id: '1.3.101', precision: 5, symbol: 'HONEST.USD' }
      ],
      [
        { bitasset_data_id: '2.4.101', id: '1.3.101', precision: 5, symbol: 'HONEST.USD' },
        { bitasset_data_id: '2.4.102', id: '1.3.102', precision: 5, symbol: 'HONEST.EUR' }
      ],
      []
    ]
  });

  try {
    const loaded = await ecosystem.loadHonestAssets({
      batchSize: 2,
      maxPages: 3,
      prefix: 'HONEST.'
    });

    assert.deepStrictEqual(
      loaded.assets.map((asset: any) => asset.symbol),
      ['HONEST.MONEY', 'HONEST.USD', 'HONEST.EUR']
    );
    assert.deepStrictEqual(calls.listAssets, [
      { limit: 2, lowerBound: 'HONEST.' },
      { limit: 2, lowerBound: 'HONEST.USD' },
      { limit: 2, lowerBound: 'HONEST.EUR' }
    ]);

    const unresolved = await ecosystem.resolveHonestPairContext('HONEST.EUR', 'BTS', {
      failPair: 'HONEST.EUR/BTS'
    });
    assert.strictEqual(unresolved.source, 'unresolved');
    assert.strictEqual(unresolved.priceBPerA, null);
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

function createPositionManagerHarness() {
  const managerPath = require.resolve('../modules/position_manager');
  const actionsPath = require.resolve('../modules/chain_actions');
  const bitsharesClientPath = require.resolve('../modules/bitshares_client');
  const profilesPath = require.resolve('../modules/dexbot_profiles');
  const queriesPath = require.resolve('../modules/chain_queries');
  const bridgePath = require.resolve('../modules/dexbot_bridge');
  const shortStrategyPath = require.resolve('../modules/short_mpa_strategy');

  const calls = {
    savedStates: [] as any[],
    syncPosition: [] as string[],
    listenForFills: [] as any[],
    onFill: [] as any[]
  };

  const coreAsset = { id: '1.3.0', precision: 5, symbol: 'BTS' };
  const mpaAsset = {
    bitasset_data_id: '2.4.100',
    id: '1.3.100',
    precision: 5,
    symbol: 'HONEST.USD'
  };

  let accountSnapshot = {
    balances: [{ asset_type: '1.3.0', balance: 500000 }],
    call_orders: [],
    limit_orders: []
  };

  registerMock(bridgePath, {
    loadDexbotOrderUtils: () => ({
      blockchainToFloat: (amount: number, precision: number) => Number(amount) / (10 ** precision)
    })
  });

  registerMock(profilesPath, {
    writeJsonFileAtomic: async (filePath: string, state: any) => {
      calls.savedStates.push({
        filePath,
        state: clone(state)
      });
    }
  });

  registerMock(actionsPath, {
    listenForFills: async (accountName: string, callback: any) => {
      calls.listenForFills.push({ accountName, callback });
      return async () => {
        calls.listenForFills.push({ accountName, callback, type: 'unsubscribe' });
      };
    }
  });

  registerMock(shortStrategyPath, {
    closeShortOnBts: async () => ({ repayResult: { raw: { source: 'close-short' } } }),
    openShortOnBts: async () => ({ sellOrderResult: { operation_results: [[0, '1.7.1']], raw: { source: 'open-short' } } }),
    placeTakeProfitBuyOrderOnBts: async () => ({ rebuyOrderResult: { operation_results: [[0, '1.7.2']], raw: { source: 'take-profit' } } })
  });

  registerMock(queriesPath, {
    getAsset: async (symbolOrId: string) => {
      if (symbolOrId === 'HONEST.USD' || symbolOrId === '1.3.100') {
        return mpaAsset;
      }
      if (symbolOrId === 'BTS' || symbolOrId === '1.3.0') {
        return coreAsset;
      }
      return null;
    },
    getBackingAsset: async () => coreAsset,
    getBalances: async () => ({
      BTS: 5
    }),
    getBitassetData: async () => ({
      current_feed: {
        settlement_price: {
          base: { asset_id: '1.3.0', amount: 200000 },
          quote: { asset_id: '1.3.100', amount: 100000 }
        }
      },
      current_feed_publication_time: '2026-03-31T00:00:00'
    }),
    getFullAccount: async () => clone(accountSnapshot)
  });

  registerMock(bitsharesClientPath, {
    BitShares: {}
  });

  clearModule(managerPath);
  const { PositionManager } = require('../modules/position_manager');
  const manager = new PositionManager({
    statePath: path.join(os.tmpdir(), `claw-position-manager-${Date.now()}.json`)
  });

  return {
    calls,
    cleanup() {
      clearModule(managerPath);
      clearModule(actionsPath);
      clearModule(bitsharesClientPath);
      clearModule(profilesPath);
      clearModule(queriesPath);
      clearModule(bridgePath);
      clearModule(shortStrategyPath);
    },
    manager,
    mpaAsset,
    setAccountSnapshot(nextSnapshot: any) {
      accountSnapshot = clone(nextSnapshot);
    }
  };
}

async function testPositionManager() {
  console.log('  position_manager...');

  const { calls, cleanup, manager, mpaAsset, setAccountSnapshot } = createPositionManagerHarness();

  try {
    const created = await manager.createShortPosition({
      accountName: 'alice',
      collateralAmount: 25,
      debtAmount: 10,
      mpaAsset: 'HONEST.USD',
      sellPriceInBts: 2.5,
      targetCollateralRatio: 2.2
    });

    assert.strictEqual(created.status, 'planned');
    assert.strictEqual(created.entry.targetSellAmount, 10);
    assert.strictEqual(created.entry.targetReceiveAmount, 25);
    assert.strictEqual(created.assets.mpa.symbol, 'HONEST.USD');
    assert.strictEqual(calls.savedStates.length, 1);

    const state = await manager.loadState();
    state.positions[0].entry.orderId = '1.7.1';
    state.positions[0].entry.orderOpen = true;

    setAccountSnapshot({
      balances: [{ asset_type: '1.3.0', balance: 500000 }],
      call_orders: [
        {
          call_price: { quote: { asset_id: mpaAsset.id } },
          collateral: 2500000,
          debt: 1000000
        }
      ],
      limit_orders: [
        { for_sale: 500000, id: '1.7.1' }
      ]
    });

    const synced = await manager.syncPosition(created.id);
    assert.strictEqual(synced.status, 'entry_order_open');
    assert.strictEqual(synced.onChain.debtAmount, 10);
    assert.strictEqual(synced.onChain.debtValueInBts, 20);
    assert.strictEqual(synced.onChain.trackedOrders.entry.orderId, '1.7.1');
    assert.strictEqual(synced.onChain.trackedOrders.entry.sellAmountRemaining, 5);

    manager.syncPosition = async (positionId: string) => {
      calls.syncPosition.push(positionId);
      return manager.getPosition(positionId);
    };

    const unsubscribe = await manager.watchAccount('alice', async (position: any, fill: any) => {
      calls.onFill.push({ fill, position });
    });

    assert.strictEqual(calls.listenForFills.length, 1);

    await calls.listenForFills[0].callback([
      {
        op: [
          4,
          {
            order_id: '1.7.1',
            pays: { asset_id: '1.3.100', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 200000 }
          }
        ]
      }
    ]);

    const updated = await manager.getPosition(created.id);
    assert.strictEqual(updated.entry.fillCount, 1);
    assert.strictEqual(updated.entry.filledSellAmount, 6);
    assert.strictEqual(updated.entry.filledReceiveAmount, 2);
    assert.strictEqual(updated.entry.fillStatus, 'partially_filled');
    assert.strictEqual(calls.onFill.length, 1);
    assert.strictEqual(calls.syncPosition[0], created.id);
    assert.ok(calls.savedStates.length >= 2);

    await unsubscribe();
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

runEsmMockStages(
  ['honest', 'honest-pagination', 'position-manager'],
  async (stage: string) => {
    if (stage === 'honest') {
      await testHonestEcosystem();
      return;
    }
    if (stage === 'honest-pagination') {
      await testHonestEcosystemPaginationAndUnresolvedPair();
      return;
    }
    if (stage === 'position-manager') {
      await testPositionManager();
      return;
    }
    throw new Error(`Unknown stage: ${stage}`);
  }
);
