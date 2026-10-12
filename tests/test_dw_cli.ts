const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running dw cli tests');

// `dexbot dw` (scripts/dw.ts) is a thin entry over the shared chart pipeline
// (scripts/chart_command.ts, run('dw')): only the renderer differs. These
// tests cover the dw-specific command labeling (usage/errors/logs) and the
// offline entry-point behavior (help / missing target / bad flag must not
// touch the network).

const { parseArgs } = require('../scripts/chart_command');
require('../scripts/dw'); // entry must load WITHOUT auto-invoking the pipeline

const DW_SCRIPT = path.join(__dirname, '..', 'scripts', 'dw.js');

function testParseArgsLabelsDw() {
    assert.throws(() => parseArgs(['--bogus'], 'dw'), /Usage: dexbot dw /);
    assert.throws(() => parseArgs(['A/B', 'extra'], 'dw'), /Only one target is supported\. Usage: dexbot dw /);
    // Flags parse identically to tv — only the usage text differs.
    const parsed = parseArgs(['BTS/HONEST.USD', '--feed', '--month', '2', '--chart', 'out.html'], 'dw');
    assert.strictEqual(parsed.target, 'BTS/HONEST.USD');
    assert.strictEqual(parsed.source, 'feed');
    assert.strictEqual(parsed.months, 2);
    assert.strictEqual(parsed.chart, 'out.html');
    // Default command stays tv for callers that omit it (legacy test usage).
    assert.throws(() => parseArgs(['--bogus']), /Usage: dexbot tv /);
}

function testMonthFlagCanonicalWithAlias() {
    // `--month` is canonical, `--months` is a pure alias — both spellings and
    // both forms (space / `=`) parse to the same value.
    assert.strictEqual(parseArgs(['A/B', '--month', '2']).months, 2);
    assert.strictEqual(parseArgs(['A/B', '--months', '4']).months, 4);
    assert.strictEqual(parseArgs(['A/B', '--month=6']).months, 6);
    assert.strictEqual(parseArgs(['A/B', '--months=5']).months, 5);
    // No flag → the --month default (3 months).
    assert.strictEqual(parseArgs(['A/B']).months, 3);
    // Invalid values always report the canonical `--month` label.
    assert.throws(() => parseArgs(['A/B', '--months', '0']), /--month: invalid value/);
    assert.throws(() => parseArgs(['A/B', '--months=abc']), /--month: invalid value/);
    assert.throws(() => parseArgs(['A/B', '--month=-1']), /--month: invalid value/);
}

function testRunIsSharedPipeline() {
    const chartCommand = require('../scripts/chart_command');
    assert.strictEqual(typeof chartCommand.run, 'function', 'scripts/chart_command exports the shared run() pipeline');
}

// The three CLI invocations below are offline and independent (help, missing
// target, unknown flag), so run them concurrently instead of paying node
// startup + module load three times in series.
function script(argv) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [DW_SCRIPT, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('dw.js timed out')); }, 30000);
        child.stdout.on('data', (d) => { stdout += String(d); });
        child.stderr.on('data', (d) => { stderr += String(d); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

async function testHelpPrintsDwUsageOffline() {
    const res = await script(['--help']);
    assert.strictEqual(res.status, 0, `--help should exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /Usage: dexbot dw /);
    assert.match(res.stdout, /--month N/);
}

async function testNoTargetPrintsUsageAndFails() {
    const res = await script([]);
    assert.strictEqual(res.status, 1, 'missing target should exit 1');
    assert.match(res.stdout, /Usage: dexbot dw /);
}

async function testUnknownFlagFailsWithDwUsage() {
    const res = await script(['--bogus']);
    assert.strictEqual(res.status, 1, 'unknown flag should exit 1');
    assert.match(res.stderr, /\[dw\] Error: Unknown flag "--bogus"\. Usage: dexbot dw /);
}

async function run() {
    testParseArgsLabelsDw();
    testMonthFlagCanonicalWithAlias();
    testRunIsSharedPipeline();
    await Promise.all([
        testHelpPrintsDwUsageOffline(),
        testNoTargetPrintsUsageAndFails(),
        testUnknownFlagFailsWithDwUsage(),
    ]);
}

run()
    .then(() => {
        console.log('dw cli tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });
