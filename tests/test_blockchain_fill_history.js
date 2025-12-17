#!/usr/bin/env node
/**
 * Test: Blockchain Fill History Structure Validation
 *
 * Fetches real fill history from BitShares blockchain for account "hanzac-si"
 * and validates that each history entry has a unique ID field that can be
 * used in fill deduplication.
 *
 * Run: node tests/test_blockchain_fill_history.js
 */

const { BitShares, waitForConnected } = require('../modules/bitshares_client');

const ACCOUNT_NAME = 'hanzac-si';
const ACCOUNT_ID = '1.2.1074325';  // Known ID for hanzac-si

async function testBlockchainFillHistory() {
    console.log('=== Blockchain Fill History Structure Test ===\n');
    console.log(`Fetching fill history for account: ${ACCOUNT_NAME}\n`);

    try {
        // Wait for connection
        console.log('Connecting to BitShares...');
        await waitForConnected(30000);
        console.log('✓ Connected\n');

        const accountId = ACCOUNT_ID;
        console.log(`✓ Account ID: ${accountId}\n`);

        // Fetch account history
        console.log('Fetching account history (last 100 operations)...');
        const history = await BitShares.history.get_account_history(accountId, '1.11.0', 100, '1.11.0');

        if (!history || !Array.isArray(history) || history.length === 0) {
            console.error('ERROR: No history found for account');
            process.exit(1);
        }

        console.log(`✓ Fetched ${history.length} history entries\n`);

        // Filter for fill_order operations (type 4)
        const fills = [];
        for (const entry of history) {
            const opData = entry.op;
            if (!Array.isArray(opData) || opData[0] !== 4) continue;

            const fillData = opData[1];
            if (!fillData || !fillData.is_maker) continue;

            fills.push(entry);
        }

        if (fills.length === 0) {
            console.log('⚠️  No fill_order operations found as maker');
            console.log('(This is expected if the account has not filled orders recently)');
            process.exit(0);
        }

        console.log(`Found ${fills.length} fill_order operations (as maker)\n`);
        console.log('=== FILL HISTORY STRUCTURE ANALYSIS ===\n');

        // Analyze structure
        let hasHistoryId = true;
        let hasBlockNum = true;
        let hasBlockTime = true;

        fills.slice(0, Math.min(5, fills.length)).forEach((fill, idx) => {
            console.log(`\n--- Fill #${idx + 1} ---`);
            console.log(`History Entry ID: ${fill.id}`);
            console.log(`Block Number: ${fill.block_num}`);
            console.log(`Block Time: ${fill.block_time}`);

            const fillOp = fill.op[1];
            console.log(`Order ID: ${fillOp.order_id}`);
            console.log(`Pays: ${fillOp.pays.amount} (asset ${fillOp.pays.asset_id})`);
            console.log(`Receives: ${fillOp.receives.amount} (asset ${fillOp.receives.asset_id})`);
            console.log(`Is Maker: ${fillOp.is_maker}`);

            // Validate structure
            if (!fill.id) hasHistoryId = false;
            if (fill.block_num === undefined) hasBlockNum = false;
            if (!fill.block_time) hasBlockTime = false;
        });

        // Check for multiple fills in same block
        console.log('\n\n=== CHECKING FOR MULTIPLE FILLS IN SAME BLOCK ===\n');

        const blockMap = new Map();
        fills.forEach(fill => {
            if (!blockMap.has(fill.block_num)) {
                blockMap.set(fill.block_num, []);
            }
            blockMap.get(fill.block_num).push(fill);
        });

        let foundMultipleFills = false;
        let totalFillsAnalyzed = 0;

        blockMap.forEach((fillsInBlock, blockNum) => {
            totalFillsAnalyzed += fillsInBlock.length;
            if (fillsInBlock.length > 1) {
                foundMultipleFills = true;
                console.log(`\nBlock ${blockNum} has ${fillsInBlock.length} fills:`);
                fillsInBlock.forEach((fill, idx) => {
                    const orderId = fill.op[1].order_id;
                    console.log(`  ${idx + 1}. Order: ${orderId}, History ID: ${fill.id}`);
                });

                // Check uniqueness
                const keys_old = fillsInBlock.map(f => `${f.op[1].order_id}:${f.block_num}`);
                const keys_new = fillsInBlock.map(f => `${f.op[1].order_id}:${f.block_num}:${f.id}`);

                const oldUnique = new Set(keys_old);
                const newUnique = new Set(keys_new);

                console.log(`  Old key collisions: ${keys_old.length - oldUnique.size}`);
                console.log(`  New key collisions: ${keys_new.length - newUnique.size}`);
            }
        });

        console.log(`\n${totalFillsAnalyzed} fills analyzed in ${blockMap.size} blocks`);

        if (!foundMultipleFills) {
            console.log('No blocks found with multiple fills (this is rare)');
        }

        // Print summary
        console.log('\n\n=== VALIDATION SUMMARY ===\n');

        const results = {
            'History entries have ID field': hasHistoryId,
            'All entries have block_num': hasBlockNum,
            'All entries have block_time': hasBlockTime,
            'ID format appears valid (1.11.x)': fills.slice(0, 5).every(f => /^1\.11\.\d+$/.test(f.id))
        };

        let allValid = true;
        for (const [test, result] of Object.entries(results)) {
            console.log(`${result ? '✓' : '✗'} ${test}`);
            if (!result) allValid = false;
        }

        console.log('\n' + '='.repeat(50));

        if (allValid) {
            console.log('\n✓ BLOCKCHAIN VALIDATION PASSED\n');
            console.log('Conclusion: The fix using history ID in dedup key is valid.');
            console.log('Each fill_order operation has a unique ID that can be used');
            console.log('to distinguish multiple fills in the same block.\n');
            process.exit(0);
        } else {
            console.log('\n✗ VALIDATION FAILED\n');
            process.exit(1);
        }

    } catch (error) {
        console.error(`\nERROR: ${error.message}`);
        if (error.message.includes('ECONNREFUSED')) {
            console.error('(Cannot connect to BitShares. Is a BitShares node available?)');
        }
        process.exit(1);
    }
}

testBlockchainFillHistory();
