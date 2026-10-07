'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { X, Minus, Plus, Trash2 } from 'lucide-react';
import { useShopCartStore } from '@/store/shop-cart-store';
import { cartImageUrl, type CartLine } from '@/lib/shop/cart-client';
import { formatMinor } from '@/lib/shop/format';

/**
 * Slide-over bag. Reads the same server-backed store as the bag page, so the
 * header badge, drawer and page can never disagree.
 */
export function CartDrawer() {
  const isOpen = useShopCartStore((state) => state.drawerOpen);
  const cart = useShopCartStore((state) => state.cart);
  const closeDrawer = useShopCartStore((state) => state.closeDrawer);
  const refresh = useShopCartStore((state) => state.refresh);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Fetch once on first open so the drawer is never stale.
  useEffect(() => { if (isOpen) void refresh(); }, [isOpen, refresh]);

  // Escape closes; focus moves into the dialog for keyboard users.
  useEffect(() => {
    if (!isOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeDrawer(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, closeDrawer]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close bag" onClick={closeDrawer} className="absolute inset-0 bg-black/30" />
      <div role="dialog" aria-modal="true" aria-label="Your bag"
        className="relative flex h-full w-full max-w-md flex-col bg-[#FAFAF8] shadow-xl">
        <header className="flex items-center justify-between border-b clout-rule px-5 py-4">
          <h2 className="clout-eyebrow">Your bag ({cart.item_count})</h2>
          <button ref={closeRef} type="button" onClick={closeDrawer} aria-label="Close bag"
            className="p-1 text-[#6b6b6b] hover:text-[#101010]">
            <X size={18} aria-hidden />
          </button>
        </header>

        {cart.items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <p className="text-sm text-[#6b6b6b]">Your bag is empty.</p>
            <Link href="/shop" onClick={closeDrawer} className="clout-link text-sm font-semibold">Browse the shop</Link>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5">
              {cart.items.map((line) => <DrawerLine key={line.item_id} line={line} />)}
            </div>
            <footer className="border-t clout-rule px-5 py-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#6b6b6b]">Subtotal</span>
                <span className="text-lg font-semibold tabular-nums">
                  {formatMinor(cart.subtotal_minor_units, cart.currency)}
                </span>
              </div>
              <Link href="/shop/cart" onClick={closeDrawer}
                className="mt-4 flex min-h-12 w-full items-center justify-center bg-[#101010] px-6 text-sm font-semibold text-white">
                View bag
              </Link>
              <p className="mt-3 text-center text-xs text-[#6b6b6b]">Adding to your bag does not reserve stock.</p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
function DrawerLine({ line }: { line: CartLine }) {
  const pendingItemId = useShopCartStore((state) => state.pendingItemId);
  const setQuantity = useShopCartStore((state) => state.setQuantity);
  const remove = useShopCartStore((state) => state.remove);
  const busy = pendingItemId === line.item_id;
  const purchasable = line.status === 'ok';
  // Mirrors the bag page: a line over available stock can still be REDUCED.
  const canDecrement = !busy && line.quantity > 1
    && line.status !== 'unpublished' && line.availability !== 'out_of_stock';
  const src = cartImageUrl(line.image_url);

  return (
    <div className="flex gap-4 border-b clout-rule py-4">
      <div className="w-16 shrink-0 bg-[#EFEEE9]">
        {src ? (
          <img src={src} alt={line.product_name} width={100} height={125} loading="lazy"
            className="aspect-[4/5] w-full object-cover" />
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold leading-snug">{line.product_name}</p>
          <button type="button" onClick={() => { void remove(line.item_id); }} disabled={busy}
            aria-label={`Remove ${line.product_name} from your bag`}
            className="shrink-0 p-1 text-[#6b6b6b] hover:text-[#b3261e] disabled:opacity-40">
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
        {line.options.length > 0 && (
          <p className="mt-1 text-xs text-[#6b6b6b]">
            {line.options.map((option) => `${option.name}: ${option.value}`).join(' · ')}
          </p>
        )}
        {line.status !== 'ok' && (
          <p role="alert" className="mt-1 text-xs text-[#b3261e]">{line.message ?? 'No longer available.'}</p>
        )}

        <div className="mt-auto flex items-center justify-between gap-3 pt-2">
          <div className="flex items-center border border-[#d9d8d3]">
            <button type="button" onClick={() => { void setQuantity(line.item_id, line.quantity - 1); }}
              disabled={!canDecrement} aria-label="Decrease quantity"
              className="flex size-8 items-center justify-center disabled:opacity-30">
              <Minus size={12} aria-hidden />
            </button>
            <span className="w-7 text-center text-xs tabular-nums">{line.quantity}</span>
            <button type="button" onClick={() => { void setQuantity(line.item_id, line.quantity + 1); }}
              disabled={busy || !purchasable} aria-label="Increase quantity"
              className="flex size-8 items-center justify-center disabled:opacity-30">
              <Plus size={12} aria-hidden />
            </button>
          </div>
          <span className="text-sm font-semibold tabular-nums">
            {formatMinor(line.line_total_minor_units, line.currency)}
          </span>
        </div>
      </div>
    </div>
  );
}
