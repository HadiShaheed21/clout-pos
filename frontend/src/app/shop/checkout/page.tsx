import type { Metadata } from 'next';
import { ShopCheckoutView } from '@/components/shop/ShopCheckoutView';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
};

export default function ShopCheckoutPage() {
  return <ShopCheckoutView />;
}
