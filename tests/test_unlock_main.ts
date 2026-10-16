// Env/profile setup MUST happen before any require(): Config snapshots
// process.env at module load (tests/helpers/* transitively load config), so
// the profile root and launcher flags below would otherwise be missed. A
// temp profile root keeps pid files, logs, and the bots fixture hermetic so
// no password prompt or network access can ever be reached.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-unlock-main-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;
process.env.DEXBOT_SUPERVISOR_SOCKET = `/tmp/dexbot-unlock-main-test-${process.pid}.sock`;
process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = '1';
delete process.env.DEXBOT_MONOLITHIC_BG;
delete process.env.DEXBOT_ISOLATED_CHILD;
delete process.env.DEXBOT_ISOLATED_FOREGROUND;
delete process.env.BOT_NAME;
delete process.env.NO_COLOR;

const assert = require('assert');
const childProcess = require('child_process');
const originalSpawn = childProcess.spawn;
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { makeControllerStub, getActiveBotNames, stripAnsi, makeFakeChild } = require('./helpers/unlock_test_helpers');
const { NullProcessDiscovery, setProcessDiscovery, resetProcessDiscovery } = require('../modules/process_discovery');

console.log('Running unlock main tests');

// unlock.ts statically imports the credential-daemon controller and
// supervisor control, so require.cache entries cannot intercept them on
// compiled ESM — both are mocked through the loader-hook harness instead.
const controllerPath = require.resolve('../modules/launcher/credential_daemon');
const supervisorControlPath = require.resolve('../modules/launcher/supervisor_control');

const FIXTURE_BOTS = [
    { name: 'AAA-BBB', active: true },
    { name: '<bot>', active: true },
];

const UNLOCK_JS = path.resolve(__dirname, '..', 'unlock.js');
const DEXBOT_JS = path.resolve(__dirname, '..', 'dexbot.js');
const CRED_DAEMON_PID = 4242;

const state: any = {
    calls: [],
    ensureCalls: [],
    ensureCount: 0,
    waitCount: 0,
    stopCount: 0,
    controlStatusCalls: 0,
    exitCodes: [],
    logs: [],
    childOpts: { emitClose: false },
    fileWrites: {} as Record<string, string>,
};

const controller = makeControllerStub({
    ensureCredentialDaemon: async (opts: any) => {
        state.ensureCalls.push(opts);
        state.ensureCount += 1;
        return true;
    },
    getManagedDaemonPid: () => CRED_DAEMON_PID,
    waitForManagedDaemon: async () => { state.waitCount += 1; return 0; },
    stopManagedDaemon: async () => { state.stopCount += 1; },
});

function resetState() {
    state.calls.length = 0;
    state.ensureCalls.length = 0;
    state.ensureCount = 0;
    state.waitCount = 0;
    state.stopCount = 0;
    state.controlStatusCalls = 0;
    state.exitCodes.length = 0;
    state.logs.length = 0;
    state.childOpts = { emitClose: false };
    state.fileWrites = {};
    cleanRuntimeStateFiles();
}

const originalWriteFileSync = fs.writeFileSync;

function cleanRuntimeStateFiles() {
    const { PATHS } = require('../modules/paths');
    for (const filePath of [
        PATHS.PROFILES.MONOLITHIC_PID,
        PATHS.PROFILES.MONOLITHIC_BOT_PID,
        PATHS.PROFILES.MONOLITHIC_BOT_INFO,
        PATHS.PROFILES.MONOLITHIC_CRED_PID,
    ]) {
        try { fs.unlinkSync(filePath); } catch (_) {}
    }
}

function readStateFile(filePath: string) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        return null;
    }
}

let restoreConsole: () => void = () => {};
const originalProcessExit = process.exit;

function installStubs() {
    defineEsmMockAbs(controllerPath, ['createCredentialDaemonController'], {
        createCredentialDaemonController: () => controller,
    });
    defineEsmMockAbs(supervisorControlPath, ['sendControlCommand'], {
        sendControlCommand: async (cmd: any) => {
            // First status probe is launchDetachedSupervisor's "is another
            // supervisor running" pre-check; the transient failure lets it
            // proceed, later probes satisfy waitForSupervisorReady.
            if (cmd.cmd === 'status') {
                state.controlStatusCalls += 1;
                if (state.controlStatusCalls === 1) {
                    throw new Error('No supervisor socket found. Start bots with: dexbot start --isolated');
                }
            }
            return { ok: true };
        },
    });

    childProcess.spawn = (command: any, args: any, options: any) => {
        state.calls.push({ command, args, options });
        return makeFakeChild(state.childOpts);
    };

    // The monolithic background child cleans up its pid/state files in its
    // own finally block, so record writes instead of reading files after the
    // fact.
    fs.writeFileSync = (filePath: any, data: any, options: any) => {
        state.fileWrites[String(filePath)] = String(data);
        return originalWriteFileSync(filePath, data, options);
    };

    setProcessDiscovery(new NullProcessDiscovery());

    // Background launch paths terminate via process.exit(0) after printing
    // the startup summary — swallow it so post-launch assertions still run.
    process.exit = ((code = 0) => {
        state.exitCodes.push(code);
        const err: any = new Error(`process.exit:${code}`);
        err.code = TEST_PROCESS_EXIT;
        throw err;
    }) as any;

    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: any[]) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) state.logs.push(line);
    };
    // console.error stays live so unexpected failures surface immediately.
    restoreConsole = () => {
        console.log = originalLog;
        console.error = originalError;
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    fs.writeFileSync = originalWriteFileSync;
    process.exit = originalProcessExit;
    restoreConsole();
    resetProcessDiscovery();
}

function logsIncludePlain(expected: string) {
    return state.logs.some((line: string) => stripAnsi(line) === expected);
}

const TEST_PROCESS_EXIT = 'TEST_PROCESS_EXIT';

let unlock: any;

async function runMain(argv: any, startupGraceMs = 0) {
    try {
        await unlock.main({ argv, startupGraceMs });
    } catch (err: any) {
        if (err && err.code === TEST_PROCESS_EXIT) {
            return; // background launch paths terminate via process.exit(0)
        }
        throw err;
    }
}

// Old "default launches one shared bot process" scenario: the current parent
// daemonizes instead — it spawns ONE detached monolithic wrapper child,
// transfers credential-daemon ownership to it (no stopManagedDaemon), records
// the wrapper + daemon pids for control commands, prints the background
// summary, and terminates via process.exit(0).
async function runAllBotsBackgroundDaemonizeTest() {
    resetState();
    await runMain(['node', 'unlock']);

    const activeBotNames = getActiveBotNames();
    const { Config } = require('../modules/config');
    const { PATHS } = require('../modules/paths');

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.waitCount, 0, 'normal startup should not wait on daemon shutdown');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');

    assert.strictEqual(state.calls.length, 1, 'daemonizing startup should spawn exactly one wrapper child');
    const spawnCall = state.calls[0];
    assert.strictEqual(spawnCall.command, Config.EXEC_PATH, 'wrapper child should run on the configured node executable');
    assert.deepStrictEqual(spawnCall.args, [UNLOCK_JS], 'wrapper child should re-enter unlock without extra args');
    assert.strictEqual(spawnCall.options.detached, true, 'wrapper child should be detached');
    assert.strictEqual(spawnCall.options.cwd, PATHS.PROJECT_ROOT, 'wrapper child should run from the project root');
    assert.strictEqual(spawnCall.options.stdio[0], 'ignore', 'wrapper child stdin should be ignored');
    assert.strictEqual(
        spawnCall.options.env.DEXBOT_MONOLITHIC_BG,
        '1',
        'wrapper child must be flagged as the monolithic background runtime'
    );
    assert.strictEqual(
        spawnCall.options.env.DEXBOT_MANAGED_CRED_PID,
        String(CRED_DAEMON_PID),
        'wrapper child should inherit the managed credential daemon pid'
    );

    assert.strictEqual(readStateFile(PATHS.PROFILES.MONOLITHIC_PID), '9999', 'wrapper pid should be recorded for control commands');
    assert.strictEqual(readStateFile(PATHS.PROFILES.MONOLITHIC_CRED_PID), String(CRED_DAEMON_PID), 'daemon pid should be recorded for control commands');

    const expectedCountLine = `DEXBot2 started ${activeBotNames.length} ${activeBotNames.length === 1 ? 'bot' : 'bots'} in background`;
    assert.ok(logsIncludePlain('DEXBot2 Unlock Launcher'), 'launcher should print a banner title');
    assert.ok(logsIncludePlain('Starting all bots'), 'launcher should print the chosen launch mode');
    assert.ok(logsIncludePlain('✓ Authentication successful'), 'launcher should confirm successful authentication');
    assert.ok(logsIncludePlain(expectedCountLine), 'launcher should print the background startup summary');
    for (const botName of activeBotNames) {
        assert.ok(logsIncludePlain(`- ${botName}`), `launcher should list active bot ${botName}`);
    }
    assert.deepStrictEqual(state.exitCodes, [0], 'daemonizing startup should terminate cleanly via process.exit(0)');
}

// Old "single-bot unlock passes the name through" scenario, updated for the
// daemonizing parent: the bot name must survive into the wrapper child argv
// and the summary must list exactly that bot.
async function runSingleBotBackgroundDaemonizeTest() {
    resetState();
    await runMain(['node', 'unlock', 'AAA-BBB']);

    const { PATHS } = require('../modules/paths');

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');
    assert.strictEqual(state.calls.length, 1, 'daemonizing startup should spawn exactly one wrapper child');
    assert.deepStrictEqual(
        state.calls[0].args,
        [UNLOCK_JS, 'AAA-BBB'],
        'single-bot unlock should pass the bot name through to the wrapper child'
    );
    assert.strictEqual(readStateFile(PATHS.PROFILES.MONOLITHIC_PID), '9999', 'wrapper pid should be recorded');
    assert.ok(logsIncludePlain('Starting bot: AAA-BBB'), 'launcher should print the selected bot name');
    assert.ok(logsIncludePlain('DEXBot2 started 1 bot in background'), 'launcher should print the single-bot count');
    assert.ok(logsIncludePlain('- AAA-BBB'), 'launcher should list the launched bot');
}

async function runClawOnlyTest() {
    resetState();
    await runMain(['node', 'unlock', '--claw-only']);

    const { PATHS } = require('../modules/paths');

    assert.strictEqual(state.ensureCount, 1, 'claw-only mode should unlock the credential daemon');
    assert.strictEqual(state.waitCount, 1, 'claw-only mode should wait for daemon lifecycle');
    assert.strictEqual(state.calls.length, 0, 'claw-only mode should not spawn a bot process');
    assert.strictEqual(state.stopCount, 1, 'claw-only mode should still clean up owned daemons');
    assert.strictEqual(readStateFile(PATHS.PROFILES.MONOLITHIC_PID), null, 'claw-only mode should not record a wrapper pid');
    assert.ok(logsIncludePlain('Starting credential daemon only'), 'launcher should print the claw-only mode');
    assert.ok(logsIncludePlain('DEXBot2 credential daemon started successfully!'), 'launcher should print the claw-only success footer');
}

// Old "--isolated spawns per-bot processes" scenarios: per-bot spawning moved
// into a dedicated detached supervisor child. The launcher must spawn exactly
// that child (with DEXBOT_ISOLATED_CHILD), verify the control socket is free
// before launching, wait for readiness, release daemon ownership, and print
// the isolated-mode summary with the supervisor pid.
async function runIsolatedDetachedSupervisorTest(botName?: string) {
    resetState();
    await runMain(['node', 'unlock', '--isolated', ...(botName ? [botName] : [])]);

    const listedBotNames = botName ? [botName] : getActiveBotNames();
    const { Config } = require('../modules/config');
    const { PATHS } = require('../modules/paths');

    assert.strictEqual(state.ensureCount, 1, 'isolated launcher should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 0, 'isolated launcher should hand daemon ownership to the supervisor child');
    assert.strictEqual(state.controlStatusCalls, 2, 'isolated launcher should probe the control socket before and after spawn');

    assert.strictEqual(state.calls.length, 1, 'isolated launcher should spawn exactly one supervisor child');
    const spawnCall = state.calls[0];
    assert.strictEqual(spawnCall.command, Config.EXEC_PATH, 'supervisor child should run on the configured node executable');
    assert.deepStrictEqual(
        spawnCall.args,
        [UNLOCK_JS, '--isolated', ...(botName ? [botName] : [])],
        'supervisor child should re-enter unlock with the isolated flags'
    );
    assert.strictEqual(spawnCall.options.detached, true, 'supervisor child should be detached');
    assert.strictEqual(spawnCall.options.cwd, PATHS.PROJECT_ROOT, 'supervisor child should run from the project root');
    assert.strictEqual(
        spawnCall.options.env.DEXBOT_ISOLATED_CHILD,
        '1',
        'supervisor child must be flagged as the isolated supervisor runtime'
    );
    assert.strictEqual(
        spawnCall.options.env.DEXBOT_MANAGED_CRED_PID,
        String(CRED_DAEMON_PID),
        'supervisor child should inherit the managed credential daemon pid'
    );

    const expectedCountLine = `DEXBot2 started ${listedBotNames.length} ${listedBotNames.length === 1 ? 'bot' : 'bots'} in isolated`;
    assert.ok(logsIncludePlain(expectedCountLine), 'isolated launcher should print the isolated startup summary');
    for (const name of listedBotNames) {
        assert.ok(logsIncludePlain(`- ${name}`), `isolated launcher should list bot ${name}`);
    }
    assert.ok(state.logs.includes('Supervisor PID: 9999'), 'isolated launcher should report the supervisor pid');
    assert.deepStrictEqual(state.exitCodes, [], 'detached isolated startup should return normally instead of exiting');
}

// Old "bot exits during the startup grace period" scenario: grace-period
// supervision moved into the monolithic background child. Running main() AS
// that child (Config.DEXBOT_MONOLITHIC_BG) must reject when the supervised
// dexbot process dies before the grace timer elapses, record the bot pid
// files, and still stop the owned daemon.
async function runMonolithicBgChildStartupFailureTest() {
    resetState();
    const { Config } = require('../modules/config');
    const { PATHS } = require('../modules/paths');
    const previousMonolithicBg = Config.DEXBOT_MONOLITHIC_BG;
    Config.DEXBOT_MONOLITHIC_BG = true;
    state.childOpts = { withStdio: true, emitClose: true };
    try {
        await assert.rejects(
            () => unlock.main({ argv: ['node', 'unlock'], startupGraceMs: 50 }),
            /DEXBot exited during startup/,
            'monolithic background child should reject when the bot exits during the startup grace period'
        );
    } finally {
        Config.DEXBOT_MONOLITHIC_BG = previousMonolithicBg;
    }

    const activeBotNames = getActiveBotNames();

    assert.strictEqual(state.ensureCount, 1, 'background child should still unlock the credential daemon first');
    assert.strictEqual(state.stopCount, 1, 'background child should still clean up its owned daemon');
    assert.strictEqual(state.calls.length, 1, 'background child should supervise exactly one bot process');
    assert.deepStrictEqual(
        state.calls[0].args,
        [DEXBOT_JS, 'worker'],
        'background child should launch the shared dexbot entry point as `worker`'
    );
    assert.strictEqual(
        state.calls[0].options.env.DEXBOT_LAUNCHER_WORKER,
        '1',
        'background child must carry the worker marker so the entry point runs the bot instead of re-entering the supervisor'
    );
    assert.strictEqual(state.calls[0].options.stdio, 'pipe', 'background child should pipe bot output into the runtime logs');
    assert.strictEqual(state.fileWrites[PATHS.PROFILES.MONOLITHIC_BOT_PID], '9999', 'background child should record the bot pid');
    const botInfo = JSON.parse(state.fileWrites[PATHS.PROFILES.MONOLITHIC_BOT_INFO]);
    assert.deepStrictEqual(botInfo.botNames, activeBotNames, 'background child should snapshot the launched bot names');
    assert.strictEqual(botInfo.pid, 9999, 'background child should snapshot the bot pid');
}

async function runMissingIsolatedBotFailsFastTest() {
    resetState();
    await assert.rejects(
        () => unlock.main({ argv: ['node', 'unlock', '--isolated', 'DOES-NOT-EXIST'], startupGraceMs: 0 }),
        /Bot 'DOES-NOT-EXIST' not found in bots\.json/,
        'isolated startup should fail immediately for unknown bots'
    );
    assert.strictEqual(state.ensureCount, 0, 'launcher should validate the target bot before unlocking credentials');
    assert.strictEqual(state.calls.length, 0, 'launcher should not spawn child processes for unknown bots');
    assert.strictEqual(state.controlStatusCalls, 0, 'unknown bots must not reach the supervisor control layer');
}

async function runHeadlessFlagPassthroughTest() {
    resetState();
    await runMain(['node', 'unlock', '--headless', 'AAA-BBB']);

    assert.strictEqual(state.ensureCount, 1, 'headless launcher should unlock the credential daemon once');
    assert.ok(state.ensureCalls.length >= 1, 'ensureCredentialDaemon should have been called');
    assert.strictEqual(state.ensureCalls[0].headless, true, 'headless flag should be passed to ensureCredentialDaemon');
    assert.strictEqual(state.ensureCalls[0].passwordFile, null, 'no password file should be reported unless given');
    assert.strictEqual(state.stopCount, 0, 'headless background startup should hand daemon ownership to the child');
    assert.strictEqual(state.calls.length, 1, 'headless single-bot unlock should spawn exactly one wrapper child');
    assert.deepStrictEqual(
        state.calls[0].args,
        [UNLOCK_JS, '--headless', 'AAA-BBB'],
        'headless flags and bot name should pass through to the wrapper child'
    );
    assert.ok(logsIncludePlain('- AAA-BBB'), 'headless launcher should list the launched bot');
}

runEsmMockStages(['unlock_main'], async () => {
    fs.writeFileSync(path.join(TEMP_PROFILE_ROOT, 'bots.json'), JSON.stringify({ bots: FIXTURE_BOTS }));
    installStubs();
    unlock = require('../unlock');
    let stageError: any = null;
    try {
        await runAllBotsBackgroundDaemonizeTest();
        await runSingleBotBackgroundDaemonizeTest();
        await runClawOnlyTest();
        await runIsolatedDetachedSupervisorTest();
        await runIsolatedDetachedSupervisorTest('AAA-BBB');
        await runMonolithicBgChildStartupFailureTest();
        await runMissingIsolatedBotFailsFastTest();
        await runHeadlessFlagPassthroughTest();
    } catch (err) {
        stageError = err;
    } finally {
        // Restore the real console first so results always reach stdout/stderr
        // regardless of test outcome.
        restoreStubs();
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }
    if (stageError) {
        console.error(stageError);
        process.exit(1);
    }
    console.log('unlock main tests passed');
});
