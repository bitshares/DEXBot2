'use strict';

// Regression tests for scripts/update_dist_freshness.ts.
//
// `dist/` is gitignored, so only the TypeScript build reconciles it. The
// updater must be able to tell when dist/ lags its sources *without* invoking
// the compiler, otherwise it reports "up to date" and never rebuilds (the
// stale `dist/dexbot.js` alias bug). These cases pin that detection.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    REQUIRED_DIST_ENTRIES,
    collectCompiledSources,
    findMissingDistEntries,
    inspectDistBundle,
} = require('../scripts/update_dist_freshness');

const BUILD_DIR = 'dist';

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-dist-freshness-'));
}

function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/** Create the minimum bundle that inspectDistBundle considers complete. */
function seedCompleteDist(root) {
    for (const rel of REQUIRED_DIST_ENTRIES) {
        writeFile(path.join(root, BUILD_DIR, rel), '// compiled\n');
    }
}

/** Seed a source file and its dist counterpart, with dist newer than src. */
function seedFreshPair(root, rel) {
    const src = path.join(root, rel);
    const dist = path.join(root, BUILD_DIR, rel.replace(/\.ts$/, '.js'));
    writeFile(src, 'export const x = 1;\n');
    writeFile(dist, 'export const x = 1;\n');
    const base = Date.now() / 1000 - 5;
    fs.utimesSync(src, base, base);
    fs.utimesSync(dist, base + 2, base + 2);
    return { src, dist };
}

function testCompleteFreshBundleNeedsNoRebuild() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        seedFreshPair(root, path.join('modules', 'sample.ts'));
        const status = inspectDistBundle(root, BUILD_DIR);
        assert.strictEqual(status.needsRebuild, false, `expected fresh, got: ${status.reason}`);
        assert.strictEqual(status.reason, '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testMissingRequiredEntryIsFlagged() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        fs.rmSync(path.join(root, BUILD_DIR, 'dexbot.js'));
        const status = inspectDistBundle(root, BUILD_DIR);
        assert.strictEqual(status.needsRebuild, true);
        assert.ok(status.reason.includes('dexbot.js'), `reason should name the file: ${status.reason}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testMissingCounterpartIsFlagged() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        writeFile(path.join(root, 'modules', 'orphan.ts'), 'export const y = 2;\n');
        const status = inspectDistBundle(root, BUILD_DIR);
        assert.strictEqual(status.needsRebuild, true);
        assert.ok(status.reason.includes('orphan'), `reason should name the source: ${status.reason}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testSourceNewerThanDistIsFlagged() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        const { src, dist } = seedFreshPair(root, path.join('modules', 'changed.ts'));
        const base = Date.now() / 1000;
        fs.utimesSync(dist, base - 10, base - 10); // dist older
        fs.utimesSync(src, base, base);            // src newer
        const status = inspectDistBundle(root, BUILD_DIR);
        assert.strictEqual(status.needsRebuild, true);
        assert.ok(status.reason.includes('changed.ts'), `reason should name the source: ${status.reason}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testRootEntrypointIsCovered() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        const { src, dist } = seedFreshPair(root, 'dexbot.ts');
        const base = Date.now() / 1000;
        fs.utimesSync(dist, base - 10, base - 10);
        fs.utimesSync(src, base, base);
        const status = inspectDistBundle(root, BUILD_DIR);
        assert.strictEqual(status.needsRebuild, true, 'root-level .ts files must be compared, not just modules/**');
        assert.ok(status.reason.includes('dexbot.ts'), `reason should name dexbot.ts: ${status.reason}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testNestedNodeModulesAndDeclarationsAreIgnored() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        seedFreshPair(root, path.join('modules', 'ok.ts'));
        // None of these are compiled by the root tsc, so none may mark the bundle stale.
        writeFile(path.join(root, 'modules', 'node_modules', 'pkg', 'vendor.ts'), 'export const v = 1;\n');
        writeFile(path.join(root, 'modules', 'types.d.ts'), 'export declare const t: number;\n');
        writeFile(path.join(root, 'tests', 'ignored.ts'), 'export const i = 1;\n');
        const status = inspectDistBundle(root, BUILD_DIR);
        assert.strictEqual(status.needsRebuild, false, `non-compiled files must be ignored, got: ${status.reason}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testCollectCompiledSourcesShape() {
    const root = makeRoot();
    try {
        writeFile(path.join(root, 'dexbot.ts'), 'export const a = 1;\n');
        writeFile(path.join(root, 'modules', 'nested', 'deep.ts'), 'export const b = 2;\n');
        writeFile(path.join(root, 'modules', 'skip.d.ts'), 'export declare const c: number;\n');
        writeFile(path.join(root, 'profiles', 'ignored.ts'), 'export const d = 4;\n');
        const collected = collectCompiledSources(root, BUILD_DIR).map((c) => path.relative(root, c.src)).sort();
        assert.deepStrictEqual(collected, ['dexbot.ts', path.join('modules', 'nested', 'deep.ts')]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testTsconfigExcludedSourcesAreIgnored() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        seedFreshPair(root, path.join('modules', 'ok.ts'));
        // The updater must mirror the compiler's exclude: a source the root build
        // skips (here an arbitrary excluded dir) has no dist counterpart and must
        // not mark the bundle stale.
        writeFile(
            path.join(root, 'tsconfig.json'),
            JSON.stringify({ exclude: ['node_modules', 'dist', 'profiles', 'tests', 'analysis/excluded'] })
        );
        writeFile(path.join(root, 'analysis', 'excluded', 'not-built.ts'), 'export const n = 1;\n');
        const status = inspectDistBundle(root, BUILD_DIR);
        assert.strictEqual(status.needsRebuild, false, `tsconfig-excluded sources must be ignored, got: ${status.reason}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function testFindMissingDistEntriesReportsRelativePaths() {
    const root = makeRoot();
    try {
        seedCompleteDist(root);
        fs.rmSync(path.join(root, BUILD_DIR, 'bot.js'));
        fs.rmSync(path.join(root, BUILD_DIR, 'unlock.js'));
        assert.deepStrictEqual(
            findMissingDistEntries(root, BUILD_DIR).sort(),
            ['bot.js', 'unlock.js']
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function main() {
    testCompleteFreshBundleNeedsNoRebuild();
    testMissingRequiredEntryIsFlagged();
    testMissingCounterpartIsFlagged();
    testSourceNewerThanDistIsFlagged();
    testRootEntrypointIsCovered();
    testNestedNodeModulesAndDeclarationsAreIgnored();
    testCollectCompiledSourcesShape();
    testTsconfigExcludedSourcesAreIgnored();
    testFindMissingDistEntriesReportsRelativePaths();
    console.log('update dist freshness tests passed');
}

main();
