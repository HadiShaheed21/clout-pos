'use client';

/**
 * Shared cart state for the storefront.
 *
 * The server is the source of truth; this store is a CACHE of the last
 * server response so the header badge and the cart page agree without each
 * refetching. Every mutation replaces state with the server's own response, so
 * the UI can never drift from what the backend actually holds.
 *
 * Deliberately separate from `@/store/cart` (POS) and from the Phase 1
 * prototype `shop-cart` store, which held mock data.
 */

import { create } from 'zustand';
import {
  EMPTY_CART, addToCart, clearCart, fetchCart, removeCartItem, setCartItemQuantity,
  type CartState,
} from '@/lib/shop/cart-client';

interface ShopCartStore {
  cart: CartState;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Item currently mutating, so only that row shows a spinner. */
  pendingItemId: string | null;
  addPending: boolean;
  drawerOpen: boolean;

  refresh: () => Promise<void>;
  add: (productId: string, variantId: string | null, quantity: number) => Promise<boolean>;
  setQuantity: (itemId: string, quantity: number) => Promise<boolean>;
  remove: (itemId: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
  openDrawer: () => void;
  closeDrawer: () => void;
}

function messageOf(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as Error).message || '');
    if (message) return message;
  }
  return fallback;
}

export const useShopCartStore = create<ShopCartStore>((set, get) => ({
  cart: EMPTY_CART,
  status: 'idle',
  error: null,
  pendingItemId: null,
  addPending: false,
  drawerOpen: false,

  async refresh() {
    try {
      const cart = await fetchCart();
      set({ cart, status: 'ready', error: null });
    } catch (error) {
      set({ status: 'error', error: messageOf(error, 'Unable to load your bag.') });
    }
  },

  async add(productId, variantId, quantity) {
    // Guard against double-submit from rapid clicks.
    if (get().addPending) return false;
    set({ addPending: true, error: null });
    try {
      const cart = await addToCart({ productId, variantId, quantity });
      set({ cart, status: 'ready', drawerOpen: true });
      return true;
    } catch (error) {
      set({ error: messageOf(error, 'Could not add that to your bag.') });
      return false;
    } finally {
      set({ addPending: false });
    }
  },

  async setQuantity(itemId, quantity) {
    if (get().pendingItemId) return false;
    set({ pendingItemId: itemId, error: null });
    try {
      const cart = await setCartItemQuantity(itemId, quantity);
      set({ cart, status: 'ready' });
      return true;
    } catch (error) {
      set({ error: messageOf(error, 'Could not update that item.') });
      // Resync so the UI reflects the server's real quantity.
      try { set({ cart: await fetchCart() }); } catch { /* keep last known state */ }
      return false;
    } finally {
      set({ pendingItemId: null });
    }
  },

  async remove(itemId) {
    if (get().pendingItemId) return false;
    set({ pendingItemId: itemId, error: null });
    try {
      const cart = await removeCartItem(itemId);
      set({ cart, status: 'ready' });
      return true;
    } catch (error) {
      set({ error: messageOf(error, 'Could not remove that item.') });
      return false;
    } finally {
      set({ pendingItemId: null });
    }
  },

  async clear() {
    if (get().pendingItemId) return false;
    set({ pendingItemId: 'all', error: null });
    try {
      const cart = await clearCart();
      set({ cart, status: 'ready' });
      return true;
    } catch (error) {
      set({ error: messageOf(error, 'Could not empty your bag.') });
      return false;
    } finally {
      set({ pendingItemId: null });
    }
  },

  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
}));