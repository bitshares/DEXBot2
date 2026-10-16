'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { NATIVE_CLIENT } from '../constants.js';
import Logger from '../order/logger.js';
import { getErrorMessage, getErrorField } from '../utils/errors.js';

const { SUBSCRIPTIONS, OPERATIONS } = NATIVE_CLIENT;

const SUBSCRIBE_CALLBACK_ID = SUBSCRIPTIONS.CALLBACK_ID;
const OP_FILL_ORDER = OPERATIONS.FILL_ORDER;

const subscriptionsLogger = new Logger('Subscriptions');

interface WarnThrottleState {
    lastAt: number;
    suppressed: number;
}

interface HistoryEntry {
    id?: string;
    op?: unknown[];
    block_num?: number;
    trx_in_block?: number;
    [key: string]: unknown;
}

interface FillObject {
    [key: string]: unknown;
    type: string;
    op: unknown[];
    block_num?: number;
    trx_in_block?: number;
    id?: string;
}

interface AccountInfo {
    account?: { id?: string; statistics?: string };
    [key: string]: unknown;
}

interface SubscriptionEntry {
    accountName: string;
    accountId: string | null;
    statisticsId: string | null;
    lastDeliveredHistoryId: string;
    lastNoticeAt: number;
    active: boolean;
    callbacks: Set<(fills: HistoryEntry[]) => unknown>;
    onError: ((err: unknown) => void) | null;
    reconnectRetryTimer: ReturnType<typeof setTimeout> | null;
    reconnecting: boolean;
    _gapRecovery: boolean;
    _channelFailures: number;
    _channelDegraded: boolean;
    _channelRecoveryCycles: number;
    _recoveryAlerted: boolean;
    _channelRetryTimer: ReturnType<typeof setTimeout> | null;
    _channelRetryStep: number;
    _channelRetryRefills: number;
    _warnThrottle: Record<string, WarnThrottleState>;
    _processingHistory?: boolean;
    [key: string]: unknown;
}

interface SubscriptionChainClient {
    transport: {
        getNodeUrl?(): string | undefined;
        addMessageHandler(handler: (params: unknown) => void): UnsubscribeFn;
    };
    db: {
        get_full_accounts(refs: string[], subscribe: boolean): Promise<Array<[string, AccountInfo]>>;
        call(method: string, args: unknown[]): Promise<unknown>;
        [key: string]: (...args: never[]) => Promise<unknown>;
    };
    history?: {
        getAccountHistory?: (...args: unknown[]) => Promise<unknown[]>;
        get_account_history?: (...args: unknown[]) => Promise<unknown[]>;
        getAccountHistoryOperations?: (...args: unknown[]) => Promise<unknown[]>;
        call(method: string, args: unknown[]): Promise<unknown>;
    };
    forceReconnect?(reason: string): unknown;
    reportNodeFailure?(node: string, message: string, source: string): void;
    getApiLimitGetAccountHistory?(): number | null;
    [key: string]: unknown;
}

type UnsubscribeFn = { (): void; isActive?(): boolean };

interface SubscriptionOverrides {
    noticeCoalesceMs?: number;
    channelErrorLogIntervalMs?: number;
    channelRetryLadderMs?: number[];
    channelRetryMaxRefills?: number;
    [key: string]: unknown;
}

interface ProcessOptions {
    lookbackOps?: number;
    maxPages?: number;
    throwOnError?: boolean;
    context?: string;
    [key: string]: unknown;
}

function createSubscriptionManager(chainClient: SubscriptionChainClient, overrides: SubscriptionOverrides = {}) {
    const subscriptions = new Map<string, SubscriptionEntry>();
    let unsubscribeNotice: UnsubscribeFn | null = null;
    const reconnectRetryDelayMs = Number.isFinite(SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS)
        ? Math.max(1000, SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS)
        : SUBSCRIPTIONS.RECONNECT_RETRY_DELAY_MS;
    // Test seam: overrides.noticeCoalesceMs collapses the production 250ms
    // coalesce window so offline tests assert on scan results without
    // sleeping on wall-clock time. Production never passes overrides, so the
    // default path is byte-for-byte the old behavior. With 0 (or any
    // non-positive value) scans run inline in notice order: the coalesce
    // timers exist to batch RAPID notices, and tests issue notices strictly
    // sequentially — no batching to preserve, so inline is equivalent.
    const noticeCoalesceMs = Number.isFinite(overrides?.noticeCoalesceMs)
        ? Math.max(0, Number(overrides.noticeCoalesceMs))
        : (Number.isFinite(SUBSCRIPTIONS.NOTICE_COALESCE_MS)
            ? Math.max(0, SUBSCRIPTIONS.NOTICE_COALESCE_MS)
            : 0);
    // Per-subscription pending scan state for coalescing. Keyed by sub object
    // (Map iteration order is stable so we can reuse a single timer per entry).
    const pendingScans = new Map<SubscriptionEntry, { timer: ReturnType<typeof setTimeout> | null; lastNoticeAt: number }>();

    // Fill polling timer + re-entrancy guard for discovering fills via history scan.
    let fillPollTimer: ReturnType<typeof setInterval> | null = null;
    let fillPollInProgress = false;

    // Fill-channel health. A history channel can be dead (stale api id, wedged
    // session) while the socket still reads "connected", so the transport's
    // close/keep-alive recovery never fires. These settings drive a per-account
    // consecutive-failure watchdog that forces a reconnect when the channel
    // stays dead, plus log throttling so a dead channel cannot flood the log.
    const channelDegradedThreshold = Number.isFinite(SUBSCRIPTIONS.CHANNEL_DEGRADED_FAILURE_THRESHOLD)
        ? Math.max(1, SUBSCRIPTIONS.CHANNEL_DEGRADED_FAILURE_THRESHOLD)
        : 3;
    const channelErrorLogIntervalMs = Number.isFinite(overrides?.channelErrorLogIntervalMs)
        ? Math.max(0, Number(overrides.channelErrorLogIntervalMs))
        : (Number.isFinite(SUBSCRIPTIONS.CHANNEL_ERROR_LOG_INTERVAL_MS)
            ? Math.max(0, SUBSCRIPTIONS.CHANNEL_ERROR_LOG_INTERVAL_MS)
            : 60000);
    // Test seams so offline tests never sleep on the retry-ladder delays.
    const channelRetryLadderMs = (Array.isArray(overrides?.channelRetryLadderMs)
        ? overrides.channelRetryLadderMs
        : (Array.isArray(SUBSCRIPTIONS.CHANNEL_RETRY_LADDER_MS) ? SUBSCRIPTIONS.CHANNEL_RETRY_LADDER_MS : [5000, 10000, 15000]))
        .map((d) => Math.max(0, Number(d) || 0))
        .filter((d: number) => d > 0);
    const channelRecoveryAlertAfter = Number.isFinite(SUBSCRIPTIONS.CHANNEL_RECOVERY_ALERT_AFTER)
        ? Math.max(1, SUBSCRIPTIONS.CHANNEL_RECOVERY_ALERT_AFTER)
        : 3;
    const channelRetryMaxRefills = Number.isFinite(overrides?.channelRetryMaxRefills)
        ? Math.max(0, Number(overrides.channelRetryMaxRefills))
        : (Number.isFinite(SUBSCRIPTIONS.CHANNEL_RETRY_MAX_REFILLS) ? Math.max(0, SUBSCRIPTIONS.CHANNEL_RETRY_MAX_REFILLS) : 3);
    // NOTE: the forced-reconnect cooldown is NOT debounced here. It is enforced
    // once per client in chain_client.forceReconnect so this watchdog and the
    // stale api_id escalation share a single window (a wedged session trips both
    // counters in the same tick and must not stack two reconnects).

    function parseObjectIdInstance(id: unknown): number {
        if (typeof id !== 'string') return Number.NaN;
        const match = id.match(/\.(\d+)$/);
        return match ? Number(match[1]) : Number.NaN;
    }

    function sortEntriesOldestFirst(entries: HistoryEntry[]): HistoryEntry[] {
        return entries.sort((left, right) => {
            const leftInstance = parseObjectIdInstance(left?.id);
            const rightInstance = parseObjectIdInstance(right?.id);
            if (!Number.isFinite(leftInstance) || !Number.isFinite(rightInstance)) {
                return String(left?.id || '').localeCompare(String(right?.id || ''));
            }
            return leftInstance - rightInstance;
        });
    }

    function decrementObjectId(id: unknown): string | null {
        if (typeof id !== 'string') return null;
        const match = id.match(/^(.+\.)(\d+)$/);
        if (!match) return null;
        const instance = Number(match[2]);
        if (!Number.isSafeInteger(instance) || instance <= 0) return null;
        return `${match[1]}${instance - 1}`;
    }

    // Decrement an object id (e.g. "1.11.1234") by `n` instances, returning the
    // resulting id string, or null if it would underflow below 0.
    function decrementObjectIdBy(id: unknown, n: number): string | null {
        if (typeof id !== 'string' || !Number.isFinite(n) || n <= 0) return null;
        const match = id.match(/^(.+\.)(\d+)$/);
        if (!match) return null;
        const instance = Number(match[2]);
        if (!Number.isSafeInteger(instance)) return null;
        const next = instance - Math.floor(n);
        if (next < 0) return null;
        return `${match[1]}${next}`;
    }

    // Active node for log correlation: subscription/history errors are almost
    // always node problems, so every warn carries the node that served it.
    function activeNodeUrl(): string {
        try {
            return chainClient?.transport?.getNodeUrl?.() || 'unknown node';
        } catch (_) {
            return 'unknown node';
        }
    }

    function warnSubscription(sub: SubscriptionEntry | null | undefined, message: string, err: unknown = null, throttleKey: string = 'channel'): void {
        const account = sub?.accountName || sub?.accountId || 'unknown';
        const now = Date.now();
        // Throttle per-account AND per-category. A dead channel otherwise logs
        // one warn per poll forever; a permanently failing callback must not be
        // masked by (or mask) channel-error lines. Suppressed repeats are
        // counted per category and reported on the next emitted line.
        let state: { lastAt: number; suppressed: number } | null = null;
        if (sub) {
            if (!sub._warnThrottle || typeof sub._warnThrottle !== 'object') sub._warnThrottle = {};
            state = sub._warnThrottle[throttleKey] || { lastAt: 0, suppressed: 0 };
        }
        if (channelErrorLogIntervalMs > 0 && sub && now - state!.lastAt < channelErrorLogIntervalMs) {
            state!.suppressed += 1;
            sub._warnThrottle[throttleKey] = state!;
            return;
        }
        const suppressed = state ? (Number(state.suppressed) || 0) : 0;
        if (sub) sub._warnThrottle[throttleKey] = { lastAt: now, suppressed: 0 };
        const detail = (err as { message?: unknown } | null)?.message ? `: ${getErrorMessage(err)}` : '';
        const suppressedDetail = suppressed > 0 ? ` (+${suppressed} suppressed)` : '';
        subscriptionsLogger.warn(`${message} for ${account}${detail}${suppressedDetail} (node=${activeNodeUrl()})`);
    }

    /**
     * Mark a subscription's history channel healthy again. Resets the
     * consecutive-failure run and the recovery-cycle counter, and logs a single
     * recovery line when it was previously degraded.
     */
    function recordChannelSuccess(sub: SubscriptionEntry | null | undefined): void {
        if (!sub) return;
        const account = sub.accountName || sub.accountId || 'unknown';
        if (sub._channelDegraded || sub._channelRecoveryCycles > 0) {
            const cycles = Number(sub._channelRecoveryCycles) || 0;
            const after = cycles > 0 ? ` after ${cycles} forced reconnect(s)` : '';
            subscriptionsLogger.info(
                `Fill channel recovered for ${account}${after} (node=${activeNodeUrl()})`
            );
        }
        clearChannelRetry(sub);
        sub._channelFailures = 0;
        sub._channelDegraded = false;
        sub._channelRecoveryCycles = 0;
        sub._recoveryAlerted = false;
        sub._channelRetryStep = 0;
        sub._channelRetryRefills = 0;
    }

    /**
     * Schedule the next rung of the escalating re-scan ladder that follows a
     * channel failure, so a recovery attempt is verified in seconds instead of
     * after the next 60s fill-poll tick.
     *
     * The ladder is bounded: once exhausted the regular poll cadence takes over
     * again, so a permanently dead channel cannot become a tight scan loop. The
     * step index resets whenever a reconnect is actually issued (a new recovery
     * attempt deserves a fresh verification ladder) and on any successful scan.
     */
    function scheduleChannelRetry(sub: SubscriptionEntry | null | undefined, context?: string): void {
        if (!sub || channelRetryLadderMs.length === 0) return;
        if (sub._channelRetryTimer) return;
        const step = Number(sub._channelRetryStep) || 0;
        if (step >= channelRetryLadderMs.length) return;
        sub._channelRetryStep = step + 1;
        // Label the rung distinctly from the scan that scheduled it, and include
        // the rung number, so a log reader can tell a fast retry from a 60s poll
        // tick and see how far the ladder has climbed.
        const retryContext = `retry${sub._channelRetryStep}-after-${context || 'scan'}`;
        const timer = setTimeout(() => {
            sub._channelRetryTimer = null;
            // The entry may have been unsubscribed (or already recovered) while
            // the retry was pending.
            if (!sub.active || !subscriptions.has(sub.accountName)) return;
            if (!sub.accountId) return;
            // Never overlap another scan for the same sub. A regular poll, a
            // notice/eager-gap scan, or a resubscribe may already be in flight;
            // its result will schedule the next rung (success clears the ladder,
            // failure re-enters recordChannelFailure), so dropping this rung is
            // safe and mirrors the guards used by every other processObjects
            // caller.
            if (sub.reconnecting || sub._processingHistory || pendingScans.has(sub)) return;
            sub._processingHistory = true;
            processObjects(sub, [sub.accountId], { context: retryContext })
                .catch((err: unknown) => {
                    // processObjects handles its own errors; this only guards
                    // against a throw from the retry plumbing itself.
                    recordChannelFailure(sub, err, retryContext);
                })
                .finally(() => {
                    sub._processingHistory = false;
                });
        }, channelRetryLadderMs[step]);
        sub._channelRetryTimer = timer;
        if (typeof timer?.unref === 'function') timer.unref();
    }

    function clearChannelRetry(sub: SubscriptionEntry | null | undefined): void {
        if (sub?._channelRetryTimer) {
            clearTimeout(sub._channelRetryTimer);
            sub._channelRetryTimer = null;
        }
    }

    /**
     * Record a history-channel failure and keep escalating while the channel
     * stays dead. Callback/processing errors (flagged subscriptionErrorReported)
     * are not channel failures and must not trip the watchdog — a deterministic
     * downstream bug would otherwise reconnect-storm.
     *
     * Reconnect requests are NOT latched on the degraded flag: if a forced
     * reconnect fails to clear the channel (every node equally stale, or the
     * same session bug on the new node), the account must keep asking. The rate
     * is bounded centrally by the per-client cooldown in
     * chain_client.forceReconnect, so re-arming here cannot storm. Only the
     * DEGRADED log line and the operator alert are transition-gated.
     */
    function recordChannelFailure(sub: SubscriptionEntry | null | undefined, err: unknown, context?: string): void {
        if (!sub) return;
        const label = `processObjects${context ? ` (${context})` : ''}`;
        if ((err as { subscriptionErrorReported?: unknown } | null)?.subscriptionErrorReported) {
            warnSubscription(sub, `${label}: callback error`, err, 'callback');
            return;
        }
        const failures = (Number(sub._channelFailures) || 0) + 1;
        sub._channelFailures = failures;
        warnSubscription(sub, `${label}: error`, err);

        const account = sub.accountName || sub.accountId || 'unknown';
        if (failures >= channelDegradedThreshold) {
            if (!sub._channelDegraded) {
                sub._channelDegraded = true;
                subscriptionsLogger.warn(
                    `Fill channel DEGRADED for ${account}: ${failures} consecutive history-scan failures ` +
                    `(last: ${getErrorMessage(err)}) — forcing reconnect (node=${activeNodeUrl()})`
                );
            }
            const outcome = requestChannelReconnect(`fill channel degraded for ${account}: ${getErrorMessage(err)}`);
            // Count a recovery cycle for a genuinely new teardown AND for one
            // coalesced onto another escalation source's recent reconnect. The
            // stale api_id path runs inside the RPC catch, before this failure
            // reaches us, so without counting `coalesced` it would reliably
            // consume the shared cooldown and starve the operator alert / node
            // strike in exactly the stale-id wedge this watchdog targets.
            if (outcome === 'issued' || outcome === 'coalesced') {
                sub._channelRecoveryCycles = (Number(sub._channelRecoveryCycles) || 0) + 1;
                // Only a genuinely new teardown gets a fresh verification ladder;
                // a coalesced reconnect is already being verified by its issuer's
                // own post-reconnect catch-up scan. Bounded by
                // channelRetryMaxRefills so a dead channel cannot chain the ladder.
                if (outcome === 'issued') {
                    const refills = Number(sub._channelRetryRefills) || 0;
                    if (refills < channelRetryMaxRefills) {
                        sub._channelRetryRefills = refills + 1;
                        sub._channelRetryStep = 0;
                    }
                }
                // Recovery is not working. This is where the node earns a strike:
                // the transport's own forced-reconnect report is deliberately
                // kept out of the persistent ledger (see reportNodeFailureToManager
                // in bitshares_client.ts), so a session-level wedge that clears
                // on the first or second cycle costs the node nothing, while a
                // node that survives repeated failed recovery is recorded here.
                if (sub._channelRecoveryCycles >= channelRecoveryAlertAfter) {
                    reportChannelNodeFailure(account, err);
                }
                maybeAlertUnrecoverableChannel(sub, account, err);
            }
        }

        // Schedule the fast re-scan LAST, so the escalation above can refill the
        // ladder first. Scheduling before it would consume the last rung on the
        // very failure that escalates, leaving the fresh attempt with no retry
        // scheduled and idling until the next 60s poll.
        scheduleChannelRetry(sub, context);
    }

    /**
     * Record a REAL node failure once fill-channel recovery has demonstrably
     * failed, so genuinely bad nodes still reach the blacklist threshold.
     *
     * Deliberately NOT done for every forced reconnect: the transport reports
     * those as 'forced-reconnect' and bitshares_client.ts keeps that source out
     * of the persistent strike ledger. A forced reconnect is an attempt; a node
     * that is still serving a dead channel after several of them is evidence.
     *
     * Attribution: the strike lands on the node active at THIS failing scan, not
     * necessarily the node that caused the original wedge — each forced
     * reconnect rotates away from the failed node, so a per-cycle wedge spreads
     * strikes across the nodes that keep serving it. A single bad node is
     * rotated off and recovers before striking; a wedge shared by all nodes
     * legitimately accumulates strikes against each of them.
     */
    function reportChannelNodeFailure(account: string, err: unknown): void {
        const node = activeNodeUrl();
        // 'unknown node' is the activeNodeUrl() fallback, not a reportable URL.
        if (!node || node === 'unknown node') return;
        try {
            if (typeof chainClient.reportNodeFailure === 'function') {
                chainClient.reportNodeFailure(
                    node,
                    `fill channel unrecoverable for ${account}: ${getErrorMessage(err)}`,
                    'fill-channel-unrecoverable'
                );
            }
        } catch (_) {
            // Best-effort: never let strike bookkeeping break the watchdog.
        }
    }

    /**
     * Operator-facing escalation: after N forced reconnects without the channel
     * recovering, recovery is not working and a human/restart is needed. Purely
     * informational reconnect looping is invisible in the logs, which is how the
     * original incident went unnoticed for hours.
     */
    function maybeAlertUnrecoverableChannel(sub: SubscriptionEntry, account: string, err: unknown): void {
        if (sub._recoveryAlerted) return;
        const cycles = Number(sub._channelRecoveryCycles) || 0;
        if (cycles < channelRecoveryAlertAfter) return;
        sub._recoveryAlerted = true;
        subscriptionsLogger.error(
            `Fill channel for ${account} did NOT recover after ${cycles} forced reconnects ` +
            `(last: ${getErrorMessage(err)}) — fills may be missed. Automatic recovery is giving up; ` +
            `check node health, then restart the bot if the channel stays dead (node=${activeNodeUrl()})`
        );
    }

    /**
     * Force a reconnect to recover a dead-but-open fill channel. The debounce
     * lives in chain_client.forceReconnect (one per client, shared with the
     * stale api_id escalation), so this is a straight delegation.
     *
     * The reconnect re-establishes the login session AND fires the registered
     * post-reconnect safety-net sync (the fill backlog is then discovered even
     * if the subscription feed stays quiet).
     *
     * @returns the reconnect outcome: 'issued' (a new teardown started),
     *          'coalesced' (a forced reconnect was already issued within the
     *          shared cooldown), or 'unavailable' (no live socket / no escalation
     *          path).
     */
    function requestChannelReconnect(reason: string): 'issued' | 'coalesced' | 'unavailable' {
        try {
            if (typeof chainClient.forceReconnect !== 'function') return 'unavailable';
            const outcome = chainClient.forceReconnect(reason);
            // New chain_client contract. Legacy/mock booleans are normalized so
            // the accounting is stable: true = issued, anything else = unavailable.
            if (outcome === 'issued' || outcome === 'coalesced' || outcome === 'unavailable') {
                return outcome;
            }
            return outcome === true ? 'issued' : 'unavailable';
        } catch (_) {
            // Best-effort recovery; the next failure re-requests (the watchdog
            // no longer latches, so a broken recovery is retried, not dropped).
            return 'unavailable';
        }
    }

    function getAccountHistoryFetcher(): (...args: unknown[]) => Promise<unknown[]> {
        return chainClient.history?.getAccountHistory
            || chainClient.history?.get_account_history
            || (chainClient.history?.getAccountHistoryOperations
                ? ((accountId: string, stop: string, limit: number, start: string) => chainClient.history!.getAccountHistoryOperations!(accountId, OP_FILL_ORDER, start, stop, limit)) as (...args: unknown[]) => Promise<unknown[]>
                : null)
            || ((...args: unknown[]) => chainClient.history!.call('get_account_history', args) as Promise<unknown[]>);
    }

    async function fetchFullAccountWithRetry(sub: SubscriptionEntry, subscribe: boolean = false): Promise<AccountInfo | null> {
        const accountRef = sub.accountId || sub.accountName;
        let lastErr = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const accounts = await chainClient.db.get_full_accounts([accountRef], subscribe);
                const account = accounts?.[0]?.[1];
                if (account) return account;
                warnSubscription(sub, `get_full_accounts returned no account data on attempt ${attempt}`);
            } catch (err) {
                lastErr = err;
                warnSubscription(sub, `get_full_accounts failed on attempt ${attempt}`, err);
            }
        }

        if (lastErr) throw lastErr;
        return null;
    }

    // Use get_account_history (unfiltered) instead of
    // get_account_history_operations (type-filtered). The type-filtered API
    // walks a per-account linked list and may miss fill_order operations even
    // when they exist on chain for the account. The unfiltered API uses the
    // efficient by_op index and returns ALL operation types. We filter for
    // OP_FILL_ORDER client-side in processObjects.
    async function fetchFillHistoryEntries(accountId: string, cursorHistoryId: string, options: ProcessOptions = {}): Promise<HistoryEntry[]> {
        const fetchPage = getAccountHistoryFetcher();

        const entries: HistoryEntry[] = [];
        const seenIds = new Set();
        const cursorInstance = parseObjectIdInstance(cursorHistoryId);

        // Gap-recovery lookback: when a gap is suspected (the live feed jumped the
        // cursor past one or more filled ops), re-scan a window BELOW the cursor so
        // the stranded fills get recovered. Re-delivery of already-seen ops in this
        // window is safe: downstream dedups every fill by its history id (see
        // dexbot_fill_runtime _isNewFillKey). See AGENTS/bitshares-core for the
        // get_account_history range semantics this relies on.
        const lookbackOps = Number.isFinite(options?.lookbackOps) ? Math.max(0, Math.floor(Number(options.lookbackOps))) : 0;
        let lookbackStopHistoryId = cursorHistoryId;
        let lookbackStopInstance = cursorInstance;
        // Actual `stop` handed to get_account_history. For the no-lookback case this is
        // just the cursor. With a lookback window we lower it one slot below
        // lookbackStop so the boundary op itself is included (see below).
        let stopHistoryId = cursorHistoryId;
        if (lookbackOps > 0 && Number.isFinite(cursorInstance)) {
            const decremented = decrementObjectIdBy(cursorHistoryId, lookbackOps);
            if (decremented) {
                lookbackStopHistoryId = decremented;
                lookbackStopInstance = cursorInstance - lookbackOps;
                // bitshares-core treats `stop` as EXCLUSIVE (api.cpp:443): it returns ops
                // strictly greater than stop. To make the lookback window inclusive of the
                // op sitting exactly at lookbackStop, lower the fetch stop by one instance.
                const stopAdjusted = decrementObjectIdBy(lookbackStopHistoryId, 1);
                stopHistoryId = stopAdjusted ?? lookbackStopHistoryId;
            }
            // else: underflow (cursor instance < lookbackOps) — keep stopHistoryId at
            // cursor and lookbackStopInstance at cursor so the two variables stay
            // consistent; server bounds the window anyway (1.11.0 is the floor).
        }

        // Scan history using get_account_history (unfiltered, uses by_op index).
        // Parameters: (accountId, stop, limit, start)
        // API returns entries from start (newest) down to stop (cursor), with
        // start=0 being replaced by the server with the max/head operation ID.
        // With a lookback window, `stop` is lowered to lookbackStopHistoryId so the
        // scan also covers the gap-recovery region below the cursor.
        let startHistoryId = SUBSCRIPTIONS.HISTORY_API_OBJECT;
        let pagesFetched = 0;
        const maxPagesDefault = SUBSCRIPTIONS.HISTORY_MAX_PAGES;
        const maxPages = Number.isFinite(options.maxPages) ? Number(options.maxPages) : maxPagesDefault;

        // Cap page size to the node's api_limit_get_account_history to avoid FC_ASSERT.
        const configuredLimit = typeof chainClient.getApiLimitGetAccountHistory === 'function'
            ? chainClient.getApiLimitGetAccountHistory()
            : null;
        const pageLimit = configuredLimit != null
            ? Math.min(SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX, configuredLimit)
            : SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX;
        if (configuredLimit != null && configuredLimit < SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX) {
            subscriptionsLogger.warn(
                `fetchFillHistoryEntries: node api_limit_get_account_history (${configuredLimit}) ` +
                `< HISTORY_LOOKBACK_MAX (${SUBSCRIPTIONS.HISTORY_LOOKBACK_MAX}), capping page size to ${pageLimit}`
            );
        }

        subscriptionsLogger.debug(`fetchFillHistoryEntries: account=${accountId}, cursor=${cursorHistoryId}, lookbackOps=${lookbackOps}, stop=${stopHistoryId}, maxPages=${maxPages}, pageLimit=${pageLimit}`);

        const FETCH_PAGE_TIMEOUT_MS = require('../constants').TIMING.FETCH_HISTORY_PAGE_TIMEOUT_MS;
        const FETCH_TOTAL_DEADLINE_MS = require('../constants').TIMING.FETCH_HISTORY_TOTAL_DEADLINE_MS;
        const scanStartedAt = Date.now();

        while (true) {
            // Outer deadline: if the total scan takes longer than
            // FETCH_HISTORY_TOTAL_DEADLINE_MS, return partial results rather
            // than blocking notice processing indefinitely.
            if (Date.now() - scanStartedAt > FETCH_TOTAL_DEADLINE_MS) {
                subscriptionsLogger.warn(
                    `fetchFillHistoryEntries: total deadline (${FETCH_TOTAL_DEADLINE_MS}ms) exceeded for ${accountId}; ` +
                    `returning ${entries.length} entries across ${pagesFetched} page(s)`
                );
                break;
            }

            let pageTimer: ReturnType<typeof setTimeout> | undefined;
            const page = await Promise.race([
                Promise.resolve(fetchPage(
                    accountId,
                    stopHistoryId,
                    pageLimit,
                    startHistoryId
                )),
                new Promise<HistoryEntry[]>((_, reject) => {
                    pageTimer = setTimeout(() => {
                        reject(new Error(`fetchFillHistoryEntries: page ${pagesFetched + 1} timed out after ${FETCH_PAGE_TIMEOUT_MS}ms`));
                    }, FETCH_PAGE_TIMEOUT_MS);
                    // Never hold the process open on a watchdog: the race settles
                    // via the fetch branch in the common case; the timer only
                    // matters while the loop is alive for other reasons.
                    if (typeof pageTimer?.unref === 'function') pageTimer.unref();
                })
            ]).finally(() => {
                if (pageTimer) clearTimeout(pageTimer);
            }) as HistoryEntry[];
            pagesFetched++;

            const pageLen = Array.isArray(page) ? page.length : 0;
            subscriptionsLogger.debug(`fetchFillHistoryEntries: page ${pagesFetched} returned ${pageLen} entries (start=${startHistoryId}, stop=${stopHistoryId})`);

            if (!Array.isArray(page) || page.length === 0) break;

            let allEntriesAtOrBeforeStop = true;
            let skippedCount = 0;
            for (const entry of page) {
                if (!entry || !entry.id || seenIds.has(entry.id)) continue;
                seenIds.add(entry.id);

                // Keep entries at or above the scan's lower bound. Without a lookback
                // window that bound is the cursor (keep strictly newer than cursor, so
                // skip <= cursor); with a lookback it is lookbackStop (keep >= lookbackStop,
                // so skip < lookbackStop). The region between lookbackStop and the cursor
                // is intentionally re-scanned to recover skipped fills.
                const entryInstance = parseObjectIdInstance(entry.id);
                const atOrBeforeStop = lookbackOps > 0
                    ? (Number.isFinite(entryInstance) && entryInstance < lookbackStopInstance)
                    : (Number.isFinite(cursorInstance) && Number.isFinite(entryInstance) && entryInstance <= cursorInstance);
                if (atOrBeforeStop) {
                    skippedCount++;
                    continue;
                }

                allEntriesAtOrBeforeStop = false;
                entries.push(entry);
            }
            if (skippedCount > 0) {
                subscriptionsLogger.debug(`fetchFillHistoryEntries: skipped ${skippedCount} entries below scan lower bound (stop=${stopHistoryId})`);
            }

            if (page.length < pageLimit) {
                subscriptionsLogger.debug(`fetchFillHistoryEntries: last page (${page.length} < ${pageLimit})`);
                break;
            }
            if (maxPages !== null && pagesFetched >= maxPages) {
                subscriptionsLogger.debug(`fetchFillHistoryEntries: maxPages (${maxPages}) reached`);
                break;
            }
            // Stop if all entries on this page are below the scan lower bound.
            if (allEntriesAtOrBeforeStop) break;

            const oldestId = page[page.length - 1]?.id;
            const nextStartHistoryId = decrementObjectId(oldestId);
            if (!oldestId || !nextStartHistoryId || nextStartHistoryId === startHistoryId) break;
            startHistoryId = nextStartHistoryId;
        }

        subscriptionsLogger.debug(`fetchFillHistoryEntries: returning ${entries.length} operation(s) across ${pagesFetched} page(s) for ${accountId}`);
        return sortEntriesOldestFirst(entries);
    }

    async function primeLastDeliveredHistoryId(sub: SubscriptionEntry | null | undefined): Promise<string> {
        if (!sub?.accountId) return SUBSCRIPTIONS.HISTORY_API_OBJECT;

        // Use get_account_history (unfiltered) to find the
        // single most recent history entry. This seeds the cursor past "1.11.0"
        // so fetchFillHistoryEntries can scan from the latest entry forward.
        const fetchAnyPage = getAccountHistoryFetcher();
        try {
            const entries = await Promise.resolve(fetchAnyPage(
                sub.accountId,
                SUBSCRIPTIONS.HISTORY_API_OBJECT,
                1,
                SUBSCRIPTIONS.HISTORY_API_OBJECT
            ));
            const latestId = (entries?.[0] as { id?: string } | undefined)?.id;
            if (latestId) {
                subscriptionsLogger.info(`primeLastDeliveredHistoryId: resolved to ${latestId} for ${sub.accountName}`);
                return latestId;
            }
        } catch (err) {
            subscriptionsLogger.warn(`primeLastDeliveredHistoryId: get_account_history failed for ${sub.accountName}: ${getErrorMessage(err)}`);
        }

        subscriptionsLogger.info(`primeLastDeliveredHistoryId: no history found, using HISTORY_API_OBJECT for ${sub.accountName}`);
        return SUBSCRIPTIONS.HISTORY_API_OBJECT;
    }

    function ensureNoticeSubscription() {
        if (unsubscribeNotice) {
            if (typeof unsubscribeNotice.isActive !== 'function' || unsubscribeNotice.isActive()) return;
            unsubscribeNotice = null;
        }
        unsubscribeNotice = chainClient.transport.addMessageHandler(handleNotice);
    }

    function removeNoticeSubscription() {
        if (unsubscribeNotice) {
            unsubscribeNotice();
            unsubscribeNotice = null;
        }
    }

    /**
     * Check if a fill object's account_id matches the given account ID.
     * Each fill_order_operation has an `account_id` field identifying
     * the account whose order was filled.
     */
    function fillMatchesAccount(fill: FillObject | HistoryEntry, accountId: string | null | undefined): boolean {
        const fillAccountId = (fill?.op?.[1] as { account_id?: unknown } | undefined)?.account_id;
        return fillAccountId === accountId;
    }

    async function handleNotice(params: unknown): Promise<void> {
        if (!Array.isArray(params) || params.length < 2) {
            subscriptionsLogger.info('handleNotice: skipping (invalid params)');
            return;
        }

        const [callbackId, data] = params;
        if (callbackId !== SUBSCRIBE_CALLBACK_ID) return;

        if (!Array.isArray(data) || data.length === 0) return;

        // Extract fill objects directly from notice data.
        // The BitShares node sends full 1.11.x operation history objects in the
        // notice when a fill occurs. We pass them straight to callbacks — no
        // history scan, no cursor tracking needed for live fills.
        const fillObjects: FillObject[] = [];
        for (const item of data) {
            if (!item || typeof item !== 'object') continue;
            const op = item.op;
            if (Array.isArray(op) && op[0] === OP_FILL_ORDER) {
                fillObjects.push({
                    type: 'fill',
                    op: op,
                    block_num: item.block_num,
                    trx_in_block: item.trx_in_block,
                    id: item.id,
                });
            }
        }

        if (fillObjects.length === 0) {
            // No fills in this notice — scan all active subscriptions to catch
            // up on any fills that may have occurred. Non-fill notices (object
            // changes, statistics updates, etc.) don't carry op data, so we must
            // fall back to history scanning to detect fills.
            //
            // Compute the per-notice max history instance once. Bare object notices
            // (statistics/account/limit-order updates) carry no 1.11.x id, so
            // noticeMaxInstance stays at -1 and the per-subscription cursor check
            // falls through to the coalesced scan path.
            let noticeMaxInstance = -1;
            for (const item of data) {
                if (!item || typeof item !== 'object') continue;
                const id = item.id;
                if (typeof id !== 'string' || !id.startsWith(`${SUBSCRIPTIONS.OPERATION_HISTORY_PREFIX}.`)) continue;
                const inst = parseObjectIdInstance(id);
                if (Number.isFinite(inst) && inst > noticeMaxInstance) {
                    noticeMaxInstance = inst;
                }
            }
            const now = Date.now();
            const eligible: SubscriptionEntry[] = [];
            for (const [, sub] of subscriptions) {
                if (!sub.active) continue;
                // Skip when the notice carries a 1.11.x id that this sub's cursor
                // has already covered — no new fills to catch up.
                if (noticeMaxInstance !== -1) {
                    const subCursorInstance = parseObjectIdInstance(sub.lastDeliveredHistoryId);
                    if (Number.isFinite(subCursorInstance) && subCursorInstance >= noticeMaxInstance) continue;
                }
                eligible.push(sub);
            }
            if (eligible.length === 0) return;

            // Coalesce: no-fill notices are just trigger signals. Schedule one
            // history scan per subscription for the coalesce window instead of
            // running one RPC per notice.
            for (const sub of eligible) {
                // Stamp eligible subs as alive — the notice arrived and a scan
                // will follow. We can't route non-fill objects per-account, so
                // this stamps all eligible subs imprecisely.
                //
                // Coverage gap: if only non-fill notices are arriving (e.g. a
                // statistics-only update for account A), all eligible subs get
                // stamped, masking a per-account fill-stream death for account B.
                // Mitigation: the coalesced processObjects scan (triggered next)
                // fetches fill history per-account via direct RPC, so no fills
                // are actually lost — they're just discovered on the next scan
                // instead of via push notification.
                sub.lastNoticeAt = now;

                // Re-entrancy guard: if _processingHistory is true, a history scan
                // for this subscription is already in flight. Skip this notice — the
                // active scan already walks from the cursor forward and will catch
                // any fills this notice describes. Without this guard, concurrent
                // scans race on lastDeliveredHistoryId advancement, causing
                // double-processing or skipped fills.
                if (sub._processingHistory) continue;
                sub._processingHistory = true;

                if (noticeCoalesceMs > 0) {
                    const entry = { timer: null as ReturnType<typeof setTimeout> | null, lastNoticeAt: now };
                    entry.timer = setTimeout(() => {
                        pendingScans.delete(sub);
                        (processObjects(sub, data).catch((err: unknown) => {
                            subscriptionsLogger.warn(`processObjects (coalesced) error for ${sub.accountName}: ${getErrorMessage(err)}`);
                        })).finally(() => {
                            sub._processingHistory = false;
                        });
                    }, noticeCoalesceMs);
                    if (typeof entry.timer.unref === 'function') entry.timer.unref();
                    pendingScans.set(sub, entry);
                } else {
                    try {
                        await processObjects(sub, data);
                    } finally {
                        sub._processingHistory = false;
                    }
                }
            }
            return;
        }

        subscriptionsLogger.info(`handleNotice: dispatching ${fillObjects.length} fill(s) directly from notice data`);

        // Batch fills per-subscription and dispatch all at once, so a single
        // callback receives all fills from one notice.
        const gapRecoveryArmed: SubscriptionEntry[] = [];
        for (const [, sub] of subscriptions) {
            if (!sub.active) continue;
            const subFills = fillObjects.filter((fill) => fillMatchesAccount(fill, sub.accountId));
            if (subFills.length === 0) continue;

            // Compute the cursor advance from the FILL ops actually delivered to this
            // subscription — NOT from every item in the notice. The previous logic
            // advanced the cursor to the highest op id present in the notice, which
            // could be a non-fill op (e.g. limit_order_create) or a later fill in the
            // same block. Advancing past such an op silently skips any fill ops whose
            // ids fall between the old cursor and that max id: fetchFillHistoryEntries
            // only scans strictly newer than the cursor, so those fills are lost
            // forever (causing inventory drift / oversell). Restricting the advance to
            // delivered fills keeps the cursor as low as possible; any residual gap is
            // recovered by the lookback scan (sub._gapRecovery) in processObjects.
            let latestId: string | null = null;
            let latestInstance = -1;
            for (const fill of subFills) {
                if (!fill || typeof fill !== 'object') continue;
                const inst = parseObjectIdInstance(fill.id);
                if (Number.isFinite(inst) && inst > latestInstance) {
                    latestInstance = inst;
                    latestId = fill.id ?? null;
                }
            }

            const failed: unknown[] = [];
            for (const callback of sub.callbacks) {
                try {
                    await Promise.resolve(callback(subFills));
                } catch (err) {
                    subscriptionsLogger.warn(`handleNotice: callback error for ${sub.accountName}: ${getErrorMessage(err)}`);
                    failed.push(err);
                }
            }

            // Notice delivered a fill for this account — stamp alive regardless
            // of callback outcome. Callback failure is a processing issue tracked
            // separately (cursor not advanced, onError dispatched).
            sub.lastNoticeAt = Date.now();

            if (failed.length > 0) {
                if (sub.onError) {
                    for (const err of failed) {
                        try { sub.onError(err); } catch (_) {}
                    }
                }
                // Cursor NOT advanced — retry on next scan.
            } else if (latestId && (!sub.lastDeliveredHistoryId || parseObjectIdInstance(latestId) > parseObjectIdInstance(sub.lastDeliveredHistoryId))) {
                const oldCursorInst = parseObjectIdInstance(sub.lastDeliveredHistoryId);
                const gap = Number.isFinite(oldCursorInst) && Number.isFinite(latestInstance) ? latestInstance - oldCursorInst : Infinity;
                sub.lastDeliveredHistoryId = latestId;
                // A notice advanced the cursor without a full history scan, so a fill
                // op may have been skipped between the old and new cursor. Arm the
                // lookback scan only when there is at least one op slot between the
                // old cursor and the new fill (gap > 1) — otherwise the window is
                // contiguous and no fill could have been skipped. This avoids a
                // 40-page history scan on every sequential fill while still
                // covering the crash-burst case (gap >> 1).
                if (gap > 1) {
                    sub._gapRecovery = true;
                    gapRecoveryArmed.push(sub);
                }
            }
        }

        // Eager gap-recovery: don't wait for the next non-fill notice (250ms
        // coalesce) or the 60s poll — which leaves a correctness window in the
        // quiet-after-gap case. Schedule a coalesced lookback scan for each
        // armed subscription. Cost is one 40-page window per gap event, not
        // per poll. If a scan is already pending/in-flight (_processingHistory
        // or pendingScans), the flag stays armed and the in-flight scan will
        // consume it (or the next tick will).
        for (const sub of gapRecoveryArmed) {
            if (sub._processingHistory) continue;
            if (pendingScans.has(sub)) continue;
            sub._processingHistory = true;
            if (noticeCoalesceMs > 0) {
                const entry = { timer: null as ReturnType<typeof setTimeout> | null, lastNoticeAt: Date.now() };
                entry.timer = setTimeout(() => {
                    pendingScans.delete(sub);
                    (processObjects(sub, [sub.accountId]).catch((err: unknown) => {
                        subscriptionsLogger.warn(`processObjects (eager gap-recovery) error for ${sub.accountName}: ${getErrorMessage(err)}`);
                    })).finally(() => {
                        sub._processingHistory = false;
                    });
                }, noticeCoalesceMs);
                if (typeof entry.timer.unref === 'function') entry.timer.unref();
                pendingScans.set(sub, entry);
            } else {
                (processObjects(sub, [sub.accountId]).catch((err: unknown) => {
                    subscriptionsLogger.warn(`processObjects (eager gap-recovery) error for ${sub.accountName}: ${getErrorMessage(err)}`);
                })).finally(() => {
                    sub._processingHistory = false;
                });
            }
        }
    }

    async function processObjects(sub: SubscriptionEntry, data: unknown[], options: ProcessOptions = {}): Promise<void> {
        if (!data || !Array.isArray(data)) return;

        const noticeObjectIds: string[] = [];
        for (const item of data) {
            if (!item) continue;
            const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : item;
            if (typeof id !== 'string') continue;
            noticeObjectIds.push(id);
        }

        if (noticeObjectIds.length === 0) {
            subscriptionsLogger.debug(`processObjects: no identifiable object IDs in notice data for ${sub.accountName} (dataLen=${data?.length}, types=${data.map((d) => typeof d).join(',')})`);
            // NOTE: Do NOT return early here. The notice data is just a trigger signal;
            // we must always scan fill history to catch actual fills, because the node
            // may send objects without string `id` fields (e.g. bare account/statistics objects).
            // Fall through to the account fetch + history scan below.
        }

        try {
            // Skip get_full_accounts (heavy RPC) when accountId is already known.
            // All callers (handleNotice, resubscribeEntry, resubscribeAll) either
            // set it during subscribe or refresh it in their preamble.
            let accountId = sub.accountId;
            if (!accountId) {
                const accData = await fetchFullAccountWithRetry(sub, false);
                if (!accData) {
                    subscriptionsLogger.warn(`processObjects: get_full_accounts returned no data for ${sub.accountName}`);
                    if (options.throwOnError) {
                        throw new Error('get_full_accounts returned no account data');
                    }
                    return;
                }
                accountId = accData.account?.id || sub.accountId;
                if (!accountId) {
                    subscriptionsLogger.warn(`processObjects: no account id after fetch for ${sub.accountName}`);
                    if (options.throwOnError) {
                        throw new Error('get_full_accounts returned no account id');
                    }
                    return;
                }
                sub.accountId = accountId;
                sub.statisticsId = accData.account?.statistics || sub.statisticsId || null;
            }

            if (!sub.lastDeliveredHistoryId) {
                sub.lastDeliveredHistoryId = await primeLastDeliveredHistoryId(sub);
                subscriptionsLogger.debug(`processObjects: primed lastDeliveredHistoryId=${sub.lastDeliveredHistoryId} for ${sub.accountName}`);
            }

            let history: HistoryEntry[];
            if (sub._gapRecovery) {
                // Gap-recovery: a notice-driven cursor advance (or a reconnect) may have
                // skipped fills that sit BELOW the cursor. Do a single lookback scan
                // instead of a separate tail fetch + merge: the lookback returns the window
                // [lookbackStop, head] — i.e. the below-cursor gap AND the strictly-newer
                // tail in ONE call — already sorted oldest-first. Re-delivery of already-seen
                // ops is safe (downstream dedups by history id).
                // _gapRecovery is cleared only after a successful fetch so a throw/timeout
                // keeps it armed for retry on the next poll/notice.
                history = await fetchFillHistoryEntries(accountId, sub.lastDeliveredHistoryId, {
                    ...options,
                    lookbackOps: SUBSCRIPTIONS.HISTORY_GAP_LOOKBACK_OPS,
                });
                sub._gapRecovery = false;
                subscriptionsLogger.info(`processObjects: gap-recovery scan (lookback=${SUBSCRIPTIONS.HISTORY_GAP_LOOKBACK_OPS}) returned ${history.length} op(s) for ${sub.accountName} (cursor=${sub.lastDeliveredHistoryId})`);
            } else {
                history = await fetchFillHistoryEntries(accountId, sub.lastDeliveredHistoryId, options);
            }

            // Defensive: guarantee oldest-first ordering so the cursor advance below lands
            // on the newest op (history[last]), never a gap entry pushed onto the end.
            sortEntriesOldestFirst(history);

            // The history RPC succeeded — the channel is alive regardless of what
            // the entries contain or whether downstream callbacks succeed.
            recordChannelSuccess(sub);

            if (history.length === 0) {
                sub.lastNoticeAt = Date.now();
                subscriptionsLogger.debug(`processObjects: no history entries for ${sub.accountName} (cursor=${sub.lastDeliveredHistoryId})`);
                return;
            }

            const historyRange = history.length > 0
                ? `${history[0]?.id}..${history[history.length - 1]?.id}`
                : 'empty';
            subscriptionsLogger.debug(`processObjects: ${history.length} history entries for ${sub.accountName} range=${historyRange} cursor=${sub.lastDeliveredHistoryId}`);

            const fills: FillObject[] = [];
            for (const entry of history) {
                if (!entry || !entry.op || !entry.id) continue;
                const opData = entry.op;
                if (Array.isArray(opData) && opData[0] === OP_FILL_ORDER) {
                    fills.push({
                        type: 'fill',
                        op: opData,
                        block_num: entry.block_num,
                        trx_in_block: entry.trx_in_block,
                        id: entry.id,
                    });
                }
            }

            if (fills.length > 0) {
                const fillIds = fills.map(f => f.id).join(', ');
                const newCursor = history[history.length - 1]?.id || sub.lastDeliveredHistoryId;
                subscriptionsLogger.info(`processObjects: dispatching ${fills.length} fill(s) to ${sub.callbacks.size} callback(s) for ${sub.accountName} cursor=${newCursor} fills=[${fillIds}]`);
                const failed: unknown[] = [];
                for (const callback of sub.callbacks) {
                    try {
                        await Promise.resolve(callback(fills));
                    } catch (err) {
                        warnSubscription(sub, 'processObjects: callback error', err, 'callback');
                        failed.push(err);
                    }
                }

                if (failed.length > 0) {
                    sub.lastNoticeAt = Date.now();
                    if (sub.onError) {
                        for (const err of failed) {
                            try { sub.onError(err); } catch (_) {}
                        }
                    }
                    if (options.throwOnError) {
                        // Do NOT advance cursor on throwOnError failure — the caller
                        // (resubscribeEntry/resubscribeAll) will retry and must find
                        // the same fills again.
                        (failed[0] as { subscriptionErrorReported?: boolean }).subscriptionErrorReported = true;
                        throw failed[0];
                    }
                    // Non-throwing path (e.g. handleNotice fallback scan): also do NOT
                    // advance cursor. The next notice-triggered scan or reconnect will
                    // re-fetch these fills, giving callbacks another chance.
                    return;
                }

                // All callbacks succeeded — advance cursor past this batch.
                sub.lastDeliveredHistoryId = newCursor;
                sub.lastNoticeAt = Date.now();
            } else {
                // No fills in this batch — advance cursor past history to avoid
                // re-scanning non-fill operations on subsequent calls.
                sub.lastDeliveredHistoryId = history[history.length - 1]?.id || sub.lastDeliveredHistoryId;
                sub.lastNoticeAt = Date.now();
                subscriptionsLogger.debug(`processObjects: history had entries but none were FILL_ORDER operations for ${sub.accountName}`);
            }
        } catch (err) {
            sub.lastNoticeAt = Date.now();
            recordChannelFailure(sub, err, options?.context);
            if (sub.onError && !getErrorField<boolean>(err, 'subscriptionErrorReported')) {
                try { sub.onError(err); } catch (_) {}
            }
            if (options.throwOnError) throw err;
        }
    }

    function clearReconnectRetry(entry: SubscriptionEntry | null | undefined): void {
        if (!entry?.reconnectRetryTimer) return;
        clearTimeout(entry.reconnectRetryTimer);
        entry.reconnectRetryTimer = null;
    }

    function scheduleReconnectRetry(entry: SubscriptionEntry | null | undefined, err: unknown): void {
        if (!entry || entry.reconnectRetryTimer || !entry.active || entry.callbacks?.size === 0) return;

        entry.reconnectRetryTimer = setTimeout(() => {
            entry.reconnectRetryTimer = null;
            resubscribeEntry(entry, 'retry').catch((retryErr: unknown) => {
                warnSubscription(entry, 'Failed to resubscribe', retryErr);
                scheduleReconnectRetry(entry, retryErr);
            });
        }, reconnectRetryDelayMs);
        if (typeof entry.reconnectRetryTimer.unref === 'function') {
            entry.reconnectRetryTimer.unref();
        }

        warnSubscription(entry, `scheduled reconnect retry in ${reconnectRetryDelayMs}ms`, err);
    }

    /**
     * Centralized subscription refresh: set_subscribe_callback then re-subscribe ALL active accounts.
     * cancel_all_subscriptions(false, false) inside set_subscribe_callback clears
     * _subscribed_accounts for every account. Every active entry must be re-subscribed after
     * every call, not just the current one.
     */
    async function refreshSubscriptions(): Promise<Array<{ entry: SubscriptionEntry; err: unknown }>> {
        const failures: Array<{ entry: SubscriptionEntry; err: unknown }> = [];
        ensureNoticeSubscription();
        await chainClient.db.call('set_subscribe_callback', [
            SUBSCRIBE_CALLBACK_ID,
            false,
        ]);
        for (const [, subEntry] of subscriptions) {
            if (!subEntry.active) continue;
            try {
                await chainClient.db.get_full_accounts([subEntry.accountName], true);
            } catch (err) {
                warnSubscription(subEntry, 'Failed to re-subscribe account after set_subscribe_callback', err);
                failures.push({ entry: subEntry, err });
            }
        }
        return failures;
    }

    async function resubscribeEntry(entry: SubscriptionEntry | null | undefined, reason: string = 'reconnect') {
        if (!entry?.active) return;
        if (entry.reconnecting) return;
        entry.reconnecting = true;

        try {
            try {
                const accounts = await chainClient.db.get_full_accounts([entry.accountName], true);
                if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                    entry.accountId = accounts[0][1].account.id ?? null;
                    entry.statisticsId = accounts[0][1].account.statistics || null;
                }
            } catch (err) {
                warnSubscription(entry, 'Failed to refresh account data', err);
            }

            const refreshFailures = await refreshSubscriptions();
            const entryRefreshFailure = refreshFailures.find((failure) => failure.entry === entry);
            if (entryRefreshFailure) throw entryRefreshFailure.err;
            for (const failure of refreshFailures) {
                scheduleReconnectRetry(failure.entry, failure.err);
            }

            // A disconnect/reconnect means fills may have been missed while offline.
            // Arm gap recovery so the post-reconnect scan re-covers the window below
            // the cursor (not just strictly-newer ops).
            entry._gapRecovery = true;
            await processObjects(entry, [entry.accountId], {
                throwOnError: true,
            });
            clearReconnectRetry(entry);
            subscriptionsLogger.warn(`Subscription restored for ${entry.accountName} (${reason})`);
        } finally {
            entry.reconnecting = false;
        }
    }

    function startFillPolling(): void {
        if (fillPollTimer) return;

        const intervalMs = Number.isFinite(SUBSCRIPTIONS.FILL_POLL_INTERVAL_MS)
            ? Math.max(10000, SUBSCRIPTIONS.FILL_POLL_INTERVAL_MS)
            : SUBSCRIPTIONS.FILL_POLL_INTERVAL_MS;

        fillPollTimer = setInterval(async () => {
            if (fillPollInProgress) return;
            fillPollInProgress = true;
            try {
                for (const [, entry] of subscriptions) {
                    if (!entry.active) continue;
                    if (entry.reconnecting) continue;
                    if (entry._processingHistory) continue;
                    // A probe is already scheduled for this account: it re-scans
                    // in seconds, so a regular tick would only duplicate the
                    // request and burn a failure count against the threshold.
                    if (entry._channelRetryTimer) continue;
                    // Poll is a lightweight liveness check (fetches only >cursor, ~1 page
                    // in steady state). Gap recovery (2000 per-account ops ≈40 pages) is
                    // already armed by handleNotice cursor advances and by
                    // resubscribeEntry/resubscribeAll on disconnects. Poll does NOT arm
                    // unconditionally — that would turn every 60s tick into a 40-page
                    // re-fetch forever (~80 pages/min across several tracked accounts). If a gap-recovery
                    // fetch previously threw, _gapRecovery stays true and the next poll
                    // will run the lookback; otherwise this tick is just a plain >cursor
                    // scan with no lookback. Eager gap-recovery scheduled in handleNotice
                    // already handles the quiet-after-gap case in ~250ms, so this poll
                    // is only the safety-net fallback.
                    try {
                        await processObjects(entry, [entry.accountId], { context: 'fill-poll' });
                    } catch (err) {
                        subscriptionsLogger.warn(`Fill poll failed for ${entry.accountName}: ${getErrorMessage(err)}`);
                    }
                }
            } finally {
                fillPollInProgress = false;
            }
        }, intervalMs);

        if (typeof fillPollTimer.unref === 'function') {
            fillPollTimer.unref();
        }
    }

    function stopFillPolling(): void {
        if (fillPollTimer) {
            clearInterval(fillPollTimer);
            fillPollTimer = null;
        }
    }

    async function subscribe(accountName: string, callback: (fills: HistoryEntry[]) => unknown, onError: ((err: unknown) => void) | null = null) {
        if (!accountName || typeof accountName !== 'string') {
            throw new Error('accountName is required');
        }
        if (typeof callback !== 'function') {
            throw new Error('callback function is required');
        }

        let entry = subscriptions.get(accountName);
        const createdEntry = !entry;
        if (!entry) {
            entry = {
                accountName,
                accountId: null,
                statisticsId: null,
                lastDeliveredHistoryId: SUBSCRIPTIONS.HISTORY_API_OBJECT,
                lastNoticeAt: Date.now(),
                _gapRecovery: false,
                active: false,
                callbacks: new Set(),
                onError: null,
                reconnectRetryTimer: null,
                reconnecting: false,
                // Fill-channel health (see recordChannelFailure/recordChannelSuccess).
                _channelFailures: 0,
                _channelDegraded: false,
                // Forced reconnects issued for this account since the last
                // successful scan; drives the unrecoverable-channel alert.
                _channelRecoveryCycles: 0,
                _recoveryAlerted: false,
                // Pending fast re-scan after a failure: it retries in seconds, so
                // a regular tick would only duplicate the request and burn a
                // failure count against the threshold.
                _channelRetryTimer: null,
                _channelRetryStep: 0,
                _channelRetryRefills: 0,
                _warnThrottle: {},
            };
            subscriptions.set(accountName, entry);

            // Add callback BEFORE first await so a rollback unsubscribe()
            // during the async work can properly find and remove it,
            // keeping callbacks consistent and avoiding orphaned entries.
            entry.callbacks.add(callback);
            if (onError) entry.onError = onError;

            const accounts = await chainClient.db.get_full_accounts([accountName], true);
            // Detect a rollback unsubscribe() that fired during the await:
            // the entry is gone from the Map, so the native subscription was
            // already torn down by the caller. Abort cleanly without
            // re-priming or registering a server-side subscription — otherwise
            // the local entry would be orphaned (still in memory, not in Map)
            // and handleNotice() would never reach its callbacks.
            if (!subscriptions.has(accountName)) {
                return () => {};
            }
            if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                entry.accountId = accounts[0][1].account.id ?? null;
                entry.statisticsId = accounts[0][1].account.statistics || null;
            }
            if (!entry.accountId) {
                subscriptions.delete(accountName);
                throw new Error(`Could not resolve subscribed account: ${accountName}`);
            }
        } else {
            entry.callbacks.add(callback);
            if (onError) entry.onError = onError;
        }

        if (createdEntry) {
            try {
                // Prime the cursor BEFORE remote activation. The cursor is
                // decremented so that the next scan re-fetches the primed fill,
                // ensuring no fills are lost between prime and subscribe.
                const latestFillId = await primeLastDeliveredHistoryId(entry);
                if (!subscriptions.has(accountName)) {
                    // Rollback during prime — entry is gone. Abort without
                    // activating or calling refreshSubscriptions.
                    return () => {};
                }
                entry.lastDeliveredHistoryId = latestFillId
                    ? (decrementObjectId(latestFillId) || latestFillId)
                    : SUBSCRIPTIONS.HISTORY_API_OBJECT;

                entry.active = !!entry.accountId;

                const refreshFailures = await refreshSubscriptions();
                if (!subscriptions.has(accountName)) {
                    // Rollback during refreshSubscriptions — entry is gone.
                    // Abort. The server-side set_subscribe_callback was already
                    // called (side effect of refreshSubscriptions), but the
                    // local entry is no longer in the Map so handleNotice()
                    // cannot dispatch to its callbacks. The orphaned callbacks
                    // become unreachable and will be GC'd on process exit.
                    return () => {};
                }
                const entryRefreshFailure = refreshFailures.find((failure) => failure.entry === entry);
                if (entryRefreshFailure) throw entryRefreshFailure.err;
                startFillPolling();
                for (const failure of refreshFailures) {
                    scheduleReconnectRetry(failure.entry, failure.err);
                }

                // NOTE: No initial catch-up scan here.
                // The startup sync (synchronizeWithChain) handles all fills from downtime.
                // processObjects is called on reconnect (resubscribeEntry/resubscribeAll)
                // to catch fills missed during disconnect, at which point the grid is loaded.
            } catch (err) {
                // Only clean up if WE still own the entry. If a rollback already
                // deleted it from the Map during the await that threw, the
                // unsubscribe() rollback path is responsible for state — touching
                // it here would corrupt the next subscribe's accounting.
                if (subscriptions.has(accountName)) {
                    entry.callbacks.delete(callback);
                    if (entry.onError === onError) {
                        entry.onError = null;
                    }
                    if (entry.callbacks.size === 0) {
                        entry.active = false;
                        subscriptions.delete(accountName);
                        if (subscriptions.size === 0) {
                            stopFillPolling();
                            removeNoticeSubscription();
                        }
                    }
                }
                throw new Error(`Failed to register subscription callback: ${getErrorMessage(err)}`);
            }
        }

        return () => unsubscribe(accountName, callback);
    }

    async function unsubscribe(accountName: string, callback?: (fills: HistoryEntry[]) => unknown): Promise<void> {
        const entry = subscriptions.get(accountName);
        if (!entry) return;

        if (callback) {
            entry.callbacks.delete(callback);
        } else {
            entry.callbacks.clear();
        }

        if (entry.callbacks.size === 0) {
            entry.active = false;
            clearReconnectRetry(entry);
            clearChannelRetry(entry);
            const pending = pendingScans.get(entry);
            if (pending) {
                if (pending.timer) clearTimeout(pending.timer);
                pendingScans.delete(entry);
                entry._processingHistory = false;
            }
            subscriptions.delete(accountName);

            if (subscriptions.size === 0) {
                stopFillPolling();
                removeNoticeSubscription();
            }
        }
    }

    async function resubscribeAll() {
        // Drop any coalesced scans scheduled before the reconnect. They reference
        // a pre-reconnect cursor and would race with the catch-up scan below.
        for (const [sub, pending] of pendingScans) {
            if (pending.timer) clearTimeout(pending.timer);
            sub._processingHistory = false;
        }
        pendingScans.clear();

        // Refresh account data for every active entry first (before any RPC calls
        // that might race with each other on the same connection).
        const refreshTasks: Promise<void>[] = [];
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;
            refreshTasks.push(
                chainClient.db.get_full_accounts([entry.accountName], true).then((accounts) => {
                    if (accounts && accounts[0] && accounts[0][1] && accounts[0][1].account) {
                        entry.accountId = accounts[0][1].account.id ?? null;
                        entry.statisticsId = accounts[0][1].account.statistics || null;
                    }
                }).catch((err: unknown) => {
                    warnSubscription(entry, 'Failed to refresh account data', err);
                })
            );
        }
        await Promise.all(refreshTasks);

        // Centralized subscription setup — one set_subscribe_callback + re-subscribe all.
        const refreshFailures = await refreshSubscriptions();
        const refreshFailureEntries = new Set(refreshFailures.map((failure) => failure.entry));
        for (const failure of refreshFailures) {
            scheduleReconnectRetry(failure.entry, failure.err);
        }

        // A disconnect/reconnect means fills may have been missed while offline
        // (the exact crash-burst scenario). Arm gap recovery on every active entry so
        // the catch-up scans below re-cover the window below each cursor — not just
        // strictly-newer ops. resubscribeEntry does the same for the single-entry path.
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;
            entry._gapRecovery = true;
        }

        // Catch-up scan for each entry (parallelized for multi-account setups).
        const scanTasks: Promise<void>[] = [];
        for (const [, entry] of subscriptions) {
            if (!entry.active) continue;
            if (refreshFailureEntries.has(entry)) continue;
            scanTasks.push(
                processObjects(entry, [entry.accountId], { throwOnError: true })
                    .then(() => clearReconnectRetry(entry))
                    .catch((err: unknown) => {
                        warnSubscription(entry, 'Failed to resubscribe', err);
                        scheduleReconnectRetry(entry, err);
                    })
            );
        }
        await Promise.all(scanTasks);
    }

    async function onReconnect() {
        await resubscribeAll();
    }

    return {
        subscribe,
        unsubscribe,
        onReconnect,
        resubscribeAll,
        removeNoticeSubscription,
        getSubscriptions: () => new Map(subscriptions),
    };
}

export { createSubscriptionManager }

