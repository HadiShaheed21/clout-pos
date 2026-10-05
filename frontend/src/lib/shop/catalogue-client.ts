'use client';

/**
 * Client for the PUBLIC shop catalogue API.
 *
 * WHY FETCHING IS CLIENT-SIDE
 * The desktop build is a fully static export (`output: 'export'`) with no
 * runtime server, and product/collection ids live in the POS database, so real
 * ids cannot be enumerated at build time without database access. Client
 * fetching is therefore the only approach that works in BOTH build modes
 * (static export and Next server mode) without changing Railway/Vercel config.
 *
 * API ORIGIN
 * - Browser mode: `/api/*` is proxied to the POS API by `next.config.ts`
 *   rewrites, so a relative URL is correct.
 * - Desktop export: served by the same Express origin that hosts `/api`.
 * - `NEXT_PUBLIC_API_URL` overrides the origin when the storefront is hosted on
 *   a different domain. It is a public build-time variable; no secret is used.
 *
 * CACHING
 * A short module-level cache prevents repeat requests when a shopper moves
 * between surfaces, and every call accepts an AbortSignal so unmounting a
 * component cannot resolve into a stale render.
 */

import {
  SHOP_PAGE_SIZE,
  type ShopApiCollection,
  type ShopApiPage,
  type ShopApiProduct,
} from './api-types';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? '';

/** Absolute-or-relative URL for a public catalogue path. */
export function shopApiUrl(path: string): string {
  return `${API_ORIGIN}/api/shop${path}`;
}

/** Resolves a server-supplied relative image URL against the API origin. */
export function shopImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_ORIGIN}${url}`;
}

export class ShopApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ShopApiError';
    this.status = status;
  }
}

type CacheEntry<T> = { value: T; expiresAt: number };
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry<unknown>>();

function readCache<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function writeCache<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * True when a rejection is an intentional cancellation rather than a failure.
 *
 * Deliberately avoids `instanceof Error`: a DOMException is the carrier for
 * AbortError and does not reliably inherit from Error across runtimes. The name
 * is the portable check. `signal` is honoured too, so a signal that was aborted
 * wins even when the rejection itself was rewrapped somewhere along the way.
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { name } = error as { name?: unknown };
  return name === 'AbortError' || name === 'CanceledError';
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const key = path;
  const cached = readCache<T>(key);
  if (cached) return cached;

  let response: Response;
  try {
    response = await fetch(shopApiUrl(path), { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    // Cancellation must stay an abort so callers can recognise it and ignore it;
    // only genuine transport failures become a catalogue error.
    if (isAbortError(error, signal)) throw error;
    // Network/DNS. Never silently substituted with placeholder stock.
    throw new ShopApiError('Unable to reach the store catalogue.', 0);
  }

  if (!response.ok) {
    throw new ShopApiError(
      response.status === 404 ? 'Not found.' : 'Unable to load the store catalogue.',
      response.status,
    );
  }

  const value = (await response.json()) as T;
  writeCache(key, value);
  return value;
}

/** Fetches one page of published, sellable products. */
export async function fetchProducts(
  options: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<ShopApiPage> {
  const limit = options.limit ?? SHOP_PAGE_SIZE;
  const offset = options.offset ?? 0;
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return getJson<ShopApiPage>(`/products?${params.toString()}`, options.signal);
}

/**
 * Walks every page so a category or collection view can filter client-side
 * without hiding products that fall beyond the first page.
 */
export async function fetchAllProducts(signal?: AbortSignal): Promise<ShopApiProduct[]> {
  const collected: ShopApiProduct[] = [];
  let offset = 0;
  // Guard against a misbehaving server looping forever.
  for (let page = 0; page < 100; page += 1) {
    const result = await fetchProducts({ limit: SHOP_PAGE_SIZE, offset, signal });
    collected.push(...result.products);
    if (!result.pagination.has_more || result.products.length === 0) break;
    offset += result.products.length;
  }
  return collected;
}

export function fetchProduct(id: string, signal?: AbortSignal): Promise<{ product: ShopApiProduct }> {
  return getJson<{ product: ShopApiProduct }>(`/products/${encodeURIComponent(id)}`, signal);
}

export function fetchCollections(signal?: AbortSignal): Promise<{ collections: ShopApiCollection[] }> {
  return getJson<{ collections: ShopApiCollection[] }>('/collections', signal);
}

/** Test/dev helper: drops cached responses so a retry refetches. */
export function clearShopCache(): void {
  cache.clear();
}
