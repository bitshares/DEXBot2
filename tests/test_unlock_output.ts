// Env/profile setup MUST happen before any require(): Config snapshots
// process.env at module load, and unlock_test_helpers resolves the bots
// fixture through PATHS.PROFILES.BOTS_JSON. A temp profile root keeps pid
// files, logs, and the bots fixture hermetic — no password prompt and no
// network access can ever be reached.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-unlock-output-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;
process.env.DEXBOT_SUPERVISOR_SOCKET = `/tmp/dexbot-unlock-output-test-${process.pid}.sock`;
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

console.log('Running unlock output tests');

// unlock.ts statically imports createCredentialDaemonController, so a
// require.cache entry cannot intercept it on compiled ESM — the controller
// module is mocked through the loader-hook harness instead.
const controllerPath = require.resolve('../modules/launcher/credential_daemon');

const FIXTURE_BOTS = [
    { name: 'AAA-BBB', active: true },
    { name: '<bot>', active: true },
];

const UNLOCK_JS = path.resolve(__dirname, '..', 'unlock.js');
const DEXBOT_JS = path.resolve(__dirname, '..', 'dexbot.js');
const LIVE_MONOLITHIC_PID = 999999;
const FAKE_CHILD_PID = 9999;

const state: any = {
    ensureCount: 0,
    ensureResult: true,
    waitCount: 0,
    stopCount: 0,
    calls: [],
    exitCodes: [],
    logs: [],
    errors: [],
    childOpts: { emitClose: false },
    liveMonolithicPid: false,
    monolithicAlive: false,
    monolithicBotInfoJson: null,
};

function setStdoutTTY(value: any) {
    Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
        writable: true,
    });
}

function logsIncludePlain(expected: string) {
    return state.logs.some((line: string) => stripAnsi(line) === expected);
}

const controller = makeControllerStub({
    ensureCredentialDaemon: async () => {
        state.ensureCount += 1;
        return state.ensureResult;
    },
    getManagedDaemonPid: () => 12345,
    waitForManagedDaemon: async () => {
        state.waitCount += 1;
        return 0;
    },
    stopManagedDaemon: async () => {
        state.stopCount += 1;
    },
});

function makeMockDiscovery() {
    return {
        isAlive(pid: number): boolean {
            if (pid === LIVE_MONOLITHIC_PID) return state.liveMonolithicPid && state.monolithicAlive;
            return false;
        },
        readArgs(pid: number): string[] {
            if (pid === LIVE_MONOLITHIC_PID && state.liveMonolithicPid && state.monolithicAlive) {
                return ['node', UNLOCK_JS];
            }
            return [];
        },
        readCmdline(pid: number): string {
            return this.readArgs(pid).join(' ');
        },
        readCwd(pid: number): string {
            if (pid === LIVE_MONOLITHIC_PID && state.liveMonolithicPid && state.monolithicAlive) {
                return path.resolve(__dirname, '..', '..');
            }
            return '';
        },
        readRSSBytes(pid: number): number {
            if (pid === LIVE_MONOLITHIC_PID && state.liveMonolithicPid && state.monolithicAlive) return 123456 * 1024;
            return -1;
        },
        readStat(pid: number): any {
            if (pid === LIVE_MONOLITHIC_PID && state.liveMonolithicPid && state.monolithicAlive) {
                return { utime: 0, stime: 0, starttime: 1234567 };
            }
            return null;
        },
        readMemMB(pid: number): string {
            if (pid === LIVE_MONOLITHIC_PID && state.liveMonolithicPid && state.monolithicAlive) return '120MB';
            return '-';
        },
        readCpuTime(_pid: number): string { return '-'; },
        async readCpuPercent(_pid: number, _samples?: number, _intervalMs?: number): Promise<string> { return '-'; },
        readUptime(_pid: number): string { return '-'; },
        readSystemUptimeSec(): number { return 1234567; },
        readSocketInode(_socketPath: string): number { return 0; },
        findSocketOwnerPid(_socketPath: string, _isLikelyProcess?: (pid: number) => boolean): number { return 0; },
        listAllPids(): number[] {
            return state.liveMonolithicPid && state.monolithicAlive ? [LIVE_MONOLITHIC_PID] : [];
        },
    };
}

let restoreConsole: () => void = () => {};
const originalProcessExit = process.exit;
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalStdoutIsTTY = process.stdout.isTTY;
const { setProcessDiscovery, resetProcessDiscovery } = require('../modules/process_discovery');

function installStubs() {
    defineEsmMockAbs(controllerPath, ['createCredentialDaemonController'], {
        createCredentialDaemonController: () => controller,
    });

    childProcess.spawn = (command: any, args: any, options: any) => {
        state.calls.push({ command, args, options });
        return makeFakeChild(state.childOpts);
    };

    setProcessDiscovery(makeMockDiscovery());

    const { PATHS } = require('../modules/paths');
    const virtualFiles = new Set([
        PATHS.PROFILES.MONOLITHIC_PID,
        PATHS.PROFILES.MONOLITHIC_BOT_INFO,
        PATHS.PROFILES.MONOLITHIC_CRED_PID,
        PATHS.PROFILES.MONOLITHIC_BOT_PID,
    ]);
    // Virtualize the monolithic pid/state files so "already running" and
    // status flows can be driven deterministically; everything else hits the
    // real (temp profile root) filesystem.
    fs.existsSync = (filePath: any) => {
        const normalized = String(filePath);
        if (normalized === PATHS.PROFILES.MONOLITHIC_PID) return state.liveMonolithicPid;
        if (normalized === PATHS.PROFILES.MONOLITHIC_BOT_INFO) return !!state.monolithicBotInfoJson;
        if (virtualFiles.has(normalized)) return false;
        return originalExistsSync(filePath);
    };
    fs.readFileSync = (filePath: any, options: any) => {
        const normalized = String(filePath);
        if (normalized === PATHS.PROFILES.MONOLITHIC_PID && state.liveMonolithicPid) {
            return String(LIVE_MONOLITHIC_PID);
        }
        if (normalized === PATHS.PROFILES.MONOLITHIC_BOT_INFO && state.monolithicBotInfoJson) {
            return state.monolithicBotInfoJson;
        }
        return originalReadFileSync(filePath, options);
    };

    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: any[]) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) state.logs.push(line);
    };
    console.error = (...args: any[]) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) state.errors.push(line);
    };
    restoreConsole = () => {
        console.log = originalLog;
        console.error = originalError;
    };

    // Background launch paths terminate via process.exit(0); control/status
    // flows may exit too. Swallow both so several invocations can run in
    // sequence while recording the requested exit code.
    process.exit = ((code = 0) => {
        state.exitCodes.push(code);
        const err: any = new Error(`process.exit:${code}`);
        err.code = TEST_PROCESS_EXIT;
        throw err;
    }) as any;
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    process.exit = originalProcessExit;
    setStdoutTTY(originalStdoutIsTTY);
    restoreConsole();
    resetProcessDiscovery();
}

function resetState() {
    state.ensureCount = 0;
    state.ensureResult = true;
    state.waitCount = 0;
    state.stopCount = 0;
    state.calls.length = 0;
    state.exitCodes.length = 0;
    state.logs.length = 0;
    state.errors.length = 0;
    state.childOpts = { emitClose: false };
    state.liveMonolithicPid = false;
    state.monolithicAlive = false;
    state.monolithicBotInfoJson = null;
    process.exitCode = 0;
}

const TEST_PROCESS_EXIT = 'TEST_PROCESS_EXIT';

let unlock: any;

async function runUnlockStart(args: any, startupGraceMs = 0) {
    try {
        await unlock.main({ argv: args, startupGraceMs });
    } catch (err: any) {
        if (err && err.code === TEST_PROCESS_EXIT) {
            return;
        }
        throw err;
    }
}

async function runAllBotsTest() {
    resetState();
    await runUnlockStart(['node', 'unlock']);
    const activeBotNames = getActiveBotNames();
    const { PATHS } = require('../modules/paths');

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.waitCount, 0, 'normal startup should not wait on daemon shutdown');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');
    assert.strictEqual(state.calls.length, 1, 'launcher should spawn the background child once');
    assert.strictEqual(state.calls[0].command, process.execPath, 'background child should use the current node executable');
    assert.deepStrictEqual(state.calls[0].args, [UNLOCK_JS], 'background child should re-enter unlock without extra args');
    assert.strictEqual(state.calls[0].options.detached, true, 'background child should be detached');
    assert.strictEqual(
        state.calls[0].options.env.DEXBOT_MONOLITHIC_BG,
        '1',
        'background child must be flagged as the monolithic background runtime'
    );
    try {
        assert.strictEqual(fs.readFileSync(PATHS.PROFILES.MONOLITHIC_PID, 'utf8'), String(FAKE_CHILD_PID), 'wrapper pid should be recorded for control commands');
    } catch (_) {
        assert.fail('wrapper pid file should exist after daemonizing startup');
    }
    assert.ok(state.logs.includes('DEXBot2 Unlock Launcher'), 'launcher should print a banner title');
    assert.ok(state.logs.includes('Starting all bots'), 'launcher should print the chosen launch mode');
    assert.ok(state.logs.includes('✓ Authentication successful'), 'launcher should confirm successful authentication');
    const countLine = `DEXBot2 started ${activeBotNames.length} ${activeBotNames.length === 1 ? 'bot' : 'bots'} in background`;
    assert.ok(logsIncludePlain(countLine), 'launcher should print the launched bot count');
    for (const botName of activeBotNames) {
        assert.ok(logsIncludePlain(`- ${botName}`), `launcher should list active bot ${botName}`);
    }
    assert.deepStrictEqual(state.exitCodes, [0], 'daemonizing startup should terminate cleanly via process.exit(0)');
}

async function runSingleBotTest() {
    resetState();
    await runUnlockStart(['node', 'unlock', 'AAA-BBB']);

    assert.strictEqual(state.ensureCount, 1, 'launcher should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');
    assert.strictEqual(state.calls.length, 1, 'launcher should spawn the background child once');
    assert.deepStrictEqual(
        state.calls[0].args,
        [UNLOCK_JS, 'AAA-BBB'],
        'single-bot unlock should pass the bot name through to the background child'
    );
    assert.ok(state.logs.includes('Starting bot: AAA-BBB'), 'launcher should print the selected bot name');
    assert.ok(logsIncludePlain('DEXBot2 started 1 bot in background'), 'launcher should print the single-bot count');
    assert.ok(logsIncludePlain('- AAA-BBB'), 'launcher should list the launched bot');
}

async function runForegroundTest() {
    resetState();
    state.childOpts = { emitClose: true };
    await runUnlockStart(['node', 'unlock', '--foreground']);
    const activeBotNames = getActiveBotNames();

    assert.strictEqual(state.ensureCount, 1, 'foreground mode should unlock the credential daemon once');
    assert.strictEqual(state.stopCount, 1, 'foreground mode should clean up its owned daemon');
    assert.strictEqual(state.calls.length, 1, 'foreground mode should spawn the bot process once');
    assert.deepStrictEqual(
        state.calls[0].args,
        [DEXBOT_JS, 'worker'],
        'foreground mode should launch the shared dexbot entry point as `worker`'
    );
    assert.strictEqual(state.calls[0].options.stdio, 'inherit', 'foreground bot output should go to the terminal');
    const countLine = `DEXBot2 started ${activeBotNames.length} ${activeBotNames.length === 1 ? 'bot' : 'bots'} in foreground`;
    assert.ok(logsIncludePlain(countLine), 'foreground mode should print the shared startup summary');
    for (const botName of activeBotNames) {
        assert.ok(logsIncludePlain(`- ${botName}`), `foreground mode should list active bot ${botName}`);
    }
    assert.ok(state.logs.includes('✓ Authentication successful'), 'foreground mode should confirm successful authentication');
    assert.strictEqual(process.exitCode, 0, 'a clean foreground bot exit should settle with exit code 0');
    assert.deepStrictEqual(state.exitCodes, [], 'foreground mode should return instead of calling process.exit');
    assert.strictEqual(state.errors.length, 0, 'foreground mode should not print errors on a clean exit');
}

async function runReuseDaemonTest() {
    resetState();
    state.ensureResult = false;
    await runUnlockStart(['node', 'unlock']);

    assert.strictEqual(state.ensureCount, 1, 'launcher should still check daemon availability');
    assert.strictEqual(state.stopCount, 0, 'background startup should hand daemon ownership to the child');
    assert.strictEqual(state.calls.length, 1, 'reuse startup should still spawn the background child');
    assert.ok(!state.logs.includes('✓ Authentication successful'), 'launcher should not claim fresh authentication when reusing an existing daemon');
}

async function runAlreadyRunningTest() {
    resetState();
    state.liveMonolithicPid = true;
    state.monolithicAlive = true;

    await runUnlockStart(['node', 'unlock']);

    assert.strictEqual(state.ensureCount, 0, 'already-running startup should not unlock the credential daemon');
    assert.strictEqual(state.stopCount, 0, 'already-running startup should not stop any daemon');
    assert.strictEqual(state.calls.length, 0, 'already-running startup should not spawn another wrapper');
    assert.strictEqual(process.exitCode, 0, 'already-running startup should exit successfully');
    assert.ok(
        state.logs.includes(`DEXBot2 already running in background (PID ${LIVE_MONOLITHIC_PID}).`),
        'launcher should report the live wrapper PID'
    );
    assert.ok(state.errors.length === 0, 'already-running startup should not print an error');
}

async function runClawOnlyTest() {
    resetState();
    await runUnlockStart(['node', 'unlock', '--claw-only']);

    assert.strictEqual(state.ensureCount, 1, 'claw-only mode should unlock the credential daemon');
    assert.strictEqual(state.waitCount, 1, 'claw-only mode should wait for daemon lifecycle');
    assert.strictEqual(state.calls.length, 0, 'claw-only mode should not spawn a bot process');
    assert.strictEqual(state.stopCount, 1, 'claw-only mode should still clean up owned daemons');
    assert.ok(state.logs.includes('Starting credential daemon only'), 'launcher should print the claw-only mode');
    assert.ok(state.logs.includes('DEXBot2 credential daemon started successfully!'), 'launcher should print the claw-only success footer');
    assert.ok(
        state.logs.includes('If the daemon stops, rerun `dexbot start --claw-only` to unlock it again.'),
        'launcher should print the claw-only restart hint'
    );
}

// The startup grace period is supervised by the monolithic background child:
// running main() as that child must reject when the bot dies before the grace
// timer elapses, and the success footer must stay suppressed.
async function runStartupFailureSuppressesSuccessTest() {
    resetState();
    state.childOpts = { withStdio: true, emitClose: true };
    const { Config } = require('../modules/config');
    const previousMonolithicBg = Config.DEXBOT_MONOLITHIC_BG;
    Config.DEXBOT_MONOLITHIC_BG = true;
    try {
        await assert.rejects(
            () => unlock.main({ argv: ['node', 'unlock'], startupGraceMs: 50 }),
            /DEXBot exited during startup/,
            'launcher should fail when the child exits during the startup grace period'
        );
    } finally {
        Config.DEXBOT_MONOLITHIC_BG = previousMonolithicBg;
    }

    assert.ok(!state.logs.includes('DEXBot2 started successfully!'), 'launcher should not print the success footer on startup failure');
    assert.ok(!logsIncludePlain('DEXBot2 started 2 bots in background'), 'launcher should not print the background summary on startup failure');
    assert.strictEqual(state.stopCount, 1, 'launcher should still clean up the daemon after startup failure');
}

async function runStatusColorTest() {
    resetState();
    setStdoutTTY(true);
    delete process.env.NO_COLOR;
    state.liveMonolithicPid = true;
    state.monolithicAlive = true;
    const activeBotNames = getActiveBotNames();
    state.monolithicBotInfoJson = JSON.stringify({ botNames: activeBotNames });

    await runUnlockStart(['node', 'unlock', 'status']);

    assert.ok(state.logs.includes('Monolithic bot') || state.logs.some((line: string) => line.includes('Monolithic bot')), 'status output should include the runtime section');
    assert.ok(
        state.logs.some((line: string) => line.includes('\x1b[1;92m') && activeBotNames.some((botName: string) => line.includes(botName))),
        'status output should color active bot names green'
    );
}

async function runStartupSummaryColorTest() {
    resetState();
    setStdoutTTY(true);
    delete process.env.NO_COLOR;
    await runUnlockStart(['node', 'unlock']);
    const activeBotNames = getActiveBotNames();

    assert.ok(
        state.logs.some((line: string) => line.includes('\x1b[1;92m') && activeBotNames.some((botName: string) => line.includes(botName))),
        'startup summary should color active bot names green'
    );
    assert.ok(
        state.logs.some((line: string) => line.includes('\x1b[1;92m') && line.includes('✓ Authentication successful')),
        'startup summary should color authentication success green'
    );
}

async function runClawOnlySuccessColorTest() {
    resetState();
    setStdoutTTY(true);
    delete process.env.NO_COLOR;

    await runUnlockStart(['node', 'unlock', 'claw-only']);

    assert.ok(
        state.logs.some((line: string) => line.includes('\x1b[1;92m') && line.includes('DEXBot2 credential daemon started successfully!')),
        'claw-only startup should color the credential-daemon success footer green'
    );
}

runEsmMockStages(['unlock_output'], async () => {
    fs.writeFileSync(path.join(TEMP_PROFILE_ROOT, 'bots.json'), JSON.stringify({ bots: FIXTURE_BOTS }));
    installStubs();
    unlock = require('../unlock');
    let stageError: any = null;
    try {
        await runAllBotsTest();
        await runSingleBotTest();
        await runForegroundTest();
        await runReuseDaemonTest();
        await runAlreadyRunningTest();
        await runClawOnlyTest();
        await runStartupFailureSuppressesSuccessTest();
        await runStatusColorTest();
        await runStartupSummaryColorTest();
        await runClawOnlySuccessColorTest();
    } catch (err) {
        stageError = err;
    } finally {
        // Restore the real console/stdout first so results always reach the
        // terminal regardless of test outcome.
        restoreStubs();
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }
    if (stageError) {
        console.error(stageError);
        process.exit(1);
    }
    process.stdout.write('unlock output tests passed\n');
});
