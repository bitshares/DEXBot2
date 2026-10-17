'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import fs from 'node:fs';
import { path } from '../path_api.js';
import net from 'node:net';
import { getStorage } from '../storage/index.js';
import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { buildScopedChildEnv } from './child_env.js';
import { PATHS } from '../paths.js';
import { normalizeBotEntries, resolveRawBotEntries, loadSettingsFile, type BotEntry } from '../bot_settings.js';
import { UPDATER, BUILD_DIR, LAUNCHER } from '../constants.js';
import { Config } from '../config.js';
import { getProcessDiscovery, formatUptime } from '../process_discovery.js';
import { runtime } from '../runtime.js';
import { sleep } from '../order/utils/system.js';

import type { Socket } from 'net';
const storage = getStorage();
const { ensureDir, readJSON, unlink: safeUnlink } = storage;
import { buildRuntimeScriptPath, SCRIPTS_ROOT as CODE_ROOT } from './runtime_entry.js';
import { getErrorMessage, getErrorCode } from '../utils/errors.js';
import { usesAmaGridPrice } from '../grid_price_source.js';

const BOT_SCRIPT = buildRuntimeScriptPath(CODE_ROOT, ['bot']);
const SOCKET_PATH = Config.DEXBOT_SUPERVISOR_SOCKET || PATHS.PROFILES.SUPERVISOR_SOCK;

const {
    MAX_RESTARTS,
    MIN_UPTIME_MS,
    RESTART_DELAY_MS,
    SHUTDOWN_TIMEOUT_MS,
    STAGGER_DELAY_MS,
    MEMORY_CHECK_INTERVAL_MS,
    STATUS_LOG_INTERVAL_MS,
    MAX_CRON_LOOKAHEAD_MINUTES,
} = LAUNCHER.SUPERVISOR;

const SUPERVISOR_PREFIX = '[supervisor]';

type SupervisedChild = ChildProcessByStdio<null, Readable, Readable>;

interface SupervisedApp {
    kind: 'bot' | 'service' | 'job';
    name: string;
    script: string;
    args?: string | string[];
    cwd: string;
    max_memory_restart?: string;
    error_file?: string;
    out_file?: string;
    max_restarts?: number;
    min_uptime?: number;
    restart_delay?: number;
    autorestart?: boolean;
    bulk_control?: boolean;
    cron_schedule?: string;
    env?: Record<string, string>;
    [key: string]: unknown;
}

interface CronSchedule {
    minute: Set<number> | null;
    hour: Set<number> | null;
    dayOfMonth: Set<number> | null;
    month: Set<number> | null;
    dayOfWeek: Set<number> | null;
}

interface BotRuntimeState {
    name: string;
    appEntry: SupervisedApp | null;
    child: SupervisedChild | null;
    restartCount: number;
    lastStartTime: number;
    status: string;
    pendingRestart: boolean;
    bulkControl: boolean;
    cronExpression: string | null;
    cronSchedule: CronSchedule | null;
    nextScheduledAt: number;
    scheduledRunTimer: ReturnType<typeof setTimeout> | null;
    autorestart?: boolean;
    maxRestarts: number;
    minUptimeMs: number;
    restartDelayMs: number;
    memoryLimitBytes: number | null;
    stoppedByUser: boolean;
    [key: string]: unknown;
}

interface SupervisorCommand {
    cmd: string;
    bot?: string;
    preserveSockets?: Socket[];
    [key: string]: unknown;
}

interface SupervisorOptions {
    bots?: BotEntry[] | null;
    buildEnv?: typeof buildScopedChildEnv;
    spawnFn?: typeof spawn;
    log?: (...args: unknown[]) => void;
    logError?: (...args: unknown[]) => void;
    controlSocket?: boolean;
    getChildRss?: (child: SupervisedChild) => number;
    memoryCheckIntervalMs?: number;
    statusLogIntervalMs?: number;
    staggerDelayMs?: number;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    nowFn?: () => number;
    stopMarketAdapter?: () => Promise<{ pid: number | null; stopped: boolean }>;
    updaterActive?: boolean;
}

function needsMarketAdapter(bots: BotEntry[] | null | undefined): boolean {
    return (bots || []).some((bot) => usesAmaGridPrice(bot));
}

function isServiceApp(app: SupervisedApp | null | undefined): boolean {
    const name = String(app?.name || '');
    return name === 'dexbot-update' || name === 'dexbot-adapter';
}

function ensureLogDir() {
    if (!storage.exists(PATHS.LOGS_DIR)) {
        ensureDir(PATHS.LOGS_DIR);
    }
}

function loadActiveBots(explicitBots: BotEntry[] | null | undefined): BotEntry[] {
    if (explicitBots) return explicitBots;
    const { config } = loadSettingsFile(PATHS.PROFILES.BOTS_JSON);
    const raw = resolveRawBotEntries(config);
    return normalizeBotEntries(raw).filter((b) => b.active !== false);
}

function buildSupervisedApps(bots: BotEntry[] | null | undefined, updaterActive: boolean): SupervisedApp[] {
    const apps: SupervisedApp[] = (bots || []).map((bot, index) => {
        const botName = bot.name || `bot-${index}`;
        return {
            kind: 'bot',
            name: botName,
            script: BOT_SCRIPT,
            args: botName,
            cwd: PATHS.PROJECT_ROOT,
            max_memory_restart: '250M',
            error_file: path.join(PATHS.LOGS_DIR, `${botName}-error.log`),
            out_file: path.join(PATHS.LOGS_DIR, `${botName}.log`),
            max_restarts: MAX_RESTARTS,
            min_uptime: MIN_UPTIME_MS,
            restart_delay: RESTART_DELAY_MS,
        };
    });

    if (needsMarketAdapter(bots)) {
        apps.unshift({
            kind: 'service',
            name: 'dexbot-adapter',
            script: buildRuntimeScriptPath(CODE_ROOT, ['market_adapter', 'market_adapter']),
            cwd: PATHS.PROJECT_ROOT,
            max_memory_restart: '150M',
            error_file: path.join(PATHS.LOGS_DIR, 'dexbot-adapter-error.log'),
            out_file: path.join(PATHS.LOGS_DIR, 'dexbot-adapter.log'),
            max_restarts: MAX_RESTARTS,
            min_uptime: 60000,
            restart_delay: RESTART_DELAY_MS,
        });
    }

    if (updaterActive) {
        apps.push({
            kind: 'job',
            name: 'dexbot-update',
            script: buildRuntimeScriptPath(CODE_ROOT, ['scripts', 'update']),
            cwd: PATHS.PROJECT_ROOT,
            error_file: path.join(PATHS.LOGS_DIR, 'dexbot-update-error.log'),
            out_file: path.join(PATHS.LOGS_DIR, 'dexbot-update.log'),
            autorestart: false,
            bulk_control: false,
            cron_schedule: UPDATER.SCHEDULE,
        });
    }

    return apps;
}

function parseCronField(field: unknown, min: number, max: number): Set<number> | null {
    const trimmed = String(field || '').trim();
    if (!trimmed) {
        throw new Error('empty cron field');
    }
    if (trimmed === '*') {
        return null;
    }

    const values = new Set<number>();
    const parts = trimmed.split(',');
    for (const part of parts) {
        if (!part) {
            throw new Error(`invalid cron field: ${field}`);
        }
        const stepMatch = part.match(/^(.+)\/(\d+)$/);
        let base = part;
        let step = 1;
        if (stepMatch) {
            base = stepMatch[1];
            step = Number(stepMatch[2]);
            if (!Number.isInteger(step) || step <= 0) {
                throw new Error(`invalid cron step: ${part}`);
            }
        }

        let rangeStart = min;
        let rangeEnd = max;
        if (base !== '*') {
            const rangeMatch = base.match(/^(\d+)-(\d+)$/);
            if (rangeMatch) {
                rangeStart = Number(rangeMatch[1]);
                rangeEnd = Number(rangeMatch[2]);
            } else {
                const exact = Number(base);
                if (!Number.isInteger(exact)) {
                    throw new Error(`invalid cron value: ${part}`);
                }
                rangeStart = exact;
                rangeEnd = exact;
            }
        }

        if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
            throw new Error(`cron value out of range: ${part}`);
        }

        for (let value = rangeStart; value <= rangeEnd; value += step) {
            values.add(value);
        }
    }
    return values;
}

function parseCronExpression(expression: unknown): CronSchedule {
    const parts = String(expression || '').trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(`invalid cron expression: ${expression}`);
    }
    return {
        minute: parseCronField(parts[0], 0, 59),
        hour: parseCronField(parts[1], 0, 23),
        dayOfMonth: parseCronField(parts[2], 1, 31),
        month: parseCronField(parts[3], 1, 12),
        dayOfWeek: parseCronField(parts[4], 0, 6),
    };
}

function cronFieldMatches(field: Set<number> | null, value: number): boolean {
    return field == null || field.has(value);
}

function cronMatchesDate(schedule: CronSchedule | null | undefined, date: Date): boolean {
    if (!schedule) return false;
    const minuteMatch = cronFieldMatches(schedule.minute, date.getMinutes());
    const hourMatch = cronFieldMatches(schedule.hour, date.getHours());
    const monthMatch = cronFieldMatches(schedule.month, date.getMonth() + 1);
    const dayOfMonthMatch = cronFieldMatches(schedule.dayOfMonth, date.getDate());
    const dayOfWeekMatch = cronFieldMatches(schedule.dayOfWeek, date.getDay());
    const domRestricted = schedule.dayOfMonth != null;
    const dowRestricted = schedule.dayOfWeek != null;
    const dayMatch = domRestricted && dowRestricted
        ? (dayOfMonthMatch || dayOfWeekMatch)
        : (dayOfMonthMatch && dayOfWeekMatch);
    return minuteMatch && hourMatch && monthMatch && dayMatch;
}

function getNextCronDate(schedule: CronSchedule, fromDate: Date = new Date()): Date {
    const cursor = new Date(fromDate.getTime());
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);

    for (let i = 0; i < MAX_CRON_LOOKAHEAD_MINUTES; i++) {
        if (cronMatchesDate(schedule, cursor)) {
            return new Date(cursor.getTime());
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
    }
    throw new Error('unable to resolve next cron run');
}

function parseMemoryLimitBytes(limit: unknown): number | null {
    if (!limit) return null;
    const match = String(limit || '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:b)?$/i);
    if (!match) return null;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const factor = unit === 't' ? 1024 ** 4
        : unit === 'g' ? 1024 ** 3
            : unit === 'k' ? 1024
                : 1024 ** 2;
    return Math.floor(value * factor);
}

function normalizeAppArgs(args: unknown): string[] {
    if (args == null || args === '') return [];
    if (Array.isArray(args)) return args.map(String);
    return [String(args)];
}

function forwardSignal(child: ChildProcess | null | undefined, signal: NodeJS.Signals): void {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch (err) {
        if (getErrorCode(err) !== 'ESRCH') throw err;
    }
}

function isPidAlive(pid: number): boolean {
    return getProcessDiscovery().isAlive(pid);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await sleep(200);
    }
    return !isPidAlive(pid);
}

function readProcArgs(pid: number): string[] {
    return getProcessDiscovery().readArgs(pid) as string[];
}

function readProcCwd(pid: number): string {
    return getProcessDiscovery().readCwd(pid) as string;
}

function normalizeProcScriptArg(arg: unknown, cwd: string | null | undefined): string {
    const argStr = arg == null ? '' : String(arg);
    if (!argStr || argStr.startsWith('-')) return '';
    if (!/\.(?:[cm]?js|ts)$/i.test(argStr)) return '';
    return path.isAbsolute(argStr)
        ? path.normalize(argStr)
        : path.resolve(cwd || PATHS.PROJECT_ROOT, argStr);
}

function scriptPathForRoot(root: string, scriptSegments: string[], ext: string): string {
    const segments = [...scriptSegments];
    const last = segments.pop();
    segments.push(String(last).replace(/\.(?:[cm]?js|ts)$/i, '') + ext);
    return path.join(root, ...segments);
}

function candidateRuntimeScriptPaths(scriptSegments: string[]): Set<string> {
    const candidates = new Set([
        buildRuntimeScriptPath(CODE_ROOT, scriptSegments),
        scriptPathForRoot(PATHS.PROJECT_ROOT, scriptSegments, '.ts'),
        scriptPathForRoot(path.join(PATHS.PROJECT_ROOT, BUILD_DIR), scriptSegments, '.js'),
    ]);

    if (scriptSegments.length === 1) {
        candidates.add(scriptPathForRoot(PATHS.PROJECT_ROOT, scriptSegments, '.js'));
    }

    return candidates;
}

function pidMatchesScriptCandidates(pid: number, expectedPaths: Set<string> | null | undefined): boolean {
    if (!expectedPaths || expectedPaths.size === 0) return false;
    const args = readProcArgs(pid);
    if (!args.some((arg) => path.basename(String(arg)).includes('node'))) {
        return false;
    }

    const cwd = readProcCwd(pid);
    for (const arg of args.slice(1)) {
        const scriptPath = normalizeProcScriptArg(arg, cwd);
        if (scriptPath && expectedPaths.has(scriptPath)) {
            return true;
        }
    }

    return false;
}

function isNodeProcessWithExactScript(pid: number, scriptSegments: string[]): boolean {
    return pidMatchesScriptCandidates(pid, candidateRuntimeScriptPaths(scriptSegments));
}

function readMarketAdapterLockPid() {
    try {
        const info = readJSON(PATHS.MARKET_ADAPTER.LOCK_FILE);
        const pid = Number(info.pid);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (_) {
        return null;
    }
}

async function stopMarketAdapterFromLock(timeoutMs: number = 5000): Promise<{ pid: number | null; stopped: boolean }> {
    const pid = readMarketAdapterLockPid();
    if (!pid || !isNodeProcessWithExactScript(pid, ['market_adapter', 'market_adapter'])) {
        return { pid, stopped: false };
    }

    runtime.kill(pid, 'SIGTERM');
    let stopped = await waitForPidExit(pid, timeoutMs);
    if (!stopped && isNodeProcessWithExactScript(pid, ['market_adapter', 'market_adapter'])) {
        runtime.kill(pid, 'SIGKILL');
        stopped = await waitForPidExit(pid, 2000);
    }
    return { pid, stopped };
}

function getChildRSS(child: SupervisedChild | null | undefined): number {
    if (!child || !child.pid) return -1;
    try {
        if (Config.PLATFORM === 'linux') {
            const bytes = getProcessDiscovery().readRSSBytes(child.pid);
            if (bytes > 0) return bytes;
        } else if (Config.PLATFORM === 'darwin') {
            const { execSync } = require('child_process');
            const out = execSync(`ps -o rss= -p ${child.pid}`, { encoding: 'utf8', timeout: 3000 });
            const rssKB = parseInt(out.trim(), 10);
            if (rssKB > 0) return rssKB * 1024;
        }
    } catch (_) {}
    return -1;
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const handleSpawn = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(undefined);
        };
        const handleError = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            child.off('spawn', handleSpawn);
            child.off('error', handleError);
        };
        child.once('spawn', handleSpawn);
        child.once('error', handleError);
    });
}

function createBotSupervisor({
    bots = null,
    buildEnv = buildScopedChildEnv,
    spawnFn = spawn,
    log = (...args: unknown[]) => console.log(SUPERVISOR_PREFIX, ...args),
    logError = (...args: unknown[]) => console.error(SUPERVISOR_PREFIX, ...args),
    controlSocket = !Config.DEXBOT_DISABLE_SUPERVISOR_SOCKET,
    getChildRss = getChildRSS,
    memoryCheckIntervalMs = MEMORY_CHECK_INTERVAL_MS,
    statusLogIntervalMs = STATUS_LOG_INTERVAL_MS,
    staggerDelayMs = STAGGER_DELAY_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    nowFn = () => Date.now(),
    stopMarketAdapter = stopMarketAdapterFromLock,
    updaterActive = UPDATER.ACTIVE,
}: SupervisorOptions = {}) {
    const botStates = new Map<string, BotRuntimeState>();
    let shuttingDown = false;
    let shutdownResolve: (() => void) | null = null;
    let memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
    let statusLogTimer: ReturnType<typeof setInterval> | null = null;
    let socketServer: net.Server | null = null;
    let socketConnections = new Set<Socket>();
    let userStopped = false;

    function allStopped() {
        for (const [, state] of botStates) {
            if (state.status === 'running' || state.status === 'restarting' || state.status === 'starting') {
                return false;
            }
        }
        return true;
    }

    function checkAllStopped() {
        if (allStopped() && shutdownResolve) {
            shutdownResolve();
            shutdownResolve = null;
        }
    }

    function printStatusSummary() {
        if (shuttingDown) return;
        const lines: string[] = [];
        for (const [name, state] of botStates) {
            const pid = state.child?.pid || '-';
            const uptime = state.lastStartTime && state.status === 'running'
                ? formatUptime(nowFn() - state.lastStartTime)
                : '-';
            let mem = '-';
            if (state.status === 'running' && state.child) {
                const rss = getChildRss(state.child);
                if (rss > 0) mem = `${Math.round(rss / 1024 / 1024)}MB`;
            }
            lines.push(`${name} | ${state.status} | pid ${pid} | uptime ${uptime} | rss ${mem}`);
        }
        if (lines.length === 0) {
            log('Status: no bots');
        } else {
            log('Status:\n  ' + lines.join('\n  '));
        }
    }

    function clearScheduledRun(state: BotRuntimeState | null | undefined): void {
        if (state?.scheduledRunTimer) {
            clearTimeoutFn(state.scheduledRunTimer);
            state.scheduledRunTimer = null;
        }
        if (state) {
            state.nextScheduledAt = 0;
        }
    }

    function scheduleNextRun(state: BotRuntimeState | null | undefined): void {
        clearScheduledRun(state);
        if (shuttingDown || !state?.cronSchedule) {
            return;
        }

        try {
            const nextRun = getNextCronDate(state.cronSchedule, new Date(nowFn()));
            const delay = Math.max(nextRun.getTime() - nowFn(), 0);
            state.nextScheduledAt = nextRun.getTime();
            state.scheduledRunTimer = setTimeoutFn(async () => {
                state.scheduledRunTimer = null;
                state.nextScheduledAt = 0;
                if (shuttingDown) return;

                if (state.status === 'running' || state.pendingRestart) {
                    log(`${state.name} scheduled run skipped because the previous run is still active.`);
                    scheduleNextRun(state);
                    return;
                }

                log(`Starting scheduled job: ${state.name}`);
                try {
                    const child = state.appEntry ? spawnApp(state.appEntry) : null;
                    if (child) {
                        await waitForChildSpawn(child);
                    }
                } catch (err) {
                    logError(`Failed to start scheduled job ${state.name}:`, getErrorMessage(err));
                    state.status = 'crashed';
                } finally {
                    scheduleNextRun(state);
                }
            }, delay);
            if (state.scheduledRunTimer && typeof state.scheduledRunTimer.unref === 'function') {
                state.scheduledRunTimer.unref();
            }
        } catch (err) {
            logError(`Invalid cron schedule for ${state.name}: ${getErrorMessage(err)}`);
        }
    }

    function runMemoryCheck() {
        if (shuttingDown) return;
        for (const [name, state] of botStates) {
            if (state.status !== 'running' || !state.child) continue;
            const rss = getChildRss(state.child);
            if (rss <= 0) continue;
            const memoryLimitBytes = state.memoryLimitBytes;
            if (memoryLimitBytes && rss > memoryLimitBytes) {
                const rssMB = Math.round(rss / 1024 / 1024);
                const limitMB = Math.round(memoryLimitBytes / 1024 / 1024);
                logError(`${name} exceeded memory limit (${rssMB}MB > ${limitMB}MB). Restarting...`);
                state.pendingRestart = true;
                try { state.child.kill('SIGTERM'); } catch (_) {}
            }
        }
    }

    function spawnApp(app: SupervisedApp): SupervisedChild | null {
        const appName = app.name;
        const state = botStates.get(appName);
        if (!state) return null;

        if (shuttingDown) {
            state.status = 'stopped';
            checkAllStopped();
            return null;
        }

        ensureLogDir();
        const outFile = app.out_file || path.join(PATHS.LOGS_DIR, `${appName}.log`);
        const errorFile = app.error_file || path.join(PATHS.LOGS_DIR, `${appName}-error.log`);
        const outStream = fs.createWriteStream(outFile, { flags: 'a' });
        const errStream = fs.createWriteStream(errorFile, { flags: 'a' });
        const isBot = !isServiceApp(app);
        const extraEnv = {
            ...(app.env || {}),
            DEXBOT_LAUNCH_MODE: 'isolated',
            ...(isBot ? { LIVE_BOT_NAME: appName } : {}),
        };

        const runtimeArgs = [app.script || BOT_SCRIPT, ...normalizeAppArgs(app.args)];
        const child = spawnFn(Config.EXEC_PATH, runtimeArgs, {
            cwd: app.cwd || PATHS.PROJECT_ROOT,
            env: buildEnv({ extra: extraEnv }),
            stdio: ['inherit', 'pipe', 'pipe'],
        });

        child.stdout.pipe(outStream);
        child.stdout.pipe(runtime.stdout as unknown as NodeJS.WritableStream);
        child.stderr.pipe(errStream);
        child.stderr.pipe(runtime.stderr as unknown as NodeJS.WritableStream);

        child.stdout.on('error', () => {});
        child.stderr.on('error', () => {});
        outStream.on('error', () => {});
        errStream.on('error', () => {});

        state.child = child;
        state.status = 'running';
        state.stoppedByUser = false;
        state.lastStartTime = nowFn();

        child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
            try { outStream.end(); } catch (_) {}
            try { errStream.end(); } catch (_) {}

            if (shuttingDown) {
                state.status = 'stopped';
                state.child = null;
                checkAllStopped();
                return;
            }

            if (state.pendingRestart) {
                state.pendingRestart = false;
                state.child = null;
                log(`${appName} restarting...`);
                spawnApp(app);
                return;
            }

            if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
                state.status = 'stopped';
                state.child = null;
                log(`${appName} stopped cleanly (exit ${code}${signal ? ', signal ' + signal : ''})`);
                checkAllStopped();
                return;
            }

            state.child = null;
            const now = nowFn();
            const uptime = now - state.lastStartTime;

            if (state.autorestart === false) {
                state.status = 'crashed';
                logError(`${appName} exited unexpectedly (exit ${code}${signal ? ', signal ' + signal : ''}) and autorestart is disabled.`);
                checkAllStopped();
                return;
            }

            const minUptime = state.minUptimeMs || MIN_UPTIME_MS;
            if (uptime < minUptime) {
                state.restartCount++;
            } else {
                state.restartCount = 0;
            }

            const maxRestarts = state.maxRestarts || MAX_RESTARTS;
            if (state.restartCount >= maxRestarts) {
                logError(`${appName} exceeded max restarts (${maxRestarts}) without stable uptime. Stopping.`);
                state.status = 'crashed';
                checkAllStopped();
                return;
            }

            const restartDelay = state.restartDelayMs || RESTART_DELAY_MS;
            log(`${appName} crashed (exit ${code}${signal ? ', signal ' + signal : ''}), restarting in ${restartDelay / 1000}s (attempt ${state.restartCount}/${maxRestarts})...`);
            state.status = 'restarting';

            setTimeout(() => {
                if (!shuttingDown) {
                    spawnApp(app);
                }
            }, restartDelay);
        });

        child.on('error', (err: Error) => {
            logError(`${appName} spawn error:`, getErrorMessage(err));
        });

        return child;
    }

    async function waitForStableStartup({ timeoutMs = 750, pollIntervalMs = 50 }: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<void> {
        const trackedStates = () =>
            Array.from(botStates.values()).filter((state) => state.appEntry && state.appEntry.kind !== 'job');

        if (timeoutMs <= 0 || trackedStates().length === 0) {
            return;
        }

        const deadline = nowFn() + timeoutMs;
        while (nowFn() < deadline) {
            const states = trackedStates();
            const failed = states.filter((state) => state.status === 'stopped' || state.status === 'crashed');
            if (failed.length > 0) {
                const details = failed.map((state) => `${state.name} (${state.status})`).join(', ');
                throw new Error(`supervised startup failed: ${details}`);
            }

            const remainingMs = Math.max(deadline - nowFn(), 0);
            await new Promise<void>((resolve) => {
                setTimeoutFn(resolve, Math.min(pollIntervalMs, remainingMs || pollIntervalMs));
            });
        }

        const states = trackedStates();
        const notRunning = states.filter((state) => state.status !== 'running');
        if (notRunning.length > 0) {
            const details = notRunning.map((state) => `${state.name} (${state.status})`).join(', ');
            throw new Error(`supervised startup failed: ${details}`);
        }
    }

    async function handleSocketCommand(cmd: SupervisorCommand) {
        try {
            switch (cmd.cmd) {
                case 'status': {
                    const status = getStatus();
                    return { ok: true, status };
                }
                case 'stop': {
                    if (!cmd.bot) return { error: 'bot name required' };
                    const state = botStates.get(cmd.bot);
                    if (!state) return { error: `bot '${cmd.bot}' not found` };
                    if (state.status !== 'running') return { error: `bot '${cmd.bot}' is not running (${state.status})` };
                    state.pendingRestart = false;
                    state.stoppedByUser = true;
                    try { state.child?.kill('SIGTERM'); } catch (_) {}
                    userStopped = true;
                    log(`stop: ${cmd.bot}`);
                    return { ok: true };
                }
                case 'restart': {
                    if (!cmd.bot) return { error: 'bot name required' };
                    const state = botStates.get(cmd.bot);
                    if (!state) return { error: `bot '${cmd.bot}' not found` };
                    if (state.status === 'running' && state.child) {
                        state.pendingRestart = true;
                        try { state.child.kill('SIGTERM'); } catch (_) {}
                    } else if ((userStopped || state.stoppedByUser) && state.status === 'stopped' && state.appEntry) {
                        spawnApp(state.appEntry);
                    } else {
                        return { error: `bot '${cmd.bot}' is not running (${state.status})` };
                    }
                    log(`restart: ${cmd.bot}`);
                    return { ok: true };
                }
                case 'restart-running':
                    await restartRunning();
                    return { ok: true };
                case 'stop-all':
                    stopAll();
                    return { ok: true };
                case 'restart-all':
                    await restartAll();
                    return { ok: true };
                case 'reload':
                    // reload mirrors restart for isolated bots (no credential
                    // daemon is involved in this path).
                    if (!cmd.bot) return { error: 'bot name required' };
                    {
                        const state = botStates.get(cmd.bot);
                        if (!state) return { error: `bot '${cmd.bot}' not found` };
                        if (state.status === 'running' && state.child) {
                            state.pendingRestart = true;
                            try { state.child.kill('SIGTERM'); } catch (_) {}
                        } else if ((userStopped || state.stoppedByUser) && state.status === 'stopped' && state.appEntry) {
                            spawnApp(state.appEntry);
                        } else {
                            return { error: `bot '${cmd.bot}' is not running (${state.status})` };
                        }
                        log(`reload: ${cmd.bot}`);
                        return { ok: true };
                    }
                case 'reload-all':
                    // reload-all mirrors restart-all (bots + market adapter only).
                    await restartAll({ logAction: 'reload-all' });
                    return { ok: true };
                case 'delete':
                    // delete tears the supervisor down as a whole; a bot target
                    // would silently kill every bot, so refuse it explicitly.
                    if (cmd.bot) return { error: `'delete' is whole-runtime; use 'stop ${cmd.bot}' to stop one bot` };
                    await shutdown({ preserveSockets: cmd.preserveSockets || [] });
                    return { ok: true };
                default:
                    return { error: `unknown command: ${cmd.cmd}` };
            }
        } catch (err) {
            return { error: getErrorMessage(err) };
        }
    }

    function startSocketServer() {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = <T>(fn: (value: T) => void, value: T): void => {
                if (settled) return;
                settled = true;
                fn(value);
            };
            const testSocket = net.createConnection(SOCKET_PATH);
            testSocket.on('connect', () => {
                testSocket.end();
                settle(reject, new Error('Another supervisor instance is already running (socket exists). Stop it first or use a different profile.'));
            });
            testSocket.on('error', () => {
                startSocketServerInternal().then(() => settle(resolve, undefined)).catch((err) => settle(reject, err));
            });
            testSocket.setTimeout(500, () => {
                testSocket.destroy();
                startSocketServerInternal().then(() => settle(resolve, undefined)).catch((err) => settle(reject, err));
            });
        });
    }

    function startSocketServerInternal(): Promise<void> {
        return new Promise((resolve, reject) => {
            safeUnlink(SOCKET_PATH)

            socketServer = net.createServer((socket: Socket) => {
            socketConnections.add(socket);
            let buffer = '';
            let commandQueue = Promise.resolve();
            let deleteQueued = false;

            const enqueueSocketResponse = (handler: () => Promise<void>) => {
                commandQueue = commandQueue
                    .then(handler)
                    .catch((err) => {
                        try {
                            socket.write(JSON.stringify({ error: getErrorMessage(err) }) + '\n');
                        } catch (_) {}
                    });
                return commandQueue;
            };

            socket.on('data', (data: Buffer) => {
                if (deleteQueued) return;
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (deleteQueued) break;
                    if (!line.trim()) continue;
                    let cmd;
                    try {
                        cmd = JSON.parse(line);
                    } catch (_) {
                        enqueueSocketResponse(() => new Promise<void>((resolve) => {
                            socket.write(JSON.stringify({ error: 'invalid JSON' }) + '\n', () => resolve());
                        }));
                        continue;
                    }
                    if (cmd.cmd === 'delete') {
                        deleteQueued = true;
                        buffer = '';
                    }
                    enqueueSocketResponse(async () => {
                        const resp = await handleSocketCommand({ ...cmd, preserveSockets: [socket] });
                        await new Promise<void>((resolve) => {
                            socket.write(JSON.stringify(resp) + '\n', () => resolve());
                        });
                        if (cmd.cmd === 'delete') {
                            socket.end();
                        }
                    });
                }
            });

            socket.on('close', () => {
                socketConnections.delete(socket);
            });

            socket.on('error', () => {
                socketConnections.delete(socket);
            });
            });

            const onError = (err: Error) => {
                logError(`Socket server error: ${getErrorMessage(err)}`);
                reject(err);
            };

            socketServer!.once('error', onError);
            socketServer!.listen(SOCKET_PATH, () => {
                socketServer!.off('error', onError);
                socketServer!.on('error', (err: Error) => {
                    logError(`Socket server error: ${getErrorMessage(err)}`);
                });
                try { storage.chmod(SOCKET_PATH, 0o600); } catch (_) {}
                log(`Control socket: ${SOCKET_PATH}`);
                resolve(undefined);
            });

            process.once('exit', () => {
                safeUnlink(SOCKET_PATH)
            });
        });
    }

    function closeSocketServer({ preserveSockets = [] as Socket[] }: { preserveSockets?: Socket[] } = {}): void {
        const preserved = new Set(preserveSockets);
        if (socketServer) {
            try { socketServer.close(); } catch (_) {}
            socketServer = null;
        }
        for (const sock of socketConnections) {
            if (preserved.has(sock)) continue;
            try { sock.destroy(); } catch (_) {}
        }
        socketConnections = new Set([...socketConnections].filter((sock) => preserved.has(sock)));
        safeUnlink(SOCKET_PATH)
    }

    async function start() {
        const activeBots = loadActiveBots(bots);
        const activeApps = buildSupervisedApps(activeBots, updaterActive);

        if (activeApps.length === 0) {
            log('No active apps configured.');
            return botStates;
        }

        if (controlSocket) {
            await startSocketServer();
        }

        for (const app of activeApps) {
            const appName = app.name;
            botStates.set(appName, {
                name: appName,
                appEntry: app,
                child: null,
                restartCount: 0,
                lastStartTime: 0,
                status: 'starting',
                pendingRestart: false,
                bulkControl: app.bulk_control !== false,
                cronExpression: app.cron_schedule || null,
                cronSchedule: app.cron_schedule ? parseCronExpression(app.cron_schedule) : null,
                nextScheduledAt: 0,
                scheduledRunTimer: null,
                autorestart: app.autorestart,
                maxRestarts: app.max_restarts || MAX_RESTARTS,
                minUptimeMs: app.min_uptime || MIN_UPTIME_MS,
                restartDelayMs: app.restart_delay || RESTART_DELAY_MS,
                memoryLimitBytes: parseMemoryLimitBytes(app.max_memory_restart),
                stoppedByUser: false,
            });
        }

        memoryCheckTimer = setInterval(runMemoryCheck, memoryCheckIntervalMs);
        if (memoryCheckTimer) memoryCheckTimer.unref();

        statusLogTimer = setInterval(printStatusSummary, statusLogIntervalMs);
        if (statusLogTimer) statusLogTimer.unref();

        for (const appDef of activeApps) {
            log(`Memory limit for ${appDef.name}: ${appDef.max_memory_restart || 'unlimited'}`);
        }

        for (let i = 0; i < activeApps.length; i++) {
            const app = activeApps[i];
            log(`Starting ${app.name}...`);
            try {
                const child = spawnApp(app);
                if (child) {
                    await waitForChildSpawn(child);
                }
            } catch (err) {
                logError(`Failed to start ${app.name}:`, getErrorMessage(err));
                const state = botStates.get(app.name);
                if (state) {
                    state.status = 'crashed';
                }
            }
            if (i < activeApps.length - 1) {
                await sleep(staggerDelayMs);
            }
        }

        for (const [, state] of botStates) {
            if (state.cronSchedule) {
                scheduleNextRun(state);
            }
        }

        printStatusSummary();

        return botStates;
    }

    function clearTimers() {
        if (memoryCheckTimer) {
            clearInterval(memoryCheckTimer);
            memoryCheckTimer = null;
        }
        if (statusLogTimer) {
            clearInterval(statusLogTimer);
            statusLogTimer = null;
        }
        for (const [, state] of botStates) {
            clearScheduledRun(state);
        }
    }

    function shutdownSignalHandler(signal: NodeJS.Signals): void {
        for (const [, state] of botStates) {
            forwardSignal(state.child, signal);
        }
    }

    async function shutdown({ preserveSockets = [] }: { preserveSockets?: Socket[] } = {}): Promise<void> {
        shuttingDown = true;
        userStopped = false;
        clearTimers();
        closeSocketServer({ preserveSockets });

        shutdownSignalHandler('SIGTERM');

        return new Promise<void>((resolve) => {
            const done = () => {
                if (forceKillTimer) clearTimeout(forceKillTimer);
                if (forceResolveTimer) clearTimeout(forceResolveTimer);
                resolve(undefined);
            };

            shutdownResolve = () => {
                if (allStopped()) {
                    done();
                }
            };

            const forceKillTimer = setTimeout(() => {
                for (const [, state] of botStates) {
                    if (state.child && state.child.exitCode == null && state.status !== 'stopped') {
                        try { state.child.kill('SIGKILL'); } catch (_) {}
                        state.status = 'stopped';
                        state.child = null;
                    }
                }
                done();
            }, SHUTDOWN_TIMEOUT_MS);

            const forceResolveTimer = setTimeout(() => {
                done();
            }, SHUTDOWN_TIMEOUT_MS + 1000);

            checkAllStopped();
        });
    }

    function getStatus(): Record<string, { status: string; pid: number | null; restarts: number; uptimeMs: number; nextScheduledAt: number }> {
        const result: Record<string, { status: string; pid: number | null; restarts: number; uptimeMs: number; nextScheduledAt: number }> = {};
        for (const [name, state] of botStates) {
            result[name] = {
                status: state.status,
                pid: state.child?.pid || null,
                restarts: state.restartCount,
                uptimeMs: state.lastStartTime ? nowFn() - state.lastStartTime : 0,
                nextScheduledAt: state.nextScheduledAt || 0,
            };
        }
        return result;
    }

    function stopAll() {
        userStopped = true;
        for (const [, state] of botStates) {
            if (!state.bulkControl) continue;
            state.pendingRestart = false;
            if (state.status === 'running' && state.child) {
                state.stoppedByUser = true;
                try { state.child.kill('SIGTERM'); } catch (_) {}
            }
        }
        log('stop-all');
    }

    async function restartRunning({ logAction = true }: { logAction?: boolean } = {}): Promise<void> {
        userStopped = false;
        const runningStates: Array<{ state: BotRuntimeState; child: SupervisedChild; pid: number | null }> = [];
        for (const [, state] of botStates) {
            if (!state.bulkControl) continue;
            if (state.status === 'running' && state.child) {
                state.pendingRestart = true;
                runningStates.push({
                    state,
                    child: state.child,
                    pid: state.child.pid || null,
                });
            }
        }

        const adapterStop = await stopMarketAdapter();
        for (const entry of runningStates) {
            if (adapterStop.pid && entry.pid === adapterStop.pid) {
                continue;
            }
            if (entry.state.child !== entry.child) {
                continue;
            }
            try { entry.child.kill('SIGTERM'); } catch (_) {}
        }

        if (adapterStop.stopped) {
            log(`restart-running: stopped market adapter PID ${adapterStop.pid}`);
        }
        if (logAction) {
            log('restart-running');
        }
    }

    async function restartAll({ logAction = 'restart-all' }: { logAction?: string } = {}): Promise<void> {
        await restartRunning({ logAction: false });
        for (const [, state] of botStates) {
            if (!state.bulkControl) continue;
            if (state.status === 'stopped' && state.appEntry && state.stoppedByUser) {
                spawnApp(state.appEntry);
            }
        }
        log(logAction);
    }

    function hasUserStopped() {
        return userStopped;
    }

    return {
        start,
        shutdown,
        shutdownSignalHandler,
        getStatus,
        printStatusSummary,
        restartAll,
        restartRunning,
        stopAll,
        hasUserStopped,
        waitForStableStartup,
    };
}

export { createBotSupervisor, SOCKET_PATH, parseCronExpression, getNextCronDate, forwardSignal, isPidAlive, waitForPidExit, candidateRuntimeScriptPaths, pidMatchesScriptCandidates, isNodeProcessWithExactScript, readMarketAdapterLockPid, stopMarketAdapterFromLock, usesAmaGridPrice, waitForChildSpawn, formatUptime }

