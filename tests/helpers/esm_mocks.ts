'use strict';

/**
 * ESM module mocking for compiled tests.
 *
 * Under plain node (no tsx) there is no require.cache interception: ESM
 * graphs resolve through the module loader and namespaces are frozen. This
 * helper restores mock capability with the supported customization-hooks API:
 *
 *   1. On first execution the test re-execs itself with `--import` hooks
 *      (esm_mock_hooks.mjs) and forwards the child's exit code.
 *   2. defineEsmMock(relPath, names, exportsObject) registers a mock. The
 *      loader manifest maps the module's absolute path to a generated stub
 *      that evaluates in the main thread, so mock functions record calls
 *      into the very object the test holds for assertions. Named imports in
 *      consumers are satisfied by synthetic re-exports built from `names`.
 *
 * Usage at the top of a test file:
 *   const { esmMockEntry, defineEsmMock } = require('../helpers/esm_mocks');
 *   esmMockEntry();                      // re-execs once, then returns
 *   const infraMock = { createClawInfrastructure: (o) => {...} };
 *   defineEsmMock('claw/modules/claw_infra.js', ['createClawInfrastructure'], infraMock);
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOOKS_FILE = fs.realpathSync(path.join(__dirname, 'esm_mock_hooks.mjs'));
const ENV_ACTIVE = 'DEXBOT_ESM_MOCKS_ACTIVE';
const ENV_MANIFEST = 'DEXBOT_ESM_MOCK_MANIFEST';
const ENV_STAGE = 'DEXBOT_ESM_MOCK_STAGE';

function repoRoot() {
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        dir = path.dirname(dir);
    }
    throw new Error('Unable to locate repo root for esm mocks');
}

function tmpDir(sub) {
    const dir = path.join(repoRoot(), 'tests', 'tmp', sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function manifestPathFor(entryFile, suffix = '') {
    const stamp = path.basename(entryFile).replace(/\W+/g, '_');
    const tail = suffix ? `-${suffix}` : '';
    return path.join(tmpDir('esm-mock-manifests'), `${stamp}-${process.pid}${tail}.json`);
}

function readManifest(manifestPath) {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return {};
    }
}

function writeManifest(manifestPath, manifest) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Entry guard for tests using ESM mocks. When hooks are not yet active,
 * spawns a hooked child running this same file and exits with its status.
 */
function esmMockEntry() {
    if (process.env[ENV_ACTIVE] === '1' && process.env[ENV_MANIFEST]) return;

    const entryFile = fs.realpathSync(path.resolve(process.argv[1] || ''));
    const manifestPath = manifestPathFor(entryFile);
    writeManifest(manifestPath, {});

    const env: Record<string, string | undefined> = {
        ...process.env,
        [ENV_ACTIVE]: '1',
        [ENV_MANIFEST]: manifestPath,
    };
    const stage = process.env[ENV_STAGE];
    if (stage) env[ENV_STAGE] = stage;

    const child = spawnSync(process.execPath, ['--import', HOOKS_FILE, entryFile], {
        stdio: 'inherit',
        env,
        cwd: repoRoot(),
    });

    try { fs.rmSync(manifestPath, { force: true }); } catch { /* best effort */ }
    process.exit(child.status === null ? 1 : child.status);
}

/**
 * Stage runner for test files whose harnesses mock the same module with
 * different sets across tests: ESM caches modules per process, so each stage
 * runs in its own hooked child. In the parent, spawns one child per stage and
 * forwards the first failing exit code; in a hooked child, executes only the
 * requested stage.
 *
 * Stages are independent, so they run with bounded concurrency (default 4,
 * override with DEXBOT_ESM_STAGE_CONCURRENCY=1 for the old sequential
 * behaviour). Each stage gets its own manifest and stub files (keyed by PID)
 * so parallel children never clobber one another.
 */
function resolveStageConcurrency(stageCount) {
    const raw = Number(process.env.DEXBOT_ESM_STAGE_CONCURRENCY);
    const configured = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
    return Math.max(1, Math.min(configured, stageCount));
}

function runEsmMockStages(stages, runStage) {
    if (process.env[ENV_ACTIVE] === '1' && process.env[ENV_MANIFEST]) {
        const stage = process.env[ENV_STAGE] || stages[0];
        Promise.resolve(runStage(stage)).then(
            () => process.exit(0),
            (err) => {
                console.error(err);
                process.exit(1);
            }
        );
        return;
    }

    const entryFile = fs.realpathSync(path.resolve(process.argv[1] || ''));
    const concurrency = resolveStageConcurrency(stages.length);

    if (concurrency <= 1) {
        let exitCode = 0;
        for (const stage of stages) {
            process.stdout.write(`\n=== [STAGE] ${stage} ===\n`);
            const manifestPath = manifestPathFor(entryFile);
            writeManifest(manifestPath, {});
            const child = spawnSync(process.execPath, ['--import', HOOKS_FILE, entryFile], {
                stdio: 'inherit',
                env: {
                    ...process.env,
                    [ENV_ACTIVE]: '1',
                    [ENV_MANIFEST]: manifestPath,
                    [ENV_STAGE]: stage,
                },
                cwd: repoRoot(),
            });
            try { fs.rmSync(manifestPath, { force: true }); } catch { /* best effort */ }
            if (child.status !== 0) {
                exitCode = child.status === null ? 1 : child.status;
                break;
            }
        }
        process.exit(exitCode);
    }

    // Parallel path: one child per stage, bounded by `concurrency`. The parent
    // stays alive on the child handles and exits once every worker settles.
    const spawnStage = (stage, index) =>
        new Promise<number>((resolve) => {
            const manifestPath = manifestPathFor(
                entryFile,
                `${index}-${Math.random().toString(36).slice(2, 8)}`
            );
            writeManifest(manifestPath, {});
            const child = spawn(process.execPath, ['--import', HOOKS_FILE, entryFile], {
                stdio: 'inherit',
                env: {
                    ...process.env,
                    [ENV_ACTIVE]: '1',
                    [ENV_MANIFEST]: manifestPath,
                    [ENV_STAGE]: stage,
                },
                cwd: repoRoot(),
            });
            const settle = (code: number | null) => {
                try { fs.rmSync(manifestPath, { force: true }); } catch { /* best effort */ }
                resolve(code === null ? 1 : code);
            };
            child.on('close', settle);
            child.on('error', () => settle(1));
        });

    let next = 0;
    let exitCode = 0;
    let abort = false;
    const worker = async () => {
        while (!abort) {
            const index = next++;
            if (index >= stages.length) return;
            const stage = stages[index];
            process.stdout.write(`\n=== [STAGE] ${stage} ===\n`);
            const code = await spawnStage(stage, index);
            if (code !== 0) {
                abort = true;
                exitCode = code;
                return;
            }
        }
    };
    Promise.all(Array.from({ length: concurrency }, worker)).then(() => process.exit(exitCode));
}

function stubFileFor(absTarget) {
    const stamp = absTarget.replace(/[^A-Za-z0-9._-]+/g, '__');
    return path.join(tmpDir('esm-mock-stubs'), `${stamp}-${process.pid}.cjs`);
}

/**
 * Register a mock for a module by absolute path (as produced by
 * require.resolve in the compiled test). See defineEsmMock for details.
 */
function defineEsmMockAbs(absPath, names, exportsValue) {
    const manifestPath = process.env[ENV_MANIFEST];
    if (!manifestPath) {
        throw new Error('defineEsmMockAbs called before esmMockEntry()/runEsmMockStages()');
    }

    const stubPath = stubFileFor(absPath);
    fs.writeFileSync(
        stubPath,
        '\'use strict\';\nmodule.exports = globalThis.__DEXBOT_ESM_MOCKS__[' + JSON.stringify(absPath) + '];\n'
    );

    globalThis.__DEXBOT_ESM_MOCKS__ = globalThis.__DEXBOT_ESM_MOCKS__ || {};
    globalThis.__DEXBOT_ESM_MOCKS__[absPath] = exportsValue;

    const manifest = readManifest(manifestPath);
    manifest[absPath] = { stub: stubPath, names: names.slice() };
    writeManifest(manifestPath, manifest);

    return exportsValue;
}

/**
 * Register a mock for a module given its repo-relative specifier (the
 * compiled .js path is derived automatically; a source-tree variant is also
 * mapped when it exists so either resolution matches).
 *
 * `names` must list every export consumers import by name; they become
 * synthetic named re-exports. The returned value is the same exportsObject
 * the mocked modules will see.
 */
function defineEsmMock(relPath, names, exportsValue) {
    const root = repoRoot();
    const absSource = path.resolve(root, relPath);
    const absDist = absSource.startsWith(root + path.sep + 'dist' + path.sep)
        ? absSource
        : path.join(root, 'dist', relPath);

    const result = defineEsmMockAbs(absDist, names, exportsValue);
    if (fs.existsSync(absSource)) {
        globalThis.__DEXBOT_ESM_MOCKS__[absSource] = exportsValue;
        const manifestPath = process.env[ENV_MANIFEST];
        const manifest = readManifest(manifestPath);
        manifest[absSource] = { stub: stubFileFor(absDist), names: names.slice() };
        writeManifest(manifestPath, manifest);
    }
    return result;
}

module.exports = { esmMockEntry, runEsmMockStages, defineEsmMock, defineEsmMockAbs };
