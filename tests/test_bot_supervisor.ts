const assert = require('assert');
const { EventEmitter } = require('events');

console.log('Running bot supervisor tests');

process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = '1';

const { createBotSupervisor, parseCronExpression, getNextCronDate } = require('../modules/launcher/bot_supervisor');

function getScriptArg(args) {
    return args.find((arg) => /\.(?:ts|js)$/.test(String(arg))) || '';
}

// Production contract: the supervisor always spawns `[node, <dist entry>, ...]`
// — the compiled script path must be referenced directly, never a tsx-era
// source `.ts` entry or tsx loader invocation.
function assertCompiledNodeInvocation(call) {
    assert.strictEqual(call.command, process.execPath, 'supervised children should be spawned with plain node');
    assert.ok(
        call.args.every((arg) => !String(arg).endsWith('.ts') && !String(arg).includes('tsx')),
        'supervisor args must reference compiled entries without any tsx remnant'
    );
}

function createChild({ closeOnKill = true } = {}) {
    const child = new EventEmitter();
    child.pid = 12345;
    child.killed = false;
    child.killSignals = [];
    child.stdout = new EventEmitter();
    child.stdout.pipe = (dest) => dest;
    child.stderr = new EventEmitter();
    child.stderr.pipe = (dest) => dest;
    child.kill = (signal) => {
        child.killed = true;
        child.killSignals.push(signal);
        if (closeOnKill) {
            setImmediate(() => child.emit('close', null, signal));
        }
    };
    process.nextTick(() => child.emit('spawn'));
    return child;
}

async function testAmaBotsStartAdapterService() {
    const calls = [];
    const supervisor = createBotSupervisor({
        bots: [{ name: 'AMA-BOT', gridPrice: 'ama', active: true }],
        controlSocket: false,
        staggerDelayMs: 0,
        log: () => {},
        logError: () => {},
        spawnFn: (command, args, options) => {
            calls.push({ command, args, options });
            const child = createChild();
            setImmediate(() => child.emit('close', 0));
            return child;
        },
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.shutdown();

    for (const call of calls) assertCompiledNodeInvocation(call);
    assert.ok(
        calls.some((call) => getScriptArg(call.args).endsWith('market_adapter.js')),
        'AMA isolated mode should supervise dexbot-adapter like PM2'
    );
    assert.ok(
        calls.some((call) => getScriptArg(call.args).endsWith('bot.js') && call.args.includes('AMA-BOT')),
        'isolated mode should still supervise the selected bot process'
    );
}

async function testMemoryLimitRestartsProcess() {
    const calls = [];
    const supervisor = createBotSupervisor({
        bots: [{ name: 'MEM-BOT', active: true }],
        controlSocket: false,
        staggerDelayMs: 0,
        memoryCheckIntervalMs: 5,
        getChildRss: () => 300 * 1024 * 1024,
        log: () => {},
        logError: () => {},
        spawnFn: (command, args, options) => {
            calls.push({ command, args, options });
            return createChild();
        },
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await supervisor.shutdown();

    const botStarts = calls.filter((call) => getScriptArg(call.args).endsWith('bot.js') && call.args.includes('MEM-BOT'));
    assert.ok(botStarts.length >= 2, 'memory limit should restart the bot instead of leaving it stopped');
}

async function testRestartControlsExcludeUpdaterJob() {
    const calls = [];
    const supervisor = createBotSupervisor({
        bots: [{ name: 'CTRL-BOT', active: true }],
        controlSocket: false,
        staggerDelayMs: 0,
        log: () => {},
        logError: () => {},
        spawnFn: (command, args, options) => {
            calls.push({ command, args, options });
            const child = createChild();
            if (getScriptArg(args).endsWith('update.js')) {
                setImmediate(() => child.emit('close', 0));
            }
            return child;
        },
        updaterActive: true,
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 5));

    supervisor.restartRunning();
    await new Promise((resolve) => setTimeout(resolve, 5));

    supervisor.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 5));

    supervisor.restartAll();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.shutdown();

    for (const call of calls) assertCompiledNodeInvocation(call);
    const updaterStarts = calls.filter((call) => getScriptArg(call.args).endsWith('update.js'));
    const botStarts = calls.filter((call) => getScriptArg(call.args).endsWith('bot.js') && call.args.includes('CTRL-BOT'));

    assert.strictEqual(updaterStarts.length, 1, 'restart controls should not relaunch the one-shot updater job');
    assert.ok(botStarts.length >= 3, 'restart controls should still restart the managed bot runtime');
}

async function testAdapterRestartDoesNotKillReplacementChild() {
    let nextPid = 20000;
    let originalAdapter = null;
    let replacementAdapter = null;

    const supervisor = createBotSupervisor({
        bots: [{ name: 'AMA-RACE-BOT', gridPrice: 'ama', active: true }],
        controlSocket: false,
        staggerDelayMs: 0,
        log: () => {},
        logError: () => {},
        spawnFn: (command, args) => {
            const child = createChild();
            child.pid = nextPid++;
            if (getScriptArg(args).endsWith('market_adapter.js')) {
                if (!originalAdapter) {
                    originalAdapter = child;
                } else {
                    replacementAdapter = child;
                }
            }
            return child;
        },
        stopMarketAdapter: async () => {
            originalAdapter.emit('close', null, 'SIGTERM');
            await new Promise((resolve) => setImmediate(resolve));
            return { pid: originalAdapter.pid, stopped: true };
        },
    });

    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await supervisor.restartRunning();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.shutdown();

    assert.ok(replacementAdapter, 'adapter close during lock-file stop should spawn a replacement');
    assert.deepStrictEqual(
        replacementAdapter.killSignals,
        ['SIGTERM'],
        'replacement adapter should only be signaled by final supervisor shutdown, not by restart-running'
    );
}

async function testStableStartupRejectsImmediateExit() {
    const supervisor = createBotSupervisor({
        bots: [{ name: 'FAIL-BOT', active: true }],
        controlSocket: false,
        staggerDelayMs: 10,
        log: () => {},
        logError: () => {},
        spawnFn: () => {
            const child = createChild();
            setImmediate(() => child.emit('close', 0));
            return child;
        },
    });

    await supervisor.start();
    await assert.rejects(
        () => supervisor.waitForStableStartup({ timeoutMs: 50, pollIntervalMs: 5 }),
        /supervised startup failed: FAIL-BOT \(stopped\)/,
        'supervisor should reject startup when a managed bot exits during the grace period'
    );
    await supervisor.shutdown();
}

function testCronSchedulingHelpers() {
    const schedule = parseCronExpression('*/15 * * * *');
    const next = getNextCronDate(schedule, new Date('2026-05-24T10:07:22Z'));
    assert.strictEqual(next.toISOString(), '2026-05-24T10:15:00.000Z', 'cron helper should resolve the next matching minute');
}

(async () => {
    try {
        await testAmaBotsStartAdapterService();
        await testMemoryLimitRestartsProcess();
        await testRestartControlsExcludeUpdaterJob();
        await testAdapterRestartDoesNotKillReplacementChild();
        await testStableStartupRejectsImmediateExit();
        testCronSchedulingHelpers();
        console.log('bot supervisor tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
