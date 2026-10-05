import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { slugToLabel } from '@/lib/shop/format';
import { ApiProductSection } from '@/components/shop/ApiProductSection';

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  men: 'Heavyweight cotton, washed denim, and workwear cuts built on the same blocks season after season.',
  women: 'Bias cuts, structured tailoring, and denim in rigid Japanese cloth.',
  kids: 'Organic cotton and reinforced seams, cut so small people can actually run in it.',
  new: 'The most recent run across every collection, cut in small batches.',
};

/**
 * Category segments are a fixed business vocabulary rather than database rows,
 * so they can be prerendered for the desktop static export. Product listings
 * inside each segment are fetched from the API at runtime.
 */
export function generateStaticParams() {
  return Object.keys(CATEGORY_DESCRIPTIONS).map((category) => ({ category }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  const label = category === 'new' ? 'New Arrivals' : slugToLabel(category);
  return {
    title: `${label} — Shop`,
    description: CATEGORY_DESCRIPTIONS[category] ?? `Shop the ${label} range from CLOUT.`,
  };
}

export default async function CategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  if (!(category in CATEGORY_DESCRIPTIONS)) notFound();

  const label = category === 'new' ? 'New Arrivals' : slugToLabel(category);
  const description = CATEGORY_DESCRIPTIONS[category];

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="clout-eyebrow">
      <ol className="flex items-center gap-2">
        <li><Link href="/shop" className="hover:text-[#101010]">Home</Link></li>
        <li aria-hidden>/</li>
        <li aria-current="page" className="text-[#101010]">{label}</li>
      </ol>
    </nav>
  );

  return (
    <>
      <header className="border-b clout-rule">
        <div className="mx-auto max-w-[1440px] px-5 py-14 sm:px-8 lg:py-20">
          {breadcrumb}
          <h1 className="clout-display mt-5 text-[clamp(2.25rem,6vw,4.5rem)]">{label}</h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-[#4a4a4a]">{description}</p>
        </div>
      </header>

      <section className="mx-auto max-w-[1440px] px-5 py-16 sm:px-8">
        <ApiProductSection
          filter="category"
          category={category}
          emptyTitle="Nothing here yet"
          emptyDetail="Publish a product in the POS under this category and it will appear here."
        />
      </section>
    </>
  );
}
