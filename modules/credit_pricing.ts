'use strict';

/**
 * modules/credit_pricing.ts — Canonical credit-pricing math (single source of truth).
 *
 * Pure functions only: no imports, no I/O, browser-safe. Both the live
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

function toFiniteOrNull(value: unknown): number | null {
    const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number(value);
    return Number.isFinite(num) ? num : null;
}

function positiveOrNull(value: unknown): number | null {
    const num = toFiniteOrNull(value);
    return num !== null && num > 0 ? num : null;
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
    const raw = toFiniteOrNull(leg?.amount);
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
    const collRaw = toFiniteOrNull(collateralAmountInt);
    const collPrec = toFiniteOrNull(collateralPrecision);
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
    const baseAmount = toFiniteOrNull(collateralPrice?.base?.amount);
    const quoteAmount = toFiniteOrNull(collateralPrice?.quote?.amount);
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
 * Minimum raw collateral required to borrow a raw debt amount at a price.
 * Integer ceil so the borrow is never under-collateralized by rounding.
 */
function requiredCollateralForBorrow(
    borrowAmountInt: unknown,
    collateralPrice: OfferPrice | null | undefined,
    debtAssetId: string | null = null,
    collateralAssetId: string | null = null,
): number | null {
    const borrowRaw = toFiniteOrNull(borrowAmountInt);
    const factors = resolvePriceFactors(collateralPrice, debtAssetId, collateralAssetId);
    if (borrowRaw === null || borrowRaw <= 0 || factors === null) return null;
    const { baseAmount, quoteAmount, orientation } = factors;
    if (orientation === 'legacy-reversed') {
        return Math.ceil((Number(borrowAmountInt) * baseAmount) / quoteAmount);
    }
    return Math.ceil((Number(borrowAmountInt) * quoteAmount) / baseAmount);
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
    const collRaw = toFiniteOrNull(collateralAmountInt);
    const factors = resolvePriceFactors(collateralPrice, debtAssetId, collateralAssetId);
    if (collRaw === null || collRaw <= 0 || factors === null) return null;
    const { baseAmount, quoteAmount, orientation } = factors;
    if (orientation === 'legacy-reversed') {
        return Math.floor((Number(collateralAmountInt) * quoteAmount) / baseAmount);
    }
    return Math.floor((Number(collateralAmountInt) * baseAmount) / quoteAmount);
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
    const coll = toFiniteOrNull(collateralFloat);
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
        const value = toFiniteOrNull(entry?.value);
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
    const feeRate = toFiniteOrNull(offer?.fee_rate);
    const maxDurationSeconds = toFiniteOrNull(offer?.max_duration_seconds);
    const denom = toFiniteOrNull(feeDenom);
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
    const repayRaw = toFiniteOrNull(repayAmountInt);
    const rateRaw = toFiniteOrNull(feeRate);
    const denomRaw = toFiniteOrNull(feeDenom);
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
    creditDealCollateralRatio,
    averageCollateralRatio,
    dailyOfferFeeRate,
    creditDealFee,
};
