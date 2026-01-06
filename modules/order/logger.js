/**
 * Logger - Color-coded console logger for OrderManager
 * 
 * Provides structured logging with:
 * - Log levels: debug, info, warn, error
 * - Color coding for order types (buy=green, sell=red, spread=yellow)
 * - Color coding for order states (virtual=gray, active=green)
 * - Formatted order grid display
 * - Fund status display (logFundsStatus)
 * 
 * Fund display (logFundsStatus) shows:
 * - available: max(0, chainFree - virtual - applicableBtsFeesOwed - btsFeesReservation)
 * - cacheFunds: fill proceeds and rotation surplus (added to available for rebalancing decisions)
 * - total.chain: chainFree + committed.chain (on-chain balance)
 * - total.grid: committed.grid + virtual (grid allocation)
 * - virtual: VIRTUAL order sizes (reserved for future placement)
 * - committed.grid: ACTIVE order sizes (internal tracking)
 * - committed.chain: ACTIVE orders with orderId (confirmed on-chain)
 * 
 * @class
 */
class Logger {
    /**
     * Create a new Logger instance.
     * @param {string} level - Minimum log level to display ('debug', 'info', 'warn', 'error')
     */
    constructor(level = 'info') {
        this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
        this.level = level;
        // Only use colors if stdout is a TTY (terminal), not when piped to files
        const useColors = process.stdout.isTTY;
        this.colors = useColors ? {
            reset: '\x1b[0m',
            buy: '\x1b[32m', sell: '\x1b[31m', spread: '\x1b[33m',
            debug: '\x1b[36m', info: '\x1b[37m', warn: '\x1b[33m', error: '\x1b[31m',
            virtual: '\x1b[90m', active: '\x1b[32m', partial: '\x1b[34m'
        } : {
            reset: '', buy: '', sell: '', spread: '',
            debug: '', info: '', warn: '', error: '',
            virtual: '', active: '', partial: ''
        };
    }

    log(message, level = 'info') {
        if (this.levels[level] >= this.levels[this.level]) {
            const color = this.colors[level] || '';
            console.log(`${color}[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${this.colors.reset}`);
        }
    }

    logOrderGrid(orders, startPrice) {
        console.log('\n===== ORDER GRID (SAMPLE) =====');
        if (this.marketName) console.log(`Market: ${this.marketName} @ ${startPrice}`);
        console.log('Price       Slot      Type      State       Size');
        console.log('----------------------------------------------------');

        const sorted = [...orders].sort((a, b) => b.price - a.price);

        // Separate by type
        const allSells = sorted.filter(o => o.type === 'sell');
        const allSpreads = sorted.filter(o => o.type === 'spread');
        const allBuys = sorted.filter(o => o.type === 'buy');

        // SELL: top 3 (highest prices, edge) + last 3 (lowest prices, next to spread)
        const sellEdge = allSells.slice(0, 3);
        const sellNearSpread = allSells.slice(-3);
        sellEdge.forEach(order => this._logOrderRow(order));
        console.log('');
        console.log('');
        sellNearSpread.forEach(order => this._logOrderRow(order));

        // SPREAD: high, middle, low with gap indicators
        if (allSpreads.length > 0) {
            const highIdx = 0;
            const midIdx = Math.floor(allSpreads.length / 2);
            const lowIdx = allSpreads.length - 1;

            const high = allSpreads[highIdx];
            const mid = (allSpreads.length > 2) ? allSpreads[midIdx] : null;
            const low = allSpreads[lowIdx];

            this._logOrderRow(high);

            if (mid) {
                if (midIdx > highIdx + 1) console.log(''); // Gap between high and mid
                this._logOrderRow(mid);
                if (lowIdx > midIdx + 1) console.log('');  // Gap between mid and low
            } else if (lowIdx > highIdx + 1) {
                console.log(''); // Gap between high and low (when only 2 total)
            }

            if (low.id !== high.id) {
                this._logOrderRow(low);
            }
        }

        // BUY: top 3 (highest prices, next to spread) + last 3 (lowest prices, edge)
        const buyNearSpread = allBuys.slice(0, 3);
        const buyEdge = allBuys.slice(-3);
        buyNearSpread.forEach(order => this._logOrderRow(order));
        console.log('');
        console.log('');
        buyEdge.forEach(order => this._logOrderRow(order));

        console.log('===============================================\n');
    }

    _logOrderRow(order) {
        const typeColor = this.colors[order.type] || '';
        const stateColor = this.colors[order.state] || '';
        const price = order.price.toFixed(4).padEnd(12);
        const id = (order.id || '').padEnd(10);
        const type = order.type.padEnd(10);
        const state = order.state.padEnd(12);
        const size = order.size.toFixed(8);
        console.log(
            `${price}${id}${typeColor}${type}${this.colors.reset}${stateColor}${state}${this.colors.reset}${size}`
        );
    }

    /**
     * Print a summary of fund status for diagnostics with optional context.
     * Displays the complete fund structure from manager.funds:
     * - available: Free funds for new orders (chainFree - virtual - cacheFunds - btsFeesOwed)
     * - total.chain: Total on-chain balance (chainFree + committed.chain)
     * - total.grid: Total grid allocation (committed.grid + virtual)
     * - virtual: VIRTUAL order sizes (reserved for future on-chain placement)
     * - committed.grid: ACTIVE order sizes (internal grid tracking)
     * - committed.chain: ACTIVE orders with orderId (confirmed on blockchain)
     * - cacheFunds: Fill proceeds and rotation surplus
     * - btsFeesOwed: Pending BTS transaction fees
     *
     * @param {OrderManager} manager - OrderManager instance to read funds from
     * @param {string} context - Optional context string describing when this is called (e.g., "AFTER fill", "BEFORE rotation")
     */
    logFundsStatus(manager, context = '') {
        if (!manager) return;
        // Show detailed fund logging in debug mode
        const isDebugMode = manager.logger?.level === 'debug';

        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';

        // Build header with context
        const headerContext = context ? ` [${context}]` : '';

        // Use new nested structure
        const availableBuy = Number.isFinite(Number(manager.funds?.available?.buy)) ? manager.funds.available.buy.toFixed(8) : 'N/A';
        const availableSell = Number.isFinite(Number(manager.funds?.available?.sell)) ? manager.funds.available.sell.toFixed(8) : 'N/A';

        const c = this.colors;
        const debug = c.debug;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        if (!isDebugMode) {
            this.log(`Funds Status${headerContext}: ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`, 'info');
            return;
        }

        console.log(`\n===== FUNDS STATUS${headerContext} =====`);

        // Chain balances (from accountTotals)
        const chainFreeBuy = manager.accountTotals?.buyFree ?? 0;
        const chainFreeSell = manager.accountTotals?.sellFree ?? 0;
        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;

        // Grid allocations
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;

        // Cache
        const cacheBuy = manager.funds?.cacheFunds?.buy ?? 0;
        const cacheSell = manager.funds?.cacheFunds?.sell ?? 0;

        // Committed
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;

        // BTS fees
        const btsFeesOwed = manager.funds?.btsFeesOwed ?? 0;
        const btsSide = (manager.config?.assetA === 'BTS') ? 'sell' : (manager.config?.assetB === 'BTS') ? 'buy' : null;

        console.log(`\n${debug}=== AVAILABLE CALCULATION ===${reset}`);
        console.log(`funds.available: ${buy}Buy ${availableBuy}${reset} ${buyName} | ${sell}Sell ${availableSell}${reset} ${sellName}`);

        console.log(`\n${debug}=== CHAIN BALANCES (from blockchain) ===${reset}`);
        console.log(`chainFree: ${buy}Buy ${chainFreeBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${chainFreeSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`total.chain: ${buy}Buy ${totalChainBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${totalChainSell.toFixed(8)}${reset} ${sellName}`);

        console.log(`\n${debug}=== GRID ALLOCATIONS (locked in orders) ===${reset}`);
        console.log(`total.grid: ${buy}Buy ${totalGridBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${totalGridSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`committed.grid: ${buy}Buy ${committedGridBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${committedGridSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`virtual (reserved): ${buy}Buy ${virtualBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${virtualSell.toFixed(8)}${reset} ${sellName}`);

        console.log(`\n${debug}=== COMMITTED ON-CHAIN ===${reset}`);
        console.log(`committed.chain: ${buy}Buy ${committedChainBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${committedChainSell.toFixed(8)}${reset} ${sellName}`);

        console.log(`\n${debug}=== DEDUCTIONS & PENDING ===${reset}`);
        console.log(`cacheFunds: ${buy}Buy ${cacheBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${cacheSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`btsFeesOwed (all): ${btsFeesOwed.toFixed(8)} BTS`);

        // Only show formula and notes in debug mode
        if (isDebugMode) {
            console.log(`\n${debug}=== FORMULA: available = max(0, chainFree - virtual - applicableBtsFeesOwed - btsFeesReservation) ===${reset}`);
            console.log(`${debug}Note: cacheFunds is kept separate and added to available for rebalancing decisions${reset}`);
        }
    }

    // Print a comprehensive status summary using manager state.
    displayStatus(manager) {
        if (!manager) return;
        const market = manager.marketName || manager.config?.market || 'unknown';
        const activeOrders = manager.getOrdersByTypeAndState(null, 'active');
        const partialOrders = manager.getOrdersByTypeAndState(null, 'partial');
        const virtualOrders = manager.getOrdersByTypeAndState(null, 'virtual');
        console.log('\n===== STATUS =====');
        console.log(`Market: ${market}`);
        const buyName = manager.config?.assetB || 'quote';
        const sellName = manager.config?.assetA || 'base';

        // Use new nested structure
        const gridBuy = Number.isFinite(Number(manager.funds?.available?.buy)) ? manager.funds.available.buy.toFixed(8) : 'N/A';
        const gridSell = Number.isFinite(Number(manager.funds?.available?.sell)) ? manager.funds.available.sell.toFixed(8) : 'N/A';
        const totalChainBuy = manager.funds?.total?.chain?.buy ?? 0;
        const totalChainSell = manager.funds?.total?.chain?.sell ?? 0;
        const totalGridBuy = manager.funds?.total?.grid?.buy ?? 0;
        const totalGridSell = manager.funds?.total?.grid?.sell ?? 0;
        const virtualBuy = manager.funds?.virtual?.buy ?? 0;
        const virtualSell = manager.funds?.virtual?.sell ?? 0;
        const cacheBuy = manager.funds?.cacheFunds?.buy ?? 0;
        const cacheSell = manager.funds?.cacheFunds?.sell ?? 0;
        const committedGridBuy = manager.funds?.committed?.grid?.buy ?? 0;
        const committedGridSell = manager.funds?.committed?.grid?.sell ?? 0;
        const committedChainBuy = manager.funds?.committed?.chain?.buy ?? 0;
        const committedChainSell = manager.funds?.committed?.chain?.sell ?? 0;

        const c = this.colors;
        const debug = c.debug;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;

        console.log(`funds.available: ${buy}Buy ${gridBuy}${reset} ${buyName} | ${sell}Sell ${gridSell}${reset} ${sellName}`);
        console.log(`total.chain: ${buy}Buy ${totalChainBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${totalChainSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`total.grid: ${buy}Buy ${totalGridBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${totalGridSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`virtual.grid: ${buy}Buy ${virtualBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${virtualSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`cacheFunds: ${buy}Buy ${cacheBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${cacheSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`committed.grid: ${buy}Buy ${committedGridBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${committedGridSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`committed.chain: ${buy}Buy ${committedChainBuy.toFixed(8)}${reset} ${buyName} | ${sell}Sell ${committedChainSell.toFixed(8)}${reset} ${sellName}`);
        console.log(`Orders: Virtual ${virtualOrders.length} | Active ${activeOrders.length} | Partial ${partialOrders.length}`);
        console.log(`Spreads: ${manager.currentSpreadCount}/${manager.targetSpreadCount}`);
        // calculateCurrentSpread may exist on manager
        const spread = typeof manager.calculateCurrentSpread === 'function' ? manager.calculateCurrentSpread() : 0;
        console.log(`Current Spread: ${Number(spread).toFixed(2)}%`);
        console.log(`Spread Condition: ${manager.outOfSpread ? 'TOO WIDE' : 'Normal'}`);
    }

    /**
     * Log detailed grid diagnostic: ACTIVE, SPREAD, PARTIAL orders and first VIRTUAL on boundary
     * Used to trace grid mutations during fill/rotation/spread-correction cycles
     */
    logGridDiagnostics(manager, context = '') {
        if (!manager) return;

        const { ORDER_TYPES, ORDER_STATES } = require('../constants');
        const c = this.colors;
        const reset = c.reset;
        const buy = c.buy;
        const sell = c.sell;
        const active = c.active;
        const spread = c.spread;
        const partial = c.partial;
        const virtual = c.virtual;

        // Get all orders sorted by price (descending)
        const allOrders = Array.from(manager.orders.values()).sort((a, b) => b.price - a.price);

        // Separate by type and state
        const activeOrders = allOrders.filter(o => o.state === ORDER_STATES.ACTIVE);
        const activeBuys = activeOrders.filter(o => o.type === ORDER_TYPES.BUY);
        const activeSells = activeOrders.filter(o => o.type === ORDER_TYPES.SELL);

        const spreadOrders = allOrders.filter(o => o.type === ORDER_TYPES.SPREAD && o.state === ORDER_STATES.VIRTUAL);
        const partialOrders = allOrders.filter(o => o.state === ORDER_STATES.PARTIAL);

        // Find first VIRTUAL order on each boundary
        const virtualOrders = allOrders.filter(o => o.state === ORDER_STATES.VIRTUAL && o.type !== ORDER_TYPES.SPREAD);
        const firstVirtualSell = virtualOrders.find(o => o.type === ORDER_TYPES.SELL);
        const firstVirtualBuy = virtualOrders.find(o => o.type === ORDER_TYPES.BUY);

        const ctxStr = context ? ` [${context}]` : '';
        console.log(`\n${spread}═══ GRID DIAGNOSTICS${ctxStr} ═══${reset}`);

        // Active orders summary
        console.log(`\n${active}ACTIVE ORDERS${reset}: ${buy}Buy=${activeBuys.length}${reset}, ${sell}Sell=${activeSells.length}${reset}`);
        if (activeBuys.length > 0) {
            console.log(`  ${buy}BUY:${reset}  ${activeBuys.map(o => `${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
        }
        if (activeSells.length > 0) {
            console.log(`  ${sell}SELL:${reset} ${activeSells.map(o => `${o.id}@${o.price.toFixed(4)}`).join(', ')}`);
        }

        // SPREAD orders
        console.log(`\n${spread}SPREAD PLACEHOLDERS${reset}: ${spreadOrders.length}`);
        if (spreadOrders.length > 0) {
            for (const order of spreadOrders) {
                const isBoundary = (order === firstVirtualBuy || order === firstVirtualSell);
                const boundaryMarker = isBoundary ? ' ← BOUNDARY' : '';
                console.log(`  ${spread}${order.id}@${order.price.toFixed(4)}${boundaryMarker}${reset}`);
            }
        }

        // PARTIAL orders
        console.log(`\n${partial}PARTIAL ORDERS${reset}: ${partialOrders.length}`);
        if (partialOrders.length > 0) {
            for (const order of partialOrders) {
                console.log(`  ${partial}${order.id}@${order.price.toFixed(4)} size=${order.size.toFixed(8)}${reset}`);
            }
        }

        // First VIRTUAL on boundary
        console.log(`\n${virtual}FIRST VIRTUAL ON BOUNDARY${reset}:`);
        if (firstVirtualSell) {
            console.log(`  ${virtual}SELL: ${firstVirtualSell.id}@${firstVirtualSell.price.toFixed(4)}${reset}`);
        } else {
            console.log(`  ${virtual}SELL: (none)${reset}`);
        }
        if (firstVirtualBuy) {
            console.log(`  ${virtual}BUY:  ${firstVirtualBuy.id}@${firstVirtualBuy.price.toFixed(4)}${reset}`);
        } else {
            console.log(`  ${virtual}BUY:  (none)${reset}`);
        }
    }
}

module.exports = Logger;

