/**
 * tests/test_spread_pure_fund_driven.ts
 *
 * Pure fund-driven spread correction.
 *
 * Corrections are funded exclusively by free available/chainFree. No resting
 * order is ever shrunk to manufacture budget — the self-funded tail-recycling
 * and the generic redistribution donor loops were removed because they moved
 * inventory within a rail and were gamed by stale-size snapshots. When free
 * funds are zero, determineOrderSideByFunds returns null and the caller
 * refreshes account totals + open orders (`getTargetedSyncReason`) instead.
 *
 * PF-010: zero free funds (committed inventory present) -> side null.
 * PF-020: zero free funds -> no create AND no resting-order shrink.
 * PF-030: partial free funds -> placement stays within the free budget and
 *         every update is a top-up, never a shrink.
 * PF-040: free funds on one side still selects that side.
 */
const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function makeMgr() {
    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 910, sell: 100 },
        coreOrders: { buy: 2, sell: 1 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    // Non-BTS pair: a zero BTS balance would make the fee reservation swallow
    // the free balance, hiding what this test asserts. Fund BTS so the
    // available-buy calculation reflects the pair's free funds.
    mgr.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
    return mgr;
}

// Over-allocated buy donor + edge partial + a missing spread slot. The donor is
// exactly what the old redistribution path would have shrunk to fund the gap.
async function seedBuyRail(mgr, donorSize = 900) {
    await mgr._updateOrder({
        id: 'buy-donor', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE,
        price: 0.80, size: donorSize, orderId: '1.7.101'
    });
    await mgr._updateOrder({
        id: 'buy-edge', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL,
        price: 0.90, size: 10, orderId: '1.7.102'
    });
    await mgr._updateOrder({
        id: 'spread-1', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL,
        price: 0.95, size: 0
    });
    // Two buy slots below the spread slot -> boundary sits at index 2 so
    // spread-1 (price-sorted idx=2) computes as BUY under the type filter.
    mgr.boundaryIdx = 2;
}

function beforeSize(mgr, id) {
    return Number(mgr.orders.get(id)?.size || 0);
}

async function run() {
    console.log('Running pure fund-driven spread correction tests...');

    // ---- PF-010 + PF-020: zero free funds -> no side, no create, no shrink ----
    {
        const mgr = makeMgr();
        await seedBuyRail(mgr);
        await mgr.setAccountTotals({ buy: 910, sell: 0, buyFree: 0, sellFree: 0 });
        await mgr.recalculateFunds();
        assert.strictEqual(mgr.funds.available.buy, 0, 'precondition: buy free funds must be zero');

        const decision = Grid.determineOrderSideByFunds(mgr, 1);
        assert.strictEqual(decision.side, null,
            'PF-010: zero free funds must select no side (committed inventory is not recycled)');

        const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY, 1);
        assert.strictEqual(correction.ordersToPlace.length, 0, 'PF-020: no free funds -> no create');
        const donorShrinks = correction.ordersToUpdate.filter((u) =>
            Number(u.newSize) < beforeSize(mgr, u.partialOrder.id));
        assert.strictEqual(donorShrinks.length, 0, 'PF-020: no resting order may be shrunk');
        console.log('  - PF-010/PF-020 zero free funds: no side, no create, no shrink');
    }

    // ---- PF-030: partial free funds -> funded placement, top-up only ----
    {
        const mgr = makeMgr();
        await seedBuyRail(mgr);
        // total 1410 - committed 910 = 500 free (consistent), so a funded
        // placement is actually possible and the budget bound is exercised.
        await mgr.setAccountTotals({ buy: 1410, sell: 0, buyFree: 500, sellFree: 0 });
        await mgr.recalculateFunds();
        const free = Number(mgr.funds.available.buy);
        assert(free > 0, 'precondition: some free buy funds');

        const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY, 1);
        const donorShrinks = correction.ordersToUpdate.filter((u) =>
            Number(u.newSize) < beforeSize(mgr, u.partialOrder.id));
        assert.strictEqual(donorShrinks.length, 0, 'PF-030: no resting order may be shrunk');

        const spent = correction.ordersToPlace.reduce((s, o) => s + Number(o.size || 0), 0)
            + correction.ordersToUpdate.reduce((s, u) =>
                s + Math.max(0, Number(u.newSize) - beforeSize(mgr, u.partialOrder.id)), 0);
        assert(spent <= free + 1e-6, `PF-030: spend ${spent} must not exceed free ${free}`);
        console.log(`  - PF-030 funded within free budget (spent ${spent.toFixed(5)} <= free ${free.toFixed(5)}), no shrink`);
    }

    // ---- PF-040: funded side selection unchanged ----
    {
        const mgr = makeMgr();
        await seedBuyRail(mgr);
        await mgr.setAccountTotals({ buy: 960, sell: 0, buyFree: 50, sellFree: 0 });
        await mgr.recalculateFunds();
        assert.strictEqual(Grid.determineOrderSideByFunds(mgr, 1).side, ORDER_TYPES.BUY,
            'PF-040: funded buy side must still be selected');
        console.log('  - PF-040 funded side selection unchanged');
    }

    console.log('PASS test_spread_pure_fund_driven');
}

run().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});
