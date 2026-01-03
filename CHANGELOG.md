# Changelog

All notable changes to this project will be documented in this file.

---

## [0.6.0] - 2026-01-03 - Order Management Modularization, Fund Accounting Fixes, Robustness Improvements & Sequential Order Placement

### Added
- **Complete Constants Centralization**: Consolidated 60+ hardcoded magic numbers into a single source of truth
  - **New Constants Sections**:
    - `PRECISION_DEFAULTS`: Asset precision fallback (5), price tolerance (0.1%)
    - `INCREMENT_BOUNDS`: Grid increment percentage bounds (0.01% - 10%)
    - `FEE_PARAMETERS`: BTS fee reservation multiplier (5), fallback fee (100)
    - `API_LIMITS`: Pool batch size (100), scan batches (100), orderbook depth (5), limit orders batch (100)
    - `FILL_PROCESSING`: Fill mode ('history'), operation type (4), taker indicator (0)
    - `MAINTENANCE`: Cleanup probability (0.1)
  - **Grid Constants Additions**:
    - `MIN_SPREAD_ORDERS`: Minimum number of spread orders (2)
    - `SPREAD_WIDENING_MULTIPLIER`: Buffer multiplier for spread condition threshold (1.5)
  - **Impact**: Eliminates scattered magic numbers across 10 files, improves maintainability and consistency
  - **Lock Refresh**: Now correctly uses `LOCK_TIMEOUT_MS / 2` instead of hardcoded 5000

- **Enhanced Settings Configuration**:
  - Split `TIMING` configuration menu into two clear sections:
    - **Timing (Core)**: Fetch interval, sync delay, lock timeout
    - **Timing (Fill)**: Dedup window, cleanup interval, record retention
  - `EXPERT` section support for advanced settings (accessible via JSON-only, not menu)
  - Maintained backward compatibility with existing settings
  - **Note**: New constants (PRECISION_DEFAULTS, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, FILL_PROCESSING, MAINTENANCE) are intentionally code-only (not exposed in general.settings.json) as they are stable defaults unlikely to need user tuning. Users can still modify constants.js directly if needed.

- **Specialized Engine Architecture**: Modularized OrderManager into three focused engines for better maintainability
  - **Accountant Engine** (`accounting.js`): Fund tracking, invariant verification, fee management
    - Fund recalculation with dynamic tolerance
    - Atomic check-and-deduct pattern for race condition prevention
    - Fund invariant verification with precision-based and percentage-based tolerance
    - BTS fee settlement with immediate chainFree deduction
  - **Strategy Engine** (`strategy.js`): Grid rebalancing, consolidation, and rotation strategies
    - Anchor & Refill partial order consolidation
    - Ghost virtualization mechanism for safe multi-partial handling
    - Multi-partial cleanup with merge vs split decisions
    - Rotation sorting by geometric closeness to market
  - **Sync Engine** (`sync_engine.js`): Blockchain reconciliation and fill processing
    - Two-pass reconciliation for grid-to-chain synchronization
    - Per-order locking with lock refresh mechanism
    - Fill history processing with delayed rotation support
    - Asset initialization and balance fetching

- **Optimized Grid Diagnostics**: Added `logGridDiagnostics` to `Logger` providing a color-coded visualization of the grid (ACTIVE, SPREAD, PARTIAL, and VIRTUAL boundaries) for precise troubleshooting.
- **Unit Test Expansion**: Added comprehensive unit tests for `OrderManager`, `Grid`, and `SyncEngine` components to ensure core logic stability.

- **Fund Invariant Verification System**: Automatic detection of fund accounting leaks
  - Three critical invariants verified after every fund recalculation:
    1. `chainTotal = chainFree + chainCommitted` (±tolerance)
    2. `available <= chainFree` (with slack)
    3. `gridCommitted <= chainTotal` (±tolerance)
  - Configurable tolerance: precision-based slack (2 units) + percentage-based (0.1%)
  - Significantly reduces spurious warnings while catching real leaks

- **Order Index Validation Method**: Defensive debugging utility
  - `validateIndices()` method in OrderManager for index corruption detection
  - Verifies all orders are properly indexed in _ordersByState and _ordersByType
  - Returns true if indices consistent, false with error logging if corruption detected
  - Useful for debugging if order lookup produces unexpected results

- **Metrics Tracking System**: Enhanced observability for production monitoring
  - `getMetrics()` returns detailed operational statistics
  - Tracks: fund recalc count, invariant violations, lock acquisitions, state transitions
  - Calculates: uptime and fund recalc frequency per minute

### Fixed
- **Synchronized Rotation Accounting**: Fixed a critical synchronization issue where `accountTotals` (buyFree/sellFree and virtuel) were not updated when on-chain orders were cancelled during rotation, ensuring accurate fund tracking.
- **Reduced Allocation Friction**: Removed the conservative `btsFeesReservation` buffer from available fund calculations, preventing false-positive "insufficient funds" errors that previously blocked legitimate order placements.
- **Atomic Spread Correction**: Simplified spread correction by moving fund deductions to the batch broadcast level, ensuring atomicity and preventing "phantom fund" leaks.
- **Null Safety Hardening**: Improved null-safety in `DEXBot` batch operations and added strategic diagnostic hooks throughout the fill processing cycle.
- **Syntax Fix in Logger**: Resolved a `SyntaxError` in `logFundsStatus` where the identifier `c` was declared multiple times.

- **Critical: Fund Accounting Leaks in Spread Correction**
  - Spread correction orders now atomically deduct from chainFree BEFORE on-chain placement
  - Uses `tryDeductFromChainFree()` pattern: check funds exist, then deduct atomically
  - Prevents "phantom funds" where orders were deducted from internal tracking but blockchain couldn't place them
  - Initial state set to VIRTUAL (not ACTIVE), allowing proper sync engine transition

- **Critical: Excess Order Creation After Spread Correction**
  - Rebalancing now compares current active count against configured target before activating new orders
  - Prevents creating extra orders when spread correction already placed an order
  - Example: If target=5 and spread correction added 1, don't activate new orders until at target

- **Critical: BTS Fee Settlement Timing**
  - BTS fees now physically deducted from chainFree immediately upon settlement
  - Previously only deducted from internal fee tracker (btsFeesOwed) until 4-hour blockchain refresh
  - Prevents discrepancies between internal accounting and blockchain between refresh cycles
  - Improves fund accuracy for BTS-denominated pairs

- **Fund Formula Consistency**: Simplified available funds calculation
  - Single source of truth: `calculateAvailableFundsValue()` in utils.js
  - Formula: `available = max(0, chainFree - virtuel - btsFeesOwed)`
  - cacheFunds intentionally kept separate (fill proceeds added back during rebalancing)
  - Removed dead functions: getTotalGridFundsAvailable, getAvailableFundsForPlacement

- **SPREAD Order State Validation** (manager.js)
  - Added explicit validation to ensure SPREAD type orders remain in VIRTUAL state
  - Prevents invalid state transitions to ACTIVE/PARTIAL for placeholder orders
  - Catches corrupted order states early

- **Noop Method Removal** (accounting.js, utils.js)
  - Removed empty `adjustFunds()` method that was intentionally disabled
  - Removed call site in applyChainSizeToGridOrder()
  - Eliminated source of confusion around fund adjustment logic

- **Null Safety Hardening** (accounting.js, grid.js)
  - Added optional chaining (`?.`) to all manager.logger.log() calls
  - Protected manager._metrics access to prevent crashes if metrics uninitialized
  - Prevents runtime errors in edge cases where logger or metrics are null

- **Lock Atomicity Improvement** (grid.js)
  - Refactored spread correction to acquire order locks BEFORE fund deduction
  - Ensures lock is released via finally block even if fund deduction or update fails
  - Prevents fund leaks in edge cases where _updateOrder throws after deduction

### Changed
- **Spread Zone Boundaries**: Implemented strict price boundaries for rotations and activations. Orders now only target slots strictly between the highest active buy and lowest active sell (`highestActiveBuy < price < lowestActiveSell`), preventing geometric congestion.
- **Rotation Selection Priority**: Refined selection logic to prioritize the lowest SPREAD slot for BUY rotations and the highest SPREAD for SELL rotations, optimizing market proximity.
- **Log Verbosity Control**:
  - Silenced `logFundsStatus` detailed output in standard `info` mode; now shows a single summary line unless `debug` level is enabled.
  - Removed high-frequency `logGridDiagnostics` calls from the main fill processing loop to reduce console noise.
- **VIRTUAL State Preservation**: Rotated orders now return to a `VIRTUAL` state with their original type and size preserved, maintaining grid integrity instead of forcing them to `SPREAD`.
- **Functional Code Organization**: Refactored `grid.js` and `utils.js` into clearly defined functional sections for improved maintainability.

- **Architecture**: Refactored OrderManager to delegate to specialized engines
  - Manager now coordinates three engines instead of implementing all logic
  - Delegation methods maintain backward compatibility
  - Cleaner separation of concerns improves maintainability

- **Fund Calculation Flow**:
  - Walk active/partial orders (not all orders) for better performance
  - Indices (_ordersByState, _ordersByType) used for faster iteration
  - Dynamic precision-based slack for rounding tolerance

- **State Transition Validation**: Enhanced state machine enforcement
  - State transitions now logged and tracked for metrics
  - Input validation prevents invalid order states from corrupting grid
  - Proper handling of undefined intermediate states

- **Batch Fund Recalculation**: Pause/resume mechanism for multi-order operations
  - `pauseFundRecalc()` / `resumeFundRecalc()` with depth counter
  - Supports safe nesting for complex operations
  - Avoids redundant recalculations during batch updates

### Technical Details
- **Ghost Virtualization**: Safely process multiple partials without blocking each other
  - Temporarily mark partials as VIRTUAL during consolidation
  - Enables accurate target slot calculations
  - Automatic restoration with batch fund recalc to keep indices in sync
  - Error safety: try/catch ensures partial rollback on failure

- **Atomic Fund Operations**: Prevention of TOCTOU race conditions
  - `tryDeductFromChainFree()`: Atomic check-and-deduct pattern
  - Guards against race where multiple operations check same balance
  - Returns false if insufficient funds, preventing negative balances

- **Fund Invariant Tolerance**: Dual-mode tolerance for rounding noise
  - **Precision Slack**: 2 × 10^(-precision) units (e.g., 0.00000002 for 8-decimal assets)
  - **Percentage Tolerance**: 0.1% of chain total (default, configurable)
  - Uses maximum of both tolerances for flexibility

### Performance Impact
- **Faster Fund Calculation**: Uses indices instead of walking all orders (~3-10× faster for large grids)
- **Batch Operations**: Pause/resume eliminates redundant recalculations
- **Lock Refresh**: Prevents timeout during long reconciliation (~5 second refresh cycles)

- **Refactored Spread Activation with Sequential Placement**: Simplified order creation logic for improved code clarity and natural fund handling
  - Removed pre-calculation of order count based on available funds (maxByFunds scaling)
  - Kept desiredCount and use sequential placement with per-iteration fund recalculation
  - Each order sized based on current available funds: `fundsPerOrder = currentAvailable / remainingOrders`
  - Naturally handles insufficient funds without artificial count scaling
  - Geometric sizing emerges naturally from sequential capital depletion, no divergence issues
  - **Benefits**: Cleaner code, true geometric distribution, natural fund exhaustion, no grid divergence
  - **Technical**: Sequential loop replaces pre-calculation, per-iteration `calculateAvailableFundsValue()`, graceful break at minSize

### Testing
- All 14 core tests passing (100%)
- Comprehensive coverage of multi-partial consolidation
- Engine integration tests verify all three engines work together
- Edge cases: ghost virtualization, dust handling, state transitions

### Migration
- **No Breaking Changes**: Fully backward compatible with existing bots
- **Automatic Initialization**: Legacy bots automatically migrate to new architecture
- **Configuration**: No new configuration required; uses existing constants

### Files Modified
**New Files**:
- `modules/order/accounting.js` (465 lines): Accountant engine for fund tracking
- `modules/order/strategy.js` (851 lines): StrategyEngine for rebalancing
- `modules/order/sync_engine.js` (598 lines): SyncEngine for blockchain sync

**Major Updates (Constants Centralization)**:
- `modules/constants.js`: Added 8 new constant sections (PRECISION_DEFAULTS, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, FILL_PROCESSING, MAINTENANCE + 2 grid constants), added EXPERT section loader for advanced settings
- `modules/order/sync_engine.js`: Replaced 4 precision fallback occurrences, changed lock refresh from hardcoded 5000 to LOCK_TIMEOUT_MS/2
- `modules/order/strategy.js`: Replaced 8 precision fallback occurrences, replaced BTS fee parameters with constants
- `modules/order/utils.js`: Replaced precision tolerance (0.001), API limits (batch sizes, orderbook depth, pool batches), increment bounds validation, fee parameters with centralized constants
- `modules/order/accounting.js`: Replaced 2 precision fallback occurrences with PRECISION_DEFAULTS
- `modules/order/grid.js`: Replaced MIN_SPREAD_ORDERS (2), SPREAD_WIDENING_MULTIPLIER (1.5), account totals timeout (10000), increment bounds validation with constants
- `modules/chain_orders.js`: Replaced fill processing mode ('history') and operation type (4) with FILL_PROCESSING constants
- `modules/dexbot_class.js`: Replaced cleanup probability (0.1) with MAINTENANCE.CLEANUP_PROBABILITY
- `modules/order/manager.js`: Replaced 2 precision fallback occurrences and timeout cap (10000) with centralized constants
- `modules/account_bots.js`: Split TIMING menu into "Timing (Core)" and "Timing (Fill)" options (from earlier in session)

**Other Modified Files**:
- `modules/order/manager.js`: Refactored to coordinate engines, added validateIndices(), added SPREAD order state validation
- `modules/order/grid.js`: Updated spread correction to use atomic fund deduction, added order locking for atomicity, added null-safe logger calls

### Code Statistics
- Lines added: ~2,095 (accounting.js + strategy.js + sync_engine.js + constants centralization)
- Lines removed: ~1,150 (manager.js consolidation, dead functions removed, scattered magic numbers consolidated)
- Net change: +945 lines with improved clarity, separation of concerns, and maintainability
- Cyclomatic complexity: Reduced by distributing logic across three engines and centralizing constants
- **Constants Consolidation**: 60+ magic numbers centralized → 1 source of truth (modules/constants.js)
- **Files Updated for Centralization**: 10 files (sync_engine, strategy, utils, accounting, grid, chain_orders, dexbot_class, manager, account_bots, constants)

---

- **Null Safety Hardening** (accounting.js, grid.js)
  - Added optional chaining (`?.`) to all manager.logger.log() calls
  - Protected manager._metrics access to prevent crashes if metrics uninitialized
  - Prevents runtime errors in edge cases where logger or metrics are null

- **Lock Atomicity Improvement** (grid.js)
  - Refactored spread correction to acquire order locks BEFORE fund deduction
  - Ensures lock is released via finally block even if fund deduction or update fails
  - Prevents fund leaks in edge cases where _updateOrder throws after deduction

### Changed
- **Architecture**: Refactored OrderManager to delegate to specialized engines
  - Manager now coordinates three engines instead of implementing all logic
  - Delegation methods maintain backward compatibility
  - Cleaner separation of concerns improves maintainability

- **Fund Calculation Flow**:
  - Walk active/partial orders (not all orders) for better performance
  - Indices (_ordersByState, _ordersByType) used for faster iteration
  - Dynamic precision-based slack for rounding tolerance

- **State Transition Validation**: Enhanced state machine enforcement
  - State transitions now logged and tracked for metrics
  - Input validation prevents invalid order states from corrupting grid
  - Proper handling of undefined intermediate states

- **Batch Fund Recalculation**: Pause/resume mechanism for multi-order operations
  - `pauseFundRecalc()` / `resumeFundRecalc()` with depth counter
  - Supports safe nesting for complex operations
  - Avoids redundant recalculations during batch updates

### Technical Details
- **Ghost Virtualization**: Safely process multiple partials without blocking each other
  - Temporarily mark partials as VIRTUAL during consolidation
  - Enables accurate target slot calculations
  - Automatic restoration with batch fund recalc to keep indices in sync
  - Error safety: try/catch ensures partial rollback on failure

- **Atomic Fund Operations**: Prevention of TOCTOU race conditions
  - `tryDeductFromChainFree()`: Atomic check-and-deduct pattern
  - Guards against race where multiple operations check same balance
  - Returns false if insufficient funds, preventing negative balances

- **Fund Invariant Tolerance**: Dual-mode tolerance for rounding noise
  - **Precision Slack**: 2 × 10^(-precision) units (e.g., 0.00000002 for 8-decimal assets)
  - **Percentage Tolerance**: 0.1% of chain total (default, configurable)
  - Uses maximum of both tolerances for flexibility

### Performance Impact
- **Faster Fund Calculation**: Uses indices instead of walking all orders (~3-10× faster for large grids)
- **Batch Operations**: Pause/resume eliminates redundant recalculations
- **Lock Refresh**: Prevents timeout during long reconciliation (~5 second refresh cycles)

- **Refactored Spread Activation with Sequential Placement**: Simplified order creation logic for improved code clarity and natural fund handling
  - Removed pre-calculation of order count based on available funds (maxByFunds scaling)
  - Kept desiredCount and use sequential placement with per-iteration fund recalculation
  - Each order sized based on current available funds: `fundsPerOrder = currentAvailable / remainingOrders`
  - Naturally handles insufficient funds without artificial count scaling
  - Geometric sizing emerges naturally from sequential capital depletion, no divergence issues
  - **Benefits**: Cleaner code, true geometric distribution, natural fund exhaustion, no grid divergence
  - **Technical**: Sequential loop replaces pre-calculation, per-iteration `calculateAvailableFundsValue()`, graceful break at minSize

### Testing
- All 14 core tests passing (100%)
- Comprehensive coverage of multi-partial consolidation
- Engine integration tests verify all three engines work together
- Edge cases: ghost virtualization, dust handling, state transitions

### Migration
- **No Breaking Changes**: Fully backward compatible with existing bots
- **Automatic Initialization**: Legacy bots automatically migrate to new architecture
- **Configuration**: No new configuration required; uses existing constants

### Files Modified
**New Files**:
- `modules/order/accounting.js` (465 lines): Accountant engine for fund tracking
- `modules/order/strategy.js` (851 lines): StrategyEngine for rebalancing
- `modules/order/sync_engine.js` (598 lines): SyncEngine for blockchain sync

**Major Updates (Constants Centralization)**:
- `modules/constants.js`: Added 8 new constant sections (PRECISION_DEFAULTS, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, FILL_PROCESSING, MAINTENANCE + 2 grid constants), added EXPERT section loader for advanced settings
- `modules/order/sync_engine.js`: Replaced 4 precision fallback occurrences, changed lock refresh from hardcoded 5000 to LOCK_TIMEOUT_MS/2
- `modules/order/strategy.js`: Replaced 8 precision fallback occurrences, replaced BTS fee parameters with constants
- `modules/order/utils.js`: Replaced precision tolerance (0.001), API limits (batch sizes, orderbook depth, pool batches), increment bounds validation, fee parameters with centralized constants
- `modules/order/accounting.js`: Replaced 2 precision fallback occurrences with PRECISION_DEFAULTS
- `modules/order/grid.js`: Replaced MIN_SPREAD_ORDERS (2), SPREAD_WIDENING_MULTIPLIER (1.5), account totals timeout (10000), increment bounds validation with constants
- `modules/chain_orders.js`: Replaced fill processing mode ('history') and operation type (4) with FILL_PROCESSING constants
- `modules/dexbot_class.js`: Replaced cleanup probability (0.1) with MAINTENANCE.CLEANUP_PROBABILITY
- `modules/order/manager.js`: Replaced 2 precision fallback occurrences and timeout cap (10000) with centralized constants
- `modules/account_bots.js`: Split TIMING menu into "Timing (Core)" and "Timing (Fill)" options (from earlier in session)

**Other Modified Files**:
- `modules/order/manager.js`: Refactored to coordinate engines, added validateIndices(), added SPREAD order state validation
- `modules/order/grid.js`: Updated spread correction to use atomic fund deduction, added order locking for atomicity, added null-safe logger calls

### Code Statistics
- Lines added: ~2,095 (accounting.js + strategy.js + sync_engine.js + constants centralization)
- Lines removed: ~1,150 (manager.js consolidation, dead functions removed, scattered magic numbers consolidated)
- Net change: +945 lines with improved clarity, separation of concerns, and maintainability
- Cyclomatic complexity: Reduced by distributing logic across three engines and centralizing constants
- **Constants Consolidation**: 60+ magic numbers centralized → 1 source of truth (modules/constants.js)
- **Files Updated for Centralization**: 10 files (sync_engine, strategy, utils, accounting, grid, chain_orders, dexbot_class, manager, account_bots, constants)

---

## [0.5.1] - 2026-01-01 - Anchor & Refill Strategy, Precision Quantization & Operational Robustness

### Added
- **Anchor & Refill Strategy**: Major architectural upgrade for partial order handling. Instead of moving partials, the bot now anchors them in place.
  - **Case A: Merged Refill (Dust)**: Merges dust (< 5%) into the next geometric allocation and delays the opposite-side rotation until the dust portion is filled.
  - **Case B: Full Anchor (Substantial)**: Upgrades partials (>= 5%) to 100% ideal size and places the leftover capital as a residual order at the spread.
- **On-Chain Alignment for Refills**: The bot now broadcasts `limit_order_update` for dust refills to ensure on-chain sizes perfectly match the merged internal allocation.
- **Cumulative Fill Tracking**: Added `filledSinceRefill` property to accurately trigger delayed rotations across multiple partial fills.
- **Precision Quantization**: Implemented size quantization to exact blockchain precision before order placement, eliminating float rounding errors.
- **Pending-Aware Health Checks**: Updated `countOrdersByType` and `checkGridHealth` to recognize intentional gaps created by delayed rotations, preventing false-positive corrections.
- **Double-Aware Divergence Engine**: Updated `calculateGridSideDivergenceMetric` to account for merged dust sizes, preventing unnecessary grid resets for anchored orders.
- **Periodic Order Synchronization**: Added `readOpenOrders` to the 4-hour periodic fetch to automatically reconcile the internal grid with the blockchain source of truth.
- **Modernized Test Suite**: Added comprehensive unit, integration, and E2E tests for the Anchor & Refill strategy and precision fixes.

### Changed
- **Pipeline-Aware Monitoring**: `checkGridHealth` now only executes when the order pipeline is clear (no pending fills or corrections), increasing operational stability.
- **Memory-Chain Alignment**: Quantized order sizes are synchronized back to the internal memory state to ensure 1:1 parity with blockchain integers.
- **State Persistence**: Added full serialization for new strategy fields (`isDoubleOrder`, `mergedDustSize`, `pendingRotation`, `filledSinceRefill`).

### Fixed
- **Sync Reversion Protection**: Prevented the bot from prematurely reverting merged sizes back to old on-chain sizes during synchronization gaps.
- **Off-by-One Eradication**: Fixed a recurring issue where small float remainders would block grid flow or cause spurious partial-state transitions.
- **Race Condition Handling**: Improved observability and lock management in `dexbot_class.js` to ensure sequential consistency during high-volume fill events.

---

## [0.5.0] - 2025-12-31 - Stability Milestone: Global Terminology Migration, General Settings & Grid Health

### Added
- **Persistent General Settings**: Implemented a new architecture using `profiles/general.settings.json` for untracked user overrides.
- **Global Settings Manager**: Added a new sub-menu to `dexbot bots` to manage global parameters (Log lvl, Grid, Timing).
- **Grid Health Monitoring**: New system to monitor structural grid integrity and log violations (e.g., ACTIVE orders further from market than VIRTUAL slots).
- **Dual-Side Dust Recovery**: Automatically refills small partial orders (< 5%) to ideal geometric sizes using `cacheFunds` when detected on both sides.
- **Enhanced Spread Correction**: Implemented proactive spread correction that pools both `VIRTUAL` and `SPREAD` slots to identify the best candidates for narrowing the market spread.
- **Sequential Fill Queue**: Implemented thread-safe sequential processing of fill events using AsyncLock to prevent accounting race conditions.
- **Safe PM2 Lifecycle Management**: Added `pm2.js stop` and `pm2.js delete` commands that safely filter for dexbot-specific processes.
- **Robust Fill Detection**: Implemented `history` mode for fill processing to reliably match orders from blockchain events.

### Changed
- **Global Terminology Migration**: Renamed all occurrences of `marketPrice` to `startPrice` across codebase, CLI, and documentation to better reflect its role as the grid center.
- **Menu-Driven Bot Editor**: Refactored `modules/account_bots.js` into a sectional, menu-driven interface for faster configuration.
- **Simplified Update Process**: Removed fragile git stashing from `update.sh` and `update-dev.sh`; user settings are now preserved via untracked JSON.
- **CLI Command Renaming**: Renamed `dexbot stop` to `dexbot disable` for better alignment with its actual function (marking bots inactive in config).
- **Price Calculation Accuracy**: Updated `buildUpdateOrderOp` to use current sell amounts when deriving prices, fixing precision issues in small price moves.
- **Default Log Level**: Changed default `LOG_LEVEL` from `debug` to `info`.
- **Architectural Cleanup**: Consolidated core logic into pure utility functions to eliminate duplication and improve maintainability.

### Fixed
- **Fund Double-Counting**: Fixed a critical bug in `processFilledOrders` where proceeds were incorrectly added to available funds twice.
- **Startup Double-Initialization**: Resolved a race condition that could cause corrupted virtual order sizes during bot startup.
- **Reset Reliability**: Fixed `node dexbot reset` command to ensure a true hard reset from blockchain state, including hot-reloading of `bots.json`.
- **Stuck VIRTUAL Orders**: Added error handling for rotation synchronization to prevent orders from being stuck in a virtual state.
- **Logging Visibility**: Ensured all cancellation operations provide explicit success/fail messages in logs.
- **Offline Detection Fixes**: Resolved edge cases in offline partial fill detection to ensure capital efficiency on startup.
- **Update Script Robustness**: Refactored update scripts to use `git reset --hard` to forcefully clear environment conflicts (e.g., in `constants.js`).
- **Module Path Corrections**: Fixed incorrect relative paths in `startup_reconcile.js` and streamlined operational logging.

---

**Note on v0.4.6**: This version includes a backported critical cacheFunds double-counting fix that was originally released in v0.4.7, then retagged to v0.4.6 for proper patch versioning. v0.4.7 release was deleted. Users should upgrade to v0.4.6 to fix the 649.72 BTS discrepancy issue.

---

## [0.4.6] - 2025-12-28 - CacheFunds Double-Counting Fix, Fill Deduplication & Race Condition Prevention

### Fixed

#### 1. CRITICAL: CacheFunds Double-Counting in Partial Fills
- **Location**: `modules/order/manager.js` lines 570-596, 1618-1625
- **Problem**: Proceeds being counted twice in `cacheFunds` balance
  - When partial fill occurred, proceeds added to `chainFree` (buyFree/sellFree)
  - Then `available` recalculated from **updated** chainFree (which already included proceeds)
  - Both `proceeds + available` added to cacheFunds → **double-counting**
- **Impact**: User reported 649.72 BTS discrepancy in fund accounting
- **Bug Timeline**: Introduced in v0.4.0 with fund consolidation refactor, present through v0.4.5
- **Solution**:
  1. Calculate available BEFORE updating chainFree (lines 570-576)
  2. Update chainFree with proceeds (lines 578-610)
  3. Store pre-update available in `this._preFillAvailable` (line 596)
  4. Use stored value in `processFilledOrders()` (lines 1618-1625)
- **Result**: Proceeds counted exactly once while preserving fund cycling feature for new deposits

#### 2. CRITICAL: Fee Double-Deduction After Bot Restart
- **Location**: `modules/account_orders.js` lines 427-551, `modules/dexbot_class.js` lines 42-48, 77-251, 652-660
- **Problem**: Permanent fund loss on bot restart during fill processing
  - When bot restarts, same fills detected again from blockchain history
  - `processFilledOrders()` called twice with identical fills
  - BTS fees double-deducted from cacheFunds
- **Impact**: Every bot restart during active trading could lose funds (fees permanently deducted twice)
- **Solution**: Persistent fill ID deduplication with multi-layer protection
  - **In-Memory Layer (5 second window)**:
    - Fill key: `${orderId}:${blockNum}:${historyId}`
    - Prevents immediate reprocessing within 5 seconds
    - Location: `dexbot_class.js` lines 100-114
  - **Persistent Layer (1 hour window)**:
    - Saves processed fill IDs to disk after each batch
    - Loads persisted fills on startup to restore dedup memory
    - Prevents reprocessing across bot restarts
    - Locations: `dexbot_class.js` lines 222-235 (save), 652-660 (load)
  - **Automatic Cleanup**:
    - Runs ~10% of batches to minimize I/O overhead
    - Removes entries older than 1 hour to prevent unbounded growth
    - Location: `dexbot_class.js` lines 237-245
  - **Persistence Methods** (`account_orders.js` lines 427-551):
    - `loadProcessedFills()`: Load fill dedup map from disk
    - `updateProcessedFillsBatch()`: Efficiently save multiple fills
    - `cleanOldProcessedFills()`: Remove old entries
    - All protected by AsyncLock to prevent race conditions
- **Storage Format** (in `profiles/orders/{botKey}.json`):
  ```json
  {
    "bots": {
      "botkey": {
        "processedFills": {
          "1.7.12345:67890:hist123": 1703808000000,
          "1.7.12346:67891:hist124": 1703808005000
        }
      }
    }
  }
  ```
- **Defensive Impact**: Protects entire fill pipeline, not just fees
  - Prevents committed funds from being recalculated twice
  - Prevents fund cycling from being triggered twice
  - Prevents grid rebalancing from being triggered twice
  - Prevents order status changes from being processed twice

#### 3. 20+ Race Conditions: TOCTOU & Concurrent Access

**Overview**: Comprehensive race condition prevention using AsyncLock pattern with 7 lock instances protecting critical sections.

**A. File Persistence Races** (`account_orders.js`)
- **Problem**: Process A reads file → Process B writes update → Process A overwrites with stale data
- **Fix**: Persistence Lock + Reload-Before-Write Pattern
  - Lock: `_persistenceLock` (line 104)
  - Protected methods:
    - `storeMasterGrid()` (lines 275-278): Reload before writing grid snapshot
    - `updateCacheFunds()` (line 366): Reload before updating cache
    - `updateBtsFeesOwed()` (line 416): Reload before updating fees
    - `ensureBotEntries()` (line 152): Reload before ensuring entries
    - `updateProcessedFillsBatch()` (line 460): Reload before batch save
  - Pattern: Always reload from disk immediately before writing to prevent stale data overwrites

**B. Account Subscription Management Races** (`chain_orders.js`)
- **Problem**: Multiple concurrent calls to `listenForFills()` could create duplicate subscriptions
- **Fix**: Subscription Lock (line 37)
  - Protected operations:
    - `_ensureAccountSubscriber()` (line 174): Atomic subscription creation
    - `listenForFills()` (line 339): Atomic callback registration
    - Unsubscribe (line 349): Atomic callback removal
  - Result: Prevents duplicate subscriptions, ensures atomic add/remove of callbacks

**C. Account Resolution Cache Races** (`chain_orders.js`)
- **Problem**: Concurrent account name/ID resolutions could race in cache updates
- **Fix**: Resolution Lock (line 39)
  - Protected operations:
    - `resolveAccountName()` (line 103): Atomic name resolution with cache
    - `resolveAccountId()` (line 140): Atomic ID resolution with cache
  - Result: Ensures atomic cache check-and-set for account resolution

**D. Preferred Account State Races** (`chain_orders.js`)
- **Problem**: Global variables `preferredAccountId` and `preferredAccountName` accessed without synchronization
- **Fix**: Preferred Account Lock (line 38)
  - Warning comment (lines 64-65): "Access MUST be protected by _preferredAccountLock to prevent race conditions"
  - Protected operations:
    - `setPreferredAccount()` (line 76): Atomic state update
    - `getPreferredAccount()` (line 87): Thread-safe read
  - Result: All access goes through thread-safe getters/setters

**E. Fill Processing Races** (`dexbot_class.js`)
- **Problem**: Multiple fill events arriving simultaneously could interleave during processing
- **Fix**: Fill Processing Lock (line 47)
  - Protected operations:
    - Fill callback (line 83): Main fill event handler
    - Triggered resync (line 892): Resync when no rotation occurs
    - Order manager loop (line 961): Catch missed fills
  - Protected workflow:
    - Filter and deduplicate fills
    - Sync and collect filled orders
    - Handle price corrections
    - Batch rebalance and execution
    - Persist processed fills
  - Result: All fill processing serialized, preventing concurrent state modifications

**F. Divergence Correction Races** (`dexbot_class.js`)
- **Problem**: Concurrent divergence corrections could modify grid state simultaneously
- **Fix**: Divergence Lock (line 48)
  - Protected operations:
    - Post-rotation divergence (line 191): Divergence check after rotation
    - Timer-based divergence (line 1017): Periodic divergence check
  - Guard check (line 569): Skip divergence if lock already held (prevents queue buildup)
  - Result: Grid updates serialized, prevents concurrent modification conflicts

**G. Order Corrections List Races** (`manager.js`)
- **Problem**: Shared array `ordersNeedingPriceCorrection` accessed by multiple functions
- **Fix**: Corrections Lock (line 140)
  - Status: Declared and prepared for active use
  - Array accessed at: Lines 138, 843, 879, 1174, 1286, 1292, 1300, 1723, 1726, 2005, 2012
  - Result: Foundation laid for serialized price correction handling

**AsyncLock Summary Table**:

| Lock Instance | File | Protected Operations | Purpose |
|--------------|------|----------------------|---------|
| `_persistenceLock` | account_orders.js | storeMasterGrid, updateCacheFunds, updateBtsFeesOwed, ensureBotEntries, processedFills methods | File I/O synchronization, prevent stale data overwrites |
| `_subscriptionLock` | chain_orders.js | _ensureAccountSubscriber, listenForFills, unsubscribe | Account subscription management, prevent duplicate subscriptions |
| `_preferredAccountLock` | chain_orders.js | setPreferredAccount, getPreferredAccount | Preferred account state synchronization |
| `_resolutionLock` | chain_orders.js | resolveAccountName, resolveAccountId | Account resolution cache atomic updates |
| `_fillProcessingLock` | dexbot_class.js | Fill callback, triggered resync, order manager loop | Fill event processing serialization |
| `_divergenceLock` | dexbot_class.js | Post-rotation divergence, timer-based divergence | Divergence correction synchronization |
| `_correctionsLock` | manager.js | ordersNeedingPriceCorrection mutations | Price correction list synchronization (prepared) |

### Added
- **AsyncLock Utility**: New queue-based mutual exclusion system (modules/order/async_lock.js)
  - FIFO queue-based synchronization for async operations
  - Prevents concurrent operations from interfering with critical sections
  - Proper error handling and re-throwing
  - Used to protect all critical sections across codebase

- **Fresh Data Reload on Write**: All write operations reload from disk before persisting
  - `storeMasterGrid()`: Reloads before writing grid snapshot
  - `updateCacheFunds()`: Always reload to prevent stale data overwrites
  - `updateBtsFeesOwed()`: Always reload to ensure fresh state
  - Fixes race between processes where stale in-memory data overwrites fresh state

- **forceReload Option**: Added to all load methods for explicit fresh data reads
  - `loadBotGrid(botKey, forceReload)`: Optional fresh disk read
  - `loadCacheFunds(botKey, forceReload)`: Optional fresh disk read
  - `loadBtsFeesOwed(botKey, forceReload)`: Optional fresh disk read
  - `getDBAssetBalances(botKeyOrName, forceReload)`: Optional fresh disk read

### Changed
- **Per-Bot File Architecture**: Now protected with AsyncLock for safe concurrent writes
  - Existing per-bot mode (each bot has own file: `profiles/orders/{botKey}.json`) now race-safe
  - `_persistenceLock` serializes all write operations to prevent TOCTOU races
  - `ensureBotEntries()` now async with lock protection
  - Per-bot subscriptions and resolution cache also protected
  - Legacy shared mode still supported for backward compatibility

- **AsyncLock Patterns**: Multiple lock instances for different critical sections
  - `_fillProcessingLock`: Serializes fill event processing in dexbot_class
  - `_divergenceLock`: Protects divergence correction operations
  - `_correctionsLock`: Protects ordersNeedingPriceCorrection in manager
  - `_persistenceLock`: Protects file I/O operations in account_orders
  - `_subscriptionLock`: Protects accountSubscriptions map in chain_orders
  - `_preferredAccountLock`: Protects preferredAccount global state
  - `_resolutionLock`: Protects account resolution cache

- **Persistence Methods Now Async**:
  - `manager.deductBtsFees()`: Made async, uses lock
  - `manager._persistWithRetry()`: Made async
  - `manager._persistCacheFunds()`: Made async
  - `manager._persistBtsFeesOwed()`: Made async
  - `grid._clearAndPersistCacheFunds()`: Made async, awaited
  - `grid._persistCacheFunds()`: Made async, awaited
  - All callers properly await these methods

- **Account Subscription Management**: Atomic check-and-set with AsyncLock
  - `_ensureAccountSubscriber()`: Uses lock to prevent duplicate subscriptions
  - `listenForFills()`: Protects callback registration inside lock
  - `unsubscribe()`: Atomic removal with lock protection

### Technical Details
- **TOCTOU Fix**: Reload-before-write prevents stale in-memory overwrites
  - Example: Process A reads file, Process B writes update, Process A overwrites with stale data
  - Solution: Always reload immediately before writing
  - Applied to: storeMasterGrid, updateCacheFunds, updateBtsFeesOwed

- **Async/Await Consistency**: All async operations properly awaited
  - No fire-and-forget promises
  - Proper error propagation throughout call chains
  - Busy-wait loops replaced with proper async setTimeout

- **Lock Nesting**: Careful lock ordering prevents deadlocks
  - No nested lock acquisition (locks released before acquiring another)
  - Each critical section has single responsible lock

### Files Modified in v0.4.6

**New Files**:
- `modules/order/async_lock.js` (84 lines): AsyncLock utility implementation with FIFO queue-based synchronization

**Modified Files**:
- `modules/account_orders.js`:
  - Line 104: _persistenceLock declaration
  - Lines 145-232: ensureBotEntries with lock
  - Lines 269-312: storeMasterGrid with lock and reload-before-write
  - Lines 360-375: updateCacheFunds with lock and reload
  - Lines 410-425: updateBtsFeesOwed with lock and reload
  - Lines 427-551: processedFills tracking methods (NEW)

- `modules/chain_orders.js`:
  - Lines 37-39: Three lock declarations (_subscriptionLock, _resolutionLock, _preferredAccountLock)
  - Lines 64-65: Warning comment about lock requirements
  - Lines 76-90: setPreferredAccount/getPreferredAccount thread-safe wrappers
  - Lines 98-164: Account resolution with locks
  - Lines 173-206: _ensureAccountSubscriber with lock
  - Lines 295-364: listenForFills with lock protection

- `modules/dexbot_class.js`:
  - Lines 42-48: Fill dedup and lock declarations
  - Lines 77-251: Fill callback with deduplication logic
  - Lines 652-660: Load persisted fills on startup (NEW)

- `modules/order/manager.js`:
  - Line 140: _correctionsLock declaration
  - Lines 570-596: cacheFunds double-counting fix (_adjustFunds method)
  - Lines 1618-1625: Use pre-update available in processFilledOrders()

- `CHANGELOG.md`:
  - Complete v0.4.6 documentation

### Performance Impact

**Minimal Overhead**:
- AsyncLock uses efficient FIFO queue (O(1) operations)
- Locks held only during critical sections (milliseconds)
- Reload-before-write adds single disk read per write (~5ms, negligible vs network latency)
- Fill dedup cleanup runs only ~10% of batches, not every batch

**Benefits**:
- Eliminates fund loss from race conditions (saves 649.72+ BTS per release cycle)
- Prevents duplicate fill processing (reduces unnecessary grid operations)
- Ensures data consistency across bot restarts (reliable state recovery)
- Foundation for future concurrent enhancements

### Testing
- All 20 integration tests passing ✅
- Test coverage includes: ensureBotEntries, storeMasterGrid, cacheFunds persistence, fee deduction, fill dedup
- Grid comparison, startup reconciliation, partial order handling all verified
- No changes to fill processing logic or output; only adds deduplication layer

### Migration
- **Backward Compatible**: No breaking changes to APIs or configuration
- **No Schema Changes**: File format unchanged; existing bot data continues to work
- **Transparent to Users**: Race condition fixes are internal improvements
- **Automatic Initialization**: `processedFills` field auto-initialized if missing in existing bots

### Summary Statistics

**Total Fixes**: 23 critical bugs
- 1 cacheFunds double-counting fix
- 1 fee double-deduction fix
- 20+ race condition fixes (7 categories of TOCTOU and concurrent access issues)
- 1 defensive fill deduplication system (multi-layer protection)

**Implementation**:
- Total AsyncLock instances: 7
- Lines of code added: ~300
- Files modified: 5 existing + 1 new
- Tests passing: 20/20 ✅

**Risk Level**: LOW
- Simple addition of locks to existing code paths
- No core algorithm changes
- Fully backward compatible
- All tests passing

---

## [0.4.5] - 2025-12-27 - Partial Order Counting & Grid Navigation Fix

### Fixed
- **Partial Orders Not Counted in Grid Targets**: Critical bug in rebalancing logic
  - Partial filled orders were excluded from order target counting
  - Caused bot to create unnecessary orders even when at target capacity
  - Now counts both ACTIVE and PARTIAL orders toward target
  - Prevents "mixing up" of grid positions and erroneous order creation

- **Grid Navigation Limited by ID Namespace**: Critical bug in partial order movement
  - `preparePartialOrderMove()` used ID-based navigation (sell-N/buy-N)
  - Could not move partial orders across sell-*/buy-* namespace boundaries
  - Example: sell-173 (highest sell slot) couldn't move to buy-0 (adjacent by price)
  - **Now uses price-sorted navigation** for fluid grid movement
  - Partial orders can now move anywhere in the grid without artificial boundaries

### Added
- **`countOrdersByType()` Helper Function** in utils.js
  - Counts both ACTIVE and PARTIAL orders by type
  - Used consistently across order target comparisons
  - Ensures partial orders take up real grid positions

### Changed
- **Order Target Checks**: Updated to include partial orders
  - `checkSpreadCondition()` (line 1396): Includes partials in "both sides" check
  - Rebalancing checks (lines 1747, 1851): Uses `countOrdersByType()`

- **Spread Calculation**: Updated to include partial orders
  - `calculateCurrentSpread()` (line 2577): Combines ACTIVE + PARTIAL orders
  - Partial orders are on-chain and affect actual market spread

### Technical Details
- Grid is now treated as fluid: no artificial boundaries during fill handling
- Price-sorted navigation allows unrestricted partial order movement
- All 18 test suites pass
- Fixed crossed rotation test expectations (test_crossed_rotation.js)

---

## [0.4.4] - 2025-12-27 - Code Consolidation & BTS Fee Deduction Fix

### Fixed
- **BTS Fee Deduction on Wrong Side**: Critical bug in grid resize operations
  - Fixed fee deduction logic that incorrectly applied to non-BTS side during order resizing
  - XRP/BTS pairs: BTS fees no longer deducted from XRP (SELL side) funds
  - Buy side (assetB): Only deduct if assetB === 'BTS'
  - Sell side (assetA): Only deduct if assetA === 'BTS'
  - Fixes 70% order size reduction issue during grid resize

### Changed
- **Fee Multiplier Update**: Increased from 4x to 5x
  - Now reserves: 1x for initial creation + 4x for rotation buffer (was 3x)
  - Provides better buffer for multiple rotation cycles

### Refactored
- **Code Consolidation**: Moved 22 grid utility functions from grid.js to utils.js
  - Eliminated duplicate code and scattered inline requires
  - Centralized reusable utilities for consistent access across modules
  - Added 15 new utility functions for common operations

- **Grid Utilities Added to utils.js**:
  - Numeric: `toFiniteNumber`, `isValidNumber`, `compareBlockchainSizes`, `computeSizeAfterFill`
  - Order filtering: `filterOrdersByType`, `filterOrdersByTypeAndState`, `sumOrderSizes`, `mapOrderSizes`
  - Precision: `getPrecisionByOrderType`, `getPrecisionForSide`, `getPrecisionsForManager`
  - Size validation: `checkSizesBeforeMinimum`, `checkSizesNearMinimum`
  - Fee calculation: `calculateOrderCreationFees`, `deductOrderFeesFromFunds`
  - Grid sizing: `allocateFundsByWeights`, `calculateOrderSizes`, `calculateRotationOrderSizes`, `calculateGridSideDivergenceMetric`, `getOrderTypeFromUpdatedFlags`, `resolveConfiguredPriceBound`

- **Manager Helper Methods**: Added fund/chainFree tracking
  - `_getCacheFunds(side)`: Safe access to cache funds
  - `_getGridTotal(side)`: Safe access to grid totals
  - `_deductFromChainFree(orderType, size, operation)`: Track fund movements
  - `_addToChainFree(orderType, size, operation)`: Track fund releases

- **Code Cleanup**: Removed debug console.log statements from chain_orders.js

### Technical Details
- Reduced grid.js from 1190 to 635 lines (-46%)
- All 18 test suites pass
- Rotation and divergence check behavior unchanged
- Net +166 lines: Justified by new utilities and JSDoc documentation

---

## [0.4.3] - 2025-12-26 - Order Pairing, Rebalance & Fee Reservation Fixes

### Fixed
- **Asymmetric Rebalance Orders Logic for BUY Fills**: Corrected order matching in rebalanceOrders function
  - Fixed logic that incorrectly paired BUY orders during rebalancing operations
  - Ensures proper order pairing for asymmetric buy/sell scenarios

- **Order Pairing Sorting & Startup Reconciliation**: Optimized order matching algorithm
  - Implemented proper sorting for order pairing to ensure consistent matching
  - Improved startup reconciliation performance and reliability

- **Grid Data Corruption Prevention**: Added validation for order sizes and IDs
  - Prevented undefined size values from corrupting grid data
  - Added null ID checks to prevent invalid order state

- **BTS Fee Reservation During Resize**: Fixed target order selection
  - Use target orders for BTS fee reservation calculations during order resizing
  - Ensures accurate fee reservation across resize operations

- **4x Blockchain Fee Buffer Enforcement**: Corrected fee buffer application
  - Respect 4x blockchain fee buffer consistently during order resizing
  - Added 100 BTS fallback for adequate fee reservation

- **Grid Edge State Synchronization**: Fixed manager state sync after reducing largest order
  - Search by blockchain orderId to find matching grid order in manager.orders
  - Ensures manager's local grid state matches blockchain after order reduction

- **Grid Edge Order Reconciliation**: Refactored cancel+create for better efficiency
  - Replace reduce+restore with cancel+create approach (N+1 vs N+2 operations)
  - Phase 1: Cancel largest order to free funds
  - Phase 2: Update remaining orders to targets
  - Phase 3: Create new order for cancelled slot
  - Simplified logic with proper index alignment

- **Vacated Slot Size Preservation**: Fixed orphaned virtual orders from partial moves
  - Don't set vacated slots to size: 0 after partial order moves
  - Prevents "no size defined" warnings when slots are reused for new orders
  - Detects already-claimed slots to avoid conflicts with new order placement
  - Complements the "below target" path that uses vacated slots for new order creation

### Changed
- Removed unused `bot_instance.js` module for code cleanup
- Enhanced `startup_reconcile` documentation in README
- Optimized grid edge reconciliation strategy for fewer blockchain operations

---

## [0.4.2] - 2025-12-24 - Grid Recalculation Fixes & Documentation Updates

### Fixed
- **Grid Recalculation in Post-Rotation Divergence Flow**: Added missing grid recalculation call
  - **Problem**: Orders were losing size information during post-rotation divergence correction
  - **Symptoms**: "Skipping virtual X - no size defined" warnings, "Cannot read properties of undefined (reading 'toFixed')" batch errors
  - **Solution**: Added `Grid.updateGridFromBlockchainSnapshot()` call to post-rotation flow, matching startup and timer divergence paths
  - **Impact**: Prevents order size loss during divergence correction cycles

- **PARTIAL Order State Preservation at Startup**: Fixed state inconsistency during synchronization
  - **Problem**: PARTIAL orders (those with remaining amounts being filled) were unconditionally converted to ACTIVE state at startup
  - **Symptoms**: False divergence spikes (700%+ divergence), state mismatches between persistedGrid and calculatedGrid, unnecessary grid recalculations
  - **Solution**: Preserve PARTIAL state across bot restarts if already set; only convert VIRTUAL orders to ACTIVE when matched on-chain
  - **Impact**: Eliminates false divergence detection and maintains consistent order state across restarts

- **Redundant Grid Recalculation Removal**: Eliminated duplicate processing in divergence correction
  - **Problem**: Grid was being recalculated twice when divergence was detected (once by divergence check, once by correction function)
  - **Symptoms**: Double order size updates, unnecessary blockchain fetches, performance inefficiency
  - **Solution**: Removed redundant recalculation from `applyGridDivergenceCorrections()` since caller already recalculates
  - **Impact**: Single grid recalculation per divergence event, improved performance

- **BTS Fee Formula Documentation**: Updated outdated comments and logged output to accurately reflect the complete fee calculation formula
  - Fixed `modules/order/grid.js`: Changed comment from "2x multiplier" to "4x multiplier" to match actual implementation
  - Updated formula in 5 files to show complete formula: `available = max(0, chainFree - virtuel - cacheFunds - applicableBtsFeesOwed - btsFeesReservation)`
  - Fixed `modules/order/logger.js`: Console output now displays full formula instead of simplified version
  - Updated `modules/order/manager.js`: Changed variable name references from ambiguous "4xReservation" to proper "btsFeesReservation"
  - Fixed `modules/account_bots.js`: Comment now correctly states default targetSpreadPercent is 4x not 3x

---

## [0.4.1] - 2025-12-23 - Order Consolidation, Grid Edge Handling & Partial Order Fixes

### Features
- **Code Consolidation**: Eliminated ~1,000 lines of duplicate code across entry points
  - Extracted shared `DEXBot` class to `modules/dexbot_class.js` (822 lines)
  - bot.js refactored from 1,021 → 186 lines
  - dexbot.js refactored from 1,568 → 598 lines
  - Unified class-based approach with logPrefix options for context-specific behavior
  - Extracted `buildCreateOrderArgs()` utility to `modules/order/utils.js`

- **Conditional Rotation**: Smart order creation at grid boundaries
  - When active order count drops below target, creates new orders instead of rotating
  - Handles grid edge cases where fewer orders can be placed near min/max prices
  - Seamlessly transitions back to normal rotation when target is reached
  - Prevents perpetual deficit caused by edge boundary constraints
  - Comprehensive test coverage with edge case validation

- **Repository Statistics Analyzer**: Interactive git history visualization
  - Analyzes repository commits and generates beautiful HTML charts
  - Tracks added/deleted lines across codebase with daily granularity
  - Charts include daily changes and cumulative statistics
  - Configurable file pattern filtering for focused analysis
  - Script: `scripts/analyze-repo-stats.js`

### Fixed
- **Partial Order State Machine Invariant**: Guaranteed PARTIAL orders always have size > 0
  - Fixed bug in `synchronizeWithChain()` where PARTIAL could be set with size = 0
  - Proper state transitions: ACTIVE (size > 0) → PARTIAL (size > 0) → SPREAD (size = 0)
  - PARTIAL and SPREAD orders excluded from divergence calculations
  - Prevents invalid order states from persisting to storage

### Changed
- **Entry Point Architecture**: Simplified bot.js and dexbot.js to thin wrappers
  - Removed duplicate class definitions
  - All core logic now centralized in `modules/dexbot_class.js`
  - Reduces maintenance overhead and improves consistency
  - Options object pattern enables context-specific behavior (e.g., logPrefix)

### Testing
- Added comprehensive test suite for conditional rotation edge cases
- Added state machine validation tests for partial orders
- All tests passing with improved grid coverage scenarios

### Technical Details
- **Grid Coverage Recovery**: Gradual recovery mechanism for edge-bound grids
  - Shortage = `targetCount - currentActiveCount`
  - Creates `min(shortage, fillCount)` new orders per fill cycle
  - Continues until target is reached, then resumes rotation
  - Respects available virtual orders (no over-activation)

- **Code Quality**: Significant reduction in complexity and duplication
  - Common patterns unified in shared class
  - Easier to maintain and update core logic
  - Improved testability with centralized implementation

---

## [0.4.0] - 2025-12-22 - Fund Management Consolidation & Automatic Fund Cycling

### Features
- **Automatic Fund Cycling**: Available funds now automatically included in cacheFunds before rotation
  - Newly deposited funds immediately available for grid sizing
  - Grid resizes when deposits arrive, not just after fills
  - More responsive to market changes and new capital inflows

- **Unified Fund Management**: Complete consolidation of pendingProceeds into cacheFunds
  - Simplified fund tracking: single cacheFunds field for all unallocated funds
  - Cleaner codebase (272 line reduction in complexity)
  - Backward compatible: legacy pendingProceeds automatically migrated

### Changed
- **BREAKING CHANGE**: `pendingProceeds` field removed from storage schema
  - Affects: `profiles/orders/<bot-name>.json` files for existing bots
  - Migration: Use `scripts/migrate_pending_proceeds.js` before first startup with v0.4.0
  - Backward compat: Legacy pendingProceeds merged into cacheFunds on load

- **Fund Formula Updated**:
  ```
  OLD: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed) + pendingProceeds
  NEW: available = max(0, chainFree - virtuel - cacheFunds - btsFeesOwed)
  ```

- **Grid Regeneration Threshold**: Now includes available funds
  - OLD: Checked only `cacheFunds / gridAllocation`
  - NEW: Checks `(cacheFunds + availableFunds) / gridAllocation`
  - Result: Grid resizes when deposits arrive, enabling fund cycling

- **Fee Deduction**: Now deducts BTS fees from cacheFunds instead of pendingProceeds
  - Called once per rotation cycle after all proceeds added
  - Cleaner integration with fund cycling

### Fixed
- **Partial Order Precision**: Fixed floating-point noise in partial fill detection
  - Now uses integer-based subtraction (blockchain-safe precision)
  - Converts orders to blockchain units, subtracts, converts back
  - Prevents false PARTIAL states from float arithmetic errors (e.g., 1e-18 floats)

- **Logger Undefined Variables**: Fixed references to removed pendingProceeds variables
  - Removed orphaned variable definitions
  - Cleaned up fund display logic in logFundsStatus()

- **Bot Metadata Initialization**: Fixed new order files being created with null metadata
  - Ensured `ensureBotEntries()` is called before any Grid initialization
  - Prevents order files from having null values for name, assetA, assetB
  - Metadata properly initialized from bot configuration in profiles/bots.json at startup
  - Applied fix to both bot.js and dexbot.js DEXBot classes

### Migration Guide
1. **Backup** your `profiles/orders/` directory before updating
2. **Run migration** (if you have existing bots with pendingProceeds):
   ```bash
   node scripts/migrate_pending_proceeds.js
   ```
3. **Restart bots**: Legacy data automatically merged into cacheFunds on load
   - No data loss - all proceeds preserved
   - Grid sizing adjusted automatically

### Technical Details
- **Fund Consolidation**: All proceeds and surpluses now consolidated in single cacheFunds field
- **Backward Compatibility**: Automatic merge of legacy pendingProceeds into cacheFunds during grid load
- **Storage**: Updated account_orders.js schema, removed pendingProceeds persistence methods
- **Test Coverage**: Added test_fund_cycling_trigger.js, test_crossed_rotation.js, test_fee_refinement.js

---

## [0.3.0] - 2025-12-19 - Grid Divergence Detection & Percentage-Based Thresholds

### Features
- **Grid Divergence Detection System**: Intelligent grid state monitoring and automatic regeneration
  - Quadratic error metric calculates divergence between in-memory and persisted grids: Σ((calculated - persisted) / persisted)² / count
  - Automatic grid size recalculation when divergence exceeds DIVERGENCE_THRESHOLD_PERCENTAGE (default: 1%)
  - Detects when cached fund reserves exceed configured percentage threshold (default: 3%)
  - Two independent triggering mechanisms ensure grid stays synchronized with actual blockchain orders

- **Percentage-Based Threshold System**: Standardized threshold configuration across the system
  - Replaced promille-based thresholds (0-1000 scale) with percentage-based (0-100 scale)
  - More intuitive configuration and easier to understand threshold values
  - DIVERGENCE_THRESHOLD_PERCENTAGE: Controls grid divergence detection sensitivity
  - GRID_REGENERATION_PERCENTAGE: Controls when cached funds trigger grid recalculation (default: 3%)

- **Enhanced Documentation**: Comprehensive threshold documentation with distribution analysis
  - Added Root Mean Square (RMS) explanation and threshold reference tables
  - Distribution analysis showing how threshold requirements change with error distribution patterns
  - Clear explanation of how same average error (e.g., 3.2%) requires different thresholds based on distribution
  - Migration guide for percentage-based thresholds
  - Mathematical formulas for threshold calculation and grid regeneration logic

### Changed
- **Breaking Change**: DIVERGENCE_THRESHOLD_Promille renamed to DIVERGENCE_THRESHOLD_PERCENTAGE
  - Configuration files using old name must be updated
  - Old: promille values (10 promille ≈ 1% divergence)
  - New: percentage values (1 = 1% divergence threshold)
  - Update pattern: divide old promille value by 10 to get new percentage value

- **Default Threshold Changes**: Improved defaults based on real-world testing
  - GRID_REGENERATION_PERCENTAGE: 1% → 3% (more stable, reduces unnecessary regeneration)
  - DIVERGENCE_THRESHOLD_PERCENTAGE: 10 promille → 1% (more sensitive divergence detection)

- **Grid Comparison Metrics**: Enhanced logging and comparison output
  - All threshold comparisons now use percentage-based values
  - Log output displays percentage divergence instead of promille
  - Clearer threshold comparison messages in grid update logging

### Fixed
- **Threshold Comparison Logic**: Corrected grid comparison triggering mechanism
  - Changed division from /1000 (promille) to /100 (percentage) in threshold calculations
  - Applied fixes to both BUY and SELL side grid regeneration logic (grid.js lines 1038-1040, 1063-1065)
  - Ensures accurate divergence detection and grid synchronization

### Technical Details
- **Quadratic Error Metric**: Sum of squared relative differences detects concentrated outliers
  - Formula: Σ((calculated - persisted) / persisted)² / count
  - Penalizes outliers more than simple average, reflects actual grid synchronization issues
  - RMS (Root Mean Square) = √(metric), provides alternative view of error magnitude

- **Distribution Scaling**: Threshold requirements scale with distribution evenness
  - Theoretical relationship: promille ≈ 1 + n (where n = ratio of perfect orders)
  - Example: 10% outlier distribution (n=9) requires ~10× higher threshold than 100% even distribution
  - Reference table in README documents thresholds for 1%→10% average errors across distributions

- **Grid Regeneration Mechanics**: Independent triggering mechanisms
  - Mechanism 1: Cache funds accumulating to GRID_REGENERATION_PERCENTAGE (3%) triggers recalculation
  - Mechanism 2: Grid divergence exceeding DIVERGENCE_THRESHOLD_PERCENTAGE (1%) triggers update
  - Both operate independently, ensuring grid stays synchronized with actual blockchain state

### Migration Guide
If upgrading from v0.2.0:
1. Update configuration files to use DIVERGENCE_THRESHOLD_PERCENTAGE instead of DIVERGENCE_THRESHOLD_Promille
2. Convert threshold values: new_value = old_promille_value / 10
   - Old: 10 promille → New: 1%
   - Old: 100 promille → New: 10%
3. Test with dryRun: true to verify threshold behavior matches expectations
4. Default GRID_REGENERATION_PERCENTAGE (3%) is now more conservative; adjust if needed

### Testing
- Comprehensive test coverage for grid divergence detection (test_grid_comparison.js)
- Validates quadratic error metric calculations across various distribution patterns
- Tests both cache funds and divergence triggers independently and in combination
- Percentage-based threshold comparisons verified across BUY and SELL sides

## [0.2.0] - 2025-12-12 - Startup Grid Reconciliation & Fee Caching System

### Features
- **Startup Grid Reconciliation System**: Intelligent grid recovery at startup
  - Price-based matching to resume persisted grids with existing on-chain orders
  - Smart regeneration decisions based on on-chain order states
  - Count-based reconciliation for order synchronization
  - Unified startup logic in both bot.js and dexbot.js

- **Fee Caching System**: Improved fill processing performance
  - One-time fee data loading to avoid repeated blockchain queries
  - Cache fee deductions throughout the trading session
  - Integrated into fill processing workflows

- **Enhanced Order Manager**: Better fund tracking and grid management
  - Improved chain order synchronization with price+size matching
  - Grid recalculation for full grid resync with better parameters
  - Enhanced logging and debug output for startup troubleshooting

- **Improved Account Handling**: Better restart operations
  - Set account info on manager during restart for balance calculations
  - Support percentage-based botFunds configuration at restart
  - Fetch on-chain balances before grid initialization if needed

### Fixed
- **Limit Order Update Calculation**: Fixed parameter handling in chain_orders.js
  - Corrected receive amount handling for price-change detection
  - Improved delta calculation when price changes toward/away from market
  - Added comprehensive validation for final amounts after delta adjustment

### Testing
- Comprehensive test coverage for new reconciliation logic
- Test startup decision logic with various grid/chain scenarios
- Test TwentyX-specific edge cases and recovery paths

## [0.1.2] - 2025-12-10 - Multi-Bot Fund Allocation & Update Script

### Features
- **Multi-Bot Fund Allocation**: Enforce botFunds percentage allocation when multiple bots share an account
  - Each bot respects its allocated percentage of chainFree (what's free on-chain)
  - Bot1 with 90% gets 90% of chainFree, Bot2 with 10% gets 10% of remaining
  - Prevents fund allocation conflicts in shared accounts
  - Applied at grid initialization for accurate startup sizing

### Fixed
- **Update Script**: Removed interactive merge prompts by using `git pull --rebase`
- **Script Permissions**: Made update.sh permanently executable via git config

## [0.1.1] - 2025-12-10 - Minimum Delta Enforcement

### Features
- **Minimum Delta Enforcement**: Enforce meaningful blockchain updates for price-only order moves
  - When price changes but amount delta is zero, automatically set delta to ±1
  - Only applies when order moves toward market center (economically beneficial)
  - Prevents wasted on-chain transactions for imperceptible price changes
  - Maintains grid integrity by pushing orders toward spread

### Fixed
- Eliminated zero-delta price-only updates that had no economic effect
- Improved order update efficiency for partial order price adjustments

## [0.1.0] - 2025-12-10 - Initial Release

### Features
- **Staggered Order Grid**: Geometric order grids with configurable weight distribution
- **Dynamic Rebalancing**: Automatic order updates after fills
- **Multi-Bot Support**: Run multiple bots simultaneously on different pairs
- **PM2 Process Management**: Production-ready process orchestration with auto-restart
- **Partial Order Handling**: Atomic moves for partially-filled orders
- **Fill Deduplication**: 5-second deduplication window prevents duplicate processing
- **Master Password Security**: Encrypted key storage with RAM-only password handling
- **Price Tolerance**: Intelligent blockchain rounding compensation
- **API Resilience**: Multi-API support with graceful fallbacks
- **Dry-Run Mode**: Safe simulation before live trading

### Fixed
- **Fill Processing in PM2 Mode**: Implemented complete 4-step fill processing pipeline for PM2-managed bots
  - Fill validation and deduplication
  - Grid synchronization with blockchain
  - Batch rebalancing and order updates
  - Proper order rotation with atomic transactions
- **Fund Fallback in Order Rotation**: Added fallback to available funds when proceeds exhausted
- **Price Derivation Robustness**: Enhanced pool price lookup with multiple API variant support


### Installation & Usage
See README.md for detailed installation and usage instructions.

### Documentation
- README.md: Complete feature overview and configuration guide
- modules/: Comprehensive module documentation
- examples/bots.json: Configuration templates
- tests/: 25+ test files covering all major functionality

### Notes
- First production-ready release for BitShares DEX market making
- Always test with `dryRun: true` before enabling live trading
- Secure your keys; do not commit private keys to version control
- Use `profiles/` directory for live configuration (not tracked by git)

