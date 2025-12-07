/**
 * Constants and default configuration for OrderManager
 * 
 * ORDER_TYPES: Categories for grid entries
 * - SELL: Orders above market price, size in base asset (assetA)
 * - BUY: Orders below market price, size in quote asset (assetB)
 * - SPREAD: Placeholder orders in the spread zone around market price
 * 
 * ORDER_STATES: Lifecycle states for orders (affects fund tracking)
 * - VIRTUAL: Not yet on-chain, size contributes to funds.virtuel (reserved)
 * - ACTIVE: Placed on-chain, size contributes to funds.committed
 * - FILLED: Fully executed, size=0, no longer contributes to funds
 */

// Order categories used by the OrderManager when classifying grid entries.
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

// Life-cycle states assigned to generated or active orders.
// State transitions affect fund calculations in manager.recalculateFunds()
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',   // Not on-chain, size in funds.virtuel
    ACTIVE: 'active',     // On-chain, size in funds.committed.grid (and .chain if has orderId)
    FILLED: 'filled'      // Executed, size=0, removed from fund tracking
});

// Defaults applied when instantiating an OrderManager with minimal configuration.
const DEFAULT_CONFIG = {
    marketPrice: "pool",
    minPrice: "4x",
    maxPrice: "4x",
    incrementPercent: 1,
    targetSpreadPercent: 5,
    active: true,
    dryRun: false,
    assetA: null,
    assetB: null,
    weightDistribution: { sell: 0.5, buy: 0.5 },
    botFunds: { buy: "100%", sell: "100%" },
    activeOrders: { buy: 24, sell: 24 },
};

// Timing constants used by OrderManager and helpers
const TIMING = Object.freeze({
    SYNC_DELAY_MS: 500,
    ACCOUNT_TOTALS_TIMEOUT_MS: 10000
});

// Grid limits and scaling constants
const GRID_LIMITS = Object.freeze({
    MIN_SPREAD_FACTOR: 2,
    MIN_ORDER_SIZE_FACTOR: 50
});

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS };

