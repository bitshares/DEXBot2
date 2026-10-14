const assert = require('assert');

const { withTimeout } = require('../modules/order/utils/timeout');

async function testRejectsOnTimeout() {
    // A never-settling promise is enough to outlive the timeout; using a 200 ms
    // timer would keep the event loop alive after the assertion.
    const slow = new Promise<string>(() => {});
    await assert.rejects(
        () => withTimeout(slow, 10),
        (err: any) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes('Timed out after 10ms'));
            return true;
        }
    );
}

async function testRejectsWithLabel() {
    const slow = new Promise<string>(() => {});
    await assert.rejects(
        () => withTimeout(slow, 10, { label: 'fetchAccount' }),
        (err: any) => {
            assert.ok(err.message.includes('fetchAccount timed out after 10ms'));
            return true;
        }
    );
}

async function testResolvesBeforeTimeout() {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 5));
    const result = await withTimeout(fast, 2000);
    assert.strictEqual(result, 'ok');
}

async function testResolveModeReturnsDefault() {
    const slow = new Promise<string>(() => {});
    const result = await withTimeout(slow, 10, { onTimeout: 'resolve', defaultValue: 'fallback' });
    assert.strictEqual(result, 'fallback');
}

async function testResolveModeSwallowsLateRejection() {
    const bad = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('boom')), 5));
    // Should not throw — .catch is attached internally
    const result = await withTimeout(bad, 10, { onTimeout: 'resolve', defaultValue: 'safe' });
    assert.strictEqual(result, 'safe');
}

async function testOnTimeoutCallbackFires() {
    let callbackFired = false;
    const slow = new Promise<void>(() => {});
    await withTimeout(slow, 10, {
        onTimeout: 'resolve',
        defaultValue: undefined as any,
        onTimeoutCallback: () => { callbackFired = true; },
    });
    assert.ok(callbackFired, 'onTimeoutCallback should have been called');
}

async function testOnTimeoutCallbackThrowDoesNotCrash() {
    const slow = new Promise<void>(() => {});
    // Should not throw despite callback throwing
    const result = await withTimeout(slow, 10, {
        onTimeout: 'resolve',
        defaultValue: 'ok',
        onTimeoutCallback: () => { throw new Error('callback boom'); },
    });
    assert.strictEqual(result, 'ok');
}

async function testRejectModeCallbackThrowPropagates() {
    const slow = new Promise<void>(() => {});
    // In reject mode, a callback throw should be swallowed (non-fatal) and
    // the timeout Error should still be thrown.
    await assert.rejects(
        () => withTimeout(slow, 10, {
            onTimeoutCallback: () => { throw new Error('callback boom'); },
        }),
        (err: any) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes('Timed out after 10ms'));
            return true;
        }
    );
}

async function testTimerCleanupOnSuccess() {
    const fast = Promise.resolve('immediate');
    const result = await withTimeout(fast, 5000);
    assert.strictEqual(result, 'immediate');
    // If timer leaks, this test may show open handle warnings.
    // Give a small delay to let any leaked timer fire.
    await new Promise((r) => setTimeout(r, 20));
}

async function testTimerCleanupOnRejection() {
    const bad = Promise.reject(new Error('fail'));
    await assert.rejects(
        () => withTimeout(bad, 5000),
        (err: any) => err.message === 'fail'
    );
    await new Promise((r) => setTimeout(r, 20));
}

async function run() {
    const tests = [
        testRejectsOnTimeout,
        testRejectsWithLabel,
        testResolvesBeforeTimeout,
        testResolveModeReturnsDefault,
        testResolveModeSwallowsLateRejection,
        testOnTimeoutCallbackFires,
        testOnTimeoutCallbackThrowDoesNotCrash,
        testRejectModeCallbackThrowPropagates,
        testTimerCleanupOnSuccess,
        testTimerCleanupOnRejection,
    ];
    let passed = 0;
    let failed = 0;
    for (const test of tests) {
        try {
            await test();
            console.log(`  ✓ ${test.name}`);
            passed++;
        } catch (err: any) {
            console.error(`  ✗ ${test.name}: ${err.message}`);
            failed++;
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run();
