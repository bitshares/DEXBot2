'use strict';

/**
 * modules/order/logger_state.ts - Logger State Manager
 *
 * State tracking engine for change detection and audit logging.
 * Exports a single LoggerState class that enables smart logging by detecting state changes.
 *
 * Purpose:
 * - Track previous funds state across state transitions
 * - Detect and report what changed between state transitions
 * - Determine if logging is needed (only log when values change)
 * - Maintain audit history of state changes
 *
 * Used by Logger to:
 * - Skip redundant logging when nothing changed
 * - Only output on significant state transitions
 * - Maintain audit trail for debugging
 *
 * ===============================================================================
 * TABLE OF CONTENTS - LoggerState Class (3 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor() - Create new LoggerState with empty previousState
 *      Initializes tracking for: funds
 *
 * CHANGE DETECTION (1 method)
 *   2. detectChanges(category, current) - Detect changes between previous and current state
 *      Returns { isNew: boolean, changes: Object } with detailed change information
 *
 * INTERNAL UTILITIES (1 method)
 *   3. _deepDiff(prev, current) - Deep diff between two objects
 *      Recursively compares objects, detects all changes and deletions
 *      Returns Object with format: { key: { from: oldVal, to: newVal } }
 *
 * ===============================================================================
 *
 * STATE CATEGORIES:
 * - funds: Available, committed, total, cache, and fee tracking
 *
 * CHANGE DETECTION ALGORITHM:
 * 1. First call: Returns { isNew: true, changes: current } and stores state
 * 2. Subsequent calls: Compares with stored state using _deepDiff
 * 3. _deepDiff: Recursively compares all keys, detects additions/deletions
 * 4. Returns: { isNew: false, changes: { key: { from, to } } }
 *
 * ===============================================================================
 *
 * @class
 */

class LoggerState {
    previousState: Record<string, unknown>;

    constructor() {
        this.previousState = {
            funds: null
        };
    }

    /**
     * Detect what changed between previous and current state
     * @param {string} category - Category name (funds)
     * @param {Object} current - Current state object
     * @returns {Object} { isNew: boolean, changes: Object }
     */
    detectChanges(category: string, current: Record<string, unknown>) {
        const prev = this.previousState[category];
        if (!prev) {
            this.previousState[category] = { ...current };
            return { isNew: true, changes: current };
        }

        const changes = this._deepDiff(prev as Record<string, unknown>, current);
        this.previousState[category] = { ...current };
        return { isNew: false, changes };
    }

    /**
     * Deep diff between two objects
     * Detects all changes recursively
     * @param {Object} prev - Previous state
     * @param {Object} current - Current state
     * @returns {Object} Object with keys that changed
     * @private
     */
    _deepDiff(prev: Record<string, unknown>, current: Record<string, unknown>) {
        const diff: Record<string, unknown> = {};

        // Check all keys in current
        for (const key in current) {
            if (JSON.stringify(prev[key]) !== JSON.stringify(current[key])) {
                diff[key] = { from: prev[key], to: current[key] };
            }
        }

        // Check for deleted keys
        for (const key in prev) {
            if (!(key in current)) {
                diff[key] = { from: prev[key], to: undefined };
            }
        }

        return diff;
    }
}

export default LoggerState
