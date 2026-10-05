/**
 * Public ecommerce catalogue projection (Phase 1, read-only).
 *
 * SECURITY MODEL
 * This module is the ONLY place that turns POS rows into customer-facing data.
 * Every response is built by an explicit allowlist projection — internal columns
 * (cost, cost_override, stock_quantity, low_stock_threshold, sku, barcode,
 * customer data, audit fields) are never copied into a public object, and are
 * not even SELECTed for list endpoints.
 *
 * A product is publicly visible only when ALL hold:
 *   - not soft-deleted, active, and `catalog_status = 'published'`
 *   - its price converts exactly to integer minor units
 *   - for variant products, at least one active variant is sellable and priced
 * Availability is COARSE only; exact stock counts never leave this module.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase } from '../db';
import { rupeesToMinorUnits } from './shop-money';
import {
  resolvePriceMinorUnits, resolveAvailability, rollUpAvailability,
  lowestPriceMinorUnits, type ShopAvailability,
} from './shop-pricing';
import { getTenantCurrency } from './refund';

/** Public default page size when the caller does not ask for one. */
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

export interface PublicVariant {
  id: string;
  display_name: string;
  price_minor_units: number;
  availability: ShopAvailability;
  options: { name: string; value: string; color_hex: string | null }[];
}

export interface PublicImage {
  id: string;
  alt_text: string | null;
  is_primary: boolean;
  sort_order: number;
  /** Relative URL to the public image endpoint; never a raw data URI. */
  url: string;
}

export interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  currency: string;
  price_minor_units: number | null;
  compare_at_minor_units: number | null;
  availability: ShopAvailability;
  is_variant_product: boolean;
  images: PublicImage[];
  collection: { slug: string; name: string } | null;
  variants: PublicVariant[];
}

type ProductRow = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  original_price: number | null;
  catalog_status: string;
  is_active: number;
  variant_mode: number;
  track_inventory: number;
  stock_quantity: number;
  low_stock_threshold: number;
  deleted_at: string | null;
  category_slug: string | null;
  category_name: string | null;
  collection_slug: string | null;
  collection_name: string | null;
};

/** Columns required to decide eligibility and build the allowlist. */
const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.description, p.price, p.original_price,
         p.catalog_status, p.is_active, p.variant_mode, p.track_inventory,
         p.stock_quantity, p.low_stock_threshold, p.deleted_at,
         c.slug AS category_slug, c.name AS category_name,
         col.slug AS collection_slug, col.name AS collection_name
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id AND c.deleted_at IS NULL AND c.is_active = 1
  LEFT JOIN collection_products cp ON cp.product_id = p.id
  LEFT JOIN collections col ON col.id = cp.collection_id AND col.is_active = 1
  WHERE p.deleted_at IS NULL
    AND p.is_active = 1
    AND p.catalog_status = 'published'
`;

type VariantRow = {
  id: string;
  product_id: string;
  display_name: string;
  price_override: number | null;
  is_active: number;
  track_inventory: number;
  stock_quantity: number;
  low_stock_threshold: number;
  deleted_at: string | null;
};

function loadVariants(db: BetterSqlite3.Database, productId: string): VariantRow[] {
  return db.prepare(`
    SELECT id, product_id, display_name, price_override, is_active,
           track_inventory, stock_quantity, low_stock_threshold, deleted_at
    FROM product_variants
    WHERE product_id = ? AND deleted_at IS NULL AND is_active = 1
    ORDER BY display_name
  `).all(productId) as VariantRow[];
}

function loadOptions(db: BetterSqlite3.Database, variantIds: string[]): Map<string, { name: string; value: string; color_hex: string | null }[]> {
  const grouped = new Map<string, { name: string; value: string; color_hex: string | null }[]>();
  if (!variantIds.length) return grouped;
  const rows = db.prepare(`
    SELECT pvv.variant_id, pog.name AS option_name, pov.label AS option_value, pov.color_hex
    FROM product_variant_option_values pvv
    JOIN product_option_groups pog ON pog.id = pvv.option_group_id
    JOIN product_option_values pov ON pov.id = pvv.option_value_id
    WHERE pvv.variant_id IN (${variantIds.map(() => '?').join(',')})
    ORDER BY pog.sort_order, pog.name, pov.sort_order, pov.label
  `).all(...variantIds) as any[];
  for (const row of rows) {
    const list = grouped.get(row.variant_id) ?? [];
    list.push({ name: row.option_name, value: row.option_value, color_hex: row.color_hex ?? null });
    grouped.set(row.variant_id, list);
  }
  return grouped;
}

function loadImages(db: BetterSqlite3.Database, productIds: string[]): Map<string, PublicImage[]> {
  const byProduct = new Map<string, PublicImage[]>();
  if (!productIds.length) return byProduct;
  const rows = db.prepare(`
    SELECT id, product_id, uses_legacy_image, alt_text, sort_order, is_primary
    FROM product_images
    WHERE product_id IN (${productIds.map(() => '?').join(',')})
    ORDER BY sort_order, created_at
  `).all(...productIds) as any[];
  for (const row of rows) {
    const list = byProduct.get(row.product_id) ?? [];
    list.push({
      id: row.id,
      alt_text: row.alt_text ?? null,
      is_primary: Boolean(row.is_primary),
      sort_order: Number(row.sort_order) || 0,
      url: `/api/shop/images/${row.id}`,
    });
    byProduct.set(row.product_id, list);
  }
  return byProduct;
}
/**
 * Builds the allowlisted public view for one product row, or `null` when the
 * product is not publicly sellable (invalid price, or no sellable variant).
 */
function toPublicProduct(
  db: BetterSqlite3.Database,
  row: ProductRow,
  currency: string,
  variantCache: Map<string, VariantRow[]>,
  imageCache?: Map<string, PublicImage[]>,
): PublicProduct | null {
  const isVariantProduct = row.variant_mode === 1;

  let variants: PublicVariant[] = [];
  let availability: ShopAvailability;

  if (isVariantProduct) {
    const rows = variantCache.get(row.id) ?? loadVariants(db, row.id);
    variantCache.set(row.id, rows);
    const options = loadOptions(db, rows.map((variant) => variant.id));
    variants = rows.map((variant) => ({
      id: variant.id,
      display_name: variant.display_name,
      price_minor_units: resolvePriceMinorUnits(row, variant, currency)?.minorUnits ?? 0,
      availability: resolveAvailability(variant),
      options: options.get(variant.id) ?? [],
    }));
    const sellable = variants.filter((variant) => variant.availability !== 'out_of_stock');
    // A variant product with nothing sellable must not be quoted at all.
    if (sellable.length === 0) return null;
    availability = rollUpAvailability(variants.map((variant) => variant.availability));
  } else {
    const price = resolvePriceMinorUnits(row, null, currency);
    // Unrepresentable price: withhold rather than misquote.
    if (!price) return null;
    availability = resolveAvailability(row);
    variants = [{
      id: row.id,
      display_name: 'Default',
      price_minor_units: price.minorUnits,
      availability,
      options: [],
    }];
  }

  const prices = variants.map((variant) => ({ minorUnits: variant.price_minor_units, source: 'product_price' as const }));
  const compareAt = row.original_price !== null && row.original_price !== undefined
    ? rupeesToMinorUnits(row.original_price, currency)
    : null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category_name,
    currency,
    price_minor_units: lowestPriceMinorUnits(prices),
    // Only expose a compare-at price when it is genuinely higher.
    compare_at_minor_units: compareAt !== null && lowestPriceMinorUnits(prices) !== null
      && compareAt > (lowestPriceMinorUnits(prices) as number)
      ? compareAt
      : null,
    availability,
    is_variant_product: isVariantProduct,
    images: imageCache?.get(row.id) ?? [],
    collection: row.collection_slug
      ? { slug: row.collection_slug, name: row.collection_name ?? row.collection_slug }
      : null,
    variants,
  };
}

/** Public collection list. Never exposes internal audit or ordering columns. */
export function listPublicCollections(db: BetterSqlite3.Database): { slug: string; name: string; description: string | null }[] {
  return db.prepare(`
    SELECT slug, name, description
    FROM collections
    WHERE is_active = 1
    ORDER BY sort_order, name
  `).all() as any[];
}

export interface PublicPage {
  products: PublicProduct[];
  pagination: { limit: number; offset: number; total: number; has_more: boolean };
}

/**
 * Paginated public product list. Eligibility is enforced in SQL AND re-checked
 * in the projection, because a product can still fail the price/variant gate.
 */
export function listPublicProducts(
  db: BetterSqlite3.Database,
  options: { limit: number; offset: number; currency?: string },
): PublicPage {
  const currency = options.currency || getTenantCurrency(db);
  const rows = db.prepare(`${PRODUCT_SELECT} ORDER BY p.sort_order, p.name`).all() as ProductRow[];

  const variantCache = new Map<string, VariantRow[]>();
  const productIds = rows.map((row) => row.id);
  const imageCache = loadImages(db, productIds);

  const eligible = rows
    .map((row) => toPublicProduct(db, row, currency, variantCache, imageCache))
    .filter((product): product is PublicProduct => product !== null);

  const total = eligible.length;
  const page = eligible.slice(options.offset, options.offset + options.limit);

  return {
    products: page,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      total,
      has_more: options.offset + page.length < total,
    },
  };
}

/** Single public product lookup. Returns `null` for anything not publishable. */
export function getPublicProductById(
  db: BetterSqlite3.Database,
  id: string,
  currency?: string,
): PublicProduct | null {
  const effectiveCurrency = currency || getTenantCurrency(db);
  const row = db.prepare(`${PRODUCT_SELECT} AND p.id = ? LIMIT 1`).get(id) as ProductRow | undefined;
  if (!row) return null;
  const imageCache = loadImages(db, [row.id]);
  return toPublicProduct(db, row, effectiveCurrency, new Map(), imageCache);
}

/** True when the product is publicly visible; used to gate image delivery. */
export function isPubliclyVisibleProduct(db: BetterSqlite3.Database, productId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM products
    WHERE id = ? AND deleted_at IS NULL AND is_active = 1 AND catalog_status = 'published'
    LIMIT 1
  `).get(productId);
  return Boolean(row);
}

export { rupeesToMinorUnits };

