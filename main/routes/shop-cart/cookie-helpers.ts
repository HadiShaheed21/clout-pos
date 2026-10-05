/**
 * Shared cookie and CSRF helpers for the public storefront cart and checkout
 * routes.
 *
 * Extracted so Phase 4 checkout reuses the EXACT same cookie parsing and CSRF
 * double-submit logic the Phase 3 cart already uses, rather than a second
 * implementation that could drift and weaken the check.
 */

import type { Request } from 'express';
import { CART_CSRF_COOKIE, CART_CSRF_HEADER, verifyCsrfToken } from '../../services/shop-cart';

/** Parses a Cookie header into a name/value map, tolerating malformed escapes. */
export function parseCookiesForCart(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try { jar[key] = decodeURIComponent(value); } catch { /* malformed escape */ }
    }
  }
  return jar;
}

/** True when the request carries a valid CSRF double-submit token pair. */
export function csrfOkForCart(req: Request): boolean {
  const cookies = parseCookiesForCart(req);
  const header = req.headers[CART_CSRF_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return verifyCsrfToken(cookies[CART_CSRF_COOKIE], value);
}
