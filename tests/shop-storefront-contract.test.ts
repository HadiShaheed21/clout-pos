/**
 * Phase 2 storefront contract tests.
 *
 * The `/shop` UI fetches from `/api/shop/*` at runtime. These tests pin the
 * exact contract `frontend/src/lib/shop/catalogue-client.ts` and `api-types.ts`
 * depend on: URL paths, query parameter names, response shape, pagination
 * envelope, availability values, image URL format, and the error codes the UI
 * branches on. If the backend drifts, the storefront breaks silently.
 *
 * Also covers storefront-facing edge states: missing images, variant products,
 * unpublished/404 handling, malformed input, and read-only enforcement.
 *
 * Disposable temporary database only.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shop-storefront-contract.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shop-ph2-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-shop-ph2';
process.env.FLO_SHOP_RATE_LIMIT_MAX = '200';

const {
  initTestDb, createApp, startServer, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { shopRoutes } = require('../main/routes/shop');
const { productRoutes } = require('../main/routes/products');

const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Mirrors the shopper-visible availability union in api-types.ts. */
const AVAILABILITY_VALUES = ['in_stock', 'low_stock', 'out_of_stock'];

function seedStorefrontFixtures(db: any) {
  seedCategory(db, 'cat-ph2', 'Clothing');

  const publish = (id: string) =>
    db.prepare("UPDATE products SET catalog_status = 'published' WHERE id = ?").run(id);

  // Published, primary image, no variant rows (single-variant product).
  seedProduct(db, 'ph2-basic', 'cat-ph2', 'Basic Tee', 1499, { track_inventory: true, stock_quantity: 20 });
  db.prepare('UPDATE products SET cost = ? WHERE id = ?').run(400, 'ph2-basic');
  publish('ph2-basic');
  db.prepare('INSERT INTO product_images (id, product_id, data_uri, is_primary, sort_order, alt_text) VALUES (?,?,?,?,?,?)')
    .run('img-basic', 'ph2-basic', PNG_URI, 1, 0, 'Basic tee front');
  db.prepare('INSERT INTO product_images (id, product_id, data_uri, is_primary, sort_order, alt_text) VALUES (?,?,?,?,?,?)')
    .run('img-basic-2', 'ph2-basic', PNG_URI, 0, 1, 'Basic tee back');

  // Published variant product: one price override, one inherited, one sold out.
  seedProduct(db, 'ph2-variant', 'cat-ph2', 'Rigid Denim', 3200, { track_inventory: true, stock_quantity: 0 });
  db.prepare('UPDATE products SET cost = ?, variant_mode = 1 WHERE id = ?').run(1200, 'ph2-variant');
  publish('ph2-variant');
  db.prepare('INSERT INTO product_option_groups (id, product_id, name, normalized_name, sort_order) VALUES (?,?,?,?,?)')
    .run('og-colour', 'ph2-variant', 'Colour', 'colour', 0);
  db.prepare('INSERT INTO product_option_values (id, option_group_id, label, normalized_label, color_hex, sort_order, is_active) VALUES (?,?,?,?,?,?,?)')
    .run('ov-navy', 'og-colour', 'Navy', 'navy', '#1B3156', 0, 1);
  db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)')
    .run('var-navy-m', 'ph2-variant', 'navy|m', 'Navy / M', 3499, 5, 1, 1);
  db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)')
    .run('var-navy-l', 'ph2-variant', 'navy|l', 'Navy / L', null, 2, 1, 1);
  db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)')
    .run('var-navy-xl', 'ph2-variant', 'navy|xl', 'Navy / XL', null, 0, 1, 1);
  db.prepare('INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?,?,?)')
    .run('var-navy-m', 'og-colour', 'ov-navy');

  // Published and sold out.
  seedProduct(db, 'ph2-soldout', 'cat-ph2', 'Archive Tee', 990, { track_inventory: true, stock_quantity: 0 });
  db.prepare('UPDATE products SET cost = ? WHERE id = ?').run(200, 'ph2-soldout');
  publish('ph2-soldout');

  // Published with no images -> storefront renders its "No image" tile.
  seedProduct(db, 'ph2-noimage', 'cat-ph2', 'Plain Cap', 799, { track_inventory: true, stock_quantity: 7 });
  db.prepare('UPDATE products SET cost = ? WHERE id = ?').run(150, 'ph2-noimage');
  publish('ph2-noimage');

  // Ineligible: draft, unpublished, inactive, soft-deleted.
  seedProduct(db, 'ph2-draft', 'cat-ph2', 'Draft Piece', 500, { stock_quantity: 5 });
  seedProduct(db, 'ph2-unpub', 'cat-ph2', 'Unpublished Piece', 500, { stock_quantity: 5 });
  publish('ph2-unpub');
  db.prepare("UPDATE products SET catalog_status = 'unpublished' WHERE id = ?").run('ph2-unpub');

  seedProduct(db, 'ph2-inactive', 'cat-ph2', 'Inactive Piece', 500, { stock_quantity: 5 });
  publish('ph2-inactive');
  db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run('ph2-inactive');

  seedProduct(db, 'ph2-deleted', 'cat-ph2', 'Deleted Piece', 500, { stock_quantity: 5 });
  publish('ph2-deleted');
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), 'ph2-deleted');

  db.prepare('INSERT INTO collections (id, slug, name, description, is_active) VALUES (?,?,?,?,?)')
    .run('col-ph2', 'new-arrivals', 'New Arrivals', 'The newest run.', 1);
  db.prepare('INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order) VALUES (?,?,?)')
    .run('col-ph2', 'ph2-basic', 0);
}

async function main() {
  const db = initTestDb();
  let server: any;
  let baseUrl = '';

  try {
    seedStorefrontFixtures(db);

    // createApp mounts routes itself and mirrors the production auth bypass.
    const app = createApp({
      '/api/shop': shopRoutes,
      '/api/products': productRoutes,
    });
    const started = await startServer(app);
    baseUrl = started.baseUrl;
    server = started.server;

    console.log('\n--- A: list matches the storefront client contract ---');
    {
      const res = await api(baseUrl, '/api/shop/products?limit=24&offset=0');
      assertEqual(res.status, 200, 'A: list returns 200');
      assert(Array.isArray(res.data.products), 'A: products is an array');
      const page = res.data.pagination;
      assert(page && typeof page.limit === 'number' && typeof page.offset === 'number'
        && typeof page.total === 'number' && typeof page.has_more === 'boolean',
        'A: pagination envelope has limit/offset/total/has_more');

      // Exactly the fields api-types.ts declares — nothing more, nothing less.
      const product = res.data.products.find((p: any) => p.id === 'ph2-basic');
      assert(product, 'A: published product present in list');
      assertEqual(JSON.stringify(Object.keys(product).sort()), JSON.stringify([
        'availability', 'category', 'collection', 'compare_at_minor_units', 'currency',
        'description', 'id', 'images', 'is_variant_product', 'name', 'price_minor_units', 'variants',
      ]), 'A: product exposes exactly the allowlisted storefront fields');

      const json = JSON.stringify(res.data);
      for (const forbidden of ['cost', 'stock_quantity', 'low_stock_threshold', 'sku', 'barcode']) {
        assert(!json.includes(forbidden), 'A: list must not expose ' + forbidden);
      }
    }

    console.log('\n--- B: only published + active + undeleted products are listed ---');
    {
      const res = await api(baseUrl, '/api/shop/products?limit=60');
      const ids = res.data.products.map((p: any) => p.id);
      assert(ids.includes('ph2-basic'), 'B: published product listed');
      assert(ids.includes('ph2-noimage'), 'B: published product without images listed');
      for (const hidden of ['ph2-draft', 'ph2-unpub', 'ph2-inactive', 'ph2-deleted']) {
        assert(!ids.includes(hidden), 'B: ' + hidden + ' must not be listed');
      }
    }

    console.log('\n--- C: variant shape, price override and option labels ---');
    {
      const res = await api(baseUrl, '/api/shop/products/ph2-variant');
      assertEqual(res.status, 200, 'C: variant product detail 200');
      const product = res.data.product;
      assertEqual(product.is_variant_product, true, 'C: is_variant_product true');
      assertEqual(product.variants.length, 3, 'C: all active variants returned');

      const override = product.variants.find((v: any) => v.id === 'var-navy-m');
      assertEqual(override.price_minor_units, 349900, 'C: price_override 3499.00 -> 349900');
      const inherited = product.variants.find((v: any) => v.id === 'var-navy-l');
      assertEqual(inherited.price_minor_units, 320000, 'C: no override inherits product price');
      assertEqual(product.price_minor_units, 320000, 'C: product price is lowest sellable variant price');

      // Option labels + colour hex drive the storefront swatch renderer.
      assertEqual(override.options.length, 1, 'C: variant carries its option labels');
      assertEqual(override.options[0].name, 'Colour', 'C: option group name returned');
      assertEqual(override.options[0].value, 'Navy', 'C: option value returned');
      assertEqual(override.options[0].color_hex, '#1B3156', 'C: colour hex returned for swatches');

      for (const forbidden of ['cost', 'stock_quantity', 'sku', 'barcode']) {
        assert(!JSON.stringify(product).includes(forbidden), 'C: must not expose ' + forbidden);
      }
    }

    console.log('\n--- D: coarse availability, never exact counts ---');
    {
      const soldOut = (await api(baseUrl, '/api/shop/products/ph2-soldout')).data.product;
      assertEqual(soldOut.availability, 'out_of_stock', 'D: zero stock -> out_of_stock');

      const basic = (await api(baseUrl, '/api/shop/products/ph2-basic')).data.product;
      assert(AVAILABILITY_VALUES.includes(basic.availability), 'D: availability is a known enum value');

      const denim = (await api(baseUrl, '/api/shop/products/ph2-variant')).data.product;
      const xl = denim.variants.find((v: any) => v.id === 'var-navy-xl');
      assertEqual(xl.availability, 'out_of_stock', 'D: zero-stock variant -> out_of_stock');
      const m = denim.variants.find((v: any) => v.id === 'var-navy-m');
      assert(AVAILABILITY_VALUES.includes(m.availability), 'D: stocked variant has coarse availability');
    }

    console.log('\n--- E: image metadata + public image endpoint ---');
    {
      const basic = (await api(baseUrl, '/api/shop/products/ph2-basic')).data.product;
      assertEqual(basic.images.length, 2, 'E: both images returned');
      const primary = basic.images.find((img: any) => img.is_primary);
      assert(primary, 'E: primary image present');
      assertEqual(primary.url, '/api/shop/images/img-basic', 'E: image url is a relative public endpoint');
      assertEqual(basic.images[0].sort_order, 0, 'E: images ordered by sort_order');
      assert(!JSON.stringify(basic).includes('data_uri'), 'E: data_uri never returned in metadata');

      const imgRes = await fetch(baseUrl + primary.url);
      assertEqual(imgRes.status, 200, 'E: public image endpoint serves anonymously');
      assertEqual(imgRes.headers.get('content-type'), 'image/png', 'E: image served as image/png');
      assertEqual(imgRes.headers.get('x-content-type-options'), 'nosniff', 'E: image served with nosniff');

      const noImage = (await api(baseUrl, '/api/shop/products/ph2-noimage')).data.product;
      assertEqual(JSON.stringify(noImage.images), '[]', 'E: product with no images returns empty array');
    }

    console.log('\n--- F: unpublished + unknown products are indistinguishable ---');
    {
      const draft = await api(baseUrl, '/api/shop/products/ph2-draft');
      const unknown = await api(baseUrl, '/api/shop/products/does-not-exist');
      assertEqual(draft.status, 404, 'F: draft product 404');
      assertEqual(unknown.status, 404, 'F: unknown product 404');
      assertEqual(JSON.stringify(draft.data), JSON.stringify(unknown.data),
        'F: draft and unknown return byte-identical errors (no existence leak)');

      for (const id of ['ph2-unpub', 'ph2-inactive', 'ph2-deleted']) {
        assertEqual((await api(baseUrl, '/api/shop/products/' + id)).status, 404, 'F: ' + id + ' 404');
      }
    }

    console.log('\n--- G: images of ineligible products are not publicly reachable ---');
    {
      seedProduct(db, 'ph2-img-draft', 'cat-ph2', 'Draft With Image', 500, { stock_quantity: 5 });
      db.prepare('INSERT INTO product_images (id, product_id, data_uri, is_primary, sort_order, alt_text) VALUES (?,?,?,?,?,?)')
        .run('img-draft', 'ph2-img-draft', PNG_URI, 1, 0, 'Draft');

      assertEqual((await fetch(baseUrl + '/api/shop/images/img-draft')).status, 404,
        'G: draft product image 404');
      assertEqual((await fetch(baseUrl + '/api/shop/images/img-basic')).status, 200,
        'G: published product image 200');
      assertEqual((await fetch(baseUrl + '/api/shop/images/nope')).status, 404,
        'G: unknown image 404');
    }

    console.log('\n--- H: collections contract ---');
    {
      const res = await api(baseUrl, '/api/shop/collections');
      assertEqual(res.status, 200, 'H: collections 200');
      assert(Array.isArray(res.data.collections), 'H: collections is an array');
      assertEqual(JSON.stringify(Object.keys(res.data.collections[0]).sort()),
        JSON.stringify(['description', 'name', 'slug']),
        'H: collection exposes exactly slug/name/description');

      const basic = (await api(baseUrl, '/api/shop/products/ph2-basic')).data.product;
      assertEqual(basic.collection.slug, 'new-arrivals', 'H: product exposes its collection slug');

      const cap = (await api(baseUrl, '/api/shop/products/ph2-noimage')).data.product;
      assertEqual(JSON.stringify(cap.collection), 'null', 'H: product without collection -> null');
    }

    console.log('\n--- I: pagination behaves as the storefront loop expects ---');
    {
      const first = await api(baseUrl, '/api/shop/products?limit=2&offset=0');
      assertEqual(first.data.products.length, 2, 'I: first page honours limit');
      assertEqual(first.data.pagination.has_more, true, 'I: has_more true when more remain');
      assertEqual(first.data.pagination.total, 4, 'I: total counts published products only');

      const lastOffset = first.data.pagination.total - 2;
      const second = await api(baseUrl, '/api/shop/products?limit=2&offset=' + lastOffset);
      assertEqual(second.data.pagination.has_more, false, 'I: has_more false on final page');

      const past = await api(baseUrl, '/api/shop/products?limit=2&offset=999');
      assertEqual(past.data.products.length, 0, 'I: offset past the end returns empty page');
      assertEqual(past.data.pagination.has_more, false, 'I: empty page terminates the loop');
    }

    console.log('\n--- J: malformed input rejected, not silently coerced ---');
    {
      for (const query of ['limit=abc', 'limit=-1', 'limit=0', 'limit=1.5', 'offset=-1', 'limit=99999']) {
        assertEqual((await api(baseUrl, '/api/shop/products?' + query)).status, 400,
          'J: ?' + query + ' rejected with 400');
      }
      // Hostile ids must never yield a 500 or leak a stack trace. The SPA fallback
// serves HTML for unknown paths, so read the raw response instead of JSON.
      for (const badId of ['..', '%2e%2e', 'a%27b', "x'%20OR%201=1--", 'a%22b', '../../etc/passwd']) {
        const res = await fetch(baseUrl + '/api/shop/products/' + badId);
        const body = await res.text();
        assert(res.status < 500, 'J: hostile id ' + badId + ' must not 500 (got ' + res.status + ')');
        assert(!/SQLITE_|at Object\.|node_modules/.test(body),
          'J: hostile id ' + badId + ' leaks no internals');
      }
    }

    console.log('\n--- K: storefront surfaces are read-only for anonymous callers ---');
    {
      const attempts: [string, string][] = [
        ['POST', '/api/shop/products'], ['PUT', '/api/shop/products/ph2-basic'],
        ['PATCH', '/api/shop/products/ph2-basic'], ['DELETE', '/api/shop/products/ph2-basic'],
        ['POST', '/api/shop/collections'],
      ];
      for (const [method, p] of attempts) {
        const res = await api(baseUrl, p, { method, body: { name: 'hacked', price: 1 } });
        assert(res.status === 404 || res.status === 401 || res.status === 405,
          'K: anonymous ' + method + ' ' + p + ' refused (' + res.status + ')');
      }
      const row = db.prepare('SELECT name, price FROM products WHERE id = ?').get('ph2-basic') as any;
      assertEqual(row.name, 'Basic Tee', 'K: product name unchanged after write attempts');
      assertEqual(row.price, 1499, 'K: product price unchanged after write attempts');
    }

    console.log('\n--- L: POS private catalogue still requires authentication ---');
    {
      assertEqual((await api(baseUrl, '/api/products')).status, 401, 'L: /api/products still 401 anonymously');
      assertEqual((await api(baseUrl, '/api/catalogue/products/ph2-basic')).status, 401,
        'L: ownerManager catalogue still 401 anonymously');
    }
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(results.passed + '/' + results.total + ' passed, ' + results.failed + ' failed');
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
