const assert = require('assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM deps are not reachable via require.cache: re-exec under the ESM
// mock loader so chain_keys/bootstrap can be replaced. Otherwise the real
// chain_keys.authenticate() prompts and the process exits 0 with no assertions.
esmMockEntry();

console.log('Running credential daemon controller output tests');

const originalSpawn = childProcess.spawn;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

const logs: any[] = [];
const warns: any[] = [];
const errors: any[] = [];
let spawnCount = 0;
const spawnCalls: any[] = [];
let authenticateCalls = 0;

function installStubs() {
    defineEsmMockAbs(require.resolve('../modules/chain_keys'),
        ['authenticate', 'isDaemonReady', 'isDaemonResponsive', 'waitForDaemon', 'unlockWithPassword'], {
        authenticate: async () => { authenticateCalls += 1; return 'test-password'; },
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        waitForDaemon: async () => {},
        unlockWithPassword: () => 'test-password',
    });

    defineEsmMockAbs(require.resolve('../modules/launcher/credential_bootstrap'), ['createPasswordBootstrapServer'], {
        createPasswordBootstrapServer: async () => ({
            socketPath: '/tmp/bootstrap.sock',
            close() {},
            waitForTransfer: async () => {},
        }),
    });

    childProcess.spawn = (command, args, options) => {
        spawnCount += 1;
        spawnCalls.push({ command, args, options });

        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {
            child.killed = true;
            child.emit('close', 0);
        };
        child.killed = false;

        process.nextTick(() => child.emit('close', 0));
        return child;
    };

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.warn = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) warns.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) errors.push(line);
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
}

installStubs();

const controllerRoot = '/tmp/dexbot2-test';
fs.mkdirSync(controllerRoot, { recursive: true });

const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');

(async () => {
    try {
        const controller = createCredentialDaemonController({
            root: controllerRoot,
            socketPath: `${controllerRoot}/dexbot-cred.sock`,
            readyFilePath: `${controllerRoot}/dexbot-cred.ready`,
            pollIntervalMs: 1,
        });
        logs.length = 0;
        warns.length = 0;
        errors.length = 0;
        spawnCalls.length = 0;
        spawnCount = 0;
        authenticateCalls = 0;

        await controller.ensureCredentialDaemon();

        assert.strictEqual(spawnCount, 1, 'controller should spawn the daemon once');
        assert.deepStrictEqual(
            spawnCalls[0].args,
            [require('path').resolve(__dirname, '..', 'credential-daemon.js')],
            'controller should launch the compiled credential daemon directly'
        );
        assert.deepStrictEqual(logs, [], 'controller startup should not emit info logs');
        assert.deepStrictEqual(warns, [], 'controller startup should not emit warnings');
        assert.deepStrictEqual(errors, [], 'controller startup should not emit errors');
        assert.strictEqual(authenticateCalls, 1, 'interactive startup should authenticate once');

        // A caller that already verified the master password can pass the
        // secret in; the controller must not prompt (authenticate) again.
        const verifiedSecret = { kind: 'vault', version: 1, vaultKeyHex: '00'.repeat(32) };
        await controller.ensureCredentialDaemon({ vaultSecret: verifiedSecret });
        assert.strictEqual(spawnCount, 2, 'controller should spawn the daemon for a pre-authenticated restart');
        assert.strictEqual(authenticateCalls, 1, 'a pre-authenticated secret must bypass the password prompt');
        assert.strictEqual(verifiedSecret.vaultKeyHex, null, 'the launcher-side secret must be cleared after the handoff');

        // A failure before the daemon is spawned (here: the bootstrap path
        // file cannot be written) must still clear the handed-off secret.
        const failingSecret = { kind: 'vault', version: 1, vaultKeyHex: '00'.repeat(32) };
        const bootstrapPathFile = require('path').join(controllerRoot, '.dexbot-cred-bootstrap-path');
        fs.rmSync(bootstrapPathFile, { force: true });
        fs.mkdirSync(bootstrapPathFile);
        try {
            await assert.rejects(
                () => controller.ensureCredentialDaemon({ vaultSecret: failingSecret }),
                /Cannot write bootstrap path file/,
                'a bootstrap path failure should reject the daemon startup'
            );
        } finally {
            fs.rmSync(bootstrapPathFile, { recursive: true, force: true });
        }
        assert.strictEqual(failingSecret.vaultKeyHex, null, 'a failed handoff must still clear the launcher-side secret');

        restoreStubs();
        originalConsoleLog('credential daemon controller output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
