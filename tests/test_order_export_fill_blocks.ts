/**
 * tests/test_order_export_fill_blocks.ts
 *
 * Regression tests for issue #22: `dexbot export` found 0 trades because
 * parseFillLine/parseFeeLine only matched a legacy log format that no runtime
 * code emits. The exporter must parse the current multi-line FILL DETECTED
 * blocks (with and without pays/receives asset IDs) and derive
 * side/price/amount from precision-scaled amounts.
 *
 * Uses native assert to avoid Jest dependency (repo convention).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running order export fill-block tests');

const {
    parseFillLine,
    parseFeeLine,
    parseLogFile,
    deriveTradeFromFillBlock,
} = require('../modules/order/export');

// <bot> market fixtures (mirrors profiles/orders/<botKey>.json):
// assetA = HONEST.MONEY (1.3.6301, precision 8), assetB = BTS (1.3.0, precision 5).
const ASSET_CTX = {
    assetA: { id: '1.3.6301', precision: 8, symbol: 'HONEST.MONEY' },
    assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
    gridMedianPrice: 0.2,
};

// Real-world fill: paid 869.69888417 HONEST, received 277 BTS
// (SELL at ~0.3185 BTS per HONEST).
const PAYS_SELL = 86969888417;
const RECEIVES_SELL = 27700000;
const EXPECTED_AMOUNT = 869.69888417;
const EXPECTED_PRICE = 277.0 / 869.69888417;

function approxEqual(actual, expected, eps = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)),
        `expected ${actual} to approx ${expected}`
    );
}

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err: any) {
        failed++;
        console.error(`  FAIL: ${name}: ${err && err.message}`);
    }
}
async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
    } catch (err: any) {
        failed++;
        console.error(`  FAIL: ${name}: ${err && err.message}`);
    }
}

function writeTempLog(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-export-test-'));
    const file = path.join(dir, 'bot.log');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return { dir, file };
}

/** Write lines to a temp log, run fn(file), then clean up. */
async function withTempLog(lines, fn) {
    const { dir, file } = writeTempLog(lines);
    try {
        await fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function main() {
    check('legacy fill line still parses', () => {
        const t = parseFillLine('[2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS');
        assert.ok(t);
        assert.strictEqual(t.side, 'sell');
        assert.strictEqual(t.amount, 0.0316);
        assert.strictEqual(t.price, 1791.30065898866);
        assert.strictEqual(t.proceeds, 56.60510082);
    });

    check('legacy fill line captures optional order= suffix', () => {
        const t = parseFillLine('[2026-01-15T15:29:06.185Z] [DEBUG] [FILL] buy fill: size=1.5, price=2.0, proceeds=3.0 BTS order=1.7.42');
        assert.ok(t);
        assert.strictEqual(t.order_id, '1.7.42');
    });

    check('legacy fee line still parses', () => {
        const f = parseFeeLine('[2026-01-15T15:29:06.185Z] [INFO] [FEES] BTS fees calculated: 1 maker fills @ 0.04826000 BTS = 0.04826000 BTS');
        assert.ok(f);
        assert.strictEqual(f.fee_asset, 'BTS');
    });

    check('deriveTradeFromFillBlock: new-style SELL block is exact', () => {
        const t = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            orderId: '1.7.569578780',
            paysRaw: PAYS_SELL,
            paysAssetId: '1.3.6301',
            receivesRaw: RECEIVES_SELL,
            receivesAssetId: '1.3.0',
            blockNum: 113545907,
            historyId: '1.11.1394621506',
        }, ASSET_CTX);
        assert.ok(t);
        assert.strictEqual(t.side, 'sell');
        approxEqual(t.amount, EXPECTED_AMOUNT);
        approxEqual(t.price, EXPECTED_PRICE);
        assert.strictEqual(t.order_id, '1.7.569578780');
    });

    check('deriveTradeFromFillBlock: new-style BUY block is exact', () => {
        const t = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            orderId: '1.7.999',
            paysRaw: RECEIVES_SELL,
            paysAssetId: '1.3.0',
            receivesRaw: PAYS_SELL,
            receivesAssetId: '1.3.6301',
        }, ASSET_CTX);
        assert.ok(t);
        assert.strictEqual(t.side, 'buy');
        approxEqual(t.amount, EXPECTED_AMOUNT);
        approxEqual(t.price, EXPECTED_PRICE);
        // Proceeds are always quote-asset (BTS): BTS cost on BUY, BTS received on SELL.
        approxEqual(t.proceeds, RECEIVES_SELL / 1e5);
    });

    check('deriveTradeFromFillBlock: SELL proceeds are BTS received', () => {
        const t = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            paysRaw: PAYS_SELL,
            paysAssetId: '1.3.6301',
            receivesRaw: RECEIVES_SELL,
            receivesAssetId: '1.3.0',
        }, ASSET_CTX);
        assert.ok(t);
        approxEqual(t.proceeds, RECEIVES_SELL / 1e5);
    });

    check('deriveTradeFromFillBlock: half-present pays side still orients', () => {
        const sell = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            paysRaw: PAYS_SELL,
            paysAssetId: '1.3.6301',
            receivesRaw: RECEIVES_SELL,
        }, ASSET_CTX);
        assert.ok(sell);
        assert.strictEqual(sell.side, 'sell');
        const buy = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            paysRaw: RECEIVES_SELL,
            receivesRaw: PAYS_SELL,
            receivesAssetId: '1.3.6301',
        }, ASSET_CTX);
        assert.ok(buy);
        assert.strictEqual(buy.side, 'buy');
        approxEqual(buy.proceeds, RECEIVES_SELL / 1e5);
    });

    check('deriveTradeFromFillBlock: half-present foreign side is skipped', () => {
        const t = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            paysRaw: 100,
            paysAssetId: '1.3.9999',
            receivesRaw: 200,
        }, ASSET_CTX);
        assert.strictEqual(t, null);
    });

    check('deriveTradeFromFillBlock: bare block uses grid median', () => {
        const t = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            orderId: '1.7.569578780',
            paysRaw: PAYS_SELL,
            receivesRaw: RECEIVES_SELL,
        }, ASSET_CTX);
        assert.ok(t);
        assert.strictEqual(t.side, 'sell');
        approxEqual(t.price, EXPECTED_PRICE);
    });

    check('deriveTradeFromFillBlock: bare block without median is skipped', () => {
        const t = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            paysRaw: PAYS_SELL,
            receivesRaw: RECEIVES_SELL,
        }, { assetA: ASSET_CTX.assetA, assetB: ASSET_CTX.assetB });
        assert.strictEqual(t, null);
    });

    check('deriveTradeFromFillBlock: foreign asset IDs are skipped', () => {
        const t = deriveTradeFromFillBlock({
            timestamp: 1785800000.5,
            paysRaw: 100,
            paysAssetId: '1.3.9999',
            receivesRaw: 200,
            receivesAssetId: '1.3.8888',
        }, ASSET_CTX);
        assert.strictEqual(t, null);
    });

    check('deriveTradeFromFillBlock: null context is skipped', () => {
        const t = deriveTradeFromFillBlock({ timestamp: 1, paysRaw: 1, receivesRaw: 2 }, null);
        assert.strictEqual(t, null);
    });

    await checkAsync('parseLogFile: new-style block end-to-end (issue #22 format)', async () => {
        await withTempLog([
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] ===== FILL DETECTED =====',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Order ID: 1.7.569578780',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Pays: 86969888417 (1.3.6301), Receives: 27700000 (1.3.0)',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Block: 113545907 (History ID: 1.11.1394621506)',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] =========================',
        ], async (file) => {
            const trades = await parseLogFile(file, ASSET_CTX);
            assert.strictEqual(trades.length, 1);
            assert.strictEqual(trades[0].side, 'sell');
            assert.strictEqual(trades[0].order_id, '1.7.569578780');
            approxEqual(trades[0].amount, EXPECTED_AMOUNT);
            approxEqual(trades[0].price, EXPECTED_PRICE);
            assert.strictEqual(trades[0].timestamp, Date.parse('2026-08-17T08:18:36.320Z') / 1000);
        });
    });

    await checkAsync('parseLogFile: bare pre-fix blocks resolve via grid median', async () => {
        await withTempLog([
            '===== FILL DETECTED =====',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Order ID: 1.7.569578780',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Pays: 86969888417, Receives: 27700000',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Block: 113545907 (History ID: 1.11.1394621506)',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] =========================',
            '[2026-08-18T03:17:21.553Z] [INFO] [DEXBot] ===== FILL DETECTED =====',
            '[2026-08-18T03:17:21.553Z] [INFO] [DEXBot] Order ID: 1.7.573573438',
            '[2026-08-18T03:17:21.553Z] [INFO] [DEXBot] Pays: 87290493434, Receives: 27941124',
            '[2026-08-18T03:17:21.553Z] [INFO] [DEXBot] Block: 113568625 (History ID: 1.11.1394662552)',
        ], async (file) => {
            const trades = await parseLogFile(file, ASSET_CTX);
            assert.strictEqual(trades.length, 2);
            assert.strictEqual(trades[0].side, 'sell');
            assert.strictEqual(trades[1].side, 'sell');
            assert.strictEqual(trades[1].order_id, '1.7.573573438');
            assert.ok(trades[1].timestamp > trades[0].timestamp);
        });
    });

    await checkAsync('parseLogFile: mixed legacy lines, blocks, and fees', async () => {
        await withTempLog([
            '[2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS',
            '[2026-01-15T15:29:06.185Z] [INFO] [FEES] BTS fees calculated: 1 maker fills @ 0.04826000 BTS = 0.04826000 BTS',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] ===== FILL DETECTED =====',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Order ID: 1.7.569578780',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Pays: 86969888417 (1.3.6301), Receives: 27700000 (1.3.0)',
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Block: 113545907 (History ID: 1.11.1394621506)',
        ], async (file) => {
            const trades = await parseLogFile(file, ASSET_CTX);
            assert.strictEqual(trades.length, 2);
            assert.strictEqual(trades[0].side, 'sell');
            assert.strictEqual(trades[0].fee_amount, 0.04826);
            assert.strictEqual(trades[1].side, 'sell');
            assert.strictEqual(trades[1].order_id, '1.7.569578780');
        });
    });

    await checkAsync('parseLogFile: aggregated fee line splits per-fill', async () => {
        await withTempLog([
            '[2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS',
            '[2026-01-15T15:29:06.300Z] [DEBUG] [FILL] sell fill: size=0.02, price=1791.3, proceeds=35.826 BTS',
            '[2026-01-15T15:29:06.400Z] [INFO] [FEES] BTS fees calculated: 2 maker fills @ 0.04826000 BTS = 0.09652000 BTS',
        ], async (file) => {
            const trades = await parseLogFile(file, ASSET_CTX);
            assert.strictEqual(trades.length, 2);
            // Each fill gets the per-fill share, not the aggregated total.
            approxEqual(trades[0].fee_amount, 0.04826);
            approxEqual(trades[1].fee_amount, 0.04826);
        });
    });

    await checkAsync('parseLogFile: log without fills yields zero trades', async () => {
        await withTempLog([
            '[2026-08-17T08:18:36.320Z] [INFO] [DEXBot] Syncing 1 fill(s) (history mode)',
            '[2026-08-17T08:18:36.399Z] [INFO] [DEXBot] >>> Processing fill set fill set [slot-93] (1/1)',
        ], async (file) => {
            const trades = await parseLogFile(file, ASSET_CTX);
            assert.strictEqual(trades.length, 0);
        });
    });

    if (failed > 0) {
        console.error(`order export fill-block tests FAILED: ${failed} failed, ${passed} passed`);
        process.exit(1);
    }
    console.log(`order export fill-block tests passed (${passed} checks)`);
}

main().catch((err) => {
    console.error(`order export fill-block tests crashed: ${err && err.stack || err}`);
    process.exit(1);
});
