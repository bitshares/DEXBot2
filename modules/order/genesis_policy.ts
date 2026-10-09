/**
 * modules/order/genesis_policy.ts - Genesis (price-ladder) establishment policy
 *
 * The genesis ladder is the ONLY authoritative price for a slot
 * (docs/GRID_PRICE_INVARIANT.md, INV-GRID-004). A grid whose genesis is
 * missing is therefore not a degraded grid -- it is an undefined one: every
 * consumer that reads `priceForSlot(idx, genesis)` has no authority for a
 * slot's price (nearest-slot adoption, the materialize descriptor-price
 * fallback, reserve-edge anchoring, the `isSlotInRail` fail-open), and that is
 * precisely the state on which an off-grid price became grid evidence and got
 * re-emitted. The tolerance matcher that used to cover it has been removed:
 * E2 refuses to sync such a grid and asks for the resync that re-derives the
 * ladder.
 *
 * This module owns the single decision "can this snapshot have a ladder?",
 * used by:
 *   - `grid.loadGrid`            (E1, source choke point)
 *   - `dexbot_startup_runtime`   (E3, startup gate before the first sync)
 *   - `order/sync_engine`        (E2, defence-in-depth at the sync entry)
 *
 * See docs/GRID_PRICE_INVARIANT.md for the trigger taxonomy (T1-T4) and the
 * option analysis that produced the fail-closed policy implemented here.
 *
 * Policy (GRID_LIMITS.MISSING_GENESIS_POLICY, default 'rebuild'):
 *   'rebuild' - refuse the genesis-less snapshot and rebuild a clean ladder
 *               through the existing resync machinery (initializeGrid /
 *               recalculateGrid, which re-derive prices and reconcile
 *               update-first so only true surplus is cancelled).
 *   'halt'    - refuse to start; a human must run a manual grid reset.
 *
 * Deliberately NOT implemented (rejected in the analysis): adopting the
 * config-derived ladder despite a >50% slot mismatch. That mass-virtualizes
 * live order tracking and persists a genesis the live grid does not match --
 * Option D ("always accept") in the paper, rejected as corruption risk.
 */

import { GRID_LIMITS } from '../constants.js';
import type { GridConfig } from '../types.js';
import { isUnknownRecord } from '../types.js';
import type { GridGenesis } from './utils/math.js';
import { getErrorMessage } from '../utils/errors.js';
import type { OrderManagerLike } from '../types.js';
import {
    assertSlotPriceInvariant,
    buildGenesisFromPriceLevels,
    calculateGapSlots,
    derivePriceLevels
} from './utils/math.js';

/** Why no ladder could be attached to a snapshot (paper T2-T4). */
export const MISSING_GENESIS_REASON = {
    /** T2: the config-derived rail disagrees with >MISSING_GENESIS_MISMATCH_RATIO of the slots. */
    SLOT_MISMATCH: 'slot_mismatch',
    /** T3: startPrice/minPrice/maxPrice/incrementPercent are not finite numbers. */
    NON_FINITE_CONFIG: 'non_finite_config',
    /** T4: the migration ladder build threw. */
    MIGRATION_FAILED: 'migration_failed'
} as const;

export type MissingGenesisReason = (typeof MISSING_GENESIS_REASON)[keyof typeof MISSING_GENESIS_REASON];

export const ON_MISSING_GENESIS = {
    REBUILD: 'rebuild',
    HALT: 'halt'
} as const;

export type OnMissingGenesisPolicy = (typeof ON_MISSING_GENESIS)[keyof typeof ON_MISSING_GENESIS];

/**
 * Thrown by `loadGrid` (and the startup gate) when a snapshot carries orders
 * but no usable ladder. Carries the policy so each caller can route the same
 * fault to the right response without re-deciding it:
 *   - 'rebuild' -> caller rebuilds (startup regenerates, recovery reload
 *                  fails closed into the structural resync, price-match resume
 *                  reports "not resumed" and the caller regenerates)
 *   - 'halt'    -> caller aborts startup
 */
export class MissingGenesisError extends Error {
    public readonly reason: string;
    public readonly detail: string;
    public readonly policy: OnMissingGenesisPolicy;
    public readonly mismatchRatio: number | null;

    constructor(
        reason: string,
        detail: string,
        policy: OnMissingGenesisPolicy,
        mismatchRatio: number | null = null
    ) {
        super(
            `[GENESIS] Persisted grid has no usable price ladder (${reason}: ${detail}); ` +
            `missing-genesis policy='${policy}'`
        );
        this.name = 'MissingGenesisError';
        this.reason = reason;
        this.detail = detail;
        this.policy = policy;
        this.mismatchRatio = mismatchRatio;
    }
}

/** True for a MissingGenesisError, including across module/realm duplication. */
export function isMissingGenesisError(err: unknown): err is MissingGenesisError {
    if (err instanceof MissingGenesisError) return true;
    if (!err || typeof err !== 'object') return false;
    const candidate = err as { name?: unknown; reason?: unknown };
    return candidate.name === 'MissingGenesisError' && typeof candidate.reason === 'string';
}

/**
 * True when `genesis` is a usable ladder: a non-empty priceLevels array. The
 * hash is deliberately not required here -- a tampered hash is warned about
 * and the ladder is still used for validation (the pre-existing contract), and
 * the persisted-row schema check lives at the source (`AccountOrders.loadGenesis`).
 */
export function hasGenesisLadder(genesis: unknown): genesis is GridGenesis {
    return !!genesis && isUnknownRecord(genesis) && Array.isArray(genesis.priceLevels) && genesis.priceLevels.length > 0;
}

/**
 * Resolve the configured missing-genesis policy.
 * Unknown/absent values fall back to the default ('rebuild'); only an explicit
 * 'halt' opts into manual intervention.
 * @param {unknown} config - Bot/manager config (reads `gridLimits.MISSING_GENESIS_POLICY`).
 * @returns {OnMissingGenesisPolicy}
 */
export function resolveOnMissingGenesisPolicy(config: GridConfig | null | undefined): OnMissingGenesisPolicy {
    const raw = config?.gridLimits?.MISSING_GENESIS_POLICY ?? GRID_LIMITS.MISSING_GENESIS_POLICY;
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return normalized === ON_MISSING_GENESIS.HALT ? ON_MISSING_GENESIS.HALT : ON_MISSING_GENESIS.REBUILD;
}

/** Ratio of persisted slots above which a config-derived rail is refused. */
export function resolveMismatchRatioLimit(config: GridConfig | null | undefined): number {
    const raw = Number(config?.gridLimits?.MISSING_GENESIS_MISMATCH_RATIO);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
    return Number(GRID_LIMITS.MISSING_GENESIS_MISMATCH_RATIO);
}

/**
 * Build the migration ladder from the LIVE geometric rail
 * (startPrice/minPrice/maxPrice/incrementPercent). The geometry itself comes
 * from `derivePriceLevels` (modules/order/utils/math.ts), the same function
 * `createOrderGrid` uses, so a migrated ladder cannot drift from a fresh build
 * of the same config.
 *
 * Persisted slot prices are deliberately NOT used as the source: a truncated
 * persisted array would permanently shrink the ladder.
 * @returns {{ok: true, genesis: any} | {ok: false, reason: string, detail: string}}
 */
export function buildGenesisFromLiveRail(config: GridConfig | null | undefined): { ok: true; genesis: GridGenesis } | { ok: false; reason: string; detail: string } {
    const startPrice = Number(config?.startPrice);
    const minPrice = Number(config?.minPrice);
    const maxPrice = Number(config?.maxPrice);
    const incPct = Number(config?.incrementPercent);

    const nonFinite = ([
        ['startPrice', config?.startPrice],
        ['minPrice', config?.minPrice],
        ['maxPrice', config?.maxPrice],
        ['incrementPercent', config?.incrementPercent]
    ] as Array<[string, unknown]>).filter(([, v]) => !Number.isFinite(Number(v)))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`);

    if (nonFinite.length > 0) {
        return {
            ok: false,
            reason: MISSING_GENESIS_REASON.NON_FINITE_CONFIG,
            detail: `grid rail config is not numeric (${nonFinite.join(', ')}); ` +
                `an unresolved price mode (e.g. "pool") must be derived by initializeGrid before a ladder can be built`
        };
    }

    try {
        // Same geometry as createOrderGrid (one shared source), so the migrated
        // ladder matches what a fresh build would produce for this config.
        const priceLevels = derivePriceLevels(startPrice, minPrice, maxPrice, incPct);
        const gapSlotsForGenesis = calculateGapSlots(incPct, config?.targetSpreadPercent, config?.gridLimits);
        return { ok: true, genesis: buildGenesisFromPriceLevels(startPrice, incPct, gapSlotsForGenesis, priceLevels) };
    } catch (e) {
        return {
            ok: false,
            reason: MISSING_GENESIS_REASON.MIGRATION_FAILED,
            detail: `ladder build threw: ${getErrorMessage(e)}`
        };
    }
}

export type GenesisResolution =
    | { ok: true; genesis: GridGenesis | null; source: 'persisted' | 'in_memory' | 'migration' }
    | { ok: false; reason: string; detail: string; mismatchRatio: number | null };

/**
 * The single "can this snapshot have a ladder?" decision.
 *
 * Resolution order:
 *   1. explicit `genesisInput` (persisted snapshot row)  -> T1 path
 *   2. `managerGenesis` (an in-process rebuild)            -> adopted as-is
 *   3. migration: build from the live config rail, then CROSS-CHECK it
 *      against the persisted slots. Adopt only while the mismatch ratio stays
 *      at or below `MISSING_GENESIS_MISMATCH_RATIO` (T1); above it the config
 *      was edited since the snapshot and the derived rail is a different
 *      generation (T2) -> refused.
 *
 * Non-numeric config (T3) and a throwing build (T4) are refused too. Nothing
 * here mutates the manager or the grid -- callers decide what to do with a
 * refusal (log + throw), which is what lets the startup gate evaluate the same
 * verdict before it commits to a resume.
 *
 * @param {Object} params
 * @param {unknown} params.config - Live bot/manager config.
 * @param {unknown[]} params.grid - Persisted grid array (may be empty).
 * @param {unknown} [params.genesisInput] - Genesis supplied by the caller (snapshot row).
 * @param {unknown} [params.managerGenesis] - In-memory `manager._genesis`.
 * @param {(msg: string, level?: string) => void} [params.log] - Logger sink for the cross-check verdict.
 * @param {string} [params.validationMode] - 'log' | 'enforce', for the warning text only.
 * @returns {GenesisResolution}
 */
export function resolvePersistedGenesis({
    config,
    grid,
    genesisInput = null,
    managerGenesis = null,
    log,
    validationMode = 'log'
}: {
    config: GridConfig | null;
    grid: unknown;
    genesisInput?: unknown;
    managerGenesis?: unknown;
    log?: (msg: string, level?: string) => void;
    validationMode?: string;
}): GenesisResolution {
    const slots: unknown[] = Array.isArray(grid) ? grid : [];
    const emit = (msg: string, level: string = 'warn') => { try { log?.(msg, level); } catch { /* logging must never fail the load */ } };

    if (hasGenesisLadder(genesisInput)) {
        return { ok: true, genesis: genesisInput, source: 'persisted' };
    }
    if (hasGenesisLadder(managerGenesis)) {
        return { ok: true, genesis: managerGenesis, source: 'in_memory' };
    }
    // No orders on the snapshot: there is nothing to price-match, so a missing
    // ladder is not a fault (the fresh grid build establishes it).
    if (slots.length === 0) {
        return { ok: true, genesis: null, source: 'migration' };
    }

    const built = buildGenesisFromLiveRail(config);
    if (!built.ok) {
        // strictNullChecks:false (tests build) does not discriminate this union,
        // so name the failure shape explicitly.
        const failure = built as { reason: string; detail: string };
        emit(
            `[GENESIS] Cannot migrate the persisted grid: ${failure.detail} — ` +
            `no ladder available, refusing to load the snapshot without one`,
            'error'
        );
        return { ok: false, reason: failure.reason, detail: failure.detail, mismatchRatio: null };
    }

    // Cross-check the derived rail against the persisted slots. A user who
    // edited startPrice/min/max/increment across restarts gets a rail the live
    // grid does not match: adopting it would mass-virtualize tracking (enforce)
    // or flood the log (log) and persist a mismatched genesis.
    let mismatchCount = 0;
    for (const slot of slots) {
        try { assertSlotPriceInvariant(slot, built.genesis); } catch { mismatchCount++; }
    }
    const mismatchRatio = slots.length > 0 ? mismatchCount / slots.length : 0;
    const ratioLimit = resolveMismatchRatioLimit(config);
    if (mismatchRatio > ratioLimit) {
        emit(
            `[GENESIS] Migration: ${mismatchCount}/${slots.length} slots mismatch new-config rail ` +
            `(ratio ${mismatchRatio.toFixed(2)} > ${ratioLimit}) — config may have changed since snapshot; ` +
            `NOT adopting migration genesis (validation would ${validationMode === 'enforce' ? 'mass-virtualize' : 'be noisy'})`,
            'warn'
        );
        return {
            ok: false,
            reason: MISSING_GENESIS_REASON.SLOT_MISMATCH,
            detail: `${mismatchCount}/${slots.length} slots mismatch the config-derived rail ` +
                `(ratio ${mismatchRatio.toFixed(2)} > ${ratioLimit}) — the config was edited since the snapshot, ` +
                `so the derived rail is a different generation`,
            mismatchRatio
        };
    }

    if (mismatchCount > 0) {
        emit(
            `[GENESIS] Migration: ${mismatchCount}/${slots.length} slots mismatch new-config rail — ` +
            `will be logged${validationMode === 'enforce' ? '/virtualized' : ''} on next load`,
            'warn'
        );
    }
    return { ok: true, genesis: built.genesis, source: 'migration' };
}

/**
 * Build the fault object for a refused snapshot, recording the policy and the
 * reason on the manager for observability (the soft half of the enforcement:
 * a counter/log is what tells an operator T2-T4 ever fire in the wild).
 * @param {unknown} manager
 * @param {{reason: string, detail: string, mismatchRatio: number | null}} fault
 * @returns {MissingGenesisError}
 */
export function recordMissingGenesisFault(manager: OrderManagerLike, fault: { reason: string; detail: string; mismatchRatio: number | null }): MissingGenesisError {
    const policy = resolveOnMissingGenesisPolicy(manager?.config);
    try {
        manager._missingGenesis = {
            reason: fault.reason,
            detail: fault.detail,
            mismatchRatio: fault.mismatchRatio ?? null,
            policy,
            at: Date.now()
        };
    } catch { /* frozen/absent manager field must not mask the refusal */ }
    const guidance = policy === ON_MISSING_GENESIS.HALT
        ? 'refusing to load the snapshot — run a manual grid reset for this bot ' +
          '(or set gridLimits.MISSING_GENESIS_POLICY=rebuild to auto-rebuild instead)'
        : 'refusing to load the snapshot — the caller must rebuild a clean price ladder ' +
          'from live config before syncing';
    manager?.logger?.log?.(
        `[GENESIS] No usable price ladder for the persisted grid (${fault.reason}: ${fault.detail}); ${guidance}`,
        'error'
    );
    return new MissingGenesisError(fault.reason, fault.detail, policy, fault.mismatchRatio ?? null);
}
