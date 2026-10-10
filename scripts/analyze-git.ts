#!/usr/bin/env node

/**
 * DEXBot2 Repository Statistics Analyzer
 *
 * Analyzes git history and generates a chart showing:
 * - Lines added vs deleted by file
 *
 * Usage: node dist/scripts/analyze-git.js
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { formatMetric2 } from '../modules/order/format.js';
import { getStorage } from '../modules/storage/index.js';
import { PATHS } from '../modules/paths.js';
const { ensureDir } = getStorage();
import { getErrorMessage } from '../modules/utils/errors.js';
import { uplotInlineTags } from '../analysis/chart_utils.js';

/**
 * RepoAnalyzer Class
 *
 * Encapsulates git statistics analysis and report generation.
 * Parses git history and generates both console and HTML visualizations.
 */
class RepoAnalyzer {
    private stats: {
        files: { [key: string]: { added: number; deleted: number; edits: number } };
        totalAdded: number;
        totalDeleted: number;
        totalEdits: number;
        commits: number;
        dailyStats: { [key: string]: { added: number; deleted: number; edits: number; commits: number } };
    };
    private allStats: {
        files: { [key: string]: { added: number; deleted: number; edits: number } };
        totalAdded: number;
        totalDeleted: number;
        totalEdits: number;
        commits: number;
        dailyStats: { [key: string]: { added: number; deleted: number; edits: number; commits: number } };
    };
    private filePatterns: RegExp[];

    /**
     * constructor: Initialize analyzer with empty stats and filter patterns
     *
     * Stats structure tracks:
     * - files: Map of file paths to their add/delete/edit counts
     * - totalAdded/Deleted/Edits: Cumulative counts across all files
     * - commits: Total commits analyzed
     * - dailyStats: Changes grouped by date (for trend analysis)
     *
     * Tracked files are filtered by patterns:
     * - README* (any README file)
     * - Root-level .js/.ts files (only matches files without directory separators)
     * - modules/* folder (core business logic)
     * - scripts/* folder (utility scripts)
     *
     * This ensures we focus on actual project code, not generated/transient files
     */
    constructor() {
        // Statistics aggregation structure
        this.stats = {
            files: {},           // filename -> {added, deleted, edits}
            totalAdded: 0,       // Total lines added across tracked files
            totalDeleted: 0,     // Total lines deleted across tracked files
            totalEdits: 0,       // Sum of added + deleted
            commits: 0,          // Number of commits processed
            dailyStats: {}       // date -> {added, deleted, edits, commits}
        };

        // All files statistics (no filtering)
        this.allStats = {
            files: {},
            totalAdded: 0,
            totalDeleted: 0,
            totalEdits: 0,
            commits: 0,
            dailyStats: {}
        };

        // Regular expressions to filter which files to track
        // This prevents noise from auto-generated files, tests, etc.
        this.filePatterns = [
            /^README/i,          // All README files
            /^[^/]+\.(js|ts)$/,  // Root-level .js/.ts files (no subdirectories)
            /^modules\//,        // Everything under modules/ (core code)
            /^scripts\//         // Everything under scripts/ (tooling)
        ];
    }

    /**
     * isTrackedFile: Check if file path matches tracked file patterns
     *
     * Returns true if file matches ANY pattern (OR logic)
     * Used to filter git log entries to focus on project code
     *
     * @param {string} filePath - File path from git log
     * @returns {boolean} - True if file should be included in stats
     */
    isTrackedFile(filePath: string): boolean {
        return this.filePatterns.some(pattern => pattern.test(filePath));
    }

    /**
     * analyzeGitLog: Parse git history and build statistics
     *
     * Executes: git log --numstat --date=short --pretty=format:"%ad %h %s"
     * Output format (line by line):
     * - Commit lines: "YYYY-MM-DD hash message"
     * - File change lines: "added\tdeleted\tfilepath"
     *
     * Flow:
     * 1. Parse commit lines to track current date
     * 2. Parse file change lines (only tracked files)
     * 3. Aggregate statistics per file and per day
     * 4. Update cumulative totals
     *
     * Error handling: Throws if git command fails (not a repo, etc.)
     */
    analyzeGitLog(): void {
        console.log('📊 Analyzing DEXBot2 Repository...\n');

        try {
            // Get all commits with file changes and dates
            const gitLog = execSync(
                'git log --numstat --date=short --pretty=format:"%ad %h %s"',
                { encoding: 'utf8', cwd: process.cwd() }
            );

            const lines = gitLog.split('\n');
            let currentDate: string | null = null;
            let commitCount = 0;

            for (const line of lines) {
                // Check if this is a commit line (date + hash + message)
                if (/^\d{4}-\d{2}-\d{2}/.test(line)) {
                    const datePart = line.substring(0, 10);
                    currentDate = datePart;

                    // Initialize daily stats if not exists
                    if (!this.stats.dailyStats[currentDate]) {
                        this.stats.dailyStats[currentDate] = {
                            added: 0,
                            deleted: 0,
                            edits: 0,
                            commits: 0
                        };
                    }
                    if (!this.allStats.dailyStats[currentDate]) {
                        this.allStats.dailyStats[currentDate] = {
                            added: 0,
                            deleted: 0,
                            edits: 0,
                            commits: 0
                        };
                    }
                    this.stats.dailyStats[currentDate].commits++;
                    this.allStats.dailyStats[currentDate].commits++;
                    commitCount++;
                    continue;
                }

                // Parse numstat line: added\tdeleted\tfilename
                if (line.trim() && /^\d+/.test(line)) {
                    const parts = line.split('\t');
                    if (parts.length >= 3) {
                        const added = parseInt(parts[0]) || 0;
                        const deleted = parseInt(parts[1]) || 0;
                        const filePath = parts[2];

                        // Track ALL files (no filtering)
                        if (!this.allStats.files[filePath]) {
                            this.allStats.files[filePath] = { added: 0, deleted: 0, edits: 0 };
                        }
                        this.allStats.files[filePath].added += added;
                        this.allStats.files[filePath].deleted += deleted;
                        this.allStats.files[filePath].edits += (added + deleted);
                        this.allStats.totalAdded += added;
                        this.allStats.totalDeleted += deleted;
                        this.allStats.totalEdits += (added + deleted);

                        if (currentDate) {
                            if (!this.allStats.dailyStats[currentDate]) {
                                this.allStats.dailyStats[currentDate] = { added: 0, deleted: 0, edits: 0, commits: 0 };
                            }
                            this.allStats.dailyStats[currentDate].added += added;
                            this.allStats.dailyStats[currentDate].deleted += deleted;
                            this.allStats.dailyStats[currentDate].edits += (added + deleted);
                        }

                        // Only track files matching our patterns
                        if (this.isTrackedFile(filePath)) {
                            // Update file stats
                            if (!this.stats.files[filePath]) {
                                this.stats.files[filePath] = {
                                    added: 0,
                                    deleted: 0,
                                    edits: 0
                                };
                            }

                            this.stats.files[filePath].added += added;
                            this.stats.files[filePath].deleted += deleted;
                            this.stats.files[filePath].edits += (added + deleted);

                            // Update daily stats
                            if (currentDate && this.stats.dailyStats[currentDate]) {
                                this.stats.dailyStats[currentDate].added += added;
                                this.stats.dailyStats[currentDate].deleted += deleted;
                                this.stats.dailyStats[currentDate].edits += (added + deleted);
                            }

                            // Update totals
                            this.stats.totalAdded += added;
                            this.stats.totalDeleted += deleted;
                            this.stats.totalEdits += (added + deleted);
                        }
                    }
                }
            }

            this.stats.commits = commitCount;
        } catch (err) {
            console.error('Error analyzing git log:', getErrorMessage(err));
            process.exit(1);
        }
    }

    /**
     * generateCharts: Generate all output visualizations
     *
     * Creates two output formats:
     * 1. Console output: Terminal-friendly ASCII tables and stats
     * 2. HTML output: Interactive charts with Chart.js library
     *
     * Files are sorted by total edits (most active files first)
     * for meaningful visualization
     */
    generateCharts(): void {
        // Sort files by total edits (descending) for most-active-first display
        const sortedFiles = Object.entries(this.stats.files)
            .sort((a, b) => b[1].edits - a[1].edits);

        // Output 1: Console visualization with tables
        this.printConsoleCharts(sortedFiles);

        // Output 2: HTML file with interactive charts
        this.generateHtmlChart(sortedFiles);
    }

    /**
     * printConsoleCharts: Print formatted ASCII statistics to console
     *
     * Displays:
     * 1. Summary stats: Total commits, lines added/deleted, net change
     * 2. Add/Delete ratio: Metric for code quality (more adds vs deletes)
     * 3. Daily activity: Last 10 days of changes (trend analysis)
     *
     * Output format uses Unicode box drawing and padding for readability
     * Suitable for terminal display with fixed-width fonts
     */
    printConsoleCharts(_sortedFiles: [string, { added: number; deleted: number; edits: number }][]): void {
        console.log('='.repeat(80));
        console.log('📈 DEXBot2 Repository Statistics');
        console.log('='.repeat(80));
        console.log();

        // Summary stats
        console.log('📊 Overall Statistics:');
        console.log('─'.repeat(80));
        console.log(`  Total Commits Analyzed:  ${this.stats.commits}`);
        console.log(`  Total Lines Added:       ${this.stats.totalAdded.toLocaleString()}`);
        console.log(`  Total Lines Deleted:     ${this.stats.totalDeleted.toLocaleString()}`);
        console.log(`  Total Lines Changed:     ${this.stats.totalEdits.toLocaleString()}`);
        console.log(`  Net Change:              ${(this.stats.totalAdded - this.stats.totalDeleted).toLocaleString()}`);
        console.log();

         // Add/Delete ratio
         console.log('🎯 Add vs Delete Ratio:');
         console.log('─'.repeat(80));
         const ratio = (this.stats.totalAdded / Math.max(1, this.stats.totalDeleted));
         console.log(`Ratio (Added/Deleted): ${formatMetric2(ratio)}x`);
         console.log();

        // Daily stats summary
        const dailyDates = Object.keys(this.stats.dailyStats).sort();
        if (dailyDates.length > 0) {
            console.log('📅 Daily Activity (Last 10 days):');
            console.log('─'.repeat(80));
            console.log(`${'Date'.padEnd(15)} ${'Added'.padStart(10)} ${'Deleted'.padStart(10)} ${'Total'.padStart(10)} ${'Commits'.padStart(8)}`);
            console.log('─'.repeat(80));

            const last10Days = dailyDates.slice(-10);
            for (const date of last10Days) {
                const daily = this.stats.dailyStats[date];
                console.log(
                    `${date.padEnd(15)} ${daily.added.toString().padStart(10)} ${daily.deleted.toString().padStart(10)} ${daily.edits.toString().padStart(10)} ${daily.commits.toString().padStart(8)}`
                );
            }
            console.log();
        }
    }

    /**
     * generateHtmlChart: Create interactive HTML visualization with uPlot
     *
     * Generates an HTML file with 5 interactive charts:
     * 1. File comparison: Stacked bar chart (added vs deleted by file)
     * 2. Daily trends: Line chart (daily changes over time)
     * 3. Cumulative progress: Line chart (total growth trajectory)
     * 4. Net core lines: Line chart (added - deleted over time for core files)
     * 5. Net repo lines: Line chart (added - deleted over time for all files)
     *
     * Data preparation:
     * - Truncates file names to fit in chart labels
     * - Escapes quotes in labels for JSON embedding
     * - Builds daily stats arrays aligned with dates
     * - Calculates cumulative sums for growth visualization
     *
     * Output: Writes file to analysis/charts/repo-stats.html
     * Uses vendored uPlot from analysis/uplot/
     *
     * @param {Array<[string, Object]>} sortedFiles - Sorted files with their stats
     */
    generateHtmlChart(sortedFiles: [string, { added: number; deleted: number; edits: number }][]): void {
        // Show only the top N most-changed files in the bar chart so labels stay readable.
        // Reverse so the most-changed file is at the top of the chart.
        const MAX_BAR_FILES = 25;
        const barFiles = sortedFiles.slice(0, MAX_BAR_FILES).reverse();
        const totalTrackedFiles = sortedFiles.length;

        // Prepare file labels: prefer basename, keep paths readable and short
        const labels = barFiles.map(([file]) => {
            let short = file;
            // For long paths keep the basename plus one parent dir when useful
            if (short.length > 36) {
                const parts = short.split('/');
                const base = parts.pop() || '';
                const parent = parts.pop();
                short = parent ? parent + '/' + base : base;
            }
            if (short.length > 36) short = '...' + short.slice(-33);
            // Escape quotes for safe JSON embedding in HTML
            return short.replace(/"/g, '\\"');
        });

        // Extract added/deleted data arrays for chart datasets
        const addedData = barFiles.map(([_, stats]) => stats.added);
        const deletedData = barFiles.map(([_, stats]) => stats.deleted);

        /**
         * Daily Statistics Preparation
         * Sorted by date (ISO format) for chronological display
         */
        const dailyDates = Object.keys(this.stats.dailyStats).sort();
        const dailyAdded = dailyDates.map(date => this.stats.dailyStats[date].added);
        const dailyDeleted = dailyDates.map(date => this.stats.dailyStats[date].deleted);
        const dailyEdits = dailyDates.map(date => this.stats.dailyStats[date].edits);

        /**
         * Cumulative Statistics Calculation
         * Shows running total over time (useful for trend analysis)
         * Cumulative sum: each value = sum of all previous + current
         */
        let cumulativeAdded = 0;
        let cumulativeDeleted = 0;
        let cumulativeEdits = 0;

        // Build cumulative arrays using running total pattern
        const cumulativeAddedData = dailyDates.map(date => {
            cumulativeAdded += this.stats.dailyStats[date].added;
            return cumulativeAdded;
        });
        const cumulativeDeletedData = dailyDates.map(date => {
            cumulativeDeleted += this.stats.dailyStats[date].deleted;
            return cumulativeDeleted;
        });
        const cumulativeEditsData = dailyDates.map(date => {
            cumulativeEdits += this.stats.dailyStats[date].edits;
            return cumulativeEdits;
        });

        /**
         * Net Lines Calculation
         * Shows net growth: (cumulative added) - (cumulative deleted)
         * Positive value = code growing, negative = code shrinking
         */
        const netLinesData = cumulativeAddedData.map((added, index) => {
            return added - cumulativeDeletedData[index];
        });

        /**
         * All Files Net Lines Calculation
         * Covers all folders in the GitHub repo (no filtering)
         */
        const allDailyDates = Object.keys(this.allStats.dailyStats).sort();
        let allCumulativeAdded = 0;
        let allCumulativeDeleted = 0;
        const allCumulativeAddedData = allDailyDates.map(date => {
            allCumulativeAdded += this.allStats.dailyStats[date].added;
            return allCumulativeAdded;
        });
        const allCumulativeDeletedData = allDailyDates.map(date => {
            allCumulativeDeleted += this.allStats.dailyStats[date].deleted;
            return allCumulativeDeleted;
        });
        const allNetLinesData = allCumulativeAddedData.map((added, index) => {
            return added - allCumulativeDeletedData[index];
        });

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="dark">
    <title>DEXBot2 Repository Statistics</title>
    ${uplotInlineTags()}
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #0e1117;
            color: #e0e0e0;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 40px 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; color: #e6edf3; }
        .header p { font-size: 1.2em; color: #8b949e; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-bottom: 40px;
        }
        .stat-card {
            background: #161b22;
            border-radius: 12px;
            padding: 24px;
            border: 1px solid #30363d;
            text-align: center;
        }
        .stat-card h3 {
            color: #8b949e;
            font-size: 0.9em;
            text-transform: uppercase;
            margin-bottom: 8px;
            letter-spacing: 1px;
        }
        .stat-card .value {
            font-size: 2.5em;
            font-weight: bold;
        }
        .stat-card.added .value { color: #3fb950; }
        .stat-card.deleted .value { color: #ff7b72; }
        .stat-card.total .value { color: #58a6ff; }
        .chart-container {
            background: #161b22;
            border-radius: 12px;
            padding: 24px;
            border: 1px solid #30363d;
            margin-bottom: 32px;
        }
        .chart-container h2 {
            color: #e6edf3;
            margin-bottom: 6px;
            font-size: 1.4em;
            text-align: center;
        }
        .chart-subtitle {
            color: #8b949e;
            font-size: 0.9em;
            text-align: center;
            margin-bottom: 16px;
        }
        .chart-wrap {
            position: relative;
            height: 500px;
        }
        .chart-wrap.tall { height: 600px; }
        .chart-wrap.short { height: 350px; }
        .uplot { background: transparent; }
        .u-axis.u-left .u-value,
        .u-axis.u-3 .u-value {
            text-align: right;
            white-space: nowrap;
        }
        .u-title { display: none; }
        .footer { text-align: center; margin-top: 40px; font-size: 1em; color: #484f58; }
        @media (max-width: 768px) {
            .header h1 { font-size: 1.6em; }
            .chart-wrap { height: 350px; }
            .chart-wrap.tall { height: 400px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>&#x1f4ca; DEXBot2 Repository Statistics</h1>
            <p>Lines Added vs Deleted Analysis</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card added">
                <h3>Lines Added</h3>
                <div class="value">${this.stats.totalAdded.toLocaleString()}</div>
            </div>
            <div class="stat-card deleted">
                <h3>Lines Deleted</h3>
                <div class="value">${this.stats.totalDeleted.toLocaleString()}</div>
            </div>
            <div class="stat-card total">
                <h3>Total Changes</h3>
                <div class="value">${this.stats.totalEdits.toLocaleString()}</div>
            </div>
            <div class="stat-card total">
                <h3>Commits Analyzed</h3>
                <div class="value">${this.stats.commits.toLocaleString()}</div>
            </div>
        </div>

        <div class="chart-container" style="padding-top:8px;padding-bottom:36px">
            <h2>Added vs Deleted by File</h2>
            <p class="chart-subtitle">Showing top ${labels.length} of ${totalTrackedFiles} tracked files by total changes</p>
            <div class="chart-wrap" id="barChart" style="height:${Math.max(300, labels.length * 24 + 60)}px"></div>
        </div>

        <div class="chart-container" style="padding-bottom:34px">
            <h2>Changes Over Time (Daily)</h2>
            <div class="chart-wrap short" id="timeChart"></div>
        </div>

        <div class="chart-container" style="padding-bottom:34px">
            <h2>Cumulative Changes Over Time</h2>
            <div class="chart-wrap short" id="cumulativeChart"></div>
        </div>

        <div class="chart-container" style="padding-bottom:34px">
            <h2>Net Core Lines Over Time</h2>
            <div class="chart-wrap short" id="netLinesChart"></div>
        </div>

        <div class="chart-container" style="padding-bottom:34px">
            <h2>Net Repo Lines Over Time</h2>
            <div class="chart-wrap short" id="allNetLinesChart"></div>
        </div>

        <div class="footer">
            <p>Generated on ${new Date().toLocaleString()} | DEXBot2 Repository Analysis</p>
        </div>
    </div>

    <script>
    // ===== Shared helpers =====
    function initChart(id, opts, data) {
        const el = document.getElementById(id);
        const rect = el.getBoundingClientRect();
        opts.width = Math.max(320, Math.floor(rect.width));
        opts.height = Math.max(200, Math.floor(rect.height));
        const chart = new uPlot(opts, data, el);
        const ro = new ResizeObserver(function() {
            const r = el.getBoundingClientRect();
            chart.setSize({ width: Math.max(320, Math.floor(r.width)), height: Math.max(200, Math.floor(r.height)) });
        });
        ro.observe(el);
        return chart;
    }

    function fmt(v) { return typeof v === 'number' ? v.toLocaleString() : String(v); }

    function line( label, color, fill, dash ) {
        var s = {
            label: label,
            stroke: color,
            width: 2,
            points: { show: false },
        };
        if (fill) s.fill = fill;
        if (dash) s.dash = dash;
        return s;
    }

    function clamp(mn, mx, lo, hi) {
        var nmin = mn, nmax = mx;
        if (nmin < lo) { nmax += lo - nmin; nmin = lo; }
        if (nmax > hi) { nmin -= nmax - hi; nmax = hi; }
        if (nmin < lo) nmin = lo;
        if (nmax > hi) nmax = hi;
        if (nmax <= nmin) return { min: lo, max: hi };
        return { min: nmin, max: nmax };
    }

    function makeTimeAxis(side) {
        return {
            stroke: '#8b949e',
            grid: { stroke: '#21262d', width: 1 },
            ticks: { stroke: '#30363d' },
            size: 50,
            font: '12px sans-serif',
            values: (u, vals) => vals.map(function(v) {
                var d = new Date(v * 1000);
                var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
                var dd = String(d.getUTCDate()).padStart(2, '0');
                return mm + '/' + dd;
            }),
        };
    }

    function makeValAxis(side) {
        return {
            stroke: '#8b949e',
            grid: { stroke: '#21262d', width: 1 },
            ticks: { stroke: '#30363d' },
            size: 70,
            font: '12px sans-serif',
            values: (u, vals) => vals.map(function(v) { return fmt(v); }),
        };
    }

    function addWheelZoom(chart, lo, hi) {
        chart.root.addEventListener('wheel', function(e) {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            var rect = chart.root.getBoundingClientRect();
            var left = e.clientX - rect.left - (chart.bbox.left / (chart.pxRatio || 1));
            var center = chart.posToVal(left, 'x');
            var s = chart.scales.x || {};
            var currMin = Number.isFinite(s.min) ? s.min : lo;
            var currMax = Number.isFinite(s.max) ? s.max : hi;
            var span = currMax - currMin;
            if (!Number.isFinite(span) || span <= 0) return;
            var factor = e.deltaY < 0 ? 0.85 : 1.15;
            var nextSpan = Math.max(1, Math.min(hi - lo, span * factor));
            var ratio = (center - currMin) / span;
            var nmin = center - nextSpan * ratio;
            var nmax = nmin + nextSpan;
            var clamped = clamp(nmin, nmax, lo, hi);
            chart.batch(function() { chart.setScale('x', clamped); });
        }, { passive: false });
    }

    // ===== Chart 1: Added vs Deleted by File (horizontal stacked bars via uPlot.paths.bars) =====
    (function() {
        // Stacking helper (from uPlot demos/stack.js)
        function stack(data, omit) {
            var data2 = [];
            var bands = [];
            var d0Len = data[0].length;
            var accum = [];
            for (var i = 0; i < d0Len; i++) accum[i] = 0;
            for (var i = 1; i < data.length; i++)
                data2.push(omit(i) ? data[i] : data[i].map(function(v, j) { return (accum[j] += +v); }));
            for (var i = 1; i < data.length; i++)
                !omit(i) && bands.push({
                    series: [data.findIndex(function(s, j) { return j > i && !omit(j); }), i],
                });
            bands = bands.filter(function(b) { return b.series[1] > -1; });
            return { data: [data[0]].concat(data2), bands: bands };
        }

        var labels = ${JSON.stringify(labels)};
        var added = ${JSON.stringify(addedData)};
        var deleted = ${JSON.stringify(deletedData)};

        labels.reverse();
        added.reverse();
        deleted.reverse();

        var idx = labels.map(function(_, i) { return i; });
        var rawData = [idx, added, deleted];
        var stacked = stack(rawData, function() { return false; });

        var opts = {
            padding: [0, null, -20, null],
            scales: {
                x: {
                    time: false,
                    distr: 2,
                    ori: 1,
                    dir: -1,
                    range: function(u, min, max) {
                        return [-0.5, u.data[0].length - 0.5];
                    },
                },
                y: {
                    range: [0, null],
                    ori: 0,
                },
            },
            bands: stacked.bands,
            series: [
                { label: 'File' },
                {
                    label: 'Added',
                    fill: '#3fb950',
                    stroke: '#3fb950',
                    width: 0,
                    paths: uPlot.paths.bars({ size: [0.7, 100] }),
                    value: function(u, v, si, di) { return added[di]; },
                },
                {
                    label: 'Deleted',
                    fill: '#ff7b72',
                    stroke: '#ff7b72',
                    width: 0,
                    paths: uPlot.paths.bars({ size: [0.7, 100] }),
                    value: function(u, v, si, di) { return deleted[di]; },
                },
            ],
            axes: [
                {
                    scale: 'x',
                    side: 3,
                    splits: function(u) { return u._data[0].slice(); },
                    values: function(u, vals) {
                        return (vals || u.data[0]).map(function(v) {
                            var lbl = labels[v] || '';
                            if (lbl.length > 34) lbl = lbl.slice(0, 31) + '...';
                            return lbl;
                        });
                    },
                    gap: 15,
                    size: function(u, values, axisIdx, cycleNum) {
                        var axis = u.axes[axisIdx];
                        if (cycleNum > 2) return axis._size;
                        var size = (axis.ticks ? axis.ticks.size : 0) + axis.gap;
                        var longest = '';
                        var vals = values || [];
                        for (var i = 0; i < vals.length; i++) {
                            if (vals[i].length > longest.length) longest = vals[i];
                        }
                        if (longest !== '') {
                            var font = Array.isArray(axis.font) ? axis.font[0] : axis.font;
                            u.ctx.font = font;
                            size += u.ctx.measureText(longest).width / (u.pxRatio || 1);
                        }
                        return Math.ceil(size);
                    },
                    font: '12px sans-serif',
                    stroke: '#8b949e',
                    grid: { show: false },
                    ticks: { show: false },
                },
                {
                    scale: 'y',
                    side: 2,
                    stroke: '#8b949e',
                    grid: { stroke: '#21262d', width: 1 },
                    ticks: { stroke: '#30363d' },
                    font: '12px sans-serif',
                    size: 70,
                    splits: function(u, axisIdx, scaleMin, scaleMax) {
                        var out = [];
                        for (var v = 0; v <= scaleMax; v += 2000) out.push(v);
                        return out;
                    },
                    values: function(u, vals) { return vals.map(function(v) { return fmt(v); }); },
                },
            ],
            cursor: {
                show: true,
                drag: { x: true, y: false },
            },
            legend: { show: true },
        };

        initChart('barChart', opts, stacked.data);
    })();

    // ===== Charts 2-4: Time series (shared date domain) =====
    (function() {
        var dates = ${JSON.stringify(dailyDates)};
        var ts = dates.map(function(d) { return new Date(d).getTime() / 1000; });
        var xMin = ts[0], xMax = ts[ts.length - 1];

        var dailyAdded    = ${JSON.stringify(dailyAdded)};
        var dailyDeleted  = ${JSON.stringify(dailyDeleted)};
        var dailyEdits    = ${JSON.stringify(dailyEdits)};
        var cumAdded      = ${JSON.stringify(cumulativeAddedData)};
        var cumDeleted    = ${JSON.stringify(cumulativeDeletedData)};
        var cumEdits      = ${JSON.stringify(cumulativeEditsData)};
        var netLines      = ${JSON.stringify(netLinesData)};

        function makeTimeSeries(titleHtml, id, seriesDefs, dataArrays) {
            var opts = {
                scales: {
                    x: { time: true, range: [xMin, xMax] },
                    y: { range: function(u, min, max) { return min === max ? [0, max * 1.1 || 1] : [Math.min(0, min), max * 1.05]; } },
                },
                series: [{ label: 'Date' }].concat(seriesDefs),
                axes: [
                    makeTimeAxis(2),
                    makeValAxis(3),
                ],
            cursor: {
                show: true,
                drag: { x: true, y: false },
            },
            legend: { show: true },
            };
            var chart = initChart(id, opts, [ts].concat(dataArrays));
            addWheelZoom(chart, xMin, xMax);

            var over = chart.over;
            var legend = document.createElement('div');
            legend.style.cssText = 'position:absolute;top:-6px;left:12px;font-size:11px;color:#8b949e;display:flex;gap:14px;z-index:10;pointer-events:none;white-space:nowrap;';
            var items = '';
            for (var i = 0; i < seriesDefs.length; i++) {
                var s = seriesDefs[i];
                items += '<span><span style="color:' + s.stroke + ';">' + s.label + '</span></span>';
            }
            legend.innerHTML = items;
            over.parentElement.appendChild(legend);
        }

        // Chart 2: Daily changes
        makeTimeSeries('Daily Changes', 'timeChart', [
            line('Added',   '#3fb950'),
            line('Deleted', '#ff7b72'),
            line('Edits',   '#58a6ff', null, [5, 5]),
        ], [dailyAdded, dailyDeleted, dailyEdits]);

        // Chart 3: Cumulative changes
        makeTimeSeries('Cumulative Changes', 'cumulativeChart', [
            line('Cum Added',   '#3fb950', 'rgba(63,185,80,0.10)'),
            line('Cum Deleted', '#ff7b72', 'rgba(255,123,114,0.10)'),
            line('Cum Edits',   '#58a6ff', null, [5, 5]),
        ], [cumAdded, cumDeleted, cumEdits]);

        // Chart 4: Net core lines
        makeTimeSeries('Net Core Lines', 'netLinesChart', [
            line('Net Lines', '#d2a8ff', 'rgba(210,168,255,0.10)'),
        ], [netLines]);
    })();

    // ===== Chart 5: Net repo lines (all files, separate date domain) =====
    (function() {
        var dates = ${JSON.stringify(allDailyDates)};
        var ts = dates.map(function(d) { return new Date(d).getTime() / 1000; });
        var xMin = ts[0], xMax = ts[ts.length - 1];
        var allNet = ${JSON.stringify(allNetLinesData)};

        var opts = {
            scales: {
                x: { time: true, range: [xMin, xMax] },
                y: { range: function(u, min, max) { return min === max ? [0, max * 1.1 || 1] : [Math.min(0, min), max * 1.05]; } },
            },
            series: [
                { label: 'Date' },
                line('Net Lines (All)', '#d29922', 'rgba(210,153,34,0.10)'),
            ],
            axes: [
                makeTimeAxis(2),
                makeValAxis(3),
            ],
            cursor: {
                show: true,
                drag: { x: true, y: false },
            },
            legend: { show: true },
        };
        var chart = initChart('allNetLinesChart', opts, [ts, allNet]);
        addWheelZoom(chart, xMin, xMax);

        var over = chart.over;
        var legend = document.createElement('div');
        legend.style.cssText = 'position:absolute;top:-20px;left:12px;font-size:11px;color:#8b949e;display:flex;gap:14px;z-index:10;pointer-events:none;';
        legend.innerHTML = '<span><span style="color:#d29922;">Net Lines (All)</span></span>';
        over.parentElement.appendChild(legend);
    })();
    </script>
</body>
</html>`;

        const outputPath = path.join(PATHS.ANALYSIS.CHARTS_DIR, 'repo-stats.html');
        ensureDir(path.dirname(outputPath));
        fs.writeFileSync(outputPath, html);
        console.log('HTML chart generated: ' + outputPath);
        console.log('   Open in browser: file://' + outputPath);
    }
}

// Run the analyzer
const analyzer = new RepoAnalyzer();
analyzer.analyzeGitLog();
analyzer.generateCharts();

