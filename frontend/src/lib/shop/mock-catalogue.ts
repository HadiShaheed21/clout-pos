/**
 * ============================================================================
 *  PROTOTYPE MOCK DATA — NOT REAL PRODUCTS, STOCK OR PRICES.
 * ============================================================================
 * Hand-written sample content for the CLOUT website design prototype. It is
 * deliberately isolated from the POS: nothing here is read from or written to
 * the SQLite catalogue, `stock_movements`, or any API route.
 *
 * Variant shape intentionally matches the POS `ProductVariant` contract
 * (`sku`, `barcode`, `stock_quantity`, `is_active`, `options[]`) so a later
 * integration swaps this module for an API client without reshaping the UI.
 * Stock numbers are invented and carry no relationship to real inventory.
 */

import type { ShopCollection, ShopOptionValue, ShopProduct, ShopVariant } from './types';

export const SHOP_BRAND = 'CLOUT';

export const SHOP_ADDRESS = 'Khalifa Masjid, Big Bazaar Rd, Mananchira, Kozhikode, Keralam 673001';

export const COLOURS = {
  black: { label: 'Black', colorHex: '#141414' },
  offWhite: { label: 'Off White', colorHex: '#EFEAE0' },
  sand: { label: 'Sand', colorHex: '#D8C4A0' },
  navy: { label: 'Navy', colorHex: '#1B3156' },
  olive: { label: 'Olive', colorHex: '#65724C' },
  indigo: { label: 'Indigo', colorHex: '#274C77' },
  charcoal: { label: 'Charcoal', colorHex: '#475569' },
  rose: { label: 'Rose', colorHex: '#E999B3' },
  lilac: { label: 'Lilac', colorHex: '#B9A2DD' },
  sunshine: { label: 'Sunshine', colorHex: '#F7C948' },
  sky: { label: 'Sky', colorHex: '#5EB3E5' },
  rust: { label: 'Rust', colorHex: '#A4552D' },
} as const satisfies Record<string, ShopOptionValue>;

export type ColourKey = keyof typeof COLOURS;

interface VariantSeed {
  colour: ColourKey;
  /** Size label to invented stock count. A `0` renders as sold out. */
  stock: Record<string, number>;
}

/** Builds the variant rows for one product deterministically from compact seeds. */
function buildVariants(productId: string, skuBase: string, priceRupees: number, seeds: VariantSeed[]): ShopVariant[] {
  const variants: ShopVariant[] = [];
  let index = 0;
  for (const seed of seeds) {
    const colour = COLOURS[seed.colour];
    for (const [size, stock] of Object.entries(seed.stock)) {
      index += 1;
      const sku = `${skuBase}-${seed.colour.toUpperCase()}-${size}`;
      variants.push({
        id: `${productId}-v${index}`,
        product_id: productId,
        display_name: `${colour.label} / ${size}`,
        sku,
        barcode: `8901000${String(index).padStart(4, '0')}`,
        priceRupees,
        stock_quantity: stock,
        is_active: true,
        options: [
          { label: colour.label, colorHex: colour.colorHex },
          { label: size, colorHex: null },
        ],
      });
    }
  }
  return variants;
}

interface ProductSeed {
  id: string;
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  details: string[];
  category: ShopProduct['category'];
  collection: string;
  price: number;
  compareAt?: number;
  badge?: ShopProduct['badge'];
  editorial: { tone: string; accent: string };
  variants: VariantSeed[];
}

const PRODUCT_SEEDS: ProductSeed[] = [
  {
    id: 'p-01', slug: 'heavyweight-box-tee', name: 'Heavyweight Box Tee',
    subtitle: '240 GSM combed cotton',
    description: 'A structured everyday tee cut with a squared hem and a dropped shoulder. Washed twice for a soft hand that holds its shape wash after wash.',
    details: ['240 GSM combed cotton', 'Boxy unisex fit', 'Pre-shrunk, garment washed', 'Machine wash cold'],
    category: 'men', collection: 'essentials', price: 1499, compareAt: 1899, badge: 'Best Seller',
    editorial: { tone: '#1B3156', accent: '#0B1A31' },
    variants: [
      { colour: 'black', stock: { S: 8, M: 12, L: 9, XL: 5, XXL: 2 } },
      { colour: 'offWhite', stock: { S: 4, M: 7, L: 6, XL: 3, XXL: 0 } },
      { colour: 'olive', stock: { S: 3, M: 5, L: 4, XL: 2, XXL: 1 } },
    ],
  },
  {
    id: 'p-02', slug: 'linen-resort-shirt', name: 'Linen Resort Shirt',
    subtitle: 'Washed European linen',
    description: 'An open-collar resort shirt in midweight linen. Breathable, softly creased, and cut to sit easy over a tee or bare.',
    details: ['100% European linen', 'Camp collar, relaxed drape', 'Corozo buttons', 'Cold wash, line dry'],
    category: 'men', collection: 'summer-edit', price: 3299,
    editorial: { tone: '#D8C4A0', accent: '#B79A6F' },
    variants: [
      { colour: 'sand', stock: { S: 6, M: 9, L: 7, XL: 4 } },
      { colour: 'offWhite', stock: { S: 5, M: 6, L: 4, XL: 3 } },
      { colour: 'olive', stock: { S: 2, M: 3, L: 2, XL: 1 } },
    ],
  },
  {
    id: 'p-03', slug: 'straight-leg-denim', name: 'Straight Leg Denim',
    subtitle: '13.5 oz rigid Japanese denim',
    description: 'A straight rise with a true leg, woven on vintage shuttle looms. Rigid at first, then it moulds to you.',
    details: ['13.5 oz Japanese denim', 'Button fly', 'Mid rise, straight leg', 'Wash inside out'],
    category: 'women', collection: 'denim-studio', price: 4499, badge: 'New',
    editorial: { tone: '#274C77', accent: '#12294A' },
    variants: [
      { colour: 'indigo', stock: { '26': 4, '28': 7, '30': 8, '32': 5, '34': 2 } },
      { colour: 'black', stock: { '26': 2, '28': 4, '30': 5, '32': 3, '34': 1 } },
    ],
  },
  {
    id: 'p-04', slug: 'bias-cut-midi-dress', name: 'Bias Cut Midi Dress',
    subtitle: 'Sand-washed satin',
    description: 'Cut on the bias so it moves with you, with a cowl back and an adjustable tie. An occasion dress without the stiffness.',
    details: ['Sand-washed satin', 'Bias cut, cowl back', 'Adjustable waist tie', 'Dry clean recommended'],
    category: 'women', collection: 'occasion', price: 5999,
    editorial: { tone: '#E999B3', accent: '#C2738F' },
    variants: [
      { colour: 'rose', stock: { S: 5, M: 9, L: 6, XL: 3 } },
      { colour: 'lilac', stock: { S: 4, M: 6, L: 5, XL: 2 } },
      { colour: 'black', stock: { S: 3, M: 4, L: 3, XL: 2 } },
    ],
  },
  {
    id: 'p-05', slug: 'tailored-wide-leg-trouser', name: 'Tailored Wide Leg Trouser',
    subtitle: 'Wool-blend suiting',
    description: 'A high, clean waistband falling into a full wide leg. Pressed creases, functional pockets, and enough room to actually sit down.',
    details: ['Wool-blend suiting', 'High rise, wide leg', 'Concealed hook closure', 'Dry clean only'],
    category: 'women', collection: 'work-edit', price: 4799,
    editorial: { tone: '#475569', accent: '#28364A' },
    variants: [
      { colour: 'charcoal', stock: { '26': 3, '28': 6, '30': 7, '32': 4, '34': 2 } },
      { colour: 'offWhite', stock: { '26': 2, '28': 4, '30': 4, '32': 3, '34': 1 } },
    ],
  },
  {
    id: 'p-06', slug: 'cropped-hoodie', name: 'Cropped Heavy Hoodie',
    subtitle: '480 GSM brushed fleece',
    description: 'A cropped, boxy hoodie in dense brushed fleece with a double-layer hood that actually stays up.',
    details: ['480 GSM brushed fleece', 'Boxy cropped fit', 'Double-layer hood', 'Wash cold, dry flat'],
    category: 'women', collection: 'essentials', price: 3499, compareAt: 4299,
    editorial: { tone: '#8C6A5D', accent: '#5E443A' },
    variants: [
      { colour: 'sand', stock: { S: 6, M: 8, L: 6, XL: 3 } },
      { colour: 'black', stock: { S: 5, M: 7, L: 5, XL: 4 } },
    ],
  },
  {
    id: 'p-07', slug: 'utility-chore-jacket', name: 'Utility Chore Jacket',
    subtitle: 'Cotton moleskin',
    description: 'A workwear classic reworked with three external pockets, bar-tacked stress points, and a softened hand.',
    details: ['Cotton moleskin', 'Relaxed fit', 'Bar-tacked stress points', 'Machine wash cold'],
    category: 'men', collection: 'essentials', price: 5499, badge: 'Limited',
    editorial: { tone: '#A4552D', accent: '#6E3419' },
    variants: [
      { colour: 'rust', stock: { S: 4, M: 6, L: 5, XL: 2 } },
      { colour: 'olive', stock: { S: 3, M: 5, L: 3, XL: 2 } },
      { colour: 'navy', stock: { S: 2, M: 3, L: 3, XL: 1 } },
    ],
  },
  {
    id: 'p-08', slug: 'pleated-midi-skirt', name: 'Pleated Midi Skirt',
    subtitle: 'Recycled georgette',
    description: 'Knife pleats set into a structured waistband, cut to mid-calf with a lining that stays opaque in motion.',
    details: ['Recycled georgette', 'Knife-pleated', 'Opaque lined', 'Hand wash cold'],
    category: 'women', collection: 'occasion', price: 3899,
    editorial: { tone: '#B9A2DD', accent: '#8A72B5' },
    variants: [
      { colour: 'lilac', stock: { S: 4, M: 6, L: 5, XL: 3 } },
      { colour: 'black', stock: { S: 3, M: 5, L: 4, XL: 2 } },
    ],
  },
  {
    id: 'p-09', slug: 'graphic-crew-tee', name: 'Graphic Crew Tee',
    subtitle: 'Soft-hand print',
    description: 'A midweight crew with a water-based print that stays soft against the skin instead of cracking.',
    details: ['180 GSM cotton jersey', 'Water-based print', 'Regular fit', 'Wash inside out'],
    category: 'kids', collection: 'play', price: 899,
    editorial: { tone: '#F7C948', accent: '#D9A41F' },
    variants: [
      { colour: 'sunshine', stock: { '4-5Y': 6, '6-7Y': 10, '8-9Y': 7, '10-11Y': 3 } },
      { colour: 'sky', stock: { '4-5Y': 5, '6-7Y': 7, '8-9Y': 5, '10-11Y': 2 } },
    ],
  },
  {
    id: 'p-10', slug: 'play-set-two-piece', name: 'Play Set Two-Piece',
    subtitle: 'Organic cotton jersey',
    description: 'A matching tee and short set in soft organic jersey, cut so kids can actually run in it.',
    details: ['Organic cotton jersey', 'Tee + short set', 'Elastic waistband', 'Machine wash warm'],
    category: 'kids', collection: 'play', price: 1499,
    editorial: { tone: '#5EB3E5', accent: '#2F82B5' },
    variants: [
      { colour: 'sky', stock: { '4-5Y': 5, '6-7Y': 6, '8-9Y': 4 } },
      { colour: 'sunshine', stock: { '4-5Y': 4, '6-7Y': 5, '8-9Y': 3 } },
    ],
  },
  {
    id: 'p-11', slug: 'pleated-tennis-skirt', name: 'Pleated Tennis Skirt',
    subtitle: 'Performance twill',
    description: 'A sporty A-line skirt in quick-dry twill with built-in shorts and a grippy hem.',
    details: ['Quick-dry twill', 'Built-in shorts', 'Grippy hem', 'Machine wash cold'],
    category: 'women', collection: 'denim-studio', price: 2799,
    editorial: { tone: '#DDE3EA', accent: '#A9B6C6' },
    variants: [
      { colour: 'offWhite', stock: { S: 5, M: 7, L: 5, XL: 3 } },
      { colour: 'navy', stock: { S: 4, M: 6, L: 4, XL: 2 } },
    ],
  },
  {
    id: 'p-12', slug: 'oversized-graphic-tee', name: 'Oversized Graphic Tee',
    subtitle: 'Dropped shoulder',
    description: 'A deliberately oversized tee with a wide ribbed neck and dropped shoulders, printed with a single archival graphic.',
    details: ['220 GSM cotton', 'Oversized drop shoulder', 'Ribbed neck binding', 'Wash cold'],
    category: 'men', collection: 'summer-edit', price: 1799, badge: 'New',
    editorial: { tone: '#2F4B3F', accent: '#1A2F27' },
    variants: [
      { colour: 'olive', stock: { S: 9, M: 11, L: 10, XL: 6, XXL: 3 } },
      { colour: 'offWhite', stock: { S: 7, M: 9, L: 8, XL: 5, XXL: 2 } },
    ],
  },
];

/** Mock catalogue. Exported read-only so no screen can mutate the shared source. */
export const MOCK_PRODUCTS: readonly ShopProduct[] = PRODUCT_SEEDS.map((seed) => ({
  id: seed.id,
  slug: seed.slug,
  name: seed.name,
  subtitle: seed.subtitle,
  description: seed.description,
  details: seed.details,
  category: seed.category,
  collection_slug: seed.collection,
  priceRupees: seed.price,
  compareAtRupees: seed.compareAt ?? null,
  badge: seed.badge ?? null,
  editorial: seed.editorial,
  variants: buildVariants(seed.id, seed.slug.toUpperCase().slice(0, 10), seed.price, seed.variants),
}));
export const MOCK_COLLECTIONS: readonly ShopCollection[] = [
  {
    slug: 'essentials', name: 'Essentials',
    tagline: 'The permanent collection',
    story: 'Heavyweight cotton, dense fleece, and moleskin built to be worn every day for years. These are the pieces we restock and never retire.',
    editorial: { tone: '#1B3156', accent: '#0B1A31' },
  },
  {
    slug: 'summer-edit', name: 'Summer Edit',
    tagline: 'Linen, air, and long evenings',
    story: 'Breathable weaves and easy cuts for the hottest months, photographed in flat coastal light.',
    editorial: { tone: '#D8C4A0', accent: '#B79A6F' },
  },
  {
    slug: 'denim-studio', name: 'Denim Studio',
    tagline: 'Rigid, then personal',
    story: 'Japanese shuttle-loom denim cut into silhouettes that wear in rather than wear out.',
    editorial: { tone: '#274C77', accent: '#12294A' },
  },
  {
    slug: 'work-edit', name: 'Work Edit',
    tagline: 'Tailoring without the suit',
    story: 'Clean waistbands, pressed creases, and fabrics that read as considered rather than corporate.',
    editorial: { tone: '#475569', accent: '#28364A' },
  },
  {
    slug: 'occasion', name: 'Occasion',
    tagline: 'For the nights that matter',
    story: 'Bias cuts, soft satins, and silhouettes that photograph well in low light.',
    editorial: { tone: '#E999B3', accent: '#C2738F' },
  },
  {
    slug: 'play', name: 'Play',
    tagline: 'Built for small people',
    story: 'Soft organic cotton, reinforced seams, and cuts that survive the playground.',
    editorial: { tone: '#F7C948', accent: '#D9A41F' },
  },
];

export const SHOP_CATEGORIES = ['men', 'women', 'kids'] as const;

export function getProductBySlug(slug: string): ShopProduct | null {
  return MOCK_PRODUCTS.find((product) => product.slug === slug) ?? null;
}

export function getCollectionBySlug(slug: string): ShopCollection | null {
  return MOCK_COLLECTIONS.find((collection) => collection.slug === slug) ?? null;
}

export function getProductsByCollection(slug: string): ShopProduct[] {
  return MOCK_PRODUCTS.filter((product) => product.collection_slug === slug);
}

export function getProductsByCategory(category: string): ShopProduct[] {
  return MOCK_PRODUCTS.filter((product) => product.category === category);
}

/** Cheapest in-stock price, so listing tiles can show a "from" price. */
export function startingPrice(product: ShopProduct): number {
  const inStock = product.variants.filter((variant) => variant.is_active && variant.stock_quantity > 0);
  const prices = (inStock.length ? inStock : product.variants).map((variant) => variant.priceRupees);
  return prices.length ? Math.min(...prices) : product.priceRupees;
}

export function isSoldOutProduct(product: ShopProduct): boolean {
  return !product.variants.some((variant) => variant.is_active && variant.stock_quantity > 0);
}
