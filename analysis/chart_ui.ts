'use strict';

/**
 * Shared browser-side JavaScript helpers for uPlot chart generators.
 *
 * All functions return raw JS code strings for interpolation into inline
 * `<script>` template literals. Consumers embed these alongside their own
 * chart-specific logic.
 */

const Y_AXIS_SIZE = 58;

/**
 * Return the uPlot cursor config object literal.
 *
 * @param syncKey  JS expression for the sync key. Defaults to the `SYNC_KEY`
 *                 variable that callers define; pass a literal/variable name
 *                 (e.g. `'chartGroupId'`) when the page uses another name.
 */
function makeCursorConfig(syncKey = 'SYNC_KEY'): string {
    return `{
            show: true,
            x: true,
            y: true,
            points: { show: false },
            drag: { x: false, y: false, setScale: false },
            sync: { key: ${syncKey}, setSeries: false, scales: ['x', null] },
            focus: { prox: -1 },
        }`;
}

/**
 * Return the `bindHoverState(chart)` function definition.
 */
function bindHoverStateFn(): string {
    return `function bindHoverState(chart) {
            const root = chart.root;
            root.addEventListener('mouseenter', () => root.classList.add('is-hovered'));
            root.addEventListener('mouseleave', () => root.classList.remove('is-hovered'));
        }`;
}

/**
 * Return the `fmtDate(ts)` browser-side function definition.
 */
function fmtDateFn(): string {
    return `function fmtDate(ts) {
            if (ts == null) return '-';
            const d = new Date(ts * 1000);
            return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                 + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        }`;
}

/**
 * Return the chart event wiring loop that binds mousemove, mouseleave,
 * hover-state, wheelZoom, and pan on each chart.
 *
 * @param chartsVar  JS variable name holding the charts array (e.g. `'charts'`)
 * @param updateFn   name of the legend update function (e.g. `'updateLegend'`)
 * @param fallback   expression for the mouseleave fallback index
 *                   (e.g. `'lastLiveIdx'`, `'null'`, or `'shiftChart.cursor.idx ?? data.realBarCount - 1'`)
 */
function wireChartEvents(chartsVar: string, updateFn: string, fallback: string): string {
    return `let leavePending = null;
            ${chartsVar}.forEach(chart => {
                chart.over.addEventListener('mousemove', () => {
                    if (leavePending !== null) { clearTimeout(leavePending); leavePending = null; }
                    ${updateFn}(chart.cursor.idx);
                });
                chart.over.addEventListener('mouseleave', () => {
                    leavePending = setTimeout(() => { leavePending = null; ${updateFn}(${fallback}); }, 60);
                });
                bindHoverState(chart);
                bindWheelZoom(chart);
                bindPan(chart);
            });`;
}

/**
 * Return the Ctrl+0 zoom-reset keyboard shortcut handler.
 * Consumers must define `xMin`, `xMax`, and `syncXRange` before calling this.
 */
function zoomResetScript(): string {
    return `window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === '0') syncXRange(xMin, xMax);
        });`;
}

/**
 * Return the `sizeCharts()` function definition.
 *
 * @param pairs  array of [chartVariableName, panelDomId] pairs
 *               e.g. `[['priceChart', 'price-panel'], ['kalmanChart', 'kalman-panel']]`
 */
function sizeChartsFn(pairs: Array<[string, string]>): string {
    const entries = pairs.map(([chartVar, panelId]) => `[${chartVar}, '${panelId}']`).join(', ');
    const nullCheck = pairs.map(([chartVar]) => `!${chartVar}`).join(' || ');
    return `function sizeCharts() {
            if (${nullCheck}) return;
            [${entries}].forEach(([chart, id]) => {
                const el = document.getElementById(id);
                chart.setSize({ width: el.offsetWidth, height: el.offsetHeight });
            });
        }`;
}

interface TimeLabelOptions {
    /** Separator between the date and the HH:MM part in the sub-14d branch. */
    dateTimeSep?: string;
    /** Zero-pad the day-of-month (tradingview) vs leave it bare (dynamic weight). */
    padDay?: boolean;
}

/**
 * Return a self-contained `formatTimeLabel(tsSec, spanSec)` browser helper that
 * chooses a label granularity from the visible span (year / month / day /
 * minute). Single home for the near-identical copies in
 * dynamic_weight_chart_generator and tradingview_uplot_chart_generator; the
 * options preserve each chart's exact text (bare vs padded day, comma).
 */
function formatTimeLabelFn({ dateTimeSep = ' ', padDay = false }: TimeLabelOptions = {}): string {
    const dayExpr = padDay ? 'pad2(d.getUTCDate())' : 'd.getUTCDate()';
    return `function formatTimeLabel(tsSec, spanSec) {
            const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const pad2 = (n) => String(n).padStart(2, '0');
            const d = new Date(tsSec * 1000);
            if (!Number.isFinite(spanSec)) spanSec = 0;
            if (spanSec >= 365 * 24 * 3600 * 2) return String(d.getUTCFullYear());
            if (spanSec >= 90 * 24 * 3600) return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
            if (spanSec >= 14 * 24 * 3600) return MONTHS[d.getUTCMonth()] + ' ' + ${dayExpr};
            return MONTHS[d.getUTCMonth()] + ' ' + ${dayExpr} + '${dateTimeSep}' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
        }`;
}

interface RefreshZoomOptions {
    /** JS expression for the chart whose current x-scale is preserved. */
    anchor: string;
    /** Statements that re-populate the chart data (one per chart). */
    reload: string[];
    /** JS expression for the array of charts receiving the restored x-scale. */
    charts: string;
}

/**
 * Return a `refreshChartsPreservingZoom()` browser helper: snapshot the anchor
 * chart's current x-range, re-run `reload`, then re-apply the saved range in one
 * batched `setScale` per chart. Single home for the copies in
 * dynamic_weight_chart_generator and volatility_chart_generator.
 */
function refreshChartsPreservingZoomFn({ anchor, reload, charts }: RefreshZoomOptions): string {
    return `function refreshChartsPreservingZoom() {
            const xs = ${anchor};
            const savedX = xs ? { min: Number.isFinite(xs.min) ? xs.min : xMin, max: Number.isFinite(xs.max) ? xs.max : xMax } : null;
            ${reload.join('\n            ')}
            if (savedX) {
                ${charts}.forEach((c) => c.batch(() => c.setScale('x', savedX)));
            }
        }`;
}

export { Y_AXIS_SIZE, makeCursorConfig, bindHoverStateFn, fmtDateFn, wireChartEvents, zoomResetScript, sizeChartsFn, formatTimeLabelFn, refreshChartsPreservingZoomFn }
