'use strict';
/**
 * Market-profile orientation tolerance.
 *
 * The candle cache stores pairs in their canonical (lower-id-first) orientation,
 * so a profile fitted from an assembled data file can be keyed on either side.
 * Both lookup paths must match the pair in either order, or a bot silently
 * falls back to builtin AMA defaults. Mirrors the flipped-pair test already
 * covering market_adapter/lp_chart_strategy_loader.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getErrorMessage } = require('../modules/utils/errors');

// Hermetic profile root: set before requiring anything that resolves PATHS.
// The bot is configured inverse of the profile's canonical order on purpose.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-profile-orient-'));
process.env.DEXBOT_PROFILE_ROOT = TEST_ROOT;
fs.writeFileSync(path.join(TEST_ROOT, 'bots.json'), JSON.stringify({
    bots: [
        { name: 'ORIENT-BOT', active: true, startPrice: 'pool', assetA: 'IOB.XRP', assetB: 'BTS', gridPrice: 'ama' },
    ],
}));
const CANONICAL_PROFILE = {
    key: 'BTS|IOB.XRP|3600',
    assetA: 'BTS',
    assetB: 'IOB.XRP',
    assetAId: '1.3.0',
    assetBId: '1.3.5537',
    intervalSeconds: 3600,
    intervalLabel: '1h',
    defaultAma: 'AMA1',
    amas: { AMA1: { name: 'AMA1', erPeriod: 111, fastPeriod: 2.2, slowPeriod: 33 } },
};
fs.writeFileSync(path.join(TEST_ROOT, 'market_profiles.json'), JSON.stringify({
    version: 1,
    profiles: [CANONICAL_PROFILE],
}));

const { resolveAmaConfig } = require('../analysis/bot_key_utils');
const { findMarketProfile } = require('../analysis/tradingview/tradingview_uplot_chart_generator');
const { updateAmaProfilesFile } = require('../analysis/ama_fitting/optimizer_high_resolution');

const PROFILES_PATH = path.join(TEST_ROOT, 'market_profiles.json');

function testFindMarketProfileAcceptsInverse() {
    const container = { profiles: [CANONICAL_PROFILE] };
    const exact = findMarketProfile(container, {
        assetA: { symbol: 'BTS', id: '1.3.0' },
        assetB: { symbol: 'IOB.XRP', id: '1.3.5537' },
        intervalSeconds: 3600,
    });
    assert.ok(exact, 'exact orientation must match');
    assert.strictEqual(exact.key, CANONICAL_PROFILE.key);

    const inverse = findMarketProfile(container, {
        assetA: { symbol: 'IOB.XRP', id: '1.3.5537' },
        assetB: { symbol: 'BTS', id: '1.3.0' },
        intervalSeconds: 3600,
    });
    assert.ok(inverse, 'inverse orientation must match the same profile');
    assert.strictEqual(inverse.key, CANONICAL_PROFILE.key);

    assert.strictEqual(findMarketProfile(container, {
        assetA: { symbol: 'OTHER', id: '1.3.9' },
        assetB: { symbol: 'BTS', id: '1.3.0' },
        intervalSeconds: 3600,
    }), null, 'a different pair must not match');

    assert.strictEqual(findMarketProfile(container, {
        assetA: { symbol: 'IOB.XRP', id: '1.3.5537' },
        assetB: { symbol: 'BTS', id: '1.3.0' },
        intervalSeconds: 14400,
    }), null, 'a different interval must not match');
}

function testResolveAmaConfigAcceptsInverse() {
    // Bot is IOB.XRP/BTS; the only profile is keyed BTS/IOB.XRP.
    const cfg = resolveAmaConfig('ORIENT-BOT');
    assert.strictEqual(cfg.erPeriod, 111, 'inverse-oriented bot must still resolve the fitted profile');
    assert.strictEqual(cfg.fastPeriod, 2.2, 'fast period comes from the matched profile');
    assert.strictEqual(cfg.slowPeriod, 33, 'slow period comes from the matched profile');
}

function winner(label, er, fast, slow) {
    return {
        label, er, fast, slow, key: label,
        weightedScore: 1, normDistance: 0, normMovement: 0,
        area: { up: 0, down: 0, total: 0 }, amaMovementTotal: 0, distanceTotal: 0, bandFactorPct: 0,
    };
}

function testWriterCanonicalizesAndDeduplicates() {
    // Pre-canonicalization entry for the same pool, written in inverse order.
    fs.writeFileSync(PROFILES_PATH, JSON.stringify({
        version: 1,
        profiles: [{
            key: 'IOB.XRP|BTS|3600',
            assetA: 'IOB.XRP', assetB: 'BTS',
            assetAId: '1.3.5537', assetBId: '1.3.0',
            intervalSeconds: 3600, intervalLabel: '1h', defaultAma: 'AMA3', amas: {},
        }],
    }));

    updateAmaProfilesFile({
        dataFile: '/tmp/lp_pool_133_1h.json',
        meta: {
            pool: '1.19.133',
            assetA: { id: '1.3.0', symbol: 'BTS' },
            assetB: { id: '1.3.5537', symbol: 'IOB.XRP' },
            intervalSeconds: 3600,
        },
        winners: {
            ama1: winner('AMA1', 1, 2, 3),
            ama2: winner('AMA2', 4, 5, 6),
            ama3: winner('AMA3', 7, 8, 9),
            ama4: winner('AMA4', 10, 11, 12),
        },
        sourceResultsFile: null,
    });

    const written = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    assert.strictEqual(written.profiles.length, 1, 'inverse entry must be replaced, not duplicated');
    assert.strictEqual(written.profiles[0].key, 'BTS|IOB.XRP|3600', 'written key is canonical');
    assert.strictEqual(written.profiles[0].assetA, 'BTS', 'stored assetA is canonical');
    assert.strictEqual(written.profiles[0].assetB, 'IOB.XRP', 'stored assetB is canonical');
}

(async () => {
    testFindMarketProfileAcceptsInverse();
    testResolveAmaConfigAcceptsInverse();
    testWriterCanonicalizesAndDeduplicates();
})()
    .then(() => {
        console.log('market profile orientation tests passed');
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
        process.exit(1);
    });
