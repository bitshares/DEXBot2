// Must be before any require() due to config caching trap
const ORIG_ENV: Record<string, string | undefined> = {};
for (const k of ['DEXBOT_PROFILE_ROOT', 'DEXBOT2_ROOT', 'DEXBOT_MARKET_ADAPTER_DATA_DIR', 'DEXBOT_MARKET_ADAPTER_STATE_DIR', 'DEXBOT_CLAW_DATA_DIR', 'DEXBOT_ANALYSIS_DIR', 'XDG_CONFIG_HOME'] as const) {
    ORIG_ENV[k] = process.env[k];
    delete process.env[k];
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('Running paths tests');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-test-paths-'));

// ── Test helpers ────────────────────────────────────────────────────────

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(keys: readonly string[]): EnvSnapshot {
    const snap: EnvSnapshot = {};
    for (const k of keys) snap[k] = process.env[k];
    return snap;
}

function restoreEnv(snap: EnvSnapshot) {
    for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

// Clear paths module from cache so the next require() re-evaluates
function freshPaths() {
    delete require.cache[require.resolve('../modules/paths')];
    // Also clear config.ts since paths depends on it
    delete require.cache[require.resolve('../modules/config')];
    return require('../modules/paths');
}

let passed = 0;
let total = 0;

function check(label: string, ok: boolean, detail?: string) {
    total++;
    if (ok) { passed++; console.log(`  ✓ ${label}`); }
    else console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── 1) DEXBOT_PROFILE_ROOT env var → returned directly ─────────────────
try {
    const testRoot1 = fs.mkdtempSync(path.join(tmpRoot, 'root-test-'));
    process.env.DEXBOT_PROFILE_ROOT = testRoot1;

    const p1 = freshPaths();
    const got1 = typeof p1.resolveProfilesDir === 'function' ? p1.resolveProfilesDir() : p1.PATHS.PROFILES_DIR;
    check('DEXBOT_PROFILE_ROOT takes priority',
        got1 === testRoot1,
        `expected ${testRoot1}, got ${got1}`);
} finally {
    restoreEnv({ DEXBOT_PROFILE_ROOT: ORIG_ENV.DEXBOT_PROFILE_ROOT });
}

// ── 2) DEXBOT2_ROOT env var → path/DEXBOT2_ROOT/profiles ───────────────
try {
    const testRoot2 = fs.mkdtempSync(path.join(tmpRoot, 'root2-test-'));
    process.env.DEXBOT2_ROOT = testRoot2;

    const p2 = freshPaths();
    const want = path.join(testRoot2, 'profiles');
    const got2 = typeof p2.resolveProfilesDir === 'function' ? p2.resolveProfilesDir() : p2.PATHS.PROFILES_DIR;
    check('DEXBOT2_ROOT appends /profiles',
        got2 === want,
        `expected ${want}, got ${got2}`);
} finally {
    restoreEnv({ DEXBOT2_ROOT: ORIG_ENV.DEXBOT2_ROOT });
}

// ── 3) Neither env var → ~/.config/dexbot2/profiles (fresh install) ────
// At this point both env vars are cleared (line 1) and never restored.
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'fresh-home-'));
    const fakeRoot = fs.mkdtempSync(path.join(tmpRoot, 'fresh-root-'));
    const emptyCwd = fs.mkdtempSync(path.join(tmpRoot, 'fresh-cwd-'));
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    process.env.HOME = fakeHome;
    try {
        process.chdir(emptyCwd);
        const p3 = freshPaths();
        const want = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
        check('fresh install defaults to ~/.config/dexbot2/profiles',
            p3.resolveProfilesDir(fakeRoot) === want,
            `expected ${want}, got ${p3.resolveProfilesDir(fakeRoot)}`);
    } finally {
        process.chdir(savedCwd);
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

// ── 3b) Legacy source checkout: repo profiles kept until home config ───
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'legacy-home-'));
    const fakeRoot = fs.mkdtempSync(path.join(tmpRoot, 'legacy-root-'));
    const repoProfiles = path.join(fakeRoot, 'profiles');
    fs.mkdirSync(repoProfiles, { recursive: true });
    fs.writeFileSync(path.join(repoProfiles, 'bots.json'), '{}');
    const emptyCwd = fs.mkdtempSync(path.join(tmpRoot, 'legacy-cwd-'));
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    process.env.HOME = fakeHome;
    try {
        process.chdir(emptyCwd);
        const p3b = freshPaths();
        check('legacy repo profiles kept until home config exists',
            p3b.resolveProfilesDir(fakeRoot) === repoProfiles,
            `expected ${repoProfiles}, got ${p3b.resolveProfilesDir(fakeRoot)}`);
    } finally {
        process.chdir(savedCwd);
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

// ── 3c) Home config wins once it exists (migration complete) ──────────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'migrated-home-'));
    const homeProfiles = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
    fs.mkdirSync(homeProfiles, { recursive: true });
    fs.writeFileSync(path.join(homeProfiles, 'bots.json'), '{}');
    const fakeRoot = fs.mkdtempSync(path.join(tmpRoot, 'migrated-root-'));
    const repoProfiles = path.join(fakeRoot, 'profiles');
    fs.mkdirSync(repoProfiles, { recursive: true });
    fs.writeFileSync(path.join(repoProfiles, 'bots.json'), '{}');
    const savedHome = process.env.HOME;
    const savedWarn = console.warn;
    process.env.HOME = fakeHome;
    console.warn = () => { };
    try {
        const p3c = freshPaths();
        check('home config wins once it exists',
            p3c.resolveProfilesDir(fakeRoot) === homeProfiles,
            `expected ${homeProfiles}, got ${p3c.resolveProfilesDir(fakeRoot)}`);
    } finally {
        console.warn = savedWarn;
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

// ── 3d) Legacy keys-only checkout kept (not treated as "fresh") ────────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'keysonly-home-'));
    const fakeRoot = fs.mkdtempSync(path.join(tmpRoot, 'keysonly-root-'));
    const repoProfiles = path.join(fakeRoot, 'profiles');
    fs.mkdirSync(repoProfiles, { recursive: true });
    fs.writeFileSync(path.join(repoProfiles, 'keys.json'), '{}');
    const emptyCwd = fs.mkdtempSync(path.join(tmpRoot, 'keysonly-cwd-'));
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    process.env.HOME = fakeHome;
    try {
        process.chdir(emptyCwd);
        const p3d = freshPaths();
        check('keys-only legacy checkout keeps repo profiles',
            p3d.resolveProfilesDir(fakeRoot) === repoProfiles,
            `expected ${repoProfiles}, got ${p3d.resolveProfilesDir(fakeRoot)}`);
    } finally {
        process.chdir(savedCwd);
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

// ── 4) resolveProfilesDir is exported ──────────────────────────────────
const p3 = freshPaths();
check('resolveProfilesDir is exported',
    typeof p3.resolveProfilesDir === 'function');

// ── 5) Exported function is callable and returns a string ──────────────
const dir = p3.resolveProfilesDir();
check('resolveProfilesDir returns a string',
    typeof dir === 'string' && dir.length > 0,
    dir);

// ── 6) isGlobalNpmPackageDir detection ────────────────────────────────
{
    const p6 = freshPaths();
    const npmLike = path.join(tmpRoot, 'node_modules', 'dexbot');
    check('isGlobalNpmPackageDir detects node_modules paths',
        p6.isGlobalNpmPackageDir(npmLike) === true);
    check('isGlobalNpmPackageDir rejects plain paths',
        p6.isGlobalNpmPackageDir(tmpRoot) === false);
}

// ── 7) Global npm install → home-based profiles default ──────────────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'npm-home-'));
    const homeProfiles = path.join(fakeHome, '.config', 'dexbot2', 'profiles');
    fs.mkdirSync(homeProfiles, { recursive: true });
    fs.writeFileSync(path.join(homeProfiles, 'bots.json'), '{}');
    const fakeNpmRoot = path.join(fakeHome, 'node_modules', 'dexbot');

    const savedHome = process.env.HOME;
    const savedWarn = console.warn;
    process.env.HOME = fakeHome;
    console.warn = () => { };
    try {
        const p7 = freshPaths();
        check('npm install defaults to ~/.config/dexbot2/profiles',
            p7.resolveProfilesDir(fakeNpmRoot) === homeProfiles,
            `expected ${homeProfiles}, got ${p7.resolveProfilesDir(fakeNpmRoot)}`);
    } finally {
        console.warn = savedWarn;
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

// ── 7b) npm install with cwd legacy profiles → cwd fallback ───────────
{
    const fakeHome = fs.mkdtempSync(path.join(tmpRoot, 'npm-cwd-home-'));
    const cwdRoot = fs.mkdtempSync(path.join(tmpRoot, 'npm-cwd-root-'));
    const cwdProfiles = path.join(cwdRoot, 'profiles');
    fs.mkdirSync(cwdProfiles, { recursive: true });
    fs.writeFileSync(path.join(cwdProfiles, 'bots.json'), '{}');
    const fakeNpmRoot = path.join(fakeHome, 'node_modules', 'dexbot');
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    process.env.HOME = fakeHome;
    try {
        process.chdir(cwdRoot);
        const p7b = freshPaths();
        check('npm install falls back to cwd profiles when no home config',
            p7b.resolveProfilesDir(fakeNpmRoot) === cwdProfiles,
            `expected ${cwdProfiles}, got ${p7b.resolveProfilesDir(fakeNpmRoot)}`);
    } finally {
        process.chdir(savedCwd);
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
    }
}

// ── 8) Market adapter dirs: source layout when profiles resolve to repo ──
{
    const p8 = freshPaths();
    const repoRoot = path.resolve(__dirname, '..');
    const repoProfiles = path.join(repoRoot, 'profiles');
    const ma = p8.resolveMarketAdapterDirs(repoProfiles, repoRoot);
    check('source checkout keeps PROJECT_ROOT/market_adapter data',
        ma.DATA_DIR === path.join(repoRoot, 'market_adapter', 'data'),
        ma.DATA_DIR);
    check('source checkout keeps PROJECT_ROOT/market_adapter state',
        ma.STATE_DIR === path.join(repoRoot, 'market_adapter', 'state'),
        ma.STATE_DIR);
}

// ── 8b) Fresh source checkout (home profiles) → MA follows profiles ─────
{
    const p8b = freshPaths();
    const repoRoot = path.resolve(__dirname, '..');
    const homeProfiles = path.join(tmpRoot, 'fresh-ma-home', '.config', 'dexbot2', 'profiles');
    const ma = p8b.resolveMarketAdapterDirs(homeProfiles, repoRoot);
    check('fresh source checkout relocates MA data under profiles',
        ma.DATA_DIR === path.join(homeProfiles, 'market_adapter', 'data'),
        ma.DATA_DIR);
    check('fresh source checkout relocates MA state under profiles',
        ma.STATE_DIR === path.join(homeProfiles, 'market_adapter', 'state'),
        ma.STATE_DIR);
}

// ── 9) Market adapter dirs: relocated under profiles for npm installs ─
{
    const p9 = freshPaths();
    const fakeNpmRoot = path.join(tmpRoot, 'node_modules', 'dexbot');
    const ma = p9.resolveMarketAdapterDirs(tmpRoot, fakeNpmRoot);
    const wantData = path.join(tmpRoot, 'market_adapter', 'data');
    const wantState = path.join(tmpRoot, 'market_adapter', 'state');
    check('npm install relocates market adapter data under profiles',
        ma.DATA_DIR === wantData,
        `expected ${wantData}, got ${ma.DATA_DIR}`);
    check('npm install relocates market adapter state under profiles',
        ma.STATE_DIR === wantState,
        `expected ${wantState}, got ${ma.STATE_DIR}`);
}

// ── 10) Market adapter dirs: env vars override everything ────────────
{
    const p10 = freshPaths();
    const cfg = require('../modules/config').Config;
    const dataOverride = path.join(tmpRoot, 'custom-ma-data');
    const stateOverride = path.join(tmpRoot, 'custom-ma-state');
    const savedData = cfg.DEXBOT_MARKET_ADAPTER_DATA_DIR;
    const savedState = cfg.DEXBOT_MARKET_ADAPTER_STATE_DIR;
    try {
        cfg.DEXBOT_MARKET_ADAPTER_DATA_DIR = dataOverride;
        cfg.DEXBOT_MARKET_ADAPTER_STATE_DIR = stateOverride;
        const ma = p10.resolveMarketAdapterDirs(tmpRoot, path.resolve(__dirname, '..'));
        check('DEXBOT_MARKET_ADAPTER_DATA_DIR overrides data root',
            ma.DATA_DIR === dataOverride,
            `expected ${dataOverride}, got ${ma.DATA_DIR}`);
        check('DEXBOT_MARKET_ADAPTER_STATE_DIR overrides state root',
            ma.STATE_DIR === stateOverride,
            `expected ${stateOverride}, got ${ma.STATE_DIR}`);
        check('LP dir derives from overridden data root',
            ma.LP_DATA_DIR === path.join(dataOverride, 'lp'));
    } finally {
        cfg.DEXBOT_MARKET_ADAPTER_DATA_DIR = savedData;
        cfg.DEXBOT_MARKET_ADAPTER_STATE_DIR = savedState;
    }
}

// ── 11) Claw data dirs: source layout when profiles resolve to repo ────
{
    const p11 = freshPaths();
    const repoRoot = path.resolve(__dirname, '..');
    const repoProfiles = path.join(repoRoot, 'profiles');
    const claw = p11.resolveClawDirs(repoProfiles, repoRoot);
    check('source checkout keeps PROJECT_ROOT/claw data',
        claw.DATA_DIR === path.join(repoRoot, 'claw', 'data'),
        claw.DATA_DIR);
    check('source checkout keeps positions under claw data',
        claw.POSITIONS_FILE === path.join(repoRoot, 'claw', 'data', 'positions.json'),
        claw.POSITIONS_FILE);
}

// ── 11b) Fresh source checkout (home profiles) → claw follows profiles ──
{
    const p11b = freshPaths();
    const repoRoot = path.resolve(__dirname, '..');
    const homeProfiles = path.join(tmpRoot, 'fresh-claw-home', '.config', 'dexbot2', 'profiles');
    const claw = p11b.resolveClawDirs(homeProfiles, repoRoot);
    check('fresh source checkout relocates claw data under profiles',
        claw.DATA_DIR === path.join(homeProfiles, 'claw', 'data'),
        claw.DATA_DIR);
    check('fresh source checkout relocates positions under profiles',
        claw.POSITIONS_FILE === path.join(homeProfiles, 'claw', 'data', 'positions.json'),
        claw.POSITIONS_FILE);
}

// ── 12) Claw data dirs: relocated under profiles for npm installs ────
{
    const p12 = freshPaths();
    const fakeNpmRoot = path.join(tmpRoot, 'node_modules', 'dexbot');
    const claw = p12.resolveClawDirs(tmpRoot, fakeNpmRoot);
    const wantData = path.join(tmpRoot, 'claw', 'data');
    check('npm install relocates claw data under profiles',
        claw.DATA_DIR === wantData,
        `expected ${wantData}, got ${claw.DATA_DIR}`);
    check('npm install relocates positions under profiles claw data',
        claw.POSITIONS_FILE === path.join(wantData, 'positions.json'),
        claw.POSITIONS_FILE);
    check('npm install keeps claw code at PROJECT_ROOT',
        claw.DIR === fakeNpmRoot + path.sep + 'claw',
        claw.DIR);
}

// ── 13) Claw data dir: env var overrides layout ─────────────────────
{
    const p13 = freshPaths();
    const cfg = require('../modules/config').Config;
    const dataOverride = path.join(tmpRoot, 'custom-claw-data');
    const saved = cfg.DEXBOT_CLAW_DATA_DIR;
    try {
        cfg.DEXBOT_CLAW_DATA_DIR = dataOverride;
        const claw = p13.resolveClawDirs(tmpRoot, path.resolve(__dirname, '..'));
        check('DEXBOT_CLAW_DATA_DIR overrides claw data root',
            claw.DATA_DIR === dataOverride,
            `expected ${dataOverride}, got ${claw.DATA_DIR}`);
        check('positions derive from overridden claw data root',
            claw.POSITIONS_FILE === path.join(dataOverride, 'positions.json'));
    } finally {
        cfg.DEXBOT_CLAW_DATA_DIR = saved;
    }
}

// ── 14) Relocation notice when MA/claw state would be orphaned ─────────
// A home config that relocates MA/claw away from the repo, while the repo
// still holds old state, must yield a warning so the user knows their claw
// positions / adapter state are no longer being read. Tested hermetically via
// the exported computeRelocationNotices() with fake fixtures (the module-load
// warning itself only fires when the real repo holds state, which is gitignored
// and absent on fresh clones/CI).
{
    const repoRoot = path.join(tmpRoot, 'reloc-repo');
    fs.mkdirSync(path.join(repoRoot, 'market_adapter', 'data'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'market_adapter', 'data', 'candles.json'), '{}');
    fs.mkdirSync(path.join(repoRoot, 'claw', 'data'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'claw', 'data', 'positions.json'), '{}');
    const homeProfiles = path.join(tmpRoot, 'reloc-home', '.config', 'dexbot2', 'profiles');
    // Old claw credit-runtime adapter double-joined the profiles segment
    // (profileRoot + '/profiles/credit_runtime'); simulate that orphan state.
    fs.mkdirSync(path.join(homeProfiles, 'profiles', 'credit_runtime'), { recursive: true });
    fs.writeFileSync(path.join(homeProfiles, 'profiles', 'credit_runtime', 'state.json'), '{}');

    const p14 = freshPaths();
    const notices = p14.computeRelocationNotices(homeProfiles, repoRoot);
    check('warns when MA/claw state would be orphaned by relocation',
        notices.some((n) => n.includes('Claw state exists') || n.includes('Market adapter state exists')),
        notices.join(' | '));
    check('warns when double-joined credit_runtime state would be orphaned',
        notices.some((n) => n.includes('Credit runtime state exists') && n.includes('profiles/credit_runtime')),
        notices.join(' | '));
    check('relocation notice names the new location and migration env vars',
        notices.every((n) => n.includes('set DEXBOT_')),
        notices.join(' | '));
    const quiet = p14.computeRelocationNotices(path.join(repoRoot, 'profiles'), repoRoot);
    check('no relocation notice when profiles stay at the repo layout',
        quiet.length === 0, quiet.join(' | '));

    // printRelocationNotices() must actually emit the same warnings (locks the
    // launcher-facing wrapper, not just the pure computation).
    const emitted: string[] = [];
    p14.printRelocationNotices(homeProfiles, repoRoot, (message) => emitted.push(message));
    check('printRelocationNotices emits the relocation warnings',
        emitted.length === notices.length
        && emitted.some((n) => n.includes('Claw state exists'))
        && emitted.some((n) => n.includes('Market adapter state exists')),
        emitted.join(' | '));
    const emittedQuiet: string[] = [];
    p14.printRelocationNotices(path.join(repoRoot, 'profiles'), repoRoot, (message) => emittedQuiet.push(message));
    check('printRelocationNotices stays silent in the normal layout',
        emittedQuiet.length === 0, emittedQuiet.join(' | '));
}

// ── 15) Analysis dirs: source layout keeps repo location ────────────
{
    const p15 = freshPaths();
    const repoRoot = path.resolve(__dirname, '..');
    const repoProfiles = path.join(repoRoot, 'profiles');
    const a = p15.resolveAnalysisDirs(repoProfiles, repoRoot);
    check('source checkout keeps PROJECT_ROOT/analysis outputs',
        a.DIR === path.join(repoRoot, 'analysis'),
        a.DIR);
    check('source checkout charts dir is PROJECT_ROOT/analysis/charts',
        a.CHARTS_DIR === path.join(repoRoot, 'analysis', 'charts'),
        a.CHARTS_DIR);
    check('source checkout results dir is PROJECT_ROOT/analysis/results',
        a.RESULTS_DIR === path.join(repoRoot, 'analysis', 'results'),
        a.RESULTS_DIR);
    check('vendored assets always stay at the code root',
        a.ASSETS_DIR === path.join(repoRoot, 'analysis', 'uplot'),
        a.ASSETS_DIR);
}

// ── 16) Analysis dirs: relocated under profiles for npm installs ─────
{
    const p16 = freshPaths();
    const fakeNpmRoot = path.join(tmpRoot, 'node_modules', 'dexbot');
    const a = p16.resolveAnalysisDirs(tmpRoot, fakeNpmRoot);
    const wantDir = path.join(tmpRoot, 'analysis');
    check('npm install relocates analysis outputs under profiles',
        a.DIR === wantDir,
        `expected ${wantDir}, got ${a.DIR}`);
    check('npm install charts dir follows relocated root',
        a.CHARTS_DIR === path.join(wantDir, 'charts'),
        a.CHARTS_DIR);
}

// ── 17) Analysis dirs: missing source dir → profiles layout ─────────
{
    const p17 = freshPaths();
    const fakeRoot = fs.mkdtempSync(path.join(tmpRoot, 'no-analysis-'));
    const a = p17.resolveAnalysisDirs(path.join(fakeRoot, 'profiles'), fakeRoot);
    check('non-source layout relocates analysis under profiles',
        a.DIR === path.join(fakeRoot, 'profiles', 'analysis'),
        a.DIR);
}

// ── 18) Analysis dirs: env var overrides layout ─────────────────────
{
    const p18 = freshPaths();
    const cfg = require('../modules/config').Config;
    const override = path.join(tmpRoot, 'custom-analysis');
    const saved = cfg.DEXBOT_ANALYSIS_DIR;
    try {
        cfg.DEXBOT_ANALYSIS_DIR = override;
        const a = p18.resolveAnalysisDirs(tmpRoot, path.resolve(__dirname, '..'));
        check('DEXBOT_ANALYSIS_DIR overrides analysis root',
            a.DIR === override,
            `expected ${override}, got ${a.DIR}`);
        check('charts derive from overridden analysis root',
            a.CHARTS_DIR === path.join(override, 'charts'));
    } finally {
        cfg.DEXBOT_ANALYSIS_DIR = saved;
    }
}

// ── 19) XDG_CONFIG_HOME overrides the user config base ──────────────
{
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const xdgBase = path.join(tmpRoot, 'xdg-base');
    process.env.XDG_CONFIG_HOME = xdgBase;
    try {
        const p19 = freshPaths();
        const gotHome = p19.getHomeProfilesDir();
        check('XDG_CONFIG_HOME redirects getHomeProfilesDir()',
            gotHome === path.join(xdgBase, 'dexbot2', 'profiles'),
            gotHome);
    } finally {
        if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = savedXdg;
    }
}

// ── Summary ────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${passed === total ? '✓' : '✗'} ${passed}/${total} paths tests passed`);
process.exit(passed === total ? 0 : 1);
