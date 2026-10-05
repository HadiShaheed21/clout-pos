/**
 * Integer minor-unit (paise) representation for the ecommerce API boundary.
 *
 * WHY THIS EXISTS
 * POS money columns are SQLite `REAL` (rupees as floats): `products.price`,
 * `variants.price_override`, `bills.*`, `orders.*`. Floats are unsafe for public
 * pricing — `0.1 + 0.2 !== 0.3`. A storefront that quotes prices to customers
 * needs deterministic integer arithmetic.
 *
 * HOW IT IS SAFE
 * - Derived on read only. This module NEVER writes to `products`, `variants`,
 *   or any other table, so no existing record changes and no migration is needed.
 * - Reuses the conversion the project already ships and tests for refunds and
 *   payments (`refundAmountMinorUnits` in main/routes/refunds.ts), so ecommerce
 *   money behaves identically to the rest of the money path.
 * - Currency-aware: decimal places come from `getCurrencyFractionDigits`, so
 *   INR (2) and JPY (0) both work.
 *
 * A value that cannot be represented exactly in minor units resolves to `null`
 * rather than being silently rounded into a price a customer would see.
 */

import { getCurrencyFractionDigits, getCurrencyMinorUnitFactor } from '../countries';

export { getCurrencyFractionDigits, getCurrencyMinorUnitFactor };

/** Absolute tolerance for a rupees -> minor-units round trip. */
const ROUND_TRIP_EPSILON = 1e-6;

/**
 * Converts rupee value to integer minor units, or `null` when the value cannot
 * be represented exactly. Rejects non-numeric, non-finite and negative inputs.
 */
export function rupeesToMinorUnits(value: unknown, currency: string): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const factor = getCurrencyMinorUnitFactor(currency);
  if (!Number.isFinite(factor) || factor <= 0) return null;

  const minorUnits = Math.round(value * factor);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) return null;

  // Guard the float hazard: a value like 10.005 must not become 1001 paise.
  if (Math.abs(minorUnits / factor - value) > ROUND_TRIP_EPSILON) return null;
  return minorUnits;
}

/** Converts integer minor units back to a rupee number for display/legacy math. */
export function minorUnitsToRupees(minorUnits: number, currency: string): number {
  return minorUnits / getCurrencyMinorUnitFactor(currency);
}

/** True when a rupee value round-trips through minor units without loss. */
export function isRepresentableInMinorUnits(value: unknown, currency: string): boolean {
  return rupeesToMinorUnits(value, currency) !== null;
}

/**
 * Multiplies minor-unit amounts and rounds once at the end, so a basket total
 * never accumulates float drift the way summing rupee floats would.
 */
export function multiplyMinorUnits(unitMinorUnits: number, quantity: number): number | null {
  if (!Number.isSafeInteger(unitMinorUnits) || unitMinorUnits < 0) return null;
  if (!Number.isSafeInteger(quantity) || quantity < 0) return null;
  const total = unitMinorUnits * quantity;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

/** Sums already-integer minor-unit amounts safely. */
export function sumMinorUnits(amounts: readonly number[]): number | null {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    total += amount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
