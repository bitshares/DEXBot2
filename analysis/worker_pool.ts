'use strict';

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

interface ModuleWorkerOptions<TResult> {
    /**
     * Called for each non-final worker message. The final message (the one for
     * which `resolveOn` returns `done: true`) is not forwarded.
     */
    onProgress?: (msg: unknown) => void;
    /**
     * Inspect a worker message. Return `{ done: true, value }` to resolve the
     * worker promise, or `{ done: false }` to keep waiting.
     */
    resolveOn: (msg: unknown) => { done: true; value: TResult } | { done: false };
}

/**
 * Run a single worker thread whose entry module is the caller itself.
 *
 * ESM has no `__filename`, so the worker entry is resolved from the caller's
 * `import.meta.url` — the caller passes its own `import.meta.url`. The worker
 * module must branch on `isMainThread` to run its handler and should let the
 * thread exit naturally after `parentPort.postMessage`: an explicit
 * `process.exit(0)` can race the message flush and silently drop the result
 * (this was duplicated in optimizer_high_resolution and backtest_ama_sweep).
 *
 * Rejects on `error`, on a non-zero `exit` code, and on a clean exit that never
 * posted a resolvable result (previously that case hung forever).
 */
function runModuleWorker<TResult>(
    callerModuleUrl: string,
    workerData: unknown,
    { onProgress, resolveOn }: ModuleWorkerOptions<TResult>,
): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        const worker = new Worker(fileURLToPath(callerModuleUrl), { workerData });
        worker.on('message', (msg) => {
            const outcome = resolveOn(msg);
            if (outcome.done) {
                settled = true;
                resolve(outcome.value);
                return;
            }
            if (onProgress) onProgress(msg);
        });
        worker.on('error', (err) => {
            settled = true;
            reject(err);
        });
        worker.on('exit', (code) => {
            if (settled) return;
            if (code !== 0) {
                settled = true;
                reject(new Error(`Worker exited with code ${code}`));
                return;
            }
            // Defer so a final `message` already in flight is processed first;
            // only a genuinely result-less clean exit rejects.
            setImmediate(() => {
                if (settled) return;
                settled = true;
                reject(new Error('Worker exited without posting a result'));
            });
        });
    });
}

/**
 * Split `values` into at most `shardCount` contiguous, roughly equal chunks.
 * Empty chunks are dropped. Single home for the copy in optimizer_high_resolution.
 */
function splitIntoShards<T>(values: T[], shardCount: number): T[][] {
    const out: T[][] = [];
    const size = Math.ceil(values.length / shardCount);
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size));
    }
    return out.filter((s) => s.length > 0);
}

export { runModuleWorker, splitIntoShards };
