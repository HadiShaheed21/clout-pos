import type Database from 'better-sqlite3';

export type StockMovementType = 'opening' | 'purchase' | 'sale' | 'sale_cancelled' | 'refund' | 'adjustment';

type StockMovement = {
  productId: string;
  variantId?: string | null;
  quantityDelta: number;
  previousQuantity: number;
  movementType: StockMovementType;
  referenceType?: string;
  referenceId?: string | number;
  reason?: string | null;
  actorUserId?: string | null;
  createdAt: string;
};

/** Records an append-only explanation for a stock mutation in the same transaction. */
export function recordStockMovement(db: Database.Database, movement: StockMovement): void {
  db.prepare(`
    INSERT INTO stock_movements (
      product_id, variant_id, movement_type, quantity_delta, quantity_before, quantity_after,
      reference_type, reference_id, reason, actor_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    movement.productId,
    movement.variantId ?? null,
    movement.movementType,
    movement.quantityDelta,
    movement.previousQuantity,
    movement.previousQuantity + movement.quantityDelta,
    movement.referenceType ?? null,
    movement.referenceId == null ? null : String(movement.referenceId),
    movement.reason ?? null,
    movement.actorUserId ?? null,
    movement.createdAt,
  );
}
