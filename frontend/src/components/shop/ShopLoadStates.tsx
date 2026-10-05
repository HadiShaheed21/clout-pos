'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ShopApiError, isAbortError } from '@/lib/shop/catalogue-client';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

/**
 * Loads catalogue data with abort-on-unmount so a fast navigation cannot resolve
 * into a stale render. Failures are surfaced, never masked with placeholder data.
 *
 * Cancellation is not failure: an AbortError from unmount, a changed dependency
 * or a superseded request is dropped rather than rendered as an error state.
 */
export function useShopFetch<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): LoadState<T> {
  // Results carry the dependency key they were fetched for, so a stale response
  // can never render against new inputs — and no setState-in-effect cascade.
  const [settled, setSettled] = useState<{ key: string; value: LoadState<T> } | null>(null);
  const key = JSON.stringify(deps);

  useEffect(() => {
    const controller = new AbortController();
    loader(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSettled({ key, value: { status: 'ready', data } });
      })
      .catch((error: unknown) => {
        // Both checks matter: the signal catches this hook's own cancellation,
        // and the error name catches an abort that arrived any other way.
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = error instanceof ShopApiError
          ? error.message
          : 'Unable to load the store catalogue.';
        setSettled({ key, value: { status: 'error', message } });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return settled && settled.key === key ? settled.value : ({ status: 'loading' } as LoadState<T>);
}

export function ShopErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border border-dashed border-[#c9c7c2] px-6 py-14 text-center">
      <AlertTriangle size={20} className="text-[#a4552d]" aria-hidden />
      <p className="text-sm font-semibold">We could not load the shop right now</p>
      <p className="max-w-sm text-sm text-[#6b6b6b]">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-2 border border-[#101010] px-5 py-2.5 text-sm font-semibold hover:bg-[#101010] hover:text-white"
      >
        Try again
      </button>
    </div>
  );
}

export function ShopEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="border border-dashed border-[#c9c7c2] px-6 py-14 text-center">
      <p className="clout-display text-xl">{title}</p>
      <p className="mx-auto mt-3 max-w-sm text-sm text-[#6b6b6b]">{detail}</p>
    </div>
  );
}

/** Skeleton keeps the layout stable while the catalogue loads. */
export function ProductGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-4 md:gap-x-6" aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>
          <div className="aspect-[4/5] animate-pulse bg-[#EFEEE9]" />
          <div className="mt-4 h-3 w-2/3 animate-pulse bg-[#EFEEE9]" />
          <div className="mt-2 h-3 w-1/3 animate-pulse bg-[#EFEEE9]" />
        </div>
      ))}
    </div>
  );
}

export function ShopLoadingState({ label = 'Loading products' }: { label?: string }) {
  return (
    <div>
      <p className="sr-only" role="status">{label}</p>
      <ProductGridSkeleton />
    </div>
  );
}
