// Must be before any require() due to the config-caching trap: Config
// snapshots process.env at module-load time, so DEXBOT_SKIP_VERSION_NOTICE
// has to be set here rather than inside a test case.
process.env.DEXBOT_SKIP_VERSION_NOTICE = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running version notice tests');

const {
    compareVersions,
    detectInstallKind,
    startVersionStatusCheck,
    formatVersionStatusLine,
    printVersionStatus,
    flushVersionStatus,
    printVersionStatusWhenReady,
    resolveReleaseSources,
    deriveGithubReleaseUrl,
    probeReleaseSources,
    startStagedVersionStatus,
    printVersionStatusOrHeader,
    flushVersionStatusOrHeader,
} = require('../modules/version_notice');
const { CLI_COLORS } = require('../modules/cli_colors');

/** Notice-only view for the latch/throttle cases; the module itself exposes
 *  only the status so no caller can render its own copy of the message. */
const noticeOf = async (options: any) => (await startVersionStatusCheck(options))?.notice ?? null;
const { Config } = require('../modules/config');

let passed = 0;
let total = 0;

function check(label: string, ok: any, detail?: any) {
    total++;
    if (ok) { passed++; console.log(`  ✓ ${label}`); }
    else console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-version-notice-'));
const cacheFile = path.join(tmpRoot, 'version_check.json');

/** Build a fetch stub that reports a fixed registry payload. */
function stubFetch(version: any, calls?: { n: number }) {
    return async () => {
        if (calls) calls.n++;
        if (version instanceof Error) throw version;
        return { ok: true, json: async () => ({ version }) };
    };
}

function readCache(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Run a callback with console.log muted — printVersionStatus is otherwise noisy. */
function quiet<T>(fn: () => T): T {
    const orig = console.log;
    (console as any).log = () => {};
    try { return fn(); } finally { (console as any).log = orig; }
}

/** Async-aware quiet(). */
async function quietAsync(fn: () => Promise<any>): Promise<void> {
    const orig = console.log;
    (console as any).log = () => {};
    try { await fn(); } finally { (console as any).log = orig; }
}

const BASE = {
    cacheFile,
    currentVersion: '1.6.7',
    intervalMs: 43_200_000,
    registryUrl: 'https://registry.invalid/dexbot/latest',
    // Pin the fallback off unless a case opts in: most cases are about the
    // npm source, and a derived GitHub URL would add an unrelated request.
    githubReleaseUrl: 'off',
    installKind: 'npm-global',
    now: 1_000_000,
    force: true,
};

async function main() {

// The env var above is asserted in section 8; every other case needs the
// module live, so flip the already-snapshotted Config flag.
Config.DEXBOT_SKIP_VERSION_NOTICE = false;

// ── 1) compareVersions ordering ───────────────────────────────────────
{
    check('equal versions compare to 0', compareVersions('1.6.7', '1.6.7') === 0);
    check('older patch sorts below newer', compareVersions('1.6.7', '1.6.10') < 0);
    check('1.6.10 sorts above 1.6.7', compareVersions('1.6.10', '1.6.7') > 0);
    check('minor ordering', compareVersions('1.6.7', '1.7.0') < 0);
    check('major ordering', compareVersions('2.0.0', '1.99.99') > 0);
    check('prerelease suffix is ignored', compareVersions('1.6.7-beta.1', '1.6.7') === 0);
    check('non-numeric segment degrades to 0, not NaN', compareVersions('1.x.7', '1.0.7') === 0);
    check('missing segments pad with 0', compareVersions('1.6', '1.6.0') === 0);
}

// ── 2) Install-kind detection without spawning ───────────────────────
{
    const repoRoot = path.join(tmpRoot, 'fake-repo', 'node_modules', 'dexbot');
    check('npm package dir is detected as npm-global',
        detectInstallKind(repoRoot) === 'npm-global', detectInstallKind(repoRoot));

    const gitDir = path.join(tmpRoot, 'fake-git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, '.git'), '', { mode: 0o600 });
    check('a directory holding .git is detected as git',
        detectInstallKind(gitDir) === 'git', detectInstallKind(gitDir));

    const bareDir = path.join(tmpRoot, 'fake-bare');
    fs.mkdirSync(bareDir, { recursive: true });
    check('a plain directory is detected as other',
        detectInstallKind(bareDir) === 'other', detectInstallKind(bareDir));
}

// ── 3) A newer version produces exactly one notice ───────────────────
{
    const calls = { n: 0 };
    const status = await startVersionStatusCheck({ ...BASE, fetchImpl: stubFetch('1.7.0', calls) });
    const notice = status?.notice ?? null;
    check('newer version yields a notice', !!notice);
    check('the state is update-available', status && status.state === 'update-available', JSON.stringify(status));
    check('notice reports both versions',
        notice && notice.currentVersion === '1.6.7' && notice.latestVersion === '1.7.0',
        JSON.stringify(notice));
    check('exactly one registry request was made', calls.n === 1, `n=${calls.n}`);

    const cached = readCache(cacheFile);
    check('cache records the probe time', cached && cached.lastCheckMs === BASE.now, JSON.stringify(cached));
    check('cache records the latest version', cached && cached.latestVersion === '1.7.0');
    check('a probe alone does NOT latch the announced version',
        cached && cached.notifiedVersion === null, JSON.stringify(cached));

    // What the operator actually sees — the wording lives in one renderer.
    const lines: string[] = [];
    const origLog = console.log;
    (console as any).log = (msg: any) => { lines.push(String(msg)); };
    try { printVersionStatus(status, { indent: '', surround: false }); } finally { (console as any).log = origLog; }
    check('the output names the latest version', (lines[0] || '').includes('v1.7.0'), lines[0]);
    check('the output names the installed version', (lines[0] || '').includes('v1.6.7'), lines[0]);
    check('the output points at `dexbot update`', (lines[1] || '').includes('dexbot update'), lines[1]);

    quiet(() => printVersionStatus(status));
    check('printing the notice latches the announced version',
        readCache(cacheFile).notifiedVersion === '1.7.0', JSON.stringify(readCache(cacheFile)));
    quiet(() => printVersionStatus(null));
    check('printVersionStatus(null) is a no-op', readCache(cacheFile).notifiedVersion === '1.7.0');
}

// ── 4) The same version is never announced twice ─────────────────────
{
    const calls = { n: 0 };
    // One minute short of the window, not exactly on the boundary: the throttle
    // is `elapsed < interval`, so a boundary-exact offset is already expired and
    // would prove nothing about staying quiet.
    const notice = await noticeOf({ ...BASE, force: false, now: BASE.now + 43_200_000 - 60_000, fetchImpl: stubFetch('1.7.0', calls) });
    check('re-check inside the interval makes no request', calls.n === 0, `n=${calls.n}`);
    check('re-check inside the interval is silent', notice === null, JSON.stringify(notice));
}
{
    // Same version, but the throttle window has expired: the request runs
    // again yet the notice stays latched.
    const calls = { n: 0 };
    const notice = await noticeOf({ ...BASE, force: false, now: BASE.now + 200_000_000, fetchImpl: stubFetch('1.7.0', calls) });
    check('expired window re-probes the registry', calls.n === 1, `n=${calls.n}`);
    check('an already-announced version is not repeated', notice === null, JSON.stringify(notice));
}

// ── 5) A newly published version resets the latch ────────────────────
{
    const status = await startVersionStatusCheck({ ...BASE, force: true, now: BASE.now + 300_000_000, fetchImpl: stubFetch('1.8.0') });
    check('a new published version is announced again', status?.notice?.latestVersion === '1.8.0', JSON.stringify(status));
    quiet(() => printVersionStatus(status));
    check('cache latch advances to the new version', readCache(cacheFile).notifiedVersion === '1.8.0');
}

// ── 5b) The latch never regresses ────────────────────────────────────
{
    // A registry that briefly serves an older `latest` (dist-tag rollback)
    // must not lower the latch and let an already-announced version reappear.
    quiet(() => printVersionStatus({
        currentVersion: '1.6.7', latestVersion: '1.7.0', installKind: 'npm-global', state: 'update-available',
        cacheFile, notice: { currentVersion: '1.6.7', latestVersion: '1.7.0', installKind: 'npm-global', cacheFile },
    }));
    check('an older notice does not regress the latch', readCache(cacheFile).notifiedVersion === '1.8.0');
}

// ── 5c) An unprinted notice is re-offered, not silently consumed ──────
{
    const unprintedCache = path.join(tmpRoot, 'version_check_unprinted.json');
    const first = await noticeOf({
        ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', fetchImpl: stubFetch('1.9.0'),
    });
    check('an unprinted notice is produced', first && first.latestVersion === '1.9.0', JSON.stringify(first));
    check('an unprinted notice is not latched', readCache(unprintedCache).notifiedVersion === null);

    const second = await noticeOf({
        ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', force: true, fetchImpl: stubFetch('1.9.0'),
    });
    check('the same notice is offered again on the next run', second && second.latestVersion === '1.9.0', JSON.stringify(second));

    // The centralized flush wrapper must print and latch exactly like the
    // other print paths.
    await quietAsync(() => flushVersionStatus(startVersionStatusCheck({ ...BASE, cacheFile: unprintedCache, currentVersion: '1.0.0', force: true, fetchImpl: stubFetch('1.9.0') })));
    check('flushVersionStatus latches the displayed version', readCache(unprintedCache).notifiedVersion === '1.9.0');
}

// ── 5d) The non-blocking print never delays the caller ───────────────
{
    const whenReadyCache = path.join(tmpRoot, 'version_check_whenready.json');
    let release: any;
    const pending = new Promise<any>((resolve) => { release = resolve; });
    const orig = console.log;
    (console as any).log = () => {};
    try {
        const t0 = Date.now();
        printVersionStatusWhenReady(pending);
        check('printVersionStatusWhenReady returns without awaiting', Date.now() - t0 < 100, `${Date.now() - t0}ms`);
        check('nothing is latched before the probe settles',
            readCache(whenReadyCache) === null);

        const readyStatus = await startVersionStatusCheck({
            ...BASE, cacheFile: whenReadyCache, currentVersion: '1.0.0', fetchImpl: stubFetch('1.2.0'),
        });
        release(readyStatus);
        await new Promise((r) => setTimeout(r, 0));
        check('the notice is latched once the probe settles',
            readCache(whenReadyCache).notifiedVersion === '1.2.0');
    } finally {
        (console as any).log = orig;
    }
}

// ── 6) Up-to-date and ahead-of-registry installs stay silent ─────────
{
    const notice = await noticeOf({
        ...BASE, currentVersion: '1.8.0', force: true, now: 400_000_000, fetchImpl: stubFetch('1.8.0'),
    });
    check('installed version equal to latest is silent', notice === null);
}
{
    const notice = await noticeOf({
        ...BASE, currentVersion: '2.0.0', force: true, now: 500_000_000, fetchImpl: stubFetch('1.8.0'),
    });
    check('installed version ahead of latest is silent', notice === null);
}

// ── 7) Network failures are silent but still throttle ────────────────
{
    const freshCache = path.join(tmpRoot, 'version_check_offline.json');
    const calls = { n: 0 };
    const notice = await noticeOf({
        ...BASE, cacheFile: freshCache, now: 600_000_000, fetchImpl: stubFetch(new Error('ENOTFOUND'), calls),
    });
    check('a network failure yields no notice', notice === null);
    const cached = readCache(freshCache);
    check('a network failure still records the probe so it backs off',
        cached && cached.lastCheckMs === 600_000_000, JSON.stringify(cached));
    check('a failed probe is not latched as announced', cached && cached.notifiedVersion === null);

    const retryCalls = { n: 0 };
    await noticeOf({
        ...BASE, cacheFile: freshCache, force: false, now: 600_000_100, fetchImpl: stubFetch(new Error('ENOTFOUND'), retryCalls),
    });
    check('an offline node does not re-probe on the next start', retryCalls.n === 0, `n=${retryCalls.n}`);
}
{
    const httpFailCache = path.join(tmpRoot, 'version_check_http.json');
    const notice = await noticeOf({
        ...BASE, cacheFile: httpFailCache, now: 700_000_000,
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    check('a non-2xx registry response yields no notice', notice === null);
}
{
    const badBodyCache = path.join(tmpRoot, 'version_check_body.json');
    const notice = await noticeOf({
        ...BASE, cacheFile: badBodyCache, now: 800_000_000,
        fetchImpl: async () => ({ ok: true, json: async () => ({ notAVersion: 1 }) }),
    });
    check('a malformed registry body yields no notice', notice === null);
}
{
    // A hung registry must be cut off by the option override, not the 2s
    // default — this is the path `dexbot status` relies on to stay responsive.
    const timeoutCache = path.join(tmpRoot, 'version_check_timeout.json');
    const notice = await noticeOf({
        ...BASE, cacheFile: timeoutCache, now: 850_000_000, timeoutMs: 20,
        fetchImpl: (_url: any, init: any) => new Promise((_resolve: any, reject: any) => {
            if (init?.signal?.aborted) return reject(new Error('aborted'));
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    check('a hung registry request is aborted at the timeout override', notice === null);
}
{
    // The hard timeout must not depend on AbortController existing or on the
    // fetch honoring the abort signal: a never-settling fetch still resolves.
    const noAbortCache = path.join(tmpRoot, 'version_check_noabort.json');
    const savedAbort = (global as any).AbortController;
    (global as any).AbortController = undefined;
    try {
        const notice = await noticeOf({
            ...BASE, cacheFile: noAbortCache, now: 875_000_000, timeoutMs: 20,
            fetchImpl: () => new Promise(() => {}), // never settles, ignores signal
        });
        check('a never-settling fetch is bounded even without AbortController', notice === null);
    } finally {
        (global as any).AbortController = savedAbort;
    }
}

// ── 8) Kill switches ─────────────────────────────────────────────────
{
    const calls = { n: 0 };
    const offCache = path.join(tmpRoot, 'version_check_off.json');
    const notice = await noticeOf({ ...BASE, cacheFile: offCache, enabled: false, fetchImpl: stubFetch('9.9.9', calls) });
    check('the notice opt-out is silent', notice === null);
    check('the notice opt-out makes no request', calls.n === 0, `n=${calls.n}`);
    check('the notice opt-out writes no cache file', !fs.existsSync(offCache));
}
{
    // The env var is set at line 1 of this file, before the config snapshot,
    // so re-asserting the flag above proves the ENV-driven kill switch, not a
    // hand-set Config field.
    const calls = { n: 0 };
    const skipCache = path.join(tmpRoot, 'version_check_skip.json');
    Config.DEXBOT_SKIP_VERSION_NOTICE = true;
    try {
        const notice = await noticeOf({ ...BASE, cacheFile: skipCache, fetchImpl: stubFetch('9.9.9', calls) });
        check('DEXBOT_SKIP_VERSION_NOTICE=1 is silent', notice === null);
        check('DEXBOT_SKIP_VERSION_NOTICE=1 makes no request', calls.n === 0, `n=${calls.n}`);
    } finally {
        Config.DEXBOT_SKIP_VERSION_NOTICE = false;
    }
}
{
    // A missing REGISTRY_URL must not burn a throttle window: the notice has
    // to appear as soon as an operator configures it.
    const noUrlCache = path.join(tmpRoot, 'version_check_nourl.json');
    const notice = await noticeOf({ ...BASE, cacheFile: noUrlCache, registryUrl: '', fetchImpl: stubFetch('9.9.9') });
    check('an empty REGISTRY_URL is silent', notice === null);
    check('an empty REGISTRY_URL writes no cache file', !fs.existsSync(noUrlCache));
}
{
    // A current version that cannot be read must not produce a bogus notice.
    const noVerCache = path.join(tmpRoot, 'version_check_nover.json');
    const notice = await noticeOf({ ...BASE, cacheFile: noVerCache, currentVersion: '', fetchImpl: stubFetch('9.9.9') });
    check('an unreadable current version is silent', notice === null);
}

// ── 9) Cache corruption is survivable ────────────────────────────────
{
    const corruptCache = path.join(tmpRoot, 'version_check_corrupt.json');
    fs.writeFileSync(corruptCache, '{not json', { mode: 0o600 });
    const notice = await noticeOf({ ...BASE, cacheFile: corruptCache, fetchImpl: stubFetch('1.9.0') });
    check('a corrupt cache does not break the check', notice && notice.latestVersion === '1.9.0', JSON.stringify(notice));
}
{
    const wrongVersionCache = path.join(tmpRoot, 'version_check_v0.json');
    fs.writeFileSync(wrongVersionCache, JSON.stringify({ version: 0, lastCheckMs: 9e15 }), { mode: 0o600 });
    const notice = await noticeOf({ ...BASE, cacheFile: wrongVersionCache, fetchImpl: stubFetch('1.9.0') });
    check('a cache from a foreign schema version is ignored', notice && notice.latestVersion === '1.9.0');
}
{
    const badTypeCache = path.join(tmpRoot, 'version_check_badtype.json');
    fs.writeFileSync(badTypeCache, JSON.stringify({
        version: 1, lastCheckMs: 9e15, latestVersion: { nope: true }, notifiedVersion: null,
    }), { mode: 0o600 });
    const notice = await noticeOf({ ...BASE, cacheFile: badTypeCache, fetchImpl: stubFetch('1.9.0') });
    check('a cache with a non-string version field is ignored', notice && notice.latestVersion === '1.9.0');
}

// ── 10) Hint text adapts to the install layout ───────────────────────
{
    for (const [installKind, expected] of [['git', 'pull it'], ['npm-global', 'install it'], ['other', 'install it']] as const) {
        const kindCache = path.join(tmpRoot, `version_check_hint_${installKind}.json`);
        const status = await startVersionStatusCheck({
            ...BASE, cacheFile: kindCache, installKind, currentVersion: '1.0.0',
            now: 900_000_000, fetchImpl: stubFetch('1.1.0'),
        });
        const lines: string[] = [];
        const origLog = console.log;
        (console as any).log = (msg: any) => { lines.push(String(msg)); };
        try { printVersionStatus(status, { indent: '', surround: false }); } finally { (console as any).log = origLog; }
        check(`a ${installKind} install gets the "${expected}" hint`,
            (lines[1] || '').includes(expected), JSON.stringify(lines));
    }
}

// ── 11) Status states drive colour and wording (dexbot stat + start) ──
{
    const upToDate = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_current.json'), now: 1_000_000_000,
        fetchImpl: stubFetch('1.6.7'),
    });
    check('equal versions read as up-to-date', upToDate && upToDate.state === 'up-to-date', JSON.stringify(upToDate));
    check('up-to-date yields no notice', upToDate && upToDate.notice === null);
    const currentLine = formatVersionStatusLine(upToDate!);
    check('up-to-date line is green and says so',
        currentLine.includes(CLI_COLORS.brightGreen) && currentLine.includes('Your version is up to date'), currentLine);
    check('up-to-date line names the installed version', currentLine.includes('DEXBot2 v1.6.7'), currentLine);
    check('up-to-date line is not orange', !currentLine.includes(CLI_COLORS.orange), currentLine);
}
{
    const ahead = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_ahead.json'), now: 1_000_000_000,
        currentVersion: '2.0.0', fetchImpl: stubFetch('1.6.7'),
    });
    check('an install ahead of latest is not flagged as outdated',
        ahead && ahead.state === 'up-to-date', JSON.stringify(ahead));
}
{
    const available = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_new.json'), now: 1_000_000_000,
        currentVersion: '1.6.7', fetchImpl: stubFetch('1.7.0'),
    });
    check('a newer release reads as update-available', available && available.state === 'update-available');
    const newLine = formatVersionStatusLine(available!);
    check('update-available line is orange',
        newLine.includes(CLI_COLORS.orange) && newLine.includes('A new version is available'), newLine);
    check('update-available line is not green', !newLine.includes(CLI_COLORS.brightGreen), newLine);
}
{
    const calls = { n: 0 };
    const offline = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'status_offline.json'), now: 1_000_000_000,
        fetchImpl: stubFetch(new Error('ENOTFOUND'), calls),
    });
    check('a failed probe reads as unknown, never as up-to-date',
        offline && offline.state === 'unknown', JSON.stringify(offline));
    check('an unknown status still names the installed version',
        (offline && formatVersionStatusLine(offline).includes('DEXBot2 v1.6.7')) || false);
    check('an unknown status carries no notice', offline && offline.notice === null);
}
{
    // A throttled run spends no request but still answers "am I current?" from
    // the cached observation — that is what `dexbot stat` renders.
    const cache = path.join(tmpRoot, 'status_throttled.json');
    await startVersionStatusCheck({ ...BASE, cacheFile: cache, now: 1_000_000_000, fetchImpl: stubFetch('1.7.0') });
    const throttledCalls = { n: 0 };
    const throttled = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, force: false, now: 1_000_000_000 + 60_000, fetchImpl: stubFetch('1.7.0', throttledCalls),
    });
    check('a throttled run makes no request', throttledCalls.n === 0, `n=${throttledCalls.n}`);
    check('a throttled run still reports the update state from the cache',
        throttled && throttled.state === 'update-available', JSON.stringify(throttled));
}
{
    // The print path is the single place a hint is shown and latched.
    const cache = path.join(tmpRoot, 'status_print.json');
    const status = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, now: 1_000_000_000, currentVersion: '1.0.0', fetchImpl: stubFetch('1.5.0'),
    });
    const lines: string[] = [];
    const orig = console.log;
    (console as any).log = (msg: any) => { lines.push(String(msg)); };
    try { printVersionStatus(status, { indent: '', surround: false }); } finally { (console as any).log = orig; }
    check('the status line is printed', lines[0] && lines[0].includes('A new version is available'), JSON.stringify(lines));
    check('the install hint follows the status line', lines[1] && lines[1].includes('dexbot update'), JSON.stringify(lines));
    check('printing the status latches the announced version', readCache(cache).notifiedVersion === '1.5.0');

    const relatched = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, now: 1_000_000_000, force: false, currentVersion: '1.0.0', fetchImpl: stubFetch('1.5.0'),
    });
    check('an announced version is no longer offered as a notice', relatched && relatched.notice === null);
    const again: string[] = [];
    (console as any).log = (msg: any) => { again.push(String(msg)); };
    try { printVersionStatus(relatched, { indent: '', surround: false }); } finally { (console as any).log = orig; }
    check('the orange status line is still shown after the latch', again[0] && again[0].includes('A new version is available'), JSON.stringify(again));
    check('no hint is repeated once latched', again.length === 1, JSON.stringify(again));
}

// ── 12) Multiple sources: fallback beats "unknown" ───────────────────
{
    // The GitHub endpoint is DERIVED from the configured repository, so a fork
    // or a self-hosted mirror is honoured without a second hardcoded owner/repo.
    check('a github.com repository derives the releases endpoint',
        deriveGithubReleaseUrl('https://github.com/froooze/DEXBot2.git', 'https://api.github.com')
            === 'https://api.github.com/repos/froooze/DEXBot2/releases/latest',
        String(deriveGithubReleaseUrl('https://github.com/froooze/DEXBot2.git', 'https://api.github.com')));
    check('the .git suffix is optional when deriving',
        deriveGithubReleaseUrl('https://github.com/o/r', 'https://api.github.com')
            === 'https://api.github.com/repos/o/r/releases/latest');
    check('a GitHub Enterprise base is honoured',
        deriveGithubReleaseUrl('https://github.com/o/r.git', 'https://ghe.example.com/api/v3/')
            === 'https://ghe.example.com/api/v3/repos/o/r/releases/latest');
    // A non-GitHub host has a different API shape: guessing produced a
    // guaranteed-wrong request on every probe, so it yields no source at all.
    check('a non-GitHub repository derives nothing',
        deriveGithubReleaseUrl('https://gitlab.example.com/o/r.git', 'https://api.github.com') === null);
    check('an empty repository derives nothing',
        deriveGithubReleaseUrl('', 'https://api.github.com') === null);
}
{
    const sources = resolveReleaseSources({
        registryUrl: 'https://registry.invalid/dexbot/latest',
        repositoryUrl: 'https://github.com/froooze/DEXBot2.git',
        apiBase: 'https://api.github.com',
    });
    check('npm is the first source and github the fallback',
        sources.length === 2 && sources[0].id === 'npm' && sources[1].id === 'github', JSON.stringify(sources.map(s => s.id)));
    check('an explicit GITHUB_RELEASE_URL overrides the derived one',
        resolveReleaseSources({ registryUrl: 'https://r.invalid', githubReleaseUrl: 'https://gh.invalid/latest' })[1]?.url
            === 'https://gh.invalid/latest');
    check("GITHUB_RELEASE_URL 'off' disables the fallback",
        resolveReleaseSources({ registryUrl: 'https://r.invalid', githubReleaseUrl: 'off' }).length === 1);
    check('an empty GITHUB_RELEASE_URL falls back to the derived endpoint',
        resolveReleaseSources({ registryUrl: 'https://r.invalid', githubReleaseUrl: '', repositoryUrl: 'https://github.com/o/r.git' })[1]?.id === 'github');
}
{
    // The production failure mode: the registry is unreachable, GitHub is not.
    // Before the fallback this was an unconditional "unknown" for a day.
    const cache = path.join(tmpRoot, 'version_check_fallback.json');
    const urls: string[] = [];
    const status = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, currentVersion: '1.0.0', now: 1_100_000_000,
        githubReleaseUrl: 'https://api.github.com/repos/o/r/releases/latest',
        fetchImpl: async (url: string) => {
            urls.push(url);
            if (String(url).includes('registry.invalid')) {
                const err: any = new Error('getaddrinfo ENOTFOUND registry.invalid');
                err.cause = { code: 'ENOTFOUND' };
                throw err;
            }
            return { ok: true, json: async () => ({ tag_name: 'v1.4.0' }) };
        },
    });
    check('an unreachable registry falls back to GitHub', status?.state === 'update-available', JSON.stringify(status));
    check('the fallback version is read from tag_name', status?.latestVersion === 'v1.4.0', JSON.stringify(status));
    check('the answering source is recorded', status?.source === 'github', JSON.stringify(status));
    check('both sources were tried', urls.length === 2, JSON.stringify(urls));
    check('a `v`-prefixed tag does not read as an ancient version',
        status?.state === 'update-available' && compareVersions('v1.4.0', '1.0.0') > 0,
        String(compareVersions('v1.4.0', '1.0.0')));
}
{
    // A hanging first source must not starve the fallback: the total budget is
    // split evenly rather than spent first-come.
    const probe = await probeReleaseSources(
        [
            { id: 'npm', url: 'https://hang.invalid', extract: (b: any) => b?.version ?? null },
            { id: 'github', url: 'https://ok.invalid', extract: (b: any) => b?.tag_name ?? null },
        ],
        200,
        async (url: string, init: any) => {
            if (String(url).includes('hang')) {
                return new Promise((_res: any, rej: any) => {
                    init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
                });
            }
            return { ok: true, json: async () => ({ tag_name: 'v9.9.9' }) };
        },
    );
    check('a hung source does not starve the fallback', probe.version === 'v9.9.9', JSON.stringify(probe));
    check('the hung source is reported as a timeout',
        probe.reasons.some((r) => r.includes('timeout')), JSON.stringify(probe.reasons));
}
{
    // Every failure mode must name itself: an unnamed "?" cannot be acted on.
    const cases: [string, any, string][] = [
        ['ENOTFOUND', () => { const e: any = new Error('getaddrinfo ENOTFOUND x'); e.cause = { code: 'ENOTFOUND' }; throw e; }, 'ENOTFOUND'],
        ['ECONNREFUSED', () => { const e: any = new Error('connect'); e.cause = { code: 'ECONNREFUSED' }; throw e; }, 'ECONNREFUSED'],
        ['HTTP 403', async () => ({ ok: false, status: 403, json: async () => ({}) }), 'HTTP 403'],
        ['bad payload', async () => ({ ok: true, json: async () => ({ nope: 1 }) }), 'no version in response'],
    ];
    for (const [label, impl, expected] of cases) {
        const cache = path.join(tmpRoot, `version_check_reason_${label.replace(/\W/g, '')}.json`);
        const status = await startVersionStatusCheck({
            ...BASE, cacheFile: cache, now: 1_200_000_000, fetchImpl: impl as any,
        });
        check(`a ${label} failure reports its reason`,
            status?.state === 'unknown' && String(status?.reason).includes(expected), JSON.stringify(status));
        check(`a ${label} failure names it in the rendered line`,
            formatVersionStatusLine(status!).includes(expected), formatVersionStatusLine(status!));
    }
    // A runtime without a global fetch (Node < 18, stripped build) is a
    // PERMANENT condition — it must not be reported as a network blip.
    const savedFetch = (global as any).fetch;
    (global as any).fetch = undefined;
    try {
        const cache = path.join(tmpRoot, 'version_check_nofetch.json');
        const status = await startVersionStatusCheck({ ...BASE, cacheFile: cache, now: 1_300_000_000 });
        check('a missing fetch is reported as such, not as a network error',
            status?.state === 'unknown' && String(status?.reason).includes('no fetch available'), JSON.stringify(status));
    } finally {
        (global as any).fetch = savedFetch;
    }
}
{
    // CACHE POLICY: a success is worth half a day, a failure only the short
    // backoff. Throttling a failure for the success window is what pinned a
    // gray "?" for a whole day.
    const cache = path.join(tmpRoot, 'version_check_backoff.json');
    await startVersionStatusCheck({
        ...BASE, cacheFile: cache, now: 2_000_000_000, fetchImpl: stubFetch(new Error('ENOTFOUND')),
    });
    const inside = { n: 0 };
    const throttled = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, force: false, now: 2_000_000_000 + 60_000, fetchImpl: stubFetch('1.9.0', inside),
    });
    check('a failure is throttled for the short backoff, not the success window', inside.n === 0, `n=${inside.n}`);
    check('a throttled failure still names its reason',
        throttled?.state === 'unknown' && String(throttled?.reason).includes('ENOTFOUND'), JSON.stringify(throttled));

    const after = { n: 0 };
    const retried = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, force: false, now: 2_000_000_000 + 901_000, fetchImpl: stubFetch('1.9.0', after),
    });
    check('a failure is re-probed once the backoff expires', after.n === 1, `n=${after.n}`);
    check('the retry can turn the verdict green again', retried?.state === 'update-available', JSON.stringify(retried));

    const successCache = path.join(tmpRoot, 'version_check_backoff_ok.json');
    await startVersionStatusCheck({ ...BASE, cacheFile: successCache, now: 3_000_000_000, fetchImpl: stubFetch('1.9.0') });
    const dayLater = { n: 0 };
    const cached = await startVersionStatusCheck({
        ...BASE, cacheFile: successCache, force: false, now: 3_000_000_000 + 6 * 3_600_000, fetchImpl: stubFetch('2.0.0', dayLater),
    });
    check('a success is still cached well inside the window', dayLater.n === 0, `n=${dayLater.n}`);
    check('the cached success answers without a request', cached?.state === 'update-available', JSON.stringify(cached));
}
{
    // The SHIPPED default, not an override: 12h. Locked here because the number
    // is a product decision (how stale may `dexbot stat` be?) and a test that
    // injects its own interval would keep passing after someone changed it.
    const { UPDATER } = require('../modules/constants');
    const cache = path.join(tmpRoot, 'version_check_default_window.json');
    const seeded = { n: 0 };
    await startVersionStatusCheck({ ...BASE, cacheFile: cache, now: 5_000_000_000, fetchImpl: stubFetch('1.9.0', seeded) });
    check('the default success window is 12h', Number(UPDATER.NOTICE_INTERVAL_MS) === 43_200_000,
        String(UPDATER.NOTICE_INTERVAL_MS));

    const inside = { n: 0 };
    await startVersionStatusCheck({
        ...BASE, cacheFile: cache, force: false, intervalMs: undefined,
        now: 5_000_000_000 + 11 * 3_600_000, fetchImpl: stubFetch('2.0.0', inside),
    });
    check('the default window reuses the cache at 11h', inside.n === 0, `n=${inside.n}`);

    const outside = { n: 0 };
    const rechecked = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, force: false, intervalMs: undefined,
        now: 5_000_000_000 + 13 * 3_600_000, fetchImpl: stubFetch('2.0.0', outside),
    });
    check('the default window re-probes at 13h', outside.n === 1, `n=${outside.n}`);
    check('the re-probe returns the newer answer', rechecked?.latestVersion === '2.0.0', JSON.stringify(rechecked));
}
{
    // DEXBOT_VERSION_CHECK_FORCE=1 is the diagnostic escape hatch: a cached
    // failure must be disprovable on demand.
    const cache = path.join(tmpRoot, 'version_check_force.json');
    await startVersionStatusCheck({ ...BASE, cacheFile: cache, now: 4_000_000_000, fetchImpl: stubFetch(new Error('ENOTFOUND')) });
    const forced = { n: 0 };
    const status = await startVersionStatusCheck({
        ...BASE, cacheFile: cache, force: true, now: 4_000_000_001, fetchImpl: stubFetch('1.6.7', forced),
    });
    check('force bypasses a cached failure', forced.n === 1, `n=${forced.n}`);
    check('a forced re-probe can clear the unknown verdict', status?.state === 'up-to-date', JSON.stringify(status));
}

// ── 13) Staged wait around `dexbot stat` ─────────────────────────────
{
    // The happy path: a valid cache (or a quick answer) lands inside the
    // top-of-report grace, so `stat` never waits on the network twice.
    const cache = path.join(tmpRoot, 'staged_cached.json');
    const calls = { n: 0 };
    const wait = startStagedVersionStatus({
        ...BASE, cacheFile: cache, currentVersion: '1.6.7', now: 5_000_000_000,
        graceMs: 200, finalMs: 500, fetchImpl: stubFetch('1.6.7', calls),
    });
    const quick = await wait.quick;
    check('a quick answer lands inside the grace period', quick?.state === 'up-to-date', JSON.stringify(quick));
    const settled = await wait.settled;
    check('the settled status is the same one', settled?.state === 'up-to-date', JSON.stringify(settled));
    check('a settled answer costs exactly one request', calls.n === 1, `n=${calls.n}`);
}
{
    // A valid CACHE answers during the grace period without any request, so
    // the report is never delayed on a node that checked recently.
    const cache = path.join(tmpRoot, 'staged_valid_cache.json');
    await startVersionStatusCheck({ ...BASE, cacheFile: cache, now: 6_000_000_000, fetchImpl: stubFetch('1.6.7') });
    const calls = { n: 0 };
    const wait = startStagedVersionStatus({
        ...BASE, cacheFile: cache, now: 6_000_000_000 + 60_000, force: false,
        graceMs: 200, finalMs: 500, fetchImpl: stubFetch('1.6.7', calls),
    });
    const t0 = Date.now();
    const quick = await wait.quick;
    check('a valid cache answers the top-of-report wait', quick?.state === 'up-to-date', JSON.stringify(quick));
    check('a valid cache answers without waiting', Date.now() - t0 < 150, `${Date.now() - t0}ms`);
    check('a valid cache spends no request', calls.n === 0, `n=${calls.n}`);
    check('the settled status reuses the cache', (await wait.settled)?.state === 'up-to-date');
}
{
    // A slow first attempt: the report runs, the end asks AGAIN (forced, so a
    // cached failure cannot suppress it), and that second answer is displayed.
    const cache = path.join(tmpRoot, 'staged_slow.json');
    let attempts = 0;
    const wait = startStagedVersionStatus({
        ...BASE, cacheFile: cache, currentVersion: '1.0.0', now: 7_000_000_000,
        graceMs: 30, finalMs: 400, fetchImpl: async () => {
            attempts++;
            if (attempts === 1) return new Promise(() => {}); // hangs past both graces
            return { ok: true, json: async () => ({ version: '1.2.0' }) };
        },
    });
    check('a hanging probe does not answer the top-of-report wait', (await wait.quick) === null);
    const settled = await wait.settled;
    check('the end of the report asks again', attempts === 2, `attempts=${attempts}`);
    check('the second answer is the one displayed', settled?.state === 'update-available', JSON.stringify(settled));
}
{
    // Nothing answers at all: the verdict must SAY the information is
    // missing. It must never be rendered as "up to date", and it must not be
    // rendered as "could not check" either — nothing ran that could fail.
    const cache = path.join(tmpRoot, 'staged_exhausted.json');
    const wait = startStagedVersionStatus({
        ...BASE, cacheFile: cache, currentVersion: '1.0.0', now: 8_000_000_000,
        graceMs: 20, finalMs: 60, fetchImpl: () => new Promise(() => {}),
    });
    check('a silent probe does not answer the top-of-report wait', (await wait.quick) === null);
    const settled = await wait.settled;
    check('a silent probe still yields a status, not null', !!settled, JSON.stringify(settled));
    check('the exhausted status is unknown', settled?.state === 'unknown', JSON.stringify(settled));
    check('the exhausted status is flagged as such', settled?.exhausted === true, JSON.stringify(settled));
    check('the exhausted status names the budget it waited for',
        String(settled?.reason).includes('60ms'), JSON.stringify(settled));
    check('the exhausted status names the sources it asked',
        String(settled?.reason).includes('npm'), JSON.stringify(settled));
    const line = formatVersionStatusLine(settled!);
    check('the exhausted line says no current version information',
        line.includes('No current version information'), line);
    check('the exhausted line is never green', !line.includes(CLI_COLORS.brightGreen), line);
    check('the exhausted line is not the "could not check" wording',
        !line.includes('Could not check'), line);
}
{
    // A switched-off feature must stay silent at BOTH stages: no grace wait,
    // no retry, no "no information" verdict standing in for a disabled notice.
    const t0 = Date.now();
    const wait = startStagedVersionStatus({
        ...BASE, cacheFile: path.join(tmpRoot, 'staged_off.json'), enabled: false,
        graceMs: 5_000, finalMs: 5_000, fetchImpl: stubFetch('9.9.9'),
    });
    check('a disabled feature resolves the grace wait immediately', (await wait.quick) === null);
    check('a disabled feature does not block on the grace period', Date.now() - t0 < 200, `${Date.now() - t0}ms`);
    check('a disabled feature settles to null, not to a verdict', (await wait.settled) === null);
    // The reason `settled` resolves null (rather than a status) is load-bearing
    // for the caller: `dexbot stat` uses it to fall back to the bare
    // "DEXBot2 vX.Y.Z" header, so a switched-off notice still tells the operator
    // which build they are running. printVersionStatus(null) is a no-op, so a
    // caller that forgets this check prints nothing at all.
    check('a disabled feature is what makes settled null (the bare-header signal)',
        printVersionStatus(await wait.settled) === undefined);
}

// ── 14) One renderer for every entry point ──────────────────────────
{
    // `dexbot stat`, `dexbot pm2` and `unlock` must not each decide what to
    // print when the check is switched off. This helper is that decision.
    const capture = (fn: () => void): string[] => {
        const lines: string[] = [];
        const orig = console.log;
        (console as any).log = (m: any) => lines.push(String(m));
        try { fn(); } finally { (console as any).log = orig; }
        return lines;
    };

    const off = capture(() => printVersionStatusOrHeader(null, { indent: '', surround: false }));
    // A bare header is the installed version and NOTHING else; the status line
    // starts with the same prefix, so it is the trailing text that tells them
    // apart.
    const isBareHeader = (l: string) => /^DEXBot2 v[\d.]+$/.test(l.replace(/\x1b\[[0-9;]*m/g, '').trim());
    check('a null status falls back to the bare installed-version header',
        off.length === 1 && isBareHeader(off[0]), JSON.stringify(off));
    check('the bare header is printed exactly once', off.length === 1, JSON.stringify(off));

    const status = await startVersionStatusCheck({
        ...BASE, cacheFile: path.join(tmpRoot, 'shared_render.json'), now: 9_000_000_000,
        currentVersion: '1.0.0', fetchImpl: stubFetch('1.5.0'),
    });
    const on = capture(() => printVersionStatusOrHeader(status, { indent: '', surround: false }));
    check('a real status renders the status line, not the header',
        on[0]?.includes('A new version is available') && !on.some(isBareHeader), JSON.stringify(on));

    // The non-awaited form must behave identically, or the isolated-foreground
    // launch path would be the one entry point that hides the build.
    const whenReady: string[] = [];
    const orig = console.log;
    (console as any).log = (m: any) => whenReady.push(String(m));
    try {
        printVersionStatusWhenReady(Promise.resolve(null));
        await new Promise((r) => setTimeout(r, 0));
    } finally {
        (console as any).log = orig;
    }
    check('the non-awaited renderer also falls back to the header',
        whenReady.filter(isBareHeader).length === 1, JSON.stringify(whenReady));

    // The flush wrapper is the awaited form of the same contract.
    const flushed: string[] = [];
    (console as any).log = (m: any) => flushed.push(String(m));
    try {
        await flushVersionStatusOrHeader(Promise.resolve(null));
    } finally {
        (console as any).log = orig;
    }
    check('the flush wrapper also falls back to the header',
        flushed.filter(isBareHeader).length === 1, JSON.stringify(flushed));
}

// ── 15) GITHUB_API_BASE is read from the settings file, not hardcoded ──
{
    // The gap this closes: `deriveGithubReleaseUrl` had a unit test with a
    // custom base, and the live UPDATER wiring had none — so hardcoding
    // `https://api.github.com` inside resolveReleaseSources (ignoring the
    // constant) would have passed every test, and a GitHub Enterprise mirror
    // would have silently probed the public API.
    //
    // A CHILD PROCESS, not an in-process module reload: the profiles dir and
    // the merged UPDATER are captured once at module load (PATHS is a
    // snapshot, and the storage adapter is a singleton), so evicting
    // require.cache does not re-derive them — an in-process version of this
    // test silently asserted the defaults and passed for the wrong reason. A
    // fresh process is also the honest shape of the claim: a real install
    // reads its general.settings.json exactly once, at startup.
    const { execFile } = require('child_process');
    const modulesDir = path.join(__dirname, '..', 'modules');
    const { UPDATER: LIVE_UPDATER } = require('../modules/constants');

    const execFileAsync = (file: string, args: string[], options: any): Promise<{ stdout: string }> =>
        new Promise((resolve, reject) => {
            execFile(file, args, options, (err: any, stdout: string) => {
                if (err) reject(err);
                else resolve({ stdout });
            });
        });

    /** Resolve the probe's sources in a fresh process with `updater` written
     *  to a temp profile root's general.settings.json. Each distinct updater
     *  needs its own process (the profile dir and merged UPDATER are captured
     *  at module load), but the scenarios are independent: resolve them in
     *  parallel and memoize, so repeated lookups do not re-spawn. */
    const sourcesCache = new Map<string, any[]>();
    const sourcesWith = async (updater: any): Promise<any[]> => {
        const key = JSON.stringify(updater ?? null);
        const cached = sourcesCache.get(key);
        if (cached) return cached;
        const root = fs.mkdtempSync(path.join(tmpRoot, 'apibase-'));
        fs.writeFileSync(path.join(root, 'general.settings.json'), JSON.stringify({ UPDATER: updater }), { mode: 0o600 });
        const { stdout } = await execFileAsync(process.execPath, ['-e', `
            const vn = require(${JSON.stringify(path.join(modulesDir, 'version_notice.js'))});
            process.stdout.write(JSON.stringify(vn.resolveReleaseSources().map((s) => ({ id: s.id, url: s.url }))));
        `], {
            encoding: 'utf8',
            env: { ...process.env, DEXBOT_PROFILE_ROOT: root },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const sources = JSON.parse(stdout);
        sourcesCache.set(key, sources);
        return sources;
    };

    const ownerRepo = String(LIVE_UPDATER.REPOSITORY_URL).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    const CUSTOM_BASE = 'https://ghe.example.com/api/v3';

    // One child per distinct settings scenario, all in flight together.
    const scenarios = [
        { GITHUB_API_BASE: CUSTOM_BASE },
        { GITHUB_API_BASE: CUSTOM_BASE, GITHUB_RELEASE_URL: '' },
        { GITHUB_API_BASE: CUSTOM_BASE, GITHUB_RELEASE_URL: 'https://pinned.example.com/releases/latest' },
        { GITHUB_API_BASE: CUSTOM_BASE, GITHUB_RELEASE_URL: 'off' },
        { GITHUB_API_BASE: CUSTOM_BASE, REPOSITORY_URL: 'https://gitlab.example.com/o/r.git' },
        {},
    ];
    const resolved = new Map<string, any[]>();
    await Promise.all(scenarios.map(async (updater) => {
        resolved.set(JSON.stringify(updater), await sourcesWith(updater));
    }));
    const sourcesFor = (updater: any): any[] => resolved.get(JSON.stringify(updater)) ?? [];
    const githubUrl = (updater: any): string | undefined => sourcesFor(updater).find((s) => s.id === 'github')?.url;
    const npmUrl = (updater: any): string | undefined => sourcesFor(updater).find((s) => s.id === 'npm')?.url;

    check('a custom GITHUB_API_BASE from the settings file builds the releases URL',
        githubUrl({ GITHUB_API_BASE: CUSTOM_BASE }) === `${CUSTOM_BASE}/repos/${ownerRepo}/releases/latest`,
        githubUrl({ GITHUB_API_BASE: CUSTOM_BASE }));
    check('an explicitly empty GITHUB_RELEASE_URL still derives from the custom base',
        githubUrl({ GITHUB_API_BASE: CUSTOM_BASE, GITHUB_RELEASE_URL: '' }) === `${CUSTOM_BASE}/repos/${ownerRepo}/releases/latest`);
    check('a pinned GITHUB_RELEASE_URL wins over a custom base',
        githubUrl({ GITHUB_API_BASE: CUSTOM_BASE, GITHUB_RELEASE_URL: 'https://pinned.example.com/releases/latest' })
            === 'https://pinned.example.com/releases/latest');
    check("'off' in the settings file drops the github source",
        githubUrl({ GITHUB_API_BASE: CUSTOM_BASE, GITHUB_RELEASE_URL: 'off' }) === undefined);
    check('a non-GitHub repository drops the source even with a custom base',
        githubUrl({ GITHUB_API_BASE: CUSTOM_BASE, REPOSITORY_URL: 'https://gitlab.example.com/o/r.git' }) === undefined);
    check('a custom base does not disturb the npm source',
        npmUrl({ GITHUB_API_BASE: CUSTOM_BASE }) === LIVE_UPDATER.REGISTRY_URL);
    // No overrides at all: the shipped defaults still produce the public API URL.
    check('the shipped defaults derive the public API URL',
        githubUrl({}) === `https://api.github.com/repos/${ownerRepo}/releases/latest`, githubUrl({}));
}

// ── Summary ───────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

assert.strictEqual(passed, total, `${passed}/${total} version notice tests passed`);
console.log(`\n✓ ${passed}/${total} version notice tests passed`);
}

main().catch((err) => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
});
