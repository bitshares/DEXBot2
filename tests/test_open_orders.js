#!/usr/bin/env node
/**
 * Test script to fetch and display open orders from the blockchain
 * for account hanzac-si, showing order ID, size, and price in a visual format.
 */

const BitShares = require('btsdex');

const ACCOUNT_NAME = 'hanzac-si';

// Asset precision lookup (will be populated from chain)
const assetPrecisions = {};

function blockchainToFloat(amount, precision) {
    return amount / Math.pow(10, precision);
}

async function getAssetPrecision(assetId) {
    if (assetPrecisions[assetId]) {
        return assetPrecisions[assetId];
    }
    try {
        const asset = await BitShares.assets[assetId];
        assetPrecisions[assetId] = asset.precision;
        return asset.precision;
    } catch (e) {
        console.error(`Failed to get precision for ${assetId}:`, e.message);
        return 5; // default
    }
}

async function getAssetSymbol(assetId) {
    try {
        const asset = await BitShares.assets[assetId];
        return asset.symbol;
    } catch (e) {
        return assetId;
    }
}

async function parseOrder(order) {
    const { sell_price, for_sale, id } = order;
    const { base, quote } = sell_price;
    
    const basePrecision = await getAssetPrecision(base.asset_id);
    const quotePrecision = await getAssetPrecision(quote.asset_id);
    const baseSymbol = await getAssetSymbol(base.asset_id);
    const quoteSymbol = await getAssetSymbol(quote.asset_id);
    
    const baseAmount = blockchainToFloat(Number(base.amount), basePrecision);
    const quoteAmount = blockchainToFloat(Number(quote.amount), quotePrecision);
    const forSaleFloat = blockchainToFloat(Number(for_sale), basePrecision);
    
    // Price = quote / base (what you receive per unit sold)
    const price = quoteAmount / baseAmount;
    
    // Determine order type based on assets
    // Assuming IOB.XRP is the "base" asset we're trading
    const isSell = baseSymbol === 'IOB.XRP';
    
    return {
        id,
        type: isSell ? 'SELL' : 'BUY',
        size: forSaleFloat,
        sizeAsset: baseSymbol,
        price: price,
        priceDisplay: isSell ? price : (1 / price),
        baseSymbol,
        quoteSymbol,
        rawBase: base,
        rawQuote: quote,
        rawForSale: for_sale
    };
}

async function main() {
    console.log('Connecting to BitShares...');
    await BitShares.connect();
    console.log('Connected!\n');
    
    // Get account
    const account = await BitShares.accounts[ACCOUNT_NAME];
    if (!account) {
        console.error(`Account ${ACCOUNT_NAME} not found`);
        process.exit(1);
    }
    
    console.log(`Account: ${ACCOUNT_NAME} (${account.id})\n`);
    
    // Fetch open orders
    const openOrders = await BitShares.db.get_full_accounts([account.id], false);
    const limitOrders = openOrders[0][1].limit_orders || [];
    
    console.log(`Found ${limitOrders.length} open orders\n`);
    
    if (limitOrders.length === 0) {
        console.log('No open orders.');
        process.exit(0);
    }
    
    // Parse all orders
    const parsedOrders = [];
    for (const order of limitOrders) {
        const parsed = await parseOrder(order);
        parsedOrders.push(parsed);
    }
    
    // Sort by price (descending for sells, ascending for buys)
    const sellOrders = parsedOrders.filter(o => o.type === 'SELL').sort((a, b) => b.priceDisplay - a.priceDisplay);
    const buyOrders = parsedOrders.filter(o => o.type === 'BUY').sort((a, b) => b.priceDisplay - a.priceDisplay);
    
    // Display
    console.log('═'.repeat(90));
    console.log('                              OPEN ORDERS ON BLOCKCHAIN');
    console.log('═'.repeat(90));
    
    console.log('\n┌─────────────────────────────────────────────────────────────────────────────────────────┐');
    console.log('│                                    SELL ORDERS                                          │');
    console.log('├──────────────────────┬─────────────────┬─────────────────┬──────────────────────────────┤');
    console.log('│      Order ID        │      Size       │      Price      │         Raw for_sale         │');
    console.log('├──────────────────────┼─────────────────┼─────────────────┼──────────────────────────────┤');
    
    for (const order of sellOrders) {
        const idStr = order.id.padEnd(20);
        const sizeStr = `${order.size.toFixed(8)} ${order.sizeAsset}`.padEnd(15);
        const priceStr = order.priceDisplay.toFixed(6).padStart(15);
        const rawStr = String(order.rawForSale).padStart(28);
        console.log(`│ ${idStr} │ ${sizeStr} │ ${priceStr} │ ${rawStr} │`);
    }
    
    console.log('└──────────────────────┴─────────────────┴─────────────────┴──────────────────────────────┘');
    
    console.log('\n┌─────────────────────────────────────────────────────────────────────────────────────────┐');
    console.log('│                                     BUY ORDERS                                          │');
    console.log('├──────────────────────┬─────────────────┬─────────────────┬──────────────────────────────┤');
    console.log('│      Order ID        │      Size       │      Price      │         Raw for_sale         │');
    console.log('├──────────────────────┼─────────────────┼─────────────────┼──────────────────────────────┤');
    
    for (const order of buyOrders) {
        const idStr = order.id.padEnd(20);
        const sizeStr = `${order.size.toFixed(5)} ${order.sizeAsset}`.padEnd(15);
        const priceStr = order.priceDisplay.toFixed(6).padStart(15);
        const rawStr = String(order.rawForSale).padStart(28);
        console.log(`│ ${idStr} │ ${sizeStr} │ ${priceStr} │ ${rawStr} │`);
    }
    
    console.log('└──────────────────────┴─────────────────┴─────────────────┴──────────────────────────────┘');
    
    // Raw data dump for debugging
    console.log('\n\n═'.repeat(90));
    console.log('                              RAW ORDER DATA (for debugging)');
    console.log('═'.repeat(90));
    
    for (const order of limitOrders) {
        console.log(`\nOrder ${order.id}:`);
        console.log(`  sell_price.base:  { asset_id: ${order.sell_price.base.asset_id}, amount: ${order.sell_price.base.amount} }`);
        console.log(`  sell_price.quote: { asset_id: ${order.sell_price.quote.asset_id}, amount: ${order.sell_price.quote.amount} }`);
        console.log(`  for_sale: ${order.for_sale}`);
    }
    
    console.log('\n');
    process.exit(0);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
