'use strict';

import { positiveOrNull, toFiniteNumber } from './order/format.js';

/**
 * modules/credit_pricing.ts — Canonical credit-pricing math (single source of truth).
 *
 * Pure functions only: no I/O, browser-safe; imports only the dependency-free
 * order/format number helpers. Both the live
 * credit runtime (modules/credit_runtime.ts) and the offline analyzer
 * (scripts/analyze-credit.ts) delegate to these helpers so offer-price
 * orientation, conversion rates, and collateral-ratio math cannot drift
 * apart between surfaces.
 *
 * Conventions (mirror the chain's credit_offer_object price layout):
 * - A 'core' price has base == debt asset / quote == collateral asset and
 *   the conversion rate (debt per 1 collateral) is base / quote.
 * - A 'legacy-reversed' price has base == collateral / quote == debt and
 *   the rate is quote / base. Unknown layouts default to 'core'.
 * - Credit CR = collateralValueInDebt / debtAmount, where
 *   collateralValueInDebt = collateralAmount * conversionRate.
 */

interface PriceLeg {
    amount?: unknown;
    asset_id?: unknown;
}

interface OfferPrice {
    base?: PriceLeg;
    quote?: PriceLeg;
}

/**
 * Tolerantly normalize an offer's acceptable_collateral map, which arrives
 * in different shapes depending on the API path (Map, [[id, price]] pairs,
 * [{key, value}] entries, or a plain {assetId: price} object).
 */
function normalizeCollateralMap(raw: unknown): Map<string, OfferPrice> {
    const out = new Map<string, OfferPrice>();
    if (raw instanceof Map) {
        for (const [key, value] of raw.entries()) {
            if (key && value) out.set(String(key), value as OfferPrice);
        }
        return out;
    }
    if (Array.isArray(raw)) {
        for (const entry of raw) {
            if (Array.isArray(entry) && entry.length >= 2 && entry[0] && entry[1]) {
                out.set(String(entry[0]), entry[1] as OfferPrice);
            } else if (entry && typeof entry === 'object') {
                const pair = entry as { key?: unknown; value?: unknown };
                if (pair.key && pair.value) out.set(String(pair.key), pair.value as OfferPrice);
            }
        }
        return out;
    }
    if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
            if (key && value) out.set(String(key), value as OfferPrice);
        }
    }
    return out;
}

function creditPriceOrientation(
    baseAssetId: string,
    quoteAssetId: string,
    debtAssetId: string,
    collateralAssetId: string,
): 'core' | 'legacy-reversed' {
    if (String(baseAssetId) === String(debtAssetId) && String(quoteAssetId) === String(collateralAssetId)) {
        return 'core';
    }
    if (String(baseAssetId) === String(collateralAssetId) && String(quoteAssetId) === String(debtAssetId)) {
        return 'legacy-reversed';
    }
    return 'core';
}

function priceLegToFloat(leg: PriceLeg | null | undefined, precision: number | null): number | null {
    const raw = toFiniteNumber(leg?.amount, null);
    if (raw === null || raw <= 0 || precision === null || !Number.isFinite(precision) || precision < 0) {
        return null;
    }
    const float = raw / Math.pow(10, precision);
    return float > 0 ? float : null;
}

/**
 * Extract the conversion rate (debt asset per 1 collateral unit) for a
 * collateral asset from an offer's acceptable_collateral map.
 *
 * @param offerCollateral - Raw acceptable_collateral in any supported shape
 * @param collateralAssetId - Collateral asset ID to look up
 * @param debtAssetId - Debt asset ID (determines price orientation)
 * @param precisionOf - (assetId) => precision, or null when unknown
 * @returns Debt-per-collateral rate, or null when not listed/unresolvable
 */
function extractOfferConversionRate(
    offerCollateral: unknown,
    collateralAssetId: string,
    debtAssetId: string,
    precisionOf: (assetId: string) => number | null,
): number | null {
    const map = normalizeCollateralMap(offerCollateral);
    const price = map.get(String(collateralAssetId));
    if (!price) return null;
    const baseId = String(price?.base?.asset_id || '');
    const quoteId = String(price?.quote?.asset_id || '');
    if (!baseId || !quoteId) return null;
    const orientation = creditPriceOrientation(baseId, quoteId, String(debtAssetId), String(collateralAssetId));
    const baseFloat = priceLegToFloat(price?.base, precisionOf(baseId));
    const quoteFloat = priceLegToFloat(price?.quote, precisionOf(quoteId));
    if (baseFloat === null || quoteFloat === null) return null;
    const rate = orientation === 'legacy-reversed' ? quoteFloat / baseFloat : baseFloat / quoteFloat;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Resolve the single offer price for a collateral asset. Accepts either the
 * full acceptable_collateral map (looked up by collateral asset ID) or the
 * bare { base, quote } price object the runtime already selected.
 */
function asOfferPrice(collateralPriceOrMap: unknown, collateralAssetId: string): OfferPrice | null {
    const hit = normalizeCollateralMap(collateralPriceOrMap).get(String(collateralAssetId));
    if (hit) return hit;
    const raw = collateralPriceOrMap as OfferPrice | null | undefined;
    if (raw && typeof raw === 'object' && raw.base && raw.quote) return raw;
    return null;
}

/**
 * Value collateral (raw int) in debt-asset units via an offer price.
 * Pure offer-math leg of the runtime's pool-aware valuation.
 */
function collateralValueFromOfferPrice(
    collateralAmountInt: unknown,
    collateralPrecision: unknown,
    collateralPriceOrMap: unknown,
    debtAssetId: string,
    collateralAssetId: string,
    precisionOf: (assetId: string) => number | null,
): number | null {
    const collRaw = toFiniteNumber(collateralAmountInt, null);
    const collPrec = toFiniteNumber(collateralPrecision, null);
    if (collRaw === null || collRaw <= 0 || collPrec === null) return null;
    const collateralFloat = collRaw / Math.pow(10, collPrec);
    if (!(collateralFloat > 0)) return null;
    const price = asOfferPrice(collateralPriceOrMap, collateralAssetId);
    if (!price) return null;
    const rate = extractOfferConversionRate({ [String(collateralAssetId)]: price }, collateralAssetId, debtAssetId, precisionOf);
    if (rate === null) return null;
    return collateralFloat * rate;
}

/**
 * Shared orientation resolution for the borrow/collateral conversion pair.
 * Validates the offer price amounts and returns the base/quote factors plus
 * the price orientation, so both directions cannot disagree on which way the
 * factor applies. Null when the price is missing or unusable.
 */
function resolvePriceFactors(
    collateralPrice: OfferPrice | null | undefined,
    debtAssetId: string | null,
    collateralAssetId: string | null,
): { baseAmount: number; quoteAmount: number; orientation: 'core' | 'legacy-reversed' } | null {
    const baseAmount = toFiniteNumber(collateralPrice?.base?.amount, null);
    const quoteAmount = toFiniteNumber(collateralPrice?.quote?.amount, null);
    if (baseAmount === null || quoteAmount === null || baseAmount <= 0 || quoteAmount <= 0) {
        return null;
    }
    const orientation = creditPriceOrientation(
        String(collateralPrice?.base?.asset_id || ''),
        String(collateralPrice?.quote?.asset_id || ''),
        String(debtAssetId || ''),
        String(collateralAssetId || ''),
    );
    return { baseAmount, quoteAmount, orientation };
}

/**
 * Convert a raw amount along the borrow<->collateral price ratio, applying the
 * price orientation and integer rounding direction. Shared by the two
 * conversions below so they cannot disagree on which factor applies; the two
 * directions are reciprocal, so `direction` flips the numerator/denominator.
 */
function convertAtPrice(
    amountInt: unknown,
    direction: 'debtToCollateral' | 'collateralToDebt',
    rounding: 'ceil' | 'floor',
    collateralPrice: OfferPrice | null | undefined,
    debtAssetId: string | null,
    collateralAssetId: string | null,
): number | null {
    const amount = toFiniteNumber(amountInt, null);
    const factors = resolvePriceFactors(collateralPrice, debtAssetId, collateralAssetId);
    if (amount === null || amount <= 0 || factors === null) return null;
    const { baseAmount, quoteAmount, orientation } = factors;
    const legacyNumerator = direction === 'debtToCollateral' ? baseAmount : quoteAmount;
    const legacyDenominator = direction === 'debtToCollateral' ? quoteAmount : baseAmount;
    const numerator = orientation === 'legacy-reversed' ? legacyNumerator : legacyDenominator;
    const denominator = orientation === 'legacy-reversed' ? legacyDenominator : legacyNumerator;
    const round = rounding === 'ceil' ? Math.ceil : Math.floor;
    return round((Number(amountInt) * numerator) / denominator);
}

/**
 * Minimum raw collateral required to borrow a raw debt amount at a price.
 * Integer ceil so the borrow is never under-collateralized by rounding.
 */
function requiredCollateralForBorrow(
    borrowAmountInt: unknown,
    collateralPrice: OfferPrice | null | undefined,
    debtAssetId: string | null = null,
    collateralAssetId: string | null = null,
): number | null {
    return convertAtPrice(borrowAmountInt, 'debtToCollateral', 'ceil', collateralPrice, debtAssetId, collateralAssetId);
}

/**
 * Raw debt yielded by raw collateral at a price. Integer floor so the
 * borrow never exceeds what the collateral covers.
 */
function borrowAmountForCollateral(
    collateralAmountInt: unknown,
    collateralPrice: OfferPrice | null | undefined,
    debtAssetId: string | null = null,
    collateralAssetId: string | null = null,
): number | null {
    return convertAtPrice(collateralAmountInt, 'collateralToDebt', 'floor', collateralPrice, debtAssetId, collateralAssetId);
}

/**
 * Raw debt yielded by a raw collateral budget, never exceeding the requested
 * raw debt. Returns `requestedBorrowInt` when no budget is supplied or the
 * budget already covers it; `null` when a supplied budget cannot support any
 * borrow at the offer price (caller should back off rather than emit a doomed
 * accept op).
 */
function capBorrowToCollateral(
    requestedBorrowInt: unknown,
    availableCollateralInt: unknown,
    collateralPrice: OfferPrice | null | undefined,
    debtAssetId: string | null = null,
    collateralAssetId: string | null = null,
): number | null {
    const requested = toFiniteNumber(requestedBorrowInt, null);
    if (requested === null || requested <= 0) return null;
    if (availableCollateralInt === null || availableCollateralInt === undefined) return requested;
    const budgetBorrow = borrowAmountForCollateral(availableCollateralInt, collateralPrice, debtAssetId, collateralAssetId);
    if (budgetBorrow === null || budgetBorrow <= 0) return null;
    return Math.min(requested, budgetBorrow);
}

/**
 * Per-deal CR from floats plus a conversion rate:
 * (collateralFloat * rate) / debtFloat.
 */
function creditDealCollateralRatio(
    debtFloat: unknown,
    collateralFloat: unknown,
    rate: unknown,
): number | null {
    const debt = positiveOrNull(debtFloat);
    const coll = toFiniteNumber(collateralFloat, null);
    const price = positiveOrNull(rate);
    if (debt === null || coll === null || coll < 0 || price === null) return null;
    return (coll * price) / debt;
}

/**
 * Value-weighted average CR = sum(collateral values) / sum(debts), so one
 * large deal correctly dominates many dust deals. Unpriced entries (null
 * debt/value) are skipped by the caller convention — entries with
 * non-positive debt are ignored here as well.
 */
function averageCollateralRatio(entries: Array<{ debt: unknown; value: unknown }>): number | null {
    let debtSum = 0;
    let valueSum = 0;
    for (const entry of entries || []) {
        const debt = positiveOrNull(entry?.debt);
        const value = toFiniteNumber(entry?.value, null);
        if (debt === null || value === null || value < 0) continue;
        debtSum += debt;
        valueSum += value;
    }
    if (!(debtSum > 0)) return null;
    return valueSum / debtSum;
}

/**
 * Flat offer fee prorated per day: (feeRate / denom) / (durationDays).
 * Returns 0 for missing/non-positive inputs (matches runtime gating, where
 * a zero daily rate never exceeds maxFeeRatePerDay).
 */
function dailyOfferFeeRate(offer: { fee_rate?: unknown; max_duration_seconds?: unknown } | null | undefined, feeDenom: unknown): number {
    const feeRate = toFiniteNumber(offer?.fee_rate, null);
    const maxDurationSeconds = toFiniteNumber(offer?.max_duration_seconds, null);
    const denom = toFiniteNumber(feeDenom, null);
    if (feeRate === null || maxDurationSeconds === null || denom === null || feeRate <= 0 || maxDurationSeconds <= 0 || denom <= 0) {
        return 0;
    }
    return (feeRate / denom) / (maxDurationSeconds / 86400);
}

/**
 * Credit-deal repay fee in raw debt units, rounded up (Graphene ceil):
 * (repay * feeRate + denom - 1) / denom. Zero when nothing is owed.
 */
function creditDealFee(repayAmountInt: unknown, feeRate: unknown, feeDenom: unknown): number {
    const repayRaw = toFiniteNumber(repayAmountInt, null);
    const rateRaw = toFiniteNumber(feeRate, null);
    const denomRaw = toFiniteNumber(feeDenom, null);
    if (repayRaw === null || rateRaw === null || denomRaw === null || denomRaw <= 0) return 0;
    const repay = BigInt(Math.max(0, Math.trunc(repayRaw)));
    const rate = BigInt(Math.max(0, Math.trunc(rateRaw)));
    const denom = BigInt(Math.max(1, Math.trunc(denomRaw)));
    if (repay <= 0n || rate <= 0n) return 0;
    return Number(((repay * rate) + denom - 1n) / denom);
}

export {
    normalizeCollateralMap,
    creditPriceOrientation,
    extractOfferConversionRate,
    collateralValueFromOfferPrice,
    requiredCollateralForBorrow,
    borrowAmountForCollateral,
    capBorrowToCollateral,
    creditDealCollateralRatio,
    averageCollateralRatio,
    dailyOfferFeeRate,
    creditDealFee,
};
