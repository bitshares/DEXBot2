'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Config snapshots process.env at module load — set the whitelist override
// BEFORE the first project require() so these tests never touch the real
// profiles/market_adapter_whitelist.json.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-adapter-flags-'));
const WHITELIST_FILE = path.join(TEMP_DIR, 'market_adapter_whitelist.json');
process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = WHITELIST_FILE;

const { parseBooleanInput, colorGridPriceValue, formatPoolRefLabel, isPoolStartPrice, isPoolRefClearInput, resolveAdapterCommitPlan, sameAdapterFlags } = require('../modules/account_bots');
const { CLI_COLORS } = require('../modules/cli_colors');
const {
    setWhitelistFlags,
    renameWhitelistEntry,
    removeWhitelistEntry,
    getWhitelistFlags,
    resetMarketAdapterWhitelistCache,
} = require('../modules/market_adapter_whitelist');

function writeDoc(doc) {
    fs.writeFileSync(WHITELIST_FILE, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n', 'utf8');
    // Raw fs writes bypass the module's own write path, so refresh its cache.
    resetMarketAdapterWhitelistCache();
}

function readDoc() {
    return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
}

function testParseBooleanInputAcceptsYesSpellings() {
    for (const raw of ['y', 'Y', 'yes', 'YES', 'true', 'TRUE', '1', 't', ' T ']) {
        const parsed = parseBooleanInput(raw, false);
        assert.strictEqual(parsed.ok, true, `'${raw}' should be recognized`);
        assert.strictEqual(parsed.value, true, `'${raw}' should parse as true`);
    }
}

function testParseBooleanInputAcceptsNoSpellings() {
    for (const raw of ['n', 'N', 'no', 'NO', 'false', 'FALSE', '0', 'f']) {
        const parsed = parseBooleanInput(raw, true);
        assert.strictEqual(parsed.ok, true, `'${raw}' should be recognized`);
        assert.strictEqual(parsed.value, false, `'${raw}' should parse as false`);
    }
}

function testParseBooleanInputKeepsDefaultAndRejectsGarbage() {
    assert.strictEqual(parseBooleanInput('', true).value, true, 'empty input keeps a true default');
    assert.strictEqual(parseBooleanInput('   ', false).value, false, 'blank input keeps a false default');
    assert.strictEqual(parseBooleanInput('maybe', true).ok, false, 'unknown words must be rejected');
    assert.strictEqual(parseBooleanInput('2', true).ok, false, 'unlisted numbers must be rejected');
    assert.strictEqual(parseBooleanInput(true as any, false).value, true, 'boolean input coerces via String()');
}

function testSetWhitelistFlagsRoundTrip() {
    writeDoc({ whitelist: {}, meta: { keep: 1 } });

    assert.strictEqual(setWhitelistFlags('bot-a', { ama: true }), true);
    assert.deepStrictEqual(
        getWhitelistFlags('bot-a'),
        { ama: true, dynamicWeight: false, asymmetricBounds: false },
        'Price-only entry should round-trip through the file'
    );

    // Partial update must keep the flags it does not mention.
    assert.strictEqual(setWhitelistFlags('bot-a', { asymmetricBounds: true }), true);
    assert.deepStrictEqual(
        getWhitelistFlags('bot-a'),
        { ama: true, dynamicWeight: false, asymmetricBounds: true },
        'omitted flags keep their current value'
    );

    // Explicit all-off keeps a protective entry so the bot stays explicitly
    // disabled rather than falling back to absent/default flags.
    assert.strictEqual(setWhitelistFlags('bot-a', { ama: false, dynamicWeight: false, asymmetricBounds: false }), true);
    const doc = readDoc();
    assert.deepStrictEqual(doc.whitelist['bot-a'], { ama: false, dynamicWeight: false, asymmetricBounds: false });
    assert.strictEqual(doc.meta.keep, 1, 'unrelated top-level keys survive the write');
    assert.strictEqual(setWhitelistFlags('', { ama: true }), false, 'empty botKey must refuse to write');
}

function testLegacyArrayFormUpgrade() {
    writeDoc({ whitelist: ['legacy-bot'] });
    assert.deepStrictEqual(
        getWhitelistFlags('legacy-bot'),
        { ama: true, dynamicWeight: false, asymmetricBounds: false },
        'legacy array entries stay readable before any write'
    );

    assert.strictEqual(setWhitelistFlags('bot-b', { asymmetricBounds: true }), true);
    const doc = readDoc();
    assert.ok(!Array.isArray(doc.whitelist), 'legacy array form is upgraded to the object form');
    assert.deepStrictEqual(doc.whitelist['legacy-bot'], { ama: true, dynamicWeight: false, asymmetricBounds: false });
    assert.deepStrictEqual(doc.whitelist['bot-b'], { ama: false, dynamicWeight: false, asymmetricBounds: true });
    assert.deepStrictEqual(Object.keys(doc.whitelist), ['bot-b', 'legacy-bot'], 'keys stay sorted on write');
}

function testMalformedFileIsNeverOverwritten() {
    writeDoc('{ not json');
    const before = fs.readFileSync(WHITELIST_FILE, 'utf8');
    assert.strictEqual(setWhitelistFlags('bot-c', { ama: true }), false, 'malformed file must abort the write');
    assert.strictEqual(renameWhitelistEntry('a', 'b'), false, 'malformed file must abort the rename');
    assert.strictEqual(fs.readFileSync(WHITELIST_FILE, 'utf8'), before, 'malformed file left untouched');
}

function testRenameWhitelistEntry() {
    const entry = { ama: true, dynamicWeight: true, asymmetricBounds: false };
    writeDoc({ whitelist: { 'old-name': entry } });

    assert.strictEqual(renameWhitelistEntry('old-name', 'new-name'), true);
    let doc = readDoc();
    assert.strictEqual(doc.whitelist['old-name'], undefined, 'old key removed after rename');
    assert.deepStrictEqual(doc.whitelist['new-name'], entry, 'entry moved with its flags intact');

    // Renaming a bot that has no entry is a no-op, not an error.
    assert.strictEqual(renameWhitelistEntry('ghost', 'ghost-2'), true);

    // A key collision must never destroy the occupant's flags.
    writeDoc({ whitelist: { taken: { ama: false, dynamicWeight: false, asymmetricBounds: false }, other: entry } });
    assert.strictEqual(renameWhitelistEntry('other', 'taken'), false, 'occupied target refuses the move');
    assert.strictEqual(renameWhitelistEntry('ghost', 'taken'), false, 'occupied target refuses even when the source entry is missing');
    doc = readDoc();
    assert.deepStrictEqual(doc.whitelist.taken, { ama: false, dynamicWeight: false, asymmetricBounds: false }, 'occupant keeps its flags');
    assert.deepStrictEqual(doc.whitelist.other, entry, 'source entry is left in place');
}

function testRemoveWhitelistEntry() {
    writeDoc({
        whitelist: {
            'bot-a': { ama: true, dynamicWeight: true, asymmetricBounds: true },
            'bot-b': { ama: true, dynamicWeight: false, asymmetricBounds: false },
        },
        meta: { keep: 1 },
    });

    assert.strictEqual(removeWhitelistEntry('bot-a'), true);
    const doc = readDoc();
    assert.strictEqual(doc.whitelist['bot-a'], undefined, 'deleted bot entry is wiped from the whitelist');
    assert.deepStrictEqual(doc.whitelist['bot-b'], { ama: true, dynamicWeight: false, asymmetricBounds: false }, 'other entries survive the delete');
    assert.strictEqual(doc.meta.keep, 1, 'unrelated top-level keys survive the removal');

    // Missing key and empty key are no-ops, not errors.
    assert.strictEqual(removeWhitelistEntry('ghost'), true, 'missing entry is a no-op');
    assert.strictEqual(removeWhitelistEntry(''), true, 'empty key is a no-op');

    // A malformed file must abort the write, exactly like set/rename.
    writeDoc('{ not json');
    const before = fs.readFileSync(WHITELIST_FILE, 'utf8');
    assert.strictEqual(removeWhitelistEntry('bot-b'), false, 'malformed file must abort the removal');
    assert.strictEqual(fs.readFileSync(WHITELIST_FILE, 'utf8'), before, 'malformed file left untouched');
}

function testGridPriceUnsetRendersRedStartPrice() {
    const redStart = `${CLI_COLORS.boldRed}startPrice${CLI_COLORS.reset}`;
    for (const value of [null, undefined, false, '', '   ', 'none', 'null', 'start', 's', 'n', 'no', 'f', '0', 'N', 'No', 'FALSE', 'F', 'S']) {
        assert.strictEqual(
            colorGridPriceValue(value),
            redStart,
            `gridPrice ${JSON.stringify(value)} must render as red startPrice`
        );
    }
    assert.strictEqual(colorGridPriceValue('ama3'), `${CLI_COLORS.buy}ama3${CLI_COLORS.reset}`, 'AMA renders green');
    assert.strictEqual(colorGridPriceValue('pool'), `${CLI_COLORS.boldRed}pool${CLI_COLORS.reset}`, 'pool renders red (discouraged market-price anchoring)');
    assert.strictEqual(colorGridPriceValue('book'), `${CLI_COLORS.boldRed}book${CLI_COLORS.reset}`, 'book renders red (discouraged market-price anchoring)');
    assert.strictEqual(colorGridPriceValue(2.5), `${CLI_COLORS.boldRed}2.5${CLI_COLORS.reset}`, 'numeric renders red');
}

function testFormatPoolRefLabel() {
    const greenDefault = `${CLI_COLORS.buy}default${CLI_COLORS.reset}`;
    const greyNone = `${CLI_COLORS.silver}none${CLI_COLORS.reset}`;

    assert.strictEqual(formatPoolRefLabel({ startPrice: 'pool' }), greenDefault, 'auto pool (startPrice=pool) renders green default');
    assert.strictEqual(formatPoolRefLabel({ startPrice: 'POOL' }), greenDefault, 'pool detection is case-insensitive');
    assert.strictEqual(formatPoolRefLabel({ startPrice: 'ama3', gridPrice: 'pool' }), greyNone, 'gridPrice=pool alone does NOT get a green default pool label (discouraged anchoring)');
    assert.strictEqual(formatPoolRefLabel({ startPrice: 'ama3', gridPrice: 'book' }), greyNone, 'gridPrice=book is not a pool source');
    assert.strictEqual(formatPoolRefLabel({ startPrice: 1.5, gridPrice: 'ama3' }), greyNone, 'no pool source renders grey none');
    assert.strictEqual(formatPoolRefLabel({ startPrice: 'book' }), greyNone, 'book is not a pool source');
    assert.strictEqual(formatPoolRefLabel({ startPrice: 'pool', poolRef: '1.19.48' }), '1.19.48', 'a pinned pool id wins over the default label');
    assert.strictEqual(formatPoolRefLabel({ startPrice: 'book', poolRef: '1.19.48' }), `${CLI_COLORS.silver}ignored${CLI_COLORS.reset}`, 'a dormant pin renders grey ignored when startPrice is not pool');
}

function testIsPoolStartPrice() {
    assert.strictEqual(isPoolStartPrice('pool'), true, 'pool selects the default pool');
    assert.strictEqual(isPoolStartPrice('POOL'), true, 'pool detection is case-insensitive');
    assert.strictEqual(isPoolStartPrice('  pool  '), true, 'pool detection trims whitespace');
    assert.strictEqual(isPoolStartPrice('book'), false, 'book is not a pool source');
    assert.strictEqual(isPoolStartPrice(1.5), false, 'a numeric startPrice is not a pool source');
    assert.strictEqual(isPoolStartPrice(undefined), false, 'unset startPrice is not a pool source');
}

function testIsPoolRefClearInput() {
    for (const raw of ['none', 'clear', 'off', 'no', 'default', 'pool', 'auto', 'DEFAULT', ' Default ']) {
        assert.strictEqual(isPoolRefClearInput(raw), true, `'${raw}' should clear the poolRef pin`);
    }
    for (const raw of ['48', '1.19.48', '1.19.', 'garbage', '', undefined]) {
        assert.strictEqual(isPoolRefClearInput(raw), false, `'${raw}' must not be treated as a clear alias`);
    }
}

function testResolveAdapterCommitPlan() {
    const plan = (baseKey, newKey, isCopy) => resolveAdapterCommitPlan({ baseKey, newKey, isCopy });

    // New bot: no source, so nothing to move; compare/write the new key.
    assert.deepStrictEqual(plan('', 'alpha', false), { renameFrom: null, compareKey: 'alpha', writeKey: 'alpha' });
    // Modify without a rename keeps the same key.
    assert.deepStrictEqual(plan('alpha', 'alpha', false), { renameFrom: null, compareKey: 'alpha', writeKey: 'alpha' });
    // Modify with a rename moves the entry and compares the pre-move source.
    assert.deepStrictEqual(plan('alpha', 'beta', false), { renameFrom: 'alpha', compareKey: 'alpha', writeKey: 'beta' });
    // Copy must NEVER move the source entry; it compares/writes the copy key.
    assert.deepStrictEqual(plan('alpha', 'beta', true), { renameFrom: null, compareKey: 'beta', writeKey: 'beta' });
    // Copy to an empty key is degenerate but must still not move anything.
    assert.deepStrictEqual(plan('alpha', '', true), { renameFrom: null, compareKey: '', writeKey: '' });
    // A renamed bot with an empty new key can not move anywhere.
    assert.deepStrictEqual(plan('alpha', '', false), { renameFrom: null, compareKey: 'alpha', writeKey: '' });
}

function testSameAdapterFlags() {
    const reference = { ama: true, dynamicWeight: false, asymmetricBounds: true };
    assert.strictEqual(sameAdapterFlags(reference, { ...reference }), true, 'identical flag sets match');
    assert.strictEqual(sameAdapterFlags(reference, { ...reference, ama: false }), false, 'ama difference is detected');
    assert.strictEqual(sameAdapterFlags(reference, { ...reference, dynamicWeight: true }), false, 'weight difference is detected');
    assert.strictEqual(sameAdapterFlags(reference, { ...reference, asymmetricBounds: false }), false, 'range difference is detected');
}

// Regression: a copy used to be treated as a rename, which moved (and deleted)
// the source bot's whitelist entry. Drive the same primitive sequence the editor
// commit hook uses and assert the source is never touched.
function testCopyCommitRetainsSourceEntry() {
    const sourceFlags = { ama: true, dynamicWeight: true, asymmetricBounds: false };
    writeDoc({ whitelist: { source: sourceFlags } });

    const plan = resolveAdapterCommitPlan({ baseKey: 'source', newKey: 'target', isCopy: true });
    assert.strictEqual(plan.renameFrom, null, 'a copy must never arm a whitelist rename');

    const desired = getWhitelistFlags('source');
    const unchanged = sameAdapterFlags(desired, getWhitelistFlags(plan.compareKey));
    if (!unchanged) assert.strictEqual(setWhitelistFlags(plan.writeKey, desired), true);

    const doc = readDoc();
    assert.deepStrictEqual(doc.whitelist.source, sourceFlags, 'source entry survives the copy');
    assert.deepStrictEqual(doc.whitelist.target, sourceFlags, 'copy receives the source flags under its own key');
}

function main() {
    console.log('Running account bot adapter flag tests');
    testParseBooleanInputAcceptsYesSpellings();
    testParseBooleanInputAcceptsNoSpellings();
    testParseBooleanInputKeepsDefaultAndRejectsGarbage();
    testGridPriceUnsetRendersRedStartPrice();
    testFormatPoolRefLabel();
    testIsPoolStartPrice();
    testIsPoolRefClearInput();
    testSetWhitelistFlagsRoundTrip();
    testLegacyArrayFormUpgrade();
    testMalformedFileIsNeverOverwritten();
    testRenameWhitelistEntry();
    testRemoveWhitelistEntry();
    testResolveAdapterCommitPlan();
    testSameAdapterFlags();
    testCopyCommitRetainsSourceEntry();
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    console.log('account bot adapter flag tests passed');
}

main();
