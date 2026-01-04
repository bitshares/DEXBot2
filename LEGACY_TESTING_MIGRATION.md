# Legacy Testing Functions Migration

## Overview
All legacy testing functions that were previously deprecated in the manager and strategy modules have been extracted into a dedicated `modules/legacy-testing.js` module.

## Changes Made

### 1. Created `modules/legacy-testing.js`
A new module containing all deprecated test-only functions:
- `rebalanceOrders(manager, filledCounts, extraTarget, excludeOrderIds)` - Legacy rebalancing using fill counts
- `rebalanceSideAfterFill(manager, filledType, oppositeType, filledCount, extraTarget, excludeOrderIds)` - Single-side rebalancing
- `activateClosestVirtualOrdersForPlacement(manager, targetType, count, excludeOrderIds)` - Virtual order activation
- `prepareFurthestOrdersForRotation(manager, targetType, count, excludeOrderIds, filledCount, options)` - Order rotation preparation
- `evaluatePartialOrderAnchor(manager, partialOrder, moveInfo)` - Partial order dust classification
- `activateSpreadOrders(manager, targetType, count)` - Spread order activation

### 2. Updated `modules/order/manager.js`
Removed all deprecated method delegations:
- ~~`rebalanceOrders()`~~
- ~~`_rebalanceSideAfterFill()`~~
- ~~`activateClosestVirtualOrdersForPlacement()`~~
- ~~`prepareFurthestOrdersForRotation()`~~
- ~~`_evaluatePartialOrderAnchor()`~~
- ~~`activateSpreadOrders()`~~

Retained active production methods:
- `processFilledOrders()` - New preferred method
- `completeOrderRotation()`
- `preparePartialOrderMove()`
- `completePartialOrderMove()`

### 3. Updated `modules/order/strategy.js`
Removed deprecated method implementations:
- ~~`async rebalanceOrders()`~~
- ~~`async rebalanceSideAfterFill()`~~
- ~~`async activateClosestVirtualOrdersForPlacement()`~~
- ~~`async prepareFurthestOrdersForRotation()`~~
- ~~`async activateSpreadOrders()`~~

Retained the core strategic methods needed for production use.

### 4. Updated Test Files
All test files that use legacy functions now import from `legacy-testing`:

- `tests/test_rebalance_orders.js` - Uses `rebalanceOrders()`
- `tests/test_manager.js` - Uses `activateClosestVirtualOrdersForPlacement()`, `prepareFurthestOrdersForRotation()`, `activateSpreadOrders()`
- `tests/test_anchor_refill_strategy.js` - Uses `evaluatePartialOrderAnchor()`
- `tests/test_anchor_refill_integration.js` - Uses `evaluatePartialOrderAnchor()`
- `tests/test_engine_integration.js` - Uses `rebalanceSideAfterFill()`
- `tests/test_critical_bug_fixes.js` - Uses `rebalanceSideAfterFill()`, `prepareFurthestOrdersForRotation()`
- `tests/test_multi_partial_consolidation.js` - Uses `rebalanceSideAfterFill()`
- `tests/test_multi_partial_edge_cases.js` - Uses `rebalanceSideAfterFill()`
- `tests/test_rotation_cachefunds.js` - Uses `prepareFurthestOrdersForRotation()`

## Migration Pattern

### Before (Direct Manager Call)
```javascript
const result = await mgr.rebalanceOrders({ [ORDER_TYPES.SELL]: 1 }, 0);
const rotations = await mgr.prepareFurthestOrdersForRotation(ORDER_TYPES.BUY, 4);
const decision = mgr._evaluatePartialOrderAnchor(partialOrder, moveInfo);
```

### After (Using Legacy Module)
```javascript
const { rebalanceOrders, prepareFurthestOrdersForRotation, evaluatePartialOrderAnchor } = require('../modules/order/legacy-testing');

const result = await rebalanceOrders(mgr, { [ORDER_TYPES.SELL]: 1 }, 0);
const rotations = await prepareFurthestOrdersForRotation(mgr, ORDER_TYPES.BUY, 4);
const decision = evaluatePartialOrderAnchor(mgr, partialOrder, moveInfo);
```

## Test Status

### Passing Tests
- ✅ test_rebalance_orders.js (5/5 tests)
- ✅ test_manager.js (all tests)
- ✅ test_anchor_refill_strategy.js (all tests)
- ✅ test_anchor_refill_integration.js (all tests)
- ✅ test_multi_partial_consolidation.js (all tests)
- ✅ test_multi_partial_edge_cases.js (all tests)

### Pre-Existing Failures (Not Related to Migration)
- test_rotation_cachefunds.js - Tests advanced cacheFunds behavior, was already failing
- test_engine_integration.js - Requires fee cache initialization, pre-existing failure
- test_critical_bug_fixes.js - Tests spread selection logic, pre-existing failure

## Benefits

1. **Cleaner Code Structure**: Legacy test functions are now isolated in their own module
2. **Clear Intent**: Production code is now free of deprecated test-only functions
3. **Easier Maintenance**: Changes to legacy behavior only affect the legacy module
4. **Better Testing**: Test files clearly show they're using legacy functionality
5. **Future-Proof**: New strategies can be tested without carrying old method baggage

## Backward Compatibility

All legacy functions maintain their exact original behavior and signatures, ensuring that existing tests continue to work without modification (other than import statements).
