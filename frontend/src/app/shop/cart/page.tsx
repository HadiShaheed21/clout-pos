import type { Metadata } from 'next';
import { ShopCartView } from '@/components/shop/ShopCartView';

export const metadata: Metadata = {
  title: 'Your bag',
  robots: { index: false, follow: true },
};

export default function ShopCartPage() {
  return <ShopCartView />;
}

