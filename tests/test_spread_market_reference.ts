/**
 * Spread-correction market-reference & cold-book suite (SMR-1..6).
 *
 * Covers the robustness fixes for the "spread correction sells at/below the
 * market on a cold grid" incident (issue #31):
 *
 *  - SMR-1: cold book (no live order either side) => no correction at all,
 *           structural stall so the targeted chain sync arms.
 *  - SMR-2: planner never places a SELL at/below / BUY at/above the last real
 *           fill (bot-scoped reference restored across regeneration).
 *  - SMR-3: persistGridSnapshot round-trips the bot-scoped lastMarketFill row;
 *           clearGrid() PRESERVES it (must survive regeneration).
 *  - SMR-4: restoreLastMarketFill shape + TTL gates.
 *  - SMR-5: rejectCorruptedGridSnapshot keeps a pre-reject snapshot copy.
 *  - SMR-6: the LAST-FILL-GUARD bypass gate shares the market-reference
 *           predicate (live fill pivot OR restored market row both deny it).
 *
 * Synthetic geometry only (start ~670, 0.3% increments) — no real accounts,
 * pairs, or live identifiers.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { AccountOrders } = require('../modules/account_orders');
const { persistGridSnapshot, restoreLastMarketFill } = require('../modules/order/utils/system');
const { rejectCorruptedGridSnapshot } = require('../modules/dexbot_state_recovery');
const { isSpreadCorrectionBypassAllowed } = require('../modules/dexbot_cow_runtime');

const INCREMENT = 0.3;
const price = (idx: number): number => 670.368 * Math.pow(1 + INCREMENT / 100, idx);
const NOW = Date.now();

function makeManager() {
    return new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1052.06,
        botFunds: { buy: 20000, sell: 20000 },
        activeOrders: { buy: 20, sell: 20 },
        incrementPercent: INCREMENT,
        targetSpreadPercent: 1.5,
    });
}

async function buildGeometry(manager: any, liveBuy: [number, number], liveSell: [number, number]) {
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 },
    };
    manager.config.weightDistribution = { buy: 0.5, sell: 0.5 };
    manager.btsBalance = { free: 1e9, total: 1e9, locked: 0 };
    const inRange = (i: number, r: [number, number]) => i >= r[0] && i <= r[1];
    for (let i = 0; i <= 291; i++) {
        const type = i <= 150 ? ORDER_TYPES.BUY : (i >= 156 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        const live = inRange(i, liveBuy) || inRange(i, liveSell);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: price(i),
            type,
            state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: live ? 2 : 0,
            orderId: live ? `1.7.${500000 + i}` : '',
        });
    }
    manager.boundaryIdx = 150;
    manager._gapSlots = 5;
    await manager.setAccountTotals({ buy: 20000, sell: 20000, buyFree: 20000, sellFree: 20000 });
    await manager.recalculateFunds();
}

// --- SMR-1: cold book places nothing and reports a structural stall --------
async function testSmr1ColdBookSkipsCorrection() {
    console.log('Running test: cold book skips spread correction');
    const manager = makeManager();
    // No live order on EITHER side.
    await buildGeometry(manager, [0, -1], [0, -1]);

    let batchCalls = 0;
    const result = await manager.checkSpreadCondition({}, async () => { batchCalls++; return { executed: true }; });

    assert.strictEqual(result.ordersPlaced, 0, 'cold book must place nothing');
    assert.strictEqual(result.stall, 'no-candidates',
        `cold book must report a structural stall (arms the targeted sync), got ${JSON.stringify(result.stall)}`);
    assert.strictEqual(batchCalls, 0, 'no correction batch may be planned on a cold book');
    console.log('  ✓ cold book places nothing and reports no-candidates');
}

// --- SMR-2: planner must not place through the last real fill --------------
async function testSmr2NoPlacementThroughMarketRef() {
    console.log('Running test: correction never places through the last market fill');
    const manager = makeManager();
    // No live sells: the empty sell rail is the issue-#31 shape.
    await buildGeometry(manager, [131, 150], [0, -1]);

    // Last real fill was a SELL at price(159). Without the guard the sort
    // would pick the lowest sell slot (156) which is BELOW the market; the
    // strict at/below rule keeps 156-159 out and admits 160.
    manager._lastMarketFillPrice = price(159);
    manager._lastMarketFillType = ORDER_TYPES.SELL;
    manager._lastMarketFillAt = NOW;

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 5);
    const placed = correction.ordersToPlace.map((o: any) => o.id);

    assert(placed.length > 0, `expected a market-safe sell, got ${JSON.stringify(placed)}`);
    const ref = price(159);
    for (const id of placed) {
        const idx = Number(String(id).replace('slot-', ''));
        assert(
            price(idx) > ref,
            `${id} @ ${price(idx).toFixed(2)} must sit ABOVE the last fill ${ref.toFixed(2)}; ` +
            'a sell at/below the last traded price is the adverse fill this guard prevents'
        );
    }
    assert.strictEqual(placed[0], 'slot-160', `expected the lowest market-safe sell (slot-160), got ${placed[0]}`);
    console.log(`  ✓ filtered to market-safe sells above ${ref.toFixed(2)} (${JSON.stringify(placed)})`);

    // Fail-open: with no reference the historical behavior is unchanged.
    const cold = makeManager();
    await buildGeometry(cold, [131, 150], [0, -1]);
    const coldCorrection = await Grid.prepareSpreadCorrectionOrders(cold, ORDER_TYPES.SELL, 1);
    assert.deepStrictEqual(
        coldCorrection.ordersToPlace.map((o: any) => o.id), ['slot-156'],
        'no reference => fail-open, lowest sell slot still chosen'
    );
    console.log('  ✓ fail-open when no real fill is known');
}

// --- SMR-3: persistence round-trip; clearGrid preserves the row ------------
async function testSmr3MarketFillPersistence() {
    console.log('Running test: lastMarketFill persists and survives clearGrid');
    const accountOrders = new AccountOrders({ botKey: 'smr-market-fill-roundtrip' });

    // persistGridSnapshot reads manager._lastMarketFill* and passes it as the
    // 11th storeMasterGrid arg.
    const mgr: any = {
        orders: new Map(),
        funds: { btsFeesOwed: 0 },
        accountTotals: null,
        boundaryIdx: 5,
        assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
        config: null,
        _recentFillKeysSnapshot: null,
        _lastGridPricingContext: null,
        _gapEvacStreaks: undefined,
        _pendingFillCrawls: undefined,
        _lastMarketFillPrice: 123.45,
        _lastMarketFillType: 'sell',
        _lastMarketFillAt: NOW,
    };
    await persistGridSnapshot(mgr, accountOrders);
    assert.deepStrictEqual(
        accountOrders.loadLastMarketFill(),
        { price: 123.45, type: 'sell', fillsAt: NOW },
        'market fill rides the snapshot persist'
    );

    // Absent-value contract matches lastFillPivot: null clears, malformed
    // clears, undefined is a legacy no-op.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined, null);
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'explicit null clears the stored row');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 0, type: 'sell', fillsAt: NOW });
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'non-positive price clears');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 100, type: 'sideways', fillsAt: NOW });
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'invalid side clears');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 100, type: 'sell', fillsAt: Number.NaN });
    assert.strictEqual(accountOrders.loadLastMarketFill(), null, 'non-finite fillsAt clears');
    // Re-store a valid row, then confirm undefined is a no-op.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined,
        { price: 123.45, type: 'sell', fillsAt: NOW });
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, undefined, undefined);
    assert.deepStrictEqual(
        accountOrders.loadLastMarketFill(),
        { price: 123.45, type: 'sell', fillsAt: NOW },
        'undefined market-fill param is a no-op'
    );

    // clearGrid() destroys the grid generation but MUST keep the market row.
    await accountOrders.clearGrid();
    assert.deepStrictEqual(
        accountOrders.loadLastMarketFill(),
        { price: 123.45, type: 'sell', fillsAt: NOW },
        'clearGrid preserves the bot-scoped market-fill reference across regeneration'
    );
    console.log('  ✓ market-fill row round-trips, validates, and survives clearGrid');
}

// --- SMR-4: restoreLastMarketFill shape + TTL -------------------------------
async function testSmr4RestoreGates() {
    console.log('Running test: restoreLastMarketFill shape and TTL gates');
    const mk = (row: any) => {
        const m = makeManager();
        const restored = restoreLastMarketFill(m, row);
        return { m, restored };
    };

    assert.strictEqual(mk(null).restored, false, 'null row is a no-op');
    assert.strictEqual(mk({ price: 0, type: 'buy', fillsAt: NOW }).restored, false, 'invalid price refused');
    assert.strictEqual(mk({ price: 10, type: 'spread', fillsAt: NOW }).restored, false, 'invalid side refused');

    const fresh = mk({ price: 42.5, type: 'buy', fillsAt: NOW });
    assert.strictEqual(fresh.restored, true, 'fresh row restored');
    assert.strictEqual(fresh.m._lastMarketFillPrice, 42.5, 'price written');
    assert.strictEqual(fresh.m._lastMarketFillType, 'buy', 'type written');

    const expired = mk({ price: 42.5, type: 'buy', fillsAt: NOW - 48 * 60 * 60 * 1000 });
    assert.strictEqual(expired.restored, false, 'row past the 24h TTL refused');
    assert.strictEqual(expired.m._lastMarketFillPrice, null, 'expired row does not arm');
    console.log('  ✓ shape + TTL gates enforced');
}

// --- SMR-6: the LAST-FILL-GUARD bypass gate --------------------------------
// The gate resolves through resolveSpreadMarketReference, the SAME predicate
// the planner's crossing filter uses. So: any real market reference (live
// fill pivot OR persisted market row) denies the bypass; only a cold/book
// reference with a fresh snapshot keeps the historical fail-open bypass.
async function testSmr6BypassGate() {
    console.log('Running test: spread-correction bypass gate');
    const gate = (manager: any) => isSpreadCorrectionBypassAllowed({ manager });

    assert.strictEqual(
        gate({
            lastFillPivotSource: 'fill',
            _lastFilledPrice: 100, _lastFilledType: ORDER_TYPES.BUY,
            _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now(),
        }),
        false,
        'a live real-fill pivot must never bypass the guard'
    );
    assert.strictEqual(
        gate({
            lastFillPivotSource: null,
            _lastMarketFillPrice: 100, _lastMarketFillType: ORDER_TYPES.SELL,
            _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now(),
        }),
        false,
        'a restored (bot-scoped) market reference must deny the bypass too — same predicate as the planner'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: null, _lastUnmatchedChainOrders: [], _lastSyncAt: 0 }),
        true,
        'cold reference with unknown sync time fails open (historical behavior)'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: null, _lastUnmatchedChainOrders: [{}], _lastSyncAt: Date.now() }),
        false,
        'known-unmatched chain orders make the snapshot untrustworthy -> no bypass'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: 'book', _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now() - 60 * 60 * 1000 }),
        false,
        'stale sync age withholds the bypass'
    );
    assert.strictEqual(
        gate({ lastFillPivotSource: 'book', _lastUnmatchedChainOrders: [], _lastSyncAt: Date.now() }),
        true,
        'fresh snapshot with a book pivot keeps the bypass'
    );
    console.log('  \u2713 bypass withheld for any real market reference / stale snapshots, kept for fresh heuristics');
}

// --- SMR-5: reject backstop keeps a pre-reject snapshot copy ----------------
async function testSmr5RejectBackupCopy() {
    console.log('Running test: rejectCorruptedGridSnapshot backs up before clear');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smr-reject-'));
    const botKey = 'smr-reject-backup';
    try {
        const accountOrders = new AccountOrders({ botKey, ordersDir: tmpDir });
        await accountOrders.storeMasterGrid(
            [{ id: 'slot-0', type: 'buy', state: 'virtual', price: 100, size: 1, orderId: null }],
            0, 0, null, null, null, null
        );

        const warnings: string[] = [];
        const bot: any = {
            accountOrders,
            _warn: (msg: string) => { warnings.push(String(msg)); },
            manager: {
                checkFundDriftAfterFills: () => ({ isValid: false, driftSell: 1, driftBuy: 0 }),
                _restoreBoundary: () => {},
                boundaryIdx: 0,
                _clearPendingFillCrawls: () => {},
                _resetLastFillPivot: () => {},
            },
        };

        const rejected = await rejectCorruptedGridSnapshot(bot, 'startup');
        assert.strictEqual(rejected, true, 'drift must trigger rejection');

        const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.rejected-drift-'));
        assert.strictEqual(backups.length, 1, `expected exactly one backup copy, got ${JSON.stringify(backups)}`);
        const backupData = JSON.parse(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'));
        assert.strictEqual(backupData.grid?.[0]?.id, 'slot-0', 'backup holds the pre-reject grid');
        assert(
            warnings.some((w) => w.includes('Kept pre-reject snapshot copy')),
            `expected a backup log line, got ${JSON.stringify(warnings)}`
        );
        console.log('  ✓ pre-reject snapshot copy written');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

(async () => {
    await testSmr1ColdBookSkipsCorrection();
    await testSmr2NoPlacementThroughMarketRef();
    await testSmr3MarketFillPersistence();
    await testSmr4RestoreGates();
    await testSmr6BypassGate();
    await testSmr5RejectBackupCopy();
    console.log('PASS test_spread_market_reference');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
