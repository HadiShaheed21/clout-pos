'use client';

/**
 * Website prototype cart.
 *
 * Intentionally a SEPARATE store from `@/store/cart`: the POS cart carries
 * add-ons, order types, held orders, table assignment and checkout/PIN
 * semantics, none of which belong to a customer storefront. Coupling the two
 * would let a website change leak into POS checkout behaviour.
 *
 * PROTOTYPE ONLY — state lives in memory for the tab session and is never sent
 * to the POS, an API, or any backend. A real implementation persists to the
 * server and validates stock and price server-side at checkout.
 */

import { create } from 'zustand';
import type { CartLine, ShopVariant } from '@/lib/shop/types';

interface ShopCartState {
  lines: CartLine[];
  /** Whether the cart drawer is open; surfaced to assistive tech as a dialog. */
  isDrawerOpen: boolean;
  addLine: (input: {
    productSlug: string;
    name: string;
    variant: ShopVariant;
    quantity: number;
  }) => void;
  setQuantity: (key: string, quantity: number) => void;
  removeLine: (key: string) => void;
  clear: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
}

/** Product slug + variant id keeps distinct colourways/sizes on separate lines. */
export function lineKey(productSlug: string, variantId: string): string {
  return `${productSlug}::${variantId}`;
}

export const useShopCart = create<ShopCartState>((set) => ({
  lines: [],
  isDrawerOpen: false,

  addLine: ({ productSlug, name, variant, quantity }) => {
    const key = lineKey(productSlug, variant.id);
    set((state) => {
      const existing = state.lines.find((line) => line.key === key);
      // Never let the prototype cart exceed the mock stock on a single line.
      const ceiling = Math.max(1, variant.stock_quantity);
      if (existing) {
        return {
          isDrawerOpen: true,
          lines: state.lines.map((line) => (line.key === key
            ? { ...line, quantity: Math.min(line.quantity + quantity, ceiling) }
            : line)),
        };
      }
      const colour = variant.options.find((option) => option.colorHex);
      const size = variant.options.find((option) => !option.colorHex);
      const line: CartLine = {
        key,
        productSlug,
        variantId: variant.id,
        name,
        variantLabel: variant.display_name,
        colourLabel: colour?.label ?? '',
        colorHex: colour?.colorHex ?? null,
        sizeLabel: size?.label ?? '',
        priceRupees: variant.priceRupees,
        quantity: Math.min(Math.max(1, quantity), ceiling),
        stockQuantity: variant.stock_quantity,
      };
      return { isDrawerOpen: true, lines: [...state.lines, line] };
    });
  },

  setQuantity: (key, quantity) => {
    set((state) => ({
      lines: state.lines.flatMap((line) => {
        if (line.key !== key) return [line];
        if (quantity <= 0) return [];
        return [{ ...line, quantity: Math.min(quantity, line.stockQuantity) }];
      }),
    }));
  },

  removeLine: (key) => set((state) => ({ lines: state.lines.filter((line) => line.key !== key) })),

  clear: () => set({ lines: [] }),

  openDrawer: () => set({ isDrawerOpen: true }),
  closeDrawer: () => set({ isDrawerOpen: false }),
}));
