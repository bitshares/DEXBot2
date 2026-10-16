const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { installPm2PathShim } = require('./helpers/pm2_path_shim');

console.log('Running PM2 stop/delete all tests');

// pm2.ts imports `spawn` and bot_settings statically, so neither
// childProcess.spawn replacement nor require.cache entries can intercept them
// on compiled ESM. The bots settings module is mocked through the loader-hook
// harness where needed, and the `pm2` binary is replaced by a recording PATH
// shim so spawned commands stay hermetic while still being assertable.
//
// Profile state (ecosystem.config.cjs presence) is controlled per stage via a
// temp DEXBOT_PROFILE_ROOT instead of fs.existsSync patching, which storage
// reads would bypass inconsistently.

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;

function writeBotsFixture(tempRoot) {
    fs.writeFileSync(path.join(tempRoot, 'bots.json'), JSON.stringify({
        bots: [
            { name: 'AAA-BBB', active: true },
            { name: '<bot-a>', active: true },
            { name: '<bot-b>', active: true },
        ],
    }));
}

function makeTempProfileRoot() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pm2-stopdel-'));
    process.env.DEXBOT_PROFILE_ROOT = tempRoot;
    return tempRoot;
}

function captureConsole({ logs, warnings }) {
    console.log = (...args) => {
        logs.push(args.map((part) => String(part)).join(' '));
    };
    console.warn = (...args) => {
        warnings.push(args.map((part) => String(part)).join(' '));
    };
}

function restoreConsole() {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
}

async function runOutputStage() {
    const tempRoot = makeTempProfileRoot();
    const shim = installPm2PathShim({
        rules: [
            {
                action: 'stop',
                targetIncludes: 'ecosystem.config.cjs',
                stdout: [
                    '[PM2] Applying action stopProcessId on app [AAA-BBB, <bot-a>, <bot-b>, dexbot-update](ids: [ 63, 64, 65, 66 ])',
                    '[PM2] [<bot-a>](64) ✓',
                    '[PM2] [AAA-BBB](63) ✓',
                    '[PM2] [dexbot-update](66) ✓',
                    '[PM2] [<bot-b>](65) ✓',
                    '┌────┬────────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐',
                    '│ id │ name           │ namespace   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │ cpu      │ mem      │ user     │ watching │',
                    '└────┴────────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘',
                ],
            },
            {
                action: 'delete',
                targetIncludes: 'ecosystem.config.cjs',
                stdout: [
                    '[PM2] Applying action deleteProcessId on app [AAA-BBB, <bot-a>, <bot-b>, dexbot-update](ids: [ 63, 64, 65, 66 ])',
                    '[PM2] [<bot-a>](64) ✓',
                    '[PM2] [AAA-BBB](63) ✓',
                    '[PM2] [dexbot-update](66) ✓',
                    '[PM2] [<bot-b>](65) ✓',
                    '┌────┬────────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐',
                    '│ id │ name           │ namespace   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │ cpu      │ mem      │ user     │ watching │',
                    '└────┴────────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘',
                ],
            },
        ],
    });

    try {
        writeBotsFixture(tempRoot);
        // The managed-apps path requires an existing ecosystem config.
        fs.writeFileSync(path.join(tempRoot, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');

        const { PATHS } = require('../modules/paths');
        const ecosystemConfigPath = PATHS.PROFILES.ECOSYSTEM_CONFIG_JS;

        // Captured only after modules/paths has been evaluated so its one-time
        // relocation notices (printed to console.warn at load) do not pollute
        // the warning assertions below.
        const logs: any[] = [];
        const warnings: any[] = [];
        captureConsole({ logs, warnings });

        const { deletePM2Processes, stopPM2Processes } = require('../pm2');

        await stopPM2Processes('all');
        assert.deepStrictEqual(
            logs,
            [
                'Stopping PM2 processes: all',
                '',
                '[PM2] [<bot-a>](64) ✓',
                '[PM2] [AAA-BBB](63) ✓',
                '[PM2] [dexbot-update](66) ✓',
                '[PM2] [<bot-b>](65) ✓',
                '',
                'All dexbot PM2 processes stopped.',
            ],
            'stop all should emit the compact ordered PM2 output'
        );
        assert.deepStrictEqual(
            shim.readCalls().filter((call) => call.args).map((call) => [call.args[0], call.args[1]]),
            [
                ['stop', 'dexbot-cred'],
                ['stop', ecosystemConfigPath],
            ],
            'stop all should act on dexbot-cred first (safety-stop) and then the managed ecosystem'
        );
        assert.deepStrictEqual(warnings, [], 'stop all should not warn in the normal path');

        logs.length = 0;
        await deletePM2Processes('all');
        assert.deepStrictEqual(
            logs,
            [
                'Deleting PM2 processes: all',
                '',
                '[PM2] [<bot-a>](64) ✓',
                '[PM2] [AAA-BBB](63) ✓',
                '[PM2] [dexbot-update](66) ✓',
                '[PM2] [<bot-b>](65) ✓',
                '',
                'All dexbot PM2 processes deleted.',
            ],
            'delete all should emit the compact ordered PM2 output'
        );
        assert.deepStrictEqual(
            shim.readCalls().filter((call) => call.args).map((call) => [call.args[0], call.args[1]]),
            [
                ['stop', 'dexbot-cred'],
                ['stop', ecosystemConfigPath],
                ['delete', 'dexbot-cred'],
                ['delete', ecosystemConfigPath],
            ],
            'delete all should act on dexbot-cred first (safety-stop) and then the managed ecosystem'
        );
        assert.deepStrictEqual(warnings, [], 'delete all should not warn in the normal path');

        restoreConsole();
        originalConsoleLog('output stage passed');
    } finally {
        restoreConsole();
        shim.restore();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function runWarnStage() {
    const tempRoot = makeTempProfileRoot();
    const shim = installPm2PathShim({ rules: [] });

    try {
        // The ecosystem config is intentionally absent so the all-target flow
        // regenerates it from bots.json, which the loader-hook mock makes
        // malformed — exercising the warn-and-continue path.
        writeBotsFixture(tempRoot);

        defineEsmMockAbs(require.resolve('../modules/bot_settings'), [
            'loadSettingsFile',
            'selectActiveBotEntries',
        ], {
            loadSettingsFile: () => {
                throw new Error('malformed bots.json');
            },
            selectActiveBotEntries: (config) => (config && Array.isArray(config.bots) ? config.bots.filter((bot) => bot.active !== false) : []),
        });

        // modules/paths first (one-time relocation notices go to the real
        // console), then capture for the assertions.
        require('../modules/paths');
        const logs: any[] = [];
        const warnings: any[] = [];
        captureConsole({ logs, warnings });

        const { deletePM2Processes, stopPM2Processes } = require('../pm2');

        await stopPM2Processes('all');
        await deletePM2Processes('all');

        assert.deepStrictEqual(
            shim.readCalls().filter((call) => call.args).map((call) => [call.args[0], call.args[1]]),
            [
                ['stop', 'dexbot-cred'],
                ['delete', 'dexbot-cred'],
            ],
            'all-target stop/delete should still act on dexbot-cred when bots.json is malformed'
        );
        assert.ok(
            warnings.some((message) => message.includes('Skipping managed bot stop')),
            'stop all should warn when managed bot config regeneration fails'
        );
        assert.ok(
            warnings.some((message) => message.includes('Skipping managed bot delete')),
            'delete all should warn when managed bot config regeneration fails'
        );

        restoreConsole();
        originalConsoleLog('warn stage passed');
    } finally {
        restoreConsole();
        shim.restore();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

runEsmMockStages(['output', 'warn'], async (stage: string) => {
    let exitCode = 0;
    try {
        if (stage === 'output') {
            await runOutputStage();
        } else if (stage === 'warn') {
            await runWarnStage();
        } else {
            throw new Error(`Unknown stage: ${stage}`);
        }
    } catch (err) {
        console.error(err);
        exitCode = 1;
    }
    process.exit(exitCode);
});
