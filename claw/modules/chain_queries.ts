

import * as client from './bitshares_client.js';
const { BitShares, waitForConnected } = client;
import { loadDexbotOrderSystemUtils, loadDexbotOrderUtils } from './dexbot_bridge.js';
import { normalizeAssetRef } from '../../modules/utils/asset_symbols.js';
function getDexbotSystem() {
  return loadDexbotOrderSystemUtils();
}

function getBlockchainToFloat() {
  return loadDexbotOrderUtils().blockchainToFloat;
}

async function dbCall(method: any, args: any[] = []) {
  await waitForConnected();

  if (BitShares?.db && typeof BitShares.db[method] === 'function') {
    return BitShares.db[method](...args);
  }

  if (BitShares?.db && typeof BitShares.db.call === 'function') {
    return BitShares.db.call(method, args);
  }

  throw new Error(`BitShares database method not available: ${method}`);
}

function toAssetMap(assetList: any[] = []) {
  const assetMap = new Map();
  for (const asset of assetList) {
    if (asset && asset.id) {
      assetMap.set(asset.id, asset);
    }
  }
  return assetMap;
}

async function getDynamicGlobalProperties() {
  return dbCall('get_dynamic_global_properties');
}

async function getAsset(symbolOrId: any) {
  // Symbols arrive from a user-supplied `pair: "BASE/QUOTE"` option; the chain
  // lookup is case-sensitive, so canonicalize before the id test and both
  // lookup paths.
  const ref = normalizeAssetRef(symbolOrId);
  if (/^1\.3\.\d+$/.test(ref)) {
    const assets = await dbCall('get_assets', [[ref]]);
    return assets[0] || null;
  }

  try {
    return await getDexbotSystem().lookupAsset(BitShares, ref);
  } catch {
    const assets = await dbCall('lookup_asset_symbols', [[ref]]);
    return assets[0] || null;
  }
}

async function getObjects(objectIds: any) {
  return dbCall('get_objects', [objectIds]);
}

async function getAssetPrecision(symbolOrId: any) {
  const asset = await getAsset(symbolOrId);
  if (!asset || typeof asset.precision !== 'number') {
    throw new Error(`Could not resolve asset precision for ${symbolOrId}`);
  }
  return asset.precision;
}

async function getBitassetData(symbolOrId: any) {
  const asset = await getAsset(symbolOrId);
  if (!asset || !asset.bitasset_data_id) {
    return null;
  }

  const objects = await getObjects([asset.bitasset_data_id]);
  return objects[0] || null;
}

async function getBackingAsset(symbolOrId: any) {
  const bitassetData = await getBitassetData(symbolOrId);
  const backingAssetId = bitassetData?.options?.short_backing_asset;

  if (!backingAssetId) {
    return null;
  }

  return getAsset(backingAssetId);
}

async function getFullAccount(accountNameOrId: any) {
  const result = await dbCall('get_full_accounts', [[accountNameOrId], false]);
  return result[0] ? result[0][1] : null;
}

async function resolveAccountId(accountNameOrId: any) {
  if (/^1\.2\.\d+$/.test(accountNameOrId)) {
    return accountNameOrId;
  }

  const full = await getFullAccount(accountNameOrId);
  return full && full.account ? full.account.id : null;
}

async function resolveAccountName(accountNameOrId: any) {
  if (!/^1\.2\.\d+$/.test(accountNameOrId)) {
    return accountNameOrId;
  }

  const full = await getFullAccount(accountNameOrId);
  return full && full.account ? full.account.name : null;
}

async function readOpenOrders(accountNameOrId: any) {
  const full = await getFullAccount(accountNameOrId);
  return full && Array.isArray(full.limit_orders) ? full.limit_orders : [];
}

async function getBalances(accountNameOrId: any) {
  const full = await getFullAccount(accountNameOrId);
  if (!full || !Array.isArray(full.balances) || full.balances.length === 0) {
    return {};
  }

  const assetIds = full.balances.map((entry: any) => entry.asset_type).filter(Boolean);
  const assets = await dbCall('get_assets', [assetIds]);
  const assetMap = toAssetMap(assets);
  const blockchainToFloat = getBlockchainToFloat();

  const balances: Record<string, any> = {};
  for (const balance of full.balances) {
    const asset = assetMap.get(balance.asset_type);
    if (!asset) {
      continue;
    }

    balances[asset.symbol] = blockchainToFloat(balance.balance, asset.precision);
  }
  return balances;
}

async function getOrderBook(baseSymbol: any, quoteSymbol: any, limit = 10) {
  return dbCall('get_order_book', [baseSymbol, quoteSymbol, limit]);
}

async function getTicker(baseSymbol: any, quoteSymbol: any) {
  return dbCall('get_ticker', [baseSymbol, quoteSymbol]);
}

async function getCallOrders(assetSymbolOrId: any, limit = 20) {
  return dbCall('get_call_orders', [assetSymbolOrId, limit]);
}

async function listAssets(lowerBoundSymbol: any = 'A', limit = 100) {
  return dbCall('list_assets', [lowerBoundSymbol, limit]);
}

export { dbCall, getAsset, getBackingAsset, getBitassetData, getAssetPrecision, getBalances, getCallOrders, getDynamicGlobalProperties, getFullAccount, getObjects, getOrderBook, getTicker, listAssets, readOpenOrders, resolveAccountId, resolveAccountName }

