'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { formatPrice, discountPercent, isLowStock, slugToLabel } from '@/lib/shop/format';
import { getCollectionBySlug } from '@/lib/shop/mock-catalogue';
import { findVariant, optionsForProduct, type ShopProduct, type ShopVariant } from '@/lib/shop/types';
import { useShopCart } from '@/store/shop-cart';
import { PlaceholderImage } from './PlaceholderImage';
import { ProductCard } from './ProductCard';
import { QuantityStepper, VariantPicker } from './VariantPicker';

export function ProductDetail({ product, related }: { product: ShopProduct; related: ShopProduct[] }) {
  const groups = useMemo(() => optionsForProduct(product.variants), [product.variants]);
  const collection = getCollectionBySlug(product.collection_slug);

  // Seed the selection from the first in-stock variant so the page never loads
  // in an "add to bag with nothing chosen" state.
  const initial = useMemo(() => {
    const firstAvailable = product.variants.find((variant) => variant.is_active && variant.stock_quantity > 0)
      ?? product.variants.find((variant) => variant.is_active)
      ?? product.variants[0];
    const selection: Record<string, string> = {};
    for (const option of firstAvailable?.options ?? []) {
      selection[option.colorHex ? 'Colour' : 'Size'] = option.label;
    }
    return selection;
  }, [product.variants]);

  const [selection, setSelection] = useState<Record<string, string>>(initial);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const addLine = useShopCart((state) => state.addLine);

  const selected: ShopVariant | null = useMemo(
    () => findVariant(product.variants, selection),
    [product.variants, selection],
  );
  const soldOut = !selected || selected.stock_quantity <= 0;
  const off = discountPercent(product.priceRupees, product.compareAtRupees);

  const handleChange = (group: string, value: string) => {
    setSelection((current) => ({ ...current, [group]: value }));
    setQuantity(1);
    setAdded(false);
  };

  const handleAdd = () => {
    if (!selected || soldOut) return;
    addLine({ productSlug: product.slug, name: product.name, variant: selected, quantity });
    setAdded(true);
  };

  return (
    <>
      <nav aria-label="Breadcrumb" className="clout-eyebrow mx-auto max-w-[1440px] px-5 pt-8 sm:px-8">
        <ol className="flex flex-wrap items-center gap-2">
          <li><Link href="/shop" className="hover:text-[#101010]">Home</Link></li>
          <li aria-hidden>/</li>
          <li><Link href={`/shop/c/${product.category}`} className="hover:text-[#101010]">{slugToLabel(product.category)}</Link></li>
          {collection && (
            <>
              <li aria-hidden>/</li>
              <li><Link href={`/shop/collections/${collection.slug}`} className="hover:text-[#101010]">{collection.name}</Link></li>
            </>
          )}
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-[#101010]">{product.name}</li>
        </ol>
      </nav>

      <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-10 sm:px-8 lg:grid-cols-2 lg:gap-16 lg:py-14">
        <div>
          <PlaceholderImage
            editorial={product.editorial}
            alt={`${product.name} — ${product.subtitle}`}
            seed={product.slug}
            ratio="aspect-[4/5]"
          />
          <div className="mt-4 grid grid-cols-3 gap-3">
            {[0, 1, 2].map((index) => (
              <PlaceholderImage
                key={index}
                editorial={product.editorial}
                alt={`${product.name} view ${index + 1}`}
                seed={`${product.slug}-${index}`}
                ratio="aspect-square"
              />
            ))}
          </div>
        </div>
        <div>
          {product.badge && (
            <span className="inline-block bg-[#101010] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
              {product.badge}
            </span>
          )}

          <h1 className="clout-display mt-4 text-3xl sm:text-4xl">{product.name}</h1>
          <p className="mt-2 text-sm text-[#6b6b6b]">{product.subtitle}</p>

          <p className="mt-5 flex flex-wrap items-baseline gap-3">
            <span className="text-xl font-semibold tabular-nums">
              {formatPrice(selected?.priceRupees ?? product.priceRupees)}
            </span>
            {product.compareAtRupees && (
              <span className="text-sm text-[#6b6b6b] line-through tabular-nums">{formatPrice(product.compareAtRupees)}</span>
            )}
            {off ? <span className="text-xs font-semibold text-[#b3261e]">{off}% off</span> : null}
          </p>
          <p className="mt-1 text-xs text-[#6b6b6b]">Inclusive of all taxes</p>

          <div className="mt-9">
            <VariantPicker
              groups={groups}
              selection={selection}
              onChange={handleChange}
              findVariantFor={(candidate) => findVariant(product.variants, candidate)}
            />
          </div>

          {/* Stock changes are announced as the shopper changes selection. */}
          <p aria-live="polite" className="mt-6 min-h-5 text-sm">
            {soldOut ? (
              <span className="text-[#b3261e]">This combination is sold out.</span>
            ) : isLowStock(selected!.stock_quantity) ? (
              <span className="text-[#a4552d]">Only {selected!.stock_quantity} left in this size</span>
            ) : (
              <span className="text-[#3f6b4a]">In stock, ships within 2 days</span>
            )}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <QuantityStepper
              value={quantity}
              max={Math.max(1, selected?.stock_quantity ?? 1)}
              onChange={(next) => { setQuantity(next); setAdded(false); }}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={soldOut}
              className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 bg-[#101010] px-8 text-sm font-semibold text-white transition-colors hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:bg-[#c9c7c2]"
            >
              {soldOut ? 'Sold out' : added ? <><Check size={16} /> Added to bag</> : 'Add to bag'}
            </button>
          </div>

          <div className="mt-10 border-t clout-rule pt-8">
            <h2 className="clout-eyebrow">Details</h2>
            <p className="mt-4 text-sm leading-relaxed text-[#4a4a4a]">{product.description}</p>
            <ul className="mt-5 space-y-2">
              {product.details.map((detail) => (
                <li key={detail} className="flex gap-3 text-sm text-[#4a4a4a]">
                  <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-[#101010]" />
                  {detail}
                </li>
              ))}
            </ul>
          </div>

          <dl className="mt-8 space-y-3 border-t clout-rule pt-8 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-[#6b6b6b]">SKU</dt>
              <dd className="font-mono text-xs">{selected?.sku ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[#6b6b6b]">Category</dt>
              <dd>{slugToLabel(product.category)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[#6b6b6b]">Collection</dt>
              <dd>{collection?.name ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </div>
      {related.length > 0 && (
        <section aria-labelledby="related-heading" className="border-t clout-rule bg-[#F2F1EC]">
          <div className="mx-auto max-w-[1440px] px-5 py-20 sm:px-8">
            <h2 id="related-heading" className="clout-display text-2xl sm:text-3xl">You may also like</h2>
            <div className="mt-10 grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-4 md:gap-x-6">
              {related.map((item) => (
                <ProductCard key={item.id} product={item} />
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
