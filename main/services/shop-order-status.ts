/**
 * Online order status transitions (Phase 5).
 *
 * Lifecycle:
 *   pending_review -> accepted -> preparing -> packed -> dispatched -> completed
 * Terminal exits from anywhere in the active chain:
 *   rejected | cancelled | expired
 *
 * The transition map is enforced on the BACKEND, not merely hidden in the UI, so
 * a crafted request cannot move an order into an impossible state. `expired` is
 * the one status the customer cannot influence and staff cannot set manually —
 * only the expiry sweep produces it — because it carries a stock side effect that
 * must not be triggerable by an impatient click.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { generateShortId } from '../db';

export type OnlineOrderStatus =
  | 'pending_review' | 'accepted' | 'preparing' | 'packed'
  | 'dispatched' | 'completed' | 'rejected' | 'cancelled' | 'expired';

export type PaymentStatus = 'unverified' | 'verified' | 'rejected' | 'refunded';

export const ONLINE_ORDER_STATUSES: OnlineOrderStatus[] = [
  'pending_review', 'accepted', 'preparing', 'packed',
  'dispatched', 'completed', 'rejected', 'cancelled', 'expired',
];

/** Statuses that can no longer change or be fulfilled. */
export const FINAL_STATUSES: OnlineOrderStatus[] = ['completed', 'rejected', 'cancelled', 'expired'];

/**
 * Allowed forward moves. `rejected`/`cancelled` are permitted from any active
 * status because a customer can cancel an order at any point before dispatch.
 */
const TRANSITIONS: Record<OnlineOrderStatus, OnlineOrderStatus[]> = {
  pending_review: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'rejected', 'cancelled'],
  preparing: ['packed', 'rejected', 'cancelled'],
  packed: ['dispatched', 'cancelled'],
  dispatched: ['completed'],
  completed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

/** Statuses that mean stock is still held for the order. */
export const RESERVATION_HOLDING: OnlineOrderStatus[] = ['pending_review', 'accepted', 'preparing', 'packed'];

export function canTransition(from: OnlineOrderStatus, to: OnlineOrderStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTransitions(from: OnlineOrderStatus): OnlineOrderStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** Statuses that require a staff-supplied reason. */
export function requiresReason(to: OnlineOrderStatus): boolean {
  return to === 'rejected' || to === 'cancelled';
}

/**
 * A shipped order has physically consumed its stock, so it can no longer be
 * cancelled or rejected without a return flow (which is out of scope).
 */
export function isFulfilmentLocked(status: OnlineOrderStatus): boolean {
  return status === 'dispatched' || status === 'completed';
}

export interface TransitionCheck {
  ok: boolean;
  error?: string;
  /** True when the target status also releases the reservation. */
  releasesReservation: boolean;
  /** True when the target status means the order has been dispatched/completed. */
  marksShipped: boolean;
}

/**
 * Validates a requested transition, including payment/fulfilment consistency.
 *
 * An order must be PAID before it ships: shipping unpaid stock is exactly how a
 * shop gives away inventory. Shipping is still allowed on an unverified order
 * only if the operator has explicitly recorded a verified payment first, so the
 * rule is enforced here rather than assumed.
 */
export function evaluateTransition(
  current: OnlineOrderStatus,
  paymentStatus: PaymentStatus,
  target: OnlineOrderStatus,
  hasReservation: boolean,
  reservationAlreadyReleased: boolean,
): TransitionCheck {
  const marksShipped = target === 'dispatched' || target === 'completed';

  // Fulfilment ALSO releases the order's own hold, because it has just consumed
  // that stock as a real sale. Leaving the hold behind would double-count the
  // same units: once deducted from stock_quantity and once still reserved, so
  // available would be understated forever and the order could never ship
  // again. Cancelling/rejecting/expiring release without consuming.
  const releasesReservation =
    (marksShipped || target === 'cancelled' || target === 'rejected' || target === 'expired')
    && hasReservation && !reservationAlreadyReleased;

  if (current === target) {
    return { ok: false, error: `Order is already ${current.replace(/_/g, ' ')}.`, releasesReservation: false, marksShipped: false };
  }
  if (FINAL_STATUSES.includes(current)) {
    return { ok: false, error: `This order is closed (${current.replace(/_/g, ' ')}) and cannot change.`, releasesReservation: false, marksShipped: false };
  }
  // `expired` belongs to the sweep alone; staff must not fake a lapse.
  if (target === 'expired') {
    return { ok: false, error: 'Expiry is applied automatically and cannot be set manually.', releasesReservation: false, marksShipped: false };
  }
  if (!canTransition(current, target)) {
    return {
      ok: false,
      error: `Cannot move from ${current.replace(/_/g, ' ')} to ${target.replace(/_/g, ' ')}.`,
      releasesReservation: false,
      marksShipped: false,
    };
  }
  // Payment gate: never ship or complete an order that staff have not confirmed
  // was paid, and never ship one that was explicitly rejected as unpaid.
  if (marksShipped && paymentStatus !== 'verified') {
    return {
      ok: false,
      error: 'Verify payment before dispatching or completing this order.',
      releasesReservation: false,
      marksShipped: false,
    };
  }
  if (target === 'rejected' && paymentStatus === 'verified') {
    return {
      ok: false,
      error: 'This order is already marked paid. Resolve the payment before rejecting it.',
      releasesReservation: false,
      marksShipped: false,
    };
  }

  return { ok: true, releasesReservation, marksShipped };
}

/** Appends to the immutable event history. */
export function recordOrderEvent(
  db: BetterSqlite3.Database,
  input: { orderId: string; actorUserId: string | null; from: string | null; to: string; reason?: string | null },
): void {
  db.prepare(`
    INSERT INTO shop_order_events (id, order_id, actor_user_id, from_status, to_status, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    generateShortId('shop_order_events'), input.orderId, input.actorUserId,
    input.from, input.to, input.reason ?? null,
  );
}