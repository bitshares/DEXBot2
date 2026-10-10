'use strict';

function toIntervalLabel(intervalSeconds: number) {
    if (intervalSeconds % 86400 === 0) return `${intervalSeconds / 86400}d`;
    if (intervalSeconds % 3600 === 0) return `${intervalSeconds / 3600}h`;
    if (intervalSeconds % 60 === 0) return `${intervalSeconds / 60}m`;
    return `${intervalSeconds}s`;
}

/**
 * Filename-safe slug: lowercase, non-alphanumerics collapsed to a single
 * underscore, no leading/trailing underscores. Single home for the helper
 * previously copied into fetch_lp_data.ts, kibana_feed_source.ts,
 * fetch_book_data.ts and scripts/chart_command.ts.
 */
function slugPart(value: unknown) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

/**
 * Start of the interval bucket that contains `nowMs` (floor on the bucket
 * grid), or null when the interval or clock is unusable.
 *
 * Single home for the candle-grid arithmetic shared by the closed-candle
 * gate, the startup-sleep verdict, the aligned-boundary sleep and candle
 * selection. Keeping one implementation matters because the closed-bucket
 * gate and the startup sleep must agree on "the newest closed bucket" by
 * construction, not by two copies happening to match.
 */
function bucketStartMs(nowMs: number, intervalSeconds: number) {
    const bucketMs = Number(intervalSeconds) * 1000;
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) return null;
    const now = Number(nowMs);
    if (!Number.isFinite(now) || now <= 0) return null;
    return Math.floor(now / bucketMs) * bucketMs;
}

/**
 * Start of the newest FULLY CLOSED bucket as of `nowMs` — the bucket just
 * before the one that contains `nowMs`. Null when `bucketStartMs` cannot
 * evaluate the interval/clock.
 */
function latestClosedBucketStartMs(nowMs: number, intervalSeconds: number) {
    const currentBucketStart = bucketStartMs(nowMs, intervalSeconds);
    if (currentBucketStart === null) return null;
    return currentBucketStart - Number(intervalSeconds) * 1000;
}

/**
 * Parse a BitShares chain timestamp (e.g. `block_time`) to epoch ms.
 *
 * Chain timestamps are ISO-8601 without a trailing `Z`; `Date.parse` treats
 * them as local time, so append `Z` unless present. Single home for the helper
 * previously copied into market_adapter.ts, kibana_candles.ts,
 * kibana_feed_source.ts, scripts/diagnose-pool-history.ts and
 * scripts/chart_command.ts. Returns `NaN` for empty/unparseable input.
 */
function parseChainTimeToMs(timeStr: unknown) {
    if (!timeStr) return Number.NaN;
    const s = String(timeStr);
    return Date.parse(s.endsWith('Z') ? s : `${s}Z`);
}

export { toIntervalLabel, slugPart, bucketStartMs, latestClosedBucketStartMs, parseChainTimeToMs }

