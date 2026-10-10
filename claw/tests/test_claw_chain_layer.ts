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

function createQueriesHarness() {
  const queriesPath = require.resolve('../modules/chain_queries');
  const bitsharesClientPath = require.resolve('../modules/bitshares_client');
  const dexbotBridgePath = require.resolve('../modules/dexbot_bridge');

  const calls = {
    dbCall: [] as Array<{ args: unknown; method: string }>,
    lookupAsset: [] as string[],
    waitForConnected: 0
  };

  const assets = {
    '1.3.0': { id: '1.3.0', precision: 5, symbol: 'BTS' },
    '1.3.100': {
      bitasset_data_id: '2.4.100',
      id: '1.3.100',
      precision: 5,
      symbol: 'HONEST.USD'
    },
    '1.3.101': {
      bitasset_data_id: '2.4.101',
      id: '1.3.101',
      precision: 5,
      symbol: 'FALLBACK.ASSET'
    }
  };

  const objects = {
    '2.4.100': {
      current_feed_publication_time: '2026-03-31T00:00:00',
      options: { short_backing_asset: '1.3.0' }
    },
    '2.4.101': {
      current_feed_publication_time: '2026-03-31T00:00:00',
      options: { short_backing_asset: '1.3.0' }
    }
  };

  const account = {
    account: { id: '1.2.345', name: 'alice' },
    balances: [
      { asset_type: '1.3.100', balance: 1234000 },
      { asset_type: '1.3.0', balance: 500000 }
    ],
    call_orders: [
      {
        call_price: { quote: { asset_id: '1.3.100' } },
        collateral: 2500000,
        debt: 1000000
      }
    ],
    limit_orders: [{ id: '1.7.1' }]
  };

  registerMock(bitsharesClientPath, {
    BitShares: {
      db: {
        get_dynamic_global_properties: async () => ({
          head_block_number: 100
        }),
        get_assets: async (ids: any[]) => ids.map((id: any) => assets[id as keyof typeof assets]).filter((x: any) => x),
        get_objects: async (ids: any[]) => ids.map((id: any) => objects[id as keyof typeof objects] || null),
        call: async (method: string, args: any) => {
          calls.dbCall.push({ args: clone(args), method });

          if (method === 'lookup_asset_symbols') {
            return args[0].map((symbol: any) => {
              if (symbol === 'FALLBACK') {
                return assets['1.3.101'];
              }
              return null;
            }).filter((x: any) => x);
          }

          if (method === 'get_full_accounts') {
            return [[args[0][0], account]];
          }

          if (method === 'get_ticker') {
            return { args, method, source: 'ticker' };
          }

          throw new Error(`Unexpected db call: ${method}`);
        }
      }
    },
    waitForConnected: async () => {
      calls.waitForConnected += 1;
    }
  });

  registerMock(dexbotBridgePath, {
    loadDexbotOrderSystemUtils: () => ({
      lookupAsset: async (_bitshares: any, symbolOrId: string) => {
        calls.lookupAsset.push(symbolOrId);
        if (symbolOrId === 'FALLBACK') {
          throw new Error('lookup failure');
        }
        if (symbolOrId === 'HONEST.USD') {
          return assets['1.3.100'];
        }
        if (symbolOrId === 'BTS') {
          return assets['1.3.0'];
        }
        return null;
      }
    }),
    loadDexbotOrderUtils: () => ({
      blockchainToFloat: (amount: number, precision: number) => Number(amount) / (10 ** precision)
    })
  });

  clearModule(queriesPath);
  const queries = require('../modules/chain_queries');

  return {
    calls,
    cleanup() {
      clearModule(queriesPath);
      clearModule(bitsharesClientPath);
      clearModule(dexbotBridgePath);
    },
    queries
  };
}

async function testChainQueries() {
  console.log('  chain_queries...');

  const { calls, cleanup, queries } = createQueriesHarness();

  try {
    const props = await queries.getDynamicGlobalProperties();
    assert.strictEqual(props.head_block_number, 100);
    assert.strictEqual(calls.waitForConnected, 1);

    const ticker = await queries.getTicker('HONEST.USD', 'BTS');
    assert.strictEqual(ticker.source, 'ticker');
    assert.ok(calls.dbCall.some((entry) => entry.method === 'get_ticker'));

    const byId = await queries.getAsset('1.3.100');
    assert.strictEqual(byId.symbol, 'HONEST.USD');

    const bySymbol = await queries.getAsset('HONEST.USD');
    assert.strictEqual(bySymbol.id, '1.3.100');

    const fallbackAsset = await queries.getAsset('FALLBACK');
    assert.strictEqual(fallbackAsset.id, '1.3.101');
    assert.ok(calls.lookupAsset.includes('FALLBACK'));

    const precision = await queries.getAssetPrecision('HONEST.USD');
    assert.strictEqual(precision, 5);

    const backing = await queries.getBackingAsset('HONEST.USD');
    assert.strictEqual(backing.symbol, 'BTS');

    const balances = await queries.getBalances('alice');
    assert.deepStrictEqual(balances, {
      BTS: 5,
      'HONEST.USD': 12.34
    });

    assert.strictEqual(await queries.resolveAccountId('alice'), '1.2.345');
    assert.strictEqual(await queries.resolveAccountId('1.2.345'), '1.2.345');
    assert.strictEqual(await queries.resolveAccountName('1.2.345'), 'alice');
    assert.strictEqual(await queries.resolveAccountName('alice'), 'alice');
    assert.deepStrictEqual(await queries.readOpenOrders('alice'), [{ id: '1.7.1' }]);
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

function createBroadcastHarness() {
  const broadcastPath = require.resolve('../modules/chain_broadcast');
  const bitsharesClientPath = require.resolve('../modules/bitshares_client');
  const credentialClientPath = require.resolve('../modules/dexbot_credential_client');

  const calls = {
    accountClient: [] as Array<{ accountName: any; privateKey: any }>,
    broadcasts: [] as any[],
    daemon: {
      broadcast: [] as Array<{ accountName: any; operation: any; options: any }>,
      execute: [] as Array<{ accountName: any; operations: any; options: any }>,
      wait: [] as Array<{ timeoutMs: any; options: any }>
    },
    daemonReady: false,
    newTx: 0,
    txOps: [] as Array<{ opData: any; opName: string }>
  };

  const tx = {
    asset_settle: (opData: any) => {
      calls.txOps.push({ opData, opName: 'asset_settle' });
      return tx;
    },
    call_order_update: (opData: any) => {
      calls.txOps.push({ opData, opName: 'call_order_update' });
      return tx;
    },
    limit_order_cancel: (opData: any) => {
      calls.txOps.push({ opData, opName: 'limit_order_cancel' });
      return tx;
    },
    limit_order_create: (opData: any) => {
      calls.txOps.push({ opData, opName: 'limit_order_create' });
      return tx;
    },
    broadcast: async () => ({
      trx: {
        operation_results: [[0, '1.7.77']]
      },
      source: 'tx-broadcast'
    })
  };

  registerMock(bitsharesClientPath, {
    createAccountClient: (accountName: any, privateKey: any) => {
      calls.accountClient.push({ accountName, privateKey });
      return {
        broadcast: async (operation: any) => {
          calls.broadcasts.push(operation);
          return {
            operation,
            source: 'raw-broadcast'
          };
        },
        initPromise: Promise.resolve(),
        newTx: () => {
          calls.newTx += 1;
          return tx;
        }
      };
    }
  });

  // ESM hooks turn mock keys into synthetic named re-exports, so every name
  // chain_broadcast statically imports must exist here. The error class is a
  // minimal inline replica of the real one (requiring the real module would
  // poison the module cache and bypass the mock).
  class BroadcastUncertainError extends Error {
    code: string;
    constructor(message: string) {
      super(message);
      this.name = 'BroadcastUncertainError';
      this.code = 'BROADCAST_UNCERTAIN';
    }
  }

  registerMock(credentialClientPath, {
    BroadcastUncertainError,
    DEFAULT_BROADCAST_TIMEOUT_MS: 30000,
    isCredentialDaemonReady: () => calls.daemonReady,
    broadcastOperationViaCredentialDaemon: async (accountName: any, operation: any, options: any) => {
      calls.daemon.broadcast.push({ accountName, operation, options });
      return {
        operation,
        operation_results: [[0, '1.7.88']],
        raw: { source: 'daemon-broadcast' },
        source: 'daemon-broadcast'
      };
    },
    executeOperationsViaCredentialDaemon: async (accountName: any, operations: any, options: any) => {
      calls.daemon.execute.push({ accountName, operations, options });
      return {
        operation_results: [[0, '1.7.77']],
        raw: { source: 'daemon-execute' },
        source: 'daemon-execute'
      };
    },
    waitForCredentialDaemon: async (timeoutMs: any, options: any) => {
      calls.daemon.wait.push({ options, timeoutMs });
    }
  });

  clearModule(broadcastPath);
  const broadcast = require('../modules/chain_broadcast');

  return {
    broadcast,
    calls,
    cleanup() {
      clearModule(broadcastPath);
      clearModule(bitsharesClientPath);
      clearModule(credentialClientPath);
    }
  };
}

async function testChainBroadcast() {
  console.log('  chain_broadcast...');

  const { broadcast, calls, cleanup } = createBroadcastHarness();

  try {
    const emptyResult = await broadcast.executeOperations([], {
      accountName: 'alice',
      privateKey: 'secret'
    });
    assert.deepStrictEqual(emptyResult, {
      operation_results: [],
      raw: null,
      success: true
    });

    const txResult = await broadcast.executeOperations([
      {
        op_data: { amount: 1 },
        op_name: 'limit_order_create'
      }
    ], {
      accountName: 'alice',
      privateKey: 'secret'
    });

    assert.strictEqual(calls.accountClient[0].accountName, 'alice');
    assert.strictEqual(calls.accountClient[0].privateKey, 'secret');
    assert.strictEqual(calls.newTx, 1);
    assert.deepStrictEqual(calls.txOps[0], {
      opData: { amount: 1 },
      opName: 'limit_order_create'
    });
    assert.deepStrictEqual(txResult.operation_results, [[0, '1.7.77']]);
    assert.strictEqual(txResult.raw.source, 'tx-broadcast');

    await assert.rejects(
      broadcast.getSigningClient({ accountName: 'alice' }),
      /Credential daemon is not ready/
    );
    assert.strictEqual(calls.daemon.wait.length, 0);

    calls.daemonReady = true;
    const daemonTxResult = await broadcast.executeOperations([
      {
        op_data: { amount: 2 },
        op_name: 'limit_order_create'
      }
    ], {
      accountName: 'alice'
    });

    assert.strictEqual(calls.daemon.execute.length, 1, 'daemon-backed execute should use the daemon RPC');
    assert.strictEqual(calls.daemon.execute[0].options.requestType, 'broadcast');
    assert.strictEqual(daemonTxResult.raw.source, 'daemon-execute');

    const rawResult = await broadcast.broadcastOperation(
      { object_id: '1.7.88' },
      { accountName: 'alice' }
    );

    assert.strictEqual(calls.daemon.wait.length, 2);
    assert.strictEqual(calls.daemon.broadcast.length, 1, 'daemon-backed raw broadcast should use the daemon RPC');
    assert.strictEqual(calls.accountClient[1], undefined, 'daemon-backed raw broadcast should not create a local account client');
    assert.strictEqual(rawResult.raw.source, 'daemon-broadcast');

    assert.strictEqual(broadcast.resolveAccountName({ accountName: 'alice' }), 'alice');
    assert.strictEqual(broadcast.resolveAccountName({}), null);

    await assert.rejects(
      broadcast.executeOperations([{ op_name: 'limit_order_create' }], {
        accountName: 'alice',
        privateKey: 'secret'
      }),
      /Each operation requires op_name and op_data/
    );

    await assert.rejects(
      broadcast.executeOperations([{ op_data: { amount: 1 }, op_name: 'unsupported_operation' }], {
        accountName: 'alice',
        privateKey: 'secret'
      }),
      /Transaction builder does not support unsupported_operation/
    );

    await assert.rejects(
      broadcast.executeOperations([{ op_data: { amount: 1 }, op_name: 'limit_order_create' }], {
        privateKey: 'secret'
      }),
      /accountName is required/
    );
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

function createActionsHarness() {
  const actionsPath = require.resolve('../modules/chain_actions');
  const bitsharesClientPath = require.resolve('../modules/bitshares_client');
  const chainBroadcastPath = require.resolve('../modules/chain_broadcast');
  const chainQueriesPath = require.resolve('../modules/chain_queries');
  const dexbotBridgePath = require.resolve('../modules/dexbot_bridge');

  const calls = {
    buildUpdateOrderOp: [] as string[],
    executeOperations: [] as any[],
    resolveAccountId: [] as string[],
    resolveAccountName: [] as string[],
    subscribe: [] as any[],
    unsubscribe: [] as any[],
    getAsset: [] as string[],
    getBackingAsset: [] as string[],
    getFullAccount: [] as string[],
    getOpenOrders: [] as string[],
    getMpaPosition: [] as any[],
    listenCallbacks: [] as any[]
  };

  const assets = {
    BTS: { id: '1.3.0', precision: 5, symbol: 'BTS' },
    '1.3.0': { id: '1.3.0', precision: 5, symbol: 'BTS' },
    '1.3.100': {
      bitasset_data_id: '2.4.100',
      id: '1.3.100',
      precision: 5,
      symbol: 'HONEST.USD'
    },
    'HONEST.USD': {
      bitasset_data_id: '2.4.100',
      id: '1.3.100',
      precision: 5,
      symbol: 'HONEST.USD'
    }
  };

  const account = {
    account: { id: '1.2.345', name: 'alice' },
    call_orders: [
      {
        call_price: { quote: { asset_id: '1.3.100' } },
        collateral: 2500000,
        debt: 1000000
      }
    ],
    limit_orders: [
      { id: '1.7.1', for_sale: 500000 }
    ]
  };

  const subscribeHandlers: any[] = [];

  registerMock(bitsharesClientPath, {
    BitShares: {
      subscribe: (topic: any, callback: any, accountName: any) => {
        calls.subscribe.push({ accountName, topic });
        subscribeHandlers.push(callback);
      },
      unsubscribe: (topic: any, _callback: any, accountName: any) => {
        calls.unsubscribe.push({ accountName, topic });
        return Promise.resolve();
      }
    }
  });

  registerMock(chainBroadcastPath, {
    executeOperations: async (operations: any, options: any) => {
      calls.executeOperations.push({ options: clone(options), operations: clone(operations) });
      return {
        operation_results: [[0, '1.7.500']],
        source: 'executeOperations'
      };
    }
  });

  registerMock(chainQueriesPath, {
    getAsset: async (symbolOrId: string) => {
      calls.getAsset.push(symbolOrId);
      return assets[symbolOrId as keyof typeof assets] || null;
    },
    getBackingAsset: async (symbolOrId: string) => {
      calls.getBackingAsset.push(symbolOrId);
      return assets.BTS;
    },
    getFullAccount: async (accountNameOrId: string) => {
      calls.getFullAccount.push(accountNameOrId);
      return account;
    },
    readOpenOrders: async (accountNameOrId: string) => {
      calls.getOpenOrders.push(accountNameOrId);
      return account.limit_orders;
    },
    resolveAccountId: async (accountNameOrId: string) => {
      calls.resolveAccountId.push(accountNameOrId);
      return accountNameOrId === 'alice' ? '1.2.345' : accountNameOrId;
    },
    resolveAccountName: async (accountNameOrId: string) => {
      calls.resolveAccountName.push(accountNameOrId);
      if (accountNameOrId === '1.2.345') {
        return 'alice';
      }
      return accountNameOrId;
    }
  });

  registerMock(dexbotBridgePath, {
    loadDexbotOrderConstants: () => ({
      FEE_PARAMETERS: { GRAPHENE_COLLATERAL_RATIO_DENOM: 1000 }
    }),
    loadDexbotOrderUtils: () => ({
      floatToBlockchainInt: (value: number, precision: number) => Math.round(Number(value) * (10 ** precision))
    }),
    requireDexbot2Module: (modulePath: string) => {
      calls.buildUpdateOrderOp.push(modulePath);
      return {
        buildUpdateOrderOp: async (accountName: string, orderId: string, newParams: any, cachedOrder: any) => ({
          op: {
            op_data: {
              accountName,
              cachedOrder: clone(cachedOrder),
              newParams: clone(newParams),
              orderId
            },
            op_name: 'limit_order_update'
          }
        })
      };
    }
  });

  clearModule(actionsPath);
  const actions = require('../modules/chain_actions');

  return {
    actions,
    calls,
    cleanup() {
      clearModule(actionsPath);
      clearModule(bitsharesClientPath);
      clearModule(chainBroadcastPath);
      clearModule(chainQueriesPath);
      clearModule(dexbotBridgePath);
    },
    subscribeHandlers
  };
}

async function testChainActions() {
  console.log('  chain_actions...');

  const { actions, calls, cleanup, subscribeHandlers } = createActionsHarness();

  try {
    const createOp = await actions.buildCreateLimitOrderOperation({
      accountName: 'alice',
      amountToSell: 1.25,
      expiration: '2026-01-01T00:00:00',
      fillOrKill: true,
      minToReceive: 2.5,
      receiveAsset: 'BTS',
      sellAsset: 'HONEST.USD'
    });

    assert.strictEqual(createOp.op_name, 'limit_order_create');
    assert.strictEqual(createOp.op_data.seller, '1.2.345');
    assert.strictEqual(createOp.op_data.amount_to_sell.amount, 125000);
    assert.strictEqual(createOp.op_data.min_to_receive.amount, 250000);
    assert.strictEqual(createOp.op_data.expiration, '2026-01-01T00:00:00');
    assert.strictEqual(createOp.op_data.fill_or_kill, true);

    await assert.rejects(
      actions.buildCreateLimitOrderOperation({
        accountName: 'alice',
        amountToSell: 0.000001,
        minToReceive: 2,
        receiveAsset: 'BTS',
        sellAsset: 'HONEST.USD'
      }),
      /Limit order amounts must round to positive blockchain integers/
    );

    const borrowOp = await actions.buildBorrowMpaOperation({
      accountName: 'alice',
      collateralDelta: 3.4,
      debtDelta: 1.2,
      mpaAsset: 'HONEST.USD',
      targetCollateralRatio: 2.2
    });

    assert.strictEqual(borrowOp.op_name, 'call_order_update');
    assert.strictEqual(borrowOp.op_data.funding_account, '1.2.345');
    assert.strictEqual(borrowOp.op_data.delta_debt.amount, 120000);
    assert.strictEqual(borrowOp.op_data.delta_collateral.amount, 340000);
    assert.strictEqual(borrowOp.op_data.extensions.target_collateral_ratio, 2200);

    await assert.rejects(
      actions.buildBorrowMpaOperation({
        accountName: 'alice',
        collateralDelta: 0,
        debtDelta: 0,
        mpaAsset: 'HONEST.USD'
      }),
      /At least one of debtDelta or collateralDelta must be non-zero/
    );

    const settleOp = await actions.buildSettleMpaOperation({
      accountName: 'alice',
      amount: 1.5,
      mpaAsset: 'HONEST.USD'
    });

    assert.strictEqual(settleOp.op_name, 'asset_settle');
    assert.strictEqual(settleOp.op_data.account, '1.2.345');
    assert.strictEqual(settleOp.op_data.amount.amount, 150000);

    const updateOp = await actions.buildUpdateLimitOrderOperation({
      accountName: 'alice',
      cachedOrder: { id: '1.7.9' },
      newParams: { newPrice: 2.5 },
      orderId: '1.7.9'
    });

    assert.strictEqual(calls.buildUpdateOrderOp[0], 'modules/chain_orders.js');
    assert.strictEqual(updateOp.op.op_name, 'limit_order_update');
    assert.strictEqual(updateOp.op.op_data.orderId, '1.7.9');
    assert.deepStrictEqual(updateOp.op.op_data.newParams, { newPrice: 2.5 });

    await actions.createLimitOrder({
      accountName: 'alice',
      amountToSell: 1,
      minToReceive: 2,
      receiveAsset: 'BTS',
      sellAsset: 'HONEST.USD'
    });
    assert.strictEqual(calls.executeOperations[0].operations[0].op_name, 'limit_order_create');

    await actions.executeBatch({
      operations: [
        {
          op_data: { foo: 'bar' },
          op_name: 'limit_order_cancel'
        }
      ]
    });
    assert.strictEqual(calls.executeOperations[1].operations[0].op_name, 'limit_order_cancel');

    const openOrders = await actions.getOpenOrders('alice');
    assert.deepStrictEqual(openOrders, [{ id: '1.7.1', for_sale: 500000 }]);

    const mpaPosition = await actions.getMpaPosition('alice', 'HONEST.USD');
    assert.strictEqual(mpaPosition.call_price.quote.asset_id, '1.3.100');

    const received: any[] = [];
    const unsubscribeFirst = await actions.listenForFills('alice', async (fills: any) => {
      received.push({ fills, source: 'first' });
    });
    const unsubscribeSecond = await actions.listenForFills('1.2.345', async (fills: any) => {
      received.push({ fills, source: 'second' });
    });

    assert.strictEqual(calls.subscribe.length, 1);
    assert.strictEqual(subscribeHandlers.length, 1);

    subscribeHandlers[0]([
      {
        op: [
          4,
          {
            order_id: '1.7.1',
            pays: { asset_id: '1.3.100', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 200000 }
          }
        ]
      },
      {
        op: [
          1,
          {
            order_id: 'ignored'
          }
        ]
      }
    ]);

    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].fills.length, 1);
    assert.strictEqual(received[0].fills[0].op[1].order_id, '1.7.1');

    await unsubscribeFirst();
    assert.strictEqual(calls.unsubscribe.length, 0);
    await unsubscribeSecond();
    assert.strictEqual(calls.unsubscribe.length, 1);

    subscribeHandlers[0]([
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
    assert.strictEqual(received.length, 2);
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

runEsmMockStages(
  ['chain-queries', 'chain-broadcast', 'chain-actions'],
  async (stage: string) => {
    if (stage === 'chain-queries') {
      await testChainQueries();
      return;
    }
    if (stage === 'chain-broadcast') {
      await testChainBroadcast();
      return;
    }
    if (stage === 'chain-actions') {
      await testChainActions();
      return;
    }
    throw new Error(`Unknown stage: ${stage}`);
  }
);
