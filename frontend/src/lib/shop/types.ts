/**
 * Website prototype view models.
 *
 * These deliberately mirror the POS catalogue contract (`ProductVariant` in
 * `src/lib/types.ts`) so that replacing the mock source with a real API later
 * is a data-source change rather than a rewrite.
 *
 * PROTOTYPE ONLY: nothing in `src/lib/shop` is wired to the POS database,
 * inventory, or API. Money is held in whole rupees for display; the POS keeps
 * amounts in integer paise, so real integration must convert at the boundary.
 */

export type ShopCategory = 'men' | 'women' | 'kids';

/** Option dimensions are modelled generically so new groups need no schema change. */
export interface ShopOptionValue {
  /** Canonical option value, e.g. "Navy" or "M". */
  label: string;
  /** Hex used to paint colour swatches; null for non-colour options. */
  colorHex: string | null;
}

export interface ShopVariant {
  id: string;
  product_id: string;
  display_name: string;
  sku: string;
  barcode: string;
  priceRupees: number;
  stock_quantity: number;
  is_active: boolean;
  options: ShopOptionValue[];
}

export interface ShopEditorial {
  /** Base tone of the generated placeholder artwork. */
  tone: string;
  /** Secondary tone layered over the base for depth. */
  accent: string;
}

export interface ShopProduct {
  id: string;
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  /** Fabric/care bullets shown on the product detail page. */
  details: string[];
  category: ShopCategory;
  collection_slug: string;
  priceRupees: number;
  /** Strike-through reference price; null when the item is not discounted. */
  compareAtRupees: number | null;
  badge: 'New' | 'Best Seller' | 'Limited' | null;
  editorial: ShopEditorial;
  variants: ShopVariant[];
}

export interface ShopCollection {
  slug: string;
  name: string;
  tagline: string;
  story: string;
  editorial: ShopEditorial;
}

export interface CartLine {
  /** Product slug + variant id, so the same variant always collapses to one line. */
  key: string;
  productSlug: string;
  variantId: string;
  name: string;
  variantLabel: string;
  colourLabel: string;
  colorHex: string | null;
  sizeLabel: string;
  priceRupees: number;
  quantity: number;
  stockQuantity: number;
}

/** Options for one product, grouped in display order (Colour then Size). */
export interface VariantOptionGroup {
  name: string;
  values: ShopOptionValue[];
}

export function optionsForProduct(variants: ShopVariant[]): VariantOptionGroup[] {
  // Colour options carry a hex and render as swatches; everything else is a
  // plain label, which keeps the model generic if a third dimension is added.
  const ordered = new Map<string, ShopOptionValue[]>();
  for (const variant of variants) {
    if (!variant.is_active) continue;
    for (const option of variant.options) {
      const key = option.colorHex ? 'Colour' : 'Size';
      const list = ordered.get(key) ?? [];
      if (!list.some((value) => value.label === option.label)) list.push(option);
      ordered.set(key, list);
    }
  }
  return [...ordered.entries()].map(([name, values]) => ({ name, values }));
}

/** Finds the active variant matching an exact set of option labels. */
export function findVariant(variants: ShopVariant[], selection: Record<string, string>): ShopVariant | null {
  const match = variants.find((variant) => variant.is_active
    && Object.entries(selection).every(([, label]) => variant.options.some((option) => option.label === label)));
  return match ?? null;
}

export function isSoldOut(variant: ShopVariant | null): boolean {
  return !variant || variant.stock_quantity <= 0;
}

export function variantLabel(variant: ShopVariant): string {
  const colour = variant.options.find((option) => option.colorHex)?.label;
  const size = variant.options.find((option) => !option.colorHex)?.label;
  return [colour, size].filter(Boolean).join(' · ') || variant.sku;
}
