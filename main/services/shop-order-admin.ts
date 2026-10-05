/**
 * Staff-facing online order management (Phase 5).
 *
 * Separates two concerns that must never be confused:
 *   - FULFILMENT status: pending_review -> ... -> completed, plus rejected /
 *     cancelled / expired. Owned by staff actions and the expiry sweep.
 *   - PAYMENT status: unverified -> verified | rejected. Owned ONLY by an
 *     explicit staff decision backed by real transaction evidence. A customer
 *     declaration, a QR scan or a WhatsApp message is never sufficient.
 *
 * Online revenue is NEVER written into the POS `orders` or `bills` tables, so it
 * cannot inflate in-store sales, cash totals or X/Z reports. Fulfilment instead
 * records a normal `sale` stock movement carrying reference_type='shop_order',
 * which keeps existing stock reporting intact while leaving sales money alone.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { getDatabase, generateShortId } from '../db';
import { recordStockMovement } from './stock-movements';
import {
  FINAL_STATUSES, ONLINE_ORDER_STATUSES, allowedTransitions, evaluateTransition,
  isFulfilmentLocked, recordOrderEvent, requiresReason,
  type OnlineOrderStatus, type PaymentStatus,
} from './shop-order-status';
import { expireStaleOrder, listActiveReservations, releaseReservations } from './shop-reservations';

const MAX_UTR_LENGTH = 40;
const MAX_NOTE_LENGTH = 500;

/** Strips control characters and bounds a free-text field. */
function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

/**
 * UTR validation.
 *
 * UPI reference numbers are alphanumeric; 6-40 characters is the range seen in
 * practice. Letters and digits only, so a reference can never carry markup or a
 * stray control character into the audit trail.
 */
export function normaliseUtr(raw: unknown): string | null {
  const cleaned = cleanText(raw, MAX_UTR_LENGTH);
  if (!cleaned) return null;
  if (!/^[A-Za-z0-9]{6,40}$/.test(cleaned)) return null;
  return cleaned.toUpperCase();
}

export interface AdminOrderRow {
  id: string;
  reference: string;
  status: OnlineOrderStatus;
  payment_status: PaymentStatus;
  currency: string;
  subtotal_minor_units: number;
  item_count: number;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  delivery_city: string;
  delivery_state: string;
  delivery_pincode: string;
  delivery_instructions: string | null;
  reservation_expires_at: string | null;
  fulfilled_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AdminFailure =
  | 'not_found' | 'invalid_transition' | 'invalid_utr' | 'note_too_long'
  | 'reason_required' | 'already_closed' | 'payment_conflict' | 'stock_unavailable'
  | 'already_fulfilled';

export type AdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: AdminFailure; message: string };

/** Shared shape for the list and detail projections. */
export function loadOrder(db: BetterSqlite3.Database, orderId: string): AdminOrderRow | undefined {
  return db.prepare('SELECT * FROM shop_orders WHERE id = ?').get(orderId) as AdminOrderRow | undefined;
}

export function loadOrderItems(db: BetterSqlite3.Database, orderId: string) {
  const rows = db.prepare(
    'SELECT * FROM shop_order_items WHERE order_id = ? ORDER BY created_at, id',
  ).all(orderId) as any[];
  return rows.map((row) => {
    let options: { name: string; value: string }[] = [];
    try { options = row.options_json ? JSON.parse(row.options_json) : []; } catch { options = []; }
    return {
      product_id: row.product_id,
      variant_id: row.variant_id,
      product_name: row.product_name,
      variant_display_name: row.variant_display_name,
      options,
      quantity: row.quantity,
      unit_price_minor_units: row.unit_price_minor_units,
      line_total_minor_units: row.line_total_minor_units,
    };
  });
}

export function loadOrderEvents(db: BetterSqlite3.Database, orderId: string) {
  return db.prepare(`
    SELECT e.id, e.actor_user_id, e.from_status, e.to_status, e.reason, e.created_at,
           u.name AS actor_name
    FROM shop_order_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.order_id = ?
    ORDER BY e.created_at, e.id
  `).all(orderId) as any[];
}

export function loadPaymentActions(db: BetterSqlite3.Database, orderId: string) {
  return db.prepare(`
    SELECT a.id, a.actor_user_id, a.action, a.utr_reference, a.note,
           a.previous_payment_status, a.new_payment_status, a.created_at,
           u.name AS actor_name
    FROM shop_order_payment_actions a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.order_id = ?
    ORDER BY a.created_at, a.id
  `).all(orderId) as any[];
}

export function loadDeclaration(db: BetterSqlite3.Database, orderId: string) {
  return db.prepare(
    'SELECT reference, declared_at FROM shop_payment_declarations WHERE order_id = ? ORDER BY declared_at LIMIT 1',
  ).get(orderId) as { reference: string | null; declared_at: string } | undefined;
}

/**
 * Records a staff payment decision.
 *
 * A customer's declaration is never enough: this requires an explicit staff
 * action with a validated UTR. The audit row and the status update are written in
 * the SAME transaction, so a failure cannot leave a verified payment unaudited or
 * an audit row without its status change.
 *
 * Re-verifying an already-verified order is refused rather than duplicated, so a
 * retried request cannot create two contradictory audit entries.
 */
export function decidePayment(
  db: BetterSqlite3.Database,
  input: { orderId: string; action: 'verified' | 'rejected'; actorUserId: string; utrReference?: unknown; note?: unknown },
): AdminResult<{ payment_status: PaymentStatus }> {
  if (input.action === 'verified') {
    const utr = normaliseUtr(input.utrReference);
    if (!utr) {
      return {
        ok: false,
        failure: 'invalid_utr',
        message: 'Enter the UPI reference number (6-40 letters or digits) you verified against your account.',
      };
    }
  }

  const note = input.note === undefined || input.note === null ? null : cleanText(input.note, MAX_NOTE_LENGTH);
  if (input.note !== undefined && input.note !== null && !note) {
    return { ok: false, failure: 'note_too_long', message: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` };
  }

  return withImmediate(() => {
    // A lapsed pending order is closed before the decision is considered, so a
    // direct payment call cannot bypass the sweep that a list request performs.
    expireStaleOrder(db, input.orderId, input.actorUserId);
    const order = loadOrder(db, input.orderId);
    if (!order) return { ok: false as const, failure: 'not_found' as const, message: 'Order not found.' };

    if (FINAL_STATUSES.includes(order.status)) {
      return {
        ok: false as const, failure: 'already_closed' as const,
        message: `This order is closed (${order.status.replace(/_/g, ' ')}) and its payment can no longer change.`,
      };
    }

    const previous = order.payment_status;
    const next: PaymentStatus = input.action === 'verified' ? 'verified' : 'rejected';

    if (previous === next) {
      return {
        ok: false as const, failure: 'payment_conflict' as const,
        message: `Payment is already marked ${next}.`,
      };
    }
    if (previous === 'verified') {
      return {
        ok: false as const, failure: 'payment_conflict' as const,
        message: 'This order is already verified as paid and cannot be re-decided.',
      };
    }

    // Re-checked inside the transaction so a concurrent sweep or cancel cannot
    // let a decision land on a closed order.
    const fresh = db.prepare('SELECT status, payment_status FROM shop_orders WHERE id = ?').get(input.orderId) as any;
    if (!fresh) return { ok: false as const, failure: 'not_found' as const, message: 'Order not found.' };
    if (FINAL_STATUSES.includes(fresh.status) || fresh.payment_status !== previous) {
      return {
        ok: false as const, failure: 'payment_conflict' as const,
        message: 'This order changed while you were working. Reload and try again.',
      };
    }

    const utr = input.action === 'verified' ? normaliseUtr(input.utrReference) : null;

    db.prepare(`
      INSERT INTO shop_order_payment_actions
        (id, order_id, actor_user_id, action, utr_reference, note,
         previous_payment_status, new_payment_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      generateShortId('shop_order_payment_actions'), input.orderId, input.actorUserId,
      input.action, utr, note, previous, next,
    );

    db.prepare(
      'UPDATE shop_orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(next, input.orderId);

    return { ok: true as const, value: { payment_status: next } };
  });
}

/**
 * Runs `fn` inside a single immediate (write-locked) transaction.
 *
 * Mirrors the Phase 4 checkout so admin mutations serialise the same way, which
 * is what makes concurrent verification, release and fulfilment safe.
 */
function withImmediate<T>(fn: () => T): T {
  const db = getDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

/**
 * Applies a staff status change.
 *
 * Dispatching or completing is where stock is actually consumed: the order's own
 * reservation is released and physical stock decremented in the same statement
 * batch, so stock is deducted exactly once and never for an order that did not
 * ship. `fulfilled_at` is the second guard — a retried dispatch finds it already
 * set and refuses.
 *
 * NO POS `orders` or `bills` row is created. Online money stays in
 * `shop_orders.subtotal_minor_units`, so in-store revenue reporting is unchanged.
 */
export function changeOrderStatus(
  db: BetterSqlite3.Database,
  input: { orderId: string; target: OnlineOrderStatus; actorUserId: string; reason?: unknown },
): AdminResult<{ status: OnlineOrderStatus }> {
  const reason = input.reason === undefined || input.reason === null
    ? null
    : cleanText(input.reason, MAX_NOTE_LENGTH);

  if (requiresReason(input.target) && !reason) {
    return {
      ok: false,
      failure: 'reason_required',
      message: `A reason is required when marking an order ${input.target}.`,
    };
  }

  const dbHandle = getDatabase();
  dbHandle.exec('BEGIN IMMEDIATE');
  try {
    // Close a lapsed pending order first, so accepting or fulfilling an order
    // whose 2-hour window has passed is impossible without a prior list request.
    expireStaleOrder(db, input.orderId, input.actorUserId);
    const order = loadOrder(db, input.orderId);
    if (!order) {
      dbHandle.exec('ROLLBACK');
      return { ok: false, failure: 'not_found', message: 'Order not found.' };
    }

    const active = listActiveReservations(db, input.orderId);
    const alreadyFulfilled = Boolean(order.fulfilled_at);
    const check = evaluateTransition(
      order.status, order.payment_status, input.target,
      active.length > 0, active.length === 0,
    );
    if (!check.ok) {
      dbHandle.exec('ROLLBACK');
      return { ok: false, failure: 'invalid_transition', message: check.error ?? 'Invalid transition.' };
    }

    // Fulfilment re-checks live stock BEFORE consuming anything, so an order
    // cannot ship against stock another sale already took.
    if (check.marksShipped) {
      // `dispatched` then `completed` are BOTH shipment points, but stock may
      // only be consumed once. `fulfilled_at` (alreadyFulfilled) is the guard.
      for (const row of active) {
        const owner = row.variant_id
          ? db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ? AND deleted_at IS NULL').get(row.variant_id) as any
          : db.prepare('SELECT stock_quantity FROM products WHERE id = ? AND deleted_at IS NULL').get(row.product_id) as any;
        if (!owner || Number(owner.stock_quantity) < Number(row.quantity)) {
          dbHandle.exec('ROLLBACK');
          return {
            ok: false,
            failure: 'stock_unavailable',
            message: 'Stock for this order is no longer available. Resolve it before dispatching.',
          };
        }
      }
    }

    // Physical stock is consumed ONLY when the order actually ships.
    //
    // Both `dispatched` and `completed` are shipment points, so `fulfilled_at`
    // guards against consuming twice across the two. Every other transition
    // (accepted, preparing, packed, cancelled, ...) leaves stock alone: an order
    // that is merely being prepared still holds its reservation, and deducting
    // physical stock there would double-count the same units.
    const consumeRows = check.marksShipped && !alreadyFulfilled ? active : [];

    for (const row of consumeRows) {
      const before = row.variant_id
        ? (db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(row.variant_id) as any).stock_quantity
        : (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(row.product_id) as any).stock_quantity;

      if (row.variant_id) {
        db.prepare('UPDATE product_variants SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(row.quantity, row.variant_id);
      } else {
        db.prepare('UPDATE products SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(row.quantity, row.product_id);
      }

      // Reuses the EXISTING 'sale' movement type with an online reference, so
      // stock reports keep working and no new movement type is needed.
      recordStockMovement(db, {
        productId: row.product_id,
        variantId: row.variant_id,
        quantityDelta: -row.quantity,
        previousQuantity: Number(before),
        movementType: 'sale',
        referenceType: 'shop_order',
        referenceId: input.orderId,
        reason: `Online order ${order.reference}`,
        actorUserId: input.actorUserId,
        createdAt: new Date().toISOString(),
      });
    }

    if (check.releasesReservation) {
      // Release AFTER deducting, so available stock never dips to a negative
      // window mid-transaction.
      const releaseReason = check.marksShipped ? 'fulfilled'
        : input.target === 'cancelled' ? 'cancelled'
        : 'rejected';
      releaseReservations(db, input.orderId, releaseReason, input.actorUserId);
    }

    db.prepare(`
      UPDATE shop_orders
      SET status = ?,
          cancelled_at = CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
          cancellation_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE cancellation_reason END,
          fulfilled_at = CASE WHEN ? IN ('dispatched', 'completed') THEN CURRENT_TIMESTAMP ELSE fulfilled_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(input.target, input.target, input.target, reason, input.target, input.orderId);

    recordOrderEvent(db, {
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      from: order.status,
      to: input.target,
      reason,
    });

    dbHandle.exec('COMMIT');
    return { ok: true, value: { status: input.target } };
  } catch (error) {
    try { dbHandle.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}
