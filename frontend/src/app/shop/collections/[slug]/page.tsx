import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiCollectionProducts } from '@/components/shop/ApiCollections';

/**
 * Collection slugs live in the POS database and cannot be enumerated at build
 * time, so a single prerendered shell is emitted and the client resolves the
 * slug against the public API at runtime.
 */
export function generateStaticParams() {
  return [{ slug: 'collection' }];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: 'Collection',
    description: `Browse the ${slug.replace(/-/g, ' ')} collection from CLOUT.`,
  };
}

export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!slug) notFound();
  const label = slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="clout-eyebrow">
      <ol className="flex items-center gap-2">
        <li><Link href="/shop" className="hover:text-[#101010]">Home</Link></li>
        <li aria-hidden>/</li>
        <li><Link href="/shop/collections" className="hover:text-[#101010]">Collections</Link></li>
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
          <p className="mt-5 max-w-lg text-base leading-relaxed text-[#4a4a4a]">
            Pieces published to this collection in the POS catalogue.
          </p>
        </div>
      </header>

      <section className="mx-auto max-w-[1440px] px-5 py-16 sm:px-8">
        <ApiCollectionProducts slug={slug} />
      </section>
    </>
  );
}
