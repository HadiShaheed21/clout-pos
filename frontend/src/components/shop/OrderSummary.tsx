'use client';

import { formatPrice } from '@/lib/shop/format';
import { useShopCart } from '@/store/shop-cart';

/** Sticky order summary shared by the cart and checkout pages. */
export function OrderSummary({
  children,
  note,
}: {
  /** Optional call-to-action rendered under the totals. */
  children?: React.ReactNode;
  note?: string;
}) {
  const lines = useShopCart((state) => state.lines);
  const subtotal = lines.reduce((sum, line) => sum + line.priceRupees * line.quantity, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <div className="border clout-rule p-6">
      <h2 className="clout-eyebrow">Summary</h2>
      <dl className="mt-5 space-y-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-[#6b6b6b]">Subtotal</dt>
          <dd className="font-semibold tabular-nums">{formatPrice(subtotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[#6b6b6b]">Shipping</dt>
          <dd>Calculated at checkout</dd>
        </div>
        <div className="flex justify-between border-t clout-rule pt-3 text-base">
          <dt className="font-semibold">Total</dt>
          <dd className="font-semibold tabular-nums">{formatPrice(subtotal)}</dd>
        </div>
      </dl>
      <p aria-live="polite" className="mt-4 text-xs text-[#6b6b6b]">
        {itemCount} {itemCount === 1 ? 'item' : 'items'}
      </p>
      {children}
      {note ? <p className="mt-3 text-xs text-[#6b6b6b]">{note}</p> : null}
    </div>
  );
}
