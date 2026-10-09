/*
 * tests/test_autoderive.ts
 * New clean test that exercises auto-derive behavior against the inverted
 * `modules/order/utils/system.ts`. It uses the first active bot from `profiles/bots.json`.
 *
 * The test does not suppress logs or errors. It short-circuits price
 * derivation via the compiled-ESM-safe `setDerivePriceTestHook` seam and
 * verifies the derived `startPrice` is numeric.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Hermetic profile fixture: this test derives a grid from the first active bot
// in bots.json. Point the profile root at a temp dir so it never depends on the
// machine's repo/home profiles layout (see modules/paths.ts).
const TEST_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-autoderive-'));
process.env.DEXBOT_PROFILE_ROOT = TEST_PROFILE_ROOT;
fs.writeFileSync(path.join(TEST_PROFILE_ROOT, 'bots.json'), JSON.stringify({
    bots: [{ name: 'TEST-BOT', active: true, startPrice: 'book', assetA: 'TESTA', assetB: 'TESTB' }],
}));

const { PATHS } = require('../modules/paths');
const { getErrorMessage } = require('../modules/utils/errors');

async function runAutoderiveForBot(botCfg) {
    console.log('Running autoderive for bot:', botCfg.name || '(unnamed)');

    // Compiled ESM exports cannot be monkey-patched; use the test hook to
    // short-circuit derivePrice so initializeGrid resolves a deterministic
    // startPrice fully offline.
    const systemModule = require('../modules/order/utils/system');
    systemModule.setDerivePriceTestHook(async () => 150);

    try {
        const { OrderManager, grid: Grid } = require('../modules/order').default;
        const assetA = botCfg.assetA; const assetB = botCfg.assetB;
        if (!assetA || !assetB) throw new Error('Bot configuration missing assetA/assetB');

        // Override minPrice/maxPrice with bounds around the hooked derived
        // price. The hook resolves to 150, so a tight window keeps the grid
        // small (a handful of slots) while still guaranteeing startPrice
        // lands inside the bounds — no need for absurd 1e-12/1e12 windows
        // that generate ~18k grid slots and blow up test runtime.
        const cfg = Object.assign({}, botCfg, {
            startPrice: botCfg.startPrice || 'book',
            minPrice: 100,
            maxPrice: 200
        });

        const manager = new OrderManager(cfg);
        manager.assets = {
            assetA: { id: '1.3.100', symbol: assetA, precision: 3 },
            assetB: { id: '1.3.101', symbol: assetB, precision: 3 },
        };
        await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

        await Grid.initializeGrid(manager);

        const derived = Number(manager.config.startPrice);
        console.log('Derived startPrice =', derived);
        assert(Number.isFinite(derived), 'Derived startPrice must be a number');
        console.log('Autoderive assertion passed for bot', botCfg.name || '(unnamed)');
    } finally {
        systemModule.setDerivePriceTestHook(null);
    }
}

async function main() {
    try {
        const botsFile = PATHS.PROFILES.BOTS_JSON;
        const liveSettings = JSON.parse(fs.readFileSync(botsFile, 'utf8'));
        const bots = liveSettings.bots || [];
        if (!bots.length) throw new Error('No bots defined in profiles/bots.json');

        // Use the first active bot, or fallback to first bot entry
        const active = bots.find(b => b.active === true) || bots[0];
        if (!active) throw new Error('No active bot found and no bots available');

        await runAutoderiveForBot(active);
        console.log('Autoderive test completed successfully');
        fs.rmSync(TEST_PROFILE_ROOT, { recursive: true, force: true });
        process.exit(0);
    } catch (err) {
        console.error('Autoderive test failed:', err && (err as any).stack ? (err as any).stack : getErrorMessage(err));
        fs.rmSync(TEST_PROFILE_ROOT, { recursive: true, force: true });
        process.exit(2);
    }
}

main();
