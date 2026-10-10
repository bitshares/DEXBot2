'use strict';
/**
 * modules/daemon_node_health.ts - Credential daemon node health ledger
 *
 * Daemon-local failure ledger used by the credential daemon's broadcast
 * path (broadcastWithDeadline). Failures count toward the bot-side
 * NODE_MANAGEMENT.BLACKLIST_THRESHOLD and, at the threshold, the node is
 * blacklisted for NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS and removed from the
 * shared health cache so every process stops preferring it.
 *
 * The counting itself (threshold / cooldown / rate-limit) is delegated to the
 * shared modules/node_failure_ledger.ts — the same ledger NodeManager uses —
 * so the two processes cannot drift apart on the NODE_MANAGEMENT rules.
 *
 * Recovery is two-fold, NOT health-bound:
 *   - the in-memory ledger entry expires after BLACKLIST_COOLDOWN_MS, so the
 *     daemon itself re-admits the node (cooldown-bound) — the node is then
 *     re-preferable immediately, without waiting for a health check;
 *   - the shared health-cache exclusion is reverted when a later bot-side
 *     health check re-adds the node (health-bound). The exclusion rewrite is
 *     a best-effort unlocked read-modify-write of the shared cache: a
 *     concurrent health-check writer may overwrite it with a fresh snapshot
 *     that re-includes the node, which is the intended recovery path (the
 *     write is atomic, so a torn file cannot result — only a lost exclusion).
 *
 * Counting unit differs from the bot-side NodeManager on purpose: one ledger
 * report per exhausted node rotation (all pinned attempts), not per probe.
 * The threshold and cooldown constants are the same NODE_MANAGEMENT values;
 * the granularity is coarser because the daemon only observes failures at
 * rotation boundaries.
 *
 * The ledger is in-memory (resets on daemon restart); the health-cache
 * exclusion persists until a health check re-adds the node.
 */

import { NODE_MANAGEMENT } from './constants.js';
import { createFailureLedger } from './node_failure_ledger.js';
import { removeNodesFromHealthCache } from './node_health_cache.js';
import { getErrorMessage } from './utils/errors.js';

interface NodeHealthLedgerEntry {
    failureCount: number;
    blacklistedUntil: number;
    lastReportedAt: number;
}

interface NodeHealthLedgerOptions {
    /** Override the shared health-cache file (tests). Defaults to the shared cache. */
    healthCacheFile?: string;
    /** Override the failure threshold (tests). Defaults to NODE_MANAGEMENT.BLACKLIST_THRESHOLD. */
    threshold?: number;
    /** Override the blacklist cooldown (tests). Defaults to NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS. */
    cooldownMs?: number;
    /** Override the report rate-limit (tests). Defaults to NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS. */
    reportCooldownMs?: number;
    logger?: { warn?: Function; log?: Function; debug?: Function };
}

interface NodeHealthLedger {
    /** Whether the node is currently blacklisted (cooldown active). */
    isBlacklisted(nodeUrl: string): boolean;
    /** Report a failed node rotation; counts toward the blacklist threshold. */
    reportFailure(nodeUrl: string, errorMessage: string): void;
    /** Snapshot of the ledger (tests/inspection). */
    getState(): ReadonlyMap<string, NodeHealthLedgerEntry>;
    /** Reset all ledger state (tests). */
    clear(): void;
}

export function createNodeHealthLedger(options: NodeHealthLedgerOptions = {}): NodeHealthLedger {
    const logger = options.logger || { warn() {}, log() {}, debug() {} };
    const threshold = Number.isFinite(Number(options.threshold))
        ? Number(options.threshold)
        : Number.isFinite(Number(NODE_MANAGEMENT?.BLACKLIST_THRESHOLD))
            ? Number(NODE_MANAGEMENT.BLACKLIST_THRESHOLD)
            : 3;
    const cooldownMs = Number.isFinite(Number(options.cooldownMs))
        ? Number(options.cooldownMs)
        : Number.isFinite(Number(NODE_MANAGEMENT?.BLACKLIST_COOLDOWN_MS))
            ? Number(NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS)
            : 24 * 60 * 60 * 1000;
    const reportCooldownMs = Number.isFinite(Number(options.reportCooldownMs))
        ? Number(options.reportCooldownMs)
        : Number.isFinite(Number(NODE_MANAGEMENT?.FAILURE_REPORT_COOLDOWN_MS))
            ? Number(NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS)
            : 1000;

    const ledger = createFailureLedger({
        threshold,
        cooldownMs,
        reportCooldownMs,
        // Daemon semantics: the count resets at blacklist, reports for an
        // already-blacklisted node are skipped, and a blacklist whose cooldown
        // expired restarts the count (recovery retry).
        resetCountOnBlacklist: true,
        resetCountAfterCooldown: true,
        skipWhileBlacklisted: true,
    });

    /**
     * Remove a blacklisted node from the shared health cache so
     * orderNodesForSettings (daemon and bot processes) stops preferring it.
     * Best-effort unlocked read-modify-write: the write itself is atomic
     * (no torn file), but a concurrent health-check writer may overwrite the
     * exclusion with a fresh snapshot that re-includes the node — which is
     * the intended health-bound recovery path.
     */
    function excludeFromHealthCache(nodeUrl: string) {
        try {
            const cacheOptions = options.healthCacheFile ? { healthCacheFile: options.healthCacheFile } : {};
            const removed = removeNodesFromHealthCache(nodeUrl, cacheOptions);
            if (removed) {
                logger.log?.(`[credential-daemon] Excluded ${nodeUrl.substring(0, 40)}... from shared health cache (blacklisted)`);
            }
        } catch (err) {
            logger.warn?.(`[credential-daemon] Failed to update health cache after blacklisting ${nodeUrl}: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Report a failed node rotation. Counts toward the threshold
     * (rate-limited by reportCooldownMs); when the threshold is reached the
     * node is blacklisted for cooldownMs, logged, and removed from the shared
     * health cache so all processes stop preferring it.
     */
    function reportFailure(nodeUrl: string, errorMessage: string) {
        const result = ledger.recordFailure(nodeUrl);
        if (result.outcome === 'rate-limited') return;
        if (result.outcome === 'skipped-blacklisted') {
            const entry = ledger.getState().get(nodeUrl);
            logger.debug?.(`Node ${nodeUrl} already blacklisted until ${new Date(entry?.blacklistedUntil || 0).toISOString()}; skipping failure report`);
            return;
        }
        if (result.outcome === 'blacklisted') {
            logger.warn?.(`✗ ${nodeUrl.substring(0, 40)}... BLACKLISTED after ${result.failureCount} failures (${errorMessage})`);
            excludeFromHealthCache(nodeUrl);
        } else {
            logger.warn?.(`⚠ ${nodeUrl.substring(0, 40)}... FAILED attempt ${result.failureCount}/${result.threshold} (${errorMessage})`);
        }
    }

    return {
        isBlacklisted: (nodeUrl: string) => ledger.isBlacklisted(nodeUrl),
        reportFailure,
        getState: ledger.getState,
        clear: () => ledger.clear(),
    };
}
