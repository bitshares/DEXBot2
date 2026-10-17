// Browser-level regression guard for generated DEXBot chart pages, built
// around the `dexbot tv` TradingView exporter. It runs under the Playwright
// test runner against a real generated page, so it exercises the actual canvas
// draw hooks rather than a Node reimplementation.
//
// What it pins (see commit "clip TV range-band draw hook to visible bars"):
//   * The chart page loads without console or page errors and its uPlot
//     instances initialize.
//   * The TV range-band draw hook (`drawRangeBand`) only walks the visible
//     index window, so its per-redraw canvas work scales with the viewport
//     instead of the total series length. Measured deterministically by
//     counting `CanvasRenderingContext2D.lineTo` calls (no wall-clock timing).
//   * The band still spans the viewport when zoomed in (clipping did not chop
//     it short of the edges) by diffing canvas pixels band-on vs band-off with
//     a pinned y-range.
//
// By default it generates a synthetic TV page from the built generator. Point
// it at any already-generated chart HTML instead:
//
//   TV_CHART_HTML=analysis/charts/<file>.html npm run test:playwright
//
// The uPlot interception below is generic (every generator inlines the same
// vendored runtime), so the load test works for any generated chart. The
// band-specific assertions require the TV Range toggle and are skipped for
// pages that lack it.
//
// The chart script is wrapped in an IIFE, so the uPlot instances are not on
// `window`. A page init-script intercepts the global `uPlot` assignment and
// records every constructed instance in `window.__charts`; the multi-series
// chart is also tagged as `window.__mainChart` so tests never depend on
// construction order.
//
// Run with the globally installed Playwright (browsers already cached):
//   NODE_PATH="$(npm root -g)" npx --no-install playwright test \
//     --config tests/playwright/playwright.config.mjs
// or `npm run test:playwright`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The repo's node_modules has no playwright (it is a dev-only, global install
// here). CJS resolution honors NODE_PATH, so resolve the global package and
// import it by path rather than letting the ESM resolver stop at the empty
// local node_modules.
const require = createRequire(import.meta.url);
const playwrightDir = path.dirname(require.resolve('playwright/package.json'));
const { test, expect } = await import(pathToFileURL(path.join(playwrightDir, 'test.mjs')).href);

const N_BARS = 4000;
const ZOOM_BARS = 200;

// Optional escape hatch: test an already-generated page instead of a synthetic
// one. Relative paths resolve against the repo root (Playwright's cwd).
const EXTERNAL_HTML = process.env.TV_CHART_HTML
    ? path.resolve(process.cwd(), process.env.TV_CHART_HTML)
    : null;

const SRC_FILE = new URL('../../analysis/tradingview/tradingview_uplot_chart_generator.ts', import.meta.url);
const DIST_FILE = new URL('../../dist/analysis/tradingview/tradingview_uplot_chart_generator.js', import.meta.url);

// Guard against testing stale compiled output. tsc is incremental and does not
// re-emit a file whose content is unchanged, so its mtime is not a reliable
// "build ran" stamp (a `git checkout` or `touch` would fail a hard check). Warn
// instead of throwing, and still hard-fail when the output is missing.
function warnIfDistStale() {
    const distPath = fileURLToPath(DIST_FILE);
    if (!fs.existsSync(distPath)) {
        throw new Error(`Missing ${distPath}. Run \`npm run build\` (or \`npm run test:playwright\`) first.`);
    }
    const srcMtime = fs.statSync(fileURLToPath(SRC_FILE)).mtimeMs;
    if (fs.statSync(distPath).mtimeMs < srcMtime) {
        console.warn('[tv_chart_perf] dist/ looks older than the TradingView chart source '
            + '(tsc is incremental, so `npm run build` may not re-emit an unchanged file). '
            + 'Confirm you are not testing stale chart code.');
    }
}

let fileUrl = null;
let synthetic = true;
let hasRangeToggle = false;
let tmpDir = null;

// Instrument the page before any chart script runs: capture uPlot instances
// and count canvas line segments drawn per redraw. Generic across generators.
async function installInstrumentation(page) {
    await page.addInitScript(() => {
        window.__charts = [];
        let real = null;
        Object.defineProperty(window, 'uPlot', {
            configurable: true,
            get() { return real; },
            set(value) {
                real = new Proxy(value, {
                    construct(target, args) {
                        const instance = new target(...args);
                        window.__charts.push(instance);
                        // The multi-series chart is the main one; tag it so
                        // tests do not have to assume construction order.
                        if (Array.isArray(instance.series)
                            && (!window.__mainChart || instance.series.length > window.__mainChart.series.length)) {
                            window.__mainChart = instance;
                        }
                        return instance;
                    },
                });
            },
        });
        window.__counts = { ctxLineTo: 0 };
        const orig = CanvasRenderingContext2D.prototype.lineTo;
        CanvasRenderingContext2D.prototype.lineTo = function (...args) {
            window.__counts.ctxLineTo++;
            return orig.apply(this, args);
        };
    });
}

function makeCandles(n) {
    const out = [];
    const startMs = Date.UTC(2026, 0, 1);
    let price = 0.1;
    let seed = 42;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    for (let i = 0; i < n; i++) {
        const open = price;
        const close = Math.max(0.001, open * (1 + (rand() - 0.5) * 0.004));
        const high = Math.max(open, close) * (1 + rand() * 0.002);
        const low = Math.min(open, close) * (1 - rand() * 0.002);
        out.push([startMs + i * 3600 * 1000, open, high, low, close, 100 + rand() * 50]);
        price = close;
    }
    return out;
}

async function loadChartPage(page) {
    await installInstrumentation(page);
    await page.goto(fileUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__charts && window.__charts.length >= 1, null, { timeout: 20000 });
    // Let the initial autofit / stat-panel rAF chain settle.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Toggle the Range band through the real checkbox handler (so the autofit and
// preserveView paths run exactly as a user click would). TV-only.
async function setRangeBand(page, on) {
    await page.evaluate((next) => {
        const el = document.getElementById('range-toggle');
        if (el.checked !== next) {
            el.checked = next;
            el.dispatchEvent(new Event('change'));
        }
    }, on);
    await page.waitForTimeout(300);
}

// Set the x window and wait for the redraw it schedules. Returns the applied
// scale so a caller can assert the chart actually moved.
async function setXWindow(page, kind, barsOrTotal) {
    return page.evaluate(async ({ kind, barsOrTotal }) => {
        const chart = window.__mainChart;
        const xs = chart.data[0];
        const zoomBars = Math.min(barsOrTotal, xs.length - 1);
        const range = kind === 'zoomed'
            ? { min: xs[xs.length - zoomBars], max: xs[xs.length - 1] }
            : { min: xs[0], max: xs[xs.length - 1] };
        chart.batch(() => chart.setScale('x', range));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return { min: chart.scales.x.min, max: chart.scales.x.max };
    }, { kind, barsOrTotal });
}

// Count ctx.lineTo calls for one redraw of the given x window. The counter is
// reset immediately before setScale; the two rAFs ensure the scheduled redraw
// and the y-refit have both run before reading.
async function lineToCount(page, kind, barsOrTotal) {
    return page.evaluate(async ({ kind, barsOrTotal }) => {
        const chart = window.__mainChart;
        const xs = chart.data[0];
        const zoomBars = Math.min(barsOrTotal, xs.length - 1);
        const range = kind === 'zoomed'
            ? { min: xs[xs.length - zoomBars], max: xs[xs.length - 1] }
            : { min: xs[0], max: xs[xs.length - 1] };
        window.__counts.ctxLineTo = 0;
        chart.batch(() => chart.setScale('x', range));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return window.__counts.ctxLineTo;
    }, { kind, barsOrTotal });
}

test.beforeAll(async () => {
    let html;
    if (EXTERNAL_HTML) {
        if (!fs.existsSync(EXTERNAL_HTML)) {
            throw new Error(`TV_CHART_HTML not found: ${EXTERNAL_HTML}`);
        }
        synthetic = false;
        html = fs.readFileSync(EXTERNAL_HTML, 'utf8');
        fileUrl = pathToFileURL(EXTERNAL_HTML).href;
    } else {
        warnIfDistStale();
        const mod = await import('../../dist/analysis/tradingview/tradingview_uplot_chart_generator.js');
        html = mod.generateHTML({
            candles: makeCandles(N_BARS),
            meta: { assetA: { symbol: 'BASE' }, assetB: { symbol: 'QUOTE' }, intervalSeconds: 3600 },
            amaEnabled: true,
            smaEnabled: true,
            vwapEnabled: true,
            grid: { minPrice: 1.2, maxPrice: 1.5, incrementPercent: 0.5 },
            gridBounds: { low: 0.09, high: 0.12 },
            orders: { buys: [0.095, 0.096, 0.097, 0.098], sells: [0.101, 0.102, 0.103, 0.104] },
        }, 'perf');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-tv-perf-'));
        tmpDir = dir;
        const tmpFile = path.join(dir, 'chart.html');
        fs.writeFileSync(tmpFile, html);
        fileUrl = pathToFileURL(tmpFile).href;
    }
    hasRangeToggle = /id="range-toggle"/.test(html);
});

test.afterAll(async () => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loads the generated chart without console or page errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

    await loadChartPage(page);

    const state = await page.evaluate(() => ({
        charts: window.__charts.length,
        canvases: document.querySelectorAll('canvas').length,
        mainBars: window.__mainChart.data[0].length,
    }));
    expect(state.charts).toBeGreaterThanOrEqual(1);
    expect(state.canvases).toBeGreaterThanOrEqual(1);
    expect(state.mainBars).toBeGreaterThan(0);
    if (synthetic) expect(state.mainBars).toBe(N_BARS);
    expect(errors).toEqual([]);

    if (hasRangeToggle) {
        // TV-specific: the price chart is the one with the indicator series;
        // pin that so a construction-order flip would be caught here rather
        // than silently pointing the zoom/pixel tests at the volume chart.
        const tv = await page.evaluate(() => ({
            hasSma: window.__mainChart.series.some((s) => s.label === 'SMA'),
            moreSeriesThanSecond: window.__charts.length < 2
                || window.__mainChart.series.length > window.__charts[1].series.length,
        }));
        expect(tv.hasSma).toBe(true);
        expect(tv.moreSeriesThanSecond).toBe(true);
    }
});

test('range-band redraw cost scales with the visible window, not the full series', async ({ page }) => {
    test.skip(!hasRangeToggle, 'chart page has no Range toggle');
    await loadChartPage(page);

    // Warm up so a pending autofit rAF cannot land inside a measurement.
    await setRangeBand(page, true);
    await lineToCount(page, 'zoomed', ZOOM_BARS);
    await lineToCount(page, 'full', 0);

    await setRangeBand(page, true);
    const zoomedWithBand = await lineToCount(page, 'zoomed', ZOOM_BARS);
    const fullWithBand = await lineToCount(page, 'full', 0);

    await setRangeBand(page, false);
    const zoomedWithoutBand = await lineToCount(page, 'zoomed', ZOOM_BARS);
    const fullWithoutBand = await lineToCount(page, 'full', 0);

    const bandZoomed = zoomedWithBand - zoomedWithoutBand;
    const bandFull = fullWithBand - fullWithoutBand;

    // Sanity: the band must actually draw at full range.
    expect(bandFull).toBeGreaterThan(0);
    // The regression: a full-series scan would make the zoomed band cost
    // ~equal to the full-range cost. With viewport clipping it must be a
    // small fraction (measured ~1-6% depending on series length).
    expect(bandZoomed).toBeGreaterThan(0);
    expect(bandZoomed).toBeLessThan(bandFull * 0.25);
});

test('range band still spans the viewport when zoomed in', async ({ page }) => {
    test.skip(!hasRangeToggle, 'chart page has no Range toggle');
    await loadChartPage(page);
    await setRangeBand(page, true);
    await setXWindow(page, 'zoomed', ZOOM_BARS);

    // Pin y so band-on and band-off differ only by the band pixels.
    const y = await page.evaluate(() => {
        const chart = window.__mainChart;
        return { min: chart.scales.y.min, max: chart.scales.y.max };
    });

    const captureBandPixels = async (slot) => page.evaluate(async ({ yRange, slot }) => {
        const chart = window.__mainChart;
        chart.setScale('y', yRange);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const ctx = chart.ctx;
        const canvas = ctx.canvas;
        window[slot] = ctx.getImageData(0, 0, canvas.width, canvas.height).data.slice();
        return { width: canvas.width, height: canvas.height };
    }, { yRange: y, slot });

    const { width } = await captureBandPixels('__snapBandOn');

    await setRangeBand(page, false);
    await setXWindow(page, 'zoomed', ZOOM_BARS);
    await captureBandPixels('__snapBandOff');

    const diff = await page.evaluate((canvasWidth) => {
        const a = window.__snapBandOn;
        const b = window.__snapBandOff;
        if (!a || !b || a.length !== b.length || !canvasWidth) return null;
        let count = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        for (let i = 0; i < a.length; i += 4) {
            if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
                count++;
                const x = (i / 4) % canvasWidth;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
        }
        return { count, minX, maxX, width: canvasWidth };
    }, width);

    expect(diff).not.toBeNull();
    expect(diff.count).toBeGreaterThan(5000);
    // The band is not a thin sliver: its changed pixels reach both plot edges.
    expect((diff.maxX - diff.minX) / diff.width).toBeGreaterThan(0.8);
});
