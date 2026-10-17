'use strict';

const assert = require('assert');
const vm = require('vm');

const { UPLOT_SHARED_SCRIPT, VIEWPORT_CLIP_SCRIPT } = require('../analysis/chart_utils');
const { generateHTML: generateDynamicWeightHTML } = require('../analysis/trend_detection/dynamic_weight_chart_generator');

// uPlot 1.6.32's built-in log-axis splits generator (used for `distr: 3` axes)
// can loop forever on a narrow price range: the step is reassigned to an
// intermediate tick that is missing from the nice-number cache, so the next
// rounding collapses the step to 0 and the tick array grows until the engine
// throws "Invalid array length" / runs out of memory (browser tab hang). The
// shared `logAxisSplits` helper replaces it for every log price axis. These
// tests pin the helper and the generator wiring.
//
// The exact values below are the ones that hung the dynamic-weight chart for a
// live market-pair bot after a couple of scroll-wheel zooms.

const HANGING_RANGE = [0.0009571018339581343, 0.0017959513373339187];

function loadSharedHelpers(): any {
    const sandbox: any = {};
    vm.createContext(sandbox);
    vm.runInContext(UPLOT_SHARED_SCRIPT + '\n' + VIEWPORT_CLIP_SCRIPT, sandbox);
    return sandbox;
}

function assertTicksInRange(splits, min, max, label) {
    assert.ok(Array.isArray(splits), `${label}: splits must be an array`);
    assert.ok(splits.length >= 2 && splits.length <= 40, `${label}: expected a bounded tick count, got ${splits.length}`);
    let prev = -Infinity;
    for (const v of splits) {
        assert.ok(Number.isFinite(v), `${label}: non-finite tick ${v}`);
        assert.ok(v >= min && v <= max, `${label}: tick ${v} outside [${min}, ${max}]`);
        assert.ok(v > prev, `${label}: ticks not strictly increasing (${prev} -> ${v})`);
        prev = v;
    }
}

function testHelperSurvivesTheHangingRange() {
    const { logAxisSplits } = loadSharedHelpers();
    assert.strictEqual(typeof logAxisSplits, 'function', 'logAxisSplits must be embedded in UPLOT_SHARED_SCRIPT');
    const [min, max] = HANGING_RANGE;
    // Would push ticks until OOM under the buggy built-in generator.
    const splits = logAxisSplits(null, 1, min, max);
    assertTicksInRange(splits, min, max, 'hanging range');
}

function testHelperNeverDiverges() {
    const { logAxisSplits } = loadSharedHelpers();
    // Deterministic fuzz across many decades / narrow bands.
    let seed = 123456789;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    for (let i = 0; i < 3000; i++) {
        const decade = Math.floor(rand() * 24) - 12; // 1e-12 .. 1e11
        const base = Math.pow(10, decade) * (1 + rand() * 9);
        const width = base * (1 + rand() * 4);
        const min = base;
        const max = base + width;
        const splits = logAxisSplits(null, 1, min, max);
        assertTicksInRange(splits, min, max, `fuzz #${i} [${min}, ${max}]`);
    }
}

function testHelperGuardsInvalidRanges() {
    const { logAxisSplits } = loadSharedHelpers();
    // vm arrays live in another realm; compare length, not deep identity.
    for (const [min, max] of [[0, 1], [-1, 1], [5, 5], [5, 4]]) {
        assert.strictEqual(logAxisSplits(null, 1, min, max).length, 0, `[${min}, ${max}] must produce no ticks`);
    }
}

function testHelperHandlesWideRanges() {
    const { logAxisSplits } = loadSharedHelpers();
    // Multi-decade ranges must stay bounded (and sorted) rather than crowd the axis.
    for (const [min, max] of [[1e-5, 1e6], [0.5, 1e9]]) {
        assertTicksInRange(logAxisSplits(null, 1, min, max), min, max, `wide [${min}, ${max}]`);
    }
}

function testDynamicWeightChartWiresSafeSplits() {
    const start = Date.UTC(2026, 0, 1);
    const rows = [];
    for (let i = 0; i < 40; i++) {
        rows.push({
            timestamp: start + i * 3600 * 1000,
            price: 0.001 + 0.0001 * Math.sin(i / 3),
            hurst: 0.5,
            pe: 0.5,
            ama3Price: 0.001,
            amaSlopePct: 0.01,
            isReady: true,
            signal: 'NEUTRAL',
        });
    }
    const html = generateDynamicWeightHTML({ allResults: rows }, 'test');
    assert.ok(html.includes('function logAxisSplits('), 'shared logAxisSplits helper must be embedded');
    assert.ok(html.includes('splits: logAxisSplits'), 'log price axis must opt into the safe splits function');
    assert.ok(html.includes('function visibleBarRange('), 'viewport-clip helper must be embedded in the dynamic-weight chart');
    assert.ok(html.includes('visibleBarRange(u, values.length)'), 'pct-fill hook must clip to the visible bar range');
    // The embedded browser script must still parse as valid JS.
    const match = html.match(/<script>\s*(const data =[\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(match, 'expected browser script block');
    new vm.Script(match[1]);
}

function testVisibleBarRange() {
    const { visibleBarRange } = loadSharedHelpers();
    assert.strictEqual(typeof visibleBarRange, 'function', 'visibleBarRange must be embedded in UPLOT_SHARED_SCRIPT');
    const xs = [10, 20, 30, 40, 50];
    const mk = (min, max) => ({ data: [xs], scales: { x: { min, max } } });
    // Viewport [20,40] covers indices 1..3; widened to the full series.
    assert.deepStrictEqual([...visibleBarRange(mk(20, 40), 5)], [0, 4]);
    // Single-point viewport -> one bar of padding on each side.
    assert.deepStrictEqual([...visibleBarRange(mk(30, 30), 5)], [1, 3]);
    // Fully right of the data -> clamps to the last bars.
    assert.deepStrictEqual([...visibleBarRange(mk(100, 200), 5)], [3, 4]);
    // Fully left of the data -> clamps to the first bars.
    assert.deepStrictEqual([...visibleBarRange(mk(-100, 0), 5)], [0, 1]);
    // Missing / malformed inputs fall back to the full range (no clipping).
    assert.deepStrictEqual([...visibleBarRange({ data: [xs] }, 5)], [0, 4]);
    assert.deepStrictEqual([...visibleBarRange({ data: [[]], scales: { x: { min: 1, max: 2 } } }, 0)], [0, -1]);
    assert.deepStrictEqual([...visibleBarRange({ data: [xs], scales: { x: { min: NaN, max: 5 } } }, 5)], [0, 4]);
}

function main() {
    testHelperSurvivesTheHangingRange();
    testHelperNeverDiverges();
    testHelperGuardsInvalidRanges();
    testHelperHandlesWideRanges();
    testDynamicWeightChartWiresSafeSplits();
    testVisibleBarRange();
    console.log('chart log-axis splits tests passed');
}

main();
