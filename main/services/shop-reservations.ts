/**
 * Reservation ledger for online orders (Phase 5).
 *
 * WHY THIS EXISTS
 * Phase 4 reserved stock with a bare `shop_reserved_quantity` counter and no
 * record of which order held it. Releasing that counter safely was therefore
 * impossible: decrementing it could free stock belonging to a DIFFERENT order.
 * This module makes every reservation an owned, releasable, auditable row.
 *
 * EXACTLY-ONCE
 * A release only ever touches ledger rows whose `released_at IS NULL`, and it
 * stamps that column in the same transaction as the counter decrement. A retried
 * cancel, a racing expiry sweep and a manual release therefore contend for the
 * same rows, and whichever wins leaves the rest as no-ops. There is no path that
 * decrements a counter without an owned, unreleased ledger row backing it.
 *
 * STOCK MODEL
 * `stock_quantity` is sale stock, `shop_reserved_quantity` is online holds. They
 * are independent, so POS sales, cancellations and refunds are untouched.
 * Available = stock_quantity - shop_reserved_quantity.
 */

import { randomBytes } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { generateShortId, getDatabase } from '../db';

/** Pending-review holds lapse exactly 2 hours after checkout. */
export const RESERVATION_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Statuses that may still hold a reservation. */
export const RESERVATION_ACTIVE_STATUSES = ['pending_review', 'accepted', 'preparing', 'packed'] as const;

/** Terminal statuses; their reservations must already be released. */
export const TERMINAL_STATUSES = ['completed', 'rejected', 'cancelled', 'expired'] as const;

export type ReleaseReason = 'cancelled' | 'expired' | 'rejected' | 'fulfilled' | 'manual';

export interface ReservationRow {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  created_at: string;
  released_at: string | null;
  released_by_user_id: string | null;
  release_reason: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Sets the 2-hour expiry when an order is created. */
export function reservationExpiryFrom(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + RESERVATION_WINDOW_MS).toISOString();
}

/**
 * Records a reservation at checkout.
 *
 * Idempotent per (order, product, variant) via the table's UNIQUE constraint, so
 * a retried insert cannot double-count a hold.
 */
export function recordReservation(
  db: BetterSqlite3.Database,
  input: { orderId: string; productId: string; variantId: string | null; quantity: number },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO shop_order_reservations
      (id, order_id, product_id, variant_id, quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(generateShortId('shop_order_reservations'), input.orderId, input.productId, input.variantId, input.quantity, nowIso());
}

/** All reservation rows for an order, newest last. */
export function listReservations(db: BetterSqlite3.Database, orderId: string): ReservationRow[] {
  return db.prepare(
    'SELECT * FROM shop_order_reservations WHERE order_id = ? ORDER BY created_at, id',
  ).all(orderId) as ReservationRow[];
}

/** Reservations for an order that have not been released yet. */
export function listActiveReservations(db: BetterSqlite3.Database, orderId: string): ReservationRow[] {
  return db.prepare(
    'SELECT * FROM shop_order_reservations WHERE order_id = ? AND released_at IS NULL ORDER BY created_at, id',
  ).all(orderId) as ReservationRow[];
}

/**
 * Decrements an online hold by exactly `quantity`.
 *
 * The `shop_reserved_quantity >= ?` guard makes the UPDATE itself conditional, so
 * a counter/ledger mismatch fails the enclosing transaction instead of silently
 * clamping to zero. Clamping would hide drift and could let one order's release
 * consume stock reserved for another; here the mismatch aborts the transaction.
 */
function decrementReserved(db: BetterSqlite3.Database, productId: string, variantId: string | null, quantity: number): void {
  const sql = variantId
    ? `UPDATE product_variants
         SET shop_reserved_quantity = shop_reserved_quantity - ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND shop_reserved_quantity >= ?`
    : `UPDATE products
         SET shop_reserved_quantity = shop_reserved_quantity - ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND shop_reserved_quantity >= ?`;

  const result = db.prepare(sql).run(quantity, variantId ?? productId, quantity);
  if (result.changes !== 1) {
    throw new Error(
      `Reservation release mismatch: ${variantId ?? productId} holds fewer than ${quantity} reserved unit(s)`,
    );
  }
}

export interface ReleaseResult {
  released: number;
  rows: ReservationRow[];
}

/**
 * Releases an order's outstanding reservations, exactly once.
 *
 * MUST be called inside a transaction. Only rows with `released_at IS NULL` are
 * touched, so calling this repeatedly — or concurrently with an expiry — cannot
 * release the same stock twice. Returns the rows actually released, which is
 * empty on every call after the first.
 */
export function releaseReservations(
  db: BetterSqlite3.Database,
  orderId: string,
  reason: ReleaseReason,
  actorUserId: string | null,
): ReleaseResult {
  const active = listActiveReservations(db, orderId);
  if (active.length === 0) return { released: 0, rows: [] };

  const stamp = db.prepare(`
    UPDATE shop_order_reservations
    SET released_at = ?, released_by_user_id = ?, release_reason = ?
    WHERE id = ? AND released_at IS NULL
  `);

  const released: ReservationRow[] = [];
  for (const row of active) {
    // The AND released_at IS NULL guard makes this safe under retry/race: if a
    // concurrent actor already released the row, changes === 0 and we skip the
    // counter decrement entirely.
    const result = stamp.run(nowIso(), actorUserId, reason, row.id);
    if (result.changes !== 1) continue;
    decrementReserved(db, row.product_id, row.variant_id, row.quantity);
    released.push({ ...row, released_at: nowIso(), release_reason: reason });
  }

  return { released: released.length, rows: released };
}
/** True when a pending order's 2-hour hold has lapsed. */
export function isReservationExpired(db: BetterSqlite3.Database, orderId: string): boolean {
  const row = db.prepare(
    "SELECT reservation_expires_at FROM shop_orders WHERE id = ? AND status = 'pending_review'",
  ).get(orderId) as { reservation_expires_at: string | null } | undefined;
  if (!row?.reservation_expires_at) return false;
  return new Date(row.reservation_expires_at).getTime() <= Date.now();
}

export interface SweepResult {
  expired: number;
  releasedRows: number;
  references: string[];
}

/**
 * Expires lapsed pending-review orders and releases their holds.
 *
 * ONLY `pending_review` is eligible. An order a staff member has already accepted
 * or begun preparing holds its stock deliberately and must never lapse
 * automatically.
 *
 * Idempotent: an order is re-read inside the transaction and skipped if it is no
 * longer pending, so repeated sweeps and a concurrent staff acceptance cannot
 * both expire it.
 *
 * MUST be called inside a transaction.
 */
export function sweepExpiredOrders(
  db: BetterSqlite3.Database,
  options: { limit?: number; actorUserId?: string | null } = {},
): SweepResult {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const now = nowIso();

  const candidates = db.prepare(`
    SELECT id, reference FROM shop_orders
    WHERE status = 'pending_review'
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at <= ?
    ORDER BY reservation_expires_at
    LIMIT ?
  `).all(now, limit) as { id: string; reference: string }[];

  const result: SweepResult = { expired: 0, releasedRows: 0, references: [] };

  for (const candidate of candidates) {
    // Re-read under the transaction: another actor may have accepted or moved it.
    const fresh = db.prepare(
      "SELECT status FROM shop_orders WHERE id = ? AND status = 'pending_review' AND reservation_expires_at <= ?",
    ).get(candidate.id, now) as { status: string } | undefined;
    if (!fresh) continue;

    const released = releaseReservations(db, candidate.id, 'expired', options.actorUserId ?? null);

    db.prepare(`
      UPDATE shop_orders
      SET status = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending_review'
    `).run(candidate.id);

    db.prepare(`
      INSERT INTO shop_order_events (id, order_id, actor_user_id, from_status, to_status, reason, created_at)
      VALUES (?, ?, ?, 'pending_review', 'expired', ?, ?)
    `).run(generateShortId('shop_order_events'), candidate.id, options.actorUserId ?? null,
      'Reservation expired after 2 hours', now);

    result.expired += 1;
    result.releasedRows += released.released;
    result.references.push(candidate.reference);
  }

  return result;
}

/**
 * Runs `sweepExpiredOrders` inside an IMMEDIATE transaction.
 *
 * The sweep performs three writes per order — release the hold, move the status,
 * append the event — and they must all land or none. Without the wrapper a
 * failure midway could leave an order marked expired while its stock stayed
 * reserved, or vice versa. `IMMEDIATE` takes the write lock up front so the
 * candidate re-read cannot race a concurrent staff acceptance.
 */
export function runExpirySweep(
  db: BetterSqlite3.Database,
  options: { limit?: number; actorUserId?: string | null } = {},
): SweepResult {
  const sweep = db.transaction(() => sweepExpiredOrders(db, options));
  return (sweep.immediate ? sweep.immediate() : sweep()) as SweepResult;
}

/**
 * Expires a lapsed pending order on demand, in a transaction.
 *
 * Called before any acceptance, payment decision or fulfilment so a direct
 * action on an order that should already have lapsed cannot bypass the sweep
 * that a list request would otherwise have performed. Returns false when the
 * order was not eligible (already accepted, or still inside its window).
 *
 * MUST be called inside a transaction; the caller owns the surrounding work.
 */
export function expireStaleOrder(
  db: BetterSqlite3.Database,
  orderId: string,
  actorUserId: string | null = null,
): boolean {
  const now = nowIso();
  const row = db.prepare(`
    SELECT id, reference FROM shop_orders
    WHERE id = ? AND status = 'pending_review'
      AND reservation_expires_at IS NOT NULL AND reservation_expires_at <= ?
  `).get(orderId, now) as { id: string; reference: string } | undefined;
  if (!row) return false;

  releaseReservations(db, orderId, 'expired', actorUserId);
  db.prepare(`
    UPDATE shop_orders SET status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending_review'
  `).run(orderId);
  db.prepare(`
    INSERT INTO shop_order_events (id, order_id, actor_user_id, from_status, to_status, reason, created_at)
    VALUES (?, ?, ?, 'pending_review', 'expired', ?, ?)
  `).run(generateShortId('shop_order_events'), orderId, actorUserId,
    'Reservation expired after 2 hours', now);
  return true;
}
