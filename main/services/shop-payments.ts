/**
 * Static UPI payment details for assisted checkout.
 *
 * WHY A GENERATED QR RATHER THAN AN IMAGE
 * The UPI ID is the authoritative value; a static QR image is just a rendering
 * of it and would silently drift from the ID if either changed. So the QR is
 * generated per order from the configured ID and the SERVER-DERIVED amount,
 * which means it can never show a wrong or stale total.
 *
 * This is still a real, scannable UPI intent QR (the standard `upi://pay`
 * scheme) — not a decorative placeholder. If no UPI ID is configured, no QR is
 * produced at all and the storefront says so, rather than inventing details.
 *
 * A declaration is a CUSTOMER CLAIM, never verification: recording one leaves
 * `payment_status` at 'unverified'.
 */

import { randomBytes } from 'crypto';
import QRCode from 'qrcode';
import type BetterSqlite3 from 'better-sqlite3';
import { minorUnitsToRupees } from './shop-money';

export interface UpiConfig {
  upiId: string;
  payeeName: string;
}

export interface UpiPaymentDetails {
  /** False when no UPI ID is configured; the UI then shows no QR. */
  configured: boolean;
  upi_id: string;
  payee_name: string;
  /** PNG data URI of a scannable UPI intent QR for THIS order's amount. */
  qr_data_url: string | null;
  /** Amount the QR is bound to, in minor units, straight from the order. */
  amount_minor_units: number;
  currency: string;
  /** Ready-made `upi://` deep link, also amount-bound. */
  upi_intent_url: string | null;
}

/** UPI handles: alphanumeric with @, dot, dash, underscore. */
const UPI_ID_PATTERN = /^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9._-]{2,64}$/;

/** Reads the staff-configured UPI details. No defaults, no invented values. */
export function getUpiConfig(db: BetterSqlite3.Database): UpiConfig {
  const read = (key: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return (row?.value || '').trim();
  };
  const upiId = read('shop_upi_id');
  const payeeName = read('shop_upi_payee_name');
  return {
    // An invalid handle is treated as unconfigured rather than surfaced broken.
    upiId: UPI_ID_PATTERN.test(upiId) ? upiId : '',
    payeeName: payeeName || 'CLOUT',
  };
}

/**
 * Builds the standard UPI intent URI.
 *
 * `URLSearchParams` encodes each field, so an ampersand inside a payee note
 * cannot break the query string or inject extra UPI parameters.
 */
export function buildUpiIntentUrl(config: UpiConfig, amountMinorUnits: number, currency: string, note: string): string | null {
  if (!config.upiId) return null;
  const params = new URLSearchParams({
    pa: config.upiId,
    pn: config.payeeName,
    am: minorUnitsToRupees(amountMinorUnits, currency).toFixed(2),
    cu: currency.toUpperCase(),
    tn: note,
  });
  return `upi://pay?${params.toString()}`;
}
/**
 * Produces the QR payload for one order.
 *
 * Returns `configured: false` (no QR, no intent link) when no valid UPI ID
 * exists, so the storefront can say "payment details unavailable" instead of
 * showing a picture that would take money for an unconfigured account.
 */
export async function buildUpiPaymentDetails(
  db: BetterSqlite3.Database,
  amountMinorUnits: number,
  currency: string,
  reference: string,
): Promise<UpiPaymentDetails> {
  const config = getUpiConfig(db);
  const intent = buildUpiIntentUrl(config, amountMinorUnits, currency, `CLOUT order ${reference}`);

  if (!config.upiId || !intent) {
    return {
      configured: false,
      upi_id: '',
      payee_name: config.payeeName,
      qr_data_url: null,
      amount_minor_units: amountMinorUnits,
      currency,
      upi_intent_url: null,
    };
  }

  let qrDataUrl: string | null = null;
  try {
    qrDataUrl = await QRCode.toDataURL(intent, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
  } catch {
    // A QR failure must not break checkout: the UPI ID and amount remain usable
    // by hand, so fall back to those rather than failing the order.
    qrDataUrl = null;
  }

  return {
    configured: true,
    upi_id: config.upiId,
    payee_name: config.payeeName,
    qr_data_url: qrDataUrl,
    amount_minor_units: amountMinorUnits,
    currency,
    upi_intent_url: intent,
  };
}

const MAX_DECLARATION_REFERENCE_LENGTH = 80;

/**
 * Records a customer's claim that they have paid.
 *
 * Deliberately does NOT touch `shop_orders.payment_status`, which stays
 * 'unverified' until staff confirm. Scoped to one order id, which the caller has
 * already authorised through the guest cart.
 */
export function recordPaymentDeclaration(
  db: BetterSqlite3.Database,
  orderId: string,
  reference: string | null,
): { declared: true; declared_at: string } {
  const existing = db.prepare(
    'SELECT declared_at FROM shop_payment_declarations WHERE order_id = ? ORDER BY declared_at LIMIT 1',
  ).get(orderId) as { declared_at: string } | undefined;

  // Declarations are idempotent: a customer who taps twice does not create two.
  if (existing) return { declared: true, declared_at: existing.declared_at };

  const declaredAt = new Date().toISOString();
  const trimmed = typeof reference === 'string'
    ? reference.replace(/\s+/g, ' ').trim().slice(0, MAX_DECLARATION_REFERENCE_LENGTH) || null
    : null;

  db.prepare(`
    INSERT INTO shop_payment_declarations (id, order_id, reference, declared_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomBytes(12).toString('hex'), orderId, trimmed, declaredAt, declaredAt);

  return { declared: true, declared_at: declaredAt };
}

/** Customer-safe declaration state for the confirmation screen. */
export function getPaymentDeclaration(
  db: BetterSqlite3.Database,
  orderId: string,
): { declared: boolean; declared_at: string | null } {
  const row = db.prepare(
    'SELECT declared_at FROM shop_payment_declarations WHERE order_id = ? ORDER BY declared_at LIMIT 1',
  ).get(orderId) as { declared_at: string } | undefined;
  return { declared: Boolean(row), declared_at: row?.declared_at ?? null };
}
