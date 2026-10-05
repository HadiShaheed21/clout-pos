import Link from 'next/link';
import { cn } from '@/lib/utils';
import { formatPrice, discountPercent } from '@/lib/shop/format';
import { isSoldOutProduct, startingPrice } from '@/lib/shop/mock-catalogue';
import type { ShopProduct } from '@/lib/shop/types';
import { PlaceholderImage } from './PlaceholderImage';

/** Listing tile used on the homepage, category, collection and rail surfaces. */
export function ProductCard({ product, className }: { product: ShopProduct; className?: string }) {
  const soldOut = isSoldOutProduct(product);
  const off = discountPercent(product.priceRupees, product.compareAtRupees);

  return (
    <article className={cn('group', className)}>
      <div className="relative overflow-hidden bg-[#EFEEE9]">
        <Link
          href={`/shop/p/${product.slug}`}
          className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#101010] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAFAF8]"
        >
          <PlaceholderImage
            editorial={product.editorial}
            alt={`${product.name} in ${product.subtitle}`}
            seed={product.slug}
            className="transition-transform duration-500 motion-reduce:transition-none group-hover:scale-[1.03]"
          />
        </Link>

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
          {product.badge ? (
            <span className="bg-[#101010] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
              {product.badge}
            </span>
          ) : <span />}
          {off ? (
            <span className="bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#b3261e]">
              {off}% off
            </span>
          ) : null}
        </div>

        {soldOut && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70">
            <span className="border border-[#101010] bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em]">
              Sold out
            </span>
          </div>
        )}
      </div>

      <div className="pt-4">
        <h3 className="text-sm font-semibold leading-snug">
          <Link href={`/shop/p/${product.slug}`} className="clout-link">{product.name}</Link>
        </h3>
        <p className="mt-1 text-xs text-[#6b6b6b]">{product.subtitle}</p>
        <p className="mt-2 flex items-baseline gap-2 text-sm">
          <span className="font-semibold tabular-nums">{formatPrice(startingPrice(product))}</span>
          {product.compareAtRupees && (
            <span className="text-[#6b6b6b] line-through tabular-nums">
              {formatPrice(product.compareAtRupees)}
            </span>
          )}
        </p>
      </div>
    </article>
  );
}
