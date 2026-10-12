'use strict';

// Bot-defaults parity suite (Phase 5 of defaults centralization) — the drift
// guards that keep the unified sources from silently diverging again:
//
//   1. buildDefaultGeneralSettings is THE default general.settings.json
//      document: exact key set/order (= editor-saved shape), merge round-trip
//      stability, no dead keys (ANCHOR must never return).
//   2. Every DEFAULT_CONFIG key is classified in bot_defaults
//      (DRAFT_SEED_ORDER or DRAFT_EXCLUDED_KEYS) — a new DEFAULT_CONFIG key
//      fails here until consciously placed, instead of silently never being
//      seeded (or being seeded and breaking byte stability).
//   3. Whitelist flag literals exist ONLY in market_adapter_whitelist's three
//      constants (source-level guard: generator/validator keep zero literals).
//   4. seedBotRuntimeConfig is value-, order-, and reference-compatible with
//      the historical `{ ...DEFAULT_CONFIG, ...config }` spread.
//
// DEFAULT_CONFIG is deliberately NOT frozen: tests (test_grid_logic) mutate
// DEFAULT_CONFIG.incrementPercent by design, and freezing would throw.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { DEFAULT_CONFIG, buildDefaultGeneralSettings, LOG_LEVEL } = require('../modules/constants');
const { normalizeBotDraft } = require('../modules/account_bots');
const { loadGeneralSettings } = require('../modules/account_bots');
const {
    DRAFT_SEED_ORDER,
    DRAFT_EXCLUDED_KEYS,
    seedBotEntry,
    seedBotRuntimeConfig,
} = require('../modules/bot_defaults');
const { mergeSettings, buildNodesView } = require('../modules/settings_merge');

// Source files (not dist) for the literal source-guard — __dirname is dist/tests.
const REPO_ROOT = path.join(__dirname, '..', '..');

// The editor-saved general.settings.json shape: constants first, derived
// NODES last. Historically the first-run file used a different order, omitted
// NODE_MANAGEMENT and carried a dead ANCHOR:{} key — all fixed in Phase 4.
const SETTINGS_DOC_KEYS = [
    'LOG_LEVEL', 'GRID_LIMITS', 'TIMING', 'UPDATER', 'MARKET_ADAPTER',
    'NODE_MANAGEMENT', 'DEFAULT_CONFIG', 'FILL_PROCESSING', 'PIPELINE_TIMING',
    'CREDENTIAL_PROMPTS', 'MAINTENANCE', 'COW_PERFORMANCE', 'INCREMENT_BOUNDS',
    'FEE_PARAMETERS', 'API_LIMITS', 'LOGGING_CONFIG', 'NATIVE_CLIENT',
    'LAUNCHER', 'NODES',
];

const NESTED_DEFAULT_KEYS = ['weightDistribution', 'botFunds', 'coreOrders', 'edgeOrders'];

function testSettingsDocShapeAndRoundTrip() {
    console.log(' - parity: settings-doc key set, round-trip, fixed point...');
    const doc = buildDefaultGeneralSettings();

    assert.deepStrictEqual(Object.keys(doc), SETTINGS_DOC_KEYS,
        'builder must emit exactly the editor-saved key set/order (first-run files were historically different)');
    assert.ok(!('ANCHOR' in doc), 'dead ANCHOR key must never come back');
    assert.strictEqual(doc.LOG_LEVEL, LOG_LEVEL, 'LOG_LEVEL section present');

    // Every default present → merged result has the same shape.
    const merged = mergeSettings({}, doc);
    assert.deepStrictEqual(Object.keys(merged), SETTINGS_DOC_KEYS, 'merge must not add/drop keys');

    // NODES is derived from NODE_MANAGEMENT, never drifted from buildNodesView.
    assert.deepStrictEqual(merged.NODES, buildNodesView(doc.NODE_MANAGEMENT), 'merged NODES must equal buildNodesView(NODE_MANAGEMENT)');

    // Re-merging the merged document is a fixed point (idempotent).
    const again = mergeSettings(merged, doc);
    assert.deepStrictEqual(again, merged, 'mergeSettings(merged, doc) must be a fixed point');

    // The editor fallback export produces the same canonical shape.
    const editorDoc = loadGeneralSettings();
    assert.deepStrictEqual(Object.keys(editorDoc), SETTINGS_DOC_KEYS,
        'loadGeneralSettings must return the canonical key set/order');
}

function testEveryDefaultConfigKeyIsClassified() {
    console.log(' - parity: every DEFAULT_CONFIG key classified in bot_defaults...');

    const seedSet = new Set(DRAFT_SEED_ORDER);
    const exclSet = new Set(DRAFT_EXCLUDED_KEYS);
    for (const key of DRAFT_SEED_ORDER) {
        assert.ok(!exclSet.has(key), `'${key}' is both seeded and excluded — disjoint sets required`);
        assert.ok(key in DEFAULT_CONFIG, `DRAFT_SEED_ORDER key '${key}' must exist in DEFAULT_CONFIG`);
    }
    for (const key of Object.keys(DEFAULT_CONFIG)) {
        assert.ok(seedSet.has(key) || exclSet.has(key),
            `DEFAULT_CONFIG.${key} is unclassified — add it to DRAFT_SEED_ORDER or DRAFT_EXCLUDED_KEYS in modules/bot_defaults.ts`);
    }

    // Behavior follows the classification: seeded keys present (in seed order
    // → byte-stable new-bot JSON), excluded keys absent.
    const draft = normalizeBotDraft({});
    assert.deepStrictEqual(Object.keys(draft), DRAFT_SEED_ORDER,
        'new-bot draft key order must equal DRAFT_SEED_ORDER (persisted JSON byte stability)');
    for (const key of DRAFT_EXCLUDED_KEYS) {
        assert.ok(!(key in draft), `draft must not seed excluded DEFAULT_CONFIG key '${key}'`);
    }
    for (const key of DRAFT_SEED_ORDER) {
        assert.ok(key in draft, `draft must seed '${key}'`);
        assert.deepStrictEqual(draft[key], DEFAULT_CONFIG[key], `draft.${key} must equal DEFAULT_CONFIG.${key}`);
    }
}

function countFlagLiterals(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    // Strip // line comments (comment prose mentions flag shapes) before counting.
    const stripped = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    const matches = stripped.match(/\b(ama|dynamicWeight|asymmetricBounds):\s*(true|false)\b/g);
    return matches ? matches.length : 0;
}

function testWhitelistLiteralsLiveOnlyInConstants() {
    console.log(' - parity: whitelist flag literals only in the canonical constants...');

    // 3 constants × 3 flags = exactly 9 value literals.
    assert.strictEqual(countFlagLiterals(path.join(REPO_ROOT, 'modules', 'market_adapter_whitelist.ts')), 9,
        'market_adapter_whitelist.ts must contain exactly the 3 canonical flag constants (9 literals)');
    assert.strictEqual(countFlagLiterals(path.join(REPO_ROOT, 'modules', 'validate_profiles.ts')), 0,
        'validate_profiles must derive WHITELIST_KNOWN_FLAGS from the constants, never inline literals');
}

function testRuntimeConfigMatchesHistoricalSpread() {
    console.log(' - parity: seedBotRuntimeConfig == { ...DEFAULT_CONFIG, ...config }...');

    const provided = { coreOrders: { buy: 3 }, minPrice: '4x', logFile: '/tmp/x.log' };
    const spread = { ...DEFAULT_CONFIG, ...provided };
    const seeded = seedBotRuntimeConfig(provided);

    assert.deepStrictEqual(seeded, spread, 'values must equal the historical spread result');
    assert.deepStrictEqual(Object.keys(seeded), Object.keys(spread),
        'key order must equal the historical spread (deep clone of defaults must not reorder)');
    assert.strictEqual(seeded.coreOrders, provided.coreOrders,
        'provided nested values keep their reference (spread semantics)');
    for (const key of NESTED_DEFAULT_KEYS) {
        assert.notStrictEqual(seeded[key], DEFAULT_CONFIG[key],
            `absent default '${key}' must be a clone, never an alias of DEFAULT_CONFIG.${key}`);
    }

    // Explicit-undefined provided values win, exactly like object spread.
    const withUndef = seedBotRuntimeConfig({ minPrice: undefined });
    assert.deepStrictEqual(Object.keys(withUndef), Object.keys({ ...DEFAULT_CONFIG, minPrice: undefined }),
        'explicit-undefined keys keep spread semantics (present, value undefined)');
    assert.strictEqual(withUndef.minPrice, undefined, 'explicit-undefined beats the default, as spread does');
}

function testEntrySeedContract() {
    console.log(' - parity: seedBotEntry contract (active default, raw passthrough)...');
    assert.strictEqual(seedBotEntry({}).active, DEFAULT_CONFIG.active, 'missing active → DEFAULT_CONFIG.active');
    assert.strictEqual(seedBotEntry({ active: false }).active, false, 'present false passes through');
    assert.strictEqual(seedBotEntry({ active: null }).active, null, 'present null passes through raw');
    assert.deepStrictEqual(seedBotEntry({ name: 'x' }), { active: DEFAULT_CONFIG.active, name: 'x' },
        'seedBotEntry must add NOTHING besides active (validation relies on key absence)');
}

function main() {
    testSettingsDocShapeAndRoundTrip();
    testEveryDefaultConfigKeyIsClassified();
    testWhitelistLiteralsLiveOnlyInConstants();
    testRuntimeConfigMatchesHistoricalSpread();
    testEntrySeedContract();
    console.log('bot defaults parity tests passed');
}

main();
