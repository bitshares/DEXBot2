const assert = require('assert');
const fs = require('fs');
const path = require('path');
const chainKeys = require('../modules/chain_keys');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
const { ensureDir, unlink: safeUnlink } = require('../modules/storage').getStorage();

console.log('Running stale daemon cleanup tests');

const TEST_ROOT = path.join(__dirname, '..', 'tmp', 'test-stale-daemon');
const SOCKET_PATH = path.join(TEST_ROOT, 'test.sock');
const READY_FILE = path.join(TEST_ROOT, 'test.ready');

// Save original spawn before any module caches it
const originalSpawn = childProcess.spawn;

async function setupFiles() {
    if (!fs.existsSync(TEST_ROOT)) {
        ensureDir(TEST_ROOT);
    }

    safeUnlink(SOCKET_PATH)

    // Create a real socket file using the ORIGINAL spawn, then kill it
    const child = originalSpawn(process.execPath, ['-e', `
        const net = require('net');
        const server = net.createServer();
        server.listen('${SOCKET_PATH}', () => {
            process.send('ready');
        });
    `], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });

    await new Promise((resolve, reject) => {
        // Clear (and never hold the loop open with) the watchdog timer once the
        // child reports ready — otherwise it keeps the test process alive for
        // the full 2s after every assertion has passed.
        const timer = setTimeout(() => reject(new Error('Child timeout')), 2000);
        timer.unref?.();
        child.on('message', (msg) => {
            if (msg === 'ready') { clearTimeout(timer); resolve(undefined); }
        });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    // Kill it forcefully so it doesn't cleanup the socket
    child.kill('SIGKILL');
    await new Promise(resolve => child.on('exit', resolve));

    if (!fs.existsSync(SOCKET_PATH)) {
        throw new Error('Failed to create stale socket file');
    }

    const stat = fs.lstatSync(SOCKET_PATH);
    if (!stat.isSocket()) {
        throw new Error('Created file is not a socket');
    }

    fs.chmodSync(SOCKET_PATH, 0o600);
    fs.writeFileSync(READY_FILE, 'stale-ready');
    fs.chmodSync(READY_FILE, 0o600);
}

function cleanupFiles() {
    safeUnlink(SOCKET_PATH)
    safeUnlink(READY_FILE)
    try { fs.rmdirSync(TEST_ROOT); } catch (err) {}
}

function makeMockChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
    };
    return child;
}

(async () => {
    try {
        await setupFiles();

        // 1. Verify isDaemonReady returns true for existing files
        assert.ok(
            chainKeys.isDaemonReady({ socketPath: SOCKET_PATH, readyFilePath: READY_FILE }),
            'isDaemonReady should be true if files exist'
        );

        // 2. Verify isDaemonResponsive returns false because no one is listening
        const responsive = await chainKeys.isDaemonResponsive(
            { socketPath: SOCKET_PATH, readyFilePath: READY_FILE },
            100
        );
        assert.strictEqual(
            responsive,
            false,
            'isDaemonResponsive should be false for stale files'
        );

        // 3. Stub the chain_keys module in the require cache BEFORE the
        // controller is loaded. The controller imports chain_keys via
        // `import * as`, which resolves a separate namespace object from the
        // `require()` binding above — mutating chainKeys.authenticate here
        // would NOT be seen by the controller and would trigger the real
        // master-password prompt. Cache stubbing is the only reliable hook.
        const chainKeysPath = require.resolve('../modules/chain_keys');
        const originalChainKeys = require.cache[chainKeysPath];
        setCachedModule(chainKeysPath, {
            isDaemonReady: chainKeys.isDaemonReady,
            isDaemonResponsive: chainKeys.isDaemonResponsive,
            waitForDaemon: chainKeys.waitForDaemon,
            authenticate: async () => 'test',
        });

        // 4. Mock credential_bootstrap BEFORE requiring the controller
        const bootstrapPath = require.resolve('../modules/launcher/credential_bootstrap');
        const originalBootstrapModule = setCachedModule(bootstrapPath, {
            createPasswordBootstrapServer: async () => ({
                socketPath: '/tmp/test-bootstrap.sock',
                close() {},
                waitForTransfer: async () => {},
            }),
        });

        // 5. Install spawn mock BEFORE requiring the controller module
        // so the controller caches the mock reference
        const mockChildren = [];
        const net = require('net');
        childProcess.spawn = () => {
            const child = makeMockChild();
            mockChildren.push(child);

            // Simulate that the daemon creates the socket + ready file so
            // waitForDaemon can proceed.  We start a real net server so
            // the path is a genuine socket; we close it once the controller
            // has seen the files and moved on.
            const server = net.createServer();
            server.listen(SOCKET_PATH, () => {
                try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (err) {}
                fs.writeFileSync(READY_FILE, 'new-ready');
                try { fs.chmodSync(READY_FILE, 0o600); } catch (err) {}

                // Give waitForDaemon time to see the files, then close
                setTimeout(() => {
                    server.close(() => {
                        child.emit('close', 0);
                    });
                }, 300);
            });

            return child;
        };

        // Clear module cache so require picks up the mocked spawn and bootstrap
        const controllerModulePath = require.resolve('../modules/launcher/credential_daemon');
        delete require.cache[controllerModulePath];
        const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');

        const controller = createCredentialDaemonController({
            root: TEST_ROOT,
            socketPath: SOCKET_PATH,
            readyFilePath: READY_FILE,
        });

        try {
            // Controller isDaemonReady should reflect responsiveness, not just file existence
            const controllerReady = await controller.isDaemonReady();
            assert.strictEqual(
                controllerReady,
                false,
                'controller.isDaemonReady should be false for stale files'
            );

            // Trigger ensureCredentialDaemon — stale files should be removed,
            // then it will try to start a new daemon (which our mock handles)
            await controller.ensureCredentialDaemon();

            // The stale files were removed and a new mock daemon was started,
            // so both files should now exist (new ones created by the mock).
            assert.ok(
                fs.existsSync(SOCKET_PATH),
                'socket should exist after mock daemon startup'
            );
            assert.ok(
                fs.existsSync(READY_FILE),
                'ready file should exist after mock daemon startup'
            );
            // Verify the ready file was rewritten (not the stale content)
            const readyContent = fs.readFileSync(READY_FILE, 'utf8');
            assert.strictEqual(
                readyContent,
                'new-ready',
                'ready file should contain new content from mock daemon'
            );
        } finally {
            restoreCachedModule(chainKeysPath, originalChainKeys);
            childProcess.spawn = originalSpawn;
            restoreCachedModule(bootstrapPath, originalBootstrapModule);
        }

        console.log('stale daemon cleanup tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        cleanupFiles();
    }
})();
