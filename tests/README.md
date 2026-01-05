# DEXBot2 Test Suite

This directory contains the test suite for DEXBot2, covering unit tests, integration tests, strategy logic verification, and infrastructure checks.

## Unit Tests

Unit tests are located in the `unit/` directory. They focus on testing individual modules in isolation.
See [unit/README.md](unit/README.md) for more details.

## Integration & Functional Tests

The tests in this directory are generally run using Node.js directly.
Example: `node tests/test_market_price.js`

### 1. Core Infrastructure & Connection
Tests ensuring the bot can connect to the blockchain and manage local state.

*   `connection_test.js` - Interactive test to verify connectivity to BitShares nodes.
*   `test_indexdb.js` - Verifies IndexedDB functionality for local data storage.
*   `test_subscriptions.js` - Tests market subscription handling and data updates.
*   `test_logger.js` - Verifies the logging system.

### 2. Account & Authentication
Tests for account handling, key validation, and balance calculations.

*   `test_key_validation.js` - Unit tests for private/public key format validation.
*   `test_privatekey_sanitize.js` - Checks sanitization logic for pasted private keys.
*   `test_account_selection.js` - Interactive tool to test account selection logic.
*   `test_account_totals.js` - Verifies account balance calculation and asset totals.

### 3. Market Data & Pricing
Tests for fetching prices, order books, and deriving trading prices.

*   `test_market_price.js` - Comprehensive test of market price fetching (Pool vs Orderbook).
*   `test_price_derive.js` - Tests logic for deriving prices from market data.
*   `test_price_orientation.js` - Verifies price orientation (buy/sell side) logic.
*   `test_price_no_positional.js` - Tests price handling when no positional data is available.
*   `test_price_tolerance.js` - Checks price tolerance boundaries.
*   `test_debug_orderbook.js` - Diagnostic tool for inspecting the order book.
*   `test_any_pair.js` - Discovers and tests active trading pairs.
*   `test_autoderive.js` - Tests automatic derivation of strategy parameters.

### 4. Order Management & Execution
Tests for order lifecycle: placement, open order tracking, and fill processing.

*   `test_open_orders.js` - Tests retrieval and management of open orders.
*   `test_fills.js` - interactive test for processing order fills.
*   `test_fill_queue_logic.js` - Verifies the logic for the fill processing queue.
*   `test_trade_history.js` - Tests retrieval of account trade history.
*   `test_blockchain_fill_history.js` - Verifies fill history against blockchain data.

### 5. Strategy & Grid Logic
Tests for the core trading strategies, specifically the grid logic.

*   `test_order_grid.js` - Core grid order generation and logic.
*   `test_grid_comparison.js` - Compares different grid strategy configurations.
*   `test_grid_funding_manual.js` - Tests manual funding scenarios for grids.
*   `test_rebalance_orders.js` - Tests logic for rebalancing orders within a grid.
*   `test_rotation_order_sizing.js` - Verifies order sizing logic for rotation strategies.
*   `test_rotation_cachefunds.js` - Tests fund caching in rotation strategies.
*   `test_conditional_rotation.js` - Tests conditional rotation logic.
*   `test_crossed_rotation.js` - Tests scenarios where rotation orders might cross.
*   `test_strategy_edge_cases.js` - Tests various edge cases in strategy execution.
*   `test_templates_ordering.js` - Verifies correct ordering of order templates.

### 6. Fees & Accounting
Tests for fee calculations, fund management, and asset precision.

*   `test_funds.js` - specific tests for fund management logic.
*   `test_fee_cache.js` - Tests the fee caching mechanism.
*   `test_fee_cache_twentix.js` - Fee caching tests specific to complex assets (e.g. Twentix).
*   `test_fee_refinement.js` - Tests refinement of fee calculations.
*   `test_market_fee_deduction.js` - Verifies deduction of market fees from orders.
*   `test_fix_proceeds_fee_deduction.js` - Verification for proceeds fee deduction logic.

### 7. Integration & Workflows
Complex tests that simulate larger workflows or system integration.

*   `test_engine_integration.js` - Integration tests for the core engine.
*   `test_anchor_refill_integration.js` - Integration tests for the anchor refill mechanism.
*   `test_anchor_refill_endtoend.js` - End-to-end tests for anchor refill.
*   `test_anchor_refill_strategy.js` - Strategy logic tests for anchor refill.
*   `test_integration_partial_complex.js` - Tests complex partial fill integration.
*   `test_integration_pending_proceeds.js` - Integration tests for pending proceeds handling.
*   `test_startup_reconcile.js` - Tests the reconciliation process at bot startup.
*   `test_startup_decision.js` - Verifies startup decision-making logic.
*   `test_startup_partial_fill.js` - Tests handling of partial fills detected at startup.

### 8. Edge Cases & Bug Fixes
Tests created to reproduce or verify fixes for specific bugs and edge cases.

*   `test_critical_bug_fixes.js` - Regression tests for critical historical bugs.
*   `test_partial_order_edge_cases.js` - Edge cases for partial orders.
*   `test_multi_partial_edge_cases.js` - Edge cases for multiple partial fills.
*   `test_multi_partial_consolidation.js` - Tests consolidation of multiple partial fills.
*   `test_twentix_only.js` - specific asset lookup test (Twentix).

### 9. Utilities & Helpers
Tests for shared utility functions and helper modules.

*   `test_utils.js` - General utility function tests.
*   `test_chain_helpers.js` - Tests for blockchain interaction helpers.
*   `test_precision_integration.js` - Integration tests for precision handling.
*   `test_precision_quantization.js` - Tests logic for quantizing values to asset precision.
*   `test_fund_cycling_trigger.js` - Tests triggers for fund cycling.
*   `test_manager.js` - Tests for the OrderManager module.

---

**Note:** Interactive tests (like `connection_test.js`) may require network access and user input.