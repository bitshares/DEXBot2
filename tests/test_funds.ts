#!/usr/bin/env node
/**
 * Test script: show on-chain free balances and amounts locked in open orders
 * for the configured account.
 */

const { BitShares } = require('../modules/bitshares_client');
const { getErrorMessage } = require('../modules/utils/errors');

const ACCOUNT_NAME = process.env.BITSHARES_TEST_ACCOUNT || '<account-name>';
const STRICT_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS_STRICT === '1';
const OVERALL_TIMEOUT_MS = Number(process.env.BITSHARES_FUNDS_TEST_TIMEOUT_MS) || 20000;

if (!process.env.RUN_LIVE_BITSHARES_TESTS) {
    console.log('Skipping live funds test.');
    console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
    process.exit(0);
}

const assetPrecisions: any = {};

function blockchainToFloat(amount, precision) {
    return Number(amount) / Math.pow(10, precision);
}

function formatNumber(n, precision) {
    // Format with grouping (commas) and dot decimal. Cap displayed decimals to 4
    const pd = Math.max(0, Math.min(4, precision));
    try {
        return new Intl.NumberFormat('en-US', { minimumFractionDigits: pd, maximumFractionDigits: pd }).format(Number(n));
    } catch (e) {
        return Number(n).toFixed(pd);
    }
}

async function getAssetPrecision(assetId) {
    if (assetPrecisions[assetId]) return assetPrecisions[assetId];
    try {
        const asset = await BitShares.assets[assetId];
        assetPrecisions[assetId] = asset.precision;
        return asset.precision;
    } catch (e) {
        throw new Error(`Failed to get precision for ${assetId}: ${(e as any)?.message ?? e}`);
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

// Build and print a table and a small ASCII stacked-bar chart for top N assets
async function main() {
    console.log('Connecting to BitShares...');
    try {
        await BitShares.connect();
        console.log('Connected!\n');
    } catch (err) {
        const message = err && getErrorMessage(err) ? getErrorMessage(err) : err;
        if (!STRICT_LIVE_TEST) {
            console.log('⚠️  Skipping live funds test: could not connect to BitShares');
            console.log('   Error:', message);
            process.exit(0);
            return;
        }
        throw err;
    }

    const account = await BitShares.accounts[ACCOUNT_NAME];
    if (!account) {
        console.error(`Account ${ACCOUNT_NAME} not found`);
        process.exit(1);
    }

    console.log(`Account: ${ACCOUNT_NAME} (${account.id})\n`);

    // Use centralized helper which returns free + locked (for_sale) amounts per asset
    const { getOnChainAssetBalances } = require('../modules/chain_orders');
    const balancesMap = await getOnChainAssetBalances(account.id); // assetRef -> { assetId, symbol, precision, freeRaw, lockedRaw, free, locked, total }

    const rows = [];
    for (const k of Object.keys(balancesMap || {})) {
        const info = balancesMap[k] || {};
        rows.push({ aid: info.assetId || k, symbol: info.symbol || k, precision: info.precision, freeRaw: info.freeRaw || 0, lockedRaw: info.lockedRaw || 0, freeHuman: info.free || 0, lockedHuman: info.locked || 0, totalHuman: info.total || 0, btsValue: null, priceInBTS: null });
    }

    // Sort by total descending for table and visualization
    rows.sort((a, b) => b.totalHuman - a.totalHuman);

    console.log('Account funds summary:\n');
    console.log('Asset'.padEnd(30) + ' | ' + 'Free'.padStart(18) + ' | ' + 'Locked (orders)'.padStart(18) + ' | ' + 'Total'.padStart(18));
    console.log('-'.repeat(30) + '-+-' + '-'.repeat(18) + '-+-' + '-'.repeat(18) + '-+-' + '-'.repeat(18));
    for (const r of rows) {
        const name = `${r.symbol} (${r.aid})`.padEnd(30);
        const freeStr = formatNumber(r.freeHuman, Math.min(8, Math.max(2, r.precision))).padStart(18);
        const lockedStr = formatNumber(r.lockedHuman, Math.min(8, Math.max(2, r.precision))).padStart(18);
        const totalStr = formatNumber(r.totalHuman, Math.min(8, Math.max(2, r.precision))).padStart(18);
        console.log(`${name} | ${freeStr} | ${lockedStr} | ${totalStr}`);
    }

    // Compute BTS-equivalent price for each asset using limit orders vs BTS
    const BTS_ID = '1.3.0';

    async function parseOrderPriceAndSize(order) {
        // return { price: number (in quote per base), size: baseHuman, type: 'SELL'|'BUY' }
        if (!order || !order.sell_price) return null;
        const { base, quote } = order.sell_price;
        const basePrec = await getAssetPrecision(base.asset_id);
        const quotePrec = await getAssetPrecision(quote.asset_id);
        const baseAmt = Number(base.amount);
        const quoteAmt = Number(quote.amount);
        if (!baseAmt || !quoteAmt) return null;
        const price = (quoteAmt / baseAmt) * Math.pow(10, basePrec - quotePrec);
        const size = blockchainToFloat(Number(order.for_sale || 0), basePrec);
        // Determine type relative to a requested asset externally
        return { price, size, baseId: String(base.asset_id), quoteId: String(quote.asset_id) };
    }

    // Centralized derivePrice (quote per base) - use shared helper in modules/order/price
    async function derivePriceInBTS(assetId) {
        if (assetId === BTS_ID) return 1;
        try {
            const derivePrice = require('../modules/order/utils/system').derivePrice;
            if (typeof derivePrice === 'function') {
                // derivePrice expects symbols or ids; we pass assetId and BTS_ID
                return await derivePrice(BitShares, assetId, BTS_ID);
            }
        } catch (e) {}
        return null;
    }

    // Enrich rows with priceInBTS and btsValue
    for (const r of rows) {
        const price = await derivePriceInBTS(r.aid);
        r.priceInBTS = price; // may be null
        r.btsValue = price ? r.totalHuman * price : null;
    }

    // ASCII visualization for top N assets by BTS value
    const topN = 10;
    const byBTS = rows.filter(r => r.btsValue !== null).sort((a, b) => b.btsValue - a.btsValue);
    const top = byBTS.slice(0, topN);
    if (top.length > 0) {
        const MAX_BAR = 40;
        const maxVal = top[0].btsValue;
        console.log('\nTop ' + top.length + ' assets by BTS value (stacked: free=#, locked==) — BTS value shown on right:\n');
        for (const r of top) {
            const frac = r.btsValue / maxVal;
            const barLen = Math.max(1, Math.round(frac * MAX_BAR));
            const lockedLen = r.totalHuman > 0 ? Math.round((r.lockedHuman / r.totalHuman) * barLen) : 0;
            const freeLen = Math.max(0, barLen - lockedLen);
            const freeBar = '#'.repeat(freeLen);
            const lockedBar = '='.repeat(lockedLen);
            const bar = (freeBar + lockedBar).padEnd(MAX_BAR, ' ');
            const label = `${r.symbol}`.padEnd(12);
            const btsFmt = formatNumber(r.btsValue, 4).padStart(18);
            console.log(`${label} | ${bar} | ${btsFmt}`);
        }
        console.log('\nLegend: # = free balance, = = locked in open orders');
    } else {
        console.log('\nNo BTS prices available to visualize top assets.');
    }

    console.log('\nDetailed raw integers (satoshis):\n');
    for (const r of rows) {
        console.log(`${r.symbol} (${r.aid}) -> free: ${r.freeRaw}, locked: ${r.lockedRaw}, precision: ${r.precision}`);
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Error:', err && getErrorMessage(err) ? getErrorMessage(err) : err);
    process.exit(1);
});

// Safety timeout to prevent hanging (this is an integration test that connects to blockchain)
setTimeout(() => {
    const message = `Test timeout: process did not exit within ${OVERALL_TIMEOUT_MS}ms`;
    if (!STRICT_LIVE_TEST) {
        console.log(`Skipping live funds test: ${message}`);
        process.exit(0);
        return;
    }
    console.error(message);
    process.exit(1);
}, OVERALL_TIMEOUT_MS);
