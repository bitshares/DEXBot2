// Config snapshots process.env at module load, so the profile-root and PM2_HOME
// overrides MUST be set before any require(). A temp root keeps the detector
// hermetic: with no pid files it must not probe the real PM2 instance, and
// pointing PM2_HOME at an empty dir proves the fast-path skips `pm2 jlist`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-mode-'));
process.env.DEXBOT_PROFILE_ROOT = tmpRoot;
process.env.PM2_HOME = path.join(tmpRoot, 'pm2-home');
fs.mkdirSync(process.env.PM2_HOME, { recursive: true });

const assert = require('assert');
const {
    checkStatusTarget,
    detectRuntimeMode,
    isConfiguredBotName,
    listDexbotPm2Processes,
    resolveStatusRoute,
    runtimeControlHelp,
    runtimeModeLabel,
    RUNTIME_MODE_LABELS,
} = require('../modules/launcher/runtime_mode');
const { PATHS } = require('../modules/paths');

console.log('Running runtime-mode tests');

const MODES = ['monolithic', 'isolated', 'pm2', 'none'];

// Every mode has a label and a non-empty Runtime help group.
for (const mode of MODES) {
    assert.ok(RUNTIME_MODE_LABELS[mode], `${mode} should have a banner label`);
    const help = runtimeControlHelp(mode);
    assert.ok(Array.isArray(help) && help.length > 0, `${mode} should produce runtime help entries`);
    for (const entry of help) {
        assert.ok(entry.command && entry.description, `${mode} help entry needs a command and description`);
    }
}

// The instructions actually reflect the runtime: monolithic folds a bot target,
// isolated targets one bot, pm2 routes through `dexbot pm2`.
function described(mode, needle) {
    return runtimeControlHelp(mode).some((e) => `${e.command} ${e.description}`.includes(needle));
}

assert.ok(described('monolithic', 'folds into the whole runtime'), 'monolithic help should state the target fold');
assert.ok(!described('monolithic', 'Stop one bot'), 'monolithic help must not promise per-bot stop');
assert.ok(described('isolated', 'Stop one bot'), 'isolated help should offer per-bot stop');
assert.ok(described('pm2', 'pm2 reload'), 'pm2 help should surface `dexbot pm2 reload`');
assert.ok(described('pm2', 'pm2 delete'), 'pm2 help should surface `dexbot pm2 delete`');
assert.ok(!described('pm2', 'reload all bots'), 'pm2 help must not advertise the unlock runtime controls');

// With no runtime detected, help must present the standard monolithic runtime
// (the `dexbot start` default), not an empty or generic shell.
assert.deepStrictEqual(
    runtimeControlHelp('none'),
    runtimeControlHelp('monolithic'),
    'the no-runtime case should document the standard monolithic runtime'
);

// The banner calls out a credential daemon that outlived a `stop`, so it agrees
// with `dexbot status` (which reports the daemon).
function runtimeInfo(overrides) {
    return {
        mode: 'none',
        monolithicPid: 0,
        supervisorSocket: false,
        credentialDaemonAlive: false,
        credentialDaemonPid: 0,
        unlockRunning: false,
        pm2Processes: [],
        ...overrides,
    };
}
assert.strictEqual(
    runtimeModeLabel(runtimeInfo({ credentialDaemonAlive: true })),
    'credential daemon only — no bot runtime'
);
assert.strictEqual(
    runtimeModeLabel(runtimeInfo({ credentialDaemonAlive: false })),
    RUNTIME_MODE_LABELS.none
);
assert.strictEqual(
    runtimeModeLabel(runtimeInfo({ mode: 'isolated', supervisorSocket: true, unlockRunning: true })),
    RUNTIME_MODE_LABELS.isolated
);

// Configured-bot lookup is the validation seam the status/control paths share.
fs.writeFileSync(path.join(tmpRoot, 'bots.json'), JSON.stringify({ bots: [{ name: 'AAA-BBB', active: true }] }));
assert.strictEqual(isConfiguredBotName('aaa-bbb'), true, 'configured bot match should be case-insensitive');
assert.strictEqual(isConfiguredBotName('missing'), false, 'unknown names must not validate');

// status target contract used by the PM2/none branch: `all`/empty is silent,
// a real name is announced then ignored, an unknown one is rejected.
assert.deepStrictEqual(checkStatusTarget(null), { error: null, notice: null });
assert.deepStrictEqual(checkStatusTarget('all'), { error: null, notice: null });
assert.deepStrictEqual(checkStatusTarget('aaa-bbb'), {
    error: null,
    notice: "'status' is whole-runtime; ignoring target 'aaa-bbb'.",
});
assert.deepStrictEqual(checkStatusTarget('missing'), {
    error: "Bot 'missing' not found in bots.json",
    notice: null,
});

// status branch selection: PM2 wins when PM2 bots exist (incl. a stray daemon
// alongside PM2), otherwise a live unlock process (bot runtime or cred daemon)
// is shown, else the empty message.
assert.strictEqual(resolveStatusRoute(runtimeInfo({})), 'empty');
assert.strictEqual(resolveStatusRoute(runtimeInfo({ unlockRunning: true })), 'unlock');
assert.strictEqual(resolveStatusRoute(runtimeInfo({ credentialDaemonAlive: true, unlockRunning: true })), 'unlock');
assert.strictEqual(resolveStatusRoute(runtimeInfo({ mode: 'pm2', pm2Processes: [{ name: 'AAA-BBB' }] })), 'pm2');
assert.strictEqual(
    resolveStatusRoute(runtimeInfo({ credentialDaemonAlive: true, unlockRunning: true, mode: 'pm2', pm2Processes: [{ name: 'AAA-BBB' }] })),
    'pm2',
    'PM2 bots should win over a lingering credential daemon so banner and status agree'
);

// The detector is the shared source of truth for status + help. With a
// supervisor socket present it must report isolated without probing PM2.
fs.writeFileSync(PATHS.PROFILES.SUPERVISOR_SOCK, '');
const isolated = detectRuntimeMode();
assert.strictEqual(isolated.mode, 'isolated', 'supervisor socket should select isolated mode');
assert.strictEqual(isolated.supervisorSocket, true);
assert.strictEqual(isolated.unlockRunning, true);
assert.deepStrictEqual(isolated.pm2Processes, [], 'isolated runtime should skip the PM2 probe');

// No PM2 daemon pid file in the temp PM2_HOME: the pm2 probe must be skipped
// entirely (deterministic, no real `pm2 jlist` on the host).
assert.deepStrictEqual(listDexbotPm2Processes(), [], 'empty PM2_HOME should short-circuit the pm2 probe');

// Removing the marker clears the unlock-runtime verdict; with the empty
// PM2_HOME the follow-up detection cannot reach a real PM2 either.
fs.rmSync(PATHS.PROFILES.SUPERVISOR_SOCK, { force: true });
const cleared = detectRuntimeMode();
assert.strictEqual(cleared.unlockRunning, false);
assert.strictEqual(cleared.mode, 'none', 'no unlock runtime and no pm2 daemon should detect none');
assert.deepStrictEqual(cleared.pm2Processes, []);

console.log('Runtime-mode tests passed');
