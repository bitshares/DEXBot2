#!/usr/bin/env node
'use strict';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { getStorage } from '../../modules/storage/index.js';
import { withReadOnlyClient } from '../chain_pool.js';
const { writeJSON } = getStorage();

/**
 * DEXBOT ACCOUNT DISCOVERY
 *
 * Scans all active BitShares accounts across the last N days to find
 * which accounts are running DEXBot or DEXBot2 staggered-orders strategy.
 *
 * Pipeline:
 *   1. Kibana (parallel):
 *        Q1 — top 100 accounts by limit_order_create count
 *        Q2 — top 100 accounts by limit_order_cancel count
 *        Q3 — top 100 accounts by fill_order count
 *        Q4 — top 200 accounts by limit_order_update count (op 77, DEXBot2 fingerprint)
 *   2. Merge & pre-filter:
 *        creates ≥ MIN_CREATES  (grid analysis determines DEXBot candidacy)
 *   3. Grid analysis (parallel, batches of 5):
 *        Fetch 200 raw orders per candidate → per-session geometric spacing test
 *   4. BitShares: resolve account IDs → names (batch db.get_objects call)
 *   5. Rank by DEX score and print table.
 *        HIGH tier (80+) is split by op-77 usage:
 *          updates ≥ 1 → DEXBot2 (native limit_order_update in-place re-price)
 *          updates = 0 → DEXBot1-style (cancel-only, cancel + recreate)
 *
 * Usage:
 *   node dist/analysis/bot_usage/discover_bot_accounts.js
 *   node dist/analysis/bot_usage/discover_bot_accounts.js --days 14
 *   node dist/analysis/bot_usage/discover_bot_accounts.js --days 7 --min-creates 10 --top 50
 *   node dist/analysis/bot_usage/discover_bot_accounts.js --no-grid   (fast: counts only)
 *   node dist/analysis/bot_usage/discover_bot_accounts.js --output-json results.json
 *   node dist/analysis/bot_usage/discover_bot_accounts.js --cv-threshold 0.25
 *
 * Options:
 *   --days <n>         Lookback window in days (default: 14)
 *   --min-creates <n>  Minimum limit_order_create count (default: 20)
 *   --top <n>          Top N candidates for grid analysis (default: 30)
 *   --no-grid          Skip grid spacing analysis (fast, counts only)
 *   --output-json <f>  Export full results as JSON to <f>
 *   --cv-threshold <n> CV threshold for grid detection (default: 0.35, lower = stricter)
 *   --retries <n>      Max retry attempts per Kibana query (default: 3)
 *   --verbose          Print extra debug/diagnostic info
 *   --help, -h         Show this help
 */

import {
    kibanaSearch,
    buildOrderPriceQuery,
    buildTopSellerAccountsQuery,
    buildTopCancellerAccountsQuery,
    buildTopFilledAccountsQuery,
    buildTopUpdaterAccountsQuery,
    DEFAULT_CONFIG,
} from './kibana_bot_queries.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountCounts {
    creates: number;
    cancels: number;
    fills: number;
    updates: number;
}

interface CandidateInfo {
    id: string;
    creates: number;
    cancels: number;
    fills: number;
    updates: number;
    flavor: 'DEXBot2' | 'DEXBot1' | '';
    cancelRatio: number;
    fillRate: number;
    gridScore: number;
    impliedInc: number | null;
    maxBatch: number;
    dexScore: number;
    cv: number | null;
    name: string;
    ordersFetched: number;
    buyCount: number;
    sellCount: number;
    pairAssets: string[];
}

// ─── Configuration ────────────────────────────────────────────────────────────

// Node pool from central node management (failover-capable) instead of a
// single hardcoded WSS endpoint.
// Single retry budget lives in withRetry below (honoring --retries), so the
// client-level retry is disabled here — otherwise the two budgets would
// stack (wrapper attempts x client attempts). Same convention as the paged
// production fetchers, which pass kibanaSearchRetries: 1 and own their
// page budget.
const KIBANA_CFG  = { ...DEFAULT_CONFIG, timeout: 30000, kibanaSearchRetries: 1 };

const ASSET_PRECISION = {
    '1.3.0':    5,   // BTS
    '1.3.5537': 4,   // IOB.XRP
    '1.3.5969': 4,   // XBTSX.XRP
};
const DEFAULT_PRECISION = 8;

function getPrec(id: string): number { return ASSET_PRECISION[id as keyof typeof ASSET_PRECISION] ?? DEFAULT_PRECISION; }

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts: {
        days: number; minCreates: number; top: number; skipGrid: boolean;
        cvThreshold: number; maxRetries: number; outputJson: string | null; verbose: boolean;
    } = {
        days: 14, minCreates: 20, top: 30, skipGrid: false,
        cvThreshold: 0.35, maxRetries: 3, outputJson: null, verbose: false,
    };
    for (let i = 0; i < args.length; i++) {
        if      (args[i] === '--help'        || args[i] === '-h')     printHelpAndExit();
        else if (args[i] === '--days'         && args[i + 1]) opts.days        = parseInt(args[++i], 10);
        else if (args[i] === '--min-creates'  && args[i + 1]) opts.minCreates  = parseInt(args[++i], 10);
        else if (args[i] === '--top'          && args[i + 1]) opts.top         = parseInt(args[++i], 10);
        else if (args[i] === '--no-grid')                      opts.skipGrid    = true;
        else if (args[i] === '--cv-threshold' && args[i + 1]) opts.cvThreshold = parseFloat(args[++i]);
        else if (args[i] === '--retries'      && args[i + 1]) opts.maxRetries  = parseInt(args[++i], 10);
        else if (args[i] === '--output-json'  && args[i + 1]) opts.outputJson  = args[++i];
        else if (args[i] === '--verbose')                     opts.verbose     = true;
    }
    return opts;
}

function printHelpAndExit() {
    console.log(`\
Usage: node dist/analysis/bot_usage/discover_bot_accounts.js [options]

Scans BitShares chain activity via Kibana to identify likely DEXBot/DEXBot2
staggered-orders strategy accounts. Works in phases: discovery queries ->
pre-filter -> grid spacing analysis -> name resolution -> ranked output.

Options:
  --days <n>         Lookback window in days (default: 14)
  --min-creates <n>  Minimum limit_order_create count (default: 20)
  --top <n>          Top N candidates for grid analysis (default: 30)
  --no-grid          Skip grid spacing analysis (fast, counts only)
  --output-json <f>  Export full results as JSON to <f>
  --cv-threshold <n> CV threshold for grid detection (default: 0.35)
                     Lower = stricter grid matching.
  --retries <n>      Max retry attempts per Kibana query (default: 3)
  --verbose          Print extra debug/diagnostic info
  --help, -h         Show this help

Examples:
  node dist/analysis/bot_usage/discover_bot_accounts.js
  node dist/analysis/bot_usage/discover_bot_accounts.js --days 30 --top 50
  node dist/analysis/bot_usage/discover_bot_accounts.js --no-grid
  node dist/analysis/bot_usage/discover_bot_accounts.js --output-json results.json`);
    process.exit(0);
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt < maxRetries) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1);
                console.warn(`  [warn] ${label} attempt ${attempt}/${maxRetries} failed: ${getErrorMessage(e)}`);
                console.warn(`         retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw new Error(`${label} failed after ${maxRetries} attempts: ${getErrorMessage(e)}`);
            }
        }
    }
    throw new Error('Unreachable');
}

// ─── Grid analysis helpers (self-contained, no external import) ───────────────

interface KibanaSearchResponse {
    aggregations?: { by_account?: { buckets?: Array<{ key: string; doc_count: number }> } };
    hits?: { hits?: KibanaHit[] };
    took?: number;
}

interface KibanaHit {
    _source?: {
        operation_history?: { op_object?: { amount_to_sell?: { amount?: unknown; asset_id?: unknown }; min_to_receive?: { amount?: unknown; asset_id?: unknown } } };
        block_data?: { block_time?: unknown };
    };
    [key: string]: unknown;
}

interface GridStats {
    isGrid: boolean;
    score: number;
    count: number;
    uniqueCount?: number;
    impliedIncrementPct?: number;
    minPrice?: number;
    maxPrice?: number;
    cv?: number;
    totalOrders?: number;
    sessionCount?: number;
}

function hitPrice(hit: KibanaHit, sellPrec: number, recvPrec: number): number | null {
    const op   = hit._source?.operation_history?.op_object;
    const sell = Number(op?.amount_to_sell?.amount);
    const recv = Number(op?.min_to_receive?.amount);
    if (!Number.isFinite(sell) || !Number.isFinite(recv) || sell <= 0 || recv <= 0) return null;
    return (recv / Math.pow(10, recvPrec)) / (sell / Math.pow(10, sellPrec));
}

function spacingStats(prices: number[], cvThreshold = 0.35): GridStats {
    if (prices.length < 3) return { isGrid: false, score: 0, count: prices.length };
    const s = [...prices].sort((a, b) => a - b);
    const u = [s[0]];
    for (let i = 1; i < s.length; i++) {
        if (Math.abs((s[i] - s[i - 1]) / s[i - 1]) > 1e-5) u.push(s[i]);
    }
    if (u.length < 3) return { isGrid: false, score: 0, count: prices.length };
    const lr: number[] = [];
    for (let i = 1; i < u.length; i++) lr.push(Math.log(u[i] / u[i - 1]));
    const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
    const vari = lr.reduce((s, r) => s + (r - mean) ** 2, 0) / lr.length;
    const cv   = mean > 1e-10 ? Math.sqrt(vari) / mean : Infinity;
    const isGrid = cv < cvThreshold && u.length >= 4;
    return {
        count:               prices.length,
        uniqueCount:         u.length,
        impliedIncrementPct: (Math.exp(mean) - 1) * 100,
        minPrice: u[0], maxPrice: u[u.length - 1],
        cv, isGrid,
        score: isGrid ? Math.max(0, Math.min(100, Math.round((1 - cv) * 100))) : 0,
    };
}

/**
 * Session-aware grid spacing analysis.
 * Groups hits by 2-minute proximity, finds the best-scoring session.
 */
function analyzeGrid(hits: KibanaHit[], sellPrec: number, recvPrec: number, cvThreshold = 0.35): GridStats {
    if (!hits || hits.length < 3) return { isGrid: false, score: 0, count: hits?.length ?? 0 };
    const SESSION_GAP = 2 * 60 * 1000;

    const entries = hits.map(h => {
        const p = hitPrice(h, sellPrec, recvPrec);
        const t = h._source?.block_data?.block_time
            ? new Date(String(h._source.block_data.block_time)).getTime() : null;
        return p && t ? { p, t } : null;
    }).filter((x): x is { p: number; t: number } => x !== null).sort((a, b) => a.t - b.t);

    if (entries.length < 3) return { isGrid: false, score: 0, count: entries.length };

    const sessions: { p: number; t: number }[][] = [[entries[0]]];
    for (let i = 1; i < entries.length; i++) {
        if (entries[i].t - entries[i - 1].t > SESSION_GAP) sessions.push([]);
        sessions[sessions.length - 1].push(entries[i]);
    }

    let best: GridStats | null = null;
    for (const sess of sessions) {
        if (sess.length < 4) continue;
        const stats = spacingStats(sess.map(e => e.p), cvThreshold);
        if (!best || stats.score > best.score || (stats.score === best.score && (stats.cv ?? Infinity) < (best.cv ?? Infinity))) {
            best = stats;
        }
    }

    if (!best) best = spacingStats(entries.map(e => e.p), cvThreshold);
    return { ...best, totalOrders: entries.length, sessionCount: sessions.length };
}

function analyzeBatching(hits: KibanaHit[]) {
    if (!hits.length) return { maxBatch: 0, avgBatch: 0 };
    const counts: Record<string, number> = {};
    for (const h of hits) {
        const t = h._source?.block_data?.block_time;
        if (t) counts[String(t)] = (counts[String(t)] ?? 0) + 1;
    }
    const vals = Object.values(counts);
    return {
        maxBatch: Math.max(...vals),
        avgBatch: vals.reduce((a, b) => a + b, 0) / vals.length,
    };
}

// ─── DEXBot score ─────────────────────────────────────────────────────────────

function dexScore(creates: number, fills: number, gridScore: number, maxBatch: number): number {
    let s = 0;
    s += Math.round(gridScore * 0.4);                        // grid quality  (0–40)
    if (maxBatch >= 4)      s += 20;                         // batch size    (0–20)
    else if (maxBatch >= 2) s += 10;
    if (creates >= 50)  s += 20; else if (creates >= 20) s += 10; // volume (0–20)
    const fr = creates > 0 ? fills / creates : 0;
    if (fr >= 0.03 && fr <= 0.95) s += 20;                  // fill rate     (0–20)
    return Math.min(100, s);
}

// ─── Account resolution ───────────────────────────────────────────────────────

async function resolveNames(ids: string[]): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    try {
        // Ephemeral read-only client over the built-in node pool (shared helper).
        await withReadOnlyClient(async (client) => {
            // BitShares db.get_objects accepts an array of IDs
            const objects = await client.db('get_objects', [ids]);
            for (const obj of ((objects ?? []) as unknown[])) {
                const o = obj as { id?: string; name?: string } | null;
                if (o?.id && o?.name) map[o.id] = o.name;
            }

            // Resolve extra asset precisions while connected
            const toCheck = ['IOB.XRP', 'HONEST.MONEY', 'XBTSX.XRP', 'XBTSX.USDT', 'USD', 'CNY'];
            for (const sym of toCheck) {
                try {
                    const assets = await client.db('lookup_asset_symbols', [[sym]]);
                    const a = Array.isArray(assets) ? assets[0] : null;
                    if (a?.id && !(String(a.id) in ASSET_PRECISION)) {
                        (ASSET_PRECISION as Record<string, unknown>)[String(a.id)] = a.precision;
                    }
                } catch (_) {}
            }
        });
    } catch (e) {
        console.warn(`  [warn] Name resolution failed: ${getErrorMessage(e)}`);
    }
    return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
    const opts      = parseArgs();
    const lookbackH = opts.days * 24;

    console.log('');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log(' DEXBot Account Discovery Scan');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log(` Kibana:      https://kibana.bitshares.dev`);
    console.log(` Lookback:    ${opts.days} days`);
    console.log(` Min creates: ${opts.minCreates}`);
    console.log(` Top N:       ${opts.top} candidates for grid analysis`);
    console.log(` Grid scan:   ${opts.skipGrid ? 'disabled' : 'enabled'}`);
    console.log(` Timestamp:   ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
    console.log('');

    // ── Phase 1: Discovery queries ─────────────────────────────────────────────

    console.log('Phase 1: Querying Kibana for top active accounts...');

    const [createRes, cancelRes, fillRes, updateRes] = await Promise.all([
        withRetry(() => kibanaSearch(KIBANA_CFG, buildTopSellerAccountsQuery(lookbackH, 200, opts.minCreates)),
            'top-seller query', opts.maxRetries),
        withRetry(() => kibanaSearch(KIBANA_CFG, buildTopCancellerAccountsQuery(lookbackH, 200, 5)),
            'top-canceller query', opts.maxRetries),
        withRetry(() => kibanaSearch(KIBANA_CFG, buildTopFilledAccountsQuery(lookbackH, 200, 3)),
            'top-fills query', opts.maxRetries),
        withRetry(() => kibanaSearch(KIBANA_CFG, buildTopUpdaterAccountsQuery(lookbackH, 200, 1)),
            'top-updater query', opts.maxRetries),
    ]) as KibanaSearchResponse[];

    const createBuckets = createRes?.aggregations?.by_account?.buckets ?? [];
    const cancelBuckets = cancelRes?.aggregations?.by_account?.buckets ?? [];
    const fillBuckets   = fillRes?.aggregations?.by_account?.buckets   ?? [];
    const updateBuckets = updateRes?.aggregations?.by_account?.buckets ?? [];

    if (opts.verbose) {
        console.log(`  [verbose] createRes keys: ${Object.keys(createRes ?? {}).join(', ')}`);
        console.log(`  [verbose] createRes took: ${createRes?.took ?? '?'}ms`);
    }

    console.log(`  Creates: ${createBuckets.length} accounts with ≥${opts.minCreates} creates`);
    console.log(`  Cancels: ${cancelBuckets.length} accounts with ≥5 cancels`);
    console.log(`  Fills:   ${fillBuckets.length} accounts with ≥3 fills`);
    console.log(`  Updates: ${updateBuckets.length} accounts with ≥1 limit_order_update (op 77)`);

    if (createBuckets.length === 0) {
        console.log('');
        console.log('  No accounts found. Try a larger --days window or lower --min-creates.');
        if (opts.outputJson) {
            writeJSON(opts.outputJson, { results: [], note: 'No accounts found', opts });
            console.log(`  Wrote empty results to ${opts.outputJson}`);
        }
        return;
    }

    // ── Phase 2: Merge & pre-filter ────────────────────────────────────────────

    console.log('\nPhase 2: Merging and filtering candidates...');

    const accounts: Record<string, AccountCounts> = {};
    for (const b of createBuckets) accounts[b.key] = { creates: b.doc_count, cancels: 0, fills: 0, updates: 0 };
    for (const b of cancelBuckets) {
        if (!accounts[b.key]) accounts[b.key] = { creates: 0, cancels: 0, fills: 0, updates: 0 };
        accounts[b.key].cancels = b.doc_count;
    }
    for (const b of fillBuckets) {
        if (!accounts[b.key]) accounts[b.key] = { creates: 0, cancels: 0, fills: 0, updates: 0 };
        accounts[b.key].fills = b.doc_count;
    }
    for (const b of updateBuckets) {
        if (!accounts[b.key]) accounts[b.key] = { creates: 0, cancels: 0, fills: 0, updates: 0 };
        accounts[b.key].updates = b.doc_count;
    }

    // Pre-filter: must have creates ≥ minCreates (grid analysis determines DEXBot candidacy)
    // Flavor: any limit_order_update (op 77) in-window → DEXBot2 (native in-place
    // re-price); zero updates → DEXBot1-style (cancel-only: cancel + recreate).
    const candidates: CandidateInfo[] = (Object.entries(accounts) as [string, AccountCounts][])
        .filter(([, s]) => s.creates >= opts.minCreates)
        .map(([id, s]) => ({
            id,
            creates: s.creates,
            cancels: s.cancels,
            fills:   s.fills,
            updates: s.updates,
            flavor: (s.updates >= 1 ? 'DEXBot2' : 'DEXBot1') as 'DEXBot2' | 'DEXBot1',
            cancelRatio: s.cancels / Math.max(s.creates, 1),
            fillRate:    s.creates > 0 ? (s.fills / s.creates * 100) : 0,
        } as CandidateInfo))
        .sort((a, b) => b.creates - a.creates);

    console.log(`  Total unique accounts:   ${Object.keys(accounts).length}`);
    console.log(`  After filter:            ${candidates.length} candidates`);
    console.log(`  Will analyze top:        ${Math.min(opts.top, candidates.length)}`);

    const toAnalyze = candidates.slice(0, opts.top);

    // ── Phase 3: Grid analysis ─────────────────────────────────────────────────

    const results: CandidateInfo[] = toAnalyze.map(c => ({
        ...c,
        gridScore: 0, impliedInc: null, maxBatch: 0, dexScore: 0,
        cv: null, name: '', ordersFetched: 0, buyCount: 0, sellCount: 0, pairAssets: [],
    }));

    if (!opts.skipGrid) {
        console.log('\nPhase 3: Grid analysis (batches of 5)...');

        const BATCH = 5;
        for (let i = 0; i < results.length; i += BATCH) {
            const slice = results.slice(i, i + BATCH);
            process.stdout.write(`  [${i + 1}–${Math.min(i + BATCH, results.length)}/${results.length}] `);

            const priceResults = await Promise.all(
                slice.map(r => withRetry(
                    () => kibanaSearch(KIBANA_CFG, buildOrderPriceQuery(r.id, lookbackH, null, 200)),
                    `price-query for ${r.id}`,
                    opts.maxRetries
                ))
            ) as KibanaSearchResponse[];

            for (let j = 0; j < slice.length; j++) {
                const r    = slice[j];
                const hits = priceResults[j]?.hits?.hits ?? [];

                const buyHits  = hits.filter((h: KibanaHit) =>
                    h._source?.operation_history?.op_object?.amount_to_sell?.asset_id === '1.3.0'
                );
                const sellHits = hits.filter((h: KibanaHit) =>
                    h._source?.operation_history?.op_object?.amount_to_sell?.asset_id !== '1.3.0'
                );

                const sellAssetId = sellHits[0]
                    ?._source?.operation_history?.op_object?.amount_to_sell?.asset_id
                    ?? buyHits[0]?._source?.operation_history?.op_object?.min_to_receive?.asset_id;

                const btsPrc = getPrec('1.3.0');
                const aPrc   = getPrec(String(sellAssetId ?? ''));

                const primaryHits = buyHits.length >= sellHits.length ? buyHits : sellHits;
                const [pSell, pRecv] = buyHits.length >= sellHits.length
                    ? [btsPrc, aPrc] : [aPrc, btsPrc];

                const grid  = analyzeGrid(primaryHits, pSell, pRecv, opts.cvThreshold);
                const batch = analyzeBatching(hits);

                const pairAssets = new Set(hits.flatMap((h: KibanaHit) => {
                    const op = h._source?.operation_history?.op_object;
                    return [op?.amount_to_sell?.asset_id, op?.min_to_receive?.asset_id].filter(Boolean);
                }) as string[]);
                r.pairAssets = [...pairAssets];

                r.gridScore  = grid.score;
                r.impliedInc = grid.impliedIncrementPct ?? null;
                r.cv         = grid.cv ?? null;
                r.maxBatch   = batch.maxBatch;
                r.dexScore   = dexScore(r.creates, r.fills, grid.score, batch.maxBatch);
                r.ordersFetched = hits.length;
                r.buyCount   = buyHits.length;
                r.sellCount  = sellHits.length;

                if (opts.verbose && hits.length > 0) {
                    process.stdout.write(`\n  [verbose] ${r.id}: ${hits.length} orders (${buyHits.length} buy/${sellHits.length} sell), ` +
                        `grid=${grid.score} cv=${grid.cv?.toFixed(4) ?? '?'} sessions=${grid.sessionCount}`);
                    process.stdout.write(`\n`);
                } else {
                    process.stdout.write('.');
                }
            }
            if (!opts.verbose) console.log('');
        }
    } else {
        // Without grid: assign a simpler heuristic score
        for (const r of results) {
            const fr = r.fillRate / 100;
            r.dexScore = Math.round(Math.min(70,
                (Math.min(r.creates, 100) / 100 * 20) +
                (Math.min(r.cancelRatio, 1.5) / 1.5 * 30) +
                (fr >= 0.03 && fr <= 0.95 ? 20 : 0)
            ));
        }
    }

    // Sort by DEX score
    results.sort((a, b) => b.dexScore - a.dexScore || b.creates - a.creates);

    // ── Phase 4: Resolve account names ────────────────────────────────────────

    console.log('\nPhase 4: Resolving account names...');
    const allIds  = results.map(r => r.id);
    const nameMap = await resolveNames(allIds);
    for (const r of results) r.name = nameMap[r.id] ?? r.id;

    // ── Phase 5: Output ───────────────────────────────────────────────────────

    console.log('');
    console.log('════════════════════════════════════════════════════════════════════════════════════');
    console.log(' Discovery Results — Ranked by DEX Score');
    console.log('════════════════════════════════════════════════════════════════════════════════════');
    console.log('');

    // Print by DEX score tier. HIGH tier (80+) splits by update-order usage:
    //   DEXBot2      — broadcast limit_order_update (op 77) in-window (in-place re-price)
    //   DEXBot1-style — cancel-only, no op 77 (cancel + recreate)
    const highV2 = results.filter(r => r.dexScore >= 80 && r.updates >= 1);
    const highV1 = results.filter(r => r.dexScore >= 80 && r.updates < 1);

    // Fixed-width cells for one candidate row, shared by the HIGH groups and
    // the tier tables so the two print paths can never drift apart.
    function formatCandidateCells(r: CandidateInfo, rank: number) {
        return {
            rank: String(rank).padStart(2),
            name: r.name.padEnd(22).slice(0, 22),
            id: r.id.padEnd(14),
            creates: String(r.creates).padStart(7),
            fills: String(r.fills).padStart(6),
            cancels: String(r.cancels).padStart(7),
            fr: (r.fillRate.toFixed(1) + '%').padStart(5),
            cr: r.cancelRatio.toFixed(2).padStart(4),
            batch: String(r.maxBatch || '-').padStart(9),
            inc: (r.impliedInc != null ? r.impliedInc.toFixed(2) + '%' : 'n/a').padStart(6),
            grid: String(r.gridScore).padStart(5),
            dex: String(r.dexScore).padStart(4),
        };
    }

    const hdrHigh = ' #   Name                  ID              Creates  Fills  Cancel  Fill%  C/C   MaxBatch  Incr%  Grid  DEX  Updates';
    function printHighGroup(label: string, rows: CandidateInfo[]) {
        if (!rows.length) return;
        console.log(` ── ${label}`);
        console.log('');
        console.log(hdrHigh);
        console.log(' ' + '─'.repeat(hdrHigh.length - 1));
        for (const r of rows) {
            const c = formatCandidateCells(r, results.indexOf(r) + 1);
            console.log(` ${c.rank}  ${c.name}  ${c.id}  ${c.creates}  ${c.fills}  ${c.cancels}  ${c.fr}  ${c.cr}  ${c.batch}  ${c.inc}  ${c.grid}  ${c.dex}  ${String(r.updates).padStart(7)}`);
        }
        console.log('');
    }
    printHighGroup('HIGH confidence — DEXBot2 (80+, uses limit_order_update op 77)', highV2);
    printHighGroup('HIGH confidence — DEXBot1-style (80+, cancel-only, no op 77)', highV1);

    const tiers = [
        { label: 'MEDIUM confidence (50–79) — likely a grid bot',           min: 50, max:  80 },
        { label: 'LOW confidence (25–49) — some automation detected',       min: 25, max:  50 },
        { label: 'WEAK signal (<25) — create/cancel pattern, no grid',     min:  0, max:  25 },
    ];

    for (const tier of tiers) {
        const group = results.filter(r => r.dexScore >= tier.min && r.dexScore < tier.max);
        if (!group.length) continue;

        console.log(` ── ${tier.label}`);
        console.log('');

        const hdr = ' #   Name                  ID              Creates  Fills  Cancel  Fill%  C/C   MaxBatch  Incr%  Grid  DEX';
        console.log(hdr);
        console.log(' ' + '─'.repeat(hdr.length - 1));

        group.forEach((r) => {
            const c = formatCandidateCells(r, results.indexOf(r) + 1);
            console.log(` ${c.rank}  ${c.name}  ${c.id}  ${c.creates}  ${c.fills}  ${c.cancels}  ${c.fr}  ${c.cr}  ${c.batch}  ${c.inc}  ${c.grid}  ${c.dex}`);
        });
        console.log('');
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    const high   = highV2.length + highV1.length;
    const medium = results.filter(r => r.dexScore >= 50 && r.dexScore < 80).length;
    const low    = results.filter(r => r.dexScore >= 25 && r.dexScore < 50).length;

    console.log('════════════════════════════════════════════════════════════════════════════════════');
    console.log(` Total candidates scanned:  ${results.length}`);
    console.log(` HIGH (80+):   ${high}  accounts — DEXBot2: ${highV2.length} (op 77 updates) / DEXBot1-style: ${highV1.length} (cancel-only)`);
    console.log(` MEDIUM (50+): ${medium}  accounts — likely grid bots`);
    console.log(` LOW (25+):    ${low}  accounts — weak signal`);
    console.log('');
    console.log(' Columns:');
    console.log('   C/C = cancel/create ratio  (grid bots: ~1.0)');
    console.log('   Incr% = implied grid increment from price spacing');
    console.log('   Grid = grid quality 0-100  |  DEX = DEXBot confidence 0-100');
    console.log('   Updates = limit_order_update (op 77) count — DEXBot2 only; 0 = cancel-only (DEXBot1-style)');
    console.log('');

    // ── Export JSON ────────────────────────────────────────────────────────────

    if (opts.outputJson) {
        const exportData = results.map(r => ({
            id:          r.id,
            name:        r.name,
            flavor:      r.flavor,
            creates:     r.creates,
            fills:       r.fills,
            cancels:     r.cancels,
            updates:     r.updates,
            fillPct:     r.fillRate,
            cancelRatio: r.cancelRatio,
            maxBatch:    r.maxBatch,
            gridScore:   r.gridScore,
            impliedInc:  r.impliedInc,
            cv:          r.cv,
            dexScore:    r.dexScore,
            ordersFetched: r.ordersFetched,
            buyCount:    r.buyCount,
            sellCount:   r.sellCount,
            pairAssets:  r.pairAssets,
        }));
        writeJSON(opts.outputJson, { results: exportData, opts: { days: opts.days, minCreates: opts.minCreates, cvThreshold: opts.cvThreshold, skipGrid: opts.skipGrid, timestamp: new Date().toISOString() } });
        console.log(` Results exported to ${opts.outputJson}`);
        console.log('');
    }
}

run().then(() => process.exit(0)).catch((e: unknown) => {
    const err = e as { message?: unknown; stack?: unknown };
    console.error('\n[fatal]', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
