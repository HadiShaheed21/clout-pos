import { MapPin } from 'lucide-react';
import Link from 'next/link';
import { SHOP_ADDRESS, SHOP_BRAND } from '@/lib/shop/mock-catalogue';
import { CloutWordmark } from '@/components/shop/CloutWordmark';

const FOOTER_GROUPS = [
  {
    title: 'Shop',
    links: [
      { href: '/shop/c/men', label: 'Men' },
      { href: '/shop/collections', label: 'Collections' },
    ],
  },
  {
    title: 'Help',
    links: [
      { href: '/shop', label: 'Shipping' },
      { href: '/shop', label: 'Returns' },
      { href: '/shop', label: 'Size guide' },
      { href: '/shop', label: 'Contact' },
    ],
  },
];

export function ShopFooter() {
  return (
    <footer className="mt-24 border-t clout-rule">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-14 sm:px-8 md:grid-cols-4">
        <div className="md:col-span-2">
          <CloutWordmark className="h-10" fallbackClassName="text-lg" alt={`${SHOP_BRAND} logo`} />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-[#6b6b6b]">
            A Kerala label making heavyweight staples, Japanese denim and occasion pieces
            in small, deliberate runs. Designed to be worn until they wear out.
          </p>
          {/* <address> is flow content, so it cannot sit inside the <p> above. */}
          <address className="mt-6 flex max-w-sm items-start gap-2 text-sm not-italic leading-relaxed text-[#6b6b6b]">
            <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden />
            <span>{SHOP_ADDRESS}</span>
          </address>
        </div>

        {FOOTER_GROUPS.map((group) => (
          <nav key={group.title} aria-label={group.title}>
            <h2 className="clout-eyebrow">{group.title}</h2>
            <ul className="mt-4 space-y-3">
              {group.links.map((link) => (
                <li key={`${group.title}-${link.label}`}>
                  <Link href={link.href} className="clout-link text-sm text-[#6b6b6b] hover:text-[#101010]">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="border-t clout-rule">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-2 px-5 py-6 text-xs text-[#6b6b6b] sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>© {new Date().getFullYear()} {SHOP_BRAND}. All rights reserved.</p>
          {/* Clearly marked so prototype status is never mistaken for a real site. */}
          <p className="clout-eyebrow">Design prototype — not a live store</p>
        </div>
      </div>
    </footer>
  );
}
