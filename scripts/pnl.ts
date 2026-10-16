#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   dexbot pnl <bot|account|1.2.x> [--month N] [--pair BASE/QUOTE] [--report <file>]
 *
 * Thin entry for the PnL analyzer (analysis/trade_profitability.ts) in HTML
 * mode. The reference is resolved against local bot profiles first, then the
 * chain; the account's fills for the requested window are analyzed and written
 * as a self-contained HTML report. Terminal tables remain available by running
 * the analyzer directly (node dist/analysis/trade_profitability.js); --json /
 * --csv exports pass straight through.
 */

import { pathToFileURL } from 'node:url';
import { getErrorMessage } from '../modules/utils/errors.js';
import { run } from '../analysis/trade_profitability.js';

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    const args = process.argv.slice(2);
    // HTML is this command's primary output, but only once an account/target is
    // present: with no positional argument the analyzer should print its usage
    // instead of treating the injected flag as the account. Leave --help/-h and
    // explicit --html/--report untouched so their own handling wins.
    // Append (never prepend) the injected flag: the analyzer treats argv[0] as
    // the account/target positional, so a leading flag would be read as the
    // account name (`dexbot pnl <account-name>` would become `--html <account-name>`).
    const hasTarget = args.some(a => !a.startsWith('-'));
    const ownsOutput = args.includes('--html') || args.includes('--report') || args.includes('--help') || args.includes('-h');
    if (hasTarget && !ownsOutput) args.push('--html');
    run(args)
        .then(() => process.exit(0))
        .catch((err: unknown) => {
            console.error(`[pnl] Error: ${getErrorMessage(err)}`);
            if (process.env.DEBUG) console.error(err);
            process.exit(1);
        });
}
