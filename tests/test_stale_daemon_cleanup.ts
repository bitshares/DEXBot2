const assert = require('assert');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const net = require('net');
const { EventEmitter } = require('events');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM deps are not reachable via require.cache. Re-exec under the ESM
// mock loader and replace chain_keys/credential_bootstrap so the controller
// never calls the real interactive authenticate() (which prompts and leaves the
// process exiting 0 with no assertion run). chain_keys' readiness helpers are
// reimplemented faithfully because both the controller and this test consume
// them through the same module.
esmMockEntry();

console.log('Running stale daemon cleanup tests');

defineEsmMockAbs(require.resolve('../modules/chain_keys'),
    ['authenticate', 'isDaemonReady', 'isDaemonResponsive', 'waitForDaemon', 'unlockWithPassword'], {
    authenticate: async () => 'test',
    unlockWithPassword: () => 'test',
    isDaemonReady: (options: any = {}) => fs.existsSync(options.socketPath) && fs.existsSync(options.readyFilePath),
    isDaemonResponsive: (options: any = {}, timeout = 2000) => new Promise((resolve) => {
        if (!(fs.existsSync(options.socketPath) && fs.existsSync(options.readyFilePath))) return resolve(false);
        const socket = net.createConnection(options.socketPath);
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; socket.destroy(); resolve(false); } }, timeout);
        socket.on('connect', () => socket.write('{}\n'));
        socket.on('data', (data) => { if (!settled && String(data).trim().length > 0) { settled = true; clearTimeout(timer); socket.end(); resolve(true); } });
        socket.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
        socket.on('end', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    }),
    waitForDaemon: async (maxWaitMs = 60000, options: any = {}) => {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            if (fs.existsSync(options.socketPath) && fs.existsSync(options.readyFilePath)) return;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`Daemon did not start within ${maxWaitMs}ms`);
    },
});
defineEsmMockAbs(require.resolve('../modules/launcher/credential_bootstrap'), ['createPasswordBootstrapServer'], {
    createPasswordBootstrapServer: async () => ({
        socketPath: '/tmp/test-bootstrap.sock',
        close() {},
        waitForTransfer: async () => {},
    }),
});

const { ensureDir, unlink: safeUnlink } = require('../modules/storage').getStorage();

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

        // Resolve chain_keys through the async ESM loader so the mocked module is
        // used. A synchronous require() here would load the real chain_keys into
        // the ESM cache first, and the controller's import would then see it too
        // (defeating the mock and reaching the interactive authenticate prompt).
        const chainKeys = await import('../modules/chain_keys.js');

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

        // 3. chain_keys and credential_bootstrap are mocked via the ESM loader
        // at the top of this file, so the controller cannot prompt.
        // 4. Install spawn mock BEFORE requiring the controller module
        // so the controller caches the mock reference
        const mockChildren = [];
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
            childProcess.spawn = originalSpawn;
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
