/**
 * Public, read-only ecommerce catalogue API (Phase 1).
 *
 * ANONYMOUS ACCESS IS THE POINT of this router, so its blast radius must stay
 * tiny. Controls, in order of importance:
 *   1. Every handler here is GET-only. There is no POST/PUT/PATCH/DELETE, so an
 *      anonymous caller has no write surface here even if a proxy misroutes.
 *   2. Only allowlisted fields leave this router; see `shop-catalogue.ts`.
 *   3. Unpublished/inactive/deleted products are excluded in SQL, and a product
 *      with an unrepresentable price is withheld rather than quoted.
 *   4. Images resolve through the owning product, so an unpublished product's
 *      images are unreachable.
 *   5. 404 is uniform and never distinguishes "absent" from "not published", so
 *      the API cannot be used to probe for hidden products.
 *
 * This router does NOT weaken authentication anywhere else. `requireAuth` in
 * main/server.ts is amended with a narrow, GET-only `/api/shop` bypass; every
 * other API route keeps requiring a bearer token.
 */

import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import { readGalleryImageBytes } from '../../services/catalogue';
import { getDatabase } from '../../db';
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  listPublicCollections, listPublicProducts, getPublicProductById, isPubliclyVisibleProduct,
} from '../../services/shop-catalogue';

const router = Router();

/**
 * Anonymous read budget. Deliberately tighter than the global /api limit and
 * NOT bypassed for private IPs, so LAN scanning and scrapers are bounded too.
 */
const publicReadRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  limit: Number.isSafeInteger(Number(process.env.FLO_SHOP_RATE_LIMIT_MAX))
    ? Number(process.env.FLO_SHOP_RATE_LIMIT_MAX)
    : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' },
});

/** Uniform 404 so hidden and missing products are indistinguishable. */
function notFound(res: Response): Response {
  return res.status(404).json({ error: 'Not found' });
}

/** Strict integer pagination parsing; rejects junk instead of coercing it. */
function parsePagination(req: Request): { limit: number; offset: number } | { error: string } {
  const rawLimit = req.query.limit;
  const rawOffset = req.query.offset;

  let limit = DEFAULT_PAGE_SIZE;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d{1,3}$/.test(rawLimit)) return { error: 'limit must be a positive integer' };
    limit = Number(rawLimit);
    if (limit < 1) return { error: 'limit must be a positive integer' };
    if (limit > MAX_PAGE_SIZE) return { error: `limit must be ${MAX_PAGE_SIZE} or less` };
  }

  let offset = 0;
  if (rawOffset !== undefined) {
    if (typeof rawOffset !== 'string' || !/^\d{1,9}$/.test(rawOffset)) return { error: 'offset must be a non-negative integer' };
    offset = Number(rawOffset);
  }

  return { limit, offset };
}

router.get('/products', publicReadRateLimit, (req: Request, res: Response) => {
  const pagination = parsePagination(req);
  if ('error' in pagination) return res.status(400).json({ error: pagination.error });
  try {
    return res.json(listPublicProducts(getDatabase(), pagination));
  } catch (error) {
    console.error('[Shop] product list failed:', error);
    return res.status(500).json({ error: 'Unable to load products' });
  }
});

router.get('/products/:slug', publicReadRateLimit, (req: Request, res: Response) => {
  try {
    // `id` is the stable public identifier; see report note on the missing
    // `slug` column before introducing a migration.
    const product = getPublicProductById(getDatabase(), String(req.params.slug));
    if (!product) return notFound(res);
    return res.json({ product });
  } catch (error) {
    console.error('[Shop] product detail failed:', error);
    return res.status(500).json({ error: 'Unable to load product' });
  }
});

router.get('/collections', publicReadRateLimit, (_req: Request, res: Response) => {
  try {
    return res.json({ collections: listPublicCollections(getDatabase()) });
  } catch (error) {
    console.error('[Shop] collection list failed:', error);
    return res.status(500).json({ error: 'Unable to load collections' });
  }
});

/**
 * Public image delivery.
 *
 * Access is resolved through the OWNING product, not the image id alone, so an
 * image belonging to a draft, unpublished, inactive or deleted product returns
 * the same uniform 404 as an unknown id. Bytes are verified with the existing
 * signature reader, and the content type is taken from the detected signature
 * with `nosniff`, so stored data can never be interpreted as active content.
 */
router.get('/images/:id', publicReadRateLimit, (req: Request, res: Response) => {
  const db = getDatabase();
  const image = db.prepare(`
    SELECT pi.id, pi.product_id, pi.uses_legacy_image, pi.data_uri
    FROM product_images pi
    WHERE pi.id = ?
    LIMIT 1
  `).get(req.params.id) as any;

  // Uniform 404: never reveal whether an image exists under a hidden product.
  if (!image) return notFound(res);
  if (!isPubliclyVisibleProduct(db, image.product_id)) return notFound(res);
  if (image.uses_legacy_image) return notFound(res);

  const verified = readGalleryImageBytes(image.data_uri);
  if (!verified) return notFound(res);

  const etag = createHash('sha256').update(verified.buffer).digest('hex');
  if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();

  res.set({
    'Content-Type': verified.mimeType,
    'Content-Length': verified.buffer.length,
    // Server-generated id only; no request data reaches a response header.
    'Content-Disposition': `inline; filename="${image.id}.${verified.extension}"`,
    'X-Content-Type-Options': 'nosniff',
    'ETag': `"${etag}"`,
    // Public, immutable catalogue artwork: safe to cache at the edge.
    'Cache-Control': 'public, max-age=3600',
  });
  return res.send(verified.buffer);
});

/**
 * Predicate consumed by `requireAuth` in main/server.ts. Kept here so the
 * bypass rule lives beside the routes it describes, and so tests can assert the
 * exact same boundary the server uses.
 *
 * Scoped to GET on `/api/shop` only: no other path, method, or prefix passes.
 */
export function isPublicShopPath(path: string, method: string): boolean {
  if (typeof method !== 'string' || method.toUpperCase() !== 'GET') return false;
  if (typeof path !== 'string') return false;
  if (!path.startsWith('/api/shop/')) return false;
  // Defence in depth: never bypass for paths that look administrative.
  return !/\/(write|admin|internal|debug)/i.test(path);
}

export { router as shopRoutes };

