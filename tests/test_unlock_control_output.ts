// Env/profile setup MUST happen before any require(): Config snapshots
// process.env at module load, and unlock_test_helpers resolves the bots
// fixture through PATHS.PROFILES.BOTS_JSON. A temp profile root keeps the
// control flows hermetic and makes the active-bot set deterministic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-unlock-control-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;

const assert = require('assert');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { makeFakeChild, stripAnsi, getActiveBotNames, hasActiveAmaBot } = require('./helpers/unlock_test_helpers');

console.log('Running unlock control output tests');

// unlock.ts statically imports sendControlCommand, so a require.cache entry
// cannot intercept it on compiled ESM — the supervisor-control module is
// mocked through the loader-hook harness instead. The credential_daemon
// controller is left real: control commands never touch it beyond harmless
// construction at module load.

const FIXTURE_BOTS = [
    { name: 'AAA-BBB', active: true },
    { name: '<bot>', active: true },
];

function formatBotCount(count) {
    return `${count} ${count === 1 ? 'bot' : 'bots'}`;
}

function assertRuntimeServicesListed(logs, command) {
    // Current production contract: delete/shutdown stop the daemon and
    // restart-all re-unlocks it, so all three list the credential daemon
    // service; stop-all releases bots only and must not list it.
    const listsCredentialDaemon = ['delete', 'shutdown', 'restart-all'].includes(command);
    if (listsCredentialDaemon) {
        assert.ok(logs.includes('- credential daemon'), `${command} controls should list the credential daemon service`);
    } else {
        assert.ok(!logs.includes('- credential daemon'), `${command} should not list the credential daemon service`);
    }
    if (hasActiveAmaBot()) {
        assert.ok(logs.includes('- market adapter'), 'whole-runtime control should list the market adapter service');
    }
}

async function runControlOutputStage() {
    fs.writeFileSync(path.join(TEMP_PROFILE_ROOT, 'bots.json'), JSON.stringify({ bots: FIXTURE_BOTS }));

    const { PATHS } = require('../modules/paths');

    const monolithicPidPath = PATHS.PROFILES.MONOLITHIC_PID;
    const monolithicCredPidPath = PATHS.PROFILES.MONOLITHIC_CRED_PID;
    const monolithicBotInfoPath = PATHS.PROFILES.MONOLITHIC_BOT_INFO;

    const originalExistsSync = fs.existsSync;
    const originalReadFileSync = fs.readFileSync;
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    const originalProcessExit = process.exit;
    const childProcess = require('child_process');
    const originalSpawn = childProcess.spawn;

    const logs: any[] = [];
    const errors: any[] = [];
    const warns: any[] = [];
    const state = {
        controlCalls: [],
        staleMonolithicPid: false,
        supervisorDeleteTransient: false,
    };

    defineEsmMockAbs(require.resolve('../modules/launcher/supervisor_control'), [
        'sendControlCommand',
    ], {
        sendControlCommand: async (cmd) => {
            if (cmd.cmd === 'delete' && state.supervisorDeleteTransient) {
                throw new Error('No supervisor socket found. Start bots with: dexbot start --isolated');
            }
            state.controlCalls.push(cmd);
            return { ok: true };
        },
    });

    function installStubs() {
        // handleControl terminates every command via process.exit(0); swallow
        // it so several control invocations can run in sequence while still
        // recording the requested exit code.
        process.exit = ((code = 0) => {
            process.exitCode = code;
        }) as any;

        // Only used by launcher spawn paths; control commands never spawn,
        // but keep them inert just in case.
        childProcess.spawn = () => makeFakeChild();

        fs.existsSync = (filePath) => {
            const normalized = String(filePath);
            if (normalized === monolithicPidPath) {
                return state.staleMonolithicPid;
            }
            if (normalized === monolithicCredPidPath) {
                return false;
            }
            return originalExistsSync(filePath);
        };

        fs.readFileSync = (filePath, options) => {
            if (String(filePath) === monolithicPidPath && state.staleMonolithicPid) {
                return '999999';
            }
            if (String(filePath) === monolithicBotInfoPath) {
                const err = new Error('ENOENT: no such file or directory');
                (err as any).code = 'ENOENT';
                throw err;
            }
            return originalReadFileSync(filePath, options);
        };

        console.log = (...args) => {
            const line = args.map((part) => String(part)).join(' ').trim();
            if (line) logs.push(line);
        };
        console.error = (...args) => {
            const line = args.map((part) => String(part)).join(' ').trim();
            if (line) errors.push(line);
        };
        console.warn = (...args) => {
            const line = args.map((part) => String(part)).join(' ').trim();
            if (line) warns.push(line);
        };
    }

    function restoreStubs() {
        process.exit = originalProcessExit;
        childProcess.spawn = originalSpawn;
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
    }

    function resetState() {
        process.exitCode = 0;
        logs.length = 0;
        errors.length = 0;
        warns.length = 0;
        state.controlCalls.length = 0;
        state.staleMonolithicPid = false;
        state.supervisorDeleteTransient = false;
    }

    installStubs();

    const unlock = require('../unlock');

    async function runControl(args) {
        resetState();
        await unlock.main({ argv: ['node', 'unlock', ...args], startupGraceMs: 0 });
    }

    async function assertTargetControl(command, actionWord, botName) {
        await runControl([command, botName]);
        assert.deepStrictEqual(state.controlCalls[0], { cmd: command, bot: botName });
        assert.ok(logs.includes(`DEXBot2 ${actionWord} 1 bot`), `should print the ${actionWord} summary`);
        assert.ok(logs.some((line) => stripAnsi(line).includes(`- ${botName}`)), 'should list the affected bot');
    }

    async function assertRejectedControl(args, messageSubstring) {
        await runControl(args);
        assert.strictEqual(state.controlCalls.length, 0, `rejected control '${args.join(' ')}' must not reach the supervisor socket`);
        assert.ok(
            errors.some((line) => stripAnsi(line).includes(messageSubstring)),
            `rejected control '${args.join(' ')}' should report: ${messageSubstring}`
        );
    }

    async function assertStatusTargetFolded(botName) {
        await runControl(['status', botName]);
        assert.deepStrictEqual(state.controlCalls[0], { cmd: 'status' }, 'status <bot> should fold to a whole-runtime status');
        assert.ok(
            warns.some((line) => line.includes('whole-runtime') && line.includes(botName)),
            'status <bot> should warn that the target is ignored'
        );
    }

    async function assertWholeRuntimeControl(command, actionWord) {
        const activeBotNames = getActiveBotNames();
        await runControl([command]);
        assert.deepStrictEqual(state.controlCalls[0], { cmd: command === 'shutdown' ? 'delete' : command });
        assert.ok(logs.includes(`DEXBot2 ${actionWord} ${formatBotCount(activeBotNames.length)}`), `should print the ${actionWord} summary`);
        for (const botName of activeBotNames) {
            assert.ok(logs.some((line) => stripAnsi(line).includes(`- ${botName}`)), `should list active bot ${botName}`);
        }
        assertRuntimeServicesListed(logs, command);
    }

    async function assertStaleControl(command, actionWord) {
        resetState();
        state.staleMonolithicPid = true;
        state.supervisorDeleteTransient = true;
        const activeBotNames = getActiveBotNames();
        await runControl([command]);

        assert.ok(logs.includes(`DEXBot2 ${actionWord} ${formatBotCount(activeBotNames.length)}`), 'stale control should print the shared summary');
        for (const botName of activeBotNames) {
            assert.ok(logs.some((line) => stripAnsi(line).includes(`- ${botName}`)), `stale control should list active bot ${botName}`);
        }
        assertRuntimeServicesListed(logs, command);
        assert.ok(!logs.some((line) => line.includes('(stale PID file)')), 'stale control should not fall back to the legacy stale message');
    }

    try {
        const activeBotNames = getActiveBotNames();
        assert.strictEqual(activeBotNames.length, FIXTURE_BOTS.length, 'test fixture should expose every bot as active');
        assert.ok(activeBotNames.length > 0, 'test requires at least one active bot');

        await assertTargetControl('stop', 'stopping', activeBotNames[0]);
        await assertTargetControl('restart', 'restarting', activeBotNames[0]);
        await assertRejectedControl(['delete', activeBotNames[0]], 'whole-runtime control');
        await assertRejectedControl(['status', 'DOES-NOT-EXIST'], 'not found in bots.json');
        // Isolated pass-through: an unknown (or renamed) name is left for the
        // supervisor, which knows the bots it actually runs.
        await assertTargetControl('reload', 'reloading', 'DOES-NOT-EXIST');
        await assertStatusTargetFolded(activeBotNames[0]);
        await assertWholeRuntimeControl('stop-all', 'stopping');
        await assertWholeRuntimeControl('restart-all', 'restarting');
        await assertWholeRuntimeControl('delete', 'shutting down');
        await assertWholeRuntimeControl('shutdown', 'shutting down');
        await assertStaleControl('delete', 'shutting down');
        await assertStaleControl('shutdown', 'shutting down');

        restoreStubs();
        originalConsoleLog('unlock control output tests passed');
    } catch (err) {
        restoreStubs();
        throw err;
    } finally {
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }
}

runEsmMockStages(['control_output'], async () => {
    let exitCode = 0;
    try {
        await runControlOutputStage();
    } catch (err) {
        console.error(err);
        exitCode = 1;
    }
    process.exit(exitCode);
});
