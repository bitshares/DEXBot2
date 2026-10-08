/**
 * tests/test_unlock_worker_drain.ts
 *
 * Regression test for `drainMonolithicWorkers` (unlock.ts). The helper backs
 * the stop/worker-drain fix: `stop` must wait until no `dexbot` worker remains
 * so a fast stop->start cannot spawn a second worker over the live orders.
 *
 * The helper is scanned on every stop path — including the stale/absent pid
 * file paths that a pid-file-only guard cannot see — so its contract is:
 *   - return true once no worker matches (the normal case here);
 *   - return false (with a warning) when the deadline is already spent,
 *     never hang.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Env must be set before requiring unlock: Config snapshots process.env at
// module load and several launcher paths resolve through the profile root.
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-worker-drain-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;

const assert = require('assert');

async function main() {
    console.log('Running unlock worker-drain tests...');

    const unlock = require('../unlock');
    assert.strictEqual(typeof unlock.drainMonolithicWorkers, 'function', 'helper must be exported');

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    try {
        // No dexbot worker runs inside the test process tree, so the scan
        // drains immediately. A generous deadline proves it does not stall.
        const started = Date.now();
        const drained = await unlock.drainMonolithicWorkers(5000);
        assert.strictEqual(drained, true, 'no worker present -> drained');
        assert.ok(Date.now() - started < 5000, 'drain must return as soon as the scan is clear');

        // Zero budget exercises the deadline path deterministically: the loop
        // body never runs, so the helper reports not-drained and warns.
        warnings.length = 0;
        const timedOut = await unlock.drainMonolithicWorkers(0);
        assert.strictEqual(timedOut, false, 'spent deadline -> not drained');
        assert.ok(warnings.some((w) => w.includes('still alive')), 'deadline exhaustion must warn');
    } finally {
        console.warn = originalWarn;
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }

    console.log('\n✓ unlock worker-drain tests passed!');
}

main().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});
