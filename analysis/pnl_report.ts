'use strict';

/**
 * PROFESSIONAL PnL REPORT (HTML)
 *
 * Renders the output of analysis/trade_profitability.ts (PairAnalysis +
 * realized lots + performance metrics) into a single self-contained HTML
 * report: no sibling assets, no CDN, no network — it opens from a file://
 * link on any machine.
 *
 * Centralises the report so every consumer (the `dexbot pnl` command and
 * direct `node dist/analysis/trade_profitability.js --html` runs) emits the
 * exact same layout. The type-only import from trade_profitability is erased
 * at compile time, so there is no runtime import cycle.
 */

import type { PairAnalysis, TradingMetrics } from './trade_profitability.js';
import { escapeHtml, writeChartFile } from './chart_utils.js';
import { assetSymbol } from './fills_source.js';
import { formatFundsValue } from '../modules/order/format.js';

interface PnlReportPair {
    pair: PairAnalysis;
    metrics: TradingMetrics;
}

interface PnlReportInput {
    /** The reference the user typed (bot name, account name or 1.2.x id). */
    accountRef: string;
    /** Resolved chain account id (1.2.x). */
    accountId: string;
    /** Local bot profile name, when the reference resolved to one. */
    botName?: string | null;
    start: string;
    end: string;
    matchMode: string;
    pairFilter?: string | null;
    assetFilter?: string | null;
    generatedAt?: string;
    pairs: PnlReportPair[];
}

const MAX_DETAIL_ROWS = 2000;

/**
 * Numbers go through the shared `formatFundsValue` (4 significant figures,
 * K/M compaction, significant trailing zeros kept) so the report matches
 * `dexbot order` instead of printing 8-decimal tails. Per-value precision is
 * fixed by the shared formatter, so callers pass no decimals.
 */
function num(n: number): string {
    return Number.isFinite(n) ? formatFundsValue(n) : 'NaN';
}

function signed(n: number): string {
    if (!Number.isFinite(n)) return 'NaN';
    if (n === 0) return num(0);
    return (n >= 0 ? '+' : '') + num(n);
}

function pct(n: number, decimals = 2): string {
    if (!Number.isFinite(n)) return 'NaN%';
    return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}

function ratio(n: number): string {
    if (n === Infinity) return '∞';
    if (Number.isNaN(n)) return '—';
    return n.toFixed(2);
}

/** Signed-value CSS class used for colouring. */
function pnlClass(n: number): string {
    if (!Number.isFinite(n) || n === 0) return 'muted';
    return n > 0 ? 'pos' : 'neg';
}

function asset(id: string): string {
    return escapeHtml(assetSymbol(id));
}

function statCard(label: string, value: string, sub = '', cls = ''): string {
    return `<div class="card ${cls}">
        <div class="card-label">${escapeHtml(label)}</div>
        <div class="card-value ${cls}">${value}</div>
        ${sub ? `<div class="card-sub">${sub}</div>` : ''}
    </div>`;
}

function metricRow(label: string, value: string, hint = ''): string {
    return `<div class="metric">
        <span class="metric-label">${escapeHtml(label)}</span>
        <span class="metric-value"${hint ? ` title="${escapeHtml(hint)}"` : ''}>${value}</span>
    </div>`;
}

function renderMetrics(metrics: TradingMetrics, quoteSymbol: string): string {
    const q = escapeHtml(quoteSymbol);

    if (metrics.totalLots === 0) {
        return '<p class="empty">No realized lots in the selected window — no performance metrics to compute.</p>';
    }

    const edge = [
        metricRow('Win rate', (metrics.winRate * 100).toFixed(1) + '%'),
        metricRow('Profit factor', ratio(metrics.profitFactor)),
        metricRow('Avg win / avg loss', ratio(metrics.avgWinLossRatio)),
        metricRow('Fee drag', metrics.feeDragPct > 0 ? metrics.feeDragPct.toFixed(2) + '% of gross profit' : '—'),
        metricRow('Expectancy (net)', `${num(metrics.netExpectancyBts)} ${q} / trade`),
        metricRow('Expectancy (gross)', `${num(metrics.expectancyBts)} ${q} (${pct(metrics.expectancyPct)})`),
        metricRow('Expectancy (R)', metrics.expectancyR === Infinity ? '∞' : metrics.expectancyR.toFixed(3) + 'R'),
    ].join('');

    const risk = [
        metricRow('Sharpe (annualised)', `${ratio(metrics.sharpeAnn)}${Number.isFinite(metrics.sharpeAnnSE) ? ` ± ${metrics.sharpeAnnSE.toFixed(2)}` : ''}`, `${metrics.periodLabel} bins, n=${metrics.periodCount}`),
        metricRow('Sortino (annualised)', ratio(metrics.sortinoAnn) + (metrics.sortinoAnn === Infinity ? ' (no losing periods)' : '')),
        metricRow('Projected net PnL', `${num(metrics.projectedNetPnlAnn)} ${q}/yr`, `${num(metrics.projectedNetPnlPerDay)}/day`),
        metrics.mddHadStablePeak
            ? metricRow('Max drawdown', `${num(metrics.mddAbsBts)} ${q} (${pct(metrics.mddPct)})`)
            : metricRow('Min equity', `${num(metrics.prePeakMinEquity)} ${q}`),
        metricRow('Max recovery time', metrics.maxRecoveryDays > 0 ? metrics.maxRecoveryDays.toFixed(1) + ' days' + (metrics.isOngoingRecovery ? ' (ongoing)' : '') : '—'),
        metrics.currentDrawdownDays > 0
            ? metricRow('Current drawdown', metrics.currentDrawdownDays.toFixed(1) + ' days (active)')
            : '',
    ].join('');

    const distribution = [
        metricRow('Median PnL', pct(metrics.medianPnlPct)),
        metricRow('P25 / P75', `${pct(metrics.p25PnlPct)} / ${pct(metrics.p75PnlPct)}`),
        metricRow('Best / worst trade', `${pct(metrics.bestTradePct)} / ${pct(metrics.worstTradePct)}`),
        metricRow('Median R', metrics.medianR.toFixed(2)),
        metricRow('Trades > 1R / > 2R', `${(metrics.pctRGreater1 * 100).toFixed(1)}% / ${(metrics.pctRGreater2 * 100).toFixed(1)}%`),
        metricRow('Trades < -1R', `${(metrics.pctRLessNeg1 * 100).toFixed(1)}%`),
    ].join('');

    const behavior = [
        metricRow('Max consecutive W / L', `${metrics.maxConsecWins} / ${metrics.maxConsecLosses}`),
        metricRow('Avg hold time', metrics.avgHoldHours > 0 ? metrics.avgHoldHours.toFixed(1) + ' h' : '—'),
        metricRow('Maker / taker', `${(metrics.limitOrderRatio * 100).toFixed(1)}% / ${((1 - metrics.limitOrderRatio) * 100).toFixed(1)}%`),
        metricRow('Sell orders filled', String(metrics.sellOrdersFilled)),
        metricRow('Partial fills / order', `${metrics.fillsPerOrderMean.toFixed(2)} mean, ${metrics.fillsPerOrderMedian.toFixed(1)} med, ${metrics.fillsPerOrderMax} max`),
        metricRow('One-shot orders', `${(metrics.oneShotOrderRatio * 100).toFixed(0)}%`),
        metricRow('Fills / day', metrics.fillsPerDay.toFixed(2)),
        metricRow('Avg volume / day', `${num(metrics.avgVolumePerDay)} ${q}`),
    ].join('');

    return `
    <div class="metrics-grid">
        <div class="metrics-col"><h4>Edge</h4>${edge}</div>
        <div class="metrics-col"><h4>Risk</h4>${risk}</div>
        <div class="metrics-col"><h4>Distribution</h4>${distribution}</div>
        <div class="metrics-col"><h4>Behavior &amp; activity</h4>${behavior}</div>
    </div>`;
}

function renderPairsTable(pair: PairAnalysis, quoteSymbol: string): string {
    const lots = pair.realizedPnls;
    if (lots.length === 0) return '';

    const shown = lots.slice(0, MAX_DETAIL_ROWS);
    const rows = shown.map((r, i) => {
        const net = r.pnlNet;
        const legs = `${r.entryIsMaker ? 'M' : 'T'}/${r.exitIsMaker ? 'M' : 'T'}`;
        return `<tr>
            <td class="num">${i + 1}</td>
            <td>${escapeHtml((r.entryTime || '').slice(0, 19).replace('T', ' '))}</td>
            <td>${escapeHtml((r.exitTime || '').slice(0, 19).replace('T', ' '))}</td>
            <td class="num">${num(r.amount)}</td>
            <td class="num">${num(r.buyPrice)}</td>
            <td class="num">${num(r.sellPrice)}</td>
            <td class="num ${pnlClass(r.pnl)}">${signed(r.pnl)}</td>
            <td class="num ${pnlClass(r.pnlPct)}">${pct(r.pnlPct)}</td>
            <td class="num">${num(r.marketFeeEntry + r.marketFeeExit)}</td>
            <td class="num">${num(r.feeBts)}</td>
            <td class="num ${pnlClass(net)}">${signed(net)}</td>
            <td class="num ${pnlClass(r.pnlNetPct)}">${pct(r.pnlNetPct)}</td>
            <td class="center">${legs}</td>
        </tr>`;
    }).join('');

    const truncated = lots.length > shown.length
        ? `<p class="empty">Showing the first ${shown.length.toLocaleString('en-US')} of ${lots.length.toLocaleString('en-US')} lots — use <code>--csv</code> for the full list.</p>`
        : '';

    return `
    <details class="lots">
        <summary>Realized lots (${lots.length.toLocaleString('en-US')})</summary>
        <div class="table-wrap">
            <table>
                <thead><tr>
                    <th>#</th><th>Entry time</th><th>Exit time</th>
                    <th>Amount</th><th>Buy</th><th>Sell</th>
                    <th>Gross PnL</th><th>Gross %</th>
                    <th>Mkt fee</th><th>Op fee (BTS)</th>
                    <th>Net PnL</th><th>Net %</th><th>Legs</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        ${truncated}
        <p class="empty">All PnL values are in ${escapeHtml(quoteSymbol)} unless marked BTS.</p>
    </details>`;
}

function renderPairSection(entry: PnlReportPair): string {
    const { pair, metrics } = entry;
    const base = asset(pair.baseAsset);
    const quote = asset(pair.quoteAsset);
    const quoteSymbol = assetSymbol(pair.quoteAsset);

    const avgBuy = pair.totalBuyBase > 0 ? pair.totalBuyQuote / pair.totalBuyBase : 0;
    const avgSell = pair.totalSellBase > 0 ? pair.totalSellQuote / pair.totalSellBase : 0;
    const q = escapeHtml(quoteSymbol);

    // Exactly one fee card keeps the left block a clean 2x2 when both fee
    // kinds are present. Two currencies can't be summed, so the market fee is
    // the headline and the op fee sits in the sub-line.
    const hasMarketFee = pair.totalMarketFees > 0.0001;
    const hasChainFee = pair.totalBlockchainFees > 0.0001;
    const feeCard = hasMarketFee && hasChainFee
        ? statCard('Fees', `${num(-pair.totalMarketFees)} ${q}`, `op ${num(-pair.totalBlockchainFees)} BTS`, 'neg')
        : hasChainFee
            ? statCard('Blockchain fees', `${num(-pair.totalBlockchainFees)} BTS`, '', 'neg')
            : hasMarketFee
                ? statCard('Market fees', `${num(-pair.totalMarketFees)} ${q}`, '', 'neg')
                : '';

    // Two 2x2 blocks: PnL/volume/fees, then position/activity. A 2-column grid
    // keeps each card readable instead of squeezing six across one row.
    const pnlCards = [
        statCard('Gross PnL', `${signed(pair.totalRealizedPnl)} ${q}`, '', pnlClass(pair.totalRealizedPnl)),
        statCard('Net PnL', `${signed(pair.totalRealizedPnlNet)} ${q}`, 'after market + op fees', pnlClass(pair.totalRealizedPnlNet)),
        statCard('Volume', `${num(pair.totalBuyQuote + pair.totalSellQuote)} ${q}`, `${num(pair.totalBuyQuote)} bought · ${num(pair.totalSellQuote)} sold`),
        feeCard,
    ].filter(Boolean).join('');

    const positionCards = [
        statCard('Realized lots', String(pair.realizedPnls.length), `from ${pair.buys.length} buys · ${pair.sells.length} sells`),
        statCard('Net inventory \u0394', `${num(pair.netPosition)} ${base}`, 'bought \u2212 sold in window'),
        statCard('Avg buy / sell', `${num(avgBuy)} / ${num(avgSell)}`, `in ${q} per ${base}`),
        pair.unmatchedSellBase > 0.0001 ? statCard('Unmatched sold', `${num(pair.unmatchedSellBase)} ${base}`, 'inventory predates window', 'muted') : '',
    ].filter(Boolean).join('');

    return `
    <article class="pair">
        <header class="pair-head">
            <h2>${base}<span class="slash">/</span>${quote}</h2>
        </header>
        <div class="cards-row">
            <div class="cards two-col">${pnlCards}</div>
            <div class="cards two-col">${positionCards}</div>
        </div>
        ${renderMetrics(metrics, quoteSymbol)}
        ${renderPairsTable(pair, quoteSymbol)}
    </article>`;
}

function renderTotals(pairs: PnlReportPair[]): string {
    if (pairs.length <= 1) return '';

    const groups = new Map<string, PnlReportPair[]>();
    for (const e of pairs) {
        const q = e.pair.quoteAsset;
        if (!groups.has(q)) groups.set(q, []);
        groups.get(q)!.push(e);
    }

    const cards = [...groups.entries()].map(([quoteAsset, group]) => {
        const gross = group.reduce((s, e) => s + e.pair.totalRealizedPnl, 0);
        const net = group.reduce((s, e) => s + e.pair.totalRealizedPnlNet, 0);
        const fees = group.reduce((s, e) => s + e.pair.totalMarketFees, 0);
        const lots = group.reduce((s, e) => s + e.pair.realizedPnls.length, 0);
        const quote = escapeHtml(assetSymbol(quoteAsset));
        return statCard(
            `Total (${quote}) · ${group.length} pair${group.length === 1 ? '' : 's'}`,
            `${signed(net)} ${quote}`,
            `gross ${signed(gross)} · mkt fees ${num(fees)} · ${lots} lots`,
            pnlClass(net),
        );
    }).join('');

    return `<section class="totals"><div class="cards">${cards}</div></section>`;
}

const REPORT_CSS = `
:root {
    --bg: #0d1117; --panel: #161b22; --panel-2: #1c2230; --border: #30363d;
    --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
    --pos: #3fb950; --neg: #f85149;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.5; }
code { font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace; background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
.hero { display: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; align-items: flex-end;
    padding: 28px 32px; border-bottom: 1px solid var(--border); background: linear-gradient(180deg, #161b22 0%, #0d1117 100%); }
.hero h1 { margin: 0; font-size: 24px; letter-spacing: .2px; color: #f0f6fc; }
.hero .sub { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.hero .sub b { color: var(--text); font-weight: 600; }
.generated { color: var(--muted); font-size: 12px; text-align: right; }
main { padding: 24px 32px 48px; max-width: 1500px; margin: 0 auto; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.cards-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.cards.two-col { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.card-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
.card-value { font-size: 20px; font-weight: 600; margin-top: 6px; font-variant-numeric: tabular-nums; }
.card-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
.card-value.pos, .pos { color: var(--pos); }
.card-value.neg, .neg { color: var(--neg); }
.muted, .card-value.muted { color: var(--muted); }
.totals { margin-bottom: 24px; }
.pair { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; margin-bottom: 20px; }
.pair-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.pair-head h2 { margin: 0; font-size: 18px; color: #f0f6fc; }
.pair-head .slash { color: var(--muted); margin: 0 2px; }
.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px 28px; margin: 20px 0 4px; }
.metrics-col h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .7px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.metric { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px dashed rgba(48,54,61,.5); }
.metric-label { color: var(--muted); font-size: 13px; }
.metric-value { font-variant-numeric: tabular-nums; font-size: 13px; text-align: right; }
details.lots { margin-top: 18px; }
details.lots > summary { cursor: pointer; color: var(--accent); font-weight: 600; font-size: 13px; padding: 6px 0; user-select: none; }
.table-wrap { overflow-x: auto; margin-top: 10px; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 10px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--border); }
th { position: sticky; top: 0; background: var(--panel-2); color: var(--muted); text-transform: uppercase; font-size: 10px; letter-spacing: .5px; z-index: 1; }
td:first-child, th:first-child, td:nth-child(2), th:nth-child(2), td:nth-child(3), th:nth-child(3) { text-align: left; }
td.center, th.center { text-align: center; }
tbody tr:hover { background: rgba(88,166,255,.06); }
.empty { color: var(--muted); font-size: 13px; margin: 10px 0; }
footer { border-top: 1px solid var(--border); padding: 18px 32px 40px; color: var(--muted); font-size: 12px; max-width: 1500px; margin: 0 auto; }
footer p { margin: 4px 0; }
@media (max-width: 900px) { .cards-row { grid-template-columns: 1fr; } }
@media (max-width: 640px) { main, .hero, footer { padding-left: 16px; padding-right: 16px; } .generated { text-align: left; } .cards.two-col { grid-template-columns: 1fr; } }
`;

function renderPnlReportHtml(input: PnlReportInput): string {
    const accountLabel = input.botName
        ? `${input.botName} (${input.accountId})`
        : input.accountId;
    const filters: string[] = [];
    if (input.pairFilter) filters.push(`pair ${input.pairFilter}`);
    if (input.assetFilter) filters.push(`asset ${input.assetFilter}`);
    const filterLabel = filters.length > 0 ? ` · filter: ${filters.join(', ')}` : '';
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const totalLots = input.pairs.reduce((s, e) => s + e.pair.realizedPnls.length, 0);
    const pairsBody = input.pairs.map(renderPairSection).join('\n');
    const periodLabel = `${escapeHtml(input.start.slice(0, 10))} → ${escapeHtml(input.end.slice(0, 10))}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="darkreader-lock">
<title>PnL Report · ${escapeHtml(accountLabel)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header class="hero">
    <div>
        <h1>PnL Report</h1>
        <p class="sub">Account <b>${escapeHtml(accountLabel)}</b> · ${periodLabel} · ${input.pairs.length} pair${input.pairs.length === 1 ? '' : 's'} · ${totalLots} realized lot${totalLots === 1 ? '' : 's'} · match mode <b>${escapeHtml(input.matchMode)}</b>${escapeHtml(filterLabel)}</p>
    </div>
    <div class="generated">Generated ${escapeHtml(generatedAt.replace('T', ' ').slice(0, 19))} UTC</div>
</header>
<main>
    ${renderTotals(input.pairs)}
    ${pairsBody || '<p class="empty">No classified trades in the selected window.</p>'}
</main>
<footer>
    <p>PnL uses gross fill prices. Net PnL deducts market fees (issuer + network portions, converted to the pair's quote asset) and blockchain operation fees (BTS per limit_order_create). Buy lots enter at net receives, so inventory matching reflects what the account actually held.</p>
    <p>If inventory predates the window or crosses asset pairs, realized lots may not reflect true trade economics. Non-BTS quote pairs report PnL in that quote asset, not BTS.</p>
    <p>Amounts are shown with 4 significant figures (compact K/M) for readability.</p>
    <p>Generated by DEXBot2 · <code>dexbot pnl</code></p>
</footer>
</body>
</html>`;
}

/** Render + atomically write the report; returns the resolved file path. */
function writePnlReport(input: PnlReportInput, outputPath: string): string {
    writeChartFile(outputPath, renderPnlReportHtml(input));
    return outputPath;
}

export { renderPnlReportHtml, writePnlReport };
export type { PnlReportInput, PnlReportPair };
