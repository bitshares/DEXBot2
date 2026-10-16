/**
 * Validation test for the fill-gap-recovery fix in modules/bitshares-native/subscriptions.ts.
 *
 * Reproduces the live bug: a subscription notice delivers a fill whose op id is
 * higher than several other fills that were dropped from the same notice batch.
 * The cursor jumped past them, leaving a gap BELOW the cursor.
 *
 * Two things are validated (both were regressions in earlier drafts):
 *   1. The dropped fills below the cursor ARE recovered by the lookback scan.
 *   2. The cursor advances to the NEWEST op in the window (e.g. 1.11.6002), NOT
 *      to a gap entry — otherwise processObjects would re-scan the same window
 *      forever (infinite loop). The merged history is sorted before the cursor
 *      is taken from history[last].
 *
 * Run with: npx tsx tests/test_fill_gap_recovery.ts  (also via `npm test` as dist/tests/test_fill_gap_recovery.js)
 */
const { createSubscriptionManager } = require('../modules/bitshares-native/subscriptions');

const OP_FILL_ORDER = 4;
const ACCOUNT = '1.2.999';

function parseInst(id: string): number {
    return Number(id.split('.')[2]);
}

function makeOp(id: string, isFill: boolean) {
    if (isFill) {
        return {
            id,
            block_num: 1,
            op: [OP_FILL_ORDER, {
                account_id: ACCOUNT,
                pays: { amount: 1, asset_id: '1.3.0' },
                receives: { amount: 1, asset_id: '1.3.1' },
            }],
        };
    }
    // non-fill operation (e.g. transfer / limit_order_create)
    return { id, block_num: 1, op: [0, { account_id: ACCOUNT }] };
}

// Master history. The live crash burst produced fills 1.11.5095..5099 (DROPPED
// from the notice) and 1.11.5100/5500/6002 (new fills above the stale cursor).
const ops = [
    makeOp('1.11.5001', false),
    makeOp('1.11.5095', true),
    makeOp('1.11.5096', true),
    makeOp('1.11.5097', true),
    makeOp('1.11.5098', true),
    makeOp('1.11.5099', true),
    makeOp('1.11.5100', true),
    makeOp('1.11.5500', true),
    makeOp('1.11.6002', true),
];

// Mimic bitshares-core get_account_history(account, stop, limit, start):
// returns ops strictly greater than `stop` and <= `start`, newest-first, capped.
function getAccountHistory(_accountId: string, stop: string, limit: number, start: string) {
    const stopInst = parseInst(stop);
    const startInst = start === '1.11.0' ? Infinity : parseInst(start);
    return ops
        .filter((o) => {
            const i = parseInst(o.id);
            return i > stopInst && i <= startInst;
        })
        .sort((a, b) => parseInst(b.id) - parseInst(a.id))
        .slice(0, limit);
}

let capturedHandler: ((params: any) => void) | null = null;

const mockChain: any = {
    db: {
        get_full_accounts: async (_ref: any, _subscribe: boolean) => [
            ['account-name', { account: { id: ACCOUNT, statistics: ACCOUNT } }],
        ],
        call: async (_method: string, _args: any) => undefined,
    },
    history: { getAccountHistory },
    getApiLimitGetAccountHistory: () => 100000,
    transport: {
        addMessageHandler: (fn: any) => { capturedHandler = fn; },
    },
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const mgr = createSubscriptionManager(mockChain, { noticeCoalesceMs: 0 });
    const delivered: string[] = [];
    const seen = new Set<string>();

    await mgr.subscribe('account-name', (fills: any[]) => {
        for (const f of fills) {
            if (!seen.has(f.id)) {
                seen.add(f.id);
                delivered.push(f.id);
            }
        }
    });

    if (!capturedHandler) throw new Error('transport.addMessageHandler was not called — cannot drive handleNotice');
    const handler = capturedHandler!;

    // Simulate a bot that had only synced up to 1.11.5000 before the crash burst.
    // (subscribe primes from chain head, so override to the stale value.)
    const sub = mgr.getSubscriptions().get('account-name');
    if (!sub) throw new Error('subscription entry missing after subscribe');
    sub.lastDeliveredHistoryId = '1.11.5000';

    // 1) Live notice delivers ONLY fill@6002 (the 5095..5099 gap + 5100/5500 were
    //    dropped from this notice). Cursor should jump 5000 -> 6002 and arm recovery.
    //    The eager gap-recovery timer scheduled in handleNotice must recover the
    //    gap without requiring a second no-fill notice or the 60s poll.
    handler([1, [makeOp('1.11.6002', true)]]);

    // Wait for the eager gap-recovery coalesce (NOTICE_COALESCE_MS 250ms) + async dispatch.
    await delay(50);

    const gotGap = ['1.11.5095', '1.11.5096', '1.11.5097', '1.11.5098', '1.11.5099']
        .every((id) => delivered.includes(id));
    const gotTop = delivered.includes('1.11.6002');
    const finalCursor = sub.lastDeliveredHistoryId;
    const cursorCorrect = finalCursor === '1.11.6002';

    console.log('Delivered fill op ids:', delivered.sort((a, b) => parseInst(a) - parseInst(b)).join(', '));
    console.log('Recovered dropped fills 5095..5099:', gotGap);
    console.log('Delivered top fill 6002:', gotTop);
    console.log('Final cursor:', finalCursor, '(must be 1.11.6002, the newest op — not a gap entry)');

    mgr.unsubscribe('account-name');

    if (gotGap && gotTop && cursorCorrect) {
        console.log('PASS: gap recovered AND cursor advanced to newest op (no re-scan loop).');
        process.exit(0);
    } else {
        console.error('FAIL: gap/cursor assertions not satisfied.');
        process.exit(1);
    }
}

main().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
