'use strict';

import { path } from '../path_api.js';
import { getStorage } from '../storage/index.js';
import { spawn } from 'node:child_process';
import { PATHS } from '../paths.js';
import { buildScopedChildEnv } from './child_env.js';
import { UPDATER, LAUNCHER } from '../constants.js';
import { readProcStat } from './status_reporting.js';
import * as foreignCredDaemon from './foreign_cred_daemon.js';
import { Config } from '../config.js';
import { runtime } from '../runtime.js';
import { getCredentialReadyFilePath, getCredentialSocketPath } from '../credential_runtime.js';
import { resolveRawBotEntries, loadSettingsFile } from '../bot_settings.js';
import { sleep } from '../order/utils/system.js';
import * as chainKeys from '../chain_keys.js';

const storage = getStorage();
const { unlink: safeUnlink } = storage;
import {
    isPidAlive,
    usesAmaGridPrice,
    parseCronExpression,
    getNextCronDate,
    isNodeProcessWithExactScript,
} from './bot_supervisor.js';
import { buildRuntimeScriptArgs, SCRIPTS_ROOT as CODE_ROOT } from './runtime_entry.js';
import { LAUNCHER_WORKER_COMMAND } from './launch_modes.js';
import { getErrorMessage } from '../utils/errors.js';
import { isSameBotName } from '../utils/sanitize_key.js';
import { buildAdapterFingerprint } from './adapter_requirement.js';

const MONOLITHIC_PID_FILE = PATHS.PROFILES.MONOLITHIC_PID;
const MONOLITHIC_BOT_PID_FILE = PATHS.PROFILES.MONOLITHIC_BOT_PID;
const MONOLITHIC_BOT_INFO_FILE = PATHS.PROFILES.MONOLITHIC_BOT_INFO;
const MONOLITHIC_CRED_PID_FILE = PATHS.PROFILES.MONOLITHIC_CRED_PID;
const MONOLITHIC_OUT_LOG = path.join(PATHS.LOGS_DIR, 'dexbot.log');
const MONOLITHIC_ERROR_LOG = path.join(PATHS.LOGS_DIR, 'dexbot-error.log');
const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const CREDENTIAL_SOCKET_FILE = getCredentialSocketPath();
const CREDENTIAL_READY_FILE = getCredentialReadyFilePath();

function formatBotCount(count: number) {
    return `${count} ${count === 1 ? 'bot' : 'bots'}`;
}

// ── PID file management ────────────────────────────────────────────

function cleanupStateFiles() {
    safeUnlink(MONOLITHIC_PID_FILE)
    safeUnlink(MONOLITHIC_BOT_PID_FILE)
    safeUnlink(MONOLITHIC_BOT_INFO_FILE)
}

function readLiveMonolithicPid() {
    if (!storage.exists(MONOLITHIC_PID_FILE)) return { pid: 0, stale: false };

    let pid = 0;
    try {
        const raw = storage.readFile(MONOLITHIC_PID_FILE).trim();
        pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0) pid = 0;
    } catch (_) {
        safeUnlink(MONOLITHIC_PID_FILE)
        return { pid: 0, stale: true };
    }

    if (pid <= 0) return { pid: 0, stale: true };

    if (!isLikelyUnlockProcess(pid)) {
        safeUnlink(MONOLITHIC_PID_FILE)
        return { pid: 0, stale: true };
    }

    return { pid, stale: false };
}

function readMonolithicBotInfo() {
    try {
        const infoRaw = storage.readFile(MONOLITHIC_BOT_INFO_FILE);
        const info = JSON.parse(infoRaw);
        return info && typeof info === 'object' ? info : null;
    } catch (_) {
        return null;
    }
}

// ── Process matching ───────────────────────────────────────────────

function isLikelyCredentialDaemonProcess(pid: number) {
    return isNodeProcessWithExactScript(pid, ['credential-daemon']);
}

function isLikelyDexbotProcess(pid: number) {
    return isNodeProcessWithExactScript(pid, ['dexbot']);
}

function isLikelyUnlockProcess(pid: number) {
    return isNodeProcessWithExactScript(pid, ['unlock']);
}

function isExpectedProcessStarttime(pid: number, expectedStarttime: unknown) {
    if (typeof expectedStarttime !== 'number') return false;
    const stat = readProcStat(pid);
    return !!(stat && stat.starttime === expectedStarttime);
}

function isExpectedMonolithicBotPid(pid: number, botInfo: Record<string, unknown> | null) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    if (!botInfo || botInfo.pid !== pid) {
        return false;
    }
    if (!isLikelyDexbotProcess(pid)) {
        return false;
    }
    if (!isExpectedProcessStarttime(pid, botInfo.starttime)) {
        return false;
    }
    return true;
}

// ── Credential daemon management ───────────────────────────────────

function isProcessInDstate(pid: number): boolean {
    try {
        const stat = storage.readFile(`/proc/${pid}/stat`);
        const lastParen = stat.lastIndexOf(')');
        if (lastParen === -1) return false;
        const state = stat.slice(lastParen + 2, lastParen + 3);
        return state === 'D';
    } catch {
        return false;
    }
}

async function stopCredentialDaemonPid(pid: string | number) {
    const daemonPid = Number(pid);
    if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
        return;
    }

    if (isProcessInDstate(daemonPid)) {
        console.warn(`stopCredentialDaemonPid: pid ${daemonPid} is in uninterruptible sleep (D-state), cannot kill.`);
        return;
    }

    runtime.kill(daemonPid, 'SIGTERM');

    const startedAt = Date.now();
    while ((Date.now() - startedAt) < 5000) {
        if (!isPidAlive(daemonPid)) {
            return;
        }
        if (isProcessInDstate(daemonPid)) {
            console.warn(`stopCredentialDaemonPid: pid ${daemonPid} entered D-state during SIGTERM wait, skipping.`);
            return;
        }
        await sleep(100);
    }
    if (isProcessInDstate(daemonPid)) {
        console.warn(`stopCredentialDaemonPid: pid ${daemonPid} is in D-state, skipping SIGKILL.`);
        return;
    }

    const SIGKILL_DEADLINE_MS = LAUNCHER.MONOLITHIC.DAEMON_SIGKILL_DEADLINE_MS;
    const sigkillStartedAt = Date.now();
    const sigkillSent = runtime.kill(daemonPid, 'SIGKILL');
    if (sigkillSent) {
        while ((Date.now() - sigkillStartedAt) < SIGKILL_DEADLINE_MS) {
            if (!isPidAlive(daemonPid)) {
                return;
            }
            if (isProcessInDstate(daemonPid)) {
                console.warn(`stopCredentialDaemonPid: pid ${daemonPid} entered D-state during SIGKILL wait, skipping.`);
                return;
            }
            await sleep(100);
        }
    }

    console.warn(
        `stopCredentialDaemonPid: SIGKILL did not terminate pid ${daemonPid} after ` +
        `${Math.ceil(SIGKILL_DEADLINE_MS / 1000)}s (process may be in uninterruptible sleep).`
    );
}

function cleanupCredentialRuntimeFiles() {
    safeUnlink(CREDENTIAL_SOCKET_FILE)
    safeUnlink(CREDENTIAL_READY_FILE)
}

async function stopCredentialDaemon() {
    let pidRaw: string | null = null;
    try {
        pidRaw = storage.readFile(MONOLITHIC_CRED_PID_FILE).trim();
    } catch (_) {}

    const daemonPid = Number(pidRaw);
    if (!pidRaw || !Number.isInteger(daemonPid) || daemonPid <= 0) {
        cleanupCredentialRuntimeFiles();
        safeUnlink(MONOLITHIC_CRED_PID_FILE)
        return { signaled: false, cleaned: true };
    }

    const signaled = isPidAlive(daemonPid);
    await stopCredentialDaemonPid(daemonPid);
    cleanupCredentialRuntimeFiles();
    safeUnlink(MONOLITHIC_CRED_PID_FILE)
    return { signaled, cleaned: true };
}

async function ensureNoForeignCredentialDaemon({ verbose = true }: { verbose?: boolean } = {}) {
    return foreignCredDaemon.ensureNoForeignCredentialDaemon({
        socketPath: CREDENTIAL_SOCKET_FILE,
        readyFilePath: CREDENTIAL_READY_FILE,
        pidFile: MONOLITHIC_CRED_PID_FILE,
        isLikelyProcess: isLikelyCredentialDaemonProcess,
        verbose,
    });
}

function findCredentialSocketOwnerPid() {
    return foreignCredDaemon.findCredentialSocketOwnerPid(
        CREDENTIAL_SOCKET_FILE,
        isLikelyCredentialDaemonProcess
    );
}

async function readCredentialDaemonStatus(pid: number | null): Promise<{ alive: boolean; ready: boolean; socket: boolean }> {
    const alive = !!(pid && isLikelyCredentialDaemonProcess(pid));
    if (!alive) {
        return { alive: false, ready: false, socket: false };
    }

    try {
        const responsive = await chainKeys.isDaemonResponsive({
            socketPath: CREDENTIAL_SOCKET_FILE,
            readyFilePath: CREDENTIAL_READY_FILE,
        });
        return { alive, ready: responsive as boolean, socket: responsive as boolean };
    } catch (_) {
        return { alive, ready: false, socket: false };
    }
}

// ── Monolithic daemonization ───────────────────────────────────────

function ensureLogDir() {
    storage.ensureDir(PATHS.LOGS_DIR);
}

function buildDexbotStartArgs(botName: string | null | undefined, dryrun: boolean = false) {
    // Launch the supervised worker as `worker` so the process table identifies
    // it as the bot worker instead of the internal runner name. The worker is
    // distinguished from the `unlock` supervisor by DEXBOT_LAUNCHER_WORKER
    // (set at spawn); without it `worker` is not a public command.
    const scriptArgs = [LAUNCHER_WORKER_COMMAND];
    if (dryrun) scriptArgs.push('--dryrun');
    if (botName) scriptArgs.push(botName);
    return buildRuntimeScriptArgs({
        codeRoot: CODE_ROOT,
        scriptSegments: ['dexbot'],
        scriptArgs,
    });
}

// ── Update scheduler ───────────────────────────────────────────────

function createUpdateScheduler({ botProcessRef, warn = console.warn }: { botProcessRef?: { current: import('node:child_process').ChildProcess | null }; warn?: (...data: unknown[]) => void } = {}) {
    let _updateTimer: ReturnType<typeof setTimeout> | null = null;
    let _pendingRestart = false;
    let cancelled = false;

    function clearTimer() {
        if (_updateTimer) {
            clearTimeout(_updateTimer);
            _updateTimer = null;
        }
    }

    function scheduleNext() {
        if (cancelled) return;
        try {
            const parsed = parseCronExpression(UPDATER.SCHEDULE);
            const nextDate = getNextCronDate(parsed);
            const delay = Math.max(0, nextDate.getTime() - Date.now());
            _updateTimer = setTimeout(async () => {
                if (cancelled) return;
                const updateArgs: string[] = buildRuntimeScriptArgs({
                    codeRoot: CODE_ROOT,
                    scriptSegments: ['scripts', 'update'],
                    scriptArgs: [],
                });
                const updateChild = spawn(Config.EXEC_PATH, updateArgs, {
                    cwd: PATHS.PROJECT_ROOT,
                    stdio: 'inherit',
                    env: buildScopedChildEnv({ extra: { DEXBOT_UPDATE_SKIP_RELOAD: '1' } }),
                });
                const code = await new Promise<number | null>((resolve) => {
                    updateChild.on('close', resolve);
                    updateChild.on('error', () => resolve(-1));
                });
                if (code === 0 && !cancelled) {
                    _pendingRestart = true;
                    const bot = botProcessRef?.current;
                    if (bot && !bot.killed) {
                        try { bot.kill('SIGTERM'); } catch (_) {}
                    }
                }
                if (!cancelled) scheduleNext();
            }, delay);
            if (_updateTimer && typeof _updateTimer.unref === 'function') {
                _updateTimer.unref();
            }
        } catch (err) {
            warn(`Update scheduler: ${getErrorMessage(err)}`);
            _updateTimer = setTimeout(scheduleNext, 3600000);
            if (_updateTimer && typeof _updateTimer.unref === 'function') {
                _updateTimer.unref();
            }
        }
    }

    scheduleNext();

    return {
        cancel: () => { cancelled = true; clearTimer(); },
        get pendingRestart() { return _pendingRestart; },
        set pendingRestart(v) { _pendingRestart = v; },
    };
}

// ── Control command helpers ────────────────────────────────────────

function listConfiguredBots(botsFile?: string): Array<{ name: string; active: boolean; gridPrice: string }> {
    try {
        const botsFilePath = botsFile || BOTS_FILE;
        const { config } = loadSettingsFile(botsFilePath);
        const raw = resolveRawBotEntries(config);
        return raw.map((b) => ({
            name: b.name as string,
            active: b.active !== false,
            gridPrice: typeof b.gridPrice === 'string' ? b.gridPrice.trim().toLowerCase() : '',
        }));
    } catch {
        return [];
    }
}

function getActiveAmaBotFingerprint(botsFile?: string) {
    // Canonical semantic fingerprint (see launcher/adapter_requirement.ts):
    // identical to the per-bot snapshot fingerprint, so the wrapper watchdog
    // and wrapper-less bot fallbacks agree on what "changed" means.
    return buildAdapterFingerprint(listConfiguredBots(botsFile));
}

function getAllControlBotNames() {
    // Prefer live bots.json (current intent) over the startup snapshot.
    // Shows what the user configured, even if the wrapper hasn't respawned yet.
    const liveBots = listConfiguredBots().filter((b) => b.active).map((b) => b.name);
    if (liveBots.length > 0) {
        return liveBots;
    }
    const botInfo = readMonolithicBotInfo();
    if (Array.isArray(botInfo?.botNames) && botInfo.botNames.length > 0) {
        return (botInfo.botNames as unknown[]).map((name) => String(name));
    }
    if (botInfo?.botName) {
        return [String(botInfo.botName)];
    }
    return [];
}

function getControlBotNames(target: string | null | undefined, wholeRuntime: boolean = false) {
    if (target) return [target];
    if (wholeRuntime) return getAllControlBotNames();
    return [];
}

function getControlActionLabel(cmd: string) {
    if (cmd === 'restart' || cmd === 'restart-all') return 'restarting';
    if (cmd === 'reload' || cmd === 'reload-all') return 'reloading';
    if (cmd === 'shutdown' || cmd === 'delete') return 'shutting down';
    return 'stopping';
}

/**
 * Decide the effective `(cmd, target)` for a runtime control request.
 *
 * `all` always selects the whole runtime. A per-bot target exists only under
 * the isolated supervisor: a live monolithic runtime runs every active bot in
 * one worker, so a target cannot select a single bot and the request degrades
 * to the whole-runtime command. `delete` is whole-runtime on every surface and
 * rejects a bot target; `status` is whole-runtime and ignores one.
 *
 * Pure, so the routing contract is unit-testable without a live runtime.
 */
interface ControlRouting {
    /** Canonical command to dispatch. */
    cmd: string;
    /** Target to act on (null for a whole-runtime action). */
    target: string | null;
    /** The normalized target the user asked for, before any fold (for validation). */
    requestedTarget: string | null;
    /** True when a requested target was dropped into a whole-runtime action. */
    folded: boolean;
    /** Informational message to print when a target was folded. */
    notice: string | null;
    /** Error message when the request must be refused. */
    reject: string | null;
}

/**
 * Normalize a target selector: `all` (and empty) select the whole runtime;
 * anything else is treated as a bot name. Single source of the alias rule.
 */
function normalizeControlTarget(target?: string | null): string | null {
    return target === 'all' ? null : (target || null);
}

// Shared control/status text, built here so the same message cannot drift
// between the control router, the status validator and the status branch.
function botNotFoundMessage(name: string): string {
    return `Bot '${name}' not found in bots.json`;
}

function statusIgnoresTargetMessage(name: string): string {
    return `'status' is whole-runtime; ignoring target '${name}'.`;
}

function resolveControlRouting({ cmd, target, monolithicLive }: { cmd: string; target?: string | null; monolithicLive: boolean }): ControlRouting {
    const baseCmd = cmd === 'shutdown' ? 'delete' : cmd === 'stat' ? 'status' : cmd;
    const requestedTarget = normalizeControlTarget(target);
    if (!requestedTarget) {
        // Canonicalize the whole-runtime form so a caller that passes a bare
        // `stop`/`restart`/`reload` still gets the `*-all` command the
        // monolithic dispatch expects (the parser usually does this earlier).
        const wholeCmd = (baseCmd === 'stop' || baseCmd === 'restart' || baseCmd === 'reload')
            ? `${baseCmd}-all`
            : baseCmd;
        return { cmd: wholeCmd, target: null, requestedTarget: null, folded: false, notice: null, reject: null };
    }
    if (baseCmd === 'delete') {
        return {
            cmd: baseCmd,
            target: null,
            requestedTarget,
            folded: true,
            notice: null,
            reject: `'delete' is a whole-runtime control and does not accept a bot name; use 'dexbot delete' or 'dexbot stop ${requestedTarget}'.`,
        };
    }
    if (baseCmd === 'status') {
        return {
            cmd: baseCmd,
            target: null,
            requestedTarget,
            folded: true,
            notice: statusIgnoresTargetMessage(requestedTarget),
            reject: null,
        };
    }
    if (monolithicLive) {
        return {
            cmd: `${baseCmd}-all`,
            target: null,
            requestedTarget,
            folded: true,
            notice: `Monolithic runtime runs all active bots in one worker; '${baseCmd} ${requestedTarget}' applies to the whole runtime.`,
            reject: null,
        };
    }
    return { cmd: baseCmd, target: requestedTarget, requestedTarget, folded: false, notice: null, reject: null };
}

function getControlServiceNames(cmd: string, botNames: string[]): string[] {
    if (!['stop-all', 'restart-all', 'reload-all', 'delete', 'shutdown'].includes(cmd)) return [];
    const serviceNames: string[] = [];
    // reload-all mirrors restart-all but leaves the credential daemon untouched,
    // so it must not list the daemon as an affected service.
    if (cmd === 'restart-all' || cmd === 'delete' || cmd === 'shutdown') {
        serviceNames.push('credential daemon');
    }
    const affectedAmaBots = listConfiguredBots().some((bot) => (
        bot.active && usesAmaGridPrice(bot as unknown as Record<string, unknown>) && botNames.some((n) => isSameBotName(n, bot.name))
    ));
    if (affectedAmaBots) {
        serviceNames.push('market adapter');
    }
    return serviceNames;
}

function printControlActionSummary(action: string, botNames: string[], serviceNames: string[] = []) {
    console.log('='.repeat(50));
    console.log(`DEXBot2 ${action} ${formatBotCount(botNames.length)}`);
    console.log();
    for (const botName of botNames) {
        console.log(`- ${botName}`);
    }
    for (const serviceName of serviceNames) {
        console.log(`- ${serviceName}`);
    }
    console.log('='.repeat(50));
    console.log();
}

export { MONOLITHIC_PID_FILE, MONOLITHIC_BOT_PID_FILE, MONOLITHIC_BOT_INFO_FILE, MONOLITHIC_CRED_PID_FILE, MONOLITHIC_OUT_LOG, MONOLITHIC_ERROR_LOG, CREDENTIAL_SOCKET_FILE, CREDENTIAL_READY_FILE, cleanupStateFiles, readLiveMonolithicPid, readMonolithicBotInfo, isLikelyCredentialDaemonProcess, isExpectedMonolithicBotPid, readProcStat, isProcessInDstate, stopCredentialDaemonPid, cleanupCredentialRuntimeFiles, stopCredentialDaemon, ensureNoForeignCredentialDaemon, findCredentialSocketOwnerPid, readCredentialDaemonStatus, ensureLogDir, buildDexbotStartArgs, createUpdateScheduler, getActiveAmaBotFingerprint, listConfiguredBots, getControlBotNames, getControlActionLabel, getControlServiceNames, resolveControlRouting, normalizeControlTarget, botNotFoundMessage, statusIgnoresTargetMessage, printControlActionSummary, formatBotCount }
export type { ControlRouting };

