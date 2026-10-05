/**
 * Staff-only online order management API (Phase 5).
 *
 * EVERY route here requires a staff bearer token via `requireRole`. This router
 * is mounted outside the three public shop bypass predicates
 * (isPublicShopPath / isPublicShopCartPath / isPublicShopCheckoutPath), so no
 * anonymous storefront request can reach it — the catalogue, cart and checkout
 * bypasses are unchanged and still GET/cart/POST-scoped respectively.
 *
 * ROLE SPLIT
 * - View online orders: owner, manager, cashier (counters need this).
 * - Server: packing view only — reference, customer name, delivery address and
 *   items needed to pack, plus the fulfilment actions that are explicitly
 *   permitted. No payment controls, no audit detail, no cancel.
 * - Payment verification/rejection: owner, manager, cashier (approved scope).
 * - Manual expiry sweep: owner, manager.
 */

import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { getDatabase, generateShortId } from '../../db';
import { ROLE_ACCESS } from '../../../shared/role-permissions';
import { requireRole } from '../../middleware/security';
import { getTenantCurrency } from '../../services/refund';
import { minorUnitsToRupees } from '../../services/shop-money';
import {
  ONLINE_ORDER_STATUSES, FINAL_STATUSES, allowedTransitions, isFulfilmentLocked,
  type OnlineOrderStatus, type PaymentStatus,
} from '../../services/shop-order-status';
import { listActiveReservations, runExpirySweep } from '../../services/shop-reservations';
import {
  changeOrderStatus, decidePayment, loadDeclaration, loadOrder, loadOrderEvents,
  loadOrderItems, loadPaymentActions, normaliseUtr,
} from '../../services/shop-order-admin';

const router = Router();

const adminReadRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const adminWriteRateLimit = expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

const MAX_PAGE_SIZE = 60;
const DEFAULT_PAGE_SIZE = 20;

/** Roles that may see full customer contact and payment detail. */
const FULL_DETAIL_ROLES = ['owner', 'manager', 'cashier'];
/** Roles limited to packing information. */
const PACKING_ROLES = ['owner', 'manager', 'cashier', 'server'];

function roleOf(req: Request): string {
  return String((req as any).user?.role ?? '');
}

function isPackingOnly(req: Request): boolean {
  return roleOf(req) === 'server';
}

/**
 * The only steps a server may perform. Dispatch and completion consume stock and
 * release the reservation, so they remain owner/manager actions.
 */
const PACKING_ACTIONS: OnlineOrderStatus[] = ['preparing', 'packed'];

function parseId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/** Bounded, strictly-validated pagination. */
function parsePaging(req: Request): { limit: number; offset: number } | null {
  const rawLimit = req.query.limit;
  const rawOffset = req.query.offset;
  let limit = DEFAULT_PAGE_SIZE;
  let offset = 0;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d{1,3}$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_PAGE_SIZE) return null;
  }
  if (rawOffset !== undefined) {
    if (typeof rawOffset !== 'string' || !/^\d{1,6}$/.test(rawOffset)) return null;
    offset = Number(rawOffset);
    if (offset < 0) return null;
  }
  return { limit, offset };
}

function formatMinor(minorUnits: number, currency: string): string {
  if (currency.toUpperCase() !== 'INR') return `${currency.toUpperCase()} ${(minorUnits / 100).toFixed(2)}`;
  return `₹${minorUnitsToRupees(minorUnits, currency).toFixed(2)}`;
}

/** GET /api/shop/admin/orders — paginated list with status/payment filters. */
router.get('/orders', adminReadRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  const paging = parsePaging(req);
  if (!paging) return res.status(400).json({ error: 'Invalid pagination' });

  const db = getDatabase();
  // Opportunistic sweep: bounded, indexed, and only ever touches lapsed
  // pending_review rows. Runs in its own IMMEDIATE transaction so a read can
  // never observe a half-applied expiry. No cron or new infrastructure.
  try { runExpirySweep(db, { limit: 25 }); } catch { /* never fail a read */ }

  const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;
  const paymentFilter = typeof req.query.payment_status === 'string' ? req.query.payment_status : null;

  if (statusFilter && !ONLINE_ORDER_STATUSES.includes(statusFilter as OnlineOrderStatus)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }
  if (paymentFilter && !['unverified', 'verified', 'rejected', 'refunded'].includes(paymentFilter)) {
    return res.status(400).json({ error: 'Invalid payment status filter' });
  }

  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (statusFilter) { where.push('status = ?'); params.push(statusFilter); }
  if (paymentFilter) { where.push('payment_status = ?'); params.push(paymentFilter); }
  const clause = where.join(' AND ');

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM shop_orders WHERE ${clause}`).get(...params) as any).n;
  const rows = db.prepare(`
    SELECT id, reference, status, payment_status, currency, subtotal_minor_units, item_count,
           customer_name, delivery_city, reservation_expires_at, created_at, updated_at
    FROM shop_orders
    WHERE ${clause}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, paging.limit, paging.offset) as any[];

  const now = Date.now();
  return res.json({
    orders: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      source: 'online',
      status: row.status,
      payment_status: row.payment_status,
      currency: row.currency,
      subtotal_minor_units: row.subtotal_minor_units,
      subtotal_display: formatMinor(row.subtotal_minor_units, row.currency),
      item_count: row.item_count,
      customer_name: row.customer_name,
      city: row.delivery_city,
      reservation_expires_at: row.reservation_expires_at,
      age_minutes: Math.max(0, Math.round((now - new Date(row.created_at).getTime()) / 60000)),
      created_at: row.created_at,
    })),
    pagination: { ...paging, total, has_more: paging.offset + rows.length < total },
  });
});

/** GET /api/shop/admin/orders/:id — full detail, role-scoped. */
router.get('/orders/:id', adminReadRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  const orderId = parseId(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

  const db = getDatabase();
  const order = loadOrder(db, orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const packingOnly = isPackingOnly(req);
  const items = loadOrderItems(db, orderId);
  const reservations = listActiveReservations(db, orderId);
  const declaration = loadDeclaration(db, orderId);

  // A server must never be offered an action the API would refuse, so its
  // transition list is filtered to packing steps before it leaves the server.
  const transitions = packingOnly
    ? allowedTransitions(order.status).filter((target) => PACKING_ACTIONS.includes(target))
    : allowedTransitions(order.status);

  const base = {
    id: order.id,
    reference: order.reference,
    source: 'online' as const,
    status: order.status,
    payment_status: order.payment_status,
    currency: order.currency,
    subtotal_minor_units: order.subtotal_minor_units,
    subtotal_display: formatMinor(order.subtotal_minor_units, order.currency),
    item_count: order.item_count,
    created_at: order.created_at,
    updated_at: order.updated_at,
    reservation_expires_at: order.reservation_expires_at,
    reservation_held: reservations.length > 0,
    reservation_quantity: reservations.reduce((sum, row) => sum + Number(row.quantity), 0),
    fulfilled_at: order.fulfilled_at,
    is_final: FINAL_STATUSES.includes(order.status),
    fulfilment_locked: isFulfilmentLocked(order.status),
    allowed_transitions: transitions,
    items,
  };

  // A server sees what is needed to pack — name, phone and address for handover —
  // but never payment controls, the declaration, or audit detail.
  if (packingOnly) {
    return res.json({
      ...base,
      customer: {
        name: order.customer_name,
        phone: order.customer_phone,
        address: `${order.delivery_address}, ${order.delivery_city}, ${order.delivery_state} - ${order.delivery_pincode}`,
        instructions: order.delivery_instructions,
      },
      // Explicitly absent: payment actions, declaration, events. `dispatched`
      // and `completed` consume stock, so they stay with owner/manager and are
      // filtered out of `transitions` above.
      packing_actions: transitions,
      payment_actions: [],
      events: [],
      declaration: null,
    });
  }

  return res.json({
    ...base,
    customer: {
      name: order.customer_name,
      phone: order.customer_phone,
      address: `${order.delivery_address}, ${order.delivery_city}, ${order.delivery_state} - ${order.delivery_pincode}`,
      city: order.delivery_city,
      state: order.delivery_state,
      pincode: order.delivery_pincode,
      instructions: order.delivery_instructions,
    },
    declaration: declaration ? { reference: declaration.reference, declared_at: declaration.declared_at } : null,
    payment_actions: loadPaymentActions(db, orderId),
    events: loadOrderEvents(db, orderId),
  });
});

/**
 * PATCH /api/shop/admin/orders/:id/status
 *
 * Owner/manager/cashier may run any legal transition. A server may only perform
 * the packing steps it is permitted, and can never cancel, reject or verify.
 */
router.patch('/orders/:id/status', adminWriteRateLimit, requireRole(...ROLE_ACCESS.allStaff), (req: Request, res: Response) => {
  const orderId = parseId(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

  const target = req.body?.status;
  if (typeof target !== 'string' || !ONLINE_ORDER_STATUSES.includes(target as OnlineOrderStatus)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  // Expiry is produced by the sweep, never by a staff click.
  if (target === 'expired') return res.status(400).json({ error: 'Expiry is applied automatically' });

  // A server packs and hands over; it does not ship. Dispatch and completion
  // are the actions that actually consume stock and release the reservation, so
  // they stay with owner/manager. This is a feature/action boundary, not an
  // ownership check: any staff member may work any order.
  if (isPackingOnly(req) && !['preparing', 'packed'].includes(target)) {
    return res.status(403).json({ error: 'Your role cannot perform this action' });
  }

  const actorUserId = String((req as any).user?.userId ?? '');
  const result = changeOrderStatus(getDatabase(), {
    orderId, target: target as OnlineOrderStatus, actorUserId, reason: req.body?.reason,
  });
  if (!result.ok) {
    // A refused transition is a state conflict (409), not malformed input.
    const status = result.failure === 'not_found' ? 404
      : result.failure === 'reason_required' || result.failure === 'stock_unavailable'
        || result.failure === 'invalid_transition' || result.failure === 'already_fulfilled' ? 409
      : 400;
    return res.status(status).json({ error: result.message, code: result.failure });
  }
  return res.json({ status: result.value.status });
});

/**
 * POST /api/shop/admin/orders/:id/payment
 *
 * Owner, manager and cashier may verify or reject (approved scope). A server is
 * refused outright. Verification REQUIRES a validated UTR — a declaration or a
 * click alone can never mark an order paid.
 */
router.post('/orders/:id/payment', adminWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManagerCashier), (req: Request, res: Response) => {
  const orderId = parseId(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

  const action = req.body?.action;
  if (action !== 'verified' && action !== 'rejected') {
    return res.status(400).json({ error: 'Action must be verified or rejected' });
  }
  // Fail fast on a malformed UTR before touching the database.
  if (action === 'verified' && !normaliseUtr(req.body?.utr_reference)) {
    return res.status(400).json({
      error: 'Enter the UPI reference number (6-40 letters or digits) you verified.',
      code: 'invalid_utr',
    });
  }

  const result = decidePayment(getDatabase(), {
    orderId,
    action,
    actorUserId: String((req as any).user?.userId ?? ''),
    utrReference: req.body?.utr_reference,
    note: req.body?.note,
  });
  if (!result.ok) {
    // A conflict means the order's state moved under us, which is a 409 rather
    // than a bad request; only malformed input is a 400.
    const status = result.failure === 'not_found' ? 404
      : result.failure === 'already_closed' || result.failure === 'payment_conflict' ? 409
      : 400;
    return res.status(status).json({ error: result.message, code: result.failure });
  }
  return res.json({ payment_status: result.value.payment_status });
});

/**
 * POST /api/shop/admin/reservations/sweep
 *
 * Expiry sweep on demand. Expiring a pending order releases its hold, so it is
 * deliberately owner/manager only and never available to a server.
 */
router.post('/reservations/sweep', adminWriteRateLimit, requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  const result = runExpirySweep(getDatabase(), {
    limit: 200,
    actorUserId: String((req as any).user?.userId ?? ''),
  });
  return res.json({
    expired: result.expired,
    released_rows: result.releasedRows,
    references: result.references,
  });
});

export default router;
