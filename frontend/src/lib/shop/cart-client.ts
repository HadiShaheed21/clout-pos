'use client';

/**
 * Client for the server-authoritative guest cart (Phase 3).
 *
 * The server owns everything that matters: prices, availability, totals and
 * even whether a line is still buyable. This module only sends intent
 * (product id, variant id, quantity) and renders whatever comes back. It
 * never computes a total it then shows as authoritative.
 *
 * IDENTITY / CSRF
 * The backend issues an HttpOnly cart cookie plus a readable CSRF cookie. The
 * browser sends the cookie automatically (same-origin via the existing
 * `/api/*` proxy), so this module reads the CSRF cookie and echoes it in a
 * header. Requests are `credentials: 'same-origin'` because the proxy makes the
 * call same-origin; no token or secret lives in JS.
 *
 * NOT A RESERVATION
 * Adding to this cart does not hold stock. Availability shown here is a
 * snapshot and is re-checked server-side at order creation in Phase 4.
 */

import type { ShopAvailability } from './api-types';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';
export { API_ORIGIN };
const CART_BASE = `${API_ORIGIN}/api/shop/cart`;
const CSRF_COOKIE = 'clout_cart_csrf';
const CSRF_HEADER = 'x-clout-csrf';

export interface CartOption {
  name: string;
  value: string;
  color_hex: string | null;
}

export interface CartLine {
  item_id: string;
  product_id: string;
  product_name: string;
  variant_id: string | null;
  variant_display_name: string | null;
  options: CartOption[];
  unit_price_minor_units: number;
  quantity: number;
  line_total_minor_units: number;
  availability: ShopAvailability;
  currency: string;
  image_url: string | null;
  status: 'ok' | 'unavailable' | 'unpublished';
  message: string | null;
}

export interface CartState {
  currency: string;
  items: CartLine[];
  item_count: number;
  subtotal_minor_units: number;
  has_unavailable_items: boolean;
  expires_at: string;
}

export const EMPTY_CART: CartState = {
  currency: 'INR',
  items: [],
  item_count: 0,
  subtotal_minor_units: 0,
  has_unavailable_items: false,
  expires_at: '',
};

export class CartApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CartApiError';
    this.status = status;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(`${CART_BASE}${path}`, {
      method,
      headers,
      // Same-origin: the existing /api proxy makes this a first-party request.
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CartApiError('Unable to reach your bag. Please try again.', 0);
  }

  const text = await response.text();
  let payload: { error?: unknown } | null = null;
  try { payload = text ? JSON.parse(text) as { error?: unknown } : null; } catch { payload = null; }

  if (!response.ok) {
    const detail = payload?.error;
    throw new CartApiError(
      typeof detail === 'string' ? detail : 'Unable to update your bag.',
      response.status,
    );
  }
  return payload as T;
}

export function fetchCart(): Promise<CartState> {
  return request<CartState>('GET', '');
}

export function addToCart(input: { productId: string; variantId: string | null; quantity: number }): Promise<CartState> {
  return request<CartState>('POST', '/items', {
    product_id: input.productId,
    variant_id: input.variantId,
    quantity: input.quantity,
  });
}

export function setCartItemQuantity(itemId: string, quantity: number): Promise<CartState> {
  return request<CartState>('PATCH', `/items/${encodeURIComponent(itemId)}`, { quantity });
}

export function removeCartItem(itemId: string): Promise<CartState> {
  return request<CartState>('DELETE', `/items/${encodeURIComponent(itemId)}`);
}

export function clearCart(): Promise<CartState> {
  return request<CartState>('DELETE', '');
}

/** Absolute-or-relative URL for a server-supplied cart image path. */
export function cartImageUrl(url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_ORIGIN}${url}`;
}