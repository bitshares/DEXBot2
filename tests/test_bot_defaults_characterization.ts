'use strict';

// Bot-defaults characterization suite (Phase 0 of defaults centralization).
//
// Pins CURRENT behavior of every defaults source before they are unified into
// a single seeder (modules/bot_defaults.ts) and a single general-settings doc
// builder (buildDefaultGeneralSettings in modules/constants.ts):
//
//   * normalizeBotDraft   — editor seed: exact key set, null/partial preservation,
//                           falsy-replace count objects, reserveOrders migration,
//                           gridPrice now seeded from DEFAULT_CONFIG (Phase 2 fix).
//   * normalizeBotEntry   — runtime entry: active default sourced from
//                           DEFAULT_CONFIG (Phase 3), raw-value passthrough.
//   * OrderManager config — deep-cloned defaults (Phase 3 fixed the historical
//                           DEFAULT_CONFIG aliasing) + spread-compatible passthrough.
//   * whitelist flags     — all default shapes in market_adapter_whitelist.ts and
//                           the whitelist generator (literals centralize in Phase 1,
//                           values must not change).
//
// Expectations derive from DEFAULT_CONFIG where possible so a developer's
// general.settings.json overrides don't produce false failures.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Config snapshots process.env at module load — whitelist override MUST be set
// before the first project require() (AGENTS config-caching trap) so these tests
// never touch the real profiles/market_adapter_whitelist.json.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-defaults-char-'));
const WHITELIST_FILE = path.join(TEMP_DIR, 'market_adapter_whitelist.json');
process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = WHITELIST_FILE;

const { DEFAULT_CONFIG } = require('../modules/constants');
const { normalizeBotDraft } = require('../modules/account_bots');
const { normalizeBotEntry } = require('../modules/bot_settings');
const {
    getWhitelistFlags,
    resetMarketAdapterWhitelistCache,
} = require('../modules/market_adapter_whitelist');
const { OrderManager } = require('../modules/order/manager');

const ALL_FALSE = { ama: false, dynamicWeight: false, asymmetricBounds: false };
const AMA_ONLY = { ama: true, dynamicWeight: false, asymmetricBounds: false };
const ALL_TRUE = { ama: true, dynamicWeight: true, asymmetricBounds: true };

// The four DEFAULT_CONFIG keys normalizeBotDraft must never seed: seeding them
// would change persisted bots.json bytes and pre-satisfy validateBotEntry's
// required-key check for assetA/assetB.
const DRAFT_EXCLUDED_KEYS = ['assetA', 'assetB', 'creditOnly', 'min_BTS_value'];

const COUNT_OBJECT_KEYS = ['weightDistribution', 'botFunds', 'activeOrders'];

const SCALAR_SEED_KEYS = [
    'active', 'dryRun', 'minPrice', 'maxPrice',
    'incrementPercent', 'targetSpreadPercent', 'startPrice', 'gridPrice',
];

function writeWhitelist(doc) {
    fs.writeFileSync(
        WHITELIST_FILE,
        typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n',
        'utf8'
    );
    // Raw fs writes bypass the module's own write path, so refresh its cache.
    resetMarketAdapterWhitelistCache();
}

function removeWhitelist() {
    if (fs.existsSync(WHITELIST_FILE)) fs.unlinkSync(WHITELIST_FILE);
    resetMarketAdapterWhitelistCache();
}

function testDraftSnapshot() {
    console.log(' - draft: exact snapshot of normalizeBotDraft({})...');
    const draft = normalizeBotDraft({});
    const expected: Record<string, any> = {};
    for (const key of COUNT_OBJECT_KEYS) expected[key] = { ...DEFAULT_CONFIG[key] };
    expected.reserveOrders = { ...DEFAULT_CONFIG.reserveOrders };
    for (const key of SCALAR_SEED_KEYS) expected[key] = DEFAULT_CONFIG[key];
    // Phase 2 fix: gridPrice is seeded from DEFAULT_CONFIG.gridPrice (the
    // repo default is "ama3"; a null default still falls back to null),
    // no longer the historical hardcoded null literal.
    expected.gridPrice = DEFAULT_CONFIG.gridPrice ?? null;

    assert.deepStrictEqual(draft, expected, 'draft({}) must seed exactly the current 12 keys with DEFAULT_CONFIG values');

    const keySet = Object.keys(draft).sort();
    assert.deepStrictEqual(
        keySet,
        [...COUNT_OBJECT_KEYS, 'reserveOrders', ...SCALAR_SEED_KEYS].sort(),
        'draft key set must stay exactly the seeded 12 keys'
    );
    for (const key of DRAFT_EXCLUDED_KEYS) {
        assert.ok(!(key in draft), `draft must NOT seed excluded DEFAULT_CONFIG key '${key}' (byte stability)`);
    }

    // Seeded count objects must be fresh copies, never shared DEFAULT_CONFIG refs.
    for (const key of [...COUNT_OBJECT_KEYS, 'reserveOrders']) {
        assert.notStrictEqual(draft[key], DEFAULT_CONFIG[key], `draft.${key} must not alias DEFAULT_CONFIG.${key}`);
    }
    assert.notStrictEqual(draft, DEFAULT_CONFIG, 'draft must be a new object');
}

function testDraftDoesNotMutateInputAndPassesThroughExtraKeys() {
    console.log(' - draft: input untouched, extra keys pass through...');
    const input = { name: 'probe', gridPriceOffsetPct: 0.35, gridPriceOffsetClampToBounds: true };
    const pristine = JSON.parse(JSON.stringify(input));
    const draft = normalizeBotDraft(input);
    assert.deepStrictEqual(input, pristine, 'normalizeBotDraft must not mutate its input');
    assert.strictEqual(draft.gridPriceOffsetPct, 0.35, 'unknowable extra keys pass through unchanged');
    assert.strictEqual(draft.gridPriceOffsetClampToBounds, true, 'unknowable extra keys pass through unchanged');
    assert.strictEqual(draft.name, 'probe', 'unrelated keys pass through');
}

function testDraftPreservesNullsAndPartials() {
    console.log(' - draft: null scalars kept, partial count objects NOT deep-filled...');

    // Scalar seed keys fill only on `=== undefined`; explicit null survives.
    const nulls = normalizeBotDraft({
        active: null, dryRun: null, minPrice: null, maxPrice: null,
        incrementPercent: null, targetSpreadPercent: null, startPrice: null, gridPrice: null,
    });
    for (const key of [...SCALAR_SEED_KEYS]) {
        assert.strictEqual(nulls[key], null, `draft.${key} must preserve explicit null`);
    }

    // active:false must survive — it is the disable flag.
    assert.strictEqual(normalizeBotDraft({ active: false }).active, false, 'active:false must survive seeding');

    // Partial/empty count objects are kept verbatim (no deep-fill today).
    const partial = normalizeBotDraft({
        weightDistribution: { buy: 7 },
        botFunds: {},
        activeOrders: { sell: 1 },
        reserveOrders: { buy: 2 },
    });
    assert.deepStrictEqual(partial.weightDistribution, { buy: 7 }, 'partial weightDistribution kept (no deep-fill)');
    assert.deepStrictEqual(partial.botFunds, {}, 'empty botFunds kept');
    assert.deepStrictEqual(partial.activeOrders, { sell: 1 }, 'partial activeOrders kept (no deep-fill)');
    assert.deepStrictEqual(partial.reserveOrders, { buy: 2 }, 'partial reserveOrders kept (no deep-fill)');

    // Count-object keys replace on ANY falsy value (not just undefined/null).
    const falsy = normalizeBotDraft({
        weightDistribution: 0,
        botFunds: '',
        activeOrders: false,
    });
    assert.deepStrictEqual(falsy.weightDistribution, { ...DEFAULT_CONFIG.weightDistribution }, 'weightDistribution:0 → default');
    assert.deepStrictEqual(falsy.botFunds, { ...DEFAULT_CONFIG.botFunds }, "botFunds:'' → default");
    assert.deepStrictEqual(falsy.activeOrders, { ...DEFAULT_CONFIG.activeOrders }, 'activeOrders:false → default');
}

function testDraftReserveOrdersMigrations() {
    console.log(' - draft: reserveOrders number migration + invalid replacement...');
    assert.deepStrictEqual(normalizeBotDraft({ reserveOrders: 7 }).reserveOrders, { buy: 7, sell: 0 }, '7 → {buy:7, sell:0}');
    assert.deepStrictEqual(normalizeBotDraft({ reserveOrders: -7 }).reserveOrders, { buy: 0, sell: 0 }, '-7 clamps to 0');
    assert.deepStrictEqual(normalizeBotDraft({ reserveOrders: 2.9 }).reserveOrders, { buy: 2, sell: 0 }, 'floors decimals');
    assert.deepStrictEqual(normalizeBotDraft({ reserveOrders: null }).reserveOrders, { ...DEFAULT_CONFIG.reserveOrders }, 'null → default');
    assert.deepStrictEqual(normalizeBotDraft({ reserveOrders: [] }).reserveOrders, { ...DEFAULT_CONFIG.reserveOrders }, 'array → default');
    assert.deepStrictEqual(normalizeBotDraft({ reserveOrders: 'x' }).reserveOrders, { ...DEFAULT_CONFIG.reserveOrders }, 'string → default');
}

function testDraftGridPriceFollowsDefaultConfig() {
    console.log(' - draft: gridPrice follows a DEFAULT_CONFIG.gridPrice override (Phase 2 fix)...');
    const original = DEFAULT_CONFIG.gridPrice;
    try {
        DEFAULT_CONFIG.gridPrice = 'book';
        assert.strictEqual(
            normalizeBotDraft({}).gridPrice,
            'book',
            'Phase 2 fix: draft gridPrice must be seeded from DEFAULT_CONFIG.gridPrice'
        );
    } finally {
        DEFAULT_CONFIG.gridPrice = original;
    }
    assert.strictEqual(normalizeBotDraft({}).gridPrice, DEFAULT_CONFIG.gridPrice, 'DEFAULT_CONFIG.gridPrice restored → seeded unchanged (ama3 by default)');
}

function testDraftGridPriceUnsetNormalization() {
    console.log(' - draft: unset gridPrice spellings (false, n/no, empty) normalize to null...');

    for (const value of [false, '', '   ', 'none', 'null', 'start', 'startprice', 's', 'n', 'no', 'false', 'f', '0', 'N', 'No', 'FALSE', 'F', 'S']) {
        assert.strictEqual(
            normalizeBotDraft({ gridPrice: value }).gridPrice,
            null,
            `gridPrice:${JSON.stringify(value)} must normalize to null`
        );
    }

    // A real reference is preserved untouched.
    for (const value of ['ama3', 'pool', 'book', 2.5]) {
        assert.strictEqual(
            normalizeBotDraft({ gridPrice: value }).gridPrice,
            value,
            `gridPrice:${JSON.stringify(value)} must survive normalization`
        );
    }
}

function testDraftStartPriceFalsyFallsBackToPool() {
    console.log(' - draft: falsy DEFAULT_CONFIG.startPrice falls back to pool...');
    const original = DEFAULT_CONFIG.startPrice;
    try {
        DEFAULT_CONFIG.startPrice = null;
        assert.strictEqual(normalizeBotDraft({}).startPrice, 'pool', 'falsy default startPrice → pool');
    } finally {
        DEFAULT_CONFIG.startPrice = original;
    }
}

function testEntryNormalization() {
    console.log(' - entry: normalizeBotEntry active default + raw passthrough...');

    // Missing/undefined active → DEFAULT_CONFIG.active (Phase 3: the
    // duplicated copies hardcoded `true`; sourcing it makes an override of
    // DEFAULT_CONFIG.active take effect. Repo settings default is true).
    assert.strictEqual(normalizeBotEntry({ name: 'n' }).active, DEFAULT_CONFIG.active,
        'missing active → DEFAULT_CONFIG.active');
    assert.strictEqual(normalizeBotEntry({ name: 'n', active: false }).active, false, 'active:false preserved');
    assert.strictEqual(normalizeBotEntry({ name: 'n', active: true }).active, true, 'active:true preserved');

    // Present non-boolean values pass through raw (spread wins over the
    // computed default); downstream uses `!== false`. The claw copy used to
    // coerce these with `!!` — Phase 3 unified it to this semantics.
    assert.strictEqual(normalizeBotEntry({ name: 'n', active: null }).active, null,
        'present null passes through raw (shared with claw copy since Phase 3)');
    assert.strictEqual(normalizeBotEntry({ name: 'n', active: 0 }).active, 0,
        'CHARACTERIZATION: present 0 passes through raw');

    const entry = { name: 'x', assetA: 'BTS', assetB: 'USD' };
    const out = normalizeBotEntry(entry, 5);
    assert.ok(!('active' in entry), 'normalizeBotEntry must not mutate its input');
    assert.strictEqual(out.botIndex, 5, 'botIndex stamped from index arg');
    assert.strictEqual(typeof out.botKey, 'string');
    assert.ok(out.botKey.length > 0, 'botKey generated');
    assert.deepStrictEqual(normalizeBotEntry(entry, 5), out, 'normalization is deterministic');

    // Entry normalization seeds NOTHING else: no count objects, no pair keys.
    const bare = normalizeBotEntry({ name: 'bare' }, 0);
    for (const key of [...COUNT_OBJECT_KEYS, 'reserveOrders', ...DRAFT_EXCLUDED_KEYS, ...SCALAR_SEED_KEYS]) {
        if (key === 'active') continue;
        assert.ok(!(key in bare), `normalizeBotEntry must not seed '${key}' (validation relies on key absence)`);
    }
}

function testManagerConfigShape() {
    console.log(' - manager: shallow spread shape + DEFAULT_CONFIG aliasing...');

    const mgr = new OrderManager({});
    assert.deepStrictEqual(mgr.config, DEFAULT_CONFIG, 'empty config → deep-equals DEFAULT_CONFIG');

    // Phase 3: absent nested keys are deep CLONES — never shared references
    // with the global DEFAULT_CONFIG (the historical shallow spread aliased
    // them, so mutating manager.config.botFunds corrupted the default).
    for (const key of [...COUNT_OBJECT_KEYS, 'reserveOrders']) {
        assert.notStrictEqual(mgr.config[key], DEFAULT_CONFIG[key],
            `mgr.config.${key} must be a clone, not an alias of DEFAULT_CONFIG.${key}`);
    }
    const probeBefore = DEFAULT_CONFIG.botFunds.buy;
    mgr.config.botFunds.buy = 999999;
    assert.strictEqual(DEFAULT_CONFIG.botFunds.buy, probeBefore,
        'mutating manager config must not leak into the global DEFAULT_CONFIG');

    // Provided values replace wholesale — no deep-merge of partial objects.
    const providedActiveOrders = { buy: 3 };
    const mgr2 = new OrderManager({ activeOrders: providedActiveOrders, minPrice: '4x' });
    assert.deepStrictEqual(
        mgr2.config,
        { ...DEFAULT_CONFIG, activeOrders: providedActiveOrders, minPrice: '4x' },
        'provided keys replace defaults wholesale; everything else equals DEFAULT_CONFIG'
    );
    assert.deepStrictEqual(mgr2.config.activeOrders, { buy: 3 }, 'partial provided activeOrders NOT deep-filled');
    assert.strictEqual(mgr2.config.activeOrders, providedActiveOrders,
        'provided nested object keeps its reference (spread semantics callers may rely on)');

    // Spread-equivalence: an explicit undefined value overrides the default
    // (key present with undefined), matching `{ ...DEFAULT_CONFIG, ...config }`.
    const mgr3 = new OrderManager({ minPrice: undefined });
    assert.ok('minPrice' in mgr3.config, 'explicit-undefined key stays present');
    assert.strictEqual(mgr3.config.minPrice, undefined,
        'CHARACTERIZATION: explicit undefined wins over default (spread semantics)');

    // Extra runtime keys pass through untouched.
    const mgr4 = new OrderManager({ logFile: '/tmp/x.log', botKey: 'k1', customFlag: 42 });
    assert.strictEqual(mgr4.config.logFile, '/tmp/x.log', 'logFile passes through');
    assert.strictEqual(mgr4.config.botKey, 'k1', 'botKey passes through');
    assert.strictEqual(mgr4.config.customFlag, 42, 'unknown keys pass through');
}

function testWhitelistFlagDefaults() {
    console.log(' - whitelist: default flag shapes (missing file, array, true, partial, garbage)...');

    removeWhitelist();
    assert.deepStrictEqual(getWhitelistFlags('anything'), ALL_FALSE, 'no file → all flags false');

    writeWhitelist({ whitelist: ['legacy-a', 'legacy-b'] });
    assert.deepStrictEqual(getWhitelistFlags('legacy-a'), AMA_ONLY, 'legacy array entry → ama-only');
    assert.deepStrictEqual(getWhitelistFlags('legacy-b'), AMA_ONLY, 'legacy array entry → ama-only');

    writeWhitelist({ whitelist: { truthy: true, partial: { ama: true } } });
    assert.deepStrictEqual(getWhitelistFlags('truthy'), ALL_TRUE, 'entry:true → all flags true');
    assert.deepStrictEqual(getWhitelistFlags('partial'), AMA_ONLY, 'partial object → missing flags false');
    assert.deepStrictEqual(getWhitelistFlags('never-written'), ALL_FALSE, 'missing key → all flags false');

    writeWhitelist({ whitelist: { garbage: { ama: 'yes', dynamicWeight: 1 } } });
    assert.deepStrictEqual(getWhitelistFlags('garbage'), ALL_FALSE, 'non-boolean flags coerce with === true → false');

    writeWhitelist('{{{ not json');
    assert.deepStrictEqual(getWhitelistFlags('anything'), ALL_FALSE, 'malformed file → all flags false (fail closed)');
}

function main() {
    testDraftSnapshot();
    testDraftDoesNotMutateInputAndPassesThroughExtraKeys();
    testDraftPreservesNullsAndPartials();
    testDraftReserveOrdersMigrations();
    testDraftGridPriceFollowsDefaultConfig();
    testDraftGridPriceUnsetNormalization();
    testDraftStartPriceFalsyFallsBackToPool();
    testEntryNormalization();
    testManagerConfigShape();
    testWhitelistFlagDefaults();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    console.log('bot defaults characterization tests passed');
}

main();
