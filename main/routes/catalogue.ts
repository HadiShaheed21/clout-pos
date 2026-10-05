import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { generateShortId, getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { catalogueReadiness, MAX_PRODUCT_IMAGES, productVariants, readGalleryImageBytes, releaseIdentifier, reserveIdentifier, wholeUnit, writeCatalogueAudit } from '../services/catalogue';
import { recordStockMovement } from '../services/stock-movements';

const router = Router();
const VALID_STATUSES = new Set(['draft', 'published', 'unpublished']);

function actor(req: Request): string { return String((req as any).user.userId); }
function text(value: unknown, max = 160): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}
function identifierValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}
function validImage(data: unknown): data is string {
  return typeof data === 'string'
    && data.length <= 50_000
    && /^data:image\/(webp|png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(data);
}

router.get('/products/:productId', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.productId) as any;
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const groups = db.prepare(`SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY sort_order, name`).all(product.id) as any[];
  const values = groups.length ? db.prepare(`SELECT * FROM product_option_values WHERE option_group_id IN (${groups.map(() => '?').join(',')}) ORDER BY sort_order, label`).all(...groups.map((group) => group.id)) : [];
  return res.json({ product: { ...product, variants: productVariants(db, product.id), option_groups: groups.map((group) => ({ ...group, values: values.filter((value: any) => value.option_group_id === group.id) })), readiness: catalogueReadiness(db, product) } });
});

router.post('/products/:productId/convert-to-variants', requireRole(...ROLE_ACCESS.owner), (req, res) => {
  const db = getDatabase();
  const productId = req.params.productId;
  const body = req.body || {};
  const optionGroups = Array.isArray(body.option_groups) ? body.option_groups : [];
  const variants = Array.isArray(body.variants) ? body.variants : [];
  if (!optionGroups.length || !variants.length) return res.status(400).json({ error: 'Option groups and variants are required' });
  try {
    const converted = withTxn(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(productId) as any;
      if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
      if (product.variant_mode) throw Object.assign(new Error('Product already uses variants'), { statusCode: 409 });
      if (!Number.isSafeInteger(product.stock_quantity) || product.stock_quantity < 0) throw Object.assign(new Error('Clothing product stock must be a whole non-negative unit before conversion'), { statusCode: 400 });
      const allocations = variants.map((variant: any) => wholeUnit(variant.stock_quantity));
      if (allocations.some((quantity: number | null) => quantity === null)) throw Object.assign(new Error('Every variant stock quantity must be a whole non-negative unit'), { statusCode: 400 });
      if (allocations.reduce((sum: number, quantity: number | null) => sum + Number(quantity), 0) !== product.stock_quantity) throw Object.assign(new Error('Variant allocation must equal current product stock exactly'), { statusCode: 400 });

      const groupLookup = new Map<string, { id: string; values: Map<string, string> }>();
      for (let index = 0; index < optionGroups.length; index += 1) {
        const groupInput = optionGroups[index];
        const name = text(groupInput?.name, 80);
        const normalizedName = name?.toLowerCase();
        const inputValues = Array.isArray(groupInput?.values) ? groupInput.values : [];
        if (!name || !normalizedName || !inputValues.length || groupLookup.has(normalizedName)) throw Object.assign(new Error('Each option group needs a unique name and value'), { statusCode: 400 });
        const groupId = generateShortId('product_option_groups');
        db.prepare(`INSERT INTO product_option_groups (id, product_id, name, normalized_name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(groupId, product.id, name, normalizedName, index, now(), now());
        const valueLookup = new Map<string, string>();
        for (let valueIndex = 0; valueIndex < inputValues.length; valueIndex += 1) {
          const label = text(inputValues[valueIndex]?.label ?? inputValues[valueIndex], 80);
          const normalizedLabel = label?.toLowerCase();
          if (!label || !normalizedLabel || valueLookup.has(normalizedLabel)) throw Object.assign(new Error('Option values must be unique'), { statusCode: 400 });
          const valueId = generateShortId('product_option_values');
          const colorHex = text(inputValues[valueIndex]?.color_hex, 9);
          db.prepare(`INSERT INTO product_option_values (id, option_group_id, label, normalized_label, color_hex, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(valueId, groupId, label, normalizedLabel, colorHex, valueIndex, now(), now());
          valueLookup.set(normalizedLabel, valueId);
        }
        groupLookup.set(normalizedName, { id: groupId, values: valueLookup });
      }

      for (let index = 0; index < variants.length; index += 1) {
        const input = variants[index] || {};
        const selected = input.options && typeof input.options === 'object' ? input.options as Record<string, unknown> : {};
        const selection: { groupId: string; valueId: string; group: string; value: string }[] = [];
        for (const [normalizedName, group] of groupLookup) {
          const selectedValue = Object.entries(selected).find(([key]) => key.trim().toLowerCase() === normalizedName)?.[1];
          const normalizedValue = typeof selectedValue === 'string' ? selectedValue.trim().toLowerCase() : '';
          const valueId = group.values.get(normalizedValue);
          if (!valueId) throw Object.assign(new Error('Every variant must select one value from every option group'), { statusCode: 400 });
          selection.push({ groupId: group.id, valueId, group: normalizedName, value: normalizedValue });
        }
        const signature = selection.map((entry) => `${entry.groupId}:${entry.valueId}`).sort().join('|');
        const displayName = text(input.display_name, 160) || selection.map((entry) => entry.value).join(' / ');
        const stockQuantity = allocations[index]!;
        const threshold = wholeUnit(input.low_stock_threshold ?? 0);
        if (threshold === null) throw Object.assign(new Error('Variant low-stock threshold must be a whole non-negative unit'), { statusCode: 400 });
        const variantId = generateShortId('product_variants');
        const sku = identifierValue(input.sku);
        const barcode = identifierValue(input.barcode);
        db.prepare(`INSERT INTO product_variants (id, product_id, option_signature, display_name, sku, barcode, price_override, cost_override, track_inventory, stock_quantity, low_stock_threshold, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
          .run(variantId, product.id, signature, displayName, sku, barcode,
            typeof input.price_override === 'number' && input.price_override >= 0 ? input.price_override : null,
            typeof input.cost_override === 'number' && input.cost_override >= 0 ? input.cost_override : null,
            stockQuantity, threshold, input.is_active === false ? 0 : 1, now(), now());
        reserveIdentifier(db, { type: 'sku', value: sku, ownerKind: 'variant', variantId, actorUserId: actor(req) });
        reserveIdentifier(db, { type: 'barcode', value: barcode, ownerKind: 'variant', variantId, actorUserId: actor(req) });
        for (const entry of selection) db.prepare(`INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?, ?, ?)`).run(variantId, entry.groupId, entry.valueId);
        if (stockQuantity > 0) recordStockMovement(db, { productId: product.id, variantId, quantityDelta: stockQuantity, previousQuantity: 0, movementType: 'adjustment', referenceType: 'variant_conversion', referenceId: product.id, reason: 'Converted product stock to variant', actorUserId: actor(req), createdAt: now() });
      }
      if (product.stock_quantity > 0) recordStockMovement(db, { productId: product.id, quantityDelta: -product.stock_quantity, previousQuantity: product.stock_quantity, movementType: 'adjustment', referenceType: 'variant_conversion', referenceId: product.id, reason: 'Converted product stock to variants', actorUserId: actor(req), createdAt: now() });
      db.prepare('UPDATE products SET variant_mode = 1, stock_quantity = 0, updated_at = ? WHERE id = ?').run(now(), product.id);
      writeCatalogueAudit(db, actor(req), 'product', product.id, 'converted_to_variants', { variant_count: variants.length, allocated_stock: product.stock_quantity });
      return productVariants(db, product.id);
    });
    return res.status(201).json({ variants: converted });
  } catch (error: any) { console.error('[Catalogue] Variant conversion failed:', error?.message || error); return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Variant conversion failed' }); }
});

router.patch('/variants/:variantId', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  try {
    const variant = db.prepare('SELECT * FROM product_variants WHERE id = ? AND deleted_at IS NULL').get(req.params.variantId) as any;
    if (!variant) return res.status(404).json({ error: 'Variant not found' });
    const skuIsChanging = req.body.sku !== undefined && identifierValue(req.body.sku) !== variant.sku;
    const barcodeIsChanging = req.body.barcode !== undefined && identifierValue(req.body.barcode) !== variant.barcode;
    if ((skuIsChanging || barcodeIsChanging) && (req as any).user.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner may release or reassign SKU and barcode identifiers' });
    }
    for (const [type, previous, changing] of [['sku', variant.sku, skuIsChanging], ['barcode', variant.barcode, barcodeIsChanging]] as const) {
      if (!changing || !previous) continue;
      const active = db.prepare(`SELECT 1 FROM catalog_identifier_assignments WHERE identifier_type = ? AND normalized_value = ? AND released_at IS NULL`).get(type, previous);
      if (active) return res.status(409).json({ error: `Release the existing ${type} with an audit reason before assigning a new value` });
    }
    const threshold = req.body.low_stock_threshold === undefined ? variant.low_stock_threshold : wholeUnit(req.body.low_stock_threshold);
    if (threshold === null) return res.status(400).json({ error: 'Low-stock threshold must be a whole non-negative unit' });
    withTxn(() => {
      const sku = req.body.sku === undefined ? variant.sku : identifierValue(req.body.sku);
      const barcode = req.body.barcode === undefined ? variant.barcode : identifierValue(req.body.barcode);
      reserveIdentifier(db, { type: 'sku', value: sku, ownerKind: 'variant', variantId: variant.id, actorUserId: actor(req) });
      reserveIdentifier(db, { type: 'barcode', value: barcode, ownerKind: 'variant', variantId: variant.id, actorUserId: actor(req) });
      db.prepare(`UPDATE product_variants SET sku = ?, barcode = ?, price_override = ?, cost_override = ?, low_stock_threshold = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(
        sku, barcode,
        req.body.price_override === undefined ? variant.price_override : (typeof req.body.price_override === 'number' && req.body.price_override >= 0 ? req.body.price_override : null),
        req.body.cost_override === undefined ? variant.cost_override : (typeof req.body.cost_override === 'number' && req.body.cost_override >= 0 ? req.body.cost_override : null),
        threshold, req.body.is_active === undefined ? variant.is_active : (req.body.is_active ? 1 : 0), now(), variant.id);
      writeCatalogueAudit(db, actor(req), 'variant', variant.id, 'updated', { active: req.body.is_active, sku_changed: req.body.sku !== undefined, barcode_changed: req.body.barcode !== undefined });
    });
    return res.json({ variant: db.prepare('SELECT * FROM product_variants WHERE id = ?').get(variant.id) });
  } catch (error: any) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Variant update failed' }); }
});

router.post('/products/:productId/variants', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  try {
    const created = withTxn(() => {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.productId) as any;
      if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
      if (!product.variant_mode) throw Object.assign(new Error('Convert this product to variant-managed inventory first'), { statusCode: 409 });
      const groups = db.prepare('SELECT * FROM product_option_groups WHERE product_id = ? ORDER BY sort_order, name').all(product.id) as any[];
      const selected = req.body?.options && typeof req.body.options === 'object' ? req.body.options as Record<string, unknown> : {};
      if (!groups.length) throw Object.assign(new Error('Product has no option groups'), { statusCode: 409 });
      const selections: { groupId: string; valueId: string; value: string }[] = [];
      for (const group of groups) {
        const source = Object.entries(selected).find(([key]) => key.trim().toLowerCase() === group.normalized_name)?.[1];
        const label = typeof source === 'string' ? source.trim().toLowerCase() : '';
        const value = label ? db.prepare('SELECT * FROM product_option_values WHERE option_group_id = ? AND normalized_label = ? AND is_active = 1').get(group.id, label) as any : null;
        if (!value) throw Object.assign(new Error(`Select an active value for ${group.name}`), { statusCode: 400 });
        selections.push({ groupId: group.id, valueId: value.id, value: value.label });
      }
      const stockQuantity = wholeUnit(req.body?.stock_quantity);
      const threshold = wholeUnit(req.body?.low_stock_threshold ?? 0);
      if (stockQuantity === null || threshold === null) throw Object.assign(new Error('Variant stock and low-stock threshold must be whole non-negative units'), { statusCode: 400 });
      const id = generateShortId('product_variants');
      const sku = identifierValue(req.body?.sku);
      const barcode = identifierValue(req.body?.barcode);
      const signature = selections.map((selection) => `${selection.groupId}:${selection.valueId}`).sort().join('|');
      const displayName = text(req.body?.display_name, 160) || selections.map((selection) => selection.value).join(' / ');
      db.prepare(`INSERT INTO product_variants (id, product_id, option_signature, display_name, sku, barcode, price_override, cost_override, track_inventory, stock_quantity, low_stock_threshold, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(
        id, product.id, signature, displayName, sku, barcode,
        typeof req.body?.price_override === 'number' && req.body.price_override >= 0 ? req.body.price_override : null,
        typeof req.body?.cost_override === 'number' && req.body.cost_override >= 0 ? req.body.cost_override : null,
        stockQuantity, threshold, req.body?.is_active === false ? 0 : 1, now(), now());
      reserveIdentifier(db, { type: 'sku', value: sku, ownerKind: 'variant', variantId: id, actorUserId: actor(req) });
      reserveIdentifier(db, { type: 'barcode', value: barcode, ownerKind: 'variant', variantId: id, actorUserId: actor(req) });
      for (const selection of selections) db.prepare('INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?, ?, ?)').run(id, selection.groupId, selection.valueId);
      if (stockQuantity > 0) recordStockMovement(db, { productId: product.id, variantId: id, quantityDelta: stockQuantity, previousQuantity: 0, movementType: 'opening', referenceType: 'variant', referenceId: id, actorUserId: actor(req), createdAt: now() });
      writeCatalogueAudit(db, actor(req), 'variant', id, 'created', { product_id: product.id, stock_quantity: stockQuantity });
      return productVariants(db, product.id).find((variant) => variant.id === id);
    });
    return res.status(201).json({ variant: created });
  } catch (error: any) { return res.status(error.statusCode || (String(error?.message).includes('UNIQUE') ? 409 : 500)).json({ error: error.statusCode ? error.message : String(error?.message).includes('UNIQUE') ? 'Variant option combination already exists' : 'Variant creation failed' }); }
});

router.post('/variants/:variantId/stock-adjustments', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const quantityDelta = typeof req.body?.quantity_delta === 'number' && Number.isSafeInteger(req.body.quantity_delta) ? req.body.quantity_delta : null;
  const reason = text(req.body?.reason, 300);
  if (quantityDelta === null || quantityDelta === 0 || !reason) return res.status(400).json({ error: 'A non-zero whole-unit adjustment and reason are required' });
  const db = getDatabase();
  try {
    const variant = withTxn(() => {
      const current = db.prepare('SELECT * FROM product_variants WHERE id = ? AND deleted_at IS NULL').get(req.params.variantId) as any;
      if (!current) throw Object.assign(new Error('Variant not found'), { statusCode: 404 });
      if (current.stock_quantity + quantityDelta < 0) throw Object.assign(new Error('Stock cannot become negative'), { statusCode: 400 });
      db.prepare('UPDATE product_variants SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE id = ?').run(quantityDelta, now(), current.id);
      recordStockMovement(db, { productId: current.product_id, variantId: current.id, quantityDelta, previousQuantity: current.stock_quantity, movementType: 'adjustment', referenceType: 'variant_adjustment', referenceId: current.id, reason, actorUserId: actor(req), createdAt: now() });
      writeCatalogueAudit(db, actor(req), 'variant', current.id, 'stock_adjusted', { quantity_delta: quantityDelta, reason });
      return db.prepare('SELECT * FROM product_variants WHERE id = ?').get(current.id);
    });
    return res.json({ variant });
  } catch (error: any) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Stock adjustment failed' }); }
});

router.post('/identifiers/:type/release', requireRole(...ROLE_ACCESS.owner), (req, res) => {
  const parameterType = String(req.params.type);
  const type = parameterType === 'barcode' ? 'barcode' : parameterType === 'sku' ? 'sku' : null;
  if (!type) return res.status(400).json({ error: 'Identifier type must be sku or barcode' });
  try { withTxn(() => releaseIdentifier(getDatabase(), type, req.body?.value, actor(req), req.body?.reason)); return res.json({ success: true }); }
  catch (error: any) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Identifier release failed' }); }
});

router.get('/products/:productId/images', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const images = getDatabase().prepare('SELECT id, product_id, uses_legacy_image, mime_type, byte_size, width, height, alt_text, sort_order, is_primary, created_at, updated_at FROM product_images WHERE product_id = ? ORDER BY sort_order, created_at').all(req.params.productId);
  res.json({ images });
});

// Serves verified gallery bytes as a binary response. The content type comes from
// the detected file signature, never from the stored data-URI prefix, so stored
// data cannot be returned as active content.
router.get('/products/:productId/images/:imageId/data', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  const product = db.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const image = db.prepare('SELECT id, uses_legacy_image, data_uri FROM product_images WHERE id = ? AND product_id = ?')
    .get(req.params.imageId, req.params.productId) as any;
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (image.uses_legacy_image) return res.status(404).json({ error: 'Legacy product images are served by the product image route' });

  const verified = readGalleryImageBytes(image.data_uri);
  if (!verified) return res.status(415).json({ error: 'Stored gallery image is not an approved PNG, JPEG, or WebP file' });

  const etag = createHash('sha256').update(verified.buffer).digest('hex');
  if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();

  res.set({
    'Content-Type': verified.mimeType,
    'Content-Length': verified.buffer.length,
    // Filename is the server-generated image ID, so no request data reaches a header.
    'Content-Disposition': `inline; filename="${image.id}.${verified.extension}"`,
    'X-Content-Type-Options': 'nosniff',
    'ETag': `"${etag}"`,
    'Cache-Control': 'no-cache',
  });
  return res.send(verified.buffer);
});

router.post('/products/:productId/images', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  const dataUri = req.body?.data_uri;
  if (!validImage(dataUri)) return res.status(400).json({ error: 'Image must be a supported compressed WebP, PNG, or JPEG data URI' });
  try {
    const image = withTxn(() => {
      const product = db.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.productId);
      if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
      const count = (db.prepare('SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?').get(req.params.productId) as any).count;
      if (count >= MAX_PRODUCT_IMAGES) throw Object.assign(new Error(`A product may have at most ${MAX_PRODUCT_IMAGES} images`), { statusCode: 400 });
      const id = generateShortId('product_images');
      const primary = count === 0 ? 1 : 0;
      const mime = dataUri.match(/^data:(image\/(?:webp|png|jpeg|jpg));base64,/)?.[1] || null;
      db.prepare(`INSERT INTO product_images (id, product_id, data_uri, uses_legacy_image, mime_type, byte_size, alt_text, sort_order, is_primary, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.params.productId, dataUri, mime, Buffer.from(dataUri.split(',')[1], 'base64').length, text(req.body?.alt_text, 160), count, primary, now(), now());
      writeCatalogueAudit(db, actor(req), 'product_image', id, 'added', { product_id: req.params.productId, mime_type: mime });
      return db.prepare('SELECT id, product_id, uses_legacy_image, mime_type, byte_size, alt_text, sort_order, is_primary FROM product_images WHERE id = ?').get(id);
    });
    return res.status(201).json({ image });
  } catch (error: any) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Image upload failed' }); }
});

router.patch('/products/:productId/images/:imageId', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  try {
    const image = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(req.params.imageId, req.params.productId) as any;
    if (!image) return res.status(404).json({ error: 'Image not found' });
    const requestedPosition = req.body?.position;
    const sortOrder = requestedPosition === undefined
      ? (req.body?.sort_order === undefined ? image.sort_order : req.body.sort_order)
      : requestedPosition;
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) return res.status(400).json({ error: 'sort_order must be a non-negative integer' });
    withTxn(() => {
      if (requestedPosition !== undefined) {
        const images = db.prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY sort_order, created_at').all(req.params.productId) as { id: string }[];
        const currentPosition = images.findIndex((candidate) => candidate.id === image.id);
        if (sortOrder >= images.length) throw Object.assign(new Error('Image position is outside this gallery'), { statusCode: 400 });
        if (sortOrder < currentPosition) {
          db.prepare('UPDATE product_images SET sort_order = sort_order + 1, updated_at = ? WHERE product_id = ? AND sort_order >= ? AND sort_order < ?').run(now(), req.params.productId, sortOrder, currentPosition);
        } else if (sortOrder > currentPosition) {
          db.prepare('UPDATE product_images SET sort_order = sort_order - 1, updated_at = ? WHERE product_id = ? AND sort_order > ? AND sort_order <= ?').run(now(), req.params.productId, currentPosition, sortOrder);
        }
      }
      if (req.body?.is_primary === true) db.prepare('UPDATE product_images SET is_primary = 0, updated_at = ? WHERE product_id = ?').run(now(), req.params.productId);
      db.prepare('UPDATE product_images SET alt_text = ?, sort_order = ?, is_primary = ?, updated_at = ? WHERE id = ?').run(
        req.body?.alt_text === undefined ? image.alt_text : text(req.body.alt_text, 160), sortOrder,
        req.body?.is_primary === undefined ? image.is_primary : (req.body.is_primary ? 1 : 0), now(), image.id);
      writeCatalogueAudit(db, actor(req), 'product_image', image.id, 'updated', { product_id: req.params.productId, primary_changed: req.body?.is_primary === true });
    });
    return res.json({ image: db.prepare('SELECT id, product_id, uses_legacy_image, mime_type, byte_size, alt_text, sort_order, is_primary FROM product_images WHERE id = ?').get(image.id) });
  } catch (error: any) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Image update failed' }); }
});

router.delete('/products/:productId/images/:imageId', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  const image = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(req.params.imageId, req.params.productId) as any;
  if (!image) return res.status(404).json({ error: 'Image not found' });
  if (image.uses_legacy_image) return res.status(409).json({ error: 'Use the existing product image control to remove the legacy image safely' });
  withTxn(() => {
    db.prepare('DELETE FROM product_images WHERE id = ?').run(image.id);
    if (image.is_primary) {
      const replacement = db.prepare('SELECT id FROM product_images WHERE product_id = ? ORDER BY sort_order, created_at LIMIT 1').get(req.params.productId) as { id: string } | undefined;
      if (replacement) db.prepare('UPDATE product_images SET is_primary = 1, updated_at = ? WHERE id = ?').run(now(), replacement.id);
    }
    writeCatalogueAudit(db, actor(req), 'product_image', image.id, 'removed', { product_id: req.params.productId });
  });
  return res.json({ success: true });
});

router.patch('/products/:productId/publishing', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const status = req.body?.catalog_status;
  if (!VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid catalogue status' });
  const db = getDatabase();
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.productId) as any;
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const readiness = catalogueReadiness(db, product);
  if (status === 'published' && readiness.length) return res.status(400).json({ error: 'Product is not ready for publishing', readiness });
  db.prepare('UPDATE products SET catalog_status = ?, published_at = ?, updated_at = ? WHERE id = ?').run(status, status === 'published' ? now() : null, now(), product.id);
  writeCatalogueAudit(db, actor(req), 'product', product.id, 'publishing_changed', { catalog_status: status });
  res.json({ catalog_status: status, readiness });
});

router.get('/collections', requireRole(...ROLE_ACCESS.ownerManager), (_req, res) => {
  const db = getDatabase();
  const collections = db.prepare('SELECT * FROM collections ORDER BY sort_order, name').all() as any[];
  const memberships = collections.length
    ? db.prepare(`SELECT cp.collection_id, cp.product_id, cp.sort_order, p.name AS product_name FROM collection_products cp JOIN products p ON p.id = cp.product_id WHERE cp.collection_id IN (${collections.map(() => '?').join(',')}) ORDER BY cp.sort_order, p.name`).all(...collections.map((collection) => collection.id)) as any[]
    : [];
  res.json({ collections: collections.map((collection) => ({ ...collection, products: memberships.filter((membership) => membership.collection_id === collection.id) })) });
});

router.post('/collections', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const name = text(req.body?.name, 120);
  const slug = text(req.body?.slug, 120)?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!name || !slug) return res.status(400).json({ error: 'Collection name and a valid slug are required' });
  const db = getDatabase();
  try {
    const collection = withTxn(() => {
      const id = generateShortId('collections');
      db.prepare(`INSERT INTO collections (id, name, slug, description, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, name, slug, text(req.body?.description, 500), req.body?.is_active === false ? 0 : 1, Number.isSafeInteger(req.body?.sort_order) ? req.body.sort_order : 0, now(), now());
      writeCatalogueAudit(db, actor(req), 'collection', id, 'created', { name, slug });
      return db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
    });
    return res.status(201).json({ collection });
  } catch (error: any) { return res.status(String(error?.message).includes('UNIQUE') ? 409 : 500).json({ error: String(error?.message).includes('UNIQUE') ? 'Collection slug already exists' : 'Collection creation failed' }); }
});

router.put('/collections/:collectionId', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const db = getDatabase();
  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.collectionId) as any;
  if (!collection) return res.status(404).json({ error: 'Collection not found' });
  const name = req.body?.name === undefined ? collection.name : text(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Collection name is required' });
  const slug = req.body?.slug === undefined ? collection.slug : text(req.body.slug, 120)?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return res.status(400).json({ error: 'A valid collection slug is required' });
  try {
    withTxn(() => {
      db.prepare('UPDATE collections SET name = ?, slug = ?, description = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(name, slug, req.body?.description === undefined ? collection.description : text(req.body.description, 500), req.body?.is_active === undefined ? collection.is_active : (req.body.is_active ? 1 : 0), Number.isSafeInteger(req.body?.sort_order) ? req.body.sort_order : collection.sort_order, now(), collection.id);
      writeCatalogueAudit(db, actor(req), 'collection', collection.id, 'updated', { name, slug });
    });
    return res.json({ collection: db.prepare('SELECT * FROM collections WHERE id = ?').get(collection.id) });
  } catch (error: any) { return res.status(String(error?.message).includes('UNIQUE') ? 409 : 500).json({ error: String(error?.message).includes('UNIQUE') ? 'Collection slug already exists' : 'Collection update failed' }); }
});

router.put('/collections/:collectionId/products', requireRole(...ROLE_ACCESS.ownerManager), (req, res) => {
  const collectionId = String(req.params.collectionId);
  const productIds = Array.isArray(req.body?.product_ids) && req.body.product_ids.every((id: unknown) => typeof id === 'string') ? req.body.product_ids as string[] : null;
  if (!productIds || new Set(productIds).size !== productIds.length) return res.status(400).json({ error: 'product_ids must be a unique array of product IDs' });
  const db = getDatabase();
  try {
    withTxn(() => {
      const exists = db.prepare('SELECT 1 FROM collections WHERE id = ?').get(collectionId);
      if (!exists) throw Object.assign(new Error('Collection not found'), { statusCode: 404 });
      for (const productId of productIds) if (!db.prepare('SELECT 1 FROM products WHERE id = ? AND deleted_at IS NULL').get(productId)) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
      db.prepare('DELETE FROM collection_products WHERE collection_id = ?').run(collectionId);
      const insert = db.prepare('INSERT INTO collection_products (collection_id, product_id, sort_order, created_at) VALUES (?, ?, ?, ?)');
      productIds.forEach((productId, index) => insert.run(collectionId, productId, index, now()));
      writeCatalogueAudit(db, actor(req), 'collection', collectionId, 'products_reordered', { product_count: productIds.length });
    });
    return res.json({ success: true });
  } catch (error: any) { return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Collection update failed' }); }
});

export { router as catalogueRoutes };
