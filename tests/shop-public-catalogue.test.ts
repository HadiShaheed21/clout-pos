/**
 * Phase 1 public ecommerce catalogue API tests.
 *
 * Uses a disposable temporary database only. Verifies eligibility filtering,
 * field allowlisting, price correctness, coarse availability, image gating,
 * pagination, input validation, rate limiting, and — critically — that
 * authentication is still enforced on every pre-existing private API.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shop-public-catalogue.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shop-public-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-shop-public';
process.env.FLO_SHOP_RATE_LIMIT_MAX = '25';

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const { shopRoutes, isPublicShopPath } = require('../main/routes/shop');
const { productRoutes } = require('../main/routes/products');
const { catalogueRoutes } = require('../main/routes/catalogue');
const { orderRoutes } = require('../main/routes/orders');

const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function seedFixtures(db: any) {
  seedCategory(db, 'cat-pub', 'Clothing');
  seedProduct(db, 'pub-basic', 'cat-pub', 'Published Tee', 1499, { track_inventory: true, stock_quantity: 20 });
  db.prepare("UPDATE products SET catalog_status='published', low_stock_threshold=3 WHERE id='pub-basic'").run();

  seedProduct(db, 'pub-draft', 'cat-pub', 'Draft Hoodie', 2499, { track_inventory: true, stock_quantity: 10 });
  seedProduct(db, 'pub-inactive', 'cat-pub', 'Inactive Cap', 899);
  db.prepare("UPDATE products SET catalog_status='published', is_active=0 WHERE id='pub-inactive'").run();
  seedProduct(db, 'pub-deleted', 'cat-pub', 'Deleted Scarf', 699);
  db.prepare("UPDATE products SET catalog_status='published', deleted_at=? WHERE id='pub-deleted'").run(now());
  seedProduct(db, 'pub-badprice', 'cat-pub', 'Bad Price Tee', 10);
  db.prepare("UPDATE products SET catalog_status='published', price=10.005 WHERE id='pub-badprice'").run();
  seedProduct(db, 'pub-soldout', 'cat-pub', 'Sold Out Vest', 1999, { track_inventory: true, stock_quantity: 0 });
  db.prepare("UPDATE products SET catalog_status='published' WHERE id='pub-soldout'").run();
  seedProduct(db, 'pub-low', 'cat-pub', 'Low Stock Socks', 499, { track_inventory: true, stock_quantity: 2, low_stock_threshold: 3 });
  db.prepare("UPDATE products SET catalog_status='published' WHERE id='pub-low'").run();

  seedProduct(db, 'pub-variants', 'cat-pub', 'Variant Jacket', 3000, { track_inventory: true, stock_quantity: 0 });
  db.prepare("UPDATE products SET catalog_status='published', variant_mode=1 WHERE id='pub-variants'").run();
  db.prepare("INSERT INTO product_option_groups (id, product_id, name, normalized_name, sort_order) VALUES ('og-pub','pub-variants','Size','size',0)").run();
  db.prepare("INSERT INTO product_option_values (id, option_group_id, label, normalized_label, sort_order) VALUES ('ov-pub','og-pub','M','m',0)").run();
  const addVariant = (id, sig, label, price, stock, active) => db.prepare(
    `INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, is_active, track_inventory, low_stock_threshold)
     VALUES (?, 'pub-variants', ?, ?, ?, ?, ?, 1, 1)`,
  ).run(id, sig, label, price, stock, active);
  addVariant('v-pub-1', 'size=m', 'M', 0, 4, 1);
  addVariant('v-pub-2', 'size=l', 'L', 3500, 2, 1);
  addVariant('v-pub-off', 'size=xl', 'XL', 100, 9, 0);
  for (const vid of ['v-pub-1', 'v-pub-2', 'v-pub-off']) {
    db.prepare("INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?, 'og-pub', 'ov-pub')").run(vid);
  }

  db.prepare("INSERT INTO collections (id, name, slug, sort_order, is_active) VALUES ('col-1','Essentials','essentials',0,1)").run();
  db.prepare("INSERT INTO collection_products (collection_id, product_id, sort_order) VALUES ('col-1','pub-basic',0)").run();
  db.prepare(`INSERT INTO product_images (id, product_id, data_uri, mime_type, byte_size, alt_text, sort_order, is_primary)
    VALUES ('img-pub','pub-basic',?,'image/png',70,'Tee front',0,1)`).run(PNG_URI);
  db.prepare(`INSERT INTO product_images (id, product_id, data_uri, mime_type, byte_size, alt_text, sort_order, is_primary)
    VALUES ('img-draft','pub-draft',?,'image/png',70,'Hoodie front',0,1)`).run(PNG_URI);
}

async function main() {
  console.log('Phase 1 public catalogue API tests');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedFixtures(db);

  const app = createApp({
    '/api/shop': shopRoutes,
    '/api/products': productRoutes,
    '/api/catalogue': catalogueRoutes,
    '/api/orders': orderRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n--- A: eligibility filtering ---');
    {
      const res = await api(baseUrl, '/api/shop/products?limit=60');
      const ids = res.data.products.map((p) => p.id);
      assert(ids.includes('pub-basic'), 'A: published product is listed');
      assert(!ids.includes('pub-draft'), 'A: draft product NOT listed');
      assert(!ids.includes('pub-inactive'), 'A: inactive product NOT listed');
      assert(!ids.includes('pub-deleted'), 'A: soft-deleted product NOT listed');
      assert(!ids.includes('pub-badprice'), 'A: unrepresentable price withheld');
      assert(ids.includes('pub-soldout'), 'A: published sold-out product still listed');
    }

    console.log('\n--- B: field allowlist — no internal data leaks ---');
    {
      const res = await api(baseUrl, '/api/shop/products?limit=60');
      const product = res.data.products.find((p) => p.id === 'pub-basic');
      assert(!('cost' in product), 'B: cost absent');
      assert(!('sku' in product), 'B: sku absent');
      assert(!('barcode' in product), 'B: barcode absent');
      assert(!('stock_quantity' in product), 'B: stock_quantity absent');
      assert(!('low_stock_threshold' in product), 'B: low_stock_threshold absent');
      assert(!('deleted_at' in product), 'B: deleted_at absent');
      assert(!JSON.stringify(product).includes('cost'), 'B: no "cost" token anywhere in payload');
      assertEqual(product.currency, 'INR', 'B: currency published');
      assertEqual(product.price_minor_units, 149900, 'B: price is integer paise');
    }

    console.log('\n--- C: coarse availability, never exact counts ---');
    {
      const res = await api(baseUrl, '/api/shop/products?limit=60');
      const byId = Object.fromEntries(res.data.products.map((p) => [p.id, p]));
      assertEqual(byId['pub-basic'].availability, 'in_stock', 'C: well-stocked in_stock');
      assertEqual(byId['pub-low'].availability, 'low_stock', 'C: at threshold low_stock');
      assertEqual(byId['pub-soldout'].availability, 'out_of_stock', 'C: zero stock out_of_stock');
      // The payload above is the real proof: no exact quantity, only a bucket.
      const payload = JSON.stringify(byId['pub-basic']);
      assert(!payload.includes('"stock'), 'C: no stock key in payload');
      assert(!payload.includes('"20"'), 'C: exact quantity 20 not published');
      assert(!payload.includes('threshold'), 'C: low_stock_threshold not published');
    }

    console.log('\n--- D: variants, overrides and inactive variants ---');
    {
      const res = await api(baseUrl, '/api/shop/products/pub-variants');
      const product = res.data.product;
      assertEqual(res.status, 200, 'D: variant product detail loads');
      const ids = product.variants.map((v) => v.id);
      assert(ids.includes('v-pub-1') && ids.includes('v-pub-2'), 'D: active variants present');
      assert(!ids.includes('v-pub-off'), 'D: inactive variant excluded');
      const zero = product.variants.find((v) => v.id === 'v-pub-1');
      const override = product.variants.find((v) => v.id === 'v-pub-2');
      assertEqual(zero.price_minor_units, 0, 'D: zero price_override published as 0');
      assertEqual(override.price_minor_units, 350000, 'D: non-zero override published');
      assertEqual(product.price_minor_units, 0, 'D: lowest price reflects zero override');
      assertEqual(product.variants[0].options[0].name, 'Size', 'D: option group name published');
      assertEqual(product.variants[0].options[0].value, 'M', 'D: option value published');
    }

    console.log('\n--- E: hidden products and images are unreachable ---');
    {
      assertEqual((await api(baseUrl, '/api/shop/products/pub-draft')).status, 404, 'E: draft product 404');
      assertEqual((await api(baseUrl, '/api/shop/products/pub-inactive')).status, 404, 'E: inactive product 404');
      assertEqual((await api(baseUrl, '/api/shop/products/pub-deleted')).status, 404, 'E: deleted product 404');
      assertEqual((await api(baseUrl, '/api/shop/products/pub-badprice')).status, 404, 'E: invalid-price product 404');
      const unknown = await api(baseUrl, '/api/shop/products/does-not-exist');
      const hidden = await api(baseUrl, '/api/shop/products/pub-draft');
      assertEqual(hidden.data.error, unknown.data.error, 'E: hidden and unknown return identical errors');
    }

    console.log('\n--- F: public image access + unpublished image gating ---');
    {
      const ok = await fetch(`${baseUrl}/api/shop/images/img-pub`);
      const bytes = Buffer.from(await ok.arrayBuffer());
      assertEqual(ok.status, 200, 'F: image of a published product is served');
      assertEqual(ok.headers.get('content-type'), 'image/png', 'F: signature-derived content type');
      assertEqual(ok.headers.get('x-content-type-options'), 'nosniff', 'F: nosniff set');
      assertEqual(bytes.length > 0, true, 'F: non-empty image bytes');
      assertEqual((await fetch(`${baseUrl}/api/shop/images/img-draft`)).status, 404, 'F: image of a DRAFT product is 404');
      assertEqual((await fetch(`${baseUrl}/api/shop/images/img-nope`)).status, 404, 'F: unknown image 404');
    }

    console.log('\n--- G: collections ---');
    {
      const res = await api(baseUrl, '/api/shop/collections');
      assertEqual(res.status, 200, 'G: collections list loads');
      assert(res.data.collections.some((c) => c.slug === 'essentials'), 'G: active collection published');
      assert(!('id' in res.data.collections[0]), 'G: internal collection id not published');
    }

    console.log('\n--- H: pagination + strict input validation ---');
    {
      const page = await api(baseUrl, '/api/shop/products?limit=2&offset=0');
      assertEqual(page.data.products.length, 2, 'H: limit honoured');
      assertEqual(page.data.pagination.limit, 2, 'H: limit echoed');
      assert(page.data.pagination.total >= 2, 'H: total reported');
      assertEqual(typeof page.data.pagination.has_more, 'boolean', 'H: has_more reported');
      assertEqual((await api(baseUrl, '/api/shop/products?limit=0')).status, 400, 'H: limit=0 rejected');
      assertEqual((await api(baseUrl, '/api/shop/products?limit=abc')).status, 400, 'H: non-numeric limit rejected');
      assertEqual((await api(baseUrl, '/api/shop/products?limit=9999')).status, 400, 'H: oversized limit rejected');
      assertEqual((await api(baseUrl, '/api/shop/products?offset=-1')).status, 400, 'H: negative offset rejected');
      assertEqual((await api(baseUrl, '/api/shop/products?offset=1.5')).status, 400, 'H: fractional offset rejected');
    }

    console.log('\n--- I: anonymous rate limiting ---');
    {
      let limited = 0;
      for (let i = 0; i < 40; i += 1) {
        const res = await fetch(`${baseUrl}/api/shop/products?limit=1`);
        if (res.status === 429) { limited += 1; }
      }
      assert(limited > 0, 'I: anonymous requests are eventually rate limited');
    }

    console.log('\n--- J: authentication still enforced on private APIs ---');
    {
      assertEqual((await api(baseUrl, '/api/products')).status, 401, 'J: GET /api/products still 401 anonymous');
      assertEqual((await api(baseUrl, '/api/catalogue/products/pub-basic')).status, 401, 'J: catalogue detail still 401');
      assertEqual((await api(baseUrl, '/api/catalogue/collections')).status, 401, 'J: catalogue collections still 401');
      assertEqual((await api(baseUrl, '/api/orders')).status, 401, 'J: GET /api/orders still 401');
      assertEqual((await api(baseUrl, '/api/products', { method: 'POST', body: { name: 'x', price: 1 } })).status, 401, 'J: anonymous product create still 401');
      assertEqual((await api(baseUrl, '/api/shop/products')).status < 500, true, 'J: public list still serves (rate limit aside)');
    }

    console.log('\n--- K: bypass predicate is narrowly scoped ---');
    {
      assertEqual(isPublicShopPath('/api/shop/products', 'GET'), true, 'K: public GET allowed');
      assertEqual(isPublicShopPath('/api/shop/products/x', 'GET'), true, 'K: public subpath GET allowed');
      assertEqual(isPublicShopPath('/api/shop/products', 'POST'), false, 'K: POST never bypasses');
      assertEqual(isPublicShopPath('/api/shop/products', 'DELETE'), false, 'K: DELETE never bypasses');
      assertEqual(isPublicShopPath('/api/products', 'GET'), false, 'K: /api/products does not bypass');
      assertEqual(isPublicShopPath('/api/orders', 'GET'), false, 'K: /api/orders does not bypass');
      assertEqual(isPublicShopPath('/api/shopadmin/products', 'GET'), false, 'K: near-miss prefix does not bypass');
      assertEqual(isPublicShopPath('/api/shop/admin/products', 'GET'), false, 'K: admin-looking path does not bypass');
    }

    console.log('\n--- L: authenticated admin still sees everything ---');
    {
      const res = await api(baseUrl, '/api/products', { headers: authHeader });
      assertEqual(res.status, 200, 'L: owner still reads the private catalogue');
      assert(res.data.products.length >= 7, 'L: private list includes unpublished rows');
    }

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`${results.passed}/${results.total} passed, ${results.failed} failed`);
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
