'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { SHOP_BRAND } from '@/lib/shop/mock-catalogue';

/**
 * Candidate brand lockups, best first. A supplied `clout-logo.png` wins as soon
 * as it is dropped into `frontend/public`; the vector fallback covers the gap.
 * Same-origin, so `img-src 'self'` permits both.
 */
const LOGO_SOURCES = ['/clout-logo.png', '/clout-logo.svg'];

/**
 * Renders the brand lockup, degrading from PNG → SVG → CSS wordmark so the
 * storefront never shows a broken image.
 *
 * `className` sizes the image only; the text fallback takes `fallbackClassName`.
 * They must stay separate — handing an image height class to the text fallback
 * stretches the glyphs instead of sizing them.
 */
export function CloutWordmark({
  className,
  fallbackClassName,
  alt = '',
}: {
  className?: string;
  fallbackClassName?: string;
  alt?: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [index, setIndex] = useState(0);
  const [lastFailed, setLastFailed] = useState(false);

  const isLast = index === LOGO_SOURCES.length - 1;

  const handleFailure = useCallback(() => {
    if (index + 1 < LOGO_SOURCES.length) {
      setIndex(index + 1);
    } else {
      setLastFailed(true);
    }
  }, [index]);

  // The browser starts fetching during HTML parse, so a fast 404 resolves
  // before React hydrates and ever attaches onError — the event is then lost.
  // Inspect the settled node on mount so that ordering degrades correctly too.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) handleFailure();
  }, [handleFailure]);

  if (isLast && lastFailed) {
    return <span className={cn('clout-wordmark', fallbackClassName)}>{SHOP_BRAND}</span>;
  }

  return (
    // Plain <img>, matching ApiProductSection: next/image optimisation is
    // disabled for the desktop static export anyway.
    <img
      ref={imgRef}
      src={LOGO_SOURCES[index]}
      alt={alt}
      onError={handleFailure}
      className={cn('clout-logo', className)}
    />
  );
}