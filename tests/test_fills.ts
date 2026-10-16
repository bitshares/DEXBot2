console.log('Starting test for listening to filled orders...');

const RUN_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS === '1';
const STRICT_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS_STRICT === '1';
const OVERALL_TIMEOUT_MS = Number(process.env.BITSHARES_FILL_LISTENER_TEST_TIMEOUT_MS) || 10000;

if (!RUN_LIVE_TEST) {
    console.log('Skipping live fill-listener test.');
    console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
    process.exit(0);
}

const { listenForFills } = require('../modules/chain_orders');
const { getErrorMessage } = require('../modules/utils/errors');

let TEST_ACCOUNT = '1.2.12345';
try {
    const live = require('../profiles/bots.json');
    // prefer a bot declared with a preferredAccount in live settings
    const bot = (live.bots || []).find(b => !!b.preferredAccount) || (live.bots || [])[0];
    if (bot && bot.preferredAccount) TEST_ACCOUNT = bot.preferredAccount;
} catch (e) {}

console.log(`Listening for fills on account ${TEST_ACCOUNT}. Waiting briefly and then exiting.`);

let unsub;
const forceExit = setTimeout(() => {
    const message = `live fill-listener test timed out after ${OVERALL_TIMEOUT_MS}ms`;
    try {
        if (typeof unsub === 'function') unsub();
    } catch (_) {}
    if (!STRICT_LIVE_TEST) {
        console.log(`Skipping live fill-listener test: ${message}`);
        process.exit(0);
        return;
    }
    console.error(message);
    process.exit(1);
}, OVERALL_TIMEOUT_MS);
(async () => {
    try {
        unsub = await listenForFills(TEST_ACCOUNT, (fills) => {
            console.log('🎯 Fill detected!');
            fills.forEach((fillOp, index) => {
                const fill = fillOp.op[1]; // The fill operation details
                console.log(`Fill ${index + 1}:`);
                console.log(`  Order ID: ${fill.order_id}`);
                console.log(`  Pays: ${fill.pays.amount} of ${fill.pays.asset_id}`);
                console.log(`  Receives: ${fill.receives.amount} of ${fill.receives.asset_id}`);
                console.log(`  Fill Price: ${fill.fill_price.base.amount} ${fill.fill_price.base.asset_id} / ${fill.fill_price.quote.amount} ${fill.fill_price.quote.asset_id}`);
                console.log('---');
            });
        });
    } catch (err) {
        clearTimeout(forceExit);
        if (!STRICT_LIVE_TEST) {
            console.log('Skipping live fill-listener test: live connectivity not available.');
            console.log('Error:', getErrorMessage(err) || err);
            process.exit(0);
            return;
        }
        console.error('listenForFills error:', getErrorMessage(err) || err);
        process.exit(1);
    }
})();

setTimeout(() => {
    clearTimeout(forceExit);
    try {
        if (typeof unsub === 'function') unsub();
    } catch (e) {}
    console.log('\nStopping listener (test timeout)');
    process.exit(0);
}, 1000);
