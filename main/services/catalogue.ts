import type Database from 'better-sqlite3';
import { generateShortId, now } from '../db';

export const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export const MAX_PRODUCT_IMAGES = 8;

/**
 * Raster formats the gallery may serve, each identified by its real file
 * signature rather than by the declared data-URI prefix. SVG and every other
 * format are deliberately absent so they can never be served as active content.
 */
const GALLERY_IMAGE_SIGNATURES: { mimeType: string; extension: string; matches: (bytes: Buffer) => boolean }[] = [
  {
    mimeType: 'image/png',
    extension: 'png',
    matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    matches: (bytes) => bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/** Identifies stored gallery bytes by signature; unknown payloads return null. */
export function detectGalleryImageType(bytes: Buffer): { mimeType: string; extension: string } | null {
  const detected = GALLERY_IMAGE_SIGNATURES.find((signature) => signature.matches(bytes));
  return detected ? { mimeType: detected.mimeType, extension: detected.extension } : null;
}

/**
 * Decodes a stored gallery data URI and verifies the real bytes before serving.
 * Returns null unless the payload is an approved raster image whose bytes agree
 * with its declared type, so an SVG/HTML payload can never be served as an image.
 */
export function readGalleryImageBytes(
  dataUri: unknown,
): { buffer: Buffer; mimeType: string; extension: string } | null {
  if (typeof dataUri !== 'string') return null;
  const match = dataUri.match(/^data:(image\/(?:webp|png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) return null;
  const detected = detectGalleryImageType(buffer);
  if (!detected) return null;
  const declared = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  if (declared !== detected.mimeType) return null;
  return { buffer, mimeType: detected.mimeType, extension: detected.extension };
}

export function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

export function wholeUnit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function writeCatalogueAudit(
  db: Database.Database,
  actorUserId: string | null | undefined,
  entityType: string,
  entityId: string,
  action: string,
  metadata: Record<string, unknown> = {},
): void {
  // Metadata is deliberately supplied by narrow callers; never pass image data or credentials here.
  db.prepare(`INSERT INTO catalog_audit_log (id, entity_type, entity_id, action, actor_user_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(generateShortId('catalog_audit_log'), entityType, entityId, action, actorUserId || null, JSON.stringify(metadata), now());
}

export function reserveIdentifier(
  db: Database.Database,
  args: {
    type: 'sku' | 'barcode'; value: unknown; ownerKind: 'product' | 'variant';
    productId?: string | null; variantId?: string | null; actorUserId?: string | null;
  },
): string | null {
  const normalized = normalizeIdentifier(args.value);
  if (!normalized) return null;
  const existing = db.prepare(`SELECT id, owner_kind, product_id, variant_id
    FROM catalog_identifier_assignments
    WHERE identifier_type = ? AND normalized_value = ? AND released_at IS NULL`).get(args.type, normalized) as
    | { id: string; owner_kind: string; product_id: string | null; variant_id: string | null }
    | undefined;
  const alreadyOwned = existing
    && existing.owner_kind === args.ownerKind
    && existing.product_id === (args.productId || null)
    && existing.variant_id === (args.variantId || null);
  if (existing && !alreadyOwned) {
    throw Object.assign(new Error(`${args.type === 'barcode' ? 'Barcode' : 'SKU'} is already assigned`), { statusCode: 409 });
  }
  if (!existing) {
    db.prepare(`INSERT INTO catalog_identifier_assignments
      (id, identifier_type, normalized_value, owner_kind, product_id, variant_id, assigned_at, assigned_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(generateShortId('catalog_identifier_assignments'), args.type, normalized, args.ownerKind, args.productId || null, args.variantId || null, now(), args.actorUserId || null);
  }
  return normalized;
}

export function releaseIdentifier(
  db: Database.Database,
  type: 'sku' | 'barcode',
  value: unknown,
  actorUserId: string,
  reason: unknown,
): void {
  const normalized = normalizeIdentifier(value);
  const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
  if (!normalized || !safeReason) throw Object.assign(new Error('Identifier and release reason are required'), { statusCode: 400 });
  const assignment = db.prepare(`SELECT id FROM catalog_identifier_assignments
    WHERE identifier_type = ? AND normalized_value = ? AND released_at IS NULL`).get(type, normalized) as { id: string } | undefined;
  if (!assignment) throw Object.assign(new Error('Active identifier assignment not found'), { statusCode: 404 });
  db.prepare(`UPDATE catalog_identifier_assignments
    SET released_at = ?, released_by = ?, release_reason = ? WHERE id = ?`)
    .run(now(), actorUserId, safeReason, assignment.id);
  writeCatalogueAudit(db, actorUserId, 'identifier', assignment.id, 'released', { identifier_type: type, value: normalized, reason: safeReason });
}

export function productVariants(db: Database.Database, productId: string): any[] {
  const variants = db.prepare(`SELECT * FROM product_variants WHERE product_id = ? AND deleted_at IS NULL ORDER BY display_name`).all(productId) as any[];
  if (!variants.length) return [];
  const values = db.prepare(`SELECT pvv.variant_id, pog.name AS option_name, pov.label AS option_value, pov.color_hex
    FROM product_variant_option_values pvv
    JOIN product_option_groups pog ON pog.id = pvv.option_group_id
    JOIN product_option_values pov ON pov.id = pvv.option_value_id
    WHERE pvv.variant_id IN (${variants.map(() => '?').join(',')})
    ORDER BY pog.sort_order, pov.sort_order`).all(...variants.map((variant) => variant.id)) as any[];
  const byVariant = new Map<string, any[]>();
  for (const value of values) byVariant.set(value.variant_id, [...(byVariant.get(value.variant_id) || []), value]);
  return variants.map((variant) => ({ ...variant, options: byVariant.get(variant.id) || [] }));
}

export function selectedVariant(db: Database.Database, product: any, variantId: unknown): any | null {
  if (!product.variant_mode) return null;
  if (typeof variantId !== 'string' || !variantId) {
    throw Object.assign(new Error(`A variant selection is required for ${product.name}`), { statusCode: 400 });
  }
  const variant = db.prepare(`SELECT * FROM product_variants
    WHERE id = ? AND product_id = ? AND deleted_at IS NULL AND is_active = 1`).get(variantId, product.id) as any;
  if (!variant) throw Object.assign(new Error(`Selected variant is unavailable for ${product.name}`), { statusCode: 400 });
  const options = db.prepare(`SELECT pog.name AS option_name, pov.label AS option_value, pov.color_hex
    FROM product_variant_option_values pvv
    JOIN product_option_groups pog ON pog.id = pvv.option_group_id
    JOIN product_option_values pov ON pov.id = pvv.option_value_id
    WHERE pvv.variant_id = ? ORDER BY pog.sort_order, pov.sort_order`).all(variant.id);
  return { ...variant, options };
}

export function catalogueReadiness(db: Database.Database, product: any): string[] {
  const warnings: string[] = [];
  if (!product.is_active) warnings.push('inactive_product');
  if (!Number.isFinite(Number(product.price)) || Number(product.price) < 0) warnings.push('invalid_price');
  const primary = db.prepare('SELECT 1 FROM product_images WHERE product_id = ? AND is_primary = 1').get(product.id);
  if (!primary && !product.image_url) warnings.push('missing_primary_image');
  if (product.variant_mode) {
    const valid = db.prepare(`SELECT 1 FROM product_variants WHERE product_id = ? AND deleted_at IS NULL AND is_active = 1 AND (track_inventory = 0 OR stock_quantity > 0) LIMIT 1`).get(product.id);
    if (!valid) warnings.push('no_active_sellable_variant');
  }
  return warnings;
}
