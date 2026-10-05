'use client';

import Link from 'next/link';
import { formatMinor } from '@/lib/shop/format';
import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { fetchProduct, shopImageUrl } from '@/lib/shop/catalogue-client';
import { useShopCartStore } from '@/store/shop-cart-store';
import type { ShopApiImage, ShopApiProduct } from '@/lib/shop/api-types';
import { ShopEmptyState, ShopErrorState, ShopLoadingState, useShopFetch } from './ShopLoadStates';

function ProductImage({ image, name, ratio }: { image: ShopApiImage | null; name: string; ratio: string }) {
  const src = shopImageUrl(image?.url);
  if (!src) {
    return (
      <div className={`flex ${ratio} w-full items-end bg-[#EFEEE9] p-4`} role="img" aria-label={`${name} — no image available`}>
        <span className="clout-eyebrow">No image</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={image?.alt_text || name}
      width={640}
      height={800}
      className={`${ratio} w-full bg-[#EFEEE9] object-cover`}
    />
  );
}

export function AvailabilityPill({ availability, large }: { availability: string; large?: boolean }) {
  const size = large ? 'text-sm' : 'text-xs';
  if (availability === 'out_of_stock') return <span className={`${size} text-[#b3261e]`}>Sold out</span>;
  if (availability === 'low_stock') return <span className={`${size} text-[#a4552d]`}>Low stock</span>;
  return <span className={`${size} text-[#3f6b4a]`}>In stock</span>;
}

function ProductGallery({ product }: { product: ShopApiProduct }) {
  const primary = product.images.find((image) => image.is_primary) ?? product.images[0] ?? null;
  return (
    <div>
      <ProductImage image={primary} name={product.name} ratio="aspect-[4/5]" />
      {product.images.length > 1 && (
        <div className="mt-4 grid grid-cols-3 gap-3">
          {product.images.slice(1, 4).map((image) => (
            <div key={image.id} className="overflow-hidden">
              <ProductImage image={image} name={`${product.name} view`} ratio="aspect-square" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VariantList({ product }: { product: ShopApiProduct }) {
  if (!product.is_variant_product || product.variants.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="clout-eyebrow">Options</h2>
      <ul className="mt-3 space-y-2">
        {product.variants.map((variant) => (
          <li key={variant.id} className="flex flex-wrap items-center justify-between gap-2 border border-[#e4e3df] px-4 py-3 text-sm">
            <span className="flex flex-wrap items-center gap-1">
              {variant.options.map((option) => (
                <span key={`${variant.id}-${option.name}`}>
                  {option.color_hex && (
                    <span
                      aria-hidden
                      className="me-1 inline-block size-3 rounded-full border border-black/15 align-middle"
                      style={{ background: option.color_hex }}
                    />
                  )}
                  <span className="me-2">{option.value}</span>
                </span>
              ))}
              <span className="text-[#6b6b6b]">{variant.display_name}</span>
            </span>
            <span className="flex items-center gap-3">
              <span className="font-semibold tabular-nums">{formatMinor(variant.price_minor_units, product.currency)}</span>
              <AvailabilityPill availability={variant.availability} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ApiProductDetail({ id }: { id: string }) {
  const state = useShopFetch<ShopApiProduct>(
    async (signal) => (await fetchProduct(id, signal)).product,
    [id],
  );

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-[1440px] px-5 py-10 sm:px-8">
        <ShopLoadingState label="Loading product" />
      </div>
    );
  }

  if (state.status === 'error') {
    const notFound = /not found/i.test(state.message);
    return (
      <div className="mx-auto max-w-[1440px] px-5 py-16 sm:px-8">
        {notFound ? (
          <ShopEmptyState
            title="This piece is no longer available"
            detail="It may have sold out or been unpublished. Browse the rest of the collection instead."
          />
        ) : (
          <ShopErrorState message={state.message} />
        )}
        <div className="mt-8 text-center">
          <Link href="/shop" className="clout-link text-sm font-semibold">Back to the shop</Link>
        </div>
      </div>
    );
  }

  const product = state.data;
  const unavailable = product.availability === 'out_of_stock';
  const discounted = product.compare_at_minor_units !== null
    && product.price_minor_units !== null
    && product.compare_at_minor_units > product.price_minor_units;

  return (
    <>
      <nav aria-label="Breadcrumb" className="clout-eyebrow mx-auto max-w-[1440px] px-5 pt-8 sm:px-8">
        <ol className="flex flex-wrap items-center gap-2">
          <li><Link href="/shop" className="hover:text-[#101010]">Home</Link></li>
          <li aria-hidden>/</li>
          {product.collection && (
            <>
              <li>
                <Link href={`/shop/collections/${product.collection.slug}`} className="hover:text-[#101010]">
                  {product.collection.name}
                </Link>
              </li>
              <li aria-hidden>/</li>
            </>
          )}
          <li aria-current="page" className="text-[#101010]">{product.name}</li>
        </ol>
      </nav>

      {/* grid-cols-1 + min-w-0: below lg the track is implicit `auto`, whose
          min-content floor is the longest word in the title. One long
          unbroken product name therefore pushed the column past the viewport
          and the whole page scrolled sideways. */}
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-10 px-5 py-10 sm:px-8 lg:grid-cols-2 lg:gap-16 lg:py-14">
        <div className="min-w-0">
          <ProductGallery product={product} />
        </div>

        <div className="min-w-0">
          <h1 className="clout-display mt-4 break-words text-3xl sm:text-4xl">{product.name}</h1>
          {product.category && <p className="mt-2 text-sm text-[#6b6b6b]">{product.category}</p>}

          <p className="mt-5 flex flex-wrap items-baseline gap-3">
            <span className="text-xl font-semibold tabular-nums">
              {formatMinor(product.price_minor_units, product.currency)}
            </span>
            {discounted && (
              <span className="text-sm text-[#6b6b6b] line-through tabular-nums">
                {formatMinor(product.compare_at_minor_units, product.currency)}
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-[#6b6b6b]">Inclusive of all taxes</p>

          <VariantList product={product} />

          <p aria-live="polite" className="mt-6 min-h-5 text-sm">
            <AvailabilityPill availability={product.availability} large />
          </p>

          <AddToBag product={product} unavailable={unavailable} />

          {product.description && (
            <section className="mt-10 border-t clout-rule pt-8">
              <h2 className="clout-eyebrow">Details</h2>
              <p className="mt-4 text-sm leading-relaxed text-[#4a4a4a]">{product.description}</p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}


/**
 * Add-to-bag control.
 *
 * A variant product requires an explicit choice, so the button stays disabled
 * until one is made. Availability and price always come from the server; the
 * browser only sends a product id, variant id and quantity. On success the
 * server's cart response replaces local state, so the header badge updates.
 */
function AddToBag({ product, unavailable }: { product: ShopApiProduct; unavailable: boolean }) {
  const add = useShopCartStore((state) => state.add);
  const addPending = useShopCartStore((state) => state.addPending);
  const cartError = useShopCartStore((state) => state.error);
  const [selected, setSelected] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  const needsVariant = product.is_variant_product && product.variants.length > 0;
  const chosen = product.variants.find((variant) => variant.id === selected) ?? null;
  const chosenUnavailable = chosen?.availability === 'out_of_stock';
  const canAdd = !unavailable && !addPending && (!needsVariant || (chosen !== null && !chosenUnavailable));

  async function handleAdd() {
    setAdded(false);
    const ok = await add(product.id, chosen?.id ?? null, quantity);
    if (ok) {
      setAdded(true);
      setQuantity(1);
      if (needsVariant) setSelected(null);
    }
  }

  return (
    <div className="mt-4">
      {needsVariant && (
        <fieldset className="mt-6">
          <legend className="clout-eyebrow">Choose a variant</legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {product.variants.map((variant) => {
              const disabled = variant.availability === 'out_of_stock';
              const isSelected = selected === variant.id;
              return (
                <label
                  key={variant.id}
                  className={`flex cursor-pointer items-center gap-2 border px-3 py-2 text-sm transition-colors ${
                    disabled ? 'cursor-not-allowed opacity-45' : 'hover:border-[#101010]'
                  } ${isSelected ? 'border-[#101010] bg-[#101010] text-white' : 'border-[#d9d8d3]'}`}
                >
                  <input
                    type="radio"
                    name="variant"
                    value={variant.id}
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => setSelected(variant.id)}
                    className="sr-only"
                  />
                  <span>
                    {variant.options.length > 0
                      ? variant.options.map((option) => option.value).join(' / ')
                      : variant.display_name}
                  </span>
                  <span className="tabular-nums opacity-70">
                    {formatMinor(variant.price_minor_units, product.currency)}
                  </span>
                </label>
              );
            })}
          </div>
          {needsVariant && !selected && (
            <p className="mt-2 text-xs text-[#6b6b6b]">Select a variant to continue.</p>
          )}
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center border border-[#d9d8d3]" role="group" aria-label="Quantity">
          <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            disabled={addPending || quantity <= 1} aria-label="Decrease quantity"
            className="flex size-11 items-center justify-center disabled:opacity-30">
            <Minus size={14} aria-hidden />
          </button>
          <span className="w-10 text-center text-sm tabular-nums" aria-live="polite">{quantity}</span>
          <button type="button" onClick={() => setQuantity((value) => Math.min(20, value + 1))}
            disabled={addPending} aria-label="Increase quantity"
            className="flex size-11 items-center justify-center disabled:opacity-30">
            <Plus size={14} aria-hidden />
          </button>
        </div>

        <button
          type="button"
          onClick={() => { void handleAdd(); }}
          disabled={!canAdd}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 bg-[#101010] px-8 text-sm font-semibold text-white transition-colors hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:bg-[#c9c7c2] sm:flex-none"
        >
          {unavailable ? 'Sold out' : chosenUnavailable ? 'Variant sold out' : addPending ? 'Adding…' : 'Add to bag'}
        </button>
      </div>

      <p aria-live="polite" className="mt-3 min-h-5 text-sm">
        {added && !cartError && <span className="text-[#3f6b4a]">Added to your bag.</span>}
        {cartError && <span role="alert" className="text-[#b3261e]">{cartError}</span>}
      </p>
    </div>
  );
}
