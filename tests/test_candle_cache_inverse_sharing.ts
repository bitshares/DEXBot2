'use strict';
/**
 * Inverse-orientation candle cache sharing.
 *
 * `bts/iob.xrp` and `iob.xrp/bts` must resolve to ONE cache family: the
 * canonical (lower-id-first) orientation on disk, translated back to the
 * requested side on the way out. These tests cover the pure transform, the
 * in-memory share (second orientation does not re-query), and the one-way
 * migration of a legacy inverse-orientation shard.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getErrorMessage } = require('../modules/utils/errors');

const { canonicalPair, invertCandleSeries } = require('../market_adapter/utils/pair_orientation');
const { fetchMarketCandlesSequentially } = require('../market_adapter/inputs/fetch_book_data');

const ASSET_A = { id: '1.3.1', precision: 5, symbol: 'BTS' };
const ASSET_B = { id: '1.3.2', precision: 4, symbol: 'TEST.USD' };

function fillHit({ id, ts, soldAssetId, receivedAssetId, soldAmount, receivedAmount }) {
    const seq = Number(String(id).match(/(\d+)$/)?.[1] || 0);
    return {
        _id: id,
        sort: [new Date(ts).toISOString(), seq],
        _source: {
            operation_id_num: seq,
            account_history: { operation_id: id },
            block_data: { block_time: new Date(ts).toISOString() },
            operation_history: {
                op_object: {
                    pays: { asset_id: soldAssetId, amount: soldAmount },
                    receives: { asset_id: receivedAssetId, amount: receivedAmount },
                },
            },
        },
    };
}

function soldAssetFromQuery(query) {
    const field = 'operation_history.op_object.pays.asset_id.keyword';
    return query.query.bool.filter.find((f) => f.term?.[field])?.term?.[field];
}

function testCanonicalPairAndInversion() {
    const pair = canonicalPair(ASSET_B, ASSET_A);
    assert.strictEqual(pair.flipped, true, 'higher-id-first input is flipped');
    assert.strictEqual(pair.assetA.id, ASSET_A.id, 'canonical A is the lower id');
    assert.strictEqual(pair.assetB.id, ASSET_B.id, 'canonical B is the higher id');
    assert.strictEqual(canonicalPair(ASSET_A, ASSET_B).flipped, false, 'already-canonical input is not flipped');

    const original = [[1000, 0.5, 0.75, 0.4, 0.8, 10]];
    const inverted = invertCandleSeries(original, { volume: 'scale' });
    assert.ok(Math.abs(inverted[0][1] - 1 / 0.8) < 1e-12, 'inverse open = 1/close (no swap)');
    assert.ok(Math.abs(inverted[0][2] - 1 / 0.4) < 1e-12, 'inverse high = 1/low');
    assert.ok(Math.abs(inverted[0][3] - 1 / 0.75) < 1e-12, 'inverse low = 1/high');
    assert.ok(Math.abs(inverted[0][4] - 1 / 0.5) < 1e-12, 'inverse close = 1/open');
    assert.ok(Math.abs(inverted[0][5] - 10 * 0.8) < 1e-12, 'inverse base volume ≈ base × close');

    const roundTrip = invertCandleSeries(inverted, { volume: 'scale' });
    assert.ok(Math.abs(roundTrip[0][1] - 0.5) < 1e-12, 'double inversion restores open');
    assert.ok(Math.abs(roundTrip[0][4] - 0.8) < 1e-12, 'double inversion restores close');
    // Volume uses the candle's own close (a per-conversion approximation, like
    // the chart's inverse view); only single conversions happen in production.

    const preserved = invertCandleSeries([[1000, 2, 4, 1, 3, 9]], { volume: 'preserve' });
    assert.strictEqual(preserved[0][5], 9, 'count volume is preserved');
}

async function testBookCacheSharesAcrossOrientations() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-inverse-book-'));
    const outPath = path.join(dir, 'book_bts_test_usd_1h.json');
    const ts = Date.parse('2026-01-15T00:00:00Z');
    const timeRange = { gte: '2026-01-01T00:00:00.000Z', lte: '2026-01-31T00:00:00.000Z' };
    let searchCalls = 0;
    const mockSearch = async (_cfg, query) => {
        searchCalls += 1;
        if (soldAssetFromQuery(query) !== ASSET_A.id) return { hits: { hits: [] } };
        return {
            hits: {
                hits: [fillHit({
                    id: `1.11.${searchCalls}`,
                    ts,
                    soldAssetId: ASSET_A.id,
                    receivedAssetId: ASSET_B.id,
                    soldAmount: 100000,
                    receivedAmount: 5000,
                })],
            },
        };
    };

    try {
        const opts = { intervalSeconds: 3600, timeRange, chunkMonths: 1, outPath, kibanaSearch: mockSearch };
        const canonical = await fetchMarketCandlesSequentially(ASSET_A, ASSET_B, opts);
        assert.ok(canonical.length > 0, 'canonical fetch must return candles');
        const callsAfterCanonical = searchCalls;
        assert.ok(callsAfterCanonical > 0, 'first fetch must query Kibana');

        const inverse = await fetchMarketCandlesSequentially(ASSET_B, ASSET_A, opts);
        assert.strictEqual(
            searchCalls,
            callsAfterCanonical,
            'inverse orientation must reuse the canonical cache with no new queries'
        );
        assert.strictEqual(inverse.length, canonical.length, 'same bucket count');
        assert.ok(
            Math.abs(inverse[0][4] - 1 / canonical[0][4]) < 1e-12,
            'inverse close is the reciprocal of the canonical close'
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testLegacyInverseShardIsMigrated() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-inverse-legacy-'));
    const canonicalDir = path.join(dir, 'bts_test_usd');
    const inverseDir = path.join(dir, 'test_usd_bts');
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.mkdirSync(inverseDir, { recursive: true });
    const outPath = path.join(canonicalDir, 'book_bts_test_usd_1h.json');
    const ts = Date.parse('2023-01-02T00:00:00Z');
    // Hand-written inverse-orientation shard: pre-canonicalization layout.
    fs.writeFileSync(
        path.join(inverseDir, 'book_test_usd_bts_1h.shard_2023-01.json'),
        JSON.stringify({
            meta: {
                source: 'book',
                pair: 'test_usd_bts',
                intervalSeconds: 3600,
                assetA: ASSET_B,
                assetB: ASSET_A,
                timeRange: { gte: '2023-01-02T00:00:00.000Z', lte: '2023-01-02T01:00:00.000Z' },
                queriedRanges: [{ gte: ts, lte: ts + 3600 * 1000, at: Date.parse('2023-02-01T00:00:00Z') }],
                fetchedAt: '2023-02-01T00:00:00.000Z',
            },
            candles: [[ts, 2, 2.5, 1.5, 2.5, 5]],
        })
    );

    let searchCalls = 0;
    const mockSearch = async () => { searchCalls += 1; return { hits: { hits: [] } }; };

    try {
        const candles = await fetchMarketCandlesSequentially(ASSET_A, ASSET_B, {
            intervalSeconds: 3600,
            timeRange: { gte: '2023-01-02T00:00:00.000Z', lte: '2023-01-02T01:00:00.000Z' },
            chunkMonths: 1,
            outPath,
            kibanaSearch: mockSearch,
        });
        assert.strictEqual(searchCalls, 0, 'legacy inverse shard must be reused without a query');
        assert.strictEqual(candles.length, 1, 'migrated shard yields its bucket');
        assert.ok(Math.abs(candles[0][4] - 1 / 2) < 1e-12, 'legacy inverse candle is inverted to canonical');

        const migrated = fs.readdirSync(canonicalDir).filter((n) => n.includes('.shard_2023-01.json'));
        assert.strictEqual(migrated.length, 1, 'legacy bucket is written into the canonical shard family');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

(async () => {
    testCanonicalPairAndInversion();
    await testBookCacheSharesAcrossOrientations();
    await testLegacyInverseShardIsMigrated();
})()
    .then(() => {
        console.log('candle cache inverse sharing tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });
