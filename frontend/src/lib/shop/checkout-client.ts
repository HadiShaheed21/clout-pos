'use client';

import { CartApiError, API_ORIGIN } from './cart-client';

/**
 * Client for the checkout API (Phase 4).
 *
 * The browser sends ONLY intent plus delivery details. Prices, totals, stock and
 * status are always whatever the server says; nothing here computes an amount.
 *
 * IDEMPOTENCY
 * A key is generated once per logical checkout attempt (a form submission that
 * the customer did not change) and REUSED across retries, so a lost response or
 * an impatient second click cannot create two orders. Changing the details or
 * the bag deliberately starts a new attempt with a fresh key.
 */

export interface CheckoutCustomer {
  name: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  instructions?: string;
}

export interface CheckoutOrderItem {
  product_name: string;
  variant_display_name: string | null;
  options: { name: string; value: string }[];
  quantity: number;
  unit_price_minor_units: number;
  line_total_minor_units: number;
}

export interface CheckoutConfirmation {
  reference: string;
  status: string;
  payment_status: string;
  currency: string;
  subtotal_minor_units: number;
  item_count: number;
  created_at: string;
  items: CheckoutOrderItem[];
  contact: {
    name: string; phone: string; address: string; city: string;
    state: string; pincode: string; instructions: string | null;
  };
  /** Customer's own claim. Never treated as verified. */
  payment_declared: boolean;
  payment_declared_at: string | null;
  whatsapp_url: string | null;
}

/** UPI details derived server-side from the order's own subtotal. */
export interface UpiPayment {
  /** False when no UPI ID is configured; the UI then shows no QR at all. */
  configured: boolean;
  upi_id: string;
  payee_name: string;
  /** Real scannable PNG data URI bound to this order's amount. */
  qr_data_url: string | null;
  amount_minor_units: number;
  currency: string;
  upi_intent_url: string | null;
}

export interface CheckoutResponse {
  order: CheckoutConfirmation;
  upi: UpiPayment | null;
  replayed: boolean;
  payment_required: boolean;
}

export interface DeclarationResponse {
  order: CheckoutConfirmation;
  payment_status: string;
  payment_declared: boolean;
}

/** A retryable failure: the customer may safely resubmit the same attempt. */
export class CheckoutRetryableError extends CartApiError {}

function newIdempotencyKey(): string {
  // crypto.randomUUID is available in all browsers that support this build;
  // the server also accepts any well-formed key and mints one otherwise.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return '';
}

export async function postCheckout<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
  const csrf = typeof document !== 'undefined'
    ? document.cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith('clout_cart_csrf='))
    : null;

  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (csrf) headers['x-clout-csrf'] = decodeURIComponent(csrf.slice('clout_cart_csrf='.length));
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}/api/shop/checkout${path}`, {
      method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body),
    });
  } catch {
    throw new CheckoutRetryableError('We could not reach the store. Check your connection and try again.', 0);
  }

  const text = await response.text();
  let payload: { error?: unknown } | null = null;
  try { payload = text ? JSON.parse(text) as { error?: unknown } : null; } catch { payload = null; }

  if (!response.ok) {
    const detail = payload?.error;
    const message = typeof detail === 'string' ? detail : 'We could not complete your order.';
    if (response.status >= 500) throw new CheckoutRetryableError(message, response.status);
    throw new CartApiError(message, response.status);
  }
  return payload as T;
}

export async function submitCheckout(
  customer: CheckoutCustomer,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  return postCheckout<CheckoutResponse>('', { customer }, idempotencyKey);
}

/**
 * Records the customer's declaration that they paid.
 *
 * This is a claim only — the server keeps `payment_status` at 'unverified' and
 * staff confirm independently. No payment gateway or verification happens here.
 */
export function declarePayment(reference?: string): Promise<DeclarationResponse> {
  return postCheckout<DeclarationResponse>('/declaration', {
    declared: true,
    reference: reference ?? null,
  });
}

export { newIdempotencyKey };