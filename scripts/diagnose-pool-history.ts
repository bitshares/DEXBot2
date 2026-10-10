#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

'use strict';

/**
 * Diagnostic: Inspect raw BitShares pool history API responses for pool 1.19.133.
 *
 * Usage: node dist/scripts/diagnose-pool-history.js [--pool <id>] [--limit <n>] [--hours <n>] [--maxPages <n>]
 */

const { BitShares, waitForConnected } = require('../modules/bitshares_client');
const { getErrorMessage } = require('../modules/utils/errors');
const { parseChainTimeToMs } = require('../market_adapter/interval_utils');

const POOL_ID = process.argv.includes('--pool')
    ? process.argv[process.argv.indexOf('--pool') + 1]
    : '1.19.133';

const LIMIT = process.argv.includes('--limit')
    ? Number(process.argv[process.argv.indexOf('--limit') + 1])
    : 10;

const HOURS = process.argv.includes('--hours')
    ? Number(process.argv[process.argv.indexOf('--hours') + 1])
    : 24;

const MAX_PAGES = process.argv.includes('--maxPages')
    ? Number(process.argv[process.argv.indexOf('--maxPages') + 1])
    : 20;

const LP_OP_TYPE = 63;

interface HistoryRow {
    sequence?: unknown;
    time?: unknown;
    op_type?: unknown;
    op?: { result?: unknown; op?: unknown; block_time?: unknown };
    [key: string]: unknown;
}

function fmt(obj: unknown): string {
    try { return JSON.stringify(obj); } catch (_) { return String(obj); }
}

function extractReceived(row: unknown) {
    const r = row as HistoryRow | null | undefined;
    const resultPayload = Array.isArray(r?.op?.result) ? (r.op.result as unknown[])[1] : null;
    const rp = resultPayload as { received?: unknown } | null;
    return Array.isArray(rp?.received)
        ? (rp.received as unknown[])[0]
        : (rp?.received || null);
}

function rowHasTradePayload(row: unknown): boolean {
    const r = row as HistoryRow | null | undefined;
    const opPayload = Array.isArray(r?.op?.op) ? (r.op.op as unknown[])[1] : null;
    return !!((opPayload as { amount_to_sell?: unknown } | null)?.amount_to_sell && extractReceived(row));
}

async function collectRecentPoolHistory(poolId: string, sinceMs: number, limit: number, maxPages: number) {
    const rows: HistoryRow[] = [];
    const seenSequences = new Set<number>();
    let pages = 0;
    let startSeq: number | null = null;
    let hitOld = false;

    while (pages < maxPages) {
        const page: unknown[] = startSeq == null
            ? await BitShares.history.get_liquidity_pool_history(poolId, null, null, limit, LP_OP_TYPE)
            : await BitShares.history.get_liquidity_pool_history_by_sequence(poolId, startSeq, null, limit, LP_OP_TYPE);

        if (!Array.isArray(page) || page.length === 0) break;
        pages++;

        for (const raw of page) {
            const row = raw as HistoryRow;
            const seq = Number(row?.sequence);
            if (Number.isFinite(seq)) {
                if (seenSequences.has(seq)) continue;
                seenSequences.add(seq);
            }

            const tsMs = parseChainTimeToMs(row?.time || row?.op?.block_time);
            if (!Number.isFinite(tsMs)) continue;
            if (tsMs < sinceMs) {
                hitOld = true;
                break;
            }
            rows.push(row);
        }

        const last = page[page.length - 1] as HistoryRow | undefined;
        const lastSeq = Number(last?.sequence);
        if (!Number.isFinite(lastSeq) || lastSeq <= 1 || hitOld) break;
        startSeq = lastSeq - 1;
    }

    rows.sort((a, b) => parseChainTimeToMs(a.time) - parseChainTimeToMs(b.time));
    return { rows, pages, hitOld, exhausted: pages >= maxPages && !hitOld };
}

function summarizeRows(rows: HistoryRow[]) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return {
            count: 0,
            validTrades: 0,
            firstTime: null,
            lastTime: null,
            byHour: [],
        };
    }

    const byHourMap = new Map<string, number>();
    let validTrades = 0;
    for (const raw of rows) {
        const row = raw as HistoryRow;
        if (rowHasTradePayload(row)) validTrades++;
        const tsMs = parseChainTimeToMs(row?.time || row?.op?.block_time);
        if (!Number.isFinite(tsMs)) continue;
        const hour = new Date(Math.floor(tsMs / 3600000) * 3600000).toISOString();
        byHourMap.set(hour, (byHourMap.get(hour) || 0) + 1);
    }

    return {
        count: rows.length,
        validTrades,
        firstTime: rows[0]?.time || null,
        lastTime: rows[rows.length - 1]?.time || null,
        byHour: [...byHourMap.entries()],
    };
}

function inspectRow(row: HistoryRow | null | undefined, index: number) {
    if (!row) {
        console.log(`  [${index}] NULL/undefined row`);
        return;
    }
    console.log(`\n  [${index}] ──────────────────────────────────────`);
    console.log(`    sequence: ${row.sequence}`);
    console.log(`    time:     ${row.time}`);
    console.log(`    op_type:  ${(row.op?.op as unknown[] | undefined)?.[0] || row.op_type || 'n/a'}`);

    if (Array.isArray(row.op?.op)) {
        const opPayload = (row.op.op as unknown[])[1];
        console.log(`    op.payload: ${fmt(opPayload)}`);
    } else if (row.op?.op) {
        console.log(`    op.op format: ${typeof row.op.op} => ${fmt(row.op.op)}`);
    } else {
        console.log('    op.op:  MISSING');
    }

    if (Array.isArray(row.op?.result)) {
        const resultPayload = (row.op.result as unknown[])[1];
        console.log(`    op.result: ${fmt(resultPayload)}`);
    } else if (row.op?.result) {
        console.log(`    op.result format: ${typeof row.op.result} => ${fmt(row.op.result)}`);
    } else {
        console.log('    op.result: MISSING');
    }

    // Full row dump (compact)
    console.log(`    FULL: ${fmt(row).slice(0, 500)}`);
}

async function main() {
    console.log('══════════════════════════════════════════════');
    console.log(` Pool History Diagnostic — pool ${POOL_ID}`);
    console.log(` Limit: ${LIMIT} rows per call`);
    console.log(` Paged summary window: last ${HOURS}h, maxPages=${MAX_PAGES}`);
    console.log('══════════════════════════════════════════════');

    const start = Date.now();
    console.log('\nConnecting to BitShares...');
    await waitForConnected(30000);
    console.log(`Connected (${Date.now() - start}ms)`);

    // ── Test 1: get_liquidity_pool_history (with op_type filter) ─────
    console.log(`\n\n═══ TEST 1: get_liquidity_pool_history(poolId, null, null, ${LIMIT}, 63) ═══`);
    try {
        const rows = await BitShares.history.get_liquidity_pool_history(
            POOL_ID, null, null, LIMIT, LP_OP_TYPE
        );
        console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
        if (Array.isArray(rows)) {
            rows.slice(0, 5).forEach((r, i) => inspectRow(r, i));
        } else {
            console.log(`  Raw: ${fmt(rows).slice(0, 500)}`);
        }
    } catch (err) {
        console.log(`ERROR: ${getErrorMessage(err)}`);
    }

    // ── Test 2: get_liquidity_pool_history (without op_type filter) ──
    console.log(`\n\n═══ TEST 2: get_liquidity_pool_history(poolId, null, null, ${LIMIT}) — no op_type ═══`);
    try {
        const rows = await BitShares.history.get_liquidity_pool_history(
            POOL_ID, null, null, LIMIT
        );
        console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
        if (Array.isArray(rows)) {
            rows.slice(0, 5).forEach((r, i) => inspectRow(r, i));
        } else {
            console.log(`  Raw: ${fmt(rows).slice(0, 500)}`);
        }
    } catch (err) {
        console.log(`ERROR: ${getErrorMessage(err)}`);
    }

    // ── Test 3: Try reversed args order (if applicable) ───────────────
    console.log(`\n\n═══ TEST 3: get_liquidity_pool_history with different arg combos ═══`);
    // Some APIs expect different parameter order
    try {
        // Try the method signature lookup
        const historyApis = Object.keys(BitShares.history || {})
            .filter(k => typeof BitShares.history[k] === 'function');
        console.log(`Available BitShares.history methods:`);
        historyApis.forEach(m => console.log(`  - ${m}`));
    } catch (err) {
        console.log(`Could not list methods: ${getErrorMessage(err)}`);
    }

    // ── Test 4: Try get_account_history for pool account ───────────
    console.log(`\n\n═══ TEST 4: get_account_history_by_operations for pool account ═══`);
    try {
        // Pool "account" is 1.19.133 — try account history API
        if (typeof BitShares.history.get_account_history_by_operations === 'function') {
            const rows = await BitShares.history.get_account_history_by_operations(
                POOL_ID, [LP_OP_TYPE], '1.19.0', '1.19.999', LIMIT
            );
            console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
            if (Array.isArray(rows)) {
                rows.slice(0, 3).forEach((r, i) => inspectRow(r, i));
            }
        } else {
            console.log('get_account_history_by_operations NOT available');
        }
    } catch (err) {
        console.log(`ERROR: ${getErrorMessage(err)}`);
    }

    // ── Test 5: Try get_relative_account_history ─────────────────
    console.log(`\n\n═══ TEST 5: get_relative_account_history ═══`);
    try {
        if (typeof BitShares.history.get_relative_account_history === 'function') {
            const rows = await BitShares.history.get_relative_account_history(
                POOL_ID, 0, LIMIT, 0
            );
            console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
            if (Array.isArray(rows)) {
                rows.slice(0, 3).forEach((r, i) => inspectRow(r, i));
            }
        } else {
            console.log('get_relative_account_history NOT available');
        }
    } catch (err) {
        console.log(`ERROR: ${getErrorMessage(err)}`);
    }

    // ── Test 6: Last 24h of trades — try to query recent only ─────
    console.log(`\n\n═══ TEST 6: Last 100 results with larger limit ═══`);
    try {
        const rows = await BitShares.history.get_liquidity_pool_history(
            POOL_ID, null, null, 100, LP_OP_TYPE
        );
        console.log(`Result: ${Array.isArray(rows) ? `Array[${rows.length}]` : typeof rows}`);
        if (Array.isArray(rows) && rows.length > 0) {
            // Show first, last, and total count
            console.log(`  First row time: ${rows[0]?.time || 'n/a'}`);
            console.log(`  Last row time:  ${rows[rows.length - 1]?.time || 'n/a'}`);
            // Check how many have valid op data
            let withSell = 0, withReceived = 0;
            for (const r of rows) {
                const opPayload = Array.isArray(r?.op?.op) ? r.op.op[1] : null;
                if (opPayload?.amount_to_sell) withSell++;
                const resultPayload = Array.isArray(r?.op?.result) ? r.op.result[1] : null;
                const received = Array.isArray(resultPayload?.received)
                    ? resultPayload.received[0]
                    : (resultPayload?.received || null);
                if (received) withReceived++;
            }
            console.log(`  Rows with amount_to_sell: ${withSell}`);
            console.log(`  Rows with received:      ${withReceived}`);
        }
    } catch (err) {
        console.log(`ERROR: ${getErrorMessage(err)}`);
    }

    // ── Test 7: Paged recent summary ──────────────────────────────
    console.log(`\n\n═══ TEST 7: Paged LP history summary, last ${HOURS}h ═══`);
    try {
        const sinceMs = Date.now() - (HOURS * 3600 * 1000);
        const collected = await collectRecentPoolHistory(POOL_ID, sinceMs, Math.min(101, LIMIT), MAX_PAGES);
        const summary = summarizeRows(collected.rows);
        console.log(`  Pages fetched:     ${collected.pages}`);
        console.log(`  Reached ${HOURS}h boundary: ${collected.hitOld ? 'yes' : 'no'}`);
        console.log(`  Exhausted maxPages: ${collected.exhausted ? 'yes' : 'no'}`);
        console.log(`  Rows/trades:       ${summary.count}`);
        console.log(`  Valid trade rows:  ${summary.validTrades}`);
        console.log(`  Timeframe:         ${summary.firstTime || 'n/a'} → ${summary.lastTime || 'n/a'}`);
        if (summary.byHour.length > 0) {
            console.log('  Trades by hour:');
            for (const [hour, count] of summary.byHour.slice(-Math.min(summary.byHour.length, 30))) {
                console.log(`    ${hour}: ${count}`);
            }
        }
    } catch (err) {
        console.log(`ERROR: ${getErrorMessage(err)}`);
    }

    console.log('\n══════════════════════════════════════════════');
    console.log('Diagnostic complete.');
    console.log('══════════════════════════════════════════════');
    if (typeof BitShares.disconnect === 'function') {
        BitShares.disconnect();
    }
}

main().catch(err => {
    console.error(`Fatal: ${getErrorMessage(err)}`);
    process.exit(1);
});
export {};
