#!/usr/bin/env node
/**
 * Test script: query trade history for a given account via BitShares DB APIs
 *
 * - Attempts to call BitShares.db.get_trade_history() when available
 * - Falls back to get_fill_order_history() or scans account history if needed
 * - Prints (maker order id, amount, returning asset symbol) for matching trades
 */

if (process.env.RUN_LIVE_BITSHARES_TESTS !== '1') {
    console.log('Skipping live BitShares connection test.');
    console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
    process.exit(0);
}

const { BitShares } = require('../modules/bitshares_client');
const { getErrorMessage } = require('../modules/utils/errors');

const ACCOUNT_NAME = process.env.BITSHARES_TEST_ACCOUNT || '<account-name>';

const assetPrecisions: any = {};

function blockchainToFloat(amount, precision) {
    return Number(amount) / Math.pow(10, precision);
}

// Scan entire account history (best-effort) to find fill_order operations where this account acted as maker
async function scanAccountHistoryForFills(accountId, baseId = null, quoteId = null, limit = 100) {
    if (!accountId) return;

    let history = null;

    // Use BitShares.history.get_account_history which is the correct API
    // Signature: get_account_history(account_id, start, limit, stop)
    // start/stop are operation history object IDs (1.11.x), use '1.11.0' for boundaries
    try {
        history = await BitShares.history.get_account_history(accountId, '1.11.0', limit, '1.11.0');
    } catch (e) {
        // Silently fail - no history available
    }

    if (!history || !Array.isArray(history) || history.length === 0) {
        return; // No history found, exit silently
    }

    // Filter for fill_order operations (op type 4) where account is maker
    const fills = [];
    for (const entry of history) {
        // Entry shape: { id, op: [op_type, op_data], result, block_num, ... }
        const opData = entry.op;
        if (!Array.isArray(opData) || opData[0] !== 4) continue; // skip non-fill

        const fillData = opData[1];
        if (!fillData) continue;

        // Only include fills where this account is the maker
        if (!fillData.is_maker) continue;

        // Optionally filter by trading pair
        if (baseId && quoteId) {
            const paysAsset = fillData.pays?.asset_id;
            const receivesAsset = fillData.receives?.asset_id;
            const pairMatch = (paysAsset === baseId && receivesAsset === quoteId) ||
                              (paysAsset === quoteId && receivesAsset === baseId);
            if (!pairMatch) continue;
        }

        fills.push({
            orderId: fillData.order_id,
            pays: fillData.pays,
            receives: fillData.receives,
            blockNum: entry.block_num,
            blockTime: entry.block_time,
            isMaker: fillData.is_maker
        });
    }

    if (fills.length === 0) {
        return; // No matching fills, exit silently
    }

    console.log(`\nFound ${fills.length} fill(s) for account ${accountId}:`);
    for (const fill of fills) {
        const paysAmount = fill.pays ? Number(fill.pays.amount) : 0;
        const receivesAmount = fill.receives ? Number(fill.receives.amount) : 0;
        const paysAssetId = fill.pays?.asset_id;
        const receivesAssetId = fill.receives?.asset_id;

        let paysPrecision = 5, receivesPrecision = 5;
        let paysSymbol = paysAssetId, receivesSymbol = receivesAssetId;

        if (paysAssetId) {
            paysPrecision = await getAssetPrecision(paysAssetId);
            paysSymbol = await getAssetSymbol(paysAssetId);
        }
        if (receivesAssetId) {
            receivesPrecision = await getAssetPrecision(receivesAssetId);
            receivesSymbol = await getAssetSymbol(receivesAssetId);
        }

        const humanPays = blockchainToFloat(paysAmount, paysPrecision);
        const humanReceives = blockchainToFloat(receivesAmount, receivesPrecision);

        console.log(`  Order ${fill.orderId}: paid ${humanPays} ${paysSymbol}, received ${humanReceives} ${receivesSymbol} (block ${fill.blockNum}, ${fill.blockTime})`);
    }
}

async function getAssetPrecision(assetId) {
    if (assetPrecisions[assetId]) return assetPrecisions[assetId];
    try {
        const asset = await BitShares.assets[assetId];
        assetPrecisions[assetId] = asset.precision;
        return asset.precision;
    } catch (e) {
        return 5;
    }
}

async function getAssetSymbol(assetId) {
    try {
        const asset = await BitShares.assets[assetId];
        return asset.symbol;
    } catch (e) {
        return String(assetId);
    }
}

async function main() {
    console.log('Connecting to BitShares...');
    await BitShares.connect();
    console.log('Connected!');

    // Resolve account
    const account = await BitShares.accounts[ACCOUNT_NAME];
    if (!account) {
        console.error(`Account ${ACCOUNT_NAME} not found`);
        process.exit(1);
    }
    console.log(`Using account ${ACCOUNT_NAME} (id=${account.id})`);

    // Query trade history directly from account history
    await scanAccountHistoryForFills(account.id);

    process.exit(0);
}

main().catch(err => {
    console.error('Error:', getErrorMessage(err));
    process.exit(1);
});
