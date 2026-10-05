'use strict';

/**
 * Shared lookback-unit conversion for the analysis commands that accept a
 * month-based range (`dexbot tv|dw|pnl --month N`).
 *
 * A "month" is the fixed 730-hour unit the chart pipeline already used, not a
 * calendar month: it keeps a `--month 3` window exactly 3 × 730 h regardless
 * of the run date, so two runs a day apart cover the same span. Centralised
 * here so the chart and PnL commands can never disagree on what `--month`
 * means.
 */

const HOURS_PER_MONTH = 730;

/** Whole months → whole hours, floored at 1 so `--month 0.x` still fetches. */
function monthsToHours(months: number): number {
    return Math.max(1, Math.round(months * HOURS_PER_MONTH));
}

export { monthsToHours };
