#!/usr/bin/env node

/**
 * DEXBot2 Repository Statistics Analyzer
 *
 * Analyzes git history and generates a chart showing:
 * - Lines added vs deleted by file
 *
 * Usage: node scripts/analyze-repo-stats.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class RepoAnalyzer {
    constructor() {
        this.stats = {
            files: {},
            totalAdded: 0,
            totalDeleted: 0,
            totalEdits: 0,
            commits: 0,
            dailyStats: {} // Track changes by day
        };
        this.filePatterns = [
            /^README/i,
            /^[^/]+\.js$/, // Root level .js files
            /^modules\//,   // Anything in modules folder
            /^scripts\//    // Anything in scripts folder
        ];
    }

    isTrackedFile(filePath) {
        return this.filePatterns.some(pattern => pattern.test(filePath));
    }

    analyzeGitLog() {
        console.log('📊 Analyzing DEXBot2 Repository...\n');

        try {
            // Get all commits with file changes and dates
            const gitLog = execSync(
                'git log --numstat --date=short --pretty=format:"%ad %h %s"',
                { encoding: 'utf8', cwd: process.cwd() }
            );

            const lines = gitLog.split('\n');
            let currentDate = null;
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
                    this.stats.dailyStats[currentDate].commits++;
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
            console.error('Error analyzing git log:', err.message);
            process.exit(1);
        }
    }

    generateCharts() {
        // Sort files by total edits
        const sortedFiles = Object.entries(this.stats.files)
            .sort((a, b) => b[1].edits - a[1].edits);

        // Generate console visualization
        this.printConsoleCharts(sortedFiles);

        // Generate HTML chart
        this.generateHtmlChart(sortedFiles);
    }

    printConsoleCharts() {
        console.log('═'.repeat(80));
        console.log('📈 DEXBot2 Repository Statistics');
        console.log('═'.repeat(80));
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

        // All tracked files
        console.log('📋 All Tracked Files:');
        console.log('─'.repeat(80));
        console.log(`${'File'.padEnd(45)} ${'Added'.padStart(10)} ${'Deleted'.padStart(10)} ${'Total'.padStart(10)}`);
        console.log('─'.repeat(80));

        const allFiles = Object.entries(this.stats.files)
            .sort((a, b) => b[1].edits - a[1].edits);

        for (const [file, stats] of allFiles) {
            const fileName = file.length > 43 ? '...' + file.slice(-40) : file;
            console.log(
                `${fileName.padEnd(45)} ${stats.added.toString().padStart(10)} ${stats.deleted.toString().padStart(10)} ${stats.edits.toString().padStart(10)}`
            );
        }
        console.log();

        // Add/Delete ratio
        console.log('🎯 Add vs Delete Ratio:');
        console.log('─'.repeat(80));
        const ratio = (this.stats.totalAdded / Math.max(1, this.stats.totalDeleted)).toFixed(2);
        console.log(`Ratio (Added/Deleted): ${ratio}x`);
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

    generateHtmlChart(sortedFiles) {
        const labels = sortedFiles.map(([file]) => {
            const short = file.length > 50 ? file.slice(0, 47) + '...' : file;
            return short.replace(/"/g, '\\"');
        });

        const addedData = sortedFiles.map(([_, stats]) => stats.added);
        const deletedData = sortedFiles.map(([_, stats]) => stats.deleted);

        // Prepare daily stats (sorted by date)
        const dailyDates = Object.keys(this.stats.dailyStats).sort();
        const dailyAdded = dailyDates.map(date => this.stats.dailyStats[date].added);
        const dailyDeleted = dailyDates.map(date => this.stats.dailyStats[date].deleted);
        const dailyEdits = dailyDates.map(date => this.stats.dailyStats[date].edits);

        // Calculate cumulative stats
        let cumulativeAdded = 0;
        let cumulativeDeleted = 0;
        let cumulativeEdits = 0;
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

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DEXBot2 Repository Statistics</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 40px 20px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            color: white;
            margin-bottom: 40px;
        }
        .header h1 {
            font-size: 3em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        .header p {
            font-size: 1.3em;
            opacity: 0.9;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }
        .stat-card {
            background: white;
            border-radius: 12px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            text-align: center;
        }
        .stat-card h3 {
            color: #667eea;
            font-size: 1.1em;
            text-transform: uppercase;
            margin-bottom: 10px;
            letter-spacing: 1px;
            font-weight: 600;
        }
        .stat-card .value {
            font-size: 3em;
            font-weight: bold;
            color: #333;
        }
        .stat-card.added .value { color: #10b981; }
        .stat-card.deleted .value { color: #ef4444; }
        .stat-card.total .value { color: #667eea; }
        .chart-container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            margin-bottom: 40px;
        }
        .chart-container h2 {
            color: #333;
            margin-bottom: 30px;
            font-size: 1.8em;
            text-align: center;
            font-weight: 600;
        }
        .chart-wrapper {
            position: relative;
            height: 600px;
        }
        .footer {
            text-align: center;
            color: white;
            margin-top: 40px;
            font-size: 1.1em;
            opacity: 0.8;
        }
        @media (max-width: 768px) {
            .header h1 {
                font-size: 1.8em;
            }
            .chart-wrapper {
                height: 400px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 DEXBot2 Repository Statistics</h1>
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

        <div class="chart-container">
            <h2>➕➖ Added vs Deleted by File</h2>
            <div class="chart-wrapper">
                <canvas id="addDelChart"></canvas>
            </div>
        </div>

        <div class="chart-container">
            <h2>📈 Changes Over Time (Daily)</h2>
            <div class="chart-wrapper" style="height: 400px;">
                <canvas id="timeChart"></canvas>
            </div>
        </div>

        <div class="chart-container">
            <h2>📊 Cumulative Changes Over Time</h2>
            <div class="chart-wrapper" style="height: 400px;">
                <canvas id="cumulativeChart"></canvas>
            </div>
        </div>

        <div class="footer">
            <p>Generated on ${new Date().toLocaleString()} | DEXBot2 Repository Analysis</p>
        </div>
    </div>

    <script>
        // Chart: Added vs Deleted stacked bar
        const ctx = document.getElementById('addDelChart').getContext('2d');
        const chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(labels)},
                datasets: [
                    {
                        label: '➕ Added',
                        data: ${JSON.stringify(addedData)},
                        backgroundColor: '#10b981',
                        borderRadius: 4,
                        borderSkipped: false
                    },
                    {
                        label: '🔴 Deleted',
                        data: ${JSON.stringify(deletedData)},
                        backgroundColor: '#ef4444',
                        borderRadius: 4,
                        borderSkipped: false
                    }
                ]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: {
                            font: { size: 14 }
                        }
                    },
                    y: {
                        stacked: true,
                        ticks: {
                            font: { size: 14 }
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            usePointStyle: true,
                            padding: 20,
                            font: { size: 15 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.x !== null) {
                                    label += context.parsed.x.toLocaleString();
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });

        // Chart: Changes over time
        const ctxTime = document.getElementById('timeChart').getContext('2d');
        const timeChart = new Chart(ctxTime, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(dailyDates)},
                datasets: [
                    {
                        label: '➕ Added',
                        data: ${JSON.stringify(dailyAdded)},
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 3,
                        pointBackgroundColor: '#10b981'
                    },
                    {
                        label: '🔴 Deleted',
                        data: ${JSON.stringify(dailyDeleted)},
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 3,
                        pointBackgroundColor: '#ef4444'
                    },
                    {
                        label: '📊 Total Edits',
                        data: ${JSON.stringify(dailyEdits)},
                        borderColor: '#667eea',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 3,
                        pointBackgroundColor: '#667eea',
                        borderDash: [5, 5]
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            usePointStyle: true,
                            padding: 20,
                            font: { size: 15 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += context.parsed.y.toLocaleString();
                                }
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            font: { size: 13 }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            font: { size: 13 }
                        }
                    }
                }
            }
        });

        // Chart: Cumulative changes over time
        const ctxCumulative = document.getElementById('cumulativeChart').getContext('2d');
        const cumulativeChart = new Chart(ctxCumulative, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(dailyDates)},
                datasets: [
                    {
                        label: '📈 Total Added (Cumulative)',
                        data: ${JSON.stringify(cumulativeAddedData)},
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.15)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.3,
                        pointRadius: 3,
                        pointBackgroundColor: '#10b981',
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2
                    },
                    {
                        label: '📉 Total Deleted (Cumulative)',
                        data: ${JSON.stringify(cumulativeDeletedData)},
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.15)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.3,
                        pointRadius: 3,
                        pointBackgroundColor: '#ef4444',
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2
                    },
                    {
                        label: '🎯 Total Edits (Cumulative)',
                        data: ${JSON.stringify(cumulativeEditsData)},
                        borderColor: '#667eea',
                        backgroundColor: 'transparent',
                        borderWidth: 3,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 4,
                        pointBackgroundColor: '#667eea',
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2,
                        borderDash: [5, 5]
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            usePointStyle: true,
                            padding: 20,
                            font: { size: 15 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += context.parsed.y.toLocaleString();
                                }
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            font: { size: 13 }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            font: { size: 11 },
                            callback: function(value) {
                                return value.toLocaleString();
                            }
                        }
                    }
                }
            }
        });
    </script>
</body>
</html>`;

        const outputPath = path.join(process.cwd(), 'repo-stats.html');
        fs.writeFileSync(outputPath, html);
        console.log(`✅ HTML chart generated: ${outputPath}`);
        console.log(`   Open in browser: file://${outputPath}`);
    }
}

// Run the analyzer
const analyzer = new RepoAnalyzer();
analyzer.analyzeGitLog();
analyzer.generateCharts();
