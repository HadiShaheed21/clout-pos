import { cn } from '@/lib/utils';
import type { ShopEditorial } from '@/lib/shop/types';

/**
 * CSP-safe placeholder artwork for the storefront prototype.
 *
 * Renders generated CSS gradients rather than an <img>, because
 * `main/csp.ts` sets `img-src 'self' data:` and this prototype ships no binary
 * assets. Real integration should swap this for the product image endpoint.
 * Decorative by default; pass `alt` when the image carries the product name.
 */
export function PlaceholderImage({
  editorial,
  alt = '',
  seed,
  className,
  ratio = 'aspect-[4/5]',
  priorityLabel,
}: {
  editorial: ShopEditorial;
  alt?: string;
  seed?: string;
  className?: string;
  ratio?: string;
  priorityLabel?: boolean;
}) {
  return (
    <div
      className={cn('relative overflow-hidden clout-art', ratio, className)}
      style={{ '--art-tone': editorial.tone, '--art-accent': editorial.accent } as React.CSSProperties}
      role={alt ? 'img' : 'presentation'}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      data-seed={seed}
      data-priority={priorityLabel ? 'true' : undefined}
    >
      {/* Grain overlay comes from .clout-art::after in shop.css. */}
      <div className="absolute inset-x-0 bottom-0 p-4">
        <span className="clout-eyebrow text-white/70">{alt || 'CLOUT'}</span>
      </div>
    </div>
  );
}
