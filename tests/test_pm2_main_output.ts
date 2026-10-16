// The passive "new version available" notice must not reach the npm registry
// (or the captured output) from a test. Config snapshots process.env at load
// time, so this has to be set before the first require().
process.env.DEXBOT_SKIP_VERSION_NOTICE = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { installPm2PathShim } = require('./helpers/pm2_path_shim');

console.log('Running PM2 main output tests');

// pm2.ts imports spawn/execSync and chain_keys/credential_bootstrap/
// bitshares_client/bot_settings statically, so neither childProcess.spawn
// replacement nor require.cache entries can intercept them on compiled ESM.
// The network/auth/settings modules are mocked through the loader-hook
// harness, and the `pm2` binary is replaced by a recording PATH shim that
// replays the canned PM2 output, keeping the whole run offline.

process.env.TEST_PM2_SECRET = 'should-not-leak';
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pm2-main-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalStdoutIsTTY = process.stdout.isTTY;
const originalNoColor = process.env.NO_COLOR;

const logs: any[] = [];
const errors: any[] = [];

function setStdoutTTY(value) {
    Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
        writable: true,
    });
}

function writeBotsFixture() {
    // generateEcosystemConfig checks existence of bots.json at the storage
    // level before the (mocked) settings loader runs.
    fs.writeFileSync(path.join(TEMP_PROFILE_ROOT, 'bots.json'), JSON.stringify({
        bots: [
            { name: 'AAA-BBB', active: true },
            { name: '<bot-a>', active: true },
            { name: '<bot-b>', active: true },
        ],
    }));
}

function installModuleMocks() {
    defineEsmMockAbs(require.resolve('../modules/bitshares_client'), [
        'waitForConnected',
    ], {
        waitForConnected: async () => {},
    });

    defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
        'checkKeysFileSecurity',
        'isDaemonReady',
        'isDaemonResponsive',
        'authenticate',
        'unlockWithPassword',
        'waitForDaemon',
    ], {
        checkKeysFileSecurity: () => {},
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        authenticate: async () => 'test-password',
        unlockWithPassword: () => 'test-password',
        waitForDaemon: async () => {},
    });

    defineEsmMockAbs(require.resolve('../modules/launcher/credential_bootstrap'), [
        'createPasswordBootstrapServer',
    ], {
        createPasswordBootstrapServer: async () => ({
            socketPath: '/tmp/bootstrap.sock',
            close() {},
            waitForTransfer: async () => {},
        }),
    });

    defineEsmMockAbs(require.resolve('../modules/bot_settings'), [
        'loadSettingsFile',
        'selectActiveBotEntries',
    ], {
        loadSettingsFile: () => ({
            config: {
                bots: [
                    { name: 'AAA-BBB', active: true },
                    { name: '<bot-a>', active: true },
                    { name: '<bot-b>', active: true },
                ],
            },
        }),
        selectActiveBotEntries: (config) => (config && Array.isArray(config.bots) ? config.bots.filter((bot) => bot.active !== false) : []),
    });
}

function installPathShim() {
    return installPm2PathShim({
        rules: [
            // `pm2 delete dexbot-cred` before the fresh start reports "not found".
            { action: 'delete', stderr: ['Process or Namespace dexbot-cred not found'], code: 1 },
            {
                action: 'start',
                targetIncludes: 'credential-daemon.js',
                stdout: [
                    '[PM2] Starting /root/DEXBot2/credential-daemon.js in fork_mode (1 instance)',
                    '[PM2] Done.',
                    '┌────┬────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐',
                    '│ id │ name               │ mode     │ ↺    │ status    │ cpu      │ memory   │',
                    '├────┼────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤',
                    '│ 57 │ dexbot-cred        │ fork     │ 0    │ online    │ 0%       │ 60.7mb   │',
                    '└────┴────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘',
                ],
            },
            {
                action: 'start',
                targetIncludes: 'ecosystem.config.cjs',
                stdout: [
                    '[PM2] cron restart at 0 0 * * *',
                    '[PM2][WARN] Applications AAA-BBB, <bot-a>, <bot-b>, dexbot-update not running, starting...',
                    '[PM2] App [AAA-BBB] launched (1 instances)',
                    '[PM2] App [<bot-a>] launched (1 instances)',
                    '[PM2] App [<bot-b>] launched (1 instances)',
                    '[PM2] App [dexbot-update] launched (1 instances)',
                    '┌────┬────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐',
                    '│ id │ name               │ mode     │ ↺    │ status    │ cpu      │ memory   │',
                    '├────┼────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤',
                    '│ 58 │ AAA-BBB            │ fork     │ 0    │ online    │ 0%       │ 44.1mb   │',
                    '│ 59 │ <bot-a>              │ fork     │ 0    │ online    │ 0%       │ 42.6mb   │',
                    '│ 60 │ <bot-b>              │ fork     │ 0    │ online    │ 0%       │ 21.9mb   │',
                    '│ 61 │ dexbot-update      │ fork     │ 0    │ online    │ 0%       │ 26.6mb   │',
                    '└────┴────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘',
                ],
            },
        ],
    });
}

function stripAnsi(text) {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function logsIncludePlain(expected) {
    return logs.some((line) => stripAnsi(line) === expected);
}

async function runMainOutputStage() {
    writeBotsFixture();

    const shim = installPathShim();
    try {
        installModuleMocks();

        setStdoutTTY(true);
        delete process.env.NO_COLOR;

        console.log = (...args) => {
            const line = args.map((part) => String(part)).join(' ');
            if (line.trim()) logs.push(line.trim());
        };
        console.error = (...args) => {
            const line = args.map((part) => String(part)).join(' ');
            if (line.trim()) errors.push(line.trim());
        };

        const { PATHS } = require('../modules/paths');
        const ecosystemConfigPath = PATHS.PROFILES.ECOSYSTEM_CONFIG_JS;
        const { main } = require('../pm2');

        await main();

        assert.ok(logsIncludePlain('Connected to BitShares'), 'launcher should still report BitShares connectivity');
        assert.ok(logsIncludePlain('✓ Authentication successful'), 'launcher should still report successful authentication');
        assert.ok(logs.includes('Number active bots: 3'), 'launcher should still report the active bot count');
        assert.ok(logs.includes('Starting PM2 with all services...'), 'launcher should still report PM2 startup');
        assert.ok(logsIncludePlain('DEXBot2 started successfully!'), 'launcher should still print the final success banner');
        assert.ok(logs.includes('If dexbot-cred stops, rerun `dexbot pm2` to unlock it again.'), 'launcher should still print the final advisory');
        assert.ok(!logs.some((line) => line.includes('Connecting to BitShares...')), 'launcher should not print a separate connection banner');
        assert.ok(!logs.some((line) => line.includes('Authenticating master password...')), 'launcher should not print an auth banner');
        assert.ok(!logs.some((line) => line.includes('Ecosystem configuration generated')), 'launcher should not announce ecosystem config generation');
        assert.ok(!logs.some((line) => line.includes('[PM2] Starting /root/DEXBot2/credential-daemon.js')), 'launcher should strip the credential daemon start banner');
        assert.ok(!logs.some((line) => line.includes('[PM2] Done.')), 'launcher should strip the PM2 done banner');
        assert.ok(!logs.some((line) => line.includes('[PM2] cron restart at')), 'launcher should strip cron restart output');
        assert.ok(!logs.some((line) => line.includes('[PM2][WARN] Applications')), 'launcher should strip PM2 not-running warnings');
        assert.ok(!logs.some((line) => line.includes('(1 instances)')), 'launcher should strip PM2 instance counts');
        assert.ok(!logs.some((line) => line.includes('(1 instance)')), 'launcher should strip PM2 instance counts');
        assert.ok(logs.includes('[PM2] App [dexbot-cred] launched'), 'launcher should list the credential daemon launch with other compact PM2 output');
        assert.ok(logs.includes('[PM2] App [AAA-BBB] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(logs.includes('[PM2] App [<bot-a>] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(logs.includes('[PM2] App [<bot-b>] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(logs.includes('[PM2] App [dexbot-update] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(!logs.some((line) => line.startsWith('┌') || line.startsWith('│') || line.startsWith('├') || line.startsWith('└')), 'launcher should strip PM2 table output');
        assert.deepStrictEqual(errors, [], 'launcher should not emit console errors during a normal start');

        const calls = shim.readCalls();
        const credSpawn = calls.find((call) => call.args[0] === 'start' && String(call.args[1]).includes('credential-daemon.js'));
        const appSpawn = calls.find((call) => call.args[0] === 'start' && String(call.args[1]).includes('ecosystem.config.cjs'));
        assert.ok(credSpawn, 'launcher should still start the credential daemon via pm2');
        assert.ok(appSpawn, 'launcher should still start the PM2 ecosystem');
        assert.strictEqual(credSpawn.env.TEST_PM2_SECRET, 'unset', 'credential daemon PM2 launch should not inherit arbitrary parent secrets');
        assert.strictEqual(credSpawn.env.DEXBOT_CRED_BOOTSTRAP_SOCKET, 'unset', 'credential daemon PM2 launch should not receive bootstrap socket env');
        assert.strictEqual(appSpawn.env.TEST_PM2_SECRET, 'unset', 'ecosystem PM2 launch should not inherit arbitrary parent secrets');
        assert.strictEqual(appSpawn.env.DEXBOT_CRED_BOOTSTRAP_SOCKET, 'unset', 'ecosystem PM2 launch should not receive bootstrap env');

        assert.ok(
            logs.some((line) => line.includes('\x1b[1;92m') && line.includes('Connected to BitShares')),
            'PM2 launcher should color connection success green'
        );
        assert.ok(
            logs.some((line) => line.includes('\x1b[1;92m') && line.includes('✓ Authentication successful')),
            'PM2 launcher should color authentication success green'
        );
        assert.ok(
            logs.some((line) => line.includes('\x1b[1;92m') && line.includes('DEXBot2 started successfully!')),
            'PM2 launcher should color the final success banner green'
        );

        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        originalConsoleLog('PM2 main output tests passed');
    } finally {
        shim.restore();
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        setStdoutTTY(originalStdoutIsTTY);
        if (originalNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = originalNoColor;
        }
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }
}

runEsmMockStages(['main_output'], async () => {
    let exitCode = 0;
    try {
        await runMainOutputStage();
    } catch (err) {
        console.error(err);
        exitCode = 1;
    }
    process.exit(exitCode);
});
