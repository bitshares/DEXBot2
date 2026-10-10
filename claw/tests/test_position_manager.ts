'use strict';

const assert = require('assert');
const fs = require('fs/promises');
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

async function createHarness() {
  const managerPath = require.resolve('../modules/position_manager');
  const actionsPath = require.resolve('../modules/chain_actions');
  const queriesPath = require.resolve('../modules/chain_queries');
  const profilesPath = require.resolve('../modules/dexbot_profiles');
  const bridgePath = require.resolve('../modules/dexbot_bridge');
  const shortStrategyPath = require.resolve('../modules/short_mpa_strategy');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-position-manager-'));
  const statePath = path.join(tempDir, 'positions.json');

  const calls = {
    closeShortOnBts: [] as any[],
    listenForFills: [] as any[],
    openShortOnBts: [] as any[],
    placeTakeProfitBuyOrderOnBts: [] as any[],
    savedStates: [] as any[]
  };

  const coreAsset = { id: '1.3.0', precision: 5, symbol: 'BTS' };
  const mpaAsset = {
    bitasset_data_id: '2.4.100',
    id: '1.3.100',
    precision: 5,
    symbol: 'HONEST.USD'
  };

  let accountSnapshot: any = {
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
      calls.savedStates.push({ filePath, state: clone(state) });
      await fs.writeFile(filePath, JSON.stringify(state, null, 2));
    }
  });

  registerMock(shortStrategyPath, {
    closeShortOnBts: async (options: any) => {
      calls.closeShortOnBts.push(options);
      accountSnapshot = {
        ...accountSnapshot,
        call_orders: [],
        limit_orders: []
      };
      return {
        repayResult: {
          raw: { source: 'close-short' }
        }
      };
    },
    openShortOnBts: async (options: any) => {
      calls.openShortOnBts.push(options);
      accountSnapshot = {
        ...accountSnapshot,
        call_orders: [
          {
            borrower: '1.2.345',
            call_price: { quote: { asset_id: mpaAsset.id } },
            collateral: 2500000,
            debt: 1000000,
            id: '2.7.1'
          }
        ],
        limit_orders: [
          {
            for_sale: 1000000,
            id: '1.7.100'
          }
        ]
      };
      return {
        sellOrderResult: {
          operation_results: [[0, '1.7.100']],
          raw: { source: 'open-short' }
        }
      };
    },
    placeTakeProfitBuyOrderOnBts: async (options: any) => {
      calls.placeTakeProfitBuyOrderOnBts.push(options);
      accountSnapshot = {
        ...accountSnapshot,
        limit_orders: [
          {
            for_sale: 1000000,
            id: '1.7.100'
          },
          {
            for_sale: 2250000,
            id: '1.7.200'
          }
        ]
      };
      return {
        rebuyOrderResult: {
          operation_results: [[0, '1.7.200']],
          raw: { source: 'take-profit' }
        }
      };
    }
  });

  registerMock(actionsPath, {
    listenForFills: async (accountName: string, callback: any) => {
      calls.listenForFills.push({ accountName, callback });
      return async () => {
        calls.listenForFills.push({ accountName, type: 'unsubscribe' });
      };
    }
  });

  registerMock(queriesPath, {
    getAsset: async (symbolOrId: string) => {
      if (symbolOrId === 'BTS' || symbolOrId === coreAsset.id) {
        return coreAsset;
      }
      if (symbolOrId === 'HONEST.USD' || symbolOrId === mpaAsset.id) {
        return mpaAsset;
      }
      return null;
    },
    getBackingAsset: async () => coreAsset,
    getBalances: async () => ({ BTS: 5 }),
    getBitassetData: async () => ({
      current_feed: {
        settlement_price: {
          base: { asset_id: coreAsset.id, amount: 200000 },
          quote: { asset_id: mpaAsset.id, amount: 100000 }
        }
      },
      current_feed_publication_time: '2026-03-31T00:00:00'
    }),
    getFullAccount: async () => clone(accountSnapshot)
  });

  clearModule(managerPath);
  const { PositionManager } = require('../modules/position_manager');

  return {
    calls,
    cleanup() {
      clearModule(managerPath);
      clearModule(actionsPath);
      clearModule(queriesPath);
      clearModule(profilesPath);
      clearModule(bridgePath);
      clearModule(shortStrategyPath);
    },
    manager: new PositionManager({ statePath }),
    setAccountSnapshot(nextSnapshot: any) {
      accountSnapshot = clone(nextSnapshot);
    },
    statePath
  };
}

async function testPositionManagerLifecycle() {
  console.log('  position_manager lifecycle...');

  const { calls, cleanup, manager, setAccountSnapshot, statePath } = await createHarness();

  try {
    const planned = await manager.createShortPosition({
      accountName: 'alice',
      collateralAmount: 25,
      debtAmount: 10,
      mpaAsset: 'HONEST.USD',
      sellPriceInBts: 2.5,
      targetCollateralRatio: 2.2
    });

    assert.strictEqual(planned.status, 'planned');
    assert.strictEqual(planned.entry.sellPriceInBts, 2.5);
    assert.strictEqual(planned.entry.targetSellAmount, 10);
    assert.strictEqual(planned.entry.targetReceiveAmount, 25);
    assert.ok(planned.id.startsWith('pos_'));
    assert.strictEqual(calls.savedStates.length, 1);
    assert.strictEqual((await manager.listPositions()).length, 1);

    const loadClone = await manager.listPositions();
    loadClone[0].status = 'mutated';
    assert.strictEqual((await manager.getPosition(planned.id)).status, 'planned');

    const opened = await manager.openShort(planned.id, {
      expiration: '2026-04-01T00:00:00',
      fillOrKill: true,
      privateKey: 'secret'
    });
    assert.strictEqual(opened.status, 'entry_order_open');
    assert.strictEqual(opened.entry.orderId, '1.7.100');
    assert.strictEqual(opened.onChain.collateralRatio, 1.25);
    assert.strictEqual(calls.openShortOnBts[0].accountName, 'alice');
    assert.strictEqual(calls.openShortOnBts[0].sellPriceInBts, 2.5);

    const watchedPositionId = planned.id;
    const state = await manager.loadState();
    const watchedPosition = state.positions.find((entry: any) => entry.id === watchedPositionId);
    watchedPosition.entry.orderId = '1.7.500';
    watchedPosition.entry.orderOpen = true;
    watchedPosition.status = 'entry_order_open';
    await manager.saveState();
    setAccountSnapshot({
      balances: [{ asset_type: '1.3.0', balance: 500000 }],
      call_orders: [
        {
          borrower: '1.2.345',
          call_price: { quote: { asset_id: '1.3.100' } },
          collateral: 2500000,
          debt: 1000000,
          id: '2.7.1'
        }
      ],
      limit_orders: [
        {
          for_sale: 900000,
          id: '1.7.500'
        }
      ]
    });

    const accountState = await manager.getPosition(watchedPositionId);
    assert.strictEqual(accountState.entry.orderId, '1.7.500');

    await manager.watchAccount('alice', async (position: any, fill: any) => {
      calls.listenForFills.push({ accountName: 'alice', fill, type: 'onFill', positionId: position.id });
    });

    await calls.listenForFills.find((entry) => entry.callback)?.callback([
      {
        op: [
          4,
          {
            order_id: '1.7.500',
            pays: { asset_id: '1.3.100', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
          }
        ]
      }
    ]);

    const filled = await manager.getPosition(watchedPositionId);
    assert.strictEqual(filled.entry.fillCount, 1);
    assert.strictEqual(filled.entry.filledSellAmount, 1);
    assert.strictEqual(filled.entry.filledReceiveAmount, 2.5);
    assert.strictEqual(filled.entry.fillStatus, 'partially_filled');
    assert.strictEqual(calls.listenForFills.some((entry) => entry.type === 'onFill'), true);

    const takeProfit = await manager.placeTakeProfit(planned.id, {
      amountToCover: 10,
      buyPriceInBts: 2.25,
      privateKey: 'secret'
    });
    assert.strictEqual(takeProfit.status, 'take_profit_order_open');
    assert.strictEqual(takeProfit.exit.orderId, '1.7.200');
    assert.strictEqual(takeProfit.exit.maxBtsToSpend, 22.5);
    assert.strictEqual(calls.placeTakeProfitBuyOrderOnBts[0].accountName, 'alice');

    const closed = await manager.closePosition(planned.id, {
      amountToRepay: 10,
      privateKey: 'secret'
    });
    assert.strictEqual(closed.status, 'closed');
    assert.strictEqual(closed.lastCloseTx.source, 'close-short');
    assert.strictEqual(calls.closeShortOnBts[0].amountToRepay, 10);

    const stored = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.strictEqual(stored.positions.length >= 1, true);
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

async function testPositionManagerExitFillAndSyncTransitions() {
  console.log('  position_manager exit fill + sync transitions...');

  const { calls, cleanup, manager, setAccountSnapshot } = await createHarness();

  try {
    const planned = await manager.createShortPosition({
      accountName: 'alice',
      collateralAmount: 25,
      debtAmount: 10,
      mpaAsset: 'HONEST.USD',
      sellPriceInBts: 2.5,
      targetCollateralRatio: 2.2
    });

    await manager.openShort(planned.id, {
      expiration: '2026-04-01T00:00:00',
      privateKey: 'secret'
    });

    const unsubscribe = await manager.watchAccount('alice');
    const fillListener = calls.listenForFills.find((entry) => typeof entry.callback === 'function');

    setAccountSnapshot({
      balances: [{ asset_type: '1.3.0', balance: 500000 }],
      call_orders: [
        {
          borrower: '1.2.345',
          call_price: { quote: { asset_id: '1.3.100' } },
          collateral: 2500000,
          debt: 1000000,
          id: '2.7.1'
        }
      ],
      limit_orders: []
    });

    await fillListener.callback([
      {
        op: [
          4,
          {
            order_id: '1.7.100',
            pays: { asset_id: '1.3.100', amount: 1000000 },
            receives: { asset_id: '1.3.0', amount: 2500000 }
          }
        ]
      }
    ]);

    await manager.placeTakeProfit(planned.id, {
      amountToCover: 10,
      buyPriceInBts: 2.25,
      privateKey: 'secret'
    });

    await fillListener.callback([
      {
        op: [
          4,
          {
            order_id: '1.7.200',
            pays: { asset_id: '1.3.0', amount: 1125000 },
            receives: { asset_id: '1.3.100', amount: 500000 }
          }
        ]
      }
    ]);

    const afterExitFill = await manager.getPosition(planned.id);
    assert.strictEqual(afterExitFill.exit.fillCount, 1);
    assert.strictEqual(afterExitFill.exit.filledSellAmount, 11.25);
    assert.strictEqual(afterExitFill.exit.filledReceiveAmount, 5);
    assert.strictEqual(afterExitFill.exit.fillStatus, 'partially_filled');
    assert.strictEqual(afterExitFill.pnl.averageExitPriceInBts, 2.25);
    assert.strictEqual(afterExitFill.pnl.realizedCoverAmount, 5);
    assert.strictEqual(afterExitFill.pnl.realizedGrossPnlInBts, 1.25);

    setAccountSnapshot({
      balances: [{ asset_type: '1.3.0', balance: 500000 }],
      call_orders: [],
      limit_orders: [
        {
          for_sale: 1125000,
          id: '1.7.200'
        }
      ]
    });

    const withoutDebt = await manager.syncPosition(planned.id);
    assert.strictEqual(withoutDebt.status, 'orders_open_without_debt');
    assert.strictEqual(withoutDebt.onChain.openOrderIds.includes('1.7.200'), true);

    setAccountSnapshot({
      balances: [{ asset_type: '1.3.0', balance: 500000 }],
      call_orders: [],
      limit_orders: []
    });

    const closed = await manager.syncPosition(planned.id);
    assert.strictEqual(closed.status, 'closed');
    assert.strictEqual(closed.exit.fillStatus, 'filled_or_closed');
    assert.strictEqual(closed.exit.orderOpen, false);
    assert.strictEqual(closed.pnl.realizedGrossPnlInBts, 1.25);

    await unsubscribe();
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

runEsmMockStages(
  ['lifecycle', 'exit-fill-and-sync-transitions'],
  async (stage: string) => {
    if (stage === 'lifecycle') {
      await testPositionManagerLifecycle();
      return;
    }
    if (stage === 'exit-fill-and-sync-transitions') {
      await testPositionManagerExitFillAndSyncTransitions();
      return;
    }
    throw new Error(`Unknown stage: ${stage}`);
  }
);
