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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker, threadId } = require('worker_threads');

const HOOKS_FILE = fs.realpathSync(path.join(__dirname, 'esm_mock_hooks.mjs'));
const ENV_ACTIVE = 'DEXBOT_ESM_MOCKS_ACTIVE';
const ENV_MANIFEST = 'DEXBOT_ESM_MOCK_MANIFEST';
const ENV_STAGE = 'DEXBOT_ESM_MOCK_STAGE';
const ENV_UNIT = 'DEXBOT_ESM_MOCK_UNIT';

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
 * different sets across tests: the ESM cache must be fresh per stage, so each
 * stage runs in its own hooked worker thread. In the parent, runs one worker
 * per stage and forwards the first failing exit code; in a worker, executes
 * only the requested stage.
 *
 * Stages are independent, so they run with bounded concurrency (default =
 * available cores, capped at 8; override with DEXBOT_ESM_STAGE_CONCURRENCY=1
 * for the old sequential behaviour). Each stage gets its own manifest and stub
 * files (keyed by PID + thread id) so parallel workers never clobber one
 * another.
 */
function defaultStageConcurrency() {
    // Each stage is an isolated worker that reloads its module graph, so the
    // useful ceiling is the core count. Cap at 8 to bound peak memory on
    // many-core hosts (a stale 4 left larger machines idle).
    const cores = typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;
    return Math.max(1, Math.min(Number.isFinite(cores) ? cores : 4, 8));
}

function resolveStageConcurrency(stageCount) {
    const raw = Number(process.env.DEXBOT_ESM_STAGE_CONCURRENCY);
    const configured = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : defaultStageConcurrency();
    return Math.max(1, Math.min(configured, stageCount));
}

/**
 * Run one stage in a dedicated worker thread.
 *
 * A worker gets its own module registry (so the stage sees fresh ESM mocks)
 * while reusing the parent process — cheaper than a full `node` spawn. The
 * test file is the worker entry, so `process.argv[1]` inside the worker is
 * still the test file and `runEsmMockStages` takes its child branch. Worker
 * stdout/stderr go to the process streams, so the runner's capture is
 * unchanged.
 */
function runStageInWorker(entryFile, stage, manifestPath) {
    return new Promise<number>((resolve) => {
        let settled = false;
        const settle = (code) => {
            if (settled) return;
            settled = true;
            try { fs.rmSync(manifestPath, { force: true }); } catch { /* best effort */ }
            resolve(typeof code === 'number' ? code : 1);
        };
        const worker = new Worker(entryFile, {
            execArgv: ['--import', HOOKS_FILE],
            env: {
                ...process.env,
                [ENV_ACTIVE]: '1',
                [ENV_MANIFEST]: manifestPath,
                [ENV_STAGE]: stage,
            },
        });
        worker.on('exit', (code) => settle(code));
        worker.on('error', (err) => {
            console.error(err);
            settle(1);
        });
    });
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
        (async () => {
            let exitCode = 0;
            for (const stage of stages) {
                process.stdout.write(`\n=== [STAGE] ${stage} ===\n`);
                const manifestPath = manifestPathFor(entryFile);
                writeManifest(manifestPath, {});
                const code = await runStageInWorker(entryFile, stage, manifestPath);
                if (code !== 0) {
                    exitCode = code;
                    break;
                }
            }
            process.exit(exitCode);
        })();
        return;
    }

    // Parallel path: one worker per stage, bounded by `concurrency`. The parent
    // stays alive on the worker handles and exits once every worker settles.
    const spawnStage = (stage, index) => {
        const manifestPath = manifestPathFor(
            entryFile,
            `${index}-${Math.random().toString(36).slice(2, 8)}`
        );
        writeManifest(manifestPath, {});
        return runStageInWorker(entryFile, stage, manifestPath);
    };

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

/**
 * Like runEsmMockStages, but runs EVERY stage inside one hooked worker thread
 * (sequentially) instead of one worker per stage.
 *
 * Only valid for test files whose mocks read a mutable per-stage scenario
 * rather than closing over the installing stage's values, and whose production
 * modules hold no cross-stage state. When that holds (e.g. test_credit_runtime)
 * this avoids paying worker startup + module-graph evaluation once per stage.
 * The stage's own install/setup must refresh the scenario on every call.
 */
function runEsmMockStagesShared(stages, runStage) {
    if (process.env[ENV_ACTIVE] === '1' && process.env[ENV_MANIFEST]) {
        (async () => {
            for (const stage of stages) {
                process.stdout.write(`\n=== [STAGE] ${stage} ===\n`);
                await runStage(stage);
            }
        })().then(
            () => process.exit(0),
            (err) => {
                console.error(err);
                process.exit(1);
            }
        );
        return;
    }

    const entryFile = fs.realpathSync(path.resolve(process.argv[1] || ''));
    const manifestPath = manifestPathFor(entryFile);
    writeManifest(manifestPath, {});
    runStageInWorker(entryFile, stages[0], manifestPath).then((code) => process.exit(code));
}

/**
 * Run one unit (a list of one or more stage names) in a worker thread.
 * The unit is forwarded as JSON in ENV_UNIT so the worker can run all of its
 * stages sequentially before exiting.
 */
function runUnitInWorker(entryFile, unit, manifestPath) {
    return new Promise<number>((resolve) => {
        let settled = false;
        const settle = (code) => {
            if (settled) return;
            settled = true;
            try { fs.rmSync(manifestPath, { force: true }); } catch { /* best effort */ }
            resolve(typeof code === 'number' ? code : 1);
        };
        const worker = new Worker(entryFile, {
            execArgv: ['--import', HOOKS_FILE],
            env: {
                ...process.env,
                [ENV_ACTIVE]: '1',
                [ENV_MANIFEST]: manifestPath,
                [ENV_UNIT]: JSON.stringify(unit),
            },
        });
        worker.on('exit', (code) => settle(code));
        worker.on('error', (err) => {
            console.error(err);
            settle(1);
        });
    });
}

/**
 * Grouped stage runner. `units` is an array whose entries are either a single
 * stage name or an array of stage names that share an identical mock module
 * set (and hold no cross-stage state), which therefore run sequentially in ONE
 * worker. This avoids paying worker startup + module-graph evaluation once per
 * stage for the mock-free / same-mock stages, while stages whose mock sets
 * conflict (or that toggle real-vs-mocked modules) stay in their own worker.
 */
function runEsmMockStagesGrouped(units, runStage) {
    units = units.map((u) => (Array.isArray(u) ? u : [u]));
    if (process.env[ENV_ACTIVE] === '1' && process.env[ENV_MANIFEST] && process.env[ENV_UNIT]) {
        let unit: string[] = [];
        try { unit = JSON.parse(process.env[ENV_UNIT] || '[]'); } catch { unit = []; }
        (async () => {
            for (const stage of unit) {
                process.stdout.write(`\n=== [STAGE] ${stage} ===\n`);
                await runStage(stage);
            }
        })().then(
            () => process.exit(0),
            (err) => {
                console.error(err);
                process.exit(1);
            }
        );
        return;
    }

    const entryFile = fs.realpathSync(path.resolve(process.argv[1] || ''));
    const concurrency = resolveStageConcurrency(units.length);
    const spawnUnit = (unit, index) => {
        const manifestPath = manifestPathFor(
            entryFile,
            `${index}-${Math.random().toString(36).slice(2, 8)}`
        );
        writeManifest(manifestPath, {});
        return runUnitInWorker(entryFile, unit, manifestPath);
    };

    if (concurrency <= 1) {
        (async () => {
            let exitCode = 0;
            for (const unit of units) {
                const code = await spawnUnit(unit, 0);
                if (code !== 0) {
                    exitCode = code;
                    break;
                }
            }
            process.exit(exitCode);
        })();
        return;
    }

    let next = 0;
    let exitCode = 0;
    let abort = false;
    const worker = async () => {
        while (!abort) {
            const index = next++;
            if (index >= units.length) return;
            const code = await spawnUnit(units[index], index);
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
    // threadId (not PID) is the per-stage identity: every worker shares the
    // parent's PID, so PID alone would let concurrent stages clobber stubs.
    return path.join(tmpDir('esm-mock-stubs'), `${stamp}-${process.pid}-${threadId}.cjs`);
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

module.exports = { esmMockEntry, runEsmMockStages, runEsmMockStagesShared, runEsmMockStagesGrouped, defineEsmMock, defineEsmMockAbs };
