import type { Metadata } from 'next';
import { ApiProductDetail } from '@/components/shop/ApiProductDetail';

/**
 * Product ids live in the POS database and cannot be enumerated at build time,
 * so one prerendered shell is emitted and the client resolves the id against the
 * public API at runtime. `generateStaticParams` still returns a seed entry
 * because the desktop static export requires at least one path per dynamic
 * segment.
 */
export function generateStaticParams() {
  return [{ slug: 'product' }];
}

export const metadata: Metadata = {
  title: 'Product',
  description: 'A CLOUT piece published from the POS catalogue.',
};

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ApiProductDetail id={slug} />;
}
