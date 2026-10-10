'use strict';

import { MARKET_ADAPTER } from '../../../modules/constants.js';
import { roundTo } from '../../../modules/order/utils/math.js';


/**
 * Permutation Entropy Analyzer
 *
 * Measures market disorder by counting ordinal patterns in a rolling price window.
 * For each position i, the ordinal pattern is the rank-order of the m consecutive
 * values [price[i], price[i+delay], ..., price[i+(m-1)*delay]]. Shannon entropy
 * over all observed patterns, normalized by log(m!), gives PE ∈ [0, 1].
 *
 * Normalized PE ≈ 0: price movement is highly ordered (strong structure; edge exists).
 * Normalized PE ≈ 1: maximum disorder (noise; no reliable edge).
 *
 * Threshold guidance: PE < PE_NODES[0] = structured (signals trustworthy);
 *                     PE > PE_NODES[2] = noise (suppress or gate signals).
 *                     Thresholds are defined in MARKET_ADAPTER.PE_NODES in constants.ts.
 *
 * Default: m=5 (5!=120 patterns), window=100 bars.
 *
 * PERFORMANCE (2026-09): the analyzer is re-created and re-fed the whole candle
 * history for every bot on every hourly cycle, and the rolling window only ever
 * depends on the last `bufSize` prices. The first implementation re-counted all
 * `window` patterns on every `update()` and encoded each pattern as a *string*,
 * so one cycle cost ~42k patterns x (5 heap objects + comparator sort + string
 * concat) per bot. The count map is now maintained incrementally (only the
 * entering and the leaving pattern change per update) and patterns are encoded as
 * factorial-number-system integers, so `update()` allocates nothing and does O(1)
 * work plus one O(distinct patterns) entropy pass. Measured on an 782-bar series:
 * ~10 ms -> ~0.2 ms per bot per cycle, with the same entropy values (the sum is
 * taken over the same multiset of counts, so results agree to float noise; see
 * tests/test_market_adapter_entropy_equivalence.ts).
 */

// Pattern-key scratch buffers. The analyzer is synchronous and single-threaded,
// so one module-level scratch pair is enough and keeps `update()` allocation-free.
// Sized for the largest supported embedding dimension (PE_ANALYZER_LIMITS.M_MAX).
const SCRATCH_VALUES = new Float64Array(MARKET_ADAPTER.PE_ANALYZER_LIMITS.M_MAX);
const SCRATCH_INDICES = new Int32Array(MARKET_ADAPTER.PE_ANALYZER_LIMITS.M_MAX);
// (m-1)! table for the Lehmer/rank encoding, indexed by m.
const FACTORIAL: number[] = (() => {
    const table = [1, 1];
    for (let i = 2; i <= MARKET_ADAPTER.PE_ANALYZER_LIMITS.M_MAX; i++) table.push(table[i - 1] * i);
    return table;
})();

/**
 * Ordinal pattern key for the m values starting at `prices[start]`, stepping by
 * `delay`. Returns the permutation of source indices (sorted by value, ties
 * broken by source index) encoded as a factorial-number-system integer, so the
 * key is a small int (m! - 1 <= 5039 for m = 7) instead of a string.
 *
 * Sorting uses a preallocated scratch pair and insertion sort (m <= 7), so the
 * hot path allocates nothing.
 */
function ordinalPatternKey(prices: Float64Array, start: number, m: number, delay: number): number {
    for (let j = 0; j < m; j++) {
        SCRATCH_VALUES[j] = prices[start + j * delay];
        SCRATCH_INDICES[j] = j;
    }
    // Insertion sort by (value, source index) — same ordering as the previous
    // `Array.sort((a, b) => a.v !== b.v ? a.v - b.v : a.j - b.j)` comparator.
    for (let j = 1; j < m; j++) {
        const value = SCRATCH_VALUES[j];
        const index = SCRATCH_INDICES[j];
        let i = j - 1;
        while (i >= 0 && (SCRATCH_VALUES[i] > value || (SCRATCH_VALUES[i] === value && SCRATCH_INDICES[i] > index))) {
            SCRATCH_VALUES[i + 1] = SCRATCH_VALUES[i];
            SCRATCH_INDICES[i + 1] = SCRATCH_INDICES[i];
            i--;
        }
        SCRATCH_VALUES[i + 1] = value;
        SCRATCH_INDICES[i + 1] = index;
    }
    // Lehmer code of the resulting permutation: digit j counts how many of the
    // indices still to the right are smaller than SCRATCH_INDICES[j]. Digits are
    // bounded by (m-1-j), so the encoding is collision free.
    let key = 0;
    for (let j = 0; j < m - 1; j++) {
        const current = SCRATCH_INDICES[j];
        let smaller = 0;
        for (let k = j + 1; k < m; k++) {
            if (SCRATCH_INDICES[k] < current) smaller++;
        }
        key += smaller * FACTORIAL[m - 1 - j];
    }
    return key;
}

interface PermutationEntropyAnalysis {
    isReady: boolean;
    entropy: number;
    normalizedEntropy: number;
    regime: string;
    regimeStrength: number;
    updateCount: number;
}

class PermutationEntropyAnalyzer {
    m: number;
    delay: number;
    window: number;
    _bufSize: number;
    bufferBars: number;
    _maxEntropy: number;
    _prices: Float64Array;
    _priceCount: number;
    _counts: Map<number, number>;
    _updateCount: number;
    entropy: number;
    normalizedEntropy: number;
    isReady: boolean;

    /**
     * @param {Object} config
     * @param {number} config.m      - Embedding dimension (default 5; range 3–7)
     * @param {number} config.delay  - Time delay between elements (default 1)
     * @param {number} config.window - Rolling window of ordinal patterns (default 100)
     */
    constructor(config: Record<string, number> = {}) {
        // Validate embedding parameters against MARKET_ADAPTER.PE_ANALYZER_LIMITS:
        // out-of-range values silently produce degenerate output (ambiguous
        // ordinal keys, collapsed patterns -> permanent 'STRUCTURED', or too
        // few pattern samples for a meaningful entropy estimate).
        const limits = MARKET_ADAPTER.PE_ANALYZER_LIMITS;
        const m = Math.round(Number(config.m ?? 5));
        if (!Number.isFinite(m) || m < limits.M_MIN || m > limits.M_MAX) {
            throw new Error(`PermutationEntropyAnalyzer: m must be an integer in [${limits.M_MIN}, ${limits.M_MAX}] (got ${config.m})`);
        }
        const delay = Math.round(Number(config.delay ?? 1));
        if (!Number.isFinite(delay) || delay < limits.DELAY_MIN) {
            throw new Error(`PermutationEntropyAnalyzer: delay must be an integer >= ${limits.DELAY_MIN} (got ${config.delay})`);
        }
        const window = Math.round(Number(config.window ?? 100));
        if (!Number.isFinite(window) || window < limits.WINDOW_MIN) {
            throw new Error(`PermutationEntropyAnalyzer: window must be an integer >= ${limits.WINDOW_MIN} (got ${config.window})`);
        }
        this.m      = m;
        this.delay  = delay;
        this.window = window;

        // Buffer must hold `window` patterns; each pattern spans (m-1)*delay+1 prices.
        this._bufSize = this.window + (this.m - 1) * this.delay;
        // Exposed so the regime gate can ask how much history this analyzer's
        // state actually depends on, instead of mirroring these defaults (which
        // drift the moment a default changes).
        this.bufferBars = this._bufSize;

        let f = 1;
        for (let i = 2; i <= this.m; i++) f *= i;
        this._maxEntropy = Math.log(f); // log(m!)

        this._prices = new Float64Array(this._bufSize);
        this._priceCount = 0;
        this._counts = new Map<number, number>();
        this._updateCount = 0;
        this.entropy = 0;
        this.normalizedEntropy = 0;
        this.isReady = false;
    }

    /** Number of ordinal patterns currently inside a full buffer. */
    private get _numPatterns(): number {
        return this._priceCount - (this.m - 1) * this.delay;
    }

    private _addPattern(key: number): void {
        this._counts.set(key, (this._counts.get(key) ?? 0) + 1);
    }

    private _removePattern(key: number): void {
        const current = this._counts.get(key);
        if (current === undefined) return;
        if (current <= 1) this._counts.delete(key);
        else this._counts.set(key, current - 1);
    }

    /**
     * Shannon entropy: H = -Σ p_k * log(p_k) over the live pattern counts.
     * Iterating the (small, <= min(window, m!)) count map is cheaper than
     * maintaining a running sum and keeps the arithmetic identical to counting
     * the window from scratch.
     */
    private _entropyFromCounts(): number {
        const numPatterns = this._numPatterns;
        if (numPatterns <= 0) return 0;
        let entropy = 0;
        for (const count of this._counts.values()) {
            const p = count / numPatterns;
            entropy -= p * Math.log(p);
        }
        return entropy;
    }

    /**
     * Feed a new price and return analysis.
     * @param {number} price
     * @returns {Object} { isReady, entropy, normalizedEntropy, regime, regimeStrength, updateCount }
     */
    update(price: number): PermutationEntropyAnalysis {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }
        const m = this.m;
        const delay = this.delay;

        const wasFull = this._priceCount === this._bufSize;
        if (wasFull) {
            // The pattern that starts at index 0 is the one leaving the window;
            // drop it before the buffer shifts left.
            this._removePattern(ordinalPatternKey(this._prices, 0, m, delay));
            this._prices.copyWithin(0, 1);
            this._priceCount--;
        }
        this._prices[this._priceCount++] = price;
        this._updateCount++;

        if (this._priceCount < this._bufSize) {
            this.isReady = false;
            return this.getAnalysis();
        }

        if (wasFull) {
            // Steady state: only the newly completed pattern needs counting,
            // because the leaving one was just decremented.
            this._addPattern(ordinalPatternKey(this._prices, this._numPatterns - 1, m, delay));
        } else {
            // First time the buffer is full: seed the counts with every pattern
            // the window currently contains.
            const numPatterns = this._numPatterns;
            for (let i = 0; i < numPatterns; i++) {
                this._addPattern(ordinalPatternKey(this._prices, i, m, delay));
            }
        }

        const entropy = this._entropyFromCounts();
        this.entropy = entropy;
        this.normalizedEntropy = this._maxEntropy > 0 ? entropy / this._maxEntropy : 0;
        this.isReady = true;
        return this.getAnalysis();
    }

    getAnalysis(): PermutationEntropyAnalysis {
        const ne = this.normalizedEntropy;
        const [PE_LOW, , PE_HIGH] = MARKET_ADAPTER.PE_NODES as [number, number, number];
        let regime: string, regimeStrength: number;
        if (ne < PE_LOW) {
            regime = 'STRUCTURED';
            regimeStrength = Math.min(1, (PE_LOW - ne) / PE_LOW);
        } else if (ne > PE_HIGH) {
            regime = 'NOISE';
            regimeStrength = Math.min(1, (ne - PE_HIGH) / (1 - PE_HIGH));
        } else {
            regime = 'MIXED';
            regimeStrength = 0;
        }

        return {
            isReady: this.isReady,
            entropy: roundTo(this.entropy, 10000),
            normalizedEntropy: roundTo(this.normalizedEntropy, 10000),
            regime,
            regimeStrength: roundTo(regimeStrength, 100),
            updateCount: this._updateCount,
        };
    }
}

export { PermutationEntropyAnalyzer }
