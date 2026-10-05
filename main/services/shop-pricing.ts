/**
 * Ecommerce price and availability projection.
 *
 * Phase 0 foundation only: this module READS POS rows and derives a storefront
 * view of price and stock. It exposes no HTTP routes, writes nothing, and does
 * not alter POS sales, refund or stock behaviour.
 *
 * Design commitments carried into later phases:
 * - Prices are integer minor units (`shop-money`), never float rupees.
 * - Availability is COARSE (in_stock / low_stock / out_of_stock). Exact counts
 *   are never returned to a customer surface, which would both leak inventory
 *   and invite scraping.
 * - `price_override` is resolved with nullish semantics: 0 is a real price.
 */

import { rupeesToMinorUnits } from './shop-money';

/** Coarse availability buckets. Never exposes an exact quantity. */
export type ShopAvailability = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface PriceSource {
  minorUnits: number;
  /** Which POS field produced the price, for transparent UI explanation. */
  source: 'variant_override' | 'product_price';
}

type ProductPriceRow = { price?: unknown };
type VariantPriceRow = { price_override?: unknown };

/**
 * Resolves the selling price in integer minor units.
 *
 * Precedence matches POS sales (`orders.ts`: `variant?.price_override ??
 * parseFloat(product.price)`). A `null` result means the price cannot be
 * published exactly, so the product is withheld rather than misquoted.
 */
export function resolvePriceMinorUnits(
  product: ProductPriceRow,
  variant: VariantPriceRow | null | undefined,
  currency: string,
): PriceSource | null {
  // Nullish coalescing, not `||`: a zero override is a deliberate price.
  if (variant && variant.price_override !== null && variant.price_override !== undefined) {
    const minorUnits = rupeesToMinorUnits(variant.price_override, currency);
    return minorUnits === null ? null : { minorUnits, source: 'variant_override' };
  }
  const minorUnits = rupeesToMinorUnits(product.price, currency);
  return minorUnits === null ? null : { minorUnits, source: 'product_price' };
}

interface AvailabilityRow {
  is_active?: unknown;
  deleted_at?: unknown;
  stock_quantity?: unknown;
  low_stock_threshold?: unknown;
  track_inventory?: unknown;
}

/**
 * Derives coarse availability for one sellable row (a variant, or a
 * non-variant product). Untracked stock is treated as in stock, matching how POS
 * sales skip the stock check when `track_inventory` is off.
 */
export function resolveAvailability(row: AvailabilityRow): ShopAvailability {
  if (row.is_active === 0 || row.is_active === false) return 'out_of_stock';
  if (row.deleted_at) return 'out_of_stock';
  if (row.track_inventory === 0 || row.track_inventory === false) return 'in_stock';

  const stock = Number(row.stock_quantity ?? 0);
  if (!Number.isFinite(stock) || stock <= 0) return 'out_of_stock';

  const threshold = Number(row.low_stock_threshold ?? 0);
  if (Number.isFinite(threshold) && threshold > 0 && stock <= threshold) return 'low_stock';
  return 'in_stock';
}

/**
 * Rolls variant availability up to the product level, so a listing tile can
 * show "some sizes available" without leaking per-variant counts.
 */
export function rollUpAvailability(availabilities: readonly ShopAvailability[]): ShopAvailability {
  if (availabilities.some((status) => status === 'in_stock')) return 'in_stock';
  if (availabilities.some((status) => status === 'low_stock')) return 'low_stock';
  return 'out_of_stock';
}

/** Lowest sellable price across variants, in integer minor units. */
export function lowestPriceMinorUnits(prices: readonly PriceSource[]): number | null {
  const values = prices.map((price) => price.minorUnits);
  return values.length ? Math.min(...values) : null;
}
