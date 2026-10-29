// Env/profile setup MUST happen before any require(): Config snapshots
// process.env at module load (tests/helpers/* transitively load config), so
// the isolated-mode flags below would otherwise be missed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-unlock-poll-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;
process.env.DEXBOT_ISOLATED_FOREGROUND = '1';
process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = '1';
process.env.DEXBOT_SUPERVISOR_SOCKET = '/tmp/dexbot-test-poll.sock';

const assert = require('assert');
const { setCachedModule } = require('./helpers/module_cache_stub');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { makeControllerStub } = require('./helpers/unlock_test_helpers');

console.log('Running unlock isolated poll rejection tests');

// unlock.ts statically imports createCredentialDaemonController, so a
// require.cache entry cannot intercept it on compiled ESM — the controller
// module is mocked through the loader-hook harness instead. bot_supervisor is
// reached through unlock's lazy require(), so its cache stub still works.
//
// Contract: when a supervised bot's getStatus() throws, unlock.main() must
// reject instead of polling forever.

const supervisorPath = require.resolve('../modules/launcher/bot_supervisor');

function createThrowingGetStatusSupervisor() {
    return {
        start: async () => {},
        waitForStableStartup: async () => {},
        shutdown: async () => {},
        shutdownSignalHandler: () => {},
        getStatus: () => {
            throw new Error('mock getStatus failure');
        },
        hasUserStopped: () => false,
        printStatusSummary: () => {},
        restartRunning: () => {},
        restartAll: () => {},
        stopAll: () => {},
    };
}

async function runIsolatedPollRejectStage() {
    fs.writeFileSync(path.join(TEMP_PROFILE_ROOT, 'bots.json'), JSON.stringify({
        bots: [{ name: 'AAA-BBB', active: true }],
    }));

    const controller = makeControllerStub();

    defineEsmMockAbs(require.resolve('../modules/launcher/credential_daemon'), [
        'createCredentialDaemonController',
        'clearVaultSecret',
    ], {
        createCredentialDaemonController: () => controller,
        clearVaultSecret: () => {},
    });

    setCachedModule(supervisorPath, {
        createBotSupervisor: () => createThrowingGetStatusSupervisor(),
        SOCKET_PATH: '/tmp/dexbot-test-poll.sock',
    });

    const childProcess = require('child_process');
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = () => {
        throw new Error('isolated foreground mode should not spawn child processes in this test');
    };

    try {
        const unlock = require('../unlock');

        const result = await Promise.race([
            unlock.main({
                argv: ['node', 'unlock', '--isolated'],
                startupGraceMs: 0,
                // Poll fast: the contract under test is that a throwing
                // getStatus() rejects at the first poll, not the wall-clock
                // cadence of the production 1s supervisor poll.
                isolatedPollIntervalMs: 5,
            })
                .then(() => ({ settled: true, reason: 'resolved' }))
                .catch(() => ({ settled: true, reason: 'rejected' })),
            new Promise((resolve) => setTimeout(() => resolve({ settled: false, reason: 'timeout' }), 5000)),
        ]);

        assert.strictEqual(result.settled, true, 'main() should settle when getStatus() throws, not hang');
        assert.notStrictEqual(result.reason, 'timeout', 'main() must not time out (would indicate a hang)');
        console.log('unlock isolated poll rejection tests passed');
    } finally {
        childProcess.spawn = originalSpawn;
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }
}

runEsmMockStages(['isolated_poll_reject'], async () => {
    let exitCode = 0;
    try {
        await runIsolatedPollRejectStage();
    } catch (err) {
        console.error(err);
        exitCode = 1;
    }
    process.exit(exitCode);
});
