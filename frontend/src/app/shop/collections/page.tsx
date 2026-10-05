import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiCollectionsIndex } from '@/components/shop/ApiCollections';

export const metadata: Metadata = {
  title: 'Collections',
  description: 'Browse CLOUT collections published from the POS catalogue.',
};

export default function CollectionsIndexPage() {
  return (
    <>
      <header className="border-b clout-rule">
        <div className="mx-auto max-w-[1440px] px-5 py-14 sm:px-8 lg:py-20">
          <nav aria-label="Breadcrumb" className="clout-eyebrow">
            <ol className="flex items-center gap-2">
              <li><Link href="/shop" className="hover:text-[#101010]">Home</Link></li>
              <li aria-hidden>/</li>
              <li aria-current="page" className="text-[#101010]">Collections</li>
            </ol>
          </nav>
          <h1 className="clout-display mt-5 text-[clamp(2.25rem,6vw,4.5rem)]">Collections</h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-[#4a4a4a]">
            Six edits, each cut in small runs and restocked for as long as the cloth lasts.
          </p>
        </div>
      </header>

      <section className="mx-auto max-w-[1440px] px-5 py-16 sm:px-8">
        <ApiCollectionsIndex />
      </section>
    </>
  );
}
