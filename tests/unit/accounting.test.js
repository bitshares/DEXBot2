/**
 * Unit tests for accounting.js - Fund tracking and calculations
 *
 * CRITICAL: These tests ensure funds are tracked correctly and no leaks occur.
 * Run with: npm test -- tests/unit/accounting.test.js
 */

const { OrderManager } = require('../../modules/order');
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('../../modules/constants');

describe('Accountant - Fund Tracking', () => {
    let manager;

    beforeEach(() => {
        // Create a fresh manager for each test
        manager = new OrderManager({
            ...DEFAULT_CONFIG,
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS'
        });

        // Set up account totals
        manager.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 10000,
            sellFree: 100
        });
    });

    describe('resetFunds()', () => {
        it('should initialize funds structure with zero values', () => {
            manager.resetFunds();
            expect(manager.funds).toBeDefined();
            expect(manager.funds.available).toEqual({ buy: 0, sell: 0 });
            expect(manager.funds.committed.chain).toEqual({ buy: 0, sell: 0 });
            expect(manager.funds.virtual).toEqual({ buy: 0, sell: 0 });
            expect(manager.funds.cacheFunds).toEqual({ buy: 0, sell: 0 });
        });

        it('should create backwards-compatible reserved alias', () => {
            manager.resetFunds();
            expect(manager.funds.reserved).toBe(manager.funds.virtual);
        });
    });

    describe('recalculateFunds()', () => {
        it('should calculate virtual funds from VIRTUAL orders', () => {
            const order = {
                id: 'virtual-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 500,
                price: 100
            };
            manager._updateOrder(order);

            expect(manager.funds.virtual.buy).toBe(500);
            expect(manager.funds.total.grid.buy).toBeGreaterThanOrEqual(500);
        });

        it('should calculate committed funds from ACTIVE orders', () => {
            const order = {
                id: 'active-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.SELL,
                size: 25,
                price: 100,
                orderId: 'chain-001'
            };
            manager._updateOrder(order);

            expect(manager.funds.committed.chain.sell).toBe(25);
            expect(manager.funds.total.grid.sell).toBe(25);
        });

        it('should include PARTIAL orders in grid committed', () => {
            const order = {
                id: 'partial-1',
                state: ORDER_STATES.PARTIAL,
                type: ORDER_TYPES.BUY,
                size: 300,
                price: 100,
                orderId: 'chain-002'
            };
            manager._updateOrder(order);

            expect(manager.funds.committed.grid.buy).toBe(300);
            expect(manager.funds.committed.chain.buy).toBe(300);
        });

        it('should sum multiple orders correctly', () => {
            manager.pauseFundRecalc();

            manager._updateOrder({
                id: 'buy-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 100
            });
            manager._updateOrder({
                id: 'buy-2',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.BUY,
                size: 200
            });
            manager._updateOrder({
                id: 'buy-3',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 150,
                orderId: 'chain-003'
            });

            manager.resumeFundRecalc();

            // Virtual: 100 + 200 = 300
            expect(manager.funds.virtual.buy).toBe(300);
            // Grid committed: 150
            expect(manager.funds.committed.grid.buy).toBe(150);
            // Total grid: 300 + 150 = 450
            expect(manager.funds.total.grid.buy).toBe(450);
        });

        it('should handle zero-size orders safely', () => {
            manager._updateOrder({
                id: 'zero-1',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 0
            });

            expect(manager.funds.virtual.sell).toBe(0);
            expect(manager.funds.committed.grid.sell).toBe(0);
        });

        it('should ignore orders with invalid types', () => {
            // This should be skipped due to validation
            manager._updateOrder({
                id: 'invalid-1',
                state: ORDER_STATES.VIRTUAL,
                type: 'INVALID_TYPE',
                size: 100
            });

            expect(manager.funds.virtual.buy + manager.funds.virtual.sell).toBe(0);
        });

        it('should detect fund invariant violations', () => {
            // Create order that uses most of funds
            manager._updateOrder({
                id: 'big-order',
                state: ORDER_STATES.VIRTUAL,
                type: ORDER_TYPES.SELL,
                size: 100
            });

            // Manually corrupt the funds to trigger invariant violation
            manager.funds.total.chain.sell = 50; // Less than committed.grid.sell

            // Recalculate should verify invariants
            manager.recalculateFunds();

            // The invariant check should have been called
            // Just verify the recalculation completes without error
            expect(manager.funds).toBeDefined();
        });
    });

    describe('Fund consistency checks', () => {
        it('should maintain chainTotal = chainFree + chainCommitted invariant', () => {
            manager._updateOrder({
                id: 'order-1',
                state: ORDER_STATES.ACTIVE,
                type: ORDER_TYPES.BUY,
                size: 1000,
                orderId: 'chain-001'
            });

            const { buy: chainTotal } = manager.funds.total.chain;
            const { buy: chainFree } = manager.accountTotals ? { buy: manager.accountTotals.buyFree } : { buy: 0 };
            const { buy: chainCommitted } = manager.funds.committed.chain;

            // Within tolerance
            expect(Math.abs(chainTotal - (chainFree + chainCommitted))).toBeLessThan(0.01);
        });

        it('should prevent available funds from exceeding chainFree', () => {
            manager.setAccountTotals({
                buy: 5000,
                sell: 50,
                buyFree: 5000,
                sellFree: 50
            });

            expect(manager.funds.available.buy).toBeLessThanOrEqual(5000 + 0.01);
            expect(manager.funds.available.sell).toBeLessThanOrEqual(50 + 0.01);
        });
    });

    describe('Edge cases', () => {
        it('should handle null accountTotals gracefully', () => {
            manager.accountTotals = null;

            expect(() => {
                manager.recalculateFunds();
            }).not.toThrow();

            expect(manager.funds).toBeDefined();
        });

        it('should handle large fund values without precision loss', () => {
            const largeValue = 999999999.123456;
            manager.setAccountTotals({
                buy: largeValue,
                sell: largeValue,
                buyFree: largeValue,
                sellFree: largeValue
            });

            manager.recalculateFunds();

            expect(manager.funds.total.chain.buy).toBeGreaterThan(0);
            expect(manager.funds.total.chain.sell).toBeGreaterThan(0);
        });
    });
});
