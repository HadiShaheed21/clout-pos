'use client';

import Link from 'next/link';
import { Trash2, Minus, Plus } from 'lucide-react';
import { formatMinor } from '@/lib/shop/format';
import { cartImageUrl, type CartLine } from '@/lib/shop/cart-client';
import { useShopCartStore } from '@/store/shop-cart-store';
import { cn } from '@/lib/utils';

const AVAILABILITY_COPY: Record<string, { label: string; className: string }> = {
  in_stock: { label: 'In stock', className: 'text-[#3f6b4a]' },
  low_stock: { label: 'Low stock', className: 'text-[#a4552d]' },
  out_of_stock: { label: 'Sold out', className: 'text-[#b3261e]' },
};

function StatusNote({ line }: { line: CartLine }) {
  if (line.status === 'ok') {
    const availability = AVAILABILITY_COPY[line.availability] ?? AVAILABILITY_COPY.in_stock;
    return <p className={`mt-1 text-xs ${availability.className}`}>{availability.label}</p>;
  }
  return (
    <p role="alert" className="mt-1 text-xs text-[#b3261e]">
      {line.message ?? 'This piece is no longer available.'}
    </p>
  );
}

function CartLineRow({ line }: { line: CartLine }) {
  const pendingItemId = useShopCartStore((state) => state.pendingItemId);
  const setQuantity = useShopCartStore((state) => state.setQuantity);
  const remove = useShopCartStore((state) => state.remove);

  const busy = pendingItemId === line.item_id;
  const purchasable = line.status === 'ok';
  // Quantity may still be REDUCED on a line that is over available stock
  // (status 'unavailable', but not sold out or unpublished) so the shopper can
  // bring it back within stock and unblock checkout.
  const canDecrement = !busy && line.quantity > 1
    && line.status !== 'unpublished' && line.availability !== 'out_of_stock';
  const src = cartImageUrl(line.image_url);

  return (
    <li className="flex gap-4 border-b clout-rule py-6 sm:gap-6">
      <Link
        href={`/shop/p/${line.product_id}`}
        className="block w-24 shrink-0 bg-[#EFEEE9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#101010] sm:w-32"
      >
        {src ? (
          <img src={src} alt={line.product_name} width={200} height={250} loading="lazy"
            className="aspect-[4/5] w-full object-cover" />
        ) : (
          <div className="flex aspect-[4/5] w-full items-end bg-[#EFEEE9] p-2"
            role="img" aria-label={`${line.product_name} — no image available`}>
            <span className="clout-eyebrow">No image</span>
          </div>
        )}
      </Link>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-snug">
              <Link href={`/shop/p/${line.product_id}`} className="clout-link break-words">{line.product_name}</Link>
            </h3>
            {line.options.length > 0 && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#6b6b6b]">
                {line.options.map((option) => (
                  <span key={option.name} className="inline-flex items-center gap-1">
                    {option.color_hex && (
                      <span aria-hidden className="inline-block size-3 rounded-full border border-black/15"
                        style={{ background: option.color_hex }} />
                    )}
                    {option.name}: {option.value}
                  </span>
                ))}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => { void remove(line.item_id); }}
            disabled={busy}
            aria-label={`Remove ${line.product_name} from your bag`}
            className="shrink-0 p-1 text-[#6b6b6b] transition-colors hover:text-[#b3261e] disabled:opacity-40"
          >
            <Trash2 size={16} aria-hidden />
          </button>
        </div>

        <StatusNote line={line} />

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
          <div className="flex items-center border border-[#d9d8d3]" role="group"
            aria-label={`Quantity for ${line.product_name}`}>
            <button type="button" onClick={() => { void setQuantity(line.item_id, line.quantity - 1); }}
              disabled={!canDecrement}
              aria-label="Decrease quantity"
              className="flex size-9 items-center justify-center disabled:opacity-30">
              <Minus size={14} aria-hidden />
            </button>
            <span aria-live="polite" className="w-9 text-center text-sm tabular-nums">{line.quantity}</span>
            <button type="button" onClick={() => { void setQuantity(line.item_id, line.quantity + 1); }}
              disabled={busy || !purchasable}
              aria-label="Increase quantity"
              className="flex size-9 items-center justify-center disabled:opacity-30">
              <Plus size={14} aria-hidden />
            </button>
          </div>

          <div className="text-right">
            <p className="text-sm font-semibold tabular-nums">{formatMinor(line.line_total_minor_units, line.currency)}</p>
            {line.quantity > 1 && (
              <p className="mt-0.5 text-xs text-[#6b6b6b] tabular-nums">
                {formatMinor(line.unit_price_minor_units, line.currency)} each
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Server-backed bag lines, shared by the cart page and the drawer. */
export function CartLinesList({ className }: { className?: string }) {
  const items = useShopCartStore((state) => state.cart.items);
  const pendingItemId = useShopCartStore((state) => state.pendingItemId);
  return (
    <ul className={cn('divide-y clout-rule', className)} aria-busy={pendingItemId !== null}>
      {items.map((line) => <CartLineRow key={line.item_id} line={line} />)}
    </ul>
  );
}
