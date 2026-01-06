/**
 * Constants and default configuration for OrderManager
 * 
 * ORDER_TYPES: Categories for grid entries
 * - SELL: Orders above market price, size in base asset (assetA)
 * - BUY: Orders below market price, size in quote asset (assetB)
 * - SPREAD: Placeholder orders in the spread zone around market price
 * 
 * ORDER_STATES: Lifecycle states for orders (affects fund tracking)
 * - VIRTUAL: Not yet on-chain, size contributes to funds.virtual (reserved)
 *            Also used for filled orders that are converted to SPREAD placeholders
 * - ACTIVE: Placed on-chain, size contributes to funds.committed
 */
const fs = require('fs');
const path = require('path');

// Order categories used by the OrderManager when classifying grid entries.
const ORDER_TYPES = Object.freeze({
    SELL: 'sell',
    BUY: 'buy',
    SPREAD: 'spread'
});

// Life-cycle states assigned to generated or active orders.
// State transitions affect fund calculations in manager.recalculateFunds()
const ORDER_STATES = Object.freeze({
    VIRTUAL: 'virtual',   // Not on-chain, size in funds.virtual; also used for fully filled orders converted to SPREAD
    ACTIVE: 'active',     // On-chain, size in funds.committed.grid (and .chain if has orderId)
    PARTIAL: 'partial'    // On-chain, partially filled order, size in funds.committed.grid (and .chain if has orderId)
});

// Defaults applied when instantiating an OrderManager with minimal configuration.
let DEFAULT_CONFIG = {
    startPrice: "pool",
    minPrice: "3x",
    maxPrice: "3x",
    incrementPercent: 0.5,
    targetSpreadPercent: 2,
    active: true,
    dryRun: false,
    assetA: null,
    assetB: null,
    weightDistribution: { sell: 0.5, buy: 0.5 },
    // Order of keys changed: place sell first then buy for readability/consistency
    botFunds: { sell: "100%", buy: "100%" },
    activeOrders: { sell: 20, buy: 20 },
};

// Timing constants used by OrderManager and helpers
let TIMING = {
    SYNC_DELAY_MS: 500,
    ACCOUNT_TOTALS_TIMEOUT_MS: 10000,
    // Blockchain fetch interval: how often to refresh blockchain account values (in minutes)
    // Default: 240 minutes (4 hours). Set to 0 or non-number to disable periodic fetches.
    BLOCKCHAIN_FETCH_INTERVAL_MIN: 240,

    // Fill processing timing
    FILL_DEDUPE_WINDOW_MS: 5000,    // 5 seconds - window for deduplicating same fill events
    FILL_CLEANUP_INTERVAL_MS: 10000, // 10 seconds - clean old fill records (2x dedup window)
    FILL_RECORD_RETENTION_MS: 3600000, // 1 hour - how long to keep persisted fill records

    // Order locking timing
    // Reduced from 30s to 10s to prevent lock-based starvation under high fill rates.
    // Locks that exceed this timeout are auto-expired by _cleanExpiredLocks() to ensure
    // orders are never permanently blocked if a process crashes while holding the lock.
    // This self-healing mechanism prevents deadlocks while still protecting against races.
    LOCK_TIMEOUT_MS: 10000  // 10 seconds - balances transaction latency with lock starvation prevention
};

// Grid limits and scaling constants
let GRID_LIMITS = {
    MIN_SPREAD_FACTOR: 2,
    MIN_ORDER_SIZE_FACTOR: 50,
    // Grid regeneration threshold (percentage)
    // When (cacheFunds / total.grid) * 100 >= this percentage on one side, trigger Grid.updateGridOrderSizes() for that side
    // Checked independently for buy and sell sides
    // Default: 3% (was 2%) — more conservative by default to reduce unnecessary churn
    // Example: If cacheFunds.buy = 100 and total.grid.buy = 1000, ratio = 10%
    // If threshold = 5%, then 10% >= 5% triggers update for buy side only
    GRID_REGENERATION_PERCENTAGE: 3,
    // Threshold for considering a partial order as "dust" relative to neighboring active orders.
    // If (partial.size / nearestActive.size) * 100 < PARTIAL_DUST_THRESHOLD_PERCENTAGE, it is marked for refill.
    // Default: 5 (5%)
    PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5,
    // Tolerance for fund invariant checks (percentage).
    // Discrepancies below this threshold will not trigger a warning.
    // Default: 0.1 (0.1%)
    FUND_INVARIANT_PERCENT_TOLERANCE: 0.1,
    // Minimum number of spread orders (1 buy, 1 sell) to maintain proper spread zone
    // Default: 2
    MIN_SPREAD_ORDERS: 2,
    SPREAD_WIDENING_MULTIPLIER: 1.5,

    // Grid comparison metrics
    // Detects significant divergence between calculated (in-memory) and persisted grid state
    // after order fills and rotations
    GRID_COMPARISON: {
        // Metric calculation: RMS (Root Mean Square) of relative order size differences
        // Formula: RMS = √(mean of ((calculated - persisted) / persisted)²)
        // Represents the quadratic mean of relative size errors
        SUMMED_RELATIVE_SQUARED_DIFFERENCE: 'summedRelativeSquaredDiff',

        // Divergence threshold for automatic grid regeneration (RMS as percentage)
        // When compareGrids() metric exceeds this threshold, updateGridOrderSizes will be triggered
        //
        // RMS Threshold Reference Table (for 5% distribution: 5% outliers, 95% perfect):
        // ┌────────────────────────────────────────────────────────┐
        // │ RMS %       │ Avg Error │ Description                 │
        // ├────────────────────────────────────────────────────────┤
        // │ 4.5%        │ ~1.0%     │ Very strict                 │
        // │ 9.8%        │ ~2.2%     │ Strict                      │
        // │ 14.3%       │ ~3.2%     │ Default (balanced)          │
        // │ 20.1%       │ ~4.5%     │ Lenient                     │
        // │ 31.7%       │ ~7.1%     │ Very lenient                │
        // │ 44.7%       │ ~10%      │ Extremely lenient           │
        // └────────────────────────────────────────────────────────┘
        RMS_PERCENTAGE: 14.3
    }
};

// Precision defaults and fallbacks for asset precision calculations
let PRECISION_DEFAULTS = {
    // Stricter precision for price tolerance and minimum order size calculations
    STRICT_CALCULATION: 8,
    // Default price tolerance ratio (0.1%)
    PRICE_TOLERANCE: 0.001
};

// Increment percentage bounds for grid configuration
let INCREMENT_BOUNDS = {
    // Minimum increment percentage allowed (0.01%)
    MIN_PERCENT: 0.01,
    // Maximum increment percentage allowed (10%)
    MAX_PERCENT: 10,
    // Minimum increment as decimal factor (0.01% = 0.0001)
    MIN_FACTOR: 0.0001,
    // Maximum increment as decimal factor (10% = 0.10)
    MAX_FACTOR: 0.10
};

// Fee-related parameters for order operations
let FEE_PARAMETERS = {
    // Multiplier for BTS fee reservation (multiplied by totalTargetOrders)
    BTS_RESERVATION_MULTIPLIER: 5,
    // Fallback BTS fee when fee data calculation fails
    BTS_FALLBACK_FEE: 100,
    // Ratio of creation fee refunded for maker orders (10% = 0.1)
    MAKER_REFUND_RATIO: 0.1
};

// API request limits and batch sizes for blockchain operations
let API_LIMITS = {
    // Maximum number of liquidity pools per batch request
    POOL_BATCH_SIZE: 100,
    // Maximum number of batch iterations for pool scanning (~10k total pools)
    MAX_POOL_SCAN_BATCHES: 100,
    // Depth of order book to fetch for market price derivation
    ORDERBOOK_DEPTH: 5,
    // Maximum number of limit orders per batch request
    LIMIT_ORDERS_BATCH: 100
};

// Fill processing configuration
let FILL_PROCESSING = {
    // Mode for fill processing: 'history' reads from historical fills
    MODE: 'history',
    // Operation type for fill_order blockchain operations
    OPERATION_TYPE: 4,
    // Indicator for taker (non-maker) fills
    TAKER_INDICATOR: 0
};

// Cleanup and maintenance parameters
let MAINTENANCE = {
    // Probability of running cleanup operation on any cycle (0.1 = 10%)
    CLEANUP_PROBABILITY: 0.1
};

// Logging Level Configuration
// Options:
// - 'debug': Verbose output including calculation details, API calls, and flow tracing.
// - 'info':  Standard production output. State changes (Active/Filled), keys confirmations, and errors.
// - 'warn':  Warnings (non-critical issues) and errors only.
// - 'error': Critical errors only.
let LOG_LEVEL = 'info';

// --- LOCAL SETTINGS OVERRIDES ---
// Load user-defined settings from profiles/general.settings.json if it exists.
// This allows preserving settings during updates without git stashing.
const SETTINGS_FILE = path.join(__dirname, '..', 'profiles', 'general.settings.json');

if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(raw);

        if (settings.LOG_LEVEL) LOG_LEVEL = settings.LOG_LEVEL;

        if (settings.TIMING) {
            // Filter out comment fields (keys starting with _) before merging
            const timingSettings = Object.fromEntries(
                Object.entries(settings.TIMING).filter(([key]) => !key.startsWith('_'))
            );
            TIMING = { ...TIMING, ...timingSettings };
        }

        if (settings.GRID_LIMITS) {
            const gridSettings = settings.GRID_LIMITS;
            // Filter out comment fields before merging
            const cleanGridSettings = Object.fromEntries(
                Object.entries(gridSettings).filter(([key]) => !key.startsWith('_'))
            );
            GRID_LIMITS = {
                ...GRID_LIMITS,
                ...cleanGridSettings,
                GRID_COMPARISON: { ...GRID_LIMITS.GRID_COMPARISON, ...(cleanGridSettings.GRID_COMPARISON || {}) }
            };
        }

        // Load expert settings (for advanced troubleshooting)
        if (settings.EXPERT) {
            if (settings.EXPERT.GRID_LIMITS) {
                const expertGridSettings = Object.fromEntries(
                    Object.entries(settings.EXPERT.GRID_LIMITS).filter(([key]) => !key.startsWith('_'))
                );
                GRID_LIMITS = { ...GRID_LIMITS, ...expertGridSettings };
            }
            if (settings.EXPERT.TIMING) {
                const expertTimingSettings = Object.fromEntries(
                    Object.entries(settings.EXPERT.TIMING).filter(([key]) => !key.startsWith('_'))
                );
                TIMING = { ...TIMING, ...expertTimingSettings };
            }
        }

        if (settings.DEFAULT_CONFIG) {
            DEFAULT_CONFIG = { ...DEFAULT_CONFIG, ...settings.DEFAULT_CONFIG };
        }
    } catch (err) {
        console.warn(`[WARN] Failed to load local settings from ${SETTINGS_FILE}: ${err.message}`);
    }
}

// Freeze objects to prevent accidental runtime modifications
Object.freeze(ORDER_TYPES);
Object.freeze(ORDER_STATES);
Object.freeze(TIMING);
Object.freeze(GRID_LIMITS);
Object.freeze(GRID_LIMITS.GRID_COMPARISON);
Object.freeze(PRECISION_DEFAULTS);
Object.freeze(INCREMENT_BOUNDS);
Object.freeze(FEE_PARAMETERS);
Object.freeze(API_LIMITS);
Object.freeze(FILL_PROCESSING);
Object.freeze(MAINTENANCE);

module.exports = { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, TIMING, GRID_LIMITS, LOG_LEVEL, PRECISION_DEFAULTS, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, FILL_PROCESSING, MAINTENANCE };
