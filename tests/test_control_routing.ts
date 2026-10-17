// Config snapshots process.env at module load, so point the profile root at a
// temp dir before any require() that pulls in config.ts. This test only reads
// static files (bots.json is never touched), but the launcher modules still
// resolve PATHS at import time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-control-routing-'));
process.env.DEXBOT_PROFILE_ROOT = tmpRoot;

const assert = require('assert');
const { resolveControlRouting, normalizeControlTarget } = require('../modules/launcher/monolithic_runtime');
const { parseUnlockArgs } = require('../modules/launcher/launch_modes');

console.log('Running control routing tests');

// The alias rule is single-sourced: `all`/empty select the whole runtime.
assert.strictEqual(normalizeControlTarget('all'), null);
assert.strictEqual(normalizeControlTarget(undefined), null);
assert.strictEqual(normalizeControlTarget(null), null);
assert.strictEqual(normalizeControlTarget(''), null);
assert.strictEqual(normalizeControlTarget('bot-a'), 'bot-a');

function route(cmd, target, monolithicLive) {
    return resolveControlRouting({ cmd, target, monolithicLive });
}

function control(argv) {
    return parseUnlockArgs(argv).control;
}

// Isolated runtime: a bot target is passed through untouched (the supervisor
// validates the name against the bots it actually runs).
assert.deepStrictEqual(
    route('reload', 'bot-a', false),
    { cmd: 'reload', target: 'bot-a', requestedTarget: 'bot-a', folded: false, notice: null, reject: null }
);
assert.deepStrictEqual(
    route('stop', 'bot-a', false),
    { cmd: 'stop', target: 'bot-a', requestedTarget: 'bot-a', folded: false, notice: null, reject: null }
);
assert.deepStrictEqual(
    route('restart', 'bot-a', false),
    { cmd: 'restart', target: 'bot-a', requestedTarget: 'bot-a', folded: false, notice: null, reject: null }
);

// Live monolithic runtime: the single worker owns every bot, so a target folds
// into the whole-runtime command with a notice. The folded target stays
// available as requestedTarget so the caller can validate the name before the
// fold takes effect (a typo must not reload/stop every bot).
for (const cmd of ['stop', 'reload', 'restart']) {
    const r = route(cmd, 'bot-a', true);
    assert.strictEqual(r.cmd, `${cmd}-all`, `${cmd} <bot> should fold to ${cmd}-all`);
    assert.strictEqual(r.target, null, `${cmd} <bot> should drop the target`);
    assert.strictEqual(r.requestedTarget, 'bot-a', `${cmd} <bot> should keep the requested target for validation`);
    assert.strictEqual(r.folded, true, `${cmd} <bot> should be marked folded`);
    assert.ok(r.notice && r.notice.includes('Monolithic'), `${cmd} <bot> should carry a monolithic notice`);
    assert.strictEqual(r.reject, null, `${cmd} <bot> should not be rejected`);
}

// `all` is a whole-runtime selector in both modes and all commands.
for (const live of [false, true]) {
    assert.deepStrictEqual(route('reload', 'all', live), { cmd: 'reload-all', target: null, requestedTarget: null, folded: false, notice: null, reject: null });
    assert.deepStrictEqual(route('stop', 'all', live), { cmd: 'stop-all', target: null, requestedTarget: null, folded: false, notice: null, reject: null });
    assert.deepStrictEqual(route('restart', 'all', live), { cmd: 'restart-all', target: null, requestedTarget: null, folded: false, notice: null, reject: null });
    assert.deepStrictEqual(route('delete', 'all', live), { cmd: 'delete', target: null, requestedTarget: null, folded: false, notice: null, reject: null });
    assert.deepStrictEqual(route('status', 'all', live), { cmd: 'status', target: null, requestedTarget: null, folded: false, notice: null, reject: null });
}

// The resolver is also the canonical normalizer: a bare whole-runtime command
// must produce the `*-all` form the monolithic dispatch expects.
assert.strictEqual(route('stop', null, false).cmd, 'stop-all');
assert.strictEqual(route('restart', undefined, true).cmd, 'restart-all');
assert.strictEqual(route('reload', null, false).cmd, 'reload-all');

// delete never accepts a bot target (it tears the whole runtime down).
for (const live of [false, true]) {
    const r = route('delete', 'bot-a', live);
    assert.strictEqual(r.cmd, 'delete');
    assert.strictEqual(r.target, null);
    assert.strictEqual(r.requestedTarget, 'bot-a');
    assert.strictEqual(r.folded, true);
    assert.ok(r.reject, 'delete <bot> must be rejected');
    assert.strictEqual(r.notice, null);
}

// status is whole-runtime: a bot target is folded away with a notice, and the
// caller validates the (folded) target before printing it.
for (const live of [false, true]) {
    const r = route('status', 'bot-a', live);
    assert.strictEqual(r.cmd, 'status');
    assert.strictEqual(r.target, null);
    assert.strictEqual(r.requestedTarget, 'bot-a');
    assert.strictEqual(r.folded, true);
    assert.ok(r.notice && r.notice.includes('whole-runtime'), 'status <bot> should note the ignored target');
    assert.strictEqual(r.reject, null);
}

// Internal aliases normalize to their canonical control names.
assert.strictEqual(route('stat', null, false).cmd, 'status');
assert.strictEqual(route('shutdown', null, false).cmd, 'delete');
assert.strictEqual(route('stat', 'bot-a', true).cmd, 'status');

// Parser normalization: `delete all` is the whole runtime, `delete <bot>`
// keeps the target so routing can validate/reject it.
assert.deepStrictEqual(control(['node', 'unlock', 'delete']), { cmd: 'delete', target: null });
assert.deepStrictEqual(control(['node', 'unlock', 'delete', 'all']), { cmd: 'delete', target: null });
assert.deepStrictEqual(control(['node', 'unlock', 'delete', 'bot-a']), { cmd: 'delete', target: 'bot-a' });
assert.deepStrictEqual(control(['node', 'unlock', 'reload', 'all']), { cmd: 'reload-all', target: null });
assert.deepStrictEqual(control(['node', 'unlock', 'reload', 'bot-a']), { cmd: 'reload', target: 'bot-a' });
assert.deepStrictEqual(control(['node', 'unlock', 'stop', 'all']), { cmd: 'stop-all', target: null });
assert.deepStrictEqual(control(['node', 'unlock', 'restart', 'all']), { cmd: 'restart-all', target: null });

console.log('Control routing tests passed');
