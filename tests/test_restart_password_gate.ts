// Regression test: `dexbot restart` must verify the master password BEFORE it
// stops the live credential daemon. A wrong/cancelled password previously left
// the runtime with no daemon (and no keys) after the restart aborted.
//
// Env/profile setup MUST happen before any require(): Config snapshots
// process.env at module load, and the bots fixture resolves through
// PATHS.PROFILES.BOTS_JSON.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-restart-gate-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;

const assert = require('assert');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');

console.log('Running restart password gate tests');

const FIXTURE_BOTS = [
    { name: 'AAA-BBB', active: true },
    { name: '<bot>', active: true },
];

const TEST_PROCESS_EXIT = 'TEST_PROCESS_EXIT';
const LIVE_WRAPPER_PID = 999999;

const state: any = {
    wrongPassword: false,
    events: [] as string[],
    ensureCalls: [] as any[],
    exitCodes: [] as number[],
    logs: [] as string[],
    errors: [] as string[],
};

const controller = {
    authenticateCredential: async () => {
        state.events.push('authenticate');
        if (state.wrongPassword) {
            throw new Error('Incorrect master password after 3 attempts.');
        }
        return { kind: 'vault', version: 1, vaultKeyHex: '00'.repeat(32) };
    },
    ensureCredentialDaemon: async (opts: any) => {
        state.events.push('ensure');
        state.ensureCalls.push(opts);
        return true;
    },
    getManagedDaemonPid: () => null,
    releaseManagedDaemon: () => {},
    isDaemonReady: async () => false,
    stopManagedDaemon: async () => {},
    waitForManagedDaemon: async () => 0,
};

const runtimePath = require.resolve('../modules/launcher/monolithic_runtime');
const controllerPath = require.resolve('../modules/launcher/credential_daemon');

const originalProcessExit = process.exit;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function installStubs() {
    defineEsmMockAbs(controllerPath, ['createCredentialDaemonController'], {
        createCredentialDaemonController: () => controller,
    });

    // The control path only needs a small surface of monolithic_runtime; the
    // module is mocked wholesale so no real pid/socket/kill logic can run.
    defineEsmMockAbs(runtimePath, [
        'MONOLITHIC_PID_FILE', 'MONOLITHIC_BOT_PID_FILE', 'MONOLITHIC_BOT_INFO_FILE',
        'MONOLITHIC_CRED_PID_FILE', 'MONOLITHIC_OUT_LOG', 'MONOLITHIC_ERROR_LOG',
        'CREDENTIAL_SOCKET_FILE', 'CREDENTIAL_READY_FILE', 'readProcStat',
        'getActiveAmaBotFingerprint', 'normalizeControlTarget', 'statusIgnoresTargetMessage',
        'cleanupStateFiles', 'readLiveMonolithicPid', 'readMonolithicBotInfo',
        'isLikelyCredentialDaemonProcess', 'isExpectedMonolithicBotPid',
        'isProcessInDstate', 'stopCredentialDaemonPid', 'stopCredentialDaemon',
        'ensureNoForeignCredentialDaemon', 'findCredentialSocketOwnerPid',
        'cleanupCredentialRuntimeFiles', 'readCredentialDaemonStatus', 'ensureLogDir',
        'buildDexbotStartArgs', 'createUpdateScheduler',
        'listConfiguredBots', 'getControlBotNames', 'getControlActionLabel',
        'getControlServiceNames', 'resolveControlRouting', 'botNotFoundMessage',
        'printControlActionSummary', 'formatBotCount',
    ], {
        MONOLITHIC_PID_FILE: '/tmp/dexbot-restart-gate-monolithic.pid',
        MONOLITHIC_BOT_PID_FILE: '/tmp/dexbot-restart-gate-bot.pid',
        MONOLITHIC_BOT_INFO_FILE: '/tmp/dexbot-restart-gate-bot-info.json',
        MONOLITHIC_CRED_PID_FILE: '/tmp/dexbot-restart-gate-cred.pid',
        MONOLITHIC_OUT_LOG: '/tmp/dexbot-restart-gate.out.log',
        MONOLITHIC_ERROR_LOG: '/tmp/dexbot-restart-gate.err.log',
        CREDENTIAL_SOCKET_FILE: '/tmp/dexbot-restart-gate.sock',
        CREDENTIAL_READY_FILE: '/tmp/dexbot-restart-gate.ready',
        readProcStat: () => null,
        getActiveAmaBotFingerprint: () => null,
        normalizeControlTarget: (target: any) => target,
        statusIgnoresTargetMessage: () => '',
        cleanupStateFiles: () => {},
        readLiveMonolithicPid: () => ({ pid: LIVE_WRAPPER_PID, stale: false }),
        readMonolithicBotInfo: () => null,
        isLikelyCredentialDaemonProcess: () => false,
        isExpectedMonolithicBotPid: () => false,
        isProcessInDstate: () => false,
        stopCredentialDaemonPid: async () => {},
        stopCredentialDaemon: async () => {
            state.events.push('stop');
            return { signaled: true, cleaned: true };
        },
        ensureNoForeignCredentialDaemon: async () => {},
        findCredentialSocketOwnerPid: () => 0,
        cleanupCredentialRuntimeFiles: () => {},
        readCredentialDaemonStatus: () => ({ running: false }),
        ensureLogDir: () => {},
        buildDexbotStartArgs: () => [],
        createUpdateScheduler: () => ({ stop: () => {} }),
        listConfiguredBots: () => FIXTURE_BOTS,
        getControlBotNames: () => FIXTURE_BOTS.map((bot) => bot.name),
        getControlActionLabel: () => 'restarting',
        getControlServiceNames: () => ['credential daemon'],
        resolveControlRouting: () => ({
            cmd: 'restart-all',
            target: null,
            requestedTarget: null,
            folded: false,
            notice: null,
            reject: null,
        }),
        botNotFoundMessage: (name: string) => `Bot '${name}' not found`,
        printControlActionSummary: (label: string, botNames: string[], services: string[]) => {
            state.logs.push(`${label} ${botNames.length} ${botNames.length === 1 ? 'bot' : 'bots'}`);
            for (const service of services) state.logs.push(`- ${service}`);
        },
        formatBotCount: (count: number) => `${count} ${count === 1 ? 'bot' : 'bots'}`,
    });

    // `restart` only re-unlocks the daemon on an interactive terminal.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    process.exit = ((code = 0) => {
        state.exitCodes.push(code);
        const err: any = new Error(`process.exit:${code}`);
        err.code = TEST_PROCESS_EXIT;
        throw err;
    }) as any;

    console.log = (...args: any[]) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) state.logs.push(line);
    };
    console.error = (...args: any[]) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) state.errors.push(line);
    };
    console.warn = (...args: any[]) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) state.errors.push(line);
    };
}

function restoreStubs() {
    process.exit = originalProcessExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    if (originalIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    } else {
        delete (process.stdin as any).isTTY;
    }
}

function resetState() {
    state.wrongPassword = false;
    state.events.length = 0;
    state.ensureCalls.length = 0;
    state.exitCodes.length = 0;
    state.logs.length = 0;
    state.errors.length = 0;
    process.exitCode = 0;
}

async function runRestart(unlock: any) {
    try {
        await unlock.main({ argv: ['node', 'unlock', 'restart'], startupGraceMs: 0 });
    } catch (err: any) {
        if (err && err.code === TEST_PROCESS_EXIT) return;
        throw err;
    }
}

runEsmMockStages(['restart_password_gate'], async () => {
    let stageError: any = null;
    try {
        fs.writeFileSync(path.join(TEMP_PROFILE_ROOT, 'bots.json'), JSON.stringify({ bots: FIXTURE_BOTS }));
        installStubs();
        const unlock = require('../unlock');
        // Wrong password: authentication must fail before the daemon is
        // touched, so the live daemon (and its unlocked keys) survives.
        resetState();
        state.wrongPassword = true;
        let rejection: any = null;
        try {
            await runRestart(unlock);
        } catch (err) {
            rejection = err;
        }
        assert.ok(rejection, 'restart should fail when authentication fails');
        assert.ok(
            /Incorrect master password/.test(String(rejection.message)),
            'restart should surface the authentication error'
        );
        assert.deepStrictEqual(
            state.events,
            ['authenticate'],
            'authentication must be the only credential step when the password is wrong'
        );
        assert.strictEqual(state.ensureCalls.length, 0, 'no daemon should be started after a failed authentication');
        assert.ok(
            !state.logs.some((line) => line.includes('Stop signal sent to credential daemon')),
            'a failed authentication must not report stopping the daemon'
        );

        // Correct password: authenticate, then stop, then start with the
        // already-verified secret (no second prompt).
        resetState();
        await runRestart(unlock);
        assert.deepStrictEqual(
            state.events,
            ['authenticate', 'stop', 'ensure'],
            'the daemon must only be stopped after authentication succeeds'
        );
        assert.strictEqual(state.ensureCalls.length, 1, 'a successful restart should start exactly one daemon');
        assert.ok(state.ensureCalls[0].vaultSecret, 'the verified secret should be handed to the daemon startup');
        assert.ok(
            state.logs.includes('✓ Authentication successful'),
            'a successful restart should confirm authentication'
        );
    } catch (err) {
        stageError = err;
    } finally {
        restoreStubs();
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }

    if (stageError) {
        console.error(stageError);
        process.exit(1);
    }
    console.log('restart password gate tests passed');
});
