// Playwright config for the browser chart tests. Written as a plain object
// (no `@playwright/test` import) so it loads under a globally-installed
// Playwright without a local dev dependency.
//
// Firefox is the default target: it is the browser the generated charts are
// hand-checked in, and it exercises a different canvas/compositor path than
// Chromium. Override with `--project` only if a project is added later.
export default {
    testDir: '.',
    // Chart draws are heavy and the two canvases share state; keep one worker.
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    outputDir: '../../test-results',
    use: {
        browserName: 'firefox',
        viewport: { width: 1400, height: 900 },
    },
};
