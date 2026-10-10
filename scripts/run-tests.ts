import { globSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn } from 'child_process';
import path from 'node:path';

// ── Intentionally uses process.env directly, NOT Config ───────────
// This script runs BEFORE any module is loaded — Config's startup
// snapshot doesn't apply here.  NODE_OPTIONS is read, mutated, and
// re-read in the same function; RUN_LIVE_BITSHARES_TESTS is a
// test-only flag with no place in a production Config object.
// ──────────────────────────────────────────────────────────────────

// By default Node warnings are left visible so they surface in the
// diagnostics summary below. Set DEXBOT_SUPPRESS_WARNINGS=1 to add
// --no-warnings to every child process (suppresses circular-dependency
// spam at the cost of hiding the warnings the summary is meant to catch).
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS || '';
if (process.env.DEXBOT_SUPPRESS_WARNINGS === '1' && !process.env.NODE_OPTIONS.includes('--no-warnings')) {
    process.env.NODE_OPTIONS += ' --no-warnings';
}

// Tests that require RUN_LIVE_BITSHARES_TESTS=1 (live blockchain connection).
// They are excluded from `npm test` and run only when the env var is set.
const liveTestFiles = new Set([
    'dist/tests/test_any_pair.js',
    'dist/tests/test_blockchain_fill_history.js',
    'dist/tests/test_market_book_xaut.js',
    'dist/tests/test_market_price.js',
    'dist/tests/test_trade_history.js',
    'dist/tests/test_connection_trace.js',
    'dist/tests/test_unlock_foreign_cred_daemon_live.js',
    // Diagnostic / live-chain scripts with no offline-relevant assertions.
    // They connect to the real BitShares node (or exit(0) vacuously when
    // offline), so they must not count as passing unit tests under `npm test`.
    'dist/tests/test_open_orders.js',
    'dist/tests/test_debug_orderbook.js',
    'dist/tests/test_twentix_only.js',
    'dist/tests/test_fee_cache.js',
    'dist/tests/test_subscriptions.js',
    'dist/tests/test_fills.js',
    'dist/tests/test_funds.js',
]);

const testFiles = globSync(['dist/tests/test_*.js', 'dist/claw/tests/test_*.js']).sort();

const runLiveTests = process.env.RUN_LIVE_BITSHARES_TESTS === '1';
let skippedLive = 0;

// ── Per-run log sink ──────────────────────────────────────────────
// Every child's stdout/stderr is echoed to the console (live) AND
// appended to a timestamped file so the full run can be inspected later.
const logDir = path.join(process.cwd(), 'tests', 'tmp');
mkdirSync(logDir, { recursive: true });
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(logDir, `test-run-${runStamp}.log`);
appendFileSync(logPath, `# DEXBot2 test run @ ${new Date().toISOString()}\n`);

function footer(text: string) {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    appendFileSync(logPath, text.endsWith('\n') ? text : text + '\n');
}

// ── Diagnostic scanning ──────────────────────────────────────────
// These patterns are matched against each test's captured output. Any
// hits are aggregated into a summary at the end so warnings, cache
// surprises, deprecations, memory pressure, etc. are not lost in the log.
interface DiagRule { name: string; re: RegExp }
const diagRules: DiagRule[] = [
    { name: 'warn',                re: /\bwarn/i },
    { name: 'error',               re: /\berror\b|\bexception\b/i },
    { name: 'cache',               re: /\bcache/i },
    { name: 'circular dependency', re: /circular dependency/i },
    { name: 'deprecation',         re: /deprecat/i },
    { name: 'openssl/cipher',      re: /openssl|unsupported.*cipher|MAXBYTES/i },
    { name: 'memory/heap',         re: /heap|out of memory|allocation/i },
    { name: 'timeout/latency',     re: /timeout|latency|slow/i },
    { name: 'ESM/strict-mode',     re: /ECMAScript|ES module|strict mode|__esModule/i },
    { name: 'experimental',        re: /experimental (warning|feature)|\bexperimental:/i },
];

interface DiagHit { test: string; rule: string; line: string }
const diagHits: DiagHit[] = [];

// ── Test runner ────────────────────────────────────────────────────
interface TestResult {
    test: string;
    elapsedMs: number;
    status: number | null;
    signal: string | null;
    failed: boolean;
    timedOut?: boolean;
}

// Per-test watchdog: a test that neither exits nor errors would otherwise
// stall the whole sequential run. Override with DEXBOT_TEST_TIMEOUT_MS.
const TEST_TIMEOUT_MS = Number(process.env.DEXBOT_TEST_TIMEOUT_MS || 240000);

function runOne(testFile: string): Promise<TestResult> {
    return new Promise((resolve) => {
        const start = performance.now();
        const child = spawn(process.execPath, [testFile], {
            stdio: ['inherit', 'pipe', 'pipe'],
            cwd: process.cwd(),
            env: process.env,
        });
        let timedOut = false;

        const killTimer = setTimeout(() => {
            timedOut = true;
            footer(`--- [TIMEOUT] ${testFile} exceeded ${TEST_TIMEOUT_MS} ms — killing`);
            child.kill('SIGTERM');
            setTimeout(() => {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }, 5000);
        }, TEST_TIMEOUT_MS);
        killTimer.unref?.();

        // Capture + echo + log the child output while buffering for scans.
        let buffer = '';
        const accumulate = (chunk: Buffer) => {
            process.stdout.write(chunk);
            appendFileSync(logPath, chunk);
            buffer += chunk.toString();
        };
        child.stdout.on('data', accumulate);
        child.stderr.on('data', accumulate);

        child.on('close', (code, signal) => {
            clearTimeout(killTimer);
            // Slice the buffered output into lines and scan for diagnostics.
            const seenForTest = new Set<string>();
            for (const line of buffer.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                for (const rule of diagRules) {
                    if (rule.re.test(trimmed)) {
                        const key = `${rule.name}|${trimmed}`;
                        if (seenForTest.has(key)) continue;
                        seenForTest.add(key);
                        diagHits.push({ test: testFile, rule: rule.name, line: trimmed });
                    }
                }
            }

            resolve({
                test: testFile,
                elapsedMs: performance.now() - start,
                status: code,
                signal,
                failed: timedOut || code !== 0 || signal !== null,
                timedOut,
            });
        });

        child.on('error', (err) => {
            clearTimeout(killTimer);
            resolve({
                test: testFile,
                elapsedMs: performance.now() - start,
                status: 1,
                signal: null,
                failed: true,
            });
            appendFileSync(logPath, `[SPAWN ERROR] ${err.message}\n`);
        });
    });
}

// ── Main loop ────────────────────────────────────────────────────────
// Files run sequentially by default. Set DEXBOT_TEST_CONCURRENCY>1 to run
// that many files in parallel (opt-in: several tests share tests/tmp paths, so
// parallelism must be requested deliberately rather than assumed safe).
async function main() {
    let startTotal = performance.now();
    const concurrency = (() => {
        const raw = Number(process.env.DEXBOT_TEST_CONCURRENCY);
        return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
    })();

    const toRun: string[] = [];
    for (const testFile of testFiles) {
        if (liveTestFiles.has(testFile) && !runLiveTests) {
            skippedLive++;
            continue;
        }
        toRun.push(testFile);
    }

    const results: TestResult[] = new Array(toRun.length);

    if (concurrency <= 1) {
        for (let i = 0; i < toRun.length; i++) {
            const testFile = toRun[i];
            footer(`\n=== [TEST] ${testFile} ===`);
            const r = await runOne(testFile);
            results[i] = r;
            const statusTag = r.timedOut ? 'TIMEOUT' : (r.failed ? 'FAIL' : 'PASS');
            footer(`--- [${statusTag}] ${testFile}  ${r.elapsedMs.toFixed(0)} ms${r.signal ? ` (signal ${r.signal})` : ''}`);
        }
    } else {
        footer(`\n(running up to ${concurrency} test files in parallel)`);
        let next = 0;
        const worker = async () => {
            while (true) {
                const i = next++;
                if (i >= toRun.length) return;
                const testFile = toRun[i];
                footer(`\n=== [TEST] ${testFile} ===`);
                const r = await runOne(testFile);
                results[i] = r;
                const statusTag = r.timedOut ? 'TIMEOUT' : (r.failed ? 'FAIL' : 'PASS');
                footer(`--- [${statusTag}] ${testFile}  ${r.elapsedMs.toFixed(0)} ms${r.signal ? ` (signal ${r.signal})` : ''}`);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, toRun.length) }, worker));
    }

    const totalMs = performance.now() - startTotal;

    // ── Summary ──────────────────────────────────────────────────────
    footer('\n' + '='.repeat(72));
    footer('TEST RUN SUMMARY');
    footer('='.repeat(72));

    footer('\n-- per-test results --');
    const failed = results.filter((r) => r.failed);
    const passed = results.filter((r) => !r.failed);
    const totalPass = passed.length;
    const totalFail = failed.length;

    for (const r of results) {
        const marker = r.failed ? 'FAIL' : 'ok';
        footer(`  [${marker}]  ${String(Math.round(r.elapsedMs)).padStart(9, ' ')} ms  ${r.test}`);
    }

    footer('\n-- totals --');
    footer(`  files:      ${results.length}`);
    footer(`  passed:     ${totalPass}`);
    footer(`  failed:     ${totalFail}`);
    footer(`  skippedLive ${skippedLive}`);
    footer(`  total time: ${(totalMs / 1000).toFixed(2)} s`);

    const sorted = [...results].sort((a, b) => b.elapsedMs - a.elapsedMs);
    footer('\n-- slowest tests (top 10) --');
    if (sorted.length === 0) {
        footer('  (none)');
    } else {
        for (const r of sorted.slice(0, 10)) {
            footer(`  ${String(Math.round(r.elapsedMs)).padStart(9, ' ')} ms  ${r.test}`);
        }
    }

    if (failed.length > 0) {
        footer('\n-- failed tests --');
        for (const f of failed) {
            footer(`  FAIL  ${f.test}  (${f.elapsedMs.toFixed(1)} ms)`);
        }
    }

    // ── Diagnostics: anything that looks like a warning/cache/etc. ──
    footer('\n-- diagnostics ( in no particular order ) --');
    const diagByRule = new Map<string, DiagHit[]>();
    for (const h of diagHits) {
        if (!diagByRule.has(h.rule)) diagByRule.set(h.rule, []);
        diagByRule.get(h.rule)!.push(h);
    }
    let diagCount = 0;
    for (const [rule, hits] of diagByRule) {
        footer(`  [${rule}]`);
        const seenLines = new Set<string>();
        for (const h of hits) {
            if (seenLines.has(h.line)) continue;
            seenLines.add(h.line);
            diagCount++;
            footer(`    ${h.test}`);
            footer(`      ${truncate(h.line, 220)}`);
        }
    }
    if (diagCount === 0) {
        footer('  no warnings / cache / deprecation / error lines detected');
    } else {
        footer(`  ${diagCount} distinct diagnostic line(s) — see: ${logPath}`);
    }

    footer(`\nfull log written to: ${logPath}`);

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});