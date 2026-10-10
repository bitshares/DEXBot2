import { getErrorMessage } from '../../utils/errors.js';
import { lookupAsset, derivePrice as systemDerivePrice, deriveMarketPrice as systemDeriveMarketPrice } from './system.js';
import type { BitSharesClient, PoolEntry, PoolReserve } from './system.js';
import { toFiniteNumber, isValidNumber } from '../format.js';
import * as MathUtils from './math.js';
import Logger from '../../order/logger.js';

const log = new Logger('PoolRef');

interface PoolPriceOverrides {
  derivePoolPrice(symA: string, symB: string): Promise<number | null>;
}

export function withPoolRef(
  BitShares: BitSharesClient,
  poolRef: string | null | undefined
): PoolPriceOverrides | null {
  if (!poolRef || typeof poolRef !== 'string' || !poolRef.trim()) return null;

  const ref = poolRef.trim();
  const pinnedId = ref.startsWith('1.19.') ? ref : `1.19.${ref}`;

  log.info(`withPoolRef: pinned to pool ${pinnedId}`);

  return {
    derivePoolPrice: async (symA: string, symB: string): Promise<number | null> => {
      try {
        const db = BitShares.db;
        if (!db?.get_objects) {
          log.warn(`derivePoolPrice: pool db unavailable for ${pinnedId}`);
          return null;
        }
        const [pool] = await db.get_objects([pinnedId]) as [PoolEntry | undefined];
        if (!pool) {
          log.warn(`derivePoolPrice: pool ${pinnedId} not found`);
          return null;
        }

        let amtA: number | null = null, amtB: number | null = null;
        let precA: number | null = null, precB: number | null = null;
        let poolLabel = `${pinnedId}`;

        if (isValidNumber(pool.balance_a) && isValidNumber(pool.balance_b)) {
          const [poolAssetA, poolAssetB] = await Promise.all([
            lookupAsset(BitShares, pool.asset_a ?? ''),
            lookupAsset(BitShares, pool.asset_b ?? ''),
          ]);
          if (!poolAssetA?.id || !poolAssetB?.id || poolAssetA.precision == null || poolAssetB.precision == null) {
            log.warn(`derivePoolPrice(pinned=${pinnedId}): cannot resolve pool asset precisions`);
            return null;
          }

          let aId: string | null = null;
          let bId: string | null = null;
          try {
            const [aMeta, bMeta] = await Promise.all([
              lookupAsset(BitShares, symA),
              lookupAsset(BitShares, symB),
            ]);
            aId = aMeta?.id ? String(aMeta.id) : null;
            bId = bMeta?.id ? String(bMeta.id) : null;
          } catch (_) {
            aId = null;
            bId = null;
          }

          const poolA = String(pool.asset_a);
          const poolB = String(pool.asset_b);

          // Orient the pinned pool's reserves to the bot's pair (B/A).
          //   - bot.assetA in pool: base position -> intrinsic, quote position -> invert
          //   - else bot.assetB in pool: quote position -> intrinsic, base position -> invert
          //   - neither in pool: pure proxy, use intrinsic as-is
          let invert = false;
          if (aId && (poolA === aId || poolB === aId)) {
            invert = poolB === aId;
          } else if (bId && (poolA === bId || poolB === bId)) {
            invert = poolA === bId;
          }

          if (invert) {
            amtA = toFiniteNumber(pool.balance_b);
            amtB = toFiniteNumber(pool.balance_a);
            precA = poolAssetB.precision ?? null;
            precB = poolAssetA.precision ?? null;
          } else {
            amtA = toFiniteNumber(pool.balance_a);
            amtB = toFiniteNumber(pool.balance_b);
            precA = poolAssetA.precision ?? null;
            precB = poolAssetB.precision ?? null;
          }
          poolLabel = `${poolAssetA.symbol || pool.asset_a}/${poolAssetB.symbol || pool.asset_b} (${pinnedId})`;
        } else if (Array.isArray(pool.reserves)) {
          const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB),
          ]);
          if (!aMeta?.id || !bMeta?.id) {
            log.warn(`derivePoolPrice(pinned=${pinnedId}): cannot resolve ${symA}/${symB}`);
            return null;
          }
          const resA = pool.reserves.find((r: PoolReserve) => String(r.asset_id) === String(aMeta.id));
          const resB = pool.reserves.find((r: PoolReserve) => String(r.asset_id) === String(bMeta.id));
          if (resA && resB) {
            amtA = Number(resA.amount);
            amtB = Number(resB.amount);
            precA = aMeta.precision ?? null;
            precB = bMeta.precision ?? null;
          }
        }

        if (!isValidNumber(amtA) || !isValidNumber(amtB) || toFiniteNumber(amtB) === 0 || precA == null || precB == null) {
          log.warn(`derivePoolPrice(pinned=${pinnedId}): invalid reserves amtA=${amtA} amtB=${amtB}`);
          return null;
        }

        const floatA = MathUtils.blockchainToFloat(amtA, precA);
        const floatB = MathUtils.blockchainToFloat(amtB, precB);
        const price = floatB > 0 ? floatB / floatA : null;

        if (price != null) {
          log.info(`derivePoolPrice: ${symA}/${symB} pool=${poolLabel} [pinned] -> ${price.toFixed(8)}`);
        }
        return price;
      } catch (err) {
        log.warn(`derivePoolPrice(pinned=${pinnedId}) failed: ${getErrorMessage(err)}`);
        return null;
      }
    },
  };
}

/**
 * Resolve the price-derivation mode from a startPrice value. `startPrice` is
 * the master price source: a string mode ("pool"/"book") governs it, while a
 * non-string value (numeric/undefined) falls back to the supplied mode
 * (default "auto"). Keeping this separate lets the grid call site pass
 * startPrice's own mode, so a pinned `poolRef` can never override
 * `startPrice: "book"`.
 * @param {*} startPrice - The configured startPrice value.
 * @param {string} [fallback='auto'] - Mode when startPrice is not a string.
 * @returns {string} Lowercased mode.
 */
export function resolveStartPriceMode(startPrice: unknown, fallback: string = 'auto'): string {
  if (typeof startPrice === 'string' && startPrice.trim()) {
    return startPrice.trim().toLowerCase();
  }
  return fallback;
}

export async function derivePriceWithPoolRef(
  BitShares: BitSharesClient,
  symA: string,
  symB: string,
  mode: string,
  poolRef: string | null | undefined
): Promise<number | null> {
  const effectiveMode = (typeof mode === 'string' ? mode : 'auto').toLowerCase();
  const override = poolRef ? withPoolRef(BitShares, poolRef) : null;

  if (override && effectiveMode !== 'book') {
    const p = await override.derivePoolPrice(symA, symB);
    if (p != null && p > 0) return p;
    if (effectiveMode === 'auto') {
      return systemDeriveMarketPrice(BitShares, symA, symB).catch(() => null);
    }
    return null;
  }

  return systemDerivePrice(BitShares, symA, symB, effectiveMode);
}
