/**
 * Server-authoritative guest shopping cart (Phase 3).
 *
 * DESIGN COMMITMENTS
 * - The browser is NEVER authoritative. Prices, availability and totals are
 *   derived here on every read from the same helpers the public catalogue uses
 *   (`shop-pricing`), in integer minor units.
 * - A cart is NOT a quote, a reservation or an order. Nothing in this module
 *   writes to `orders`, `bills`, `payments` or `stock_movements`, and no stock
 *   is decremented. Final stock enforcement belongs to the Phase 4 order
 *   transaction.
 * - No customer identity is stored. A cart is addressed by an opaque,
 *   cryptographically random token held in an HMAC-signed cookie.
 *
 * IDENTITY
 * The cookie carries `token.HMAC(token)`. The server verifies the signature in
 * constant time, then looks the cart up by `SHA-256(token)`. The raw token is
 * never written to the database, so a database copy cannot be replayed as a
 * cart session. `randomBytes` is used rather than the project's
 * `generateShortId`, which is `Math.random()`-based and not fit for a secret.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getJWTSecret } from '../routes/auth';
import { resolvePriceMinorUnits, resolveAvailability, type ShopAvailability } from './shop-pricing';

/** Cart lifetime. Deliberately generous for a fashion browse, not indefinite. */
export const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Hard ceiling per line and per cart, independent of available stock. */
export const MAX_LINE_QUANTITY = 20;
export const MAX_CART_LINES = 50;
/** Cookie name. Scoped so it cannot collide with POS session cookies. */
export const CART_COOKIE = 'clout_cart';
/** CSRF token bound to the cart cookie; verified on state-changing calls. */
export const CART_CSRF_COOKIE = 'clout_cart_csrf';
export const CART_CSRF_HEADER = 'x-clout-csrf';

const TOKEN_BYTES = 32; // 256 bits

function now(): string {
  return new Date().toISOString();
}

/** Fresh expiry, used when creating or sliding a cart forward. */
function expiryFromNow(): string {
  return new Date(Date.now() + CART_TTL_MS).toISOString();
}

/** SHA-256 hex of the raw token; this is the only form persisted. */
export function hashCartToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function signCartToken(token: string): string {
  return createHmac('sha256', getJWTSecret()).update(token).digest('base64url');
}

export interface IssuedCartToken {
  /** Value to store in the cookie: `token.signature`. */
  cookieValue: string;
  token: string;
  csrfToken: string;
}

/** Fresh CSRF token for the double-submit cookie. */
export function issueCsrfToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Creates a new opaque cart token. Never derived from personal data. */
export function issueCartToken(): IssuedCartToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    cookieValue: `${token}.${signCartToken(token)}`,
    token,
    csrfToken: issueCsrfToken(),
  };
}

/**
 * Verifies a cookie value in constant time.
 *
 * Returns the raw token only when the HMAC matches, so a forged or truncated
 * cookie yields `null` rather than being used as a lookup key.
 */
export function verifyCartToken(cookieValue: string | undefined | null): string | null {
  if (typeof cookieValue !== 'string') return null;
  const separator = cookieValue.lastIndexOf('.');
  if (separator <= 0) return null;

  const token = cookieValue.slice(0, separator);
  const provided = Buffer.from(cookieValue.slice(separator + 1));
  const expected = Buffer.from(signCartToken(token));
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  return token;
}

/** Constant-time CSRF comparison. */
export function verifyCsrfToken(cookieToken: string | undefined | null, headerToken: string | undefined | null): boolean {
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') return false;
  const provided = Buffer.from(headerToken);
  const expected = Buffer.from(cookieToken);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
export type CartLineStatus = 'ok' | 'unavailable' | 'unpublished';

export interface CartLineView {
  item_id: string;
  product_id: string;
  product_name: string;
  variant_id: string | null;
  variant_display_name: string | null;
  /** Option labels for the chosen variant, e.g. Colour=Navy. */
  options: { name: string; value: string; color_hex: string | null }[];
  /** Current server-derived unit price in minor units. */
  unit_price_minor_units: number;
  quantity: number;
  /** unit_price x quantity, computed in integer minor units. */
  line_total_minor_units: number;
  availability: ShopAvailability;
  currency: string;
  image_url: string | null;
  status: CartLineStatus;
  /** Human-readable reason when status is not 'ok'. */
  message: string | null;
}

export interface CartView {
  currency: string;
  items: CartLineView[];
  item_count: number;
  subtotal_minor_units: number;
  /** Lines that can no longer be bought, so the UI can explain them. */
  has_unavailable_items: boolean;
  expires_at: string;
}

interface CartRow {
  id: string;
  token_hash: string;
  expires_at: string;
}

/** Resolves a cart by raw token; null when absent or expired. */
export function findCartByToken(db: BetterSqlite3.Database, token: string): CartRow | null {
  const row = db.prepare('SELECT id, token_hash, expires_at FROM shop_carts WHERE token_hash = ?')
    .get(hashCartToken(token)) as CartRow | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

/** Creates a cart row for a freshly issued token. */
export function createCart(db: BetterSqlite3.Database, token: string): CartRow {
  const id = randomBytes(12).toString('hex');
  const expiresAt = expiryFromNow();
  db.prepare('INSERT INTO shop_carts (id, token_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, hashCartToken(token), expiresAt, now(), now());
  return { id, token_hash: hashCartToken(token), expires_at: expiresAt };
}

/** Sliding renewal, applied only on activity so dormant carts still expire. */
export function touchCart(db: BetterSqlite3.Database, cartId: string): void {
  db.prepare('UPDATE shop_carts SET expires_at = ?, updated_at = ? WHERE id = ?')
    .run(expiryFromNow(), now(), cartId);
}

/**
 * Opportunistic cleanup of expired carts. Runs inline on cart requests rather
 * than as a background worker, so no new infrastructure is required. Cheap
 * because it is bounded and indexed on `expires_at`.
 */
export function purgeExpiredCarts(db: BetterSqlite3.Database): number {
  return db.prepare('DELETE FROM shop_carts WHERE expires_at <= ?').run(now()).changes;
}
interface ProductLookup {
  id: string;
  name: string;
  product_price: unknown;
  variant_mode: unknown;
  image_id: string | null;
  is_variant: number;
  variant_id: string | null;
  variant_display_name: string | null;
  variant_price_override: unknown;
  variant_is_active: unknown;
  variant_stock: unknown;
  variant_low_threshold: unknown;
  variant_track_inventory: unknown;
  product_stock: unknown;
  product_low_threshold: unknown;
  product_track_inventory: unknown;
}

/**
 * Loads a product plus its chosen variant in ONE query.
 *
 * Eligibility is enforced in SQL (active, published, not deleted) so an
 * unpublished or deleted product can never be added. The variant is joined on
 * `product_id` as well as its own id, so a variant belonging to a DIFFERENT
 * product cannot be substituted for the requested product.
 */
export function loadCartProduct(
  db: BetterSqlite3.Database,
  productId: string,
  variantId: string | null,
): ProductLookup | null {
  const row = db.prepare(`
    SELECT p.id, p.name, p.price AS product_price, p.variant_mode,
           p.stock_quantity AS product_stock,
           p.low_stock_threshold AS product_low_threshold,
           p.track_inventory AS product_track_inventory,
           (SELECT pi.id FROM product_images pi WHERE pi.product_id = p.id
             ORDER BY pi.is_primary DESC, pi.sort_order LIMIT 1) AS image_id,
           (CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END) AS is_variant,
           v.id AS variant_id, v.display_name AS variant_display_name,
           v.price_override AS variant_price_override, v.is_active AS variant_is_active,
           v.stock_quantity AS variant_stock, v.low_stock_threshold AS variant_low_threshold,
           v.track_inventory AS variant_track_inventory
    FROM products p
    LEFT JOIN product_variants v
      ON v.id = ? AND v.product_id = p.id AND v.deleted_at IS NULL
    WHERE p.id = ?
      AND p.deleted_at IS NULL
      AND p.is_active = 1
      AND p.catalog_status = 'published'
    LIMIT 1
  `).get(variantId, variantId, productId) as any;

  if (!row) return null;
  // A variant was requested but did not join: it is not this product's variant
  // (wrong id, belongs to another product, inactive, or soft-deleted).
  if (variantId && !row.variant_id) return null;
  // A variant product needs a variant; a simple product must not be given one.
  if (Number(row.variant_mode) === 1 && !row.variant_id) return null;
  if (Number(row.variant_mode) !== 1 && row.variant_id) return null;

  return {
    id: row.id,
    name: row.name,
    product_price: row.product_price,
    variant_mode: row.variant_mode,
    image_id: row.image_id ?? null,
    is_variant: row.is_variant,
    variant_id: row.variant_id ?? null,
    variant_display_name: row.variant_display_name ?? null,
    variant_price_override: row.variant_price_override,
    variant_is_active: row.variant_is_active,
    variant_stock: row.variant_stock,
    variant_low_threshold: row.variant_low_threshold,
    variant_track_inventory: row.variant_track_inventory,
    product_stock: row.product_stock,
    product_low_threshold: row.product_low_threshold,
    product_track_inventory: row.product_track_inventory,
  };
}

/**
 * Derives price and availability using the SAME helpers the public catalogue
 * uses, so a cart can never disagree with the listing a customer clicked.
 */
export function priceAndAvailability(
  row: ProductLookup,
  currency: string,
): { minorUnits: number; availability: ShopAvailability } | null {
  const variant = row.is_variant
    ? {
        price_override: row.variant_price_override,
        is_active: row.variant_is_active,
        stock_quantity: row.variant_stock,
        low_stock_threshold: row.variant_low_threshold,
        track_inventory: row.variant_track_inventory,
        deleted_at: null,
      }
    : null;

  const price = resolvePriceMinorUnits({ price: row.product_price }, variant, currency);
  if (!price) return null;

  const availability = resolveAvailability(
    variant ?? {
      is_active: 1,
      deleted_at: null,
      stock_quantity: row.product_stock,
      low_stock_threshold: row.product_low_threshold,
      track_inventory: row.product_track_inventory,
    },
  );

  return { minorUnits: price.minorUnits, availability };
}

interface CartItemRow {
  item_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
}

/** Option labels for a variant, used to render "Colour: Navy" in the cart. */
export function loadVariantOptions(
  db: BetterSqlite3.Database,
  variantId: string | null,
): CartLineView['options'] {
  if (!variantId) return [];
  const rows = db.prepare(`
    SELECT g.name AS group_name, v.label AS value_label, v.color_hex
    FROM product_variant_option_values j
    JOIN product_option_values v ON v.id = j.option_value_id
    JOIN product_option_groups g ON g.id = j.option_group_id
    WHERE j.variant_id = ?
    ORDER BY g.sort_order, v.sort_order
  `).all(variantId) as { group_name: string; value_label: string; color_hex: string | null }[];

  return rows.map((row) => ({
    name: row.group_name,
    value: row.value_label,
    color_hex: row.color_hex,
  }));
}

/**
 * Builds the cart view, re-deriving every price and availability from the
 * current catalogue.
 *
 * A line whose product has since been unpublished, deleted or had its variant
 * removed is reported with status `unpublished` and is EXCLUDED from the
 * subtotal, rather than being silently dropped or quoted at a stale price.
 */
export function buildCartView(
  db: BetterSqlite3.Database,
  cart: CartRow,
  currency: string,
): CartView {
  const rows = db.prepare(`
    SELECT id AS item_id, product_id, variant_id, quantity
    FROM shop_cart_items
    WHERE cart_id = ?
    ORDER BY created_at, id
  `).all(cart.id) as CartItemRow[];

  const items: CartLineView[] = [];
  let subtotal = 0;
  let itemCount = 0;
  let hasUnavailable = false;

  for (const row of rows) {
    const product = loadCartProduct(db, row.product_id, row.variant_id);
    if (!product) {
      hasUnavailable = true;
      items.push({
        item_id: row.item_id,
        product_id: row.product_id,
        product_name: 'Unavailable product',
        variant_id: row.variant_id,
        variant_display_name: null,
        options: [],
        unit_price_minor_units: 0,
        quantity: row.quantity,
        line_total_minor_units: 0,
        availability: 'out_of_stock',
        currency,
        image_url: null,
        status: 'unpublished',
        message: 'This piece is no longer available. Please remove it to continue.',
      });
      continue;
    }

    const priced = priceAndAvailability(product, currency);
    if (!priced) {
      hasUnavailable = true;
      items.push({
        item_id: row.item_id,
        product_id: product.id,
        product_name: product.name,
        variant_id: product.variant_id,
        variant_display_name: product.variant_display_name,
        options: loadVariantOptions(db, product.variant_id),
        unit_price_minor_units: 0,
        quantity: row.quantity,
        line_total_minor_units: 0,
        availability: 'out_of_stock',
        currency,
        image_url: product.image_id ? `/api/shop/images/${product.image_id}` : null,
        status: 'unavailable',
        message: 'This piece cannot be priced right now. Please remove it to continue.',
      });
      continue;
    }

    const soldOut = priced.availability === 'out_of_stock';
    const overQuantity = !soldOut && Number(product.variant_stock ?? 0) >= 0
      && row.quantity > Number(product.variant_stock ?? row.quantity);

    if (soldOut) hasUnavailable = true;

    // Integer minor-unit arithmetic only; no float money anywhere.
    const lineTotal = priced.minorUnits * row.quantity;

    // Only purchasable lines contribute to the subtotal.
    if (!soldOut) {
      subtotal += lineTotal;
      itemCount += row.quantity;
    } else {
      hasUnavailable = true;
    }

    items.push({
      item_id: row.item_id,
      product_id: product.id,
      product_name: product.name,
      variant_id: product.variant_id,
      variant_display_name: product.variant_display_name,
      options: loadVariantOptions(db, product.variant_id),
      unit_price_minor_units: priced.minorUnits,
      quantity: row.quantity,
      line_total_minor_units: lineTotal,
      availability: priced.availability,
      currency,
      image_url: product.image_id ? `/api/shop/images/${product.image_id}` : null,
      status: soldOut ? 'unavailable' : (overQuantity ? 'unavailable' : 'ok'),
      message: soldOut
        ? 'Sold out. Please remove it to continue.'
        : (overQuantity ? `Only ${Number(product.variant_stock)} left. Please reduce the quantity.` : null),
    });
  }

  return {
    currency,
    items,
    item_count: itemCount,
    subtotal_minor_units: subtotal,
    has_unavailable_items: hasUnavailable,
    expires_at: cart.expires_at,
  };
}