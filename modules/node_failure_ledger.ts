'use strict';
/**
 * modules/node_failure_ledger.ts - Shared node failure counting ledger
 *
 * Pure in-memory failure counting shared by the bot-side NodeManager
 * (modules/node_manager.ts) and the credential daemon's node health ledger
 * (modules/daemon_node_health.ts). Both processes must apply the same
 * threshold/cooldown/rate-limit rules to NODE_MANAGEMENT constants without
 * drifting — this module is the single implementation.
 *
 * The ledger only counts; callers own their side effects:
 *  - NodeManager persists blacklists (state file + shared health cache),
 *    gates health checks, and logs with its own warning dedup.
 *  - the daemon removes the node from the shared health cache and logs.
 *
 * Semantic options cover the two consumers' intentional differences:
 *  - NodeManager keeps the count that crossed the threshold (persisted via
 *    the blacklist state file) and keeps counting failures while a node is
 *    blacklisted (each failure extends the blacklist); the health-check
 *    cooldown expiry resets the entry via reset().
 *  - the daemon resets the count at blacklist, skips reports for an
 *    already-blacklisted node, and restarts counting from 0 when a previous
 *    blacklist's cooldown expired.
 */

interface FailureLedgerEntry {
    failureCount: number;
    blacklistedUntil: number;
    lastReportedAt: number;
}

interface FailureLedgerOptions {
    /** Failure count that triggers a blacklist. */
    threshold: number;
    /** Blacklist duration once the threshold is reached. */
    cooldownMs: number;
    /** Minimum gap between counted reports per node. */
    reportCooldownMs: number;
    /** Keep the count that crossed the threshold at blacklist (NodeManager); reset to 0 (daemon). */
    resetCountOnBlacklist?: boolean;
    /** Restart counting from 0 after a previous blacklist's cooldown expired (daemon). */
    resetCountAfterCooldown?: boolean;
    /** Skip counting while the node is currently blacklisted (daemon). */
    skipWhileBlacklisted?: boolean;
}

type FailureRecordOutcome = 'counted' | 'blacklisted' | 'rate-limited' | 'skipped-blacklisted';

interface FailureRecordResult {
    outcome: FailureRecordOutcome;
    /** The count as recorded (or the existing count for skipped outcomes). */
    failureCount: number;
    threshold: number;
}

interface FailureLedger {
    isBlacklisted(key: string): boolean;
    recordFailure(key: string, now?: number): FailureRecordResult;
    /** Clear a single entry (recovery: health-check success, resetNode). */
    reset(key: string): void;
    /** Seed an entry from persisted/external state (blacklist file, manual blacklist). */
    seed(key: string, entry: Pick<FailureLedgerEntry, 'failureCount' | 'blacklistedUntil'>): void;
    getState(): ReadonlyMap<string, FailureLedgerEntry>;
    clear(): void;
}

export function createFailureLedger(options: FailureLedgerOptions): FailureLedger {
    const ledger = new Map<string, FailureLedgerEntry>();
    const threshold = Math.max(1, Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 1);
    const cooldownMs = Math.max(0, Number.isFinite(Number(options.cooldownMs)) ? Number(options.cooldownMs) : 0);
    const reportCooldownMs = Math.max(0, Number.isFinite(Number(options.reportCooldownMs)) ? Number(options.reportCooldownMs) : 0);
    const resetCountOnBlacklist = options.resetCountOnBlacklist === true;
    const resetCountAfterCooldown = options.resetCountAfterCooldown === true;
    const skipWhileBlacklisted = options.skipWhileBlacklisted === true;

    function isBlacklisted(key: string): boolean {
        const entry = ledger.get(key);
        return !!entry && entry.blacklistedUntil > Date.now();
    }

    function recordFailure(key: string, now: number = Date.now()): FailureRecordResult {
        const prev = ledger.get(key);
        if (prev && prev.blacklistedUntil > now) {
            if (skipWhileBlacklisted) {
                return { outcome: 'skipped-blacklisted', failureCount: prev.failureCount, threshold };
            }
            // NodeManager semantics: failures while blacklisted still count and
            // re-blacklist (extending the cooldown).
        }
        if (prev && now - prev.lastReportedAt < reportCooldownMs) {
            return { outcome: 'rate-limited', failureCount: prev?.failureCount ?? 0, threshold };
        }

        // A blacklist whose cooldown expired restarts the count (recovery retry).
        const base = prev && prev.blacklistedUntil > 0 && prev.blacklistedUntil <= now && resetCountAfterCooldown
            ? 0
            : (prev?.failureCount ?? 0);
        const failureCount = base + 1;

        if (failureCount >= threshold) {
            ledger.set(key, {
                failureCount: resetCountOnBlacklist ? 0 : failureCount,
                blacklistedUntil: now + cooldownMs,
                lastReportedAt: now,
            });
            return { outcome: 'blacklisted', failureCount, threshold };
        }
        ledger.set(key, { failureCount, blacklistedUntil: 0, lastReportedAt: now });
        return { outcome: 'counted', failureCount, threshold };
    }

    function reset(key: string): void {
        ledger.delete(key);
    }

    function seed(key: string, entry: Pick<FailureLedgerEntry, 'failureCount' | 'blacklistedUntil'>): void {
        const prev = ledger.get(key);
        ledger.set(key, {
            failureCount: Math.max(0, Number(entry.failureCount) || 0),
            blacklistedUntil: Math.max(0, Number(entry.blacklistedUntil) || 0),
            lastReportedAt: prev?.lastReportedAt ?? 0,
        });
    }

    return {
        isBlacklisted,
        recordFailure,
        reset,
        seed,
        getState: () => new Map(ledger),
        clear: () => ledger.clear(),
    };
}
