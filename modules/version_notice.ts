/**
 * modules/version_notice.ts - Passive version status + "new version" notice.
 *
 * Reports the INSTALLED version against the published `latest` on every start
 * and in `dexbot stat`, and prints a one-time hint when a newer DEXBot2 release
 * exists — without ever changing code on its own. This is deliberately
 * ORTHOGONAL to `UPDATER.ACTIVE` (the automated updater, default OFF): a bot
 * handling real funds must never silently change its own code, but the
 * operator still deserves to KNOW a fix or a breaking change landed. The
 * opt-out lives in `UPDATER.NOTICE_ENABLED` so it can be tuned independently of
 * the updater.
 *
 * ===============================================================================
 * DESIGN CONSTRAINTS
 * ===============================================================================
 *
 * 1. NEVER BLOCKS STARTUP. `startVersionStatusCheck()` returns a promise
 *    immediately and resolves with a `VersionStatus` (or null when the check is
 *    disabled). Callers start it early and `await` it late, so the round-trip
 *    overlaps work that is already happening (BitShares connection, password
 *    prompt).
 * 2. NEVER THROWS. Every failure path — offline, DNS failure, slow registry,
 *    unreadable cache, browser — resolves to `null`.
 * 3. NO SUBPROCESSES. Each source is queried with a single HTTPS GET and a
 *    hard timeout. `execSync('npm view ...')` (as used by `dexbot update`)
 *    costs 1-3s of spawn and hard-depends on the npm CLI, neither of which is
 *    acceptable on the launcher critical path.
 * 3b. MULTIPLE SOURCES, FALLBACK NOT FAILURE. One source is a single point of
 *    failure: a host that cannot reach registry.npmjs.org (firewall, DNS, a
 *    proxy only the npm CLI knows about) reported "unknown" forever even when
 *    the release was published on GitHub. Sources are tried in order and the
 *    first answer wins, so an unreachable registry degrades to a slower probe
 *    instead of a permanent "?". Each source is bounded by an even share of
 *    the total budget, so a hanging first source cannot starve the second.
 * 3c. NEVER MYSTERY. Every failure path records WHY (`ENOTFOUND`, `HTTP 403`,
 *    `timeout`, `no fetch`, …) and the unknown verdict names it. An operator
 *    cannot act on "?" and used to have to guess between DNS, TLS, a proxy and
 *    a timeout.
 * 4. THROTTLED + NOTIFY-ONCE. A check runs at most once per
 *    `UPDATER.NOTICE_INTERVAL_MS` AFTER A SUCCESS, and once per
 *    `UPDATER.NOTICE_RETRY_MS` after a failure (a failure is the observation
 *    that decays fastest — see the constant). The same version is announced
 *    only once (`notifiedVersion` in the cache) so an ignored notice does not
 *    nag on every restart. A new published version resets that latch. The latch
 *    is committed by `printVersionStatus` only AFTER the notice is displayed, so a
 *    launcher path that returns without printing cannot silently consume it —
 *    it is re-offered once the throttle window expires. A throttled run still
 *    reports a status (from the cached observation) so `dexbot stat` answers
 *    "am I current?" without spending a request.
 * 4a. DEFERRED, NOT DROPPED. Callers that have other work to do (`dexbot stat`
 *    prints a process table) start the probe, do their work, and flush the
 *    verdict when it lands. Nothing is printed speculatively and nothing is
 *    ever truncated by an early `process.exit()`.
 * 4b. ONE IMPLEMENTATION. Every consumer (`unlock`, `pm2`, `dexbot stat`) goes
 *    through this module — `startVersionStatusCheck` / `startStagedVersionStatus`
 *    → `printVersionStatus`; the colour of the status line, the hint wording
 *    and the latch all live here, so no caller can drift from another.
 * 5. SILENT WHEN DISABLED. `Config.DEXBOT_SKIP_VERSION_NOTICE=1` (tests, CI,
 *    automation) or `UPDATER.NOTICE_ENABLED: false` short-circuits before any
 *    network or filesystem work.
 *
 * Cache layout mirrors `modules/node_health_cache.ts` and lives in the profiles
 * dir (never in the package dir — npm reinstalls wipe that).
 */

import { path } from './path_api.js';
import { UPDATER } from './constants.js';
import { PATHS, isGlobalNpmPackageDir } from './paths.js';
import { Config } from './config.js';
import { hasProcess } from './env.js';
import { getStorage } from './storage/index.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import { CLI_COLORS } from './cli_colors.js';

const storage = getStorage();
const { readJSON } = storage;

/** How the running copy was installed — selects the hint text. */
type InstallKind = 'npm-global' | 'git' | 'other';

/**
 * The pending one-time announcement: what the operator is told when a newer
 * release exists and has not been displayed yet. It carries DATA only — the
 * wording and colour are rendered by `printVersionStatus`, so there is exactly
 * one place that decides how a version verdict looks.
 */
interface VersionNotice {
    currentVersion: string;
    latestVersion: string;
    installKind: InstallKind;
    /** Cache file `printVersionStatus` advances once the notice is displayed.
     *  Internal plumbing; callers should not read it. */
    cacheFile: string;
}

/** Green when current, orange when a newer release exists, gray when unknown. */
type VersionState = 'up-to-date' | 'update-available' | 'unknown';

interface VersionStatus {
    /** Installed version — `Config.VERSION` unless overridden. */
    currentVersion: string;
    /** Latest version observed this run, or from the throttle cache. Null when
     *  the probe failed, which renders as `unknown`. */
    latestVersion: string | null;
    installKind: InstallKind;
    state: VersionState;
    /** Id of the source that answered (`npm` / `github`). */
    source?: string;
    /** Why the probe could not answer — `ENOTFOUND`, `HTTP 403`, `timeout`…
     *  Only set when `state === 'unknown'`; rendered in the verdict so the
     *  operator can act instead of guessing. */
    reason?: string;
    /** True when the staged wait gave up: nothing answered at all, so the
     *  information is MISSING rather than the check having failed. Rendered
     *  differently — "no current version information" must not read as
     *  "could not check", and neither may read as "up to date". */
    exhausted?: boolean;
    /** Cache file backing the throttle. Plumbing; callers should not read it. */
    cacheFile: string;
    /** Present only when a NEWER version exists AND it has not been announced
     *  yet. Carries the one-time hint; `printVersionStatus` is the only path
     *  that latches it. */
    notice: VersionNotice | null;
}

interface VersionCheckCache {
    version: number;
    updatedAt: string;
    /** Epoch ms of the last probe, successful or not. Drives the throttle:
     *  NOTICE_INTERVAL_MS after a success, NOTICE_RETRY_MS after a failure. */
    lastCheckMs: number;
    /** Latest version observed — null when the probe failed. */
    latestVersion: string | null;
    /** Version already announced to the operator, so it is never repeated. */
    notifiedVersion: string | null;
    /** Source that answered (`npm` / `github`); diagnostics only. */
    source?: string;
    /** Why the last probe failed; kept so a throttled run can still explain
     *  itself without spending a request. */
    lastError?: string;
}

interface VersionNoticeOptions {
    /** Override the installed version (defaults to `Config.VERSION`). */
    currentVersion?: string;
    /** Override the cache location (tests). */
    cacheFile?: string;
    /** Override the throttle window in ms for a SUCCESSFUL cached observation
     *  (tests). 0 disables throttling. */
    intervalMs?: number;
    /** Override the backoff in ms after a FAILED observation (tests). 0
     *  disables throttling, so every run re-probes. */
    retryMs?: number;
    /** Override the registry URL (tests). Pass '' to model an unconfigured setup. */
    registryUrl?: string;
    /** Override the GitHub releases URL (tests). '' / 'off' disables it. */
    githubReleaseUrl?: string;
    /** Override `UPDATER.NOTICE_ENABLED` (tests). */
    enabled?: boolean;
    /** Override install-kind detection (tests). */
    installKind?: InstallKind;
    /** Injectable fetch, for offline/hermetic tests. */
    fetchImpl?: FetchImpl;
    /** Injected clock (tests). */
    now?: number;
    /** Ignore the throttle window. */
    force?: boolean;
    /** Override the network timeout in ms (tests; a shorter `dexbot status`). */
    timeoutMs?: number;
}

const CACHE_VERSION = 1;
/** Matches UPDATER.NOTICE_TIMEOUT_MS default; kept local so a malformed
 *  general.settings.json can never turn the probe into an open-ended hang. */
const MAX_TIMEOUT_MS = 10_000;

/**
 * Minimal semver comparison for `major.minor.patch` strings.
 * Returns negative when a < b, 0 when equal, positive when a > b.
 *
 * Prerelease and build metadata are stripped: `1.6.7-beta.1` and `1.6.7`
 * compare EQUAL. That is the intended reading for an update hint — a locally
 * built prerelease is not "older" than the published release, and comparing it
 * as `1.6.7.1 > 1.6.7` would permanently hide real updates from anyone
 * running a source checkout. A non-numeric segment degrades to 0 rather than
 * producing NaN ordering.
 */
export function compareVersions(a: string, b: string): number {
    // The leading `v` is stripped because the two sources spell it
    // differently: a GitHub release tag is `v1.6.8`, the npm dist-tag document
    // says `1.6.8`. Without this, `v1.6.8` parsed to [0,6,8] and compared as
    // an ancient version — a source-spelling artefact masquerading as "an
    // update is available".
    const parse = (v: unknown) =>
        String(v ?? '').trim().replace(/^[vV]/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
    const na = parse(a);
    const nb = parse(b);
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
        const va = na[i] ?? 0;
        const vb = nb[i] ?? 0;
        if (va !== vb) return va < vb ? -1 : 1;
    }
    return 0;
}

/** Classify the running install without spawning anything. */
export function detectInstallKind(projectRoot: string = PATHS.PROJECT_ROOT): InstallKind {
    if (isGlobalNpmPackageDir(projectRoot)) return 'npm-global';
    try {
        if (storage.exists(path.join(projectRoot, '.git'))) return 'git';
    } catch {
        /* fall through to 'other' */
    }
    return 'other';
}

/** Minimal structural view of a fetch response used by the probe. */
interface FetchResponseLike {
    ok?: boolean;
    status?: number;
    json(): Promise<unknown>;
}

type FetchImpl = (
    url: string,
    init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<FetchResponseLike | null | undefined>;

/** One place the published version can be read from. */
interface VersionSource {
    id: string;
    url: string;
    /** Pull the version out of the source's JSON shape. Returns null when the
     *  document does not carry a usable version (bad payload). */
    extract: (body: unknown) => string | null;
}

/** npm's dist-tag document: `{ "version": "1.6.8", ... }`. */
const NPM_EXTRACT = (body: unknown): string | null =>
    typeof (body as { version?: unknown } | null)?.version === 'string' && (body as { version: string }).version.trim() ? (body as { version: string }).version.trim() : null;

/**
 * GitHub's latest-release document: `{ "tag_name": "v1.6.8", ... }`. The tag
 * is normalised (leading `v` dropped) by `compareVersions`, so the two
 * sources are directly comparable.
 */
const GITHUB_EXTRACT = (body: unknown): string | null => {
    const rec = body as { tag_name?: unknown; name?: unknown } | null;
    const tag = rec?.tag_name ?? rec?.name;
    return typeof tag === 'string' && tag.trim() ? tag.trim() : null;
};

/**
 * Derive the GitHub "latest release" endpoint from the configured repository
 * URL, so a fork or a self-hosted mirror is honoured without a second hardcoded
 * owner/repo. Returns null for anything that is not a github.com repository —
 * a non-GitHub host has a different API shape and guessing it would produce a
 * guaranteed-wrong request on every probe.
 */
export function deriveGithubReleaseUrl(repositoryUrl: string | undefined, apiBase: string): string | null {
    const raw = String(repositoryUrl ?? '').trim();
    if (!raw) return null;
    const m = raw.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
    if (!m) return null;
    const base = String(apiBase || 'https://api.github.com').replace(/\/+$/, '');
    return `${base}/repos/${m[1]}/${m[2]}/releases/latest`;
}

/**
 * The probe's sources, in priority order.
 *
 * npm FIRST, GitHub second — measured, and the order is load-bearing:
 *
 *   latency      a wash. Warm, interleaved: npm p50 21ms / github p50 18ms.
 *                Cold process: npm 92-102ms / github 97-99ms. GitHub being
 *                ~3ms "faster" is noise, not a reason to reorder.
 *   payload      npm 8KB vs github 40KB (the release document carries the
 *                body, assets and author objects). 5x for the same answer.
 *   rate limit   the GitHub API is 60 requests/hour per IP unauthenticated
 *                and answers 403 when spent; npm has no comparable ceiling.
 *                Our own 12h throttle keeps us far below it, but a shared
 *                server IP or a retry burst is not ours to control.
 *   AUTHORITY    the deciding one. The release pipeline creates the GitHub
 *                release FIRST and publishes to npm ~4-9 minutes LATER
 *                (1.6.8 10:15:14Z vs 10:24:00Z; 1.6.7 09:08:48 vs 09:13:15;
 *                1.6.6 00:49:52 vs 00:54:27). GitHub-first would therefore
 *                spend that window telling operators a new version exists
 *                while `dexbot update` still installs the old one — a hint
 *                that is not merely early but wrong. npm lagging by the same
 *                minutes is harmless: it says "up to date" a little longer.
 *
 * The cost of this order is the one case that measurably suffers: on a host
 * that cannot reach the registry at all, the fallback answer arrives after the
 * first source's share of the budget is spent (~1.6s of the 3s), versus ~20ms
 * if GitHub went first. That is the right trade — a slow answer is still an
 * answer, and the alternative is an answer that is wrong for the first minutes
 * of every release.
 */
export function resolveReleaseSources(options: {
    registryUrl?: string;
    githubReleaseUrl?: string;
    repositoryUrl?: string;
    apiBase?: string;
} = {}): VersionSource[] {
    const sources: VersionSource[] = [];
    const npmUrl = options.registryUrl !== undefined ? options.registryUrl : UPDATER?.REGISTRY_URL;
    if (npmUrl) sources.push({ id: 'npm', url: String(npmUrl), extract: NPM_EXTRACT });

    const configured = options.githubReleaseUrl !== undefined
        ? options.githubReleaseUrl
        : UPDATER?.GITHUB_RELEASE_URL;
    // 'off' (any case) disables the fallback explicitly; an empty value means
    // "derive it from the repository we already know about".
    const disabled = typeof configured === 'string' && ['off', 'none', 'false', 'disabled'].includes(configured.trim().toLowerCase());
    const githubUrl = disabled
        ? null
        : (String(configured ?? '').trim() || deriveGithubReleaseUrl(
            options.repositoryUrl !== undefined ? options.repositoryUrl : UPDATER?.REPOSITORY_URL,
            options.apiBase ?? UPDATER?.GITHUB_API_BASE ?? 'https://api.github.com',
        ));
    if (githubUrl) sources.push({ id: 'github', url: githubUrl, extract: GITHUB_EXTRACT });
    return sources;
}

/**
 * The single status line, shared by `dexbot stat` and every launcher start.
 *
 * GREEN when the install matches the published version, ORANGE when a newer
 * release exists, GRAY when the probe could not answer (offline / throttled
 * with no prior observation) — an unknown answer must never be rendered as
 * "up to date". The installed version is always named, so a caller never needs
 * a second "DEXBot2 vX.Y.Z" header of its own. The unknown verdict carries the
 * probe's reason, because an unnamed "?" tells the operator nothing they can
 * act on.
 */
export function formatVersionStatusLine(status: Pick<VersionStatus, 'currentVersion' | 'latestVersion' | 'state'> & { reason?: string; exhausted?: boolean }): string {
    const c = CLI_COLORS;
    const current = `DEXBot2 v${status.currentVersion}`;
    if (status.state === 'up-to-date') {
        return `${current}  ${c.brightGreen}✓${c.reset} ${c.greenBold}Your version is up to date.${c.reset}`;
    }
    if (status.state === 'update-available') {
        return `${current}  ${c.orange}⬆${c.reset} ${c.orange}A new version is available: v${status.latestVersion}.${c.reset}`;
    }
    // The staged wait gave up: say the information is missing. Distinct from
    // the branch below, where a probe ran and told us it failed.
    if (status.exhausted) {
        return `${current}  ${c.gray}? No current version information (${status.reason ?? 'no answer'}).${c.reset}`;
    }
    const why = status.reason ? ` (${status.reason})` : '';
    return `${current}  ${c.gray}? Could not check for a newer version${why}.${c.reset}`;
}

/**
 * Hint text. `dexbot update` is the correct verb for BOTH layouts: the npm
 * flow does `npm install -g <pkg>@<latest>`, the git flow does
 * `fetch` + `pull` + rebuild + runtime restart. `update` is only complete
 * once active bots have been restarted onto the new code, which a bare
 * `git pull` in a terminal would not do.
 */
function formatVersionHint(installKind: InstallKind): string {
    return installKind === 'git'
        ? `Run \`dexbot update\` to pull it and restart your bots.`
        : `Run \`dexbot update\` to install it and restart your bots.`;
}

function readCache(file: string): VersionCheckCache | null {
    try {
        const payload = readJSON(file);
        if (!payload || payload.version !== CACHE_VERSION) return null;
        if (!Number.isFinite(payload.lastCheckMs)) return null;
        // Reject a foreign schema rather than trusting hand-edited types: a
        // non-string version would otherwise flow into compareVersions.
        if (payload.latestVersion != null && typeof payload.latestVersion !== 'string') return null;
        if (payload.notifiedVersion != null && typeof payload.notifiedVersion !== 'string') return null;
        return payload as unknown as VersionCheckCache;
    } catch {
        return null;
    }
}

function writeCache(file: string, cache: VersionCheckCache): void {
    try {
        writeJsonFileAtomic(file, cache);
    } catch {
        // A read-only or full profiles dir must never fail a startup.
    }
}

function resolveTimeoutMs(override?: number): number {
    const raw = override !== undefined ? Number(override) : Number(UPDATER?.NOTICE_TIMEOUT_MS);
    if (!Number.isFinite(raw) || raw <= 0) return 2_000;
    return Math.min(raw, MAX_TIMEOUT_MS);
}

/** Outcome of one source attempt. `version` is null on every failure path and
 *  `reason` then says why — the whole point of the multi-source rewrite. */
interface SourceAttempt {
    sourceId: string;
    version: string | null;
    reason?: string;
}

/** Turn a thrown fetch error into something an operator can act on. The
 *  `cause.code` is the useful part (`ENOTFOUND`, `ECONNREFUSED`,
 *  `CERT_HAS_EXPIRED`, `UND_ERR_SOCKET`); the wrapper message is noise. */
function describeFetchError(err: unknown, source: VersionSource, timeoutMs: number): string {
    const e = err as { cause?: { code?: unknown }; code?: unknown; name?: unknown; message?: unknown } | null | undefined;
    const code = e?.cause?.code || e?.code;
    if (code) return `${source.id}: ${code}`;
    const name = String(e?.name ?? '');
    if (name === 'AbortError' || name === 'TimeoutError') return `${source.id}: timeout after ${timeoutMs}ms`;
    const message = String(e?.message ?? '').trim();
    return message ? `${source.id}: ${message.split('\n')[0].slice(0, 60)}` : `${source.id}: request failed`;
}

/**
 * Query ONE source. Resolves with a version or with a reason; never throws and
 * never rejects, so the sequential fallback in `probeReleaseSources` cannot be
 * short-circuited by a single bad source.
 */
async function fetchFromSource(source: VersionSource, timeoutMs: number, fetchImpl?: FetchImpl): Promise<SourceAttempt> {
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) {
        // Node < 18 (or a stripped runtime) has no global fetch. That is a
        // permanent, not transient, condition — say so instead of "unknown".
        return { sourceId: source.id, version: null, reason: `${source.id}: no fetch available (Node >= 18 required)` };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;

    // The attempt never rejects, so racing it cannot leak an unhandled
    // rejection. The enclosing timeout is a HARD backstop: it resolves even
    // when no AbortController exists or a custom fetch ignores the signal, so
    // the "never blocks startup" guarantee does not depend on either. Without
    // it, a hung registry socket could stall a terminal `flushVersionStatus`
    // ahead of `process.exit()` and freeze `dexbot start`.
    const attempt = (async (): Promise<SourceAttempt> => {
        try {
            const res = await doFetch(source.url, {
                method: 'GET',
                headers: { accept: 'application/json' },
                signal: controller?.signal,
            });
            if (!res) return { sourceId: source.id, version: null, reason: `${source.id}: empty response` };
            if (res.ok === false) return { sourceId: source.id, version: null, reason: `${source.id}: HTTP ${res.status}` };
            const body = await res.json();
            const version = source.extract(body);
            if (!version) return { sourceId: source.id, version: null, reason: `${source.id}: no version in response` };
            return { sourceId: source.id, version };
        } catch (err) {
            return { sourceId: source.id, version: null, reason: describeFetchError(err, source, timeoutMs) };
        }
    })();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<SourceAttempt>((resolve) => {
        timer = setTimeout(() => {
            timedOut = true;
            try { controller?.abort(); } catch { /* best-effort cancel */ }
            resolve({ sourceId: source.id, version: null, reason: `${source.id}: timeout after ${timeoutMs}ms` });
        }, timeoutMs);
    });

    try {
        const result = await Promise.race([attempt, timeout]);
        // Prefer the explicit timeout verdict: an aborted fetch usually rejects
        // with a bare "aborted", which is a much worse thing to show.
        return timedOut ? { sourceId: source.id, version: null, reason: `${source.id}: timeout after ${timeoutMs}ms` } : result;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** What the whole probe concluded. */
export interface ProbeResult {
    version: string | null;
    source?: string;
    /** Every source's failure reason, in the order they were tried. */
    reasons: string[];
}

/**
 * Try the sources in order and take the first answer. The total budget is split
 * EVENLY rather than spent first-come: a source that hangs until the deadline
 * would otherwise leave the fallback with no time at all, which is precisely
 * the case the fallback exists for.
 */
export async function probeReleaseSources(
    sources: VersionSource[],
    timeoutMs: number,
    fetchImpl?: FetchImpl,
): Promise<ProbeResult> {
    if (!sources.length) return { version: null, reasons: ['no version source configured'] };
    const perSource = Math.max(1, Math.floor(timeoutMs / sources.length));
    const reasons: string[] = [];
    for (const source of sources) {
        const result = await fetchFromSource(source, perSource, fetchImpl);
        if (result.version) return { version: result.version, source: result.sourceId, reasons };
        if (result.reason) reasons.push(result.reason);
    }
    return { version: null, reasons };
}

/** Assemble a status; `includeNotice` is false on the throttled path, which
 *  reports the cached observation but never re-announces. */
function buildVersionStatus(
    currentVersion: string,
    latestVersion: string | null,
    installKind: InstallKind,
    cacheFile: string,
    includeNotice: boolean,
    extra: { source?: string; reason?: string; exhausted?: boolean } = {},
): VersionStatus {
    const state: VersionState = !latestVersion
        ? 'unknown'
        : compareVersions(currentVersion, latestVersion) < 0 ? 'update-available' : 'up-to-date';
    const notice = state === 'update-available' && includeNotice && latestVersion
        ? { currentVersion, latestVersion, installKind, cacheFile }
        : null;
    return { currentVersion, latestVersion, installKind, state, cacheFile, notice, ...extra };
}

/**
 * How long a cached observation stays valid. A SUCCESS is worth a full
 * `UPDATER.NOTICE_INTERVAL_MS` (12h): the published version does not move under
 * us, and every run consults this cache before spending a request. A FAILURE is
 * re-tried after `UPDATER.NOTICE_RETRY_MS` — throttling a failure for the full
 * success window is what turned one 5s network hiccup into a permanent
 * "could not check", with no retry left to disprove it.
 */
function resolveThrottleMs(previous: VersionCheckCache | null, options: VersionNoticeOptions): number {
    // `NOTICE_INTERVAL_MS: 0` is the documented "check on every start" opt-in.
    // It must disable BOTH windows: leaving the failure backoff in force would
    // silently throttle exactly the case an operator turned throttling off to
    // diagnose.
    if (options.intervalMs === 0 || options.retryMs === 0) return 0;
    if (Number(UPDATER?.NOTICE_INTERVAL_MS ?? 0) === 0) return 0;
    const failed = !previous || previous.latestVersion == null;
    const override = failed ? options.retryMs : options.intervalMs;
    if (override !== undefined) return Math.max(0, Number(override) || 0);
    const configured = failed
        ? Number(UPDATER?.NOTICE_RETRY_MS ?? 0)
        : Number(UPDATER?.NOTICE_INTERVAL_MS ?? 0);
    return Number.isFinite(configured) ? configured : 0;
}

/**
 * Start the check. Resolves with the installed-vs-published status, plus a
 * `notice` when a NEWER version exists and that version has not been
 * announced yet. Resolves null only when the whole feature is switched off.
 * Rejects never.
 */
export function startVersionStatusCheck(options: VersionNoticeOptions = {}): Promise<VersionStatus | null> {
    // Every early return is a resolved null so callers can always await.
    const done = (value: VersionStatus | null | undefined): Promise<VersionStatus | null> =>
        Promise.resolve(value ?? null);

    if (!hasProcess()) return done(null);
    if (Config.DEXBOT_SKIP_VERSION_NOTICE) return done(null);
    const noticeEnabled = options.enabled ?? UPDATER?.NOTICE_ENABLED !== false;
    if (!noticeEnabled) return done(null);

    const cacheFile = options.cacheFile || PATHS.PROFILES.VERSION_CHECK_JSON;
    const now = options.now ?? Date.now();
    const previous = readCache(cacheFile);

    // `??` (not `||`) so an explicitly empty current version is reported as
    // "unknown" and stays silent rather than falling back to a real version.
    const currentVersion = options.currentVersion ?? Config.VERSION;
    if (!currentVersion) return done(null);

    const sources = resolveReleaseSources({
        ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
        ...(options.githubReleaseUrl !== undefined ? { githubReleaseUrl: options.githubReleaseUrl } : {}),
    });
    if (!sources.length) {
        // No source configured — do not even write a cache entry, so
        // enabling it later takes effect on the very next start.
        return done(null);
    }
    const installKind = options.installKind || detectInstallKind();

    // Throttle: a recent probe means stay quiet, so a node never pays the
    // network timeout on every single restart. The cached observation still
    // answers "am I current?" without spending a request — including when the
    // cached observation is a failure, which is rendered WITH its reason.
    const force = options.force ?? Config.DEXBOT_VERSION_CHECK_FORCE;
    const throttleMs = resolveThrottleMs(previous, options);
    if (!force && throttleMs > 0 && previous) {
        if (now - previous.lastCheckMs < throttleMs) {
            return done(buildVersionStatus(currentVersion, previous.latestVersion, installKind, cacheFile, false, {
                source: previous.source,
                reason: previous.latestVersion == null ? previous.lastError : undefined,
            }));
        }
    }

    return (async () => {
        const probe = await probeReleaseSources(sources, resolveTimeoutMs(options.timeoutMs), options.fetchImpl);
        const reason = probe.version ? undefined : (probe.reasons.join('; ') || 'probe failed');

        // Record the observation but DO NOT latch here: `notifiedVersion` is
        // advanced by `printVersionStatus` only once the hint is displayed.
        const base: VersionCheckCache = {
            version: CACHE_VERSION,
            updatedAt: new Date(now).toISOString(),
            lastCheckMs: now,
            latestVersion: probe.version ?? null,
            notifiedVersion: previous?.notifiedVersion ?? null,
            source: probe.source ?? previous?.source,
            lastError: reason,
        };
        writeCache(cacheFile, base);

        const status = buildVersionStatus(currentVersion, probe.version, installKind, cacheFile, true, {
            source: probe.source,
            reason,
        });
        // Same version already announced: keep reporting the state, drop only
        // the one-time hint.
        if (status.notice && previous?.notifiedVersion === status.notice.latestVersion) {
            return { ...status, notice: null };
        }
        return status;
    })().catch(() => null);
}

/**
 * Advance the notify-once latch for a notice that was actually displayed.
 * Separate from the probe so a notice the caller never surfaces cannot be
 * silently consumed — the next launcher run re-offers it. The latch only ever
 * moves forward, so a registry that briefly serves an older `latest`
 * (dist-tag rollback) cannot make an already-announced version reappear.
 */
function latchVersionNotice(notice: VersionNotice): void {
    try {
        const existing = readCache(notice.cacheFile);
        const announced = existing?.notifiedVersion ?? null;
        if (announced && compareVersions(announced, notice.latestVersion) >= 0) return;
        const next: VersionCheckCache = {
            version: CACHE_VERSION,
            updatedAt: existing?.updatedAt ?? new Date().toISOString(),
            lastCheckMs: existing?.lastCheckMs ?? 0,
            latestVersion: existing?.latestVersion ?? notice.latestVersion,
            notifiedVersion: notice.latestVersion,
            // Diagnostics survive the latch, so a later throttled run can still
            // name the source that answered / why the last probe failed.
            source: existing?.source,
            lastError: existing?.lastError,
        };
        writeCache(notice.cacheFile, next);
    } catch {
        // Best-effort: a read-only profiles dir must never fail a startup.
    }
}

/**
 * Print the status line (plus the install hint when a NEW, unannounced
 * version exists) and commit the notify-once latch for that hint. The single
 * print path for every caller, so latching cannot drift from display.
 */
export function printVersionStatus(status: VersionStatus | null | undefined, options: { indent?: string; surround?: boolean } = {}): void {
    if (!status) return;
    const c = CLI_COLORS;
    const indent = options.indent ?? '  ';
    const surround = options.surround !== false;
    if (surround) console.log();
    console.log(`${indent}${formatVersionStatusLine(status)}`);
    if (status.notice) {
        console.log(`${indent}  ${c.gray}${formatVersionHint(status.installKind)}${c.reset}`);
        latchVersionNotice(status.notice);
    }
    if (surround) console.log();
}

/**
 * The entry-point renderer: the status line when there is one, the bare
 * installed-version header when the check is switched off.
 *
 * `printVersionStatus(null)` is a deliberate no-op, which is right for a
 * caller that only wants the line — but every CLI entry point must still name
 * the running build when the notice is disabled
 * (`DEXBOT_SKIP_VERSION_NOTICE=1` / `UPDATER.NOTICE_ENABLED=false`), and
 * re-implementing that fallback per entry point is how they drift: `dexbot
 * stat` had it, `dexbot pm2` did not, so a node with the notice off learned its
 * version from one command and not the other. One helper, one behaviour.
 */
export function printVersionStatusOrHeader(
    status: VersionStatus | null | undefined,
    options: { indent?: string; surround?: boolean } = {},
): void {
    if (status) {
        printVersionStatus(status, options);
        return;
    }
    const indent = options.indent ?? '  ';
    if (options.surround !== false) console.log();
    console.log(`${indent}DEXBot2 v${Config.VERSION}`);
    if (options.surround !== false) console.log();
}

/**
 * Await an already-started check and print its status. The single flush path
 * for callers (`unlock.ts`, `pm2.ts`) that start the probe early and surface it
 * only at a terminal point, so the await+print pair is not reimplemented per
 * call site.
 */
export async function flushVersionStatus(pending: Promise<VersionStatus | null>): Promise<void> {
    printVersionStatus(await pending);
}

/**
 * The flush counterpart of `printVersionStatusOrHeader`, for callers that start
 * the probe early and surface it at a terminal point (`unlock.ts`, `pm2.ts`).
 * A null status is the "check switched off" signal, so the installed version is
 * still named - the same single behaviour the stat path gets.
 */
export async function flushVersionStatusOrHeader(pending: Promise<VersionStatus | null>): Promise<void> {
    printVersionStatusOrHeader(await pending);
}

/**
 * Print the status when the probe settles, WITHOUT awaiting it. For launch
 * paths that must never delay the bot start — the resident process outlives the
 * probe, so there is no `process.exit()` to truncate it.
 *
 * Uses the header-aware renderer: an entry point must name the running build
 * even when the check is switched off, and this is the non-awaited form of the
 * same contract as `flushVersionStatusOrHeader`.
 */
export function printVersionStatusWhenReady(pending: Promise<VersionStatus | null>): void {
    void pending.then(printVersionStatusOrHeader, () => {});
}

// ── Staged wait (dexbot stat) ───────────────────────────────────────────
//
// A status command has TWO natural moments to show a version verdict, and
// neither is "block the whole report on the network":
//
//   top    wait UPDATER.NOTICE_STAGE_GRACE_MS (1s). A valid cache or a quick
//          registry answer lands here and the report never notices.
//   bottom if it has not landed, give the in-flight probe one more grace
//          period, then ASK AGAIN with a forced, full-budget probe — the first
//          attempt may have failed fast (ENOTFOUND) or spent its share of the
//          budget on a source that is simply blocked.
//   bottom if that answers nothing either, say so explicitly: "no current
//          version information". An operator must never be left believing a
//          silent, missing line means "you are up to date".
//
// The two moments are exposed as two promises so the caller can await the
// first at the top of its output and the second at the end, and the policy
// (how long, how many attempts, what to say when it all fails) stays here
// rather than being re-spelled per call site.

interface StagedVersionNoticeOptions extends VersionNoticeOptions {
    /** Wait at the top of the command before the caller prints anything else.
     *  Default `UPDATER.NOTICE_STAGE_GRACE_MS` (1s). */
    graceMs?: number;
    /** Budget for the final forced re-probe. Default
     *  `UPDATER.NOTICE_STATUS_TIMEOUT_MS`. */
    finalMs?: number;
}

interface StagedVersionWait {
    /** The status if it lands within `graceMs`, else null. Await this at the
     *  top of a report; the value is only interesting for its TIMING. */
    quick: Promise<VersionStatus | null>;
    /** The status to display at the end. Never "still in flight": it resolves
     *  with a definitive answer, or with an exhausted status naming the
     *  absence of information. Resolves null only when the feature is off. */
    settled: Promise<VersionStatus | null>;
}

/**
 * Race `promise` against `ms`. Resolves `{ hit: true, value }` when the
 * promise wins and `{ hit: false }` when the timer does. The timer is always
 * cleared once the promise wins, so a fast answer never leaves a pending timer
 * behind — and nothing is unref'd, because a test awaiting `settled` must not
 * have the process exit from under it.
 */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ hit: boolean; value?: T }> {
    if (!Number.isFinite(ms) || ms <= 0) {
        return promise.then((value) => ({ hit: true, value }), () => ({ hit: false }));
    }
    return new Promise((resolve) => {
        let done = false;
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
            if (done) return;
            done = true;
            resolve({ hit: false });
        }, ms);
        promise.then(
            (value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ hit: true, value });
            },
            () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ hit: false });
            },
        );
    });
}

function resolveGraceMs(override?: number): number {
    const raw = override !== undefined ? Number(override) : Number(UPDATER?.NOTICE_STAGE_GRACE_MS);
    if (!Number.isFinite(raw) || raw <= 0) return 1_000;
    return Math.min(raw, MAX_TIMEOUT_MS);
}

/** Budget for the final re-probe; falls back to the launcher default so a
 *  malformed settings file cannot turn it into an open-ended hang. */
function resolveFinalTimeoutMs(override?: number, inherited?: number): number {
    const raw = override !== undefined
        ? Number(override)
        : inherited !== undefined
            ? Number(inherited)
            : Number(UPDATER?.NOTICE_STATUS_TIMEOUT_MS ?? UPDATER?.NOTICE_TIMEOUT_MS);
    if (!Number.isFinite(raw) || raw <= 0) return 3_000;
    return Math.min(raw, MAX_TIMEOUT_MS);
}

/** The explicit "we have no version information" verdict. Distinct from a
 *  probe that RAN and failed: here nothing answered at all, and the operator
 *  is told the information is missing rather than that the check failed. */
function buildExhaustedStatus(
    currentVersion: string,
    installKind: InstallKind,
    cacheFile: string,
    sourceLabels: string[],
    budgetMs: number,
): VersionStatus {
    const who = sourceLabels.length ? sourceLabels.join(' / ') : 'the release sources';
    return buildVersionStatus(currentVersion, null, installKind, cacheFile, false, {
        exhausted: true,
        reason: `${who} did not answer within ${budgetMs}ms`,
    });
}

/**
 * The one wording a staged caller shows for "we still do not know".
 *
 * Without this, `dexbot stat` could end on either "could not check
 * (npm: timeout after 2000ms)" or "no current version information" depending
 * on whether the forced re-probe happened to return a failed status or simply
 * never answered. Both are honest, but the operator reads them as two
 * different problems, and neither states what matters after the full
 * escalation: the answer is MISSING. A caller that escalated has waited, so it
 * says so; the inline launcher path, which never escalated, keeps the more
 * specific "could not check (reason)".
 */
function asExhausted(status: VersionStatus | null): VersionStatus | null {
    if (!status || status.exhausted || status.state !== 'unknown') return status;
    return { ...status, exhausted: true };
}

/**
 * Start the probe and expose the two moments described above. The first probe
 * is started immediately; `quick` settles within the grace period and `settled`
 * carries the whole escalation.
 */
export function startStagedVersionStatus(options: StagedVersionNoticeOptions = {}): StagedVersionWait {
    const { graceMs, finalMs, ...probeOptions } = options;
    const grace = resolveGraceMs(graceMs);
    const budget = resolveFinalTimeoutMs(finalMs, probeOptions.timeoutMs);

    // `tracked` records that the FIRST probe reached a verdict of its own
    // (including "the feature is off", which resolves immediately), so the
    // escalation below can tell "no answer yet" from "nothing to report".
    let firstSettled = false;
    const first = startVersionStatusCheck({ ...probeOptions, timeoutMs: budget });
    const tracked = first.then(
        (value) => { firstSettled = true; return value; },
        () => { firstSettled = true; return null; },
    );

    const quick = settleWithin(tracked, grace).then((r) => (r.hit ? r.value ?? null : null));

    const settled = (async (): Promise<VersionStatus | null> => {
        // 1) Landed during the top-of-command grace (or the cache answered).
        const early = await settleWithin(tracked, grace);
        if (early.hit) return asExhausted(early.value ?? null);

        // 2) End of the report: one more grace period for the in-flight probe.
        const late = await settleWithin(tracked, grace);
        if (late.hit) return asExhausted(late.value ?? null);

        // 3) Nothing yet. A disabled feature always resolves instantly, so
        //    still being in flight here means the probe is genuinely slow or
        //    the network is broken — ask once more, ignoring the throttle (a
        //    cached FAILURE would otherwise be re-reported for the whole
        //    retry backoff without a single request being made).
        const retry = settleWithin(
            startVersionStatusCheck({ ...probeOptions, timeoutMs: budget, force: true }),
            budget,
        );
        const retried = await retry;
        if (retried.hit) {
            // A null here can only mean the feature was switched off between
            // the two probes; honour it rather than inventing a verdict.
            if (retried.value) return asExhausted(retried.value);
            if (firstSettled) return null;
        }

        return buildExhaustedStatus(
            probeOptions.currentVersion ?? Config.VERSION,
            probeOptions.installKind || detectInstallKind(),
            probeOptions.cacheFile || PATHS.PROFILES.VERSION_CHECK_JSON,
            resolveReleaseSources({
                ...(probeOptions.registryUrl !== undefined ? { registryUrl: probeOptions.registryUrl } : {}),
                ...(probeOptions.githubReleaseUrl !== undefined ? { githubReleaseUrl: probeOptions.githubReleaseUrl } : {}),
            }).map((s) => s.id),
            budget,
        );
    })().catch(() => null);

    return { quick, settled };
}
