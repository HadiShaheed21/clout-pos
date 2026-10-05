import { Router, Request, Response } from 'express';
import { generateShortId, getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { recordStockMovement } from '../services/stock-movements';

const router = Router();

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const items = req.body?.items;
    const purchasedAt = typeof req.body?.purchased_at === 'string' ? req.body.purchased_at : now();
    if (!Array.isArray(items) || items.length === 0 || items.length > 200) return res.status(400).json({ error: 'items must contain between 1 and 200 entries' });
    if (typeof req.body?.supplier === 'string' && req.body.supplier.length > 200) return res.status(400).json({ error: 'supplier must be 200 characters or fewer' });
    const db = getDatabase();
    const purchaseId = generateShortId('purchases');
    const actor = String((req as any).user.userId);
    const createdAt = now();
    const createPurchase = db.transaction(() => {
      let total = 0;
      db.prepare(`INSERT INTO purchases (id, supplier, reference, purchased_at, created_by, total, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(purchaseId, typeof req.body.supplier === 'string' ? req.body.supplier.trim() || null : null,
          typeof req.body.reference === 'string' ? req.body.reference.trim().slice(0, 120) || null : null,
          purchasedAt, actor, createdAt, createdAt);
      const insertItem = db.prepare(`INSERT INTO purchase_items (purchase_id, product_id, variant_id, quantity, unit_cost, total)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const item of items) {
        if (!item || typeof item.product_id !== 'string' || typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0
          || typeof item.unit_cost !== 'number' || !Number.isFinite(item.unit_cost) || item.unit_cost < 0) {
          throw Object.assign(new Error('Each item requires product_id, positive quantity, and non-negative unit_cost'), { statusCode: 400 });
        }
        const product = db.prepare('SELECT id, track_inventory, stock_quantity FROM products WHERE id = ? AND deleted_at IS NULL').get(item.product_id) as { id: string; track_inventory: number; stock_quantity: number } | undefined;
        if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 });
        const variant = item.variant_id ? db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ? AND deleted_at IS NULL').get(item.variant_id, product.id) as any : null;
        if (item.variant_id && !variant) throw Object.assign(new Error('Variant not found for product'), { statusCode: 404 });
        if (variant && (!Number.isSafeInteger(item.quantity) || item.quantity <= 0)) throw Object.assign(new Error('Variant purchases require a positive whole-unit quantity'), { statusCode: 400 });
        if (!product.track_inventory) throw Object.assign(new Error('Purchases require inventory tracking to be enabled for every product'), { statusCode: 400 });
        const lineTotal = item.quantity * item.unit_cost;
        insertItem.run(purchaseId, product.id, variant?.id || null, item.quantity, item.unit_cost, lineTotal);
        if (variant) db.prepare('UPDATE product_variants SET stock_quantity = stock_quantity + ?, cost_override = ?, updated_at = ? WHERE id = ?').run(item.quantity, item.unit_cost, createdAt, variant.id);
        else db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, cost = ?, updated_at = ? WHERE id = ?').run(item.quantity, item.unit_cost, createdAt, product.id);
        recordStockMovement(db, { productId: product.id, variantId: variant?.id || null, quantityDelta: item.quantity, previousQuantity: variant?.stock_quantity ?? product.stock_quantity,
          movementType: 'purchase', referenceType: 'purchase', referenceId: purchaseId, actorUserId: actor, createdAt });
        total += lineTotal;
      }
      db.prepare('UPDATE purchases SET total = ? WHERE id = ?').run(total, purchaseId);
    });
    createPurchase();
    res.status(201).json({ purchase: db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) });
  } catch (error: any) {
    res.status(error.statusCode || 500).json({ error: error.message || 'Unable to create purchase' });
  }
});

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (_req: Request, res: Response) => {
  const db = getDatabase();
  res.json({ purchases: db.prepare('SELECT * FROM purchases ORDER BY purchased_at DESC, created_at DESC LIMIT 500').all() });
});

export { router as purchaseRoutes };
