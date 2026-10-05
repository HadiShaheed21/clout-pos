import Link from 'next/link';

export default function ShopNotFound() {
  return (
    <section className="mx-auto flex max-w-[1440px] flex-col items-center px-5 py-32 text-center sm:px-8">
      <p className="clout-eyebrow">Error 404</p>
      <h1 className="clout-display mt-5 text-[clamp(2.25rem,6vw,4.5rem)]">Page not found</h1>
      <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-[#4a4a4a]">
        That page has moved or never existed. The collections below are a better place to start.
      </p>
      <div className="mt-9 flex flex-wrap justify-center gap-3">
        <Link href="/shop" className="inline-flex min-h-12 items-center bg-[#101010] px-7 text-sm font-semibold text-white hover:bg-[#2a2a2a]">
          Back to home
        </Link>
        <Link href="/shop/collections" className="inline-flex min-h-12 items-center border border-[#101010] px-7 text-sm font-semibold hover:bg-[#101010] hover:text-white">
          Browse collections
        </Link>
      </div>
    </section>
  );
}
