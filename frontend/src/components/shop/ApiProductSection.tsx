'use client';

import { formatMinor } from '@/lib/shop/format';
import { fetchAllProducts, shopImageUrl } from '@/lib/shop/catalogue-client';
import { isUnavailable, primaryImageOf, type ShopApiProduct } from '@/lib/shop/api-types';
import { cn } from '@/lib/utils';
import {
  ShopEmptyState, ShopErrorState, ShopLoadingState, useShopFetch,
} from './ShopLoadStates';

/**
 * Listing tile backed by a real API product. Falls back to a neutral tile when a
 * product has no image, so a missing asset never breaks the grid.
 */
export function ApiProductCard({ product, className }: { product: ShopApiProduct; className?: string }) {
  const image = primaryImageOf(product);
  const src = shopImageUrl(image?.url);
  const unavailable = isUnavailable(product);
  const discounted = product.compare_at_minor_units !== null
    && product.price_minor_units !== null
    && product.compare_at_minor_units > product.price_minor_units;

  return (
    <article className={cn('group', className)}>
      <div className="relative overflow-hidden bg-[#EFEEE9]">
        <a
          href={`/shop/p/${product.id}`}
          className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#101010] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAFAF8]"
        >
          {src ? (
            // Plain <img>: the public image endpoint is same-origin and CSP
            // allows img-src 'self'. next/image would need remote patterns.
            <img
              src={src}
              alt={image?.alt_text || product.name}
              loading="lazy"
              width={640}
              height={800}
              className="aspect-[4/5] w-full object-cover transition-transform duration-500 motion-reduce:transition-none group-hover:scale-[1.03]"
            />
          ) : (
            <div
              className="flex aspect-[4/5] w-full items-end bg-[#EFEEE9] p-4"
              role="img"
              aria-label={`${product.name} — no image available`}
            >
              <span className="clout-eyebrow">No image</span>
            </div>
          )}
        </a>

        {unavailable && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <span className="border border-[#101010] bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em]">Sold out</span>
          </div>
        )}
      </div>

      <div className="pt-4">
        <h3 className="text-sm font-semibold leading-snug">
          <a href={`/shop/p/${product.id}`} className="clout-link">{product.name}</a>
        </h3>
        {product.category && <p className="mt-1 text-xs text-[#6b6b6b]">{product.category}</p>}
        <p className="mt-2 flex items-baseline gap-2 text-sm">
          <span className="font-semibold tabular-nums">{formatMinor(product.price_minor_units, product.currency)}</span>
          {discounted && (
            <span className="text-[#6b6b6b] line-through tabular-nums">
              {formatMinor(product.compare_at_minor_units, product.currency)}
            </span>
          )}
        </p>
        {product.availability === 'low_stock' && <p className="mt-1 text-xs text-[#a4552d]">Low stock</p>}
      </div>
    </article>
  );
}

export function ApiProductGrid({ products }: { products: ShopApiProduct[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-3 lg:grid-cols-4 md:gap-x-6">
      {products.map((product) => (
        <ApiProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}

/**
 * Loads all published products, then applies a named filter.
 *
 * The filter is a serializable KEY rather than a callback: these sections are
 * rendered by server components, and Next.js cannot pass functions across the
 * server/client boundary.
 */
export type ShopProductFilter = 'all' | 'in_stock' | 'category';

export function matchesShopFilter(product: ShopApiProduct, filter: ShopProductFilter, category?: string): boolean {
  if (filter === 'in_stock') return product.availability === 'in_stock';
  if (filter === 'category') {
    if (!category || category === 'new') return true;
    return (product.category || '').toLowerCase().includes(category.toLowerCase());
  }
  return true;
}

export function ApiProductSection({
  filter = 'all',
  category,
  emptyTitle,
  emptyDetail,
  headingId,
  limit,
}: {
  filter?: ShopProductFilter;
  category?: string;
  emptyTitle: string;
  emptyDetail: string;
  headingId?: string;
  limit?: number;
}) {
  const state = useShopFetch<ShopApiProduct[]>((signal) => fetchAllProducts(signal), []);

  if (state.status === 'loading') return <ShopLoadingState />;
  if (state.status === 'error') return <ShopErrorState message={state.message} />;

  const matches = state.data
    .filter((product) => matchesShopFilter(product, filter, category))
    .slice(0, limit ?? state.data.length);
  if (matches.length === 0) {
    return (
      <section aria-labelledby={headingId} className="mt-10">
        <ShopEmptyState title={emptyTitle} detail={emptyDetail} />
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <p className="clout-eyebrow" aria-live="polite">
        {matches.length} {matches.length === 1 ? 'style' : 'styles'}
      </p>
      <div className="mt-5">
        <ApiProductGrid products={matches} />
      </div>
    </section>
  );
}
