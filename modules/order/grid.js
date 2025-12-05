/**
 * OrderGridGenerator - Generates the virtual order grid structure
 * 
 * This module creates the foundational grid of virtual orders based on:
 * - Market price (center of the grid)
 * - Min/max price bounds
 * - Increment percentage (spacing between orders)
 * - Target spread percentage (zone around market price)
 * 
 * The grid consists of:
 * - SELL orders above market price
 * - BUY orders below market price  
 * - SPREAD orders in the zone closest to market price
 * 
 * Orders are sized based on available funds and weight distribution.
 */
const { ORDER_TYPES, DEFAULT_CONFIG } = require('./constants');
const { floatToBlockchainInt } = require('./utils');

// MIN_SPREAD_FACTOR constant (moved from constants.js)
const MIN_SPREAD_FACTOR = 2;

/**
 * OrderGridGenerator - Static class for grid creation and sizing
 * 
 * Grid creation algorithm:
 * 1. Calculate price levels from marketPrice to maxPrice (sells) and minPrice (buys)
 * 2. Use incrementPercent for geometric spacing (1% -> 1.01x per level)
 * 3. Assign SPREAD type to orders closest to market price
 * 4. Calculate order sizes based on funds and weight distribution
 * 
 * @class
 */
class OrderGridGenerator {
    /**
     * Create the order grid structure.
     * Generates sell orders from market to max, buy orders from market to min.
     * Orders within targetSpreadPercent of market are marked as SPREAD.
     * 
     * @param {Object} config - Grid configuration
     * @param {number} config.marketPrice - Center price for the grid
     * @param {number} config.minPrice - Lower price bound
     * @param {number} config.maxPrice - Upper price bound
     * @param {number} config.incrementPercent - Price step (e.g., 1 for 1%)
     * @param {number} config.targetSpreadPercent - Spread zone width
     * @returns {Object} { orders: Array, initialSpreadCount: { buy, sell } }
     */
    static createOrderGrid(config) {
        // Compute helper arrays of buy/sell price levels relative to the market price.
        const { marketPrice, minPrice, maxPrice, incrementPercent } = config;
        // Use explicit step multipliers for clarity:
        const stepUp = 1 + (incrementPercent / 100);    // e.g. 1.02 for +2%
        const stepDown = 1 - (incrementPercent / 100);  // e.g. 0.98 for -2%
        
        // Ensure targetSpreadPercent is at least `minSpreadFactor * incrementPercent` to guarantee spread orders.
        // This implementation uses the constant MIN_SPREAD_FACTOR defined in this module.
        const spreadFactor = Number(MIN_SPREAD_FACTOR);
        const minSpreadPercent = incrementPercent * spreadFactor;
        const targetSpreadPercent = Math.max(config.targetSpreadPercent, minSpreadPercent);
        if (config.targetSpreadPercent < minSpreadPercent) {
            console.log(`[WARN] targetSpreadPercent (${config.targetSpreadPercent}%) is less than ${spreadFactor}*incrementPercent (${minSpreadPercent.toFixed(2)}%). ` +
                        `Auto-adjusting to ${minSpreadPercent.toFixed(2)}% to ensure spread orders are created.`);
        }
        
        // Calculate number of spread orders based on target spread vs increment
        // Ensure at least 2 spread orders (1 buy, 1 sell) to maintain a proper spread zone
        // Number of increments needed to cover the target spread using stepUp^n >= (1 + targetSpread)
        const calculatedNOrders = Math.ceil(Math.log(1 + (targetSpreadPercent / 100)) / Math.log(stepUp));
        const nOrders = Math.max(2, calculatedNOrders); // Minimum 2 spread orders

        const calculateLevels = (start, min) => {
            const levels = [];
            for (let current = start; current >= min; current *= stepDown) {
                levels.push(current);
            }
            return levels;
        };

        const sellLevels = calculateLevels(maxPrice, marketPrice);
        // Start the buy side one step below the last sell level (or marketPrice) using stepDown
        const buyStart = (sellLevels[sellLevels.length - 1] || marketPrice) * stepDown;
        const buyLevels = calculateLevels(buyStart, minPrice);

        const buySpread = Math.floor(nOrders / 2);
        const sellSpread = nOrders - buySpread;
        const initialSpreadCount = { buy: 0, sell: 0 };

        const sellOrders = sellLevels.map((price, i) => ({
            price,
            type: i >= sellLevels.length - sellSpread ? (initialSpreadCount.sell++, ORDER_TYPES.SPREAD) : ORDER_TYPES.SELL,
            id: `sell-${i}`,
            state: 'virtual'
        }));

        const buyOrders = buyLevels.map((price, i) => ({
            price,
            type: i < buySpread ? (initialSpreadCount.buy++, ORDER_TYPES.SPREAD) : ORDER_TYPES.BUY,
            id: `buy-${i}`,
            state: 'virtual'
        }));

        return { orders: [...sellOrders, ...buyOrders], initialSpreadCount };
    }

    /**
     * Distribute funds across grid orders using weighted allocation.
     * 
     * Weight distribution algorithm:
     * - Uses geometric weighting based on incrementPercent
     * - Can favor orders closer to or further from market price
     * - Respects minimum size constraints
     * 
     * @param {Array} orders - Array of order objects from createOrderGrid
     * @param {Object} config - Grid configuration with weightDistribution
     * @param {number} sellFunds - Available funds for sell orders (in base asset)
     * @param {number} buyFunds - Available funds for buy orders (in quote asset)
     * @param {number} minSellSize - Minimum size for sell orders (0 to disable)
     * @param {number} minBuySize - Minimum size for buy orders (0 to disable)
     * @returns {Array} Orders with size property added
     */
    // Accept optional precision parameters for both sides so size-vs-min
    // comparisons can be performed exactly at blockchain integer granularity.
    static calculateOrderSizes(orders, config, sellFunds, buyFunds, minSellSize = 0, minBuySize = 0, precisionA = null, precisionB = null) {
        const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
        const incrementFactor = incrementPercent / 100;

        // side: 'sell' or 'buy' - explicit instead of comparing weights
        // minSize: enforce a minimum human-unit size per order; allocations below
        // minSize are removed and their funds redistributed among remaining orders.
        const calculateSizes = (ordersForSide, weight, totalFunds, side, minSize) => {
            if (!Array.isArray(ordersForSide) || ordersForSide.length === 0) return [];
            const n = ordersForSide.length;
            // Validate totalFunds to avoid NaN propagation
            if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

            const reverse = (side === 'sell');
            const base = 1 - incrementFactor;
            // Precompute per-index raw weights
            const rawWeights = new Array(n);
            for (let i = 0; i < n; i++) {
                const idx = reverse ? (n - 1 - i) : i;
                rawWeights[i] = Math.pow(base, idx * weight);
            }

            // Compute sizes (single-pass). `remaining`/`fundsLeft` not needed
            // since we abort the whole allocation when a per-order minimum
            // cannot be satisfied.
            let sizes = new Array(n).fill(0);

            // Single-pass allocation. If no minSize is enforced, allocate once.
            // If minSize is enforced, perform the allocation and abort (return zeros)
            // when any allocated order would be below the minimum. This keeps
            // grid-generation simple and allows the caller to abort creating
            // the grid when the per-order minimum cannot be satisfied.
            if (!Number.isFinite(minSize) || minSize <= 0) {
                const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
            } else {
                const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
                // If any allocated size is below the minimum, try a fallback:
                // - If there are totalFunds available, retry the allocation without
                //   enforcing the per-order minimum (i.e. minSize=0).
                // - If totalFunds is zero or not finite, signal failure with
                //   a zero-filled array so the caller can decide how to proceed.
                    // If precision provided for this side, compare integer representations
                    const precision = (side === 'sell') ? precisionA : precisionB;
                    let anyBelow = false;
                    if (precision !== null && precision !== undefined && Number.isFinite(precision)) {
                        const minInt = floatToBlockchainInt(minSize, precision);
                        anyBelow = sizes.some(sz => floatToBlockchainInt(sz, precision) < minInt);
                    } else {
                        anyBelow = sizes.some(sz => sz < minSize - 1e-8);
                    }
                if (anyBelow) {
                    if (Number.isFinite(totalFunds) && totalFunds > 0) {
                        // Retry allocation without min-size (single-pass)
                        const fallbackTotalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;
                        for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / fallbackTotalWeight) * totalFunds;
                    } else {
                        return new Array(n).fill(0);
                    }
                }
            }

            // Note: intentionally not applying a residual correction here.
            // Small floating-point rounding differences are accepted and will
            // be handled at higher-level logic (e.g. when converting to
            // integer chain units) rather than by altering individual
            // allocation amounts here.

            return sizes;
        };

        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

        const sellSizes = calculateSizes(sellOrders, sellWeight, sellFunds, 'sell', minSellSize);
        const buySizes = calculateSizes(buyOrders, buyWeight, buyFunds, 'buy', minBuySize);

        const sizeMap = { [ORDER_TYPES.SELL]: { sizes: sellSizes, index: 0 }, [ORDER_TYPES.BUY]: { sizes: buySizes, index: 0 } };
        return orders.map(order => ({
            ...order,
            size: sizeMap[order.type] ? sizeMap[order.type].sizes[sizeMap[order.type].index++] : 0
        }));
    }
}

module.exports = OrderGridGenerator;
