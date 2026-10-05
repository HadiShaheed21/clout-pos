'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu, ShoppingBag, X } from 'lucide-react';
import { SHOP_BRAND } from '@/lib/shop/mock-catalogue';
import { CloutWordmark } from '@/components/shop/CloutWordmark';
import { useShopCartStore } from '@/store/shop-cart-store';

const NAV_LINKS = [
  { href: '/shop/c/men', label: 'Men' },
  { href: '/shop/c/women', label: 'Women' },
  { href: '/shop/c/kids', label: 'Kids' },
  { href: '/shop/collections', label: 'Collections' },
];

export function ShopHeader() {
  const pathname = usePathname();
  const itemCount = useShopCartStore((state) => state.cart.item_count);
  const openDrawer = useShopCartStore((state) => state.openDrawer);
  const [menuOpen, setMenuOpen] = useState(false);

  // Derived from the subscribed line list so the badge updates on every change.

  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-50 border-b clout-rule bg-[#FAFAF8]/95 backdrop-blur supports-[backdrop-filter]:bg-[#FAFAF8]/80">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-5 sm:px-8">
        <button
          type="button"
          onClick={() => { setMenuOpen((open) => !open); }}
          aria-expanded={menuOpen}
          aria-controls="shop-mobile-nav"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          className="-ms-2 flex size-11 items-center justify-center lg:hidden"
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>

        <Link href="/shop" className="shrink-0" aria-label={`${SHOP_BRAND} home`}>
          <CloutWordmark className="h-7 sm:h-8" fallbackClassName="text-base sm:text-lg" />
        </Link>

        <nav aria-label="Primary" className="ms-6 hidden items-center gap-7 lg:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? 'page' : undefined}
              className="clout-link text-sm font-medium"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-1">
          <button
            type="button"
            onClick={openDrawer}
            className="relative flex size-11 items-center justify-center"
            aria-label={`Open cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`}
          >
            <ShoppingBag size={19} />
            {itemCount > 0 && (
              <span
                aria-hidden
                className="absolute end-1 top-1 min-w-4 rounded-full bg-[#101010] px-1 text-[10px] font-semibold leading-4 text-white"
              >
                {itemCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav
          id="shop-mobile-nav"
          aria-label="Primary mobile"
          className="border-t clout-rule bg-[#FAFAF8] lg:hidden"
        >
          <ul className="mx-auto max-w-[1440px] px-5 py-2 sm:px-8">
            {NAV_LINKS.map((link) => (
              <li key={link.href} className="border-b clout-rule last:border-0">
                <Link
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={isActive(link.href) ? 'page' : undefined}
                  className="flex min-h-13 items-center text-base font-medium"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}
