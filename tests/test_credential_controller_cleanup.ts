const assert = require('assert');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// The controller and its deps are compiled ESM: require.cache stubbing does not
// reach them. Re-exec once under the ESM mock loader so defineEsmMock below can
// replace chain_keys / credential_runtime / bootstrap / policy. Without this
// the real chain_keys.authenticate() runs, prompts for a master password, and
// the test process exits 0 with no assertion ever executed.
esmMockEntry();

console.log('Running credential controller cleanup tests');

const { PATHS } = require('../modules/paths');

const originalSpawn = childProcess.spawn;
const originalTestSecret = process.env.TEST_DAEMON_SECRET;

const state = {
    ensurePolicyPaths: [],
    killSignals: [],
    spawnCount: 0,
    spawnOptions: [],
};

function installStubs() {
    defineEsmMockAbs(require.resolve('../modules/chain_keys'),
        ['authenticate', 'isDaemonReady', 'isDaemonResponsive', 'waitForDaemon', 'unlockWithPassword'], {
        authenticate: async () => 'test-secret',
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        waitForDaemon: async () => {},
        unlockWithPassword: () => 'test-secret',
    });

    defineEsmMockAbs(require.resolve('../modules/credential_runtime'),
        ['ensureCredentialRuntimeDirSync', 'getCredentialReadyFilePath', 'getCredentialRuntimeDir', 'getCredentialSocketPath', 'assertPrivatePathSecurity'], {
        ensureCredentialRuntimeDirSync: () => {},
        getCredentialReadyFilePath: () => '/tmp/dexbot-test.ready',
        getCredentialRuntimeDir: () => '/tmp',
        getCredentialSocketPath: () => '/tmp/dexbot-test.sock',
        assertPrivatePathSecurity: () => {},
    });

    defineEsmMockAbs(require.resolve('../modules/launcher/credential_bootstrap'), ['createPasswordBootstrapServer'], {
        createPasswordBootstrapServer: async () => ({
            socketPath: '/tmp/bootstrap.sock',
            close: () => {},
            waitForTransfer: async () => {},
        }),
    });

    defineEsmMockAbs(require.resolve('../modules/credential_policy'), ['ensurePolicyConfig'], {
        ensurePolicyConfig: (filePath) => {
            state.ensurePolicyPaths.push(filePath);
            return { accounts: {} };
        },
    });

    childProcess.spawn = (_command, _args, options) => {
        state.spawnCount += 1;
        state.spawnOptions.push(options);
        const child = new EventEmitter();
        child.killed = false;
        child.kill = (signal) => {
            state.killSignals.push(signal);
            child.killed = true;
        };
        process.nextTick(() => child.emit('close', 0));
        return child;
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    if (originalTestSecret === undefined) delete process.env.TEST_DAEMON_SECRET;
    else process.env.TEST_DAEMON_SECRET = originalTestSecret;
}

installStubs();
process.env.TEST_DAEMON_SECRET = 'should-not-leak';

const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');

(async () => {
    // NOTE: process.exit() does not unwind the stack, so restoreStubs() MUST
    // run in the finally BEFORE the exit call below.
    let passed = false;
    try {
        const controller = createCredentialDaemonController({
            root: '/tmp',
            socketPath: '/tmp/dexbot-test.sock',
            readyFilePath: '/tmp/dexbot-test.ready',
        });

        await controller.ensureCredentialDaemon();

        const startedAt = Date.now();
        await controller.stopManagedDaemon();
        const elapsed = Date.now() - startedAt;

        assert.strictEqual(state.spawnCount, 1, 'controller should spawn exactly one daemon');
        assert.deepStrictEqual(state.ensurePolicyPaths, [PATHS.PROFILES.DAEMON_POLICIES_JSON], 'controller should preflight policy before daemon spawn');
        assert.deepStrictEqual(state.killSignals, ['SIGTERM'], 'controller should terminate the daemon it owns');
        assert.ok(elapsed < 1000, `cleanup should resolve quickly after daemon exit, elapsed=${elapsed}ms`);
        assert.strictEqual(state.spawnOptions[0].env.TEST_DAEMON_SECRET, undefined, 'credential daemon controller should not forward arbitrary parent secrets');
        assert.strictEqual(state.spawnOptions[0].env.DEXBOT_CRED_BOOTSTRAP_SOCKET, undefined, 'credential daemon controller should not pass bootstrap socket env');
        assert.ok(state.spawnOptions[0].env.DEXBOT_CRED_BOOTSTRAP_PATH_FILE, 'credential daemon controller should pass bootstrap path file');
        assert.ok(state.spawnOptions[0].env.DEXBOT_CRED_DAEMON_SOCKET, 'credential daemon controller should pass daemon socket path');
        assert.ok(state.spawnOptions[0].env.DEXBOT_CRED_DAEMON_READY_FILE, 'credential daemon controller should pass daemon ready file path');
        passed = true;
    } finally {
        restoreStubs();
    }
    if (passed) {
        console.log('credential controller cleanup tests passed');
        process.exit(0);
    }
    process.exit(1);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
