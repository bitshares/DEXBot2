'use strict';

import { positiveOrNull } from './order/format.js';
import { resolveConfigValue, isPercentageString, roundToDecimals } from './order/utils/math.js';

interface CrPolicy {
    minCollateralRatio?: number;
    maxCollateralRatio?: number;
    targetCollateralRatio?: number;
}

interface DebtFirstCrPlanOptions {
    currentCollateralAmount?: number;
    currentDebtAmount?: number;
    feedPrice?: number;
    minCollateralRatio?: number;
    maxCollateralRatio?: number;
    targetCollateralRatio?: number;
    maxBorrowAmount?: number;
    maxBorrowAmountPerOperation?: number;
    maxCollateralAmount?: number | string;
    collateralLimitReferenceAmount?: number;
    minCollateralIncreaseThreshold?: number | string;
    debtOnly?: boolean;
}

interface CollateralFallbackPlanOptions {
    currentCollateralAmount?: number;
    currentDebtAmount?: number;
    feedPrice?: number;
    targetCollateralRatio?: number;
    maxCollateralAmount?: number | string;
    collateralLimitReferenceAmount?: number;
}

function resolveCollateralLimit(value: unknown, referenceAmount: unknown): number | null {
    const resolved = resolveConfigValue(value, referenceAmount);
    if (!Number.isFinite(resolved)) return null;
    if (isPercentageString(value)) {
        return resolved >= 0 ? resolved : null;
    }
    return resolved > 0 ? resolved : null;
}

function clampIncreaseToTotalMax(rawIncrease: unknown, currentTotal: unknown, maxTotal: unknown): number {
    const numeric = Number(rawIncrease);
    const current = Number(currentTotal);
    const limit = positiveOrNull(maxTotal);
    if (!Number.isFinite(numeric) || !Number.isFinite(current) || limit === null) {
        return numeric;
    }
    if (numeric <= 0) {
        return numeric;
    }

    const remaining = limit - current;
    if (remaining <= 0) {
        return 0;
    }
    return Math.min(numeric, remaining);
}

function resolveMinCollateralIncreaseThreshold(value: unknown, referenceAmount: unknown = null): number | null {
    if (value === undefined) return 0;
    if (value === null) return null;
    if (isPercentageString(value)) {
        const trimmed = value.trim();
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(trimmed)) {
            return null;
        }
        const percent = Number(trimmed.slice(0, -1));
        const reference = Number(referenceAmount);
        if (!Number.isFinite(percent) || percent < 0 || !Number.isFinite(reference) || reference <= 0) {
            return null;
        }
        return reference * percent / 100;
    }
    if (typeof value === 'string' && value.trim() === '') {
        return null;
    }
    if (typeof value !== 'number') {
        return null;
    }
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveTargetCollateralRatio(policy: CrPolicy = {}): number | null {
    const minCr = positiveOrNull(policy.minCollateralRatio);
    const maxCr = positiveOrNull(policy.maxCollateralRatio);
    const targetCr = positiveOrNull(policy.targetCollateralRatio);
    if (targetCr !== null) return targetCr;
    if (minCr !== null && maxCr !== null) return (minCr + maxCr) / 2;
    if (minCr !== null) return minCr;
    if (maxCr !== null) return maxCr;
    return null;
}

function calculateCollateralRatio(currentCollateralAmount: unknown, currentDebtAmount: unknown, feedPrice: unknown): number | null {
    const collateral = positiveOrNull(currentCollateralAmount);
    const debt = positiveOrNull(currentDebtAmount);
    const price = positiveOrNull(feedPrice);
    if (collateral === null || debt === null || price === null) {
        return null;
    }
    return collateral / (debt * price);
}

function _buildBounds(policy: CrPolicy = {}): { minCr: number | null; maxCr: number | null; targetCr: number | null; lowerBound: number | null; upperBound: number | null } {
    const minCr = positiveOrNull(policy.minCollateralRatio);
    const maxCr = positiveOrNull(policy.maxCollateralRatio);
    const targetCr = resolveTargetCollateralRatio(policy);
    const lowerBound = minCr !== null ? minCr : targetCr;
    const upperBound = maxCr !== null ? maxCr : targetCr;
    return { minCr, maxCr, targetCr, lowerBound, upperBound };
}

function buildDebtFirstCrPlan({
    currentCollateralAmount,
    currentDebtAmount,
    feedPrice,
    minCollateralRatio,
    maxCollateralRatio,
    targetCollateralRatio,
    maxBorrowAmount,
    maxBorrowAmountPerOperation,
    maxCollateralAmount,
    collateralLimitReferenceAmount,
    minCollateralIncreaseThreshold,
    debtOnly,
}: DebtFirstCrPlanOptions = {}) {
    const currentCr = calculateCollateralRatio(currentCollateralAmount, currentDebtAmount, feedPrice);
    const policy: CrPolicy = {
        minCollateralRatio,
        maxCollateralRatio,
        targetCollateralRatio,
    };
    const { minCr, maxCr, targetCr, lowerBound, upperBound } = _buildBounds(policy);

    if (currentCr == null || !Number.isFinite(currentCr) || !Number.isFinite(feedPrice) || !Number.isFinite(currentDebtAmount) || !Number.isFinite(currentCollateralAmount)) {
        return null;
    }
    if (minCr !== null && maxCr !== null && minCr > maxCr) {
        return { blocked: true, reason: 'minCollateralRatio exceeds maxCollateralRatio' };
    }
    if (lowerBound == null || upperBound == null || !Number.isFinite(lowerBound) || !Number.isFinite(upperBound)) {
        return null;
    }

    let desiredCr: number | null = null;
    let primaryAction: string | null = null;
    let fallbackAction: string | null = null;

    if (currentCr < lowerBound) {
        desiredCr = lowerBound;
        primaryAction = 'reduce_debt';
        fallbackAction = 'add_collateral';
    } else if (currentCr > upperBound) {
        desiredCr = upperBound;
        primaryAction = 'increase_debt';
        fallbackAction = 'withdraw_collateral';
    } else {
        return null;
    }

    const collateralLimit = resolveCollateralLimit(
        maxCollateralAmount,
        collateralLimitReferenceAmount ?? currentCollateralAmount
    );

    if (primaryAction === 'increase_debt' && minCollateralIncreaseThreshold !== undefined) {
        const minCollateralIncrease = resolveMinCollateralIncreaseThreshold(
            minCollateralIncreaseThreshold,
            collateralLimit ?? collateralLimitReferenceAmount ?? currentCollateralAmount
        );
        if (minCollateralIncrease === null) return null;
        if (minCollateralIncrease > 0) {
            const collateralIncreaseAmount = Number.isFinite(collateralLimit)
                ? (collateralLimit as number) - (currentCollateralAmount as number)
                : 0;
            if (!Number.isFinite(collateralIncreaseAmount) || collateralIncreaseAmount <= 0 || collateralIncreaseAmount < minCollateralIncrease) {
                return null;
            }
        }
    }

    const targetDebt = (currentCollateralAmount as number) / ((feedPrice as number) * (desiredCr as number));
    const rawDebtDelta = targetDebt - (currentDebtAmount as number);
    let debtDelta = clampIncreaseToTotalMax(rawDebtDelta, currentDebtAmount, maxBorrowAmount);
    // Also clamp by per-operation limit
    if (debtDelta > 0) {
        const limit = positiveOrNull(maxBorrowAmountPerOperation);
        if (limit !== null) {
            debtDelta = Math.min(debtDelta, limit);
        }
    }
    const projectedDebt = Math.max(0, (currentDebtAmount as number) + debtDelta);
    const targetCollateral = (desiredCr as number) * (feedPrice as number) * projectedDebt;
    let collateralDelta = targetCollateral - (currentCollateralAmount as number);

    // Total collateral ceiling: only cap additions; withdrawals are always allowed.
    if (collateralDelta > 0 && collateralLimit !== null) {
        const remaining = (collateralLimit as number) - (currentCollateralAmount as number);
        if (remaining <= 0) {
            collateralDelta = 0;
        } else {
            collateralDelta = Math.min(collateralDelta, remaining);
        }
    }

    // debtOnly: keep collateral constant, only adjust debt
    if (debtOnly) {
        collateralDelta = 0;
        fallbackAction = null;
    }

    return {
        action: primaryAction,
        fallbackAction,
        targetCollateralRatio: desiredCr ?? targetCr,
        currentCollateralRatio: currentCr,
        currentDebtAmount,
        currentCollateralAmount,
        feedPrice,
        debtDelta: roundToDecimals(debtDelta, 8),
        collateralDelta: roundToDecimals(collateralDelta, 8),
        needsGridReset: true,
        resetReason: 'cr-adjustment',
    };
}

function buildCollateralFallbackPlan({
    currentCollateralAmount,
    currentDebtAmount,
    feedPrice,
    targetCollateralRatio,
    maxCollateralAmount,
    collateralLimitReferenceAmount,
}: CollateralFallbackPlanOptions = {}) {
    const targetCr = positiveOrNull(targetCollateralRatio);
    const currentCr = calculateCollateralRatio(currentCollateralAmount, currentDebtAmount, feedPrice);
    if (!Number.isFinite(currentCr) || targetCr === null) {
        return null;
    }

    const targetCollateral = targetCr * (feedPrice as number) * (currentDebtAmount as number);
    let collateralDelta = targetCollateral - (currentCollateralAmount as number);
    if (!Number.isFinite(collateralDelta) || collateralDelta === 0) {
        return null;
    }

    const collateralLimit = resolveCollateralLimit(
        maxCollateralAmount,
        collateralLimitReferenceAmount ?? currentCollateralAmount
    );
    // Total collateral ceiling: only cap additions; withdrawals are always allowed.
    if (collateralDelta > 0 && collateralLimit !== null) {
        const remaining = (collateralLimit as number) - (currentCollateralAmount as number);
        if (remaining <= 0) {
            return null;
        }
        collateralDelta = Math.min(collateralDelta, remaining);
    }

    if (collateralDelta === 0) {
        return null;
    }

    return {
        action: collateralDelta > 0 ? 'add_collateral' : 'withdraw_collateral',
        targetCollateralRatio: targetCr,
        currentCollateralRatio: currentCr,
        currentDebtAmount,
        currentCollateralAmount,
        feedPrice,
        collateralDelta: roundToDecimals(collateralDelta, 8),
        needsGridReset: true,
        resetReason: 'cr-adjustment',
    };
}

export { buildCollateralFallbackPlan, buildDebtFirstCrPlan, positiveOrNull, resolveMinCollateralIncreaseThreshold, resolveTargetCollateralRatio }

