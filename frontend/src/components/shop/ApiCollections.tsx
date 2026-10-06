'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { fetchAllProducts, fetchCollections } from '@/lib/shop/catalogue-client';
import { slugFromShopPathname } from '@/lib/shop/slug-from-pathname';
import type { ShopApiCollection, ShopApiProduct } from '@/lib/shop/api-types';
import { ApiProductGrid } from './ApiProductSection';
import { ShopEmptyState, ShopErrorState, ShopLoadingState, useShopFetch } from './ShopLoadStates';

/** Collections index backed by the public API. */
export function ApiCollectionsIndex() {
  const state = useShopFetch<ShopApiCollection[]>(
    async (signal) => (await fetchCollections(signal)).collections,
    [],
  );

  if (state.status === 'loading') return <ShopLoadingState label="Loading collections" />;
  if (state.status === 'error') return <ShopErrorState message={state.message} />;
  if (state.data.length === 0) {
    return (
      <ShopEmptyState
        title="No collections yet"
        detail="We are preparing the first edit. Check back shortly."
      />
    );
  }

  return (
    <ul className="grid gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
      {state.data.map((collection) => (
        <li key={collection.slug}>
          <Link href={`/shop/collections/${collection.slug}`} className="group block">
            <div
              className="aspect-[3/2] w-full bg-[#EFEEE9] transition-transform duration-500 motion-reduce:transition-none group-hover:scale-[1.02]"
              role="img"
              aria-label={`${collection.name} collection`}
            />
            <h2 className="mt-4 text-lg font-semibold">{collection.name}</h2>
            {collection.description && <p className="mt-1 text-sm text-[#6b6b6b]">{collection.description}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Products belonging to one collection; the live pathname wins over the seed slug. */
export function ApiCollectionProducts({ slug }: { slug: string }) {
  const pathname = usePathname();
  const collectionSlug = slugFromShopPathname(pathname, '/shop/collections/') ?? slug;
  const state = useShopFetch<ShopApiProduct[]>(
    async (signal) => (await fetchAllProducts(signal)).filter((product) => product.collection?.slug === collectionSlug),
    [collectionSlug],
  );

  if (state.status === 'loading') return <ShopLoadingState label="Loading collection" />;
  if (state.status === 'error') return <ShopErrorState message={state.message} />;
  if (state.data.length === 0) {
    return (
      <ShopEmptyState
        title="Nothing in this collection yet"
        detail="This edit has no published pieces right now."
      />
    );
  }
  return <ApiProductGrid products={state.data} />;
}

function formatCollectionLabel(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Slug-derived label that follows the live pathname over the seed slug. */
export function ApiCollectionLabel({ slug }: { slug: string }) {
  const pathname = usePathname();
  const liveSlug = slugFromShopPathname(pathname, '/shop/collections/') ?? slug;
  return <>{formatCollectionLabel(liveSlug)}</>;
}

