const assert = require('assert');

console.log('Running PM2 logic tests');

const {
    buildCredentialDaemonApp,
    buildEcosystemApps,
    buildScopedChildEnv,
    countManagedBots,
    isServiceApp,
    needsMarketAdapter,
    usesAmaGridPrice,
} = require('../pm2');
const { selectActiveBotEntries } = require('../modules/bot_settings');

assert.strictEqual(isServiceApp({ name: 'dexbot-cred' }), true, 'credential daemon should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'dexbot-update' }), true, 'updater should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'dexbot-adapter' }), true, 'adapter should be treated as a service app');
assert.strictEqual(isServiceApp({ name: 'AAA-BBB' }), false, 'bot processes should not be treated as service apps');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 'ama' }), true, 'ama should require the market adapter');
assert.strictEqual(usesAmaGridPrice({ gridPrice: 'book' }), false, 'book should not require the market adapter');
assert.strictEqual(usesAmaGridPrice({ gridPrice: '  AMA4  ' }), true, 'ama4 matching should be case-insensitive');
assert.strictEqual(needsMarketAdapter([{ gridPrice: 'book' }, { gridPrice: null }]), false, 'non-AMA bots should not require the market adapter');
assert.strictEqual(needsMarketAdapter([{ gridPrice: 'book' }, { gridPrice: 'ama2' }]), true, 'any AMA bot should require the market adapter');
const adapterApp = buildEcosystemApps([{ name: 'AMA-BOT', gridPrice: 'ama' }], { includeUpdater: false })
    .find((app) => app.name === 'dexbot-adapter');
assert.ok(adapterApp, 'AMA bots should include the market adapter service');
assert.strictEqual(adapterApp.args, undefined, 'PM2 ecosystem should keep market adapter logging enabled by default');

assert.strictEqual(
    countManagedBots([
        { name: 'dexbot-cred' },
        { name: 'dexbot-adapter' },
        { name: 'dexbot-update' },
        { name: 'AAA-BBB' },
        { name: 'USD-BTS' },
    ]),
    2,
    'managed bot count should exclude service processes'
);

assert.deepStrictEqual(selectActiveBotEntries({ bots: [] }), [], 'empty bot config should remain empty');
assert.deepStrictEqual(
    selectActiveBotEntries({ bots: [{ name: 'AAA-BBB', active: false }, { name: 'H-BTS', active: true }] }),
    [{ name: 'H-BTS', active: true }],
    'inactive bots should be filtered out'
);
const clawOnlyApps = buildEcosystemApps([], { includeUpdater: false });
assert.deepStrictEqual(
    clawOnlyApps.map((app) => app.name),
    [],
    'claw-only ecosystem should not contain any bot-managed apps'
);

const credentialApp = buildCredentialDaemonApp({
    credentialEnv: {
        DEXBOT_CRED_BOOTSTRAP_PATH_FILE: '/tmp/test-bootstrap-path',
    },
});
assert.deepStrictEqual(
    credentialApp.env,
    {
        DEXBOT_CRED_DAEMON_SOCKET: credentialApp.env.DEXBOT_CRED_DAEMON_SOCKET,
        DEXBOT_CRED_DAEMON_READY_FILE: credentialApp.env.DEXBOT_CRED_DAEMON_READY_FILE,
        DEXBOT_CRED_BOOTSTRAP_PATH_FILE: '/tmp/test-bootstrap-path',
    },
    'credential bootstrap env should only be attached to dexbot-cred'
);
assert.strictEqual(credentialApp.autorestart, false, 'credential daemon should require a fresh unlock after stop/crash');
assert.strictEqual(credentialApp.merge_logs, true, 'credential daemon should merge logs into its single out_file like managed apps');
process.env.TEST_PM2_SECRET = 'should-not-leak';
const scopedEnv = buildScopedChildEnv({ extra: { DEXBOT_CRED_BOOTSTRAP_PATH_FILE: '/tmp/test-bootstrap-path' } });
delete process.env.TEST_PM2_SECRET;
assert.strictEqual(scopedEnv.TEST_PM2_SECRET, undefined, 'scoped child env should not forward arbitrary parent secrets');
assert.strictEqual(scopedEnv.DEXBOT_CRED_BOOTSTRAP_PATH_FILE, '/tmp/test-bootstrap-path', 'scoped child env should keep explicit launcher extras');
assert.strictEqual(
    buildEcosystemApps([{ name: 'AAA-BBB' }], { includeUpdater: false, credentialEnv: { DEXBOT_CRED_BOOTSTRAP_PATH_FILE: '/tmp/test-bootstrap-path' } })
        .find((app) => app.name === 'AAA-BBB').env,
    undefined,
    'bot apps should not receive credential bootstrap env'
);

console.log('PM2 logic tests passed');
process.exit(0);
