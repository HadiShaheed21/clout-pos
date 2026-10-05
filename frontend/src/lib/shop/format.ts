/**
 * Display helpers for the website prototype.
 *
 * PROTOTYPE ONLY — these format mock rupee values for on-screen display. The POS
 * stores money as integer paise and applies its own tenant-aware formatting via
 * `useFormatCurrency`; a real integration must convert at the API boundary
 * rather than reusing these display helpers.
 */

/**
 * Display helpers for the storefront.
 *
 * The POS and the public API both express money as integer MINOR UNITS
 * (paise) produced by the server's shop-money module. Real data therefore
 * arrives as integers, and these helpers format them without ever doing float
 * rupee arithmetic in the browser.
 *
 * The legacy `formatPrice` (whole rupees) remains for the offline mock
 * prototype data, which is still used by the design-only cart/checkout screens.
 */

const minorUnitFormat = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats integer minor units for display, e.g. 149900 -> "₹1,499.00". */
export function formatMinor(minorUnits: number | null | undefined, currency = 'INR'): string {
  if (typeof minorUnits !== 'number' || !Number.isFinite(minorUnits)) return '—';
  if (currency.toUpperCase() !== 'INR') {
    // Only INR is formatted exactly; other currencies fall back to a safe label
    // rather than guessing an exchange or decimal convention.
    return `${currency.toUpperCase()} ${(minorUnits / 100).toFixed(2)}`;
  }
  return minorUnitFormat.format(minorUnits / 100);
}

const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export function formatPrice(rupees: number): string {
  return INR_WHOLE.format(Math.max(0, Math.round(rupees)));
}

export function discountPercent(priceRupees: number, compareAtRupees: number | null): number | null {
  if (!compareAtRupees || compareAtRupees <= priceRupees) return null;
  return Math.round(((compareAtRupees - priceRupees) / compareAtRupees) * 100);
}

export function isLowStock(stockQuantity: number): boolean {
  return stockQuantity > 0 && stockQuantity <= 3;
}

/** Uppercases a slug into a display label, e.g. "new-arrivals" -> "New Arrivals". */
export function slugToLabel(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Builds a deterministic, evenly distributed hue from any string. */
export function hashToHue(seed: string): number {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) % 360;
  }
  return hash;
}
