'use strict';

/**
 * Regression guard for `dexbot rich <asset...>`.
 *
 * BitShares `lookup_asset_symbols` is case-sensitive: a lowercase symbol
 * resolves to null, so `dexbot rich asset.sym` silently reported "asset not
 * found" while `ASSET.SYM` worked. The script must canonicalize every symbol
 * at the chain boundary (see scripts/rich_list.ts lookupSymbols) while still
 * echoing the caller's original spelling in the result row.
 */

const assert = require('assert');

console.log('Running rich-list symbol normalization tests');

const { lookupSymbols, fetchAssets } = require('../scripts/rich_list');

/** Minimal Session stub that records the refs handed to lookup_asset_symbols. */
function makeSession(resolve: (ref: string) => unknown) {
    const calls: string[][] = [];
    return {
        calls,
        session: {
            assetApi: 1,
            dbApi: 0,
            holderLimit: 100,
            client: {
                call: async (_api: number, method: string, args: unknown[]) => {
                    assert.strictEqual(method, 'lookup_asset_symbols', 'only symbol lookups are stubbed');
                    const refs = args[0] as string[];
                    calls.push([...refs]);
                    return refs.map(resolve);
                },
            },
        },
    };
}

(async () => {
    // ── lowercase symbol reaches the chain UPPERCASE ──────────────────────────
    {
        const { session, calls } = makeSession((ref) =>
            ref === 'ASSET.SYM' ? { id: '1.3.999', symbol: 'ASSET.SYM', precision: 6 } : null);
        const out = await lookupSymbols(session as never, ['asset.sym']);
        assert.deepStrictEqual(calls, [['ASSET.SYM']], 'lowercase symbol is uppercased before the chain call');
        assert.strictEqual(out[0].found, true, 'lowercase symbol resolves after normalization');
        assert.strictEqual(out[0].request, 'asset.sym', 'original request spelling is preserved for reporting');
        assert.strictEqual(out[0].symbol, 'ASSET.SYM', 'canonical symbol comes back from the chain');
    }

    // ── asset object ids pass through untouched ───────────────────────────────
    {
        const { session, calls } = makeSession((ref) =>
            ref === '1.3.999' ? { id: '1.3.999', symbol: 'ASSET.SYM', precision: 6 } : null);
        const out = await lookupSymbols(session as never, ['1.3.999']);
        assert.deepStrictEqual(calls, [['1.3.999']], 'object id is not rewritten');
        assert.strictEqual(out[0].found, true, 'object id resolves');
    }

    // ── unknown asset stays reported against the caller's spelling ────────────
    {
        const { session } = makeSession(() => null);
        const out = await lookupSymbols(session as never, ['nope.nope']);
        assert.strictEqual(out[0].found, false, 'unknown asset reports not-found');
        assert.strictEqual(out[0].request, 'nope.nope', 'not-found keeps the user spelling');
    }

    // ── legacy `bit*` alias retry also normalizes its stripped symbol ─────────
    {
        const { session, calls } = makeSession((ref) =>
            ref === 'FOO' ? { id: '1.3.998', symbol: 'FOO', precision: 4 } : null);
        const out = await fetchAssets(session as never, ['bitfoo']);
        assert.deepStrictEqual(calls, [['BITFOO'], ['FOO']], 'alias retry uppercases the stripped symbol too');
        assert.strictEqual(out[0].found, true, 'renamed MPA resolves via retry');
        assert.strictEqual(out[0].request, 'bitfoo', 'aliased request keeps original spelling');
        assert.strictEqual(out[0].alias, 'bitfoo', 'original request recorded as alias');
        assert.strictEqual(out[0].symbol, 'FOO', 'renamed symbol reported');
    }

    console.log('All rich-list symbol normalization tests passed');
})().catch((e: any) => {
    console.error(e);
    process.exit(1);
});
