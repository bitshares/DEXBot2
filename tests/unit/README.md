# DEXBot2 Unit Tests

Comprehensive unit tests for critical order management, accounting, and blockchain synchronization logic.

## Overview

These tests validate the core financial logic and state management of DEXBot2, ensuring fund tracking integrity, order state consistency, and blockchain reconciliation correctness.

## Running Tests

Install Jest first:
```bash
npm install --save-dev jest
```

### Run all unit tests
```bash
npm run test:unit
```

### Run specific test file
```bash
npm run test:unit -- tests/unit/accounting.test.js
npm run test:unit -- tests/unit/manager.test.js
npm run test:unit -- tests/unit/grid.test.js
npm run test:unit -- tests/unit/sync_engine.test.js
```

### Run in watch mode (re-run on file changes)
```bash
npm run test:unit:watch
```

### Generate coverage report
```bash
npm run test:unit:coverage
```

## Test Files

### `accounting.test.js` - Fund Tracking
**Validates:** Fund initialization, recalculation, invariant checks, and fund consistency.

**Critical Tests:**
- `recalculateFunds()` correctly sums VIRTUAL and ACTIVE orders
- Fund invariants detect leaks and inconsistencies
- Available funds don't exceed chain balance
- Edge cases (null totals, large values, zero-size orders)

**Run alone:**
```bash
npm run test:unit -- tests/unit/accounting.test.js
```

### `manager.test.js` - Order State Machine & Indexing
**Validates:** Order state transitions, index consistency, locking, and lookup.

**Critical Tests:**
- Index synchronization (orders Map ↔ _ordersByState, _ordersByType)
- Valid/invalid state transitions
- Index corruption detection and repair
- Order locking and expiry
- Fund recalc pausing with nesting support

**Run alone:**
```bash
npm run test:unit -- tests/unit/manager.test.js
```

### `grid.test.js` - Order Grid Generation
**Validates:** Grid structure, order sizing, price levels, and geometric progression.

**Critical Tests:**
- Grid has correct buy/sell/spread orders
- Orders follow geometric progression with incrementPercent
- Buys are below market, sells are above market
- Respects min/max price bounds
- Weight distribution affects order sizing

**Run alone:**
```bash
npm run test:unit -- tests/unit/grid.test.js
```

### `sync_engine.test.js` - Blockchain Reconciliation
**Validates:** Fill detection, state synchronization, and chain-grid consistency.

**Critical Tests:**
- Input validation handles null/malformed data
- Lock handling prevents concurrent syncs
- Partial fills are detected and processed
- Price tolerance for matching
- Index consistency after sync
- Precision mismatches handled correctly

**Run alone:**
```bash
npm run test:unit -- tests/unit/sync_engine.test.js
```

## Test Coverage Goals

| Module | Coverage Target | Purpose |
|--------|-----------------|---------|
| `accounting.js` | 80%+ | Fund integrity is critical |
| `manager.js` | 75%+ | State machine complexity |
| `grid.js` | 70%+ | Complex math algorithms |
| `sync_engine.js` | 70%+ | Race condition prevention |

## Key Testing Patterns

### 1. Fund Tracking Tests
```javascript
// Create order and verify funds updated correctly
manager._updateOrder(order);
expect(manager.funds.virtual.buy).toBe(expectedValue);
```

### 2. State Transition Tests
```javascript
// Test valid transition
manager._updateOrder(virtualOrder);
expect(() => {
    manager._updateOrder(activeVersion);
}).not.toThrow();

// Test invalid transition
expect(() => {
    manager._updateOrder(invalidVersion);
}).toThrow(); // OR logs error
```

### 3. Index Consistency Tests
```javascript
// Add orders and verify indices
manager._updateOrder(order);
expect(manager._ordersByState[state]).toContain(order.id);
expect(manager._ordersByType[type]).toContain(order.id);

// Validate all indices
expect(manager.validateIndices()).toBe(true);
```

### 4. Async/Lock Tests
```javascript
// Test lock acquisition
expect(manager.isOrderLocked(id)).toBe(false);
manager.lockOrders([id]);
expect(manager.isOrderLocked(id)).toBe(true);
```

## Debugging Failed Tests

### Fund Recalc Issues
Check if `pauseFundRecalc()` is being used correctly. Fund recalc should be paused during batch updates:
```javascript
manager.pauseFundRecalc();
// batch updates
manager._updateOrder(order1);
manager._updateOrder(order2);
manager.resumeFundRecalc(); // Recalc happens once here
```

### Index Corruption
If you see "Index mismatch" errors, call the repair function:
```javascript
manager.assertIndexConsistency(); // Validates and repairs
```

### State Transition Errors
Check the `validTransitions` map in `manager.js` line 376. Valid flows:
```
VIRTUAL → ACTIVE or PARTIAL
ACTIVE  → PARTIAL or VIRTUAL
PARTIAL → ACTIVE or VIRTUAL
```

## Adding New Tests

Follow the existing patterns:

1. **Setup**: Create manager instance with test config
2. **Arrange**: Create test data (orders, prices, etc.)
3. **Act**: Call the function being tested
4. **Assert**: Verify results with `expect()`

Example:
```javascript
it('should validate new behavior', () => {
    // Setup
    const order = { id: 'test', state: 'VIRTUAL', type: 'BUY', size: 100 };

    // Act
    manager._updateOrder(order);

    // Assert
    expect(manager.orders.has('test')).toBe(true);
    expect(manager.validateIndices()).toBe(true);
});
```

## CI/CD Integration

Add to your CI pipeline:
```bash
npm run test:unit:coverage

# Fail if coverage below threshold
if coverage < 60%; then
  exit 1
fi
```

See `jest.config.js` for coverage thresholds.

## Known Limitations

1. **AsyncLock behavior**: Tests mock timing; real timing may differ in production
2. **Blockchain precision**: Tests use mock asset precision; real values may differ
3. **External API calls**: Tests don't make actual blockchain calls (mocked)

## Contributing

When adding new tests:
- Keep tests focused and small (one concept per test)
- Use descriptive names: `it('should [behavior] when [condition]')`
- Document why a test exists if not obvious
- Update this README if adding new test files
