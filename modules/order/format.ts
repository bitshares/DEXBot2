/**
 * modules/order/format.ts - Numeric formatting utilities
 *
 * Centralized formatting utilities for consistent decimal precision display across logs and output.
 * All functions return strings formatted to specified decimal places.
 *
 * ===============================================================================
 * DECIMAL PRECISION STANDARDS
 * ===============================================================================
 *
 * Asset Amounts:                8 decimals  - blockchain native precision
 * Prices:                       6-8 decimals - price precision varies by pair
 * Percentages:                  1-4 decimals - display precision
 * Ratios/Metrics:               2-5 decimals - context dependent
 * Time/Performance (ms, %):     1-2 decimals - readable metrics
 *
 * ===============================================================================
 * TABLE OF CONTENTS (15 exported functions)
 * ===============================================================================
 *
 * SECTION 1: ASSET FORMATTING (4 functions)
 *   1. formatAmount8(value) - Format to 8 decimals (blockchain standard)
 *   2. formatAmount(value, decimals) - Format with custom decimal places
 *   3. formatAmountByPrecision(value, precision) - Format using chain precision
 *   4. formatSizeByOrderType(value, orderType, assets) - Format order size by BUY/SELL asset precision
 *
 * SECTION 2: PRICE & FUNDS FORMATTING (5 functions)
 *   5. formatPrice(value) - Format to 8 decimals (maximum precision)
 *   6. formatPrice6(value) - Format to 6 decimals
 *   7. formatPrice4(value) - Format to 4 decimals (simplified display)
 *   8. formatCurrency(value, digits) - Grouped thousands with SI micro-suffixes
 *   9. formatFundsValue(value) - Compact K/M, 4 significant figures (keeps trailing zeros)
 *
 * SECTION 3: PERCENTAGE FORMATTING (2 functions)
 *   10. formatPercent2(value) - Format to 2 decimals (spread %, ratios)
 *   11. formatPercent(value, decimals) - Format with custom decimal places
 *
 * SECTION 4: RATIO/METRIC FORMATTING (1 function)
 *   12. formatMetric2(value) - Format to 2 decimals (timing, performance)
 *
 * SECTION 5: HELPER UTILITIES (4 functions)
 *   13. isValidNumber(value) - Check if value is defined and finite
 *   14. toFiniteNumber(value, defaultValue) - Convert to finite number with fallback
 *   15. positiveOrNull(value) - Convert to a strictly-positive number, else null
 *   16. safeFormat(value, decimals, fallback) - Safely format with fallback
 *
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: ASSET FORMATTING
// ===============================================================================

/**
 * Format asset amounts to 8 decimal places (blockchain standard)
 * Used for: Asset amounts, order sizes
 *
 * @param {number} value - The value to format
 * @returns {string} Formatted value to 8 decimals
 */
function formatAmount8(value: number): string {
	return safeFormat(value, 8);
}

/**
 * Format asset amounts with custom decimal places
 *
 * @param {number} value - The value to format
 * @param {number} [decimals=8] - Number of decimal places (default 8)
 * @returns {string} Formatted value
 */
function formatAmount(value: number, decimals: number = 8): string {
	return safeFormat(value, decimals);
}

/**
 * Format asset amount using an explicit blockchain precision.
 * Throws if precision is invalid — no silent fallback.
 *
 * @param {number} value - The value to format
 * @param {number} precision - Asset precision to apply
 * @returns {string} Formatted value
 */
function formatAmountByPrecision(value: number, precision: number | undefined): string {
	if (precision === undefined || !Number.isInteger(precision) || precision < 0) {
		throw new Error(`Invalid precision for formatAmountByPrecision: ${precision}`);
	}
	return safeFormat(value, precision);
}

/**
 * Format an order size using market-side precision.
 * BUY size is in assetB units, SELL size is in assetA units.
 * Throws if precision is unavailable — no silent fallback.
 *
 * @param {number} value - The value to format
 * @param {string} orderType - Order side ('buy' or 'sell')
 * @param {Object} assets - Asset metadata with assetA/assetB precision
 * @returns {string} Formatted value
 */
function formatSizeByOrderType(value: number, orderType: string, assets: { assetA?: { precision?: number }; assetB?: { precision?: number } }): string {
	const side = String(orderType || '').toLowerCase();
	const buyPrecision = assets?.assetB?.precision;
	const sellPrecision = assets?.assetA?.precision;
	const precision = side === 'buy' ? buyPrecision : side === 'sell' ? sellPrecision : undefined;
	return formatAmountByPrecision(value, precision);
}

// ===============================================================================
// SECTION 2: PRICE & FUNDS FORMATTING
// ===============================================================================

/**
 * Format prices to 8 decimal places (maximum precision)
 * Used for: order prices, market prices
 *
 * @param {number} value - The price to format
 * @returns {string} Formatted price to 8 decimals
 */
function formatPrice(value: number): string {
	return formatAmount8(value);
}

function formatPrice6(value: number): string {
	return safeFormat(value, 6);
}

function formatPrice4(value: number): string {
	return safeFormat(value, 4);
}

/**
 * Format a number with SI micro-value suffixes for very small values,
 * otherwise formats with significant digits and comma grouping.
 * Examples: 1234.56 -> "1,235", 0.00567 -> "5.67m", 0.00000123 -> "1.23µ"
 *
 * @param {number} value - The value to format
 * @param {number} digits - Number of significant digits (default 4)
 * @returns {string} Formatted value with suffix if small
 */
function formatCurrency(value: number, digits: number = 4): string {
	if (!isValidNumber(value)) return 'N/A';
	const num = Number(value);
	if (num === 0) return '0';
	const abs = Math.abs(num);
	if (abs < 0.1) {
		if (abs >= 0.001) return formatCurrency(num * 1000, digits) + 'm';
		if (abs >= 0.000001) return formatCurrency(num * 1000000, digits) + 'µ';
		if (abs >= 1e-9) return formatCurrency(num * 1e9, digits) + 'n';
		if (abs >= 1e-12) return formatCurrency(num * 1e12, digits) + 'p';
		if (abs >= 1e-15) return formatCurrency(num * 1e15, digits) + 'f';
		if (abs >= 1e-18) return formatCurrency(num * 1e18, digits) + 'a';
		return safeFormat(num, 6);
	}
	let intDigits = Math.floor(Math.log10(abs)) + 1;
	if (abs < 1) intDigits = 1;
	const formatted: string = intDigits >= digits
		? String(Math.round(num))
		: num.toFixed(digits - intDigits);
	return intDigits >= 4
		? formatted.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
		: formatted;
}

/**
 * Format a value with compact K/M notation and exactly 4 significant figures
 * for values that have more than 4. Unlike `formatCurrency`, this caps the
 * significant digits of large magnitudes (e.g. a volume of 19,423,608.6 ->
 * "19.42M") instead of keeping every integer digit, and it KEEPS significant
 * trailing zeros rather than trimming them (1009.794 -> "1.010K", not "1.01K").
 * Examples:
 *   194395   -> "194.4K"
 *   1009.794 -> "1.010K"
 *   10000    -> "10.00K"
 *   1000     -> "1.000K"
 *   332.33   -> "332.3"
 *   10.389   -> "10.39"
 *   1500000  -> "1.500M"
 * @param {number} value
 * @returns {string}
 */
function formatFundsValue(value: number): string {
	if (!Number.isFinite(value)) return 'N/A';
	if (value === 0) return '0';
	const digits = 4;
	const absValue = Math.abs(value);

	let quotient: number;
	let suffix = '';
	if (absValue >= 1000000) {
		quotient = value / 1000000;
		suffix = 'M';
	} else if (absValue >= 1000) {
		quotient = value / 1000;
		suffix = 'K';
	} else {
		quotient = value;
	}

	const absQ = Math.abs(quotient);
	const intDigits = Math.floor(Math.log10(Math.max(absQ, 1e-10))) + 1;
	const formatted = intDigits >= digits
		? String(Math.round(quotient))
		: quotient.toFixed(digits - intDigits);

	return formatted + suffix;
}

// ===============================================================================
// SECTION 3: PERCENTAGE FORMATTING
// ===============================================================================

/**
 * Format percentages to 2 decimal places
 * Used for: spread %, ratios, simple percentages
 *
 * @param {number} value - The percentage value (0-100 or decimal 0-1)
 * @returns {string} Formatted percentage to 2 decimals
 */
function formatPercent2(value: number): string {
	return safeFormat(value, 2);
}

function formatPercent(value: number, decimals: number = 2): string {
	return safeFormat(value, decimals);
}

// ===============================================================================
// SECTION 4: RATIO/METRIC FORMATTING
// ===============================================================================

/**
 * Format metric to 2 decimal places
 *
 * @param {number} value - The metric value
 * @returns {string} Formatted metric
 */
function formatMetric2(value: number): string {
	return formatPercent2(value);
}

// ===============================================================================
// SECTION 5: HELPER UTILITIES
// ===============================================================================

/**
 * Check if a value is defined and represents a finite number.
 * @param {*} value - Value to check
 * @returns {boolean} True if value is defined and finite
 */
function isValidNumber(value: unknown): boolean {
	return value !== null && value !== undefined && Number.isFinite(Number(value));
}

/**
 * Safely convert a value to a finite number.
 *
 * IMPORTANT: passing `undefined` as defaultValue triggers the TS default of 0.
 * Pass `null` explicitly to get `null` back for non-finite values.
 */
function toFiniteNumber(value: unknown, defaultValue?: number): number;
function toFiniteNumber(value: unknown, defaultValue: number | null): number | null;
function toFiniteNumber(value: unknown, defaultValue: number | null = 0): number | null {
	const num = Number(value);
	return Number.isFinite(num) ? num : defaultValue;
}

/**
 * Convert a value to a strictly-positive finite number, else `null`.
 *
 * Single home for the `positiveOrNull` guard previously duplicated in
 * cr_planner and credit_pricing. Zero, negatives, non-finite values and
 * non-numeric strings all yield `null`.
 */
function positiveOrNull(value: unknown): number | null {
	const num = Number(value);
	return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Safely format a numeric value with specified decimals and fallback.
 *
 * @param {*} value - The value to format
 * @param {number} decimals - Number of decimal places
 * @param {string} [fallback='N/A'] - Fallback value if format fails
 * @returns {string} Formatted value or fallback string
 */
function safeFormat(value: unknown, decimals: number, fallback: string = 'N/A'): string {
	try {
		if (!isValidNumber(value)) {
			return fallback;
		}
		return Number(value).toFixed(decimals);
	} catch (e) {
		return fallback;
	}
}

// ===============================================================================
// EXPORTS
// ===============================================================================

export { formatAmount8, formatAmount, formatAmountByPrecision, formatSizeByOrderType, formatPrice, formatPrice6, formatPrice4, formatCurrency, formatFundsValue, formatPercent2, formatPercent, formatMetric2, isValidNumber, toFiniteNumber, positiveOrNull, safeFormat }

