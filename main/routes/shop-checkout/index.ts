/**
 * Checkout API (Phase 4): creates ONE pending online order from the guest cart.
 *
 * SCOPE
 * Exactly one public write surface: `POST /api/shop/checkout`. There is no
 * public GET, no public order lookup, and no way for a caller to set status,
 * payment, price or stock. Those belong to the authorized POS surface (Phase 5).
 *
 * SAFETY
 * - The guest cart cookie is the only identity; no login is required.
 * - CSRF double-submit protects the mutation.
 * - Idempotency key is scoped to the cart and enforced by a composite PRIMARY
 *   KEY, so concurrent duplicates cannot create two orders.
 * - Order creation, stock reservation, idempotency record and cart clearing all
 *   happen inside one `BEGIN IMMEDIATE` transaction, so a failure leaves no
 *   partial order, no orphaned lines and no stray reservation.
 * - Creating an order is NOT payment: payment_status stays `unverified`.
 */

import { Router, Request, Response } from 'express';
import { getDatabase } from '../../db';
import {
  acceptIdempotencyKey, buildConfirmationPayment, buildOrderConfirmation, createOnlineOrder,
  StockShortError, validateCustomer, withImmediateTxn,
} from '../../services/shop-orders';
import { recordPaymentDeclaration } from '../../services/shop-payments';
import { CART_COOKIE, findCartByToken, verifyCartToken } from '../../services/shop-cart';
import { cartWriteRateLimit } from '../shop-cart';
import { parseCookiesForCart, csrfOkForCart } from '../shop-cart/cookie-helpers';

const router = Router();

/**
 * Public bypass for checkout. Extends the Phase 3 cart surface by exactly one
 * path and one verb; the catalogue bypass remains untouched.
 */
export function isPublicShopCheckoutPath(path: string, method: string): boolean {
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return false;
  if (typeof path !== 'string') return false;
  // Exactly two POST endpoints: order creation and the payment declaration.
  return path === '/api/shop/checkout' || path === '/api/shop/checkout/declaration';
}

router.post('/', cartWriteRateLimit, async (req: Request, res: Response) => {
  if (!csrfOkForCart(req)) return res.status(403).json({ error: 'Invalid request' });

  const db = getDatabase();

  // Identity comes from the cookie, never the body.
  const cookies = parseCookiesForCart(req);
  const token = verifyCartToken(cookies[CART_COOKIE]);
  if (!token) return res.status(401).json({ error: 'Your bag session has expired. Please add your items again.' });

  const customer = validateCustomer(req.body?.customer);
  if (!customer.ok) return res.status(400).json({ error: customer.message });

  const idempotencyKey = acceptIdempotencyKey(
    req.headers['idempotency-key'] ?? req.body?.idempotency_key,
  );

  let result;
  try {
    result = withImmediateTxn(() => {
      const cart = findCartByToken(db, token);
      if (!cart) return { expired: true } as const;

      // Recovery is consulted BEFORE the empty-cart check.
      //
      // A retry after a committed checkout finds an EMPTY cart (we cleared it),
      // so the empty-cart branch below would otherwise report failure for an
      // order that actually exists — the worst possible outcome after a lost
      // response. Two lookups run here:
      //   1. by (cart_id, idempotency_key) — the exact same logical attempt;
      //   2. by cart_id alone — any prior order for this cart, because
      //      `shop_orders.cart_id` is UNIQUE so a cart can only ever be spent
      //      once. This catches a client that retries without reusing its key,
      //      and prevents a cleared cart from spawning a second order.
      const byKey = db.prepare(
        'SELECT i.payload_hash, o.id AS order_id, o.reference FROM shop_checkout_idempotency i ' +
        'JOIN shop_orders o ON o.id = i.order_id ' +
        'WHERE i.cart_id = ? AND i.idempotency_key = ?',
      ).get(cart.id, idempotencyKey) as any;
      if (byKey) {
        return {
          created: {
            ok: true as const,
            value: { orderId: byKey.order_id, reference: byKey.reference, replayed: true },
          },
        } as const;
      }

      const byCart = db.prepare('SELECT id, reference FROM shop_orders WHERE cart_id = ?').get(cart.id) as any;
      if (byCart) {
        return {
          created: {
            ok: true as const,
            value: { orderId: byCart.id, reference: byCart.reference, replayed: true },
          },
        } as const;
      }

      const lines = db.prepare(
        'SELECT product_id, variant_id, quantity FROM shop_cart_items WHERE cart_id = ? ORDER BY created_at, id',
      ).all(cart.id) as { product_id: string; variant_id: string | null; quantity: number }[];

      if (lines.length === 0) {
        return { empty: true } as const;
      }

      const created = createOnlineOrder(db, cart.id, cart.token_hash, customer.value, idempotencyKey, lines);
      return { created } as const;
    });
  } catch (error) {
    // A lost reservation race inside the transaction is a normal 409, not a 500.
    if (error instanceof StockShortError) {
      return res.status(409).json({
        error: 'Another shopper just took the last of an item in your bag. Please review your bag.',
        code: 'insufficient_stock',
      });
    }
    console.error('[shop-checkout] checkout failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'We could not complete your order. Please try again.' });
  }

  if ('expired' in result) {
    return res.status(401).json({ error: 'Your bag session has expired. Please add your items again.', code: 'cart_expired' });
  }
  if ('empty' in result) {
    return res.status(400).json({ error: 'Your bag is empty.', code: 'cart_empty' });
  }

  const created = result.created;
  if (!created.ok) {
    // Customer-safe message only; no internal ids, stock counts or SQL detail.
    return res.status(created.failure === 'insufficient_stock' || created.failure === 'item_unavailable' ? 409 : 400).json({
      error: created.message,
      code: created.failure,
    });
  }

  const confirmation = buildOrderConfirmation(db, created.value.orderId);
  if (!confirmation) return res.status(500).json({ error: 'We could not load your order. Please retry.' });

  // QR generation is async and derived from the server-side subtotal, so the
  // amount scanned can never disagree with the order.
  const upi = await buildConfirmationPayment(db, created.value.orderId);

  // 200 (not 201) on replay so a retry is indistinguishable from the original.
  return res.status(created.value.replayed ? 200 : 201).json({
    order: confirmation,
    upi,
    replayed: created.value.replayed,
    payment_required: true,
  });
});

/**
 * POST /api/shop/checkout/declaration
 *
 * Records the CUSTOMER's claim that they paid. This is explicitly NOT
 * verification: `payment_status` stays 'unverified' and only staff can change
 * it, through the authorized POS surface.
 *
 * Authorised the same way as checkout — by the guest cart cookie — so an order
 * reference alone can never be used to touch another guest's order.
 */
router.post('/declaration', cartWriteRateLimit, async (req: Request, res: Response) => {
  if (!csrfOkForCart(req)) return res.status(403).json({ error: 'Invalid request' });

  const db = getDatabase();
  const cookies = parseCookiesForCart(req);
  const token = verifyCartToken(cookies[CART_COOKIE]);
  if (!token) return res.status(401).json({ error: 'Your bag session has expired.' });

  if (req.body?.declared !== true) {
    return res.status(400).json({ error: 'Nothing to declare.' });
  }

  const reference = typeof req.body?.reference === 'string' ? req.body.reference : null;

  try {
    const result = withImmediateTxn(() => {
      const cart = findCartByToken(db, token);
      if (!cart) return null;
      // Resolve the order through the CART, never through a supplied reference.
      const order = db.prepare('SELECT id, reference FROM shop_orders WHERE cart_id = ?').get(cart.id) as any;
      if (!order) return null;
      const declaration = recordPaymentDeclaration(db, order.id, reference);
      return { reference: order.reference, declaration, orderId: order.id };
    });
    if (!result) return res.status(404).json({ error: 'No order found for this bag.' });

    const confirmation = buildOrderConfirmation(db, result.orderId);
    if (!confirmation) return res.status(500).json({ error: 'We could not read your order.' });

    return res.json({
      order: confirmation,
      // Unchanged by design: staff verify independently.
      payment_status: 'unverified',
      payment_declared: true,
    });
  } catch (error) {
    console.error('[shop-checkout] declaration failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'We could not record that. Please try again.' });
  }
});

export default router;