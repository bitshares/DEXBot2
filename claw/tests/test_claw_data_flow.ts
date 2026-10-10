'use strict';

const assert = require('assert');
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

function createChainDataHarness() {
  const bridgePath = require.resolve('../modules/dexbot_bridge');
  const queriesPath = require.resolve('../modules/chain_queries');
  const discoveryPath = require.resolve('../modules/position_discovery');
  const feedPath = require.resolve('../modules/feed_price_source');

  const calls = {
    dbCall: [] as Array<{ method: string; args: unknown }>,
    getAsset: [] as string[],
    getBackingAsset: [] as string[],
    getBitassetData: [] as string[],
    getFullAccount: [] as string[]
  };

  const bts = { id: '1.3.0', precision: 5, symbol: 'BTS' };
  const honest = {
    bitasset_data_id: '2.4.100',
    id: '1.3.100',
    precision: 5,
    symbol: 'HONEST.USD'
  };
  const other = {
    bitasset_data_id: '2.4.101',
    id: '1.3.101',
    precision: 5,
    symbol: 'HONEST.EUR'
  };

  const account = {
    call_orders: [
      {
        borrower: '1.2.345',
        call_price: { quote: { asset_id: honest.id } },
        collateral: 2500000,
        debt: 1000000,
        id: '2.7.1'
      },
      {
        borrower: '1.2.345',
        call_price: { quote: { asset_id: '1.3.999' } },
        collateral: 999,
        debt: 1,
        id: '2.7.skip'
      }
    ]
  };

  registerMock(bridgePath, {
    loadDexbotOrderUtils: () => ({
      blockchainToFloat: (amount: number, precision: number) => Number(amount) / (10 ** precision)
    }),
    loadDexbotOrderSystemUtils: () => ({
      blockchainToFloat: (amount: number, precision: number) => Number(amount) / (10 ** precision)
    })
  });

  registerMock(queriesPath, {
    getAsset: async (symbolOrId: string) => {
      calls.getAsset.push(symbolOrId);
      if (symbolOrId === 'BTS' || symbolOrId === bts.id) {
        return bts;
      }
      if (symbolOrId === honest.symbol || symbolOrId === honest.id) {
        return honest;
      }
      if (symbolOrId === other.symbol || symbolOrId === other.id) {
        return other;
      }
      return null;
    },
    getBackingAsset: async (symbolOrId: string) => {
      calls.getBackingAsset.push(symbolOrId);
      if (symbolOrId === honest.id || symbolOrId === honest.symbol) {
        return bts;
      }
      if (symbolOrId === other.id || symbolOrId === other.symbol) {
        return bts;
      }
      return null;
    },
    getBitassetData: async (symbolOrId: string) => {
      calls.getBitassetData.push(symbolOrId);
      if (symbolOrId === honest.id || symbolOrId === honest.symbol) {
        return {
          current_feed_publication_time: '2026-03-31T00:00:00',
          current_feed: {
            settlement_price: {
              base: { asset_id: bts.id, amount: 200000 },
              quote: { asset_id: honest.id, amount: 100000 }
            }
          }
        };
      }
      if (symbolOrId === other.id || symbolOrId === other.symbol) {
        return {
          current_feed_publication_time: '2026-03-31T00:00:01',
          current_feed: {
            settlement_price: {
              base: { asset_id: other.id, amount: 100000 },
              quote: { asset_id: bts.id, amount: 200000 }
            }
          }
        };
      }
      return null;
    },
    getFullAccount: async (accountName: string) => {
      calls.getFullAccount.push(accountName);
      if (accountName !== 'alice') {
        return null;
      }
      return clone(account);
    },
    dbCall: async (method: string, args: unknown) => {
      calls.dbCall.push({ method, args: clone(args) });
      if (method === 'get_order_book') {
        return {
          asks: [{ price: 2.2 }],
          bids: [{ price: 1.8 }]
        };
      }
      return null;
    }
  });

  clearModule(discoveryPath);
  clearModule(feedPath);

  return {
    calls,
    cleanup() {
      clearModule(discoveryPath);
      clearModule(feedPath);
      clearModule(queriesPath);
      clearModule(bridgePath);
    },
    discovery: require('../modules/position_discovery'),
    feed: require('../modules/feed_price_source')
  };
}

async function testPositionDiscoveryAndFeedSource() {
  console.log('  position_discovery + feed_price_source...');

  const { calls, cleanup, discovery, feed } = createChainDataHarness();

  try {
    const positions = await discovery.discoverPositions('alice');
    assert.strictEqual(positions.length, 1);
    assert.strictEqual(positions[0].market, 'HONEST.USD/BTS');
    assert.strictEqual(positions[0].onChain.debtAmount, 10);
    assert.strictEqual(positions[0].onChain.collateralAmount, 25);
    assert.strictEqual(positions[0].onChain.collateralRatio, 1.25);

    const summary = await discovery.discoverPositionsSummary('alice');
    assert.strictEqual(summary.positionCount, 1);
    assert.strictEqual(summary.positions[0].cr, 1.25);

    const feedPrice = await feed.fetchFeedPrice('HONEST.USD');
    assert.strictEqual(feedPrice.feedPrice, 2);
    assert.strictEqual(feedPrice.backingSymbol, 'BTS');

    const midPrice = await feed.fetchMidPrice('BTS', 'HONEST.USD');
    assert.strictEqual(midPrice, 2);

    const trendInput = await feed.fetchTrendInput('HONEST.USD');
    assert.strictEqual(trendInput.marketPrice, 2);
    assert.strictEqual(trendInput.feedPrice, 2);
    assert.strictEqual(trendInput.premium, 0);

    assert.strictEqual(feed.parseBtsPerMpa(
      {
        base: { asset_id: '1.3.100', amount: 100000 },
        quote: { asset_id: '1.3.0', amount: 200000 }
      },
      { id: '1.3.100', precision: 5 },
      { id: '1.3.0', precision: 5 }
    ), 2);

    assert.ok(calls.getFullAccount.includes('alice'));
    assert.ok(calls.getAsset.includes('HONEST.USD'));
    assert.ok(calls.getBitassetData.includes('HONEST.USD'));
    assert.ok(calls.dbCall.some((entry) => entry.method === 'get_order_book'));
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

function createDecisionLoopHarness() {
  const decisionLoopPath = require.resolve('../modules/decision_loop');
  const discoveryPath = require.resolve('../modules/position_discovery');
  const healthPath = require.resolve('../modules/position_health');
  const feedPath = require.resolve('../modules/feed_price_source');
  const analyzerPath = require.resolve('../../market_adapter/core/signals/kalman_trend_analyzer');

  const calls = {
    fetchTrendInput: [] as string[],
    log: [] as string[],
    updates: [] as Array<{ positionId: string; trendSignal: any }>
  };

  class FakeTrendAnalyzer {
    [key: string]: any;
    constructor(config: any) {
      this.config = config;
      this.updateCount = 0;
    }

    update(marketPrice: number, feedPrice: number) {
      this.updateCount += 1;
      this.lastResult = {
        confidence: 80,
        premium: { percent: ((marketPrice - feedPrice) / feedPrice) * 100 },
        trend: this.updateCount === 1 ? 'DOWN' : 'UP'
      };
      return this.lastResult;
    }

    getAnalysis() {
      return this.lastResult || {
        confidence: 0,
        premium: { percent: null },
        trend: 'NEUTRAL'
      };
    }
  }

  registerMock(discoveryPath, {
    discoverPositions: async () => ([
      { id: 'pos-1', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 5 } },
      { id: 'pos-2', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 6 } },
      { id: 'pos-3', market: 'HONEST.EUR/BTS', mpaSymbol: 'HONEST.EUR', onChain: { debtAmount: 7 } }
    ])
  });
  registerMock(healthPath, {
    assessPosition: (position: any, trendSignal: any) => {
      calls.updates.push({ positionId: position.id, trendSignal: clone(trendSignal) });
      return {
        actions: position.id === 'pos-1'
          ? [{ priority: 'immediate', action: 'reduce_debt' }]
          : [{ priority: 'soon', action: 'review_direction' }],
        collateral: { zone: 'green' },
        positionId: position.id
      };
    }
  });
  registerMock(feedPath, {
    fetchTrendInput: async (mpaSymbol: string) => {
      calls.fetchTrendInput.push(mpaSymbol);
      if (mpaSymbol === 'HONEST.EUR') {
        throw new Error('feed unavailable');
      }
      return {
        feedPrice: 10,
        marketPrice: 12,
        premium: 20
      };
    }
  });
  registerMock(analyzerPath, {
    KalmanTrendAnalyzer: FakeTrendAnalyzer
  });

  clearModule(decisionLoopPath);

  return {
    calls,
    cleanup() {
      clearModule(decisionLoopPath);
      clearModule(discoveryPath);
      clearModule(healthPath);
      clearModule(feedPath);
      clearModule(analyzerPath);
    },
    decisionLoop: require('../modules/decision_loop')
  };
}

async function testDecisionLoop() {
  console.log('  decision_loop...');

  const { calls, cleanup, decisionLoop } = createDecisionLoopHarness();

  try {
    const result = await decisionLoop.evaluate('alice', {
      analyzerConfig: { period: 12 },
      logger: (message: string) => calls.log.push(message)
    });

    assert.strictEqual(result.positionCount, 3);
    assert.strictEqual(result.positions[0].positionId, 'pos-1');
    assert.strictEqual(result.positions[1].positionId, 'pos-2');
    assert.strictEqual(result.positions[2].positionId, 'pos-3');
    assert.strictEqual(calls.fetchTrendInput.filter((symbol) => symbol === 'HONEST.USD').length, 1);
    assert.strictEqual(calls.fetchTrendInput.filter((symbol) => symbol === 'HONEST.EUR').length, 1);
    assert.ok(calls.log.some((line) => line.includes('trend fetch failed for HONEST.EUR')));
    assert.strictEqual(result.summary.immediateActions, 1);
    assert.strictEqual(result.summary.soonActions, 2);
    assert.strictEqual(result.summary.zones.green, 3);
    assert.strictEqual(result.positions[1].actions[0].priority, 'soon');
    assert.strictEqual(calls.updates[1].trendSignal.premium, 20);
  } finally {
    decisionLoop.resetAnalyzers();
    cleanup();
  }

  console.log('    PASS');
}

function createKibanaHarness() {
  const chainQueriesPath = require.resolve('../modules/chain_queries');
  const marketCandlesPath = require.resolve('../../market_adapter/core/kibana_market_candles');
  const lpSourcePath = require.resolve('../../market_adapter/inputs/kibana_source');
  const kibanaPricePath = require.resolve('../modules/kibana_price_source');

  const calls = {
    getAsset: [] as string[],
    marketCandles: [] as Array<{ assetA: any; assetB: any; config: any }>,
    marketClosePrices: [] as Array<{ assetA: any; assetB: any; config: any }>,
    lpCandles: [] as Array<{ poolId: any; assetA: any; assetB: any; config: any }>,
    lpClosePrices: [] as Array<{ poolId: any; assetA: any; assetB: any; config: any }>,
    poolAssets: [] as Array<{ poolId: any; config: any }>
  };

  const bts = { id: '1.3.0', precision: 5, symbol: 'BTS' };
  const honest = { id: '1.3.100', precision: 5, symbol: 'HONEST.USD' };

  registerMock(chainQueriesPath, {
    getAsset: async (symbolOrId: string) => {
      calls.getAsset.push(symbolOrId);
      if (symbolOrId === 'BTS') {
        return bts;
      }
      if (symbolOrId === 'HONEST.USD') {
        return honest;
      }
      return null;
    }
  });
  registerMock(marketCandlesPath, {
    getMarketCandles: async (assetA: any, assetB: any, config: any) => {
      calls.marketCandles.push({ assetA, assetB, config: clone(config) });
      return [[1, 2, 2, 2, 2, 10]];
    },
    getMarketClosePrices: async (assetA: any, assetB: any, config: any) => {
      calls.marketClosePrices.push({ assetA, assetB, config: clone(config) });
      return [2];
    }
  });
  registerMock(lpSourcePath, {
    discoverPoolAssets: async (poolId: any, config: any) => {
      calls.poolAssets.push({ poolId, config: clone(config) });
      return ['1.3.0', '1.3.100'];
    },
    getLpCandlesForPool: async (poolId: any, assetA: any, assetB: any, config: any) => {
      calls.lpCandles.push({ poolId, assetA, assetB, config: clone(config) });
      return [[2, 3, 3, 3, 3, 4]];
    },
    getLpClosePricesForPool: async (poolId: any, assetA: any, assetB: any, config: any) => {
      calls.lpClosePrices.push({ poolId, assetA, assetB, config: clone(config) });
      return [3];
    }
  });

  clearModule(kibanaPricePath);

  return {
    calls,
    cleanup() {
      clearModule(kibanaPricePath);
      clearModule(chainQueriesPath);
      clearModule(marketCandlesPath);
      clearModule(lpSourcePath);
    },
    kibanaPriceSource: require('../modules/kibana_price_source')
  };
}

async function testKibanaPriceSource() {
  console.log('  kibana_price_source...');

  const { calls, cleanup, kibanaPriceSource } = createKibanaHarness();

  try {
    const marketCandles = await kibanaPriceSource.fetchMarketCandles('HONEST.USD', { lookbackHours: 12 });
    assert.deepStrictEqual(marketCandles, [[1, 2, 2, 2, 2, 10]]);
    // fetchMarketCandles requests (mpa, bts) so the returned candles are
    // BTS-per-MPA (the live feed convention).
    assert.strictEqual(calls.marketCandles[0].assetA.symbol, 'HONEST.USD');
    assert.strictEqual(calls.marketCandles[0].assetB.symbol, 'BTS');

    const marketClose = await kibanaPriceSource.fetchMarketClosePrices('HONEST.USD', {});
    assert.deepStrictEqual(marketClose, [2]);

    const lpCandles = await kibanaPriceSource.fetchLpCandles('1.19.305', 'BTS', 'HONEST.USD', { intervalSeconds: 60 });
    assert.deepStrictEqual(lpCandles, [[2, 3, 3, 3, 3, 4]]);
    assert.strictEqual(calls.lpCandles[0].poolId, '1.19.305');

    const lpClose = await kibanaPriceSource.fetchLpClosePrices(305, 'BTS', 'HONEST.USD', {});
    assert.deepStrictEqual(lpClose, [3]);

    const poolAssets = await kibanaPriceSource.fetchPoolAssets(305, { lookbackHours: 4 });
    assert.deepStrictEqual(poolAssets, ['1.3.0', '1.3.100']);

    const history = await kibanaPriceSource.fetchTrendHistoryCandles('HONEST.USD', { intervalSeconds: 900, lookbackHours: 8 });
    assert.strictEqual(history.candleCount, 1);
    assert.deepStrictEqual(history.closePrices, [2]);
    assert.strictEqual(history.intervalSeconds, 900);
    assert.strictEqual(history.lookbackHours, 8);
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

function createLiquidityHarness() {
  const bitsharesPath = require.resolve('../modules/bitshares_client');
  const bridgePath = require.resolve('../modules/dexbot_bridge');
  const poolsPath = require.resolve('../modules/liquidity_pools');
  const sharedBitShares = { name: 'shared-bitshares-client' };
  const calls = {
    pool: null as any,
    price: null as any
  };

  registerMock(bitsharesPath, {
    BitShares: sharedBitShares
  });
  registerMock(bridgePath, {
    getDexbot2Root: () => '/tmp',
    loadDexbotOrderSystemUtils: () => ({
      cloneMap: (value: any) => value,
      deepFreeze: (value: any) => value,
      derivePoolPrice: (...args: any[]) => {
        calls.pool = args;
        return 'pool-price';
      },
      derivePrice: (...args: any[]) => {
        calls.price = args;
        return 'derived-price';
      },
      loadAmaCenterPrice: () => null,
      lookupAsset: () => null
    }),
    requireDexbot2Module: () => null
  });

  clearModule(poolsPath);

  return {
    calls,
    cleanup() {
      clearModule(poolsPath);
      clearModule(bridgePath);
      clearModule(bitsharesPath);
    },
    pools: require('../modules/liquidity_pools')
  };
}

function testLiquidityPoolsWrapper() {
  console.log('  liquidity_pools...');

  const { calls, cleanup, pools } = createLiquidityHarness();

  try {
    assert.strictEqual(pools.derivePoolPrice('HONEST.USD', 'BTS'), 'pool-price');
    assert.deepStrictEqual(calls.pool, [{ name: 'shared-bitshares-client' }, 'HONEST.USD', 'BTS']);

    assert.strictEqual(pools.derivePrice('HONEST.USD', 'BTS', 'pool'), 'derived-price');
    assert.deepStrictEqual(calls.price, [{ name: 'shared-bitshares-client' }, 'HONEST.USD', 'BTS', 'pool']);

    const helper = pools.createDexbotPoolHelper();
    assert.strictEqual(helper.derivePoolPrice('HONEST.USD', 'BTS'), 'pool-price');
    assert.strictEqual(typeof helper.lookupAsset, 'function');
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

runEsmMockStages(
  ['discovery-feed', 'decision-loop', 'kibana', 'liquidity-pools'],
  async (stage: string) => {
    if (stage === 'discovery-feed') {
      await testPositionDiscoveryAndFeedSource();
      return;
    }
    if (stage === 'decision-loop') {
      await testDecisionLoop();
      return;
    }
    if (stage === 'kibana') {
      await testKibanaPriceSource();
      return;
    }
    if (stage === 'liquidity-pools') {
      testLiquidityPoolsWrapper();
      return;
    }
    throw new Error(`Unknown stage: ${stage}`);
  }
);
