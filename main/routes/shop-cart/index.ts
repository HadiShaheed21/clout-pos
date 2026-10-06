/**
 * Guest shopping cart API (Phase 3).
 *
 * These are WRITE routes, so they live in their own router rather than being
 * added to the Phase 1 catalogue router. That separation matters: the Phase 1
 * `isPublicShopPath` bypass is GET-only by design, and cart writes must not be
 * able to reach it. `requireAuth` is extended with a separate, narrowly scoped
 * predicate for exactly these paths.
 *
 * SAFETY
 * - The cart token is opaque and HMAC-signed; the database stores only its
 *   SHA-256 hash, so one guest can never address another's cart.
 * - Every price and availability value is derived server-side. Client-supplied
 *   prices, totals or stock are ignored outright.
 * - No order, bill, payment or stock movement is ever written here.
 * - State-changing requests require a CSRF header matching a cookie token.
 */

import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { parseCookiesForCart } from './cookie-helpers';
import { getDatabase, withTxn, generateShortId } from '../../db';
import { getTenantCurrency } from '../../services/refund';
import {
  CART_COOKIE, CART_CSRF_COOKIE, CART_CSRF_HEADER,
  MAX_CART_LINES, MAX_LINE_QUANTITY,
  buildCartView, createCart, findCartByToken, issueCartToken, loadCartProduct,
  priceAndAvailability, purgeExpiredCarts, touchCart, verifyCartToken, verifyCsrfToken,
} from '../../services/shop-cart';

const router = Router();

/** Cart lifetime used for the cookie Max-Age; matches the service TTL. */
const CART_COOKIE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Paths that bypass JWT authentication for anonymous guests.
 *
 * Deliberately explicit rather than pattern-based: only the cart resource and
 * its items, and only for the methods the cart actually uses. The Phase 1
 * catalogue bypass is unaffected.
 */
export function isPublicShopCartPath(path: string, method: string): boolean {
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(verb)) return false;
  if (typeof path !== 'string') return false;
  return /^\/api\/shop\/cart(\/items(\/[A-Za-z0-9_-]+)?)?$/.test(path);
}

/** Builds a windowed limiter from an env override, else the given default. */
export function rateLimitFor(envVar: string, fallback: number) {
  return expressRateLimit({
    windowMs: 60 * 1000,
    limit: Number.isSafeInteger(Number(process.env[envVar])) ? Number(process.env[envVar]) : fallback,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again shortly.' },
  });
}

/** Read budget; tighter than the global /api limit and not bypassed for LAN. */
const cartReadRateLimit = rateLimitFor('FLO_SHOP_RATE_LIMIT_MAX', 120);
/**
 * Write budget. Deliberately tighter: cart writes are the only public
 * mutating surface in the system.
 */
export const cartWriteRateLimit = rateLimitFor('FLO_SHOP_CART_RATE_LIMIT_MAX', 60);

/** `secure` follows deployment so plain-HTTP local development still works. */
function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function setCartCookie(res: Response, cookieValue: string, csrfToken: string): void {
  const maxAge = Math.floor(CART_COOKIE_MS / 1000);
  const attrs = ['Path=/api/shop', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (cookieSecure()) attrs.push('Secure');
  res.append('Set-Cookie', `${CART_COOKIE}=${cookieValue}; ${attrs.join('; ')}`);
  // The CSRF token is deliberately NOT HttpOnly: the browser must read it to
  // echo it back in a header. That is the double-submit pattern.
  const csrfAttrs = ['Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (cookieSecure()) csrfAttrs.push('Secure');
  res.append('Set-Cookie', `${CART_CSRF_COOKIE}=${csrfToken}; ${csrfAttrs.join('; ')}`);
}

/** Uniform 404 for unknown, forged or expired cart: no existence oracle. */
function cartNotFound(res: Response): Response {
  return res.status(404).json({ error: 'Cart not found' });
}

/**
 * Resolves the current guest cart, or null when the cookie is absent, forged
 * or expired. A dead cookie is never an error for reads: the caller issues a
 * fresh empty cart instead.
 */
function resolveCart(req: Request): { token: string; cart: NonNullable<ReturnType<typeof findCartByToken>> } | null {
  const cookies = parseCookiesForCart(req);
  const token = verifyCartToken(cookies[CART_COOKIE]);
  if (!token) return null;
  const db = getDatabase();
  const cart = findCartByToken(db, token);
  if (!cart) return null;
  return { token, cart };
}

/** Rejects a state-changing request that lacks a valid CSRF double-submit. */
function csrfOk(req: Request): boolean {
  const cookies = parseCookiesForCart(req);
  const header = req.headers[CART_CSRF_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return verifyCsrfToken(cookies[CART_CSRF_COOKIE], value);
}

/** Positive integer quantity within the configured ceiling. */
function parseQuantity(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_LINE_QUANTITY) return null;
  return value;
}

/** Opaque public id: non-empty, bounded, and restricted to safe characters. */
function parseId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/** Ensures a cart exists for this request, issuing one if the cookie was new. */
function ensureCart(req: Request, res: Response): { token: string; cart: NonNullable<ReturnType<typeof findCartByToken>> } {
  const existing = resolveCart(req);
  if (existing) return existing;
  const db = getDatabase();
  const issued = issueCartToken();
  const cart = createCart(db, issued.token);
  setCartCookie(res, issued.cookieValue, issued.csrfToken);
  return { token: issued.token, cart };
}

/** GET /api/shop/cart — this guest's cart, priced live from the catalogue. */
router.get('/', cartReadRateLimit, (req: Request, res: Response) => {
  const db = getDatabase();
  purgeExpiredCarts(db);
  const { cart } = ensureCart(req, res);
  res.json(buildCartView(db, cart, getTenantCurrency(db)));
});

/** POST /api/shop/cart/items — add a product/variant, merging repeat adds. */
router.post('/items', cartWriteRateLimit, (req: Request, res: Response) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'Invalid request' });

  const db = getDatabase();
  purgeExpiredCarts(db);

  const productId = parseId(req.body?.product_id);
  if (!productId) return res.status(400).json({ error: 'A valid product is required' });

  const rawVariant = req.body?.variant_id;
  const variantId = rawVariant === undefined || rawVariant === null ? null : parseId(rawVariant);
  if (rawVariant !== undefined && rawVariant !== null && !variantId) {
    return res.status(400).json({ error: 'Invalid variant' });
  }

  const quantity = parseQuantity(req.body?.quantity);
  if (quantity === null) {
    return res.status(400).json({ error: `Quantity must be between 1 and ${MAX_LINE_QUANTITY}` });
  }

  // Resolves published + active + undeleted AND joins the variant to THIS
  // product, so an unpublished product or a foreign variant cannot be added.
  const product = loadCartProduct(db, productId, variantId);
  if (!product) return res.status(404).json({ error: 'Not found' });

  const currency = getTenantCurrency(db);
  const priced = priceAndAvailability(product, currency);
  if (!priced) return res.status(404).json({ error: 'Not found' });
  if (priced.availability === 'out_of_stock') {
    return res.status(409).json({ error: 'This piece is sold out' });
  }

  const { token, cart } = ensureCart(req, res);

  const existing = db.prepare(
    'SELECT id, quantity FROM shop_cart_items WHERE cart_id = ? AND product_id = ? AND variant_id IS ?',
  ).get(cart.id, productId, variantId) as { id: string; quantity: number } | undefined;

  // Merging is capped by the configured ceiling. This is NOT a stock
  // reservation: stock is re-checked in the Phase 4 order transaction.
  const nextQuantity = Math.min((existing?.quantity ?? 0) + quantity, MAX_LINE_QUANTITY);

  if (!existing) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM shop_cart_items WHERE cart_id = ?')
      .get(cart.id) as { n: number };
    if (count.n >= MAX_CART_LINES) {
      return res.status(400).json({ error: 'Your bag is full. Please remove an item.' });
    }
  }

  withTxn(() => {
    if (existing) {
      db.prepare('UPDATE shop_cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(nextQuantity, existing.id);
    } else {
      db.prepare(`
        INSERT INTO shop_cart_items (id, cart_id, product_id, variant_id, quantity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(generateShortId('shop_cart_items'), cart.id, productId, variantId, nextQuantity);
    }
    touchCart(db, cart.id);
  });

  const refreshed = findCartByToken(db, token);
  if (!refreshed) return cartNotFound(res);
  return res.status(200).json(buildCartView(db, refreshed, currency));
});


/** PATCH /api/shop/cart/items/:itemId — change the quantity of one line. */
router.patch('/items/:itemId', cartWriteRateLimit, (req: Request, res: Response) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'Invalid request' });

  const db = getDatabase();
  purgeExpiredCarts(db);

  const itemId = parseId(req.params.itemId);
  if (!itemId) return res.status(400).json({ error: 'Invalid cart item' });

  const quantity = parseQuantity(req.body?.quantity);
  if (quantity === null) {
    return res.status(400).json({ error: `Quantity must be between 1 and ${MAX_LINE_QUANTITY}` });
  }

  const resolved = resolveCart(req);
  if (!resolved) return cartNotFound(res);
  const { token, cart } = resolved;

  // Scoped to this cart, so one guest can never alter another's line.
  const line = db.prepare('SELECT product_id, variant_id FROM shop_cart_items WHERE id = ? AND cart_id = ?')
    .get(itemId, cart.id) as { product_id: string; variant_id: string | null } | undefined;
  if (!line) return cartNotFound(res);

  // Re-derive from the current catalogue before accepting a new quantity.
  const product = loadCartProduct(db, line.product_id, line.variant_id);
  if (!product) return res.status(409).json({ error: 'This piece is no longer available' });
  const currency = getTenantCurrency(db);
  const priced = priceAndAvailability(product, currency);
  if (!priced) return res.status(409).json({ error: 'This piece is no longer available' });
  if (priced.availability === 'out_of_stock') {
    return res.status(409).json({ error: 'This piece is sold out' });
  }

  withTxn(() => {
    db.prepare('UPDATE shop_cart_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(quantity, itemId);
    touchCart(db, cart.id);
  });

  const refreshed = findCartByToken(db, token);
  if (!refreshed) return cartNotFound(res);
  return res.json(buildCartView(db, refreshed, currency));
});

/** DELETE /api/shop/cart/items/:itemId — remove one line from this guest's cart. */
router.delete('/items/:itemId', cartWriteRateLimit, (req: Request, res: Response) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'Invalid request' });

  const db = getDatabase();
  purgeExpiredCarts(db);

  const itemId = parseId(req.params.itemId);
  if (!itemId) return res.status(400).json({ error: 'Invalid cart item' });

  const resolved = resolveCart(req);
  if (!resolved) return cartNotFound(res);
  const { token, cart } = resolved;

  const result = db.prepare('DELETE FROM shop_cart_items WHERE id = ? AND cart_id = ?')
    .run(itemId, cart.id);
  if (result.changes === 0) return cartNotFound(res);
  touchCart(db, cart.id);

  const refreshed = findCartByToken(db, token);
  if (!refreshed) return cartNotFound(res);
  return res.json(buildCartView(db, refreshed, getTenantCurrency(db)));
});

/** DELETE /api/shop/cart — empty this guest's cart only. */
router.delete('/', cartWriteRateLimit, (req: Request, res: Response) => {
  if (!csrfOk(req)) return res.status(403).json({ error: 'Invalid request' });

  const db = getDatabase();
  purgeExpiredCarts(db);

  const resolved = resolveCart(req);
  if (!resolved) return cartNotFound(res);
  const { token, cart } = resolved;

  withTxn(() => {
    db.prepare('DELETE FROM shop_cart_items WHERE cart_id = ?').run(cart.id);
    touchCart(db, cart.id);
  });

  const refreshed = findCartByToken(db, token);
  if (!refreshed) return cartNotFound(res);
  return res.json(buildCartView(db, refreshed, getTenantCurrency(db)));
});

export default router;
