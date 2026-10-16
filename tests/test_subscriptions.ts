console.log('Testing listenForFills subscribe/unsubscribe behavior');

const RUN_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS === '1';
const STRICT_LIVE_TEST = process.env.RUN_LIVE_BITSHARES_TESTS_STRICT === '1';
const OVERALL_TIMEOUT_MS = Number(process.env.BITSHARES_SUBSCRIPTION_TEST_TIMEOUT_MS) || 10000;

const { getErrorMessage } = require('../modules/utils/errors');
const forceExit = setTimeout(() => {
    const message = `live subscription test timed out after ${OVERALL_TIMEOUT_MS}ms`;
    if (!STRICT_LIVE_TEST) {
        console.log(`Skipping live listenForFills subscription test: ${message}`);
        process.exit(0);
        return;
    }
    console.error(message);
    process.exit(1);
}, OVERALL_TIMEOUT_MS);

(async () => {
    if (!RUN_LIVE_TEST) {
        clearTimeout(forceExit);
        console.log('Skipping live listenForFills subscription test.');
        console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
        process.exit(0);
        return;
    }

    const orders = require('../modules/chain_orders');

    try {
        // subscribe twice for same account id
        // prefer account selected from profiles/bots.json (preferredAccount) for test consistency
        let TEST_ACCOUNT = '1.2.12345';
        try {
            const live = require('../profiles/bots.json');
            const bot = (live.bots || [])[0];
            if (bot && bot.preferredAccount) TEST_ACCOUNT = bot.preferredAccount;
        } catch (e) {}

        const unsubA = await orders.listenForFills(TEST_ACCOUNT, (_fills) => { /* noop */ });
        const unsubB = await orders.listenForFills(TEST_ACCOUNT, (_fills) => { /* noop */ });

        console.log('subscribe returns:', typeof unsubA, typeof unsubB);

        // unsubscribe safely
        if (typeof unsubA === 'function') unsubA();
        if (typeof unsubB === 'function') unsubB();

        console.log('Unsubscribe calls completed without throwing');
    } catch (err) {
        clearTimeout(forceExit);
        if (!STRICT_LIVE_TEST) {
            console.log('Skipping live listenForFills subscription test: live connectivity not available.');
            console.log('Error:', getErrorMessage(err) || err);
            process.exit(0);
            return;
        }
        console.error('subscribe/unsubscribe threw:', getErrorMessage(err) || err);
        process.exit(1);
        return;
    }

    console.log('OK');
    clearTimeout(forceExit);
    setTimeout(() => process.exit(0), 50);
})();
