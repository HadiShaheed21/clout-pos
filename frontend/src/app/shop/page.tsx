import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ApiProductSection } from '@/components/shop/ApiProductSection';
import { ApiCollectionsIndex } from '@/components/shop/ApiCollections';
import { PlaceholderImage } from '@/components/shop/PlaceholderImage';

export const metadata: Metadata = {
  title: 'Streetwear, built to last',
  description: 'Heavyweight staples, Japanese denim and occasion pieces from CLOUT, made in small deliberate runs.',
};

const MARQUEE_ITEMS = [
  'Free shipping over ₹2,000',
  'Small, deliberate runs',
  'Made to be worn until they wear out',
  'Easy 7-day exchanges',
  'Designed in Kerala',
];

export default function ShopHomePage() {

  return (
    <>
      {/* Hero: full-bleed editorial statement with a single call to action. */}
      <section className="border-b clout-rule">
        <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-12 lg:gap-14 lg:py-24">
          <div className="lg:col-span-7">
            <p className="clout-eyebrow">Kerala, made in small runs</p>
            <h1 className="clout-display mt-6 text-[clamp(2.75rem,8vw,6rem)]">
              Built to
              <br />
              be worn out
            </h1>
            <p className="mt-7 max-w-xl text-base leading-relaxed text-[#4a4a4a] sm:text-lg">Heavyweight staples, Japanese denim and occasion pieces, cut in small deliberate runs and restocked for as long as the cloth lasts.</p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/shop/collections"
                className="inline-flex min-h-12 items-center gap-2 bg-[#101010] px-7 text-sm font-semibold text-white hover:bg-[#2a2a2a]"
              >
                Shop the catalogue
                <ArrowRight size={16} />
              </Link>
              <Link
                href="/shop/c/new"
                className="inline-flex min-h-12 items-center gap-2 border border-[#101010] px-7 text-sm font-semibold hover:bg-[#101010] hover:text-white"
              >
                New arrivals
              </Link>
            </div>
          </div>

          <div className="lg:col-span-5">
            <PlaceholderImage
              editorial={{ tone: '#1B3156', accent: '#0B1A31' }}
              alt="CLOUT editorial campaign artwork"
              seed="clout-hero"
              ratio="aspect-[4/5] lg:aspect-[3/4]"
            />
          </div>
        </div>
      </section>

      <MarqueeStrip />

      <section aria-labelledby="featured-heading" className="mx-auto max-w-[1440px] px-5 py-20 sm:px-8">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="clout-eyebrow">From the POS catalogue</p>
            <h2 id="featured-heading" className="clout-display mt-3 text-3xl sm:text-4xl">Latest pieces</h2>
          </div>
          <Link href="/shop/c/new" className="clout-link hidden shrink-0 text-sm font-medium sm:block">View all</Link>
        </div>

        <ApiProductSection
          headingId="featured-heading"
          filter="all"
          limit={8}
          emptyTitle="Nothing published yet"
          emptyDetail="Publish a product in the POS catalogue and it will appear here automatically."
        />
      </section>
      <section aria-labelledby="collections-heading" className="border-t clout-rule bg-[#F2F1EC]">
        <div className="mx-auto max-w-[1440px] px-5 py-20 sm:px-8">
          <p className="clout-eyebrow">Browse</p>
          <h2 id="collections-heading" className="clout-display mt-3 text-3xl sm:text-4xl">Collections</h2>

          <div className="mt-10">
            <ApiCollectionsIndex />
          </div>
        </div>
      </section>

      <section aria-labelledby="new-heading" className="mx-auto max-w-[1440px] px-5 py-20 sm:px-8">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="clout-eyebrow">Ready to ship</p>
            <h2 id="new-heading" className="clout-display mt-3 text-3xl sm:text-4xl">In stock now</h2>
          </div>
        </div>

        <ApiProductSection
          headingId="new-heading"
          filter="in_stock"
          limit={4}
          emptyTitle="Nothing in stock yet"
          emptyDetail="Receive stock through a purchase or adjustment in the POS to see it here."
        />
      </section>

      <section className="border-t clout-rule">
        <div className="mx-auto max-w-3xl px-5 py-24 text-center sm:px-8">
          <p className="clout-eyebrow">Our approach</p>
          <p className="clout-display mt-6 text-2xl leading-tight sm:text-4xl">
            Fewer pieces. Better cloth. Restocked forever.
          </p>
          <p className="mx-auto mt-7 max-w-xl text-base leading-relaxed text-[#4a4a4a]">
            We cut small runs so nothing is wasted, and we keep the same patterns in
            production for years — so the tee you bought last season still fits this one.
          </p>
          <Link href="/shop/collections" className="clout-link mt-8 inline-block text-sm font-semibold">
            See all collections
          </Link>
        </div>
      </section>
    </>
  );
}

function MarqueeStrip() {
  return (
    <div className="overflow-hidden border-b clout-rule bg-[#101010] py-3.5 text-white">
      <div className="clout-marquee-track" aria-hidden>
        {[0, 1].map((copy) => (
          <ul key={copy} className="flex shrink-0 items-center">
            {MARQUEE_ITEMS.map((item) => (
              <li key={`${copy}-${item}`} className="clout-eyebrow flex items-center gap-8 px-8 text-white/80">
                {item}
                <span aria-hidden className="text-white/40">✦</span>
              </li>
            ))}
          </ul>
        ))}
      </div>
      {/* Screen readers get the same facts once, statically. */}
      <p className="sr-only">{MARQUEE_ITEMS.join('. ')}.</p>
    </div>
  );
}
