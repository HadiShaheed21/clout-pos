'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useShopCartStore } from '@/store/shop-cart-store';
import { formatMinor } from '@/lib/shop/format';
import { CartLinesList } from './CartLinesList';
import { ShopEmptyState, ShopErrorState, ShopLoadingState } from './ShopLoadStates';

/**
 * Bag page backed entirely by the server cart.
 *
 * The subtotal shown here is the SERVER's integer minor-unit total. The browser
 * formats it for display but never computes it, and checkout is deliberately
 * deferred to Phase 4 — nothing here places an order or reserves stock.
 */
export function ShopCartView() {
  const cart = useShopCartStore((state) => state.cart);
  const status = useShopCartStore((state) => state.status);
  const error = useShopCartStore((state) => state.error);
  const refresh = useShopCartStore((state) => state.refresh);
  const clear = useShopCartStore((state) => state.clear);
  const pendingItemId = useShopCartStore((state) => state.pendingItemId);

  useEffect(() => { void refresh(); }, [refresh]);

  const busy = pendingItemId !== null;

  return (
    <>
      <header className="border-b clout-rule">
        <div className="mx-auto max-w-[1440px] px-5 py-12 sm:px-8">
          <nav aria-label="Breadcrumb" className="clout-eyebrow">
            <ol className="flex items-center gap-2">
              <li><Link href="/shop" className="hover:text-[#101010]">Home</Link></li>
              <li aria-hidden>/</li>
              <li aria-current="page" className="text-[#101010]">Bag</li>
            </ol>
          </nav>
          <h1 className="clout-display mt-5 text-[clamp(2.25rem,6vw,4.5rem)]">Your bag</h1>
          {status === 'ready' && cart.items.length > 0 && (
            <p className="mt-3 text-sm text-[#6b6b6b]">
              {cart.item_count} {cart.item_count === 1 ? 'item' : 'items'}
            </p>
          )}
        </div>
      </header>

      <section className="mx-auto max-w-[1440px] px-5 py-12 sm:px-8">
        {status === 'loading' || status === 'idle' ? (
          <ShopLoadingState label="Loading your bag" />
        ) : status === 'error' ? (
          <ShopErrorState message={error ?? 'Unable to load your bag.'} />
        ) : cart.items.length === 0 ? (
          <ShopEmptyState
            title="Your bag is empty"
            detail="Pieces you add will stay here, even after you close the browser."
          />
        ) : (
          // grid-cols-1 pins the mobile track to minmax(0,1fr); the implicit `auto`
          // track has a min-content floor, so one long product name in the bag
          // widened the column past the viewport.
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_22rem] lg:gap-16">
            <div className="min-w-0">
              {error && (
                <p role="alert" className="mb-6 border border-[#e0c4c0] bg-[#fdf6f5] px-4 py-3 text-sm text-[#b3261e]">
                  {error}
                </p>
              )}
              <CartLinesList />
            </div>

            <aside className="lg:sticky lg:top-8 lg:self-start">
              <div className="border clout-rule p-6">
                <h2 className="clout-eyebrow">Summary</h2>
                <dl className="mt-5 space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-[#6b6b6b]">Items</dt>
                    <dd className="tabular-nums">{cart.item_count}</dd>
                  </div>
                  <div className="flex items-center justify-between border-t clout-rule pt-3 text-base font-semibold">
                    <dt>Subtotal</dt>
                    <dd className="tabular-nums">{formatMinor(cart.subtotal_minor_units, cart.currency)}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-[#6b6b6b]">
                  Taxes and shipping are calculated at checkout. Adding to your bag does not reserve stock.
                </p>

                {cart.has_unavailable_items && (
                  <p role="alert" className="mt-4 border border-[#e0c4c0] bg-[#fdf6f5] px-3 py-2 text-xs text-[#b3261e]">
                    Remove the unavailable items above to continue.
                  </p>
                )}

                <button
                  type="button"
                  disabled
                  className="mt-6 inline-flex min-h-12 w-full cursor-not-allowed items-center justify-center bg-[#c9c7c2] px-6 text-sm font-semibold text-white"
                >
                  Checkout — coming next
                </button>

                <button
                  type="button"
                  onClick={() => { void clear(); }}
                  disabled={busy}
                  className="mt-3 w-full border border-[#101010] px-6 py-3 text-sm font-semibold transition-colors hover:bg-[#101010] hover:text-white disabled:opacity-40"
                >
                  Empty bag
                </button>
              </div>

              <p className="mt-4 text-center text-xs text-[#6b6b6b]">
                <Link href="/shop" className="clout-link">Continue shopping</Link>
              </p>
            </aside>
          </div>
        )}
      </section>
    </>
  );
}