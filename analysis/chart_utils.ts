'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { getStorage } from '../modules/storage/index.js';
import { PATHS } from '../modules/paths.js';
const { ensureDir } = getStorage();

/**
 * Chart utilities for analysis HTML generators.
 */

// Vendored uPlot runtime assets are inlined directly into every generated chart
// (see uplotInlineTags below), so each chart is a single self-contained file
// that renders anywhere: no DEXBot2 install, no sibling uplot/ dir, no CDN, no
// network. The vendored originals always live with the code under the analysis
// assets dir.
let _uplotRuntime: { css: string; js: string } | null = null;

function getUplotRuntime() {
    if (!_uplotRuntime) {
        const dir = PATHS.ANALYSIS.ASSETS_DIR;
        _uplotRuntime = {
            css: fs.readFileSync(path.join(dir, 'uPlot.min.css'), 'utf8'),
            js: fs.readFileSync(path.join(dir, 'uPlot.iife.min.js'), 'utf8'),
        };
    }
    return _uplotRuntime;
}

/**
 * Inline <style>/<script> tags carrying the vendored uPlot runtime. Embedding
 * the source (not a relative <script src>) makes a chart portable: it keeps
 * rendering after being copied, mailed, or reopened on a machine without a
 * DEXBot2 installation. The inline script must be the first script that runs,
 * placed before any chart-initialization code, since uPlot must exist first.
 * Both the minified JS (no `</script>`) and CSS (no `</style>`) are safe to
 * embed verbatim.
 */
function uplotInlineTags({ css = true, js = true } = {}) {
    const { css: cssCode, js: jsCode } = getUplotRuntime();
    const parts: string[] = [];
    if (css && cssCode) parts.push(`<style>\n${cssCode}\n</style>`);
    if (js && jsCode) parts.push(`<script>\n${jsCode}\n</script>`);
    return parts.join('\n    ');
}


function escapeHtml(str: string) {
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    };
    return String(str).replace(/[&<>"']/g, (m: string) => map[m]);
}

function serializeJsonForScript(value: unknown) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function toEpochSeconds(ts: unknown, fallbackIdx: number) {
    const ms = new Date(ts as string | number | Date).getTime();
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    return fallbackIdx * 3600;
}

function toFileUrl(filePath: string): string {
    return `file://${path.resolve(String(filePath))}`;
}

function writeChartFile(filePath: string, html: string) {
    const chartDir = path.dirname(filePath);
    if (!fs.existsSync(chartDir)) ensureDir(chartDir);
    // Atomic write (tmp + rename, matching the production storage adapter
    // pattern) so a crash mid-write can never leave a truncated chart file.
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, html, 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort cleanup */ }
        throw err;
    }
}

/**
 * Serialize the exact source of the given pure functions for injection into a
 * generated HTML <script> block. Each function is emitted as a top-level
 * function declaration (Function.prototype.toString()), so browser-embedded
 * charts run the same logic as the Node-side modules instead of a hand-copied
 * copy. Functions must be self-contained (no imports or module-level constants
 * referenced from their bodies); callers pass all config values explicitly.
 *
 * The emitted block is wrapped in marker comments so test harnesses can extract
 * the embedded sources reliably regardless of the function list or ordering.
 */
function embedFunctionSources(fns: Array<Function>): string {
    const sources = fns.map((fn) => fn.toString()).join('\n\n');
    return `/* EMBEDDED_FUNCS_START */\n${sources}\n/* EMBEDDED_FUNCS_END */`;
}

/**
 * Shared uPlot interaction boilerplate for embedded browser scripts.
 * Consumers must define `xMin`, `xMax`, `charts`, `pendingRange`, and `pendingRangeRaf`
 * before embedding this script block.
 */
const UPLOT_SHARED_SCRIPT = `
function clampXRange(min, max) {
    let nextMin = min, nextMax = max;
    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMax <= nextMin) {
        return { min: xMin, max: xMax };
    }
    if (nextMin < xMin) { nextMax += xMin - nextMin; nextMin = xMin; }
    if (nextMax > xMax) { nextMin -= nextMax - xMax; nextMax = xMax; }
    if (nextMin < xMin) nextMin = xMin;
    if (nextMax > xMax) nextMax = xMax;
    if (nextMax <= nextMin) return { min: xMin, max: xMax };
    return { min: nextMin, max: nextMax };
}

function syncXRange(min, max) {
    pendingRange = clampXRange(min, max);
    if (pendingRangeRaf) return;
    const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame.bind(window) : (fn) => setTimeout(fn, 0);
    pendingRangeRaf = raf(() => {
        const next = pendingRange;
        pendingRange = null;
        pendingRangeRaf = 0;
        if (!next) return;
        charts.forEach(c => c && c.batch(() => c.setScale('x', next)));
    });
}

function bindWheelZoom(chart) {
    chart.root.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = chart.root.getBoundingClientRect();
        
        // Correctly calculate plot-relative 'left' for accurate centering
        const left = e.clientX - rect.left - (chart.bbox.left / (chart.pxRatio || 1));
        const center = chart.posToVal(left, 'x');
        
        const s = chart.scales.x || {};
        const currMin = Number.isFinite(s.min) ? s.min : xMin;
        const currMax = Number.isFinite(s.max) ? s.max : xMax;
        const span = currMax - currMin;
        if (!Number.isFinite(span) || span <= 0) return;
        const factor = e.deltaY < 0 ? 0.85 : 1.15;
        const nextSpan = Math.max(1, Math.min(xMax - xMin, span * factor));
        const ratio = (center - currMin) / span;
        syncXRange(center - nextSpan * ratio, center - nextSpan * ratio + nextSpan);
    }, { passive: false });
}

function bindPan(chart) {
    let dragging = false, startClientX = 0, startClientY = 0, startMin = xMin, startMax = xMax, xUnitsPerPx = 0;
    const getScale = () => {
        const s = chart.scales.x || {};
        return { currMin: Number.isFinite(s.min) ? s.min : xMin, currMax: Number.isFinite(s.max) ? s.max : xMax };
    };
    const onMouseMove = (e) => {
        if (!dragging) return;
        
        // Ignore if vertical movement is dominant (likely scrolling)
        if (Math.abs(e.clientY - startClientY) > 20) return;
        
        e.preventDefault();
        const deltaPx = e.clientX - startClientX;
        const deltaVal = deltaPx * xUnitsPerPx;
        syncXRange(startMin - deltaVal, startMax - deltaVal);
    };
    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', endDrag);
    };
    chart.root.addEventListener('mousedown', (e) => {
        if (!e || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
        const rect = chart.root.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        dragging = true;
        startClientX = e.clientX;
        startClientY = e.clientY;
        const cur = getScale();
        startMin = cur.currMin; startMax = cur.currMax;
        
        // Calculate units per pixel once at start of drag to avoid sliding bug
        // chart.bbox.width is in device pixels; divide by pxRatio for CSS pixels
        xUnitsPerPx = (cur.currMax - cur.currMin) / (chart.bbox.width / (chart.pxRatio || 1));
        
        document.body.style.cursor = 'grabbing';
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', endDrag, { once: true });
    });

    // Keep the grab cursor while dragging even as the pointer leaves the plot,
    // and end the drag if the window loses focus mid-drag (otherwise the chart
    // keeps panning on the next mousemove after refocus).
    chart.root.addEventListener('mouseleave', () => {
        if (!dragging) return;
        document.body.style.cursor = 'grabbing';
    });
    window.addEventListener('blur', endDrag);
}
`;

export { escapeHtml, serializeJsonForScript, toEpochSeconds, writeChartFile, toFileUrl, embedFunctionSources, UPLOT_SHARED_SCRIPT, uplotInlineTags }

