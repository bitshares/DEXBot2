'use strict';

/**
 * Asset-symbol normalization is centralized in modules/utils/asset_symbols.ts
 * and applied at every boundary that accepts a pair (CLI prompts, `dexbot tv`/
 * `dexbot dw` targets, bots.json) or hands a symbol to the chain. BitShares
 * `lookup_asset_symbols` is case-sensitive, so a miss here is a silent miss:
 * the lowercase symbol resolves to null and the wrong casing propagates into
 * cache keys, chart titles and strict comparisons like `assetA === 'ASSET_A'`.
 */

const assert = require('assert');

console.log('Running asset symbol normalization tests');

const {
    isAssetObjectId,
    normalizeAssetSymbol,
    normalizeAssetRef,
    isSameAssetSymbol,
    splitPairTarget,
} = require('../modules/utils/asset_symbols');

// ── Core helper ─────────────────────────────────────────────────────────────
assert.strictEqual(normalizeAssetSymbol('asset_a'), 'ASSET_A', 'lowercase → uppercase');
assert.strictEqual(normalizeAssetSymbol('  asset_b  '), 'ASSET_B', 'trimmed + uppercased');
assert.strictEqual(normalizeAssetSymbol('ASSET_B'), 'ASSET_B', 'already canonical stays put');
assert.strictEqual(normalizeAssetSymbol(''), '', 'empty string stays empty');
assert.strictEqual(normalizeAssetSymbol('   '), '', 'whitespace-only becomes empty');
assert.strictEqual(normalizeAssetSymbol(null), '', 'null → empty (never "null")');
assert.strictEqual(normalizeAssetSymbol(undefined), '', 'undefined → empty (never "undefined")');
assert.strictEqual(normalizeAssetSymbol(123), '123', 'non-strings are stringified');
// Only the OUTER whitespace is trimmed: inner separators of a compound symbol
// must survive untouched (a real symbol can carry them).
assert.strictEqual(normalizeAssetSymbol('  asset_b_c  '), 'ASSET_B_C', 'only outer whitespace trimmed');
assert.strictEqual(normalizeAssetSymbol('asset_b_c'), 'ASSET_B_C', 'inner separator preserved');

// Object ids are not symbols: they must survive verbatim or the ref-routing
// callers (get_assets vs lookup_asset_symbols) would change branch.
assert.strictEqual(normalizeAssetSymbol('1.3.0'), '1.3.0', 'asset id passed through untouched');
assert.strictEqual(normalizeAssetRef('1.3.529'), '1.3.529', 'normalizeAssetRef keeps object ids');
assert.strictEqual(isAssetObjectId('1.3.0'), true, 'object id detected');
assert.strictEqual(isAssetObjectId('ASSET_A'), false, 'symbol is not an object id');
assert.strictEqual(isAssetObjectId(' 1.3.0 '), true, 'object id detected after trim');

assert.strictEqual(isSameAssetSymbol('asset_a', 'ASSET_A'), true, 'case-insensitive equality');
assert.strictEqual(isSameAssetSymbol(' asset_a ', 'asset_a'), true, 'whitespace-insensitive equality');
assert.strictEqual(isSameAssetSymbol('asset_a', 'asset_c'), false, 'different assets do not match');
assert.strictEqual(isSameAssetSymbol('', ''), false, 'empty never matches empty');

assert.deepStrictEqual(splitPairTarget('asset_a/asset_b'), ['ASSET_A', 'ASSET_B'], 'pair target canonicalized');
assert.deepStrictEqual(splitPairTarget(' ASSET_A / ASSET_B '), ['ASSET_A', 'ASSET_B'], 'pair target trimmed');
assert.deepStrictEqual(splitPairTarget('1.3.0/1.3.1'), ['1.3.0', '1.3.1'], 'id pair untouched');
assert.deepStrictEqual(splitPairTarget('ASSET_A'), ['ASSET_A'], 'single leg yields one entry (caller validates count)');
assert.deepStrictEqual(splitPairTarget(''), [], 'empty target yields no legs');

// ── market_adapter resolveAsset: uppercase on the wire ──────────────────────
const { resolveAsset } = require('../market_adapter/utils/chain');

const ASSET_A = { id: '1.3.0', precision: 5, symbol: 'ASSET_A' };
const ASSET_B_MPA = { id: '1.3.5649', precision: 4, symbol: 'ASSET_B' };

function symbolClient(seen) {
    return {
        BitShares: {
            db: {
                lookup_asset_symbols: async (syms) => {
                    seen.push(...syms);
                    return syms.map((s) => (s === 'ASSET_A' ? ASSET_A : s === 'ASSET_B' ? ASSET_B_MPA : null));
                },
            },
        },
    };
}

(async () => {
    const seen: string[] = [];
    const client = symbolClient(seen);

    const lower = await resolveAsset('asset_a', client);
    assert.deepStrictEqual(seen, ['ASSET_A'], 'lowercase symbol is uppercased before lookup_asset_symbols');
    assert.strictEqual(lower.symbol, 'ASSET_A', 'resolved asset carries the canonical symbol');
    assert.strictEqual(lower.id, ASSET_A.id, 'id resolved');
    assert.strictEqual(lower.precision, ASSET_A.precision, 'precision resolved');

    const mixed = await resolveAsset(' asset_b ', client);
    assert.deepStrictEqual(seen, ['ASSET_A', 'ASSET_B'], 'trimmed + uppercased before lookup');
    assert.strictEqual(mixed.symbol, 'ASSET_B', 'canonical symbol returned');

    // ── order/utils/system lookupAsset: uppercase on the wire ────────────────
    const { lookupAsset, resolveAssetByRef } = require('../modules/order/utils/system');
    const sysSeen: string[] = [];
    const BitShares = {
        db: {
            lookup_asset_symbols: async (syms) => {
                sysSeen.push(...syms);
                return syms.map((s) => (s === 'ASSET_A' ? ASSET_A : s === 'ASSET_B' ? ASSET_B_MPA : null));
            },
            get_assets: async (ids) => ids.map(() => null),
        },
    };

    await lookupAsset(BitShares, 'asset_a');
    assert.deepStrictEqual(sysSeen, ['ASSET_A'], 'lookupAsset sends the canonical symbol');

    await resolveAssetByRef(BitShares, 'asset_b');
    assert.deepStrictEqual(sysSeen, ['ASSET_A', 'ASSET_B'], 'resolveAssetByRef sends the canonical symbol');

    // ── bots.json read funnel ────────────────────────────────────────────────
    const { normalizeBotEntry } = require('../modules/bot_settings');
    const upper = normalizeBotEntry({ name: 'upper-bot', assetA: 'ASSET_A', assetB: 'ASSET_B' }, 0);
    const lowerEntry = normalizeBotEntry({ name: 'lower-bot', assetA: 'asset_a', assetB: 'asset_b' }, 0);
    assert.strictEqual(lowerEntry.assetA, 'ASSET_A', 'lowercase assetA canonicalized on load');
    assert.strictEqual(lowerEntry.assetB, 'ASSET_B', 'lowercase assetB canonicalized on load');
    assert.deepStrictEqual(
        { assetA: lowerEntry.assetA, assetB: lowerEntry.assetB },
        { assetA: upper.assetA, assetB: upper.assetB },
        'case-only difference in bots.json is not a different bot'
    );
    const lowerSameName = normalizeBotEntry({ name: 'pair-bot', assetA: 'asset_a', assetB: 'asset_b' }, 7);
    const upperSameName = normalizeBotEntry({ name: 'pair-bot', assetA: 'ASSET_A', assetB: 'ASSET_B' }, 7);
    assert.strictEqual(lowerSameName.botKey, upperSameName.botKey, 'botKey is case-insensitive (sanitizeKey)');
    // Ids must keep their digits-only form.
    const idEntry = normalizeBotEntry({ name: 'id-bot', assetA: '1.3.0', assetB: '1.3.1' }, 0);
    assert.strictEqual(idEntry.assetA, '1.3.0', 'asset id in bots.json untouched');
    // Absent keys stay absent — validateBotEntry relies on key absence.
    const bare = normalizeBotEntry({ name: 'bare' }, 0);
    assert.ok(!('assetA' in bare) && !('assetB' in bare), 'missing asset keys are not seeded');
    // Deterministic / non-mutating.
    const raw: any = { name: 'raw-bot', assetA: 'asset_a', assetB: 'asset_b' };
    const first = normalizeBotEntry(raw, 3);
    assert.strictEqual(raw.assetA, 'asset_a', 'normalizeBotEntry does not mutate its input');
    assert.deepStrictEqual(normalizeBotEntry(raw, 3), first, 'normalization is deterministic');

    // ── `dexbot tv` / `dexbot dw` price-feed leg ────────────────────────────────────
    const { resolveMpaBacking } = require('../scripts/chart_command');
    const mpaSeen: string[] = [];
    const bitasset: any = { options: { short_backing_asset: ASSET_A.id, is_prediction_market: false } };
    const mpaClient = {
        BitShares: {
            db: {
                lookup_asset_symbols: async (syms: string[]) => {
                    mpaSeen.push(...syms);
                    return syms.map((s) => (s === 'ASSET_B' ? { ...ASSET_B_MPA, bitasset_data_id: '2.4.294' } : null));
                },
                get_objects: async (ids: string[]) => ids.map(() => bitasset),
                get_assets: async (ids: string[]) => ids.map((id) => (id === ASSET_A.id ? ASSET_A : null)),
            },
        },
    };
    const mpa = await resolveMpaBacking('asset_b', mpaClient);
    assert.deepStrictEqual(mpaSeen, ['ASSET_B'], 'price-feed leg uppercased before lookup');
    assert.strictEqual(mpa.mpa.symbol, 'ASSET_B', 'price-feed leg reported with canonical symbol');

    // ── bots.json: debtPolicy.lending pair (no editor prompt exists) ─────────
    const lendingBot: any = {
        name: 'credit-bot',
        assetA: 'TOKENA',
        assetB: 'ASSET_B',
        debtPolicy: {
            lending: [
                { type: 'creditOffer', asset: 'tokena', collateralAsset: 'asset_b', maxCollateralRatio: 1.5 },
                { type: 'creditOffer', asset: 'ASSET_A', collateralAsset: 'TOKENA' },
            ],
        },
    };
    const normalizedLending = normalizeBotEntry(lendingBot, 0);
    assert.strictEqual(normalizedLending.debtPolicy.lending[0].asset, 'TOKENA', 'lending asset canonicalized');
    assert.strictEqual(normalizedLending.debtPolicy.lending[0].collateralAsset, 'ASSET_B', 'lending collateral canonicalized');
    assert.strictEqual(normalizedLending.debtPolicy.lending[1].asset, 'ASSET_A', 'already-canonical lending entry untouched');
    assert.strictEqual(normalizedLending.debtPolicy.lending[1].collateralAsset, 'TOKENA', 'second entry canonicalized');
    assert.strictEqual(lendingBot.debtPolicy.lending[0].asset, 'tokena', 'input not mutated');
    assert.strictEqual(lendingBot.debtPolicy.lending[0].maxCollateralRatio, 1.5, 'sibling fields preserved');
    // No lending array / malformed policy must pass through untouched.
    const noPolicy = normalizeBotEntry({ name: 'n' }, 0);
    assert.ok(!('debtPolicy' in noPolicy), 'absent debtPolicy is not seeded');
    const badPolicy = normalizeBotEntry({ name: 'n', debtPolicy: { lending: 'nope' } }, 0);
    assert.strictEqual(badPolicy.debtPolicy.lending, 'nope', 'malformed lending is passed through verbatim');
    // Reference equality is kept when there is nothing to canonicalize.
    const cleanPolicy = { lending: [{ asset: 'ASSET_A', collateralAsset: 'ASSET_B' }] };
    assert.strictEqual(
        normalizeBotEntry({ name: 'n', debtPolicy: cleanPolicy }, 0).debtPolicy,
        cleanPolicy,
        'already-canonical debtPolicy keeps its reference (no needless clone)'
    );

    // ── claw: user-supplied pair option (assetA/assetB) ───────────────────────────────
    const { splitPair } = require('../claw/modules/claw_bridge');
    assert.deepStrictEqual(splitPair('asset_a/asset_b'), { baseSymbol: 'ASSET_A', quoteSymbol: 'ASSET_B' },
        'claw pair option canonicalized to uppercase');
    assert.deepStrictEqual(splitPair(' asset_a / asset_b '), { baseSymbol: 'ASSET_A', quoteSymbol: 'ASSET_B' },
        'claw pair option trimmed + canonicalized');
    assert.deepStrictEqual(splitPair('1.3.0/1.3.1'), { baseSymbol: '1.3.0', quoteSymbol: '1.3.1' },
        'claw pair option keeps asset ids verbatim');
    assert.throws(() => splitPair('asset_a'), /BASE\/QUOTE/, 'claw still rejects a one-leg pair');
    assert.throws(() => splitPair('asset_a/asset_b/extra'), /BASE\/QUOTE/, 'claw still rejects three legs');

    console.log('All asset symbol normalization tests passed');
})().catch((e: any) => {
    console.error(e);
    process.exit(1);
});
