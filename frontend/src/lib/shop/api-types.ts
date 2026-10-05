/**
 * Wire types for the PUBLIC shop catalogue API (`/api/shop/*`).
 *
 * These mirror `main/services/shop-catalogue.ts` exactly. The server owns this
 * allowlist, so this file deliberately contains NO cost, sku, barcode,
 * stock_quantity or low_stock_threshold — those are never sent and must never
 * be assumed. Prices are integer minor units (paise) as produced by the Phase 0
 * money module; the storefront never does float-rupee arithmetic.
 *
 * The public product identifier is the POS product id (there is no slug column),
 * so product URLs are `/shop/p/<productId>`.
 */

export type ShopAvailability = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface ShopApiVariant {
  id: string;
  display_name: string;
  price_minor_units: number;
  availability: ShopAvailability;
  options: { name: string; value: string; color_hex: string | null }[];
}

export interface ShopApiImage {
  id: string;
  alt_text: string | null;
  is_primary: boolean;
  sort_order: number;
  /** Relative URL to the public image endpoint; never a raw data URI. */
  url: string;
}

export interface ShopApiProduct {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  currency: string;
  /** Lowest sellable price across variants, in minor units. */
  price_minor_units: number | null;
  compare_at_minor_units: number | null;
  availability: ShopAvailability;
  is_variant_product: boolean;
  images: ShopApiImage[];
  collection: { slug: string; name: string } | null;
  variants: ShopApiVariant[];
}

export interface ShopApiCollection {
  slug: string;
  name: string;
  description: string | null;
}

export interface ShopApiPage {
  products: ShopApiProduct[];
  pagination: { limit: number; offset: number; total: number; has_more: boolean };
}

export const SHOP_PAGE_SIZE = 24;

/** Sentinel for "an image the shopper can actually see". */
export function primaryImageOf(product: ShopApiProduct): ShopApiImage | null {
  return product.images.find((image) => image.is_primary) ?? product.images[0] ?? null;
}

export function isUnavailable(product: ShopApiProduct): boolean {
  return product.availability === 'out_of_stock';
}
