/**
 * @enum {string}
 */
import type { AccountOrdersLike } from '../types.js';
import { getErrorMessage } from '../utils/errors.js';
const PROCESSED_FILL_PERSISTENCE_MODES: { readonly IMMEDIATE: string; readonly BATCHED: string; readonly MANUAL: string } = Object.freeze({
    IMMEDIATE: 'immediate',
    BATCHED: 'batched',
    MANUAL: 'manual'
});

/**
 * Resolve the processed fill persistence mode from options.
 * @param {Object} [options] - Options object
 * @param {string} [options.persistenceMode] - Explicit persistence mode
 * @returns {string} Resolved persistence mode ('immediate', 'batched', or 'manual')
 */
function resolveProcessedFillPersistenceMode(options: { persistenceMode?: string } = {}): string {
    if (options?.persistenceMode === PROCESSED_FILL_PERSISTENCE_MODES.BATCHED) {
        return PROCESSED_FILL_PERSISTENCE_MODES.BATCHED;
    }
    if (options?.persistenceMode === PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE) {
        return PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE;
    }
    if (options?.persistenceMode === PROCESSED_FILL_PERSISTENCE_MODES.MANUAL) {
        return PROCESSED_FILL_PERSISTENCE_MODES.MANUAL;
    }
    return PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE;
}

/**
 * @class
 */
class ProcessedFillStore {
    tracker: Map<string, number>;
    pendingWrites: Map<string, number> = new Map();
    _batchMs: number | undefined;
    _batchSize: number | undefined;
    _warn: (msg: string) => void;
    _persistTimer: ReturnType<typeof setTimeout> | null;
    _flushPromise: Promise<void>;
    _accountOrders: AccountOrdersLike | null;
    _shuttingDown: boolean;

    /**
     * Create a ProcessedFillStore instance.
     * @param {unknown} [options] - Configuration
     * @param {number} [options.batchMs] - Batch interval in ms for coalesced writes
     * @param {number} [options.batchSize] - Max batch size before auto-flush
     * @param {Function} [options.warn] - Warning logger function
     */
    constructor({
        batchMs,
        batchSize,
        warn
    }: { batchMs?: number; batchSize?: number; warn?: (msg: string) => void } = {}) {
        this.tracker = new Map();
        this.pendingWrites = new Map();
        this._batchMs = batchMs;
        this._batchSize = batchSize;
        this._warn = typeof warn === 'function' ? warn : () => {};
        this._persistTimer = null;
        this._flushPromise = Promise.resolve();
        this._accountOrders = null;
        this._shuttingDown = false;
    }

    /**
     * Configure the store with an AccountOrders instance.
     * @param {Object} [options] - Configuration options
     * @param {Object} [options.accountOrders] - AccountOrders instance for persistence
     */
    configure({ accountOrders }: { accountOrders?: AccountOrdersLike } = {}): void {
        this._accountOrders = accountOrders || null;
    }

    /**
     * Set the shutting down flag to prevent delayed writes during shutdown.
     * @param {boolean} value - Shutting down flag
     */
    setShuttingDown(value: boolean): void {
        this._shuttingDown = value === true;
    }

    /**
     * Load persisted fill records from disk into the in-memory tracker.
     * @param {Object} [options] - Load options
     * @param {boolean} [options.forceReload=false] - Force reload from disk
     * @param {number|null} [options.minTimestamp=null] - Minimum timestamp filter
     * @returns {number} Number of persisted entries loaded
     */
    loadPersisted({ forceReload = false, minTimestamp = null }: { forceReload?: boolean; minTimestamp?: number | null } = {}): number {
        if (!this._accountOrders) return 0;

        const persistedFills = this._accountOrders.loadProcessedFills({
            forceReload,
            minTimestamp
        });

        for (const [fillKey, timestamp] of persistedFills) {
            const existing = this.tracker.get(fillKey);
            if (existing === undefined || timestamp > existing) {
                this.tracker.set(fillKey, timestamp);
            }
        }

        return persistedFills.size;
    }

    /**
     * Merge entries from a source Map into the in-memory tracker.
     * @param {Map<string, number>} sourceTracker - Source fill tracker to merge
     */
    mergeTracker(sourceTracker: Map<string, number>): void {
        if (!(sourceTracker instanceof Map) || sourceTracker === this.tracker) return;

        for (const [fillKey, timestamp] of sourceTracker) {
            const existing = this.tracker.get(fillKey);
            if (existing === undefined || timestamp > existing) {
                this.tracker.set(fillKey, timestamp);
            }
        }
    }

    /**
     * Persist a single fill key with deduplication.
     * Queues the write and flushes immediately unless mode is BATCHED or MANUAL.
     * @param {string} fillKey - Fill deduplication key
     * @param {number} timestamp - Processing timestamp
     * @param {Object} [options] - Persist options
     * @param {string} [options.mode='immediate'] - Persistence mode
     * @returns {Promise<void>}
     */
    async persist(fillKey: string, timestamp: number, { mode = PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE }: { mode?: string } = {}): Promise<void> {
        if (!this._accountOrders || !fillKey) return;

        if (mode === PROCESSED_FILL_PERSISTENCE_MODES.MANUAL) {
            this._queue(fillKey, timestamp, { schedule: false });
            return;
        }
        this._queue(fillKey, timestamp);
        if (mode === PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE) {
            await this.flush('fill-persist', { throwOnError: true });
        }
    }

    /**
     * Discard a pending write from the queue.
     * @param {string} fillKey - Fill key to discard
     * @param {number} [timestamp] - Only discard if queued timestamp <= this value
     */
    discard(fillKey: string, timestamp?: number): void {
        const queuedTimestamp = this.pendingWrites.get(fillKey);
        if (queuedTimestamp === undefined) return;
        if (timestamp !== undefined && queuedTimestamp > timestamp) return;
        this.pendingWrites.delete(fillKey);
    }

    /**
     * Flush all pending writes to persistent storage.
     * @param {string} [reason='manual'] - Reason label for logging
     * @param {Object} [options] - Flush options
     * @param {boolean} [options.throwOnError=false] - Re-throw on flush failure
     * @returns {Promise<void>}
     */
    async flush(reason: string = 'manual', { throwOnError = false }: { throwOnError?: boolean } = {}): Promise<void> {
        if (this._persistTimer) {
            clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }

        if (!this._accountOrders) {
            await this._flushPromise;
            return;
        }

        if (this.pendingWrites.size === 0) {
            await this._flushPromise;
            return;
        }

        const batch = new Map(this.pendingWrites);
        this.pendingWrites.clear();
        await this._flushBatch(batch, reason, throwOnError, 'processed');
    }

    /**
     * Flush pending writes for specific fill keys.
     * @param {string[]|Set<string>} fillKeys - Fill keys to flush
     * @param {string} [reason='manual-selected'] - Reason label for logging
     * @param {Object} [options] - Flush options
     * @param {boolean} [options.throwOnError=false] - Re-throw on flush failure
     * @returns {Promise<void>}
     */
    async flushKeys(fillKeys: string[] | Set<string>, reason: string = 'manual-selected', { throwOnError = false }: { throwOnError?: boolean } = {}): Promise<void> {
        const keySet = fillKeys instanceof Set ? fillKeys : new Set(fillKeys || []);
        if (keySet.size === 0) return;

        if (!this._accountOrders) {
            return;
        }

        const batch = new Map();
        for (const fillKey of keySet) {
            if (!fillKey || !this.pendingWrites.has(fillKey)) continue;
            batch.set(fillKey, this.pendingWrites.get(fillKey));
            this.pendingWrites.delete(fillKey);
        }

        await this._flushBatch(batch, reason, throwOnError, 'selected processed');
    }

    /**
     * Persist a batch of already-dequeued fills, re-queuing entries when the
     * write fails. Shared by flush() and flushKeys() so the retry/back-off
     * path cannot drift apart.
     * @param {Map<string, number>} batch - Dequeued fill keys to persist
     * @param {string} reason - Reason label for logging
     * @param {boolean} throwOnError - Re-throw on flush failure
     * @param {string} descriptor - Noun describing the batch in the failure log
     * @returns {Promise<void>}
     */
    async _flushBatch(batch: Map<string, number>, reason: string, throwOnError: boolean, descriptor: string): Promise<void> {
        if (batch.size === 0) {
            await this._flushPromise;
            return;
        }

        let flushError: unknown = null;

        const flushWork = async () => {
            try {
                await this._accountOrders!.updateProcessedFillsBatch(batch);
            } catch (err) {
                flushError = err;
                for (const [fillKey, timestamp] of batch) {
                    const queuedTimestamp = this.pendingWrites.get(fillKey);
                    if (queuedTimestamp === undefined || timestamp > queuedTimestamp) {
                        this.pendingWrites.set(fillKey, timestamp);
                    }
                }
                this._warn(`[FILL-DEDUP] Failed to flush ${batch.size} ${descriptor} fill record(s) (${reason}): ${getErrorMessage(err)}`);
                this._schedule();
            }
        };

        this._flushPromise = this._flushPromise.then(flushWork, flushWork);
        await this._flushPromise;
        if (flushError && throwOnError) {
            throw flushError;
        }
    }

    /**
     * Queue a fill key for batched persistence.
     * @param {string} fillKey - Fill deduplication key
     * @param {number} timestamp - Processing timestamp
     * @param {Object} [options] - Queue options
     * @param {boolean} [options.schedule=true] - Schedule auto-flush timer
     * @private
     */
    _queue(fillKey: string, timestamp: number, { schedule = true }: { schedule?: boolean } = {}): void {
        const existing = this.pendingWrites.get(fillKey);
        if (existing === undefined || timestamp > existing) {
            this.pendingWrites.set(fillKey, timestamp);
        }

        if (!schedule) return;

        if (this._batchSize !== undefined && this.pendingWrites.size >= this._batchSize) {
            void this.flush('batch-size');
            return;
        }

        this._schedule();
    }

    /**
     * Schedule a delayed flush if not already scheduled.
     * @private
     */
    _schedule(): void {
        if (this._persistTimer || this._shuttingDown || this.pendingWrites.size === 0) return;

        const batchMs = Number(this._batchMs);
        if (Number.isFinite(batchMs)) {
            this._persistTimer = setTimeout(() => {
                this._persistTimer = null;
                void this.flush('timer');
            }, batchMs);
        } else {
            void this.flush('timer');
        }
    }
}

export { ProcessedFillStore, PROCESSED_FILL_PERSISTENCE_MODES, resolveProcessedFillPersistenceMode }

