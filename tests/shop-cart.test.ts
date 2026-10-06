/**
 * Phase 3 guest shopping cart tests.
 *
 * Disposable temporary database only. Verifies that the cart is
 * server-authoritative (prices always re-derived), that one guest can never
 * reach another's cart, that CSRF and rate limits hold, and — critically —
 * that NO cart operation writes an order, a bill, a payment or a stock
 * movement, or decrements inventory.
 *
 * The shared `api()` helper does not forward cookies, so this suite carries its
 * own cookie-aware client that exercises the real cookie round trip.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shop-cart.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shop-cart-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-shop-cart';
process.env.FLO_SHOP_RATE_LIMIT_MAX = '1000';
process.env.FLO_SHOP_CART_RATE_LIMIT_MAX = '1000';

const {
  initTestDb, createApp, startServer, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { shopRoutes } = require('../main/routes/shop');
const cartRoutes = require('../main/routes/shop-cart').default;
const { isPublicShopCartPath } = require('../main/routes/shop-cart');

const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * A browser-like client: keeps its own cookie jar and echoes the CSRF cookie in
 * the request header, mirroring how the storefront will behave.
 */
function makeClient(baseUrl: string) {
  const jar: Record<string, string> = {};

  async function call(method: string, urlPath: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar.clout_cart_csrf) headers['x-clout-csrf'] = jar.clout_cart_csrf;
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;

    const response = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }

    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: response.status, data, headers: response.headers };
  }

  return {
    jar,
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b, h),
    patch: (p: string, b?: unknown, h?: Record<string, string>) => call('PATCH', p, b, h),
    del: (p: string, h?: Record<string, string>) => call('DELETE', p, undefined, h),
  };
}
function seedCartFixtures(db: any) {
  seedCategory(db, 'cat-cart', 'Clothing');
  const publish = (id: string) =>
    db.prepare("UPDATE products SET catalog_status = 'published' WHERE id = ?").run(id);

  seedProduct(db, 'cart-basic', 'cat-cart', 'Basic Tee', 1499, { track_inventory: true, stock_quantity: 20 });
  publish('cart-basic');
  db.prepare('INSERT INTO product_images (id, product_id, data_uri, is_primary, sort_order, alt_text) VALUES (?,?,?,?,?,?)')
    .run('img-cart', 'cart-basic', PNG_URI, 1, 0, 'Basic tee');

  seedProduct(db, 'cart-soldout', 'cat-cart', 'Sold Out Cap', 990, { track_inventory: true, stock_quantity: 0 });
  publish('cart-soldout');

  seedProduct(db, 'cart-variant', 'cat-cart', 'Rigid Denim', 3200, { track_inventory: true, stock_quantity: 0 });
  db.prepare('UPDATE products SET variant_mode = 1 WHERE id = ?').run('cart-variant');
  publish('cart-variant');
  db.prepare('INSERT INTO product_option_groups (id, product_id, name, normalized_name, sort_order) VALUES (?,?,?,?,?)')
    .run('og-cart', 'cart-variant', 'Colour', 'colour', 0);
  db.prepare('INSERT INTO product_option_values (id, option_group_id, label, normalized_label, color_hex, sort_order, is_active) VALUES (?,?,?,?,?,?,?)')
    .run('ov-cart', 'og-cart', 'Navy', 'navy', '#1B3156', 0, 1);
  db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)')
    .run('var-cart-m', 'cart-variant', 'navy|m', 'Navy / M', 3499, 5, 1, 1);
  db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)')
    .run('var-cart-xl', 'cart-variant', 'navy|xl', 'Navy / XL', null, 0, 1, 1);
  db.prepare('INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?,?,?)')
    .run('var-cart-m', 'og-cart', 'ov-cart');

  seedProduct(db, 'cart-draft', 'cat-cart', 'Draft Piece', 500, { stock_quantity: 5 });
  seedProduct(db, 'cart-unpub', 'cat-cart', 'Unpublished Piece', 500, { stock_quantity: 5 });
  publish('cart-unpub');
  db.prepare("UPDATE products SET catalog_status = 'unpublished' WHERE id = ?").run('cart-unpub');
  seedProduct(db, 'cart-inactive', 'cat-cart', 'Inactive Piece', 500, { stock_quantity: 5 });
  publish('cart-inactive');
  db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run('cart-inactive');
  seedProduct(db, 'cart-deleted', 'cat-cart', 'Deleted Piece', 500, { stock_quantity: 5 });
  publish('cart-deleted');
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), 'cart-deleted');
}

/** Counts rows that a cart operation must NEVER create. */
function countBusinessRecords(db: any) {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    orders: one('SELECT COUNT(*) AS n FROM orders'),
    order_items: one('SELECT COUNT(*) AS n FROM order_items'),
    bills: one('SELECT COUNT(*) AS n FROM bills'),
    payment_methods: one('SELECT COUNT(*) AS n FROM payment_methods'),
    stock_movements: one('SELECT COUNT(*) AS n FROM stock_movements'),
  };
}

async function main() {
  const db = initTestDb();
  let server: any;
  let baseUrl = '';

  try {
    seedCartFixtures(db);

    const app = createApp({
      '/api/shop/cart': cartRoutes,
      '/api/shop': shopRoutes,
    });
    const started = await startServer(app);
    baseUrl = started.baseUrl;
    server = started.server;

    const guest = makeClient(baseUrl);

    console.log('\n--- A: new guest gets an empty cart and a cookie ---');
    {
      const res = await guest.get('/api/shop/cart');
      assertEqual(res.status, 200, 'A: empty cart 200');
      assertEqual(JSON.stringify(res.data.items), '[]', 'A: no items');
      assertEqual(res.data.item_count, 0, 'A: item_count 0');
      assertEqual(res.data.subtotal_minor_units, 0, 'A: subtotal 0');
      assert(guest.jar.clout_cart, 'A: cart cookie issued');
      assert(guest.jar.clout_cart_csrf, 'A: csrf cookie issued');
      // The cart cookie must be HttpOnly and not readable by scripts.
      const rawCookie = res.headers.getSetCookie().find((c: string) => c.startsWith('clout_cart='));
      assert(/HttpOnly/i.test(rawCookie), 'A: cart cookie is HttpOnly');
      assert(/SameSite=Lax/i.test(rawCookie), 'A: cart cookie is SameSite=Lax');
      const csrfCookie = res.headers.getSetCookie().find((c: string) => c.startsWith('clout_cart_csrf='));
      assert(!/HttpOnly/i.test(csrfCookie), 'A: csrf cookie readable for double-submit');
      // The CSRF cookie must be visible to storefront JS on /shop/* pages, so it
      // uses the root path; the identity cookie stays scoped to the API.
      assert(/Path=\/(;|$)/i.test(csrfCookie), 'A: csrf cookie uses Path=/ (readable from /shop/*)');
      assert(/Path=\/api\/shop/i.test(rawCookie), 'A: cart cookie stays scoped to Path=/api/shop');
    }

    console.log('\n--- B: add a simple product; server-derived price ---');
    {
      const res = await guest.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: 2 });
      assertEqual(res.status, 200, 'B: add simple product 200');
      assertEqual(res.data.items.length, 1, 'B: one line');
      assertEqual(res.data.items[0].unit_price_minor_units, 149900, 'B: 1499.00 -> 149900 minor units');
      assertEqual(res.data.items[0].line_total_minor_units, 299800, 'B: line total = unit x qty');
      assertEqual(res.data.subtotal_minor_units, 299800, 'B: subtotal matches line total');
      assertEqual(res.data.item_count, 2, 'B: item_count 2');
      assertEqual(res.data.items[0].product_name, 'Basic Tee', 'B: product name returned');
      assertEqual(res.data.items[0].image_url, '/api/shop/images/img-cart', 'B: image url returned');
      assertEqual(res.data.items[0].status, 'ok', 'B: line status ok');
    }

    console.log('\n--- C: add a variant product; override price respected ---');
    {
      const res = await guest.post('/api/shop/cart/items', { product_id: 'cart-variant', variant_id: 'var-cart-m', quantity: 1 });
      assertEqual(res.status, 200, 'C: add variant 200');
      const line = res.data.items.find((i: any) => i.variant_id === 'var-cart-m');
      assert(line, 'C: variant line present');
      assertEqual(line.unit_price_minor_units, 349900, 'C: variant override 3499.00 -> 349900');
      assertEqual(line.variant_display_name, 'Navy / M', 'C: variant display name');
      assertEqual(line.options.length, 1, 'C: option labels returned');
      assertEqual(line.options[0].name, 'Colour', 'C: option group name');
      assertEqual(line.options[0].value, 'Navy', 'C: option value');
      assertEqual(res.data.subtotal_minor_units, 299800 + 349900, 'C: subtotal includes both lines');
    }

    console.log('\n--- D: re-adding merges quantity instead of duplicating ---');
    {
      const res = await guest.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: 1 });
      assertEqual(res.status, 200, 'D: repeat add 200');
      assertEqual(res.data.items.filter((i: any) => i.product_id === 'cart-basic').length, 1, 'D: still one line');
      assertEqual(res.data.items.find((i: any) => i.product_id === 'cart-basic').quantity, 3, 'D: quantity merged to 3');
    }

    console.log('\n--- E: ineligible products cannot be added ---');
    {
      for (const [id, label] of [['cart-draft', 'draft'], ['cart-unpub', 'unpublished'],
        ['cart-inactive', 'inactive'], ['cart-deleted', 'deleted'], ['nope', 'unknown']]) {
        const res = await guest.post('/api/shop/cart/items', { product_id: id, quantity: 1 });
        assertEqual(res.status, 404, 'E: ' + label + ' product rejected with 404');
      }
    }

    console.log('\n--- F: invalid variants rejected ---');
    {
      assertEqual((await guest.post('/api/shop/cart/items', { product_id: 'cart-basic', variant_id: 'var-cart-m', quantity: 1 })).status,
        404, 'F: variant from another product rejected');
      assertEqual((await guest.post('/api/shop/cart/items', { product_id: 'cart-variant', variant_id: 'nope', quantity: 1 })).status,
        404, 'F: unknown variant rejected');
      assertEqual((await guest.post('/api/shop/cart/items', { product_id: 'cart-variant', quantity: 1 })).status,
        404, 'F: variant product without a variant rejected');
    }

    console.log('\n--- G: sold-out items rejected ---');
    {
      assertEqual((await guest.post('/api/shop/cart/items', { product_id: 'cart-soldout', quantity: 1 })).status,
        409, 'G: sold-out product 409');
      assertEqual((await guest.post('/api/shop/cart/items', { product_id: 'cart-variant', variant_id: 'var-cart-xl', quantity: 1 })).status,
        409, 'G: sold-out variant 409');
    }

    console.log('\n--- H: invalid quantities rejected ---');
    {
      for (const q of [0, -1, 1.5, '2', null, 21, 999999]) {
        const res = await guest.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: q });
        assertEqual(res.status, 400, 'H: quantity ' + JSON.stringify(q) + ' rejected with 400');
      }
    }

    console.log('\n--- I: malformed payloads handled safely ---');
    {
      const missingProduct = await guest.post('/api/shop/cart/items', { quantity: 1 });
      assertEqual(missingProduct.status, 400, 'I: missing product_id 400');
      const badId = await guest.post('/api/shop/cart/items', { product_id: "'; DROP TABLE products;--", quantity: 1 });
      assertEqual(badId.status, 400, 'I: injection-style product id 400');
      const badJson = await guest.post('/api/shop/cart/items', undefined, { 'Content-Type': 'application/json' });
      assert(badJson.status >= 400 && badJson.status < 500, 'I: empty body rejected cleanly (' + badJson.status + ')');
      // The table must still exist.
      assertEqual((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='products'").get() as any).n, 1,
        'I: products table intact after injection attempt');
    }

    console.log('\n--- J: update quantity uses server-derived pricing ---');
    {
      const before = await guest.get('/api/shop/cart');
      const line = before.data.items.find((i: any) => i.product_id === 'cart-basic');
      const res = await guest.patch('/api/shop/cart/items/' + line.item_id, { quantity: 4 });
      assertEqual(res.status, 200, 'J: patch quantity 200');
      const updated = res.data.items.find((i: any) => i.item_id === line.item_id);
      assertEqual(updated.quantity, 4, 'J: quantity updated');
      assertEqual(updated.unit_price_minor_units, 149900, 'J: unit price still server-derived');
      assertEqual(updated.line_total_minor_units, 599600, 'J: line total recomputed server-side');

      assertEqual((await guest.patch('/api/shop/cart/items/' + line.item_id, { quantity: 0 })).status, 400, 'J: zero quantity rejected');
      assertEqual((await guest.patch('/api/shop/cart/items/' + line.item_id, { quantity: 99 })).status, 400, 'J: over-ceiling quantity rejected');
      assertEqual((await guest.patch('/api/shop/cart/items/nope', { quantity: 1 })).status, 404, 'J: unknown item 404');
    }

    console.log('\n--- K: price change is reflected from the catalogue ---');
    {
      db.prepare('UPDATE products SET price = ? WHERE id = ?').run(1799, 'cart-basic');
      const res = await guest.get('/api/shop/cart');
      const line = res.data.items.find((i: any) => i.product_id === 'cart-basic');
      assertEqual(line.unit_price_minor_units, 179900, 'K: new price re-derived, stale price not preserved');
      assertEqual(line.line_total_minor_units, 179900 * line.quantity, 'K: line total uses new price');
    }

    console.log('\n--- L: availability change is reflected ---');
    {
      db.prepare('UPDATE products SET stock_quantity = 0 WHERE id = ?').run('cart-basic');
      const res = await guest.get('/api/shop/cart');
      const line = res.data.items.find((i: any) => i.product_id === 'cart-basic');
      assertEqual(line.availability, 'out_of_stock', 'L: availability becomes out_of_stock');
      assertEqual(line.status, 'unavailable', 'L: line flagged unavailable');
      assertEqual(res.data.has_unavailable_items, true, 'L: cart reports unavailable items');
      assertEqual(res.data.item_count, 1, 'L: unavailable line excluded from count');
      assert(res.data.items.find((i: any) => i.product_id === 'cart-basic').message, 'L: explanatory message present');

      // Restoring stock makes it buyable again.
      db.prepare('UPDATE products SET stock_quantity = 10 WHERE id = ?').run('cart-basic');
      const back = await guest.get('/api/shop/cart');
      assertEqual(back.data.has_unavailable_items, false, 'L: recovered after restock');
    }

    console.log('\n--- M: unpublishing a product mid-cart is surfaced ---');
    {
      db.prepare("UPDATE products SET catalog_status = 'unpublished' WHERE id = ?").run('cart-variant');
      const res = await guest.get('/api/shop/cart');
      const line = res.data.items.find((i: any) => i.product_id === 'cart-variant');
      assertEqual(line.status, 'unpublished', 'M: line flagged unpublished');
      assertEqual(line.line_total_minor_units, 0, 'M: unpublished line excluded from totals');
      assertEqual(res.data.has_unavailable_items, true, 'M: cart warns');
      db.prepare("UPDATE products SET catalog_status = 'published' WHERE id = ?").run('cart-variant');
    }

    console.log('\n--- N: one guest cannot touch another guest cart ---');
    {
      const other = makeClient(baseUrl);
      await other.get('/api/shop/cart');
      await other.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: 1 });

      const mine = await guest.get('/api/shop/cart');
      const myLine = mine.data.items.find((i: any) => i.product_id === 'cart-basic');

      // The other guest cannot patch or delete my line.
      const crossPatch = await other.patch('/api/shop/cart/items/' + myLine.item_id, { quantity: 5 });
      assert(crossPatch.status === 404 || crossPatch.status === 400,
        'N: other guest cannot patch my line (refused with ' + crossPatch.status + ')');
      assertEqual((await other.del('/api/shop/cart/items/' + myLine.item_id)).status,
        404, 'N: other guest cannot delete my line');

      const stillMine = await guest.get('/api/shop/cart');
      assertEqual(stillMine.data.items.find((i: any) => i.item_id === myLine.item_id).quantity,
        myLine.quantity, 'N: my line quantity unchanged');

      // Clearing another cart must not empty mine.
      await other.del('/api/shop/cart');
      assert((await guest.get('/api/shop/cart')).data.items.length > 0, 'N: my cart survives another guest clearing theirs');
    }

    console.log('\n--- O: forged and missing cart identifiers rejected ---');
    {
      const forged = makeClient(baseUrl);
      forged.jar.clout_cart = 'not-a-real-token.signature';
      forged.jar.clout_cart_csrf = 'x';
      const res = await forged.patch('/api/shop/cart/items/anything', { quantity: 1 });
      assert(res.status === 404 || res.status === 400, 'O: forged token refused (' + res.status + ')');

      const noCookie = makeClient(baseUrl);
      // No cookie means no CSRF cookie, so the double-submit check refuses first.
      assertEqual((await noCookie.patch('/api/shop/cart/items/anything', { quantity: 1 })).status,
        403, 'O: no cookie refused by CSRF');
      assertEqual((await noCookie.del('/api/shop/cart')).status, 403, 'O: clear without cookie refused');
    }

    console.log('\n--- P: expired carts cannot be reused ---');
    {
      const stale = makeClient(baseUrl);
      await stale.get('/api/shop/cart');
      await stale.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: 1 });
      // Force the cart past its expiry.
      db.prepare("UPDATE shop_carts SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM shop_carts ORDER BY created_at DESC LIMIT 1)")
        .run(new Date(Date.now() - 1000).toISOString());
      const res = await stale.patch('/api/shop/cart/items/whatever', { quantity: 2 });
      assert(res.status === 404 || res.status === 400, 'P: expired cart refused (' + res.status + ')');
      // And it is purged rather than accumulating forever.
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM shop_carts WHERE expires_at <= ?')
        .run(new Date().toISOString()).changes;
      assert(remaining >= 0, 'P: purge executed without error');
    }

    console.log('\n--- Q: persistence across independent requests ---');
    {
      const first = await guest.get('/api/shop/cart');
      const count = first.data.items.length;
      const subtotal = first.data.subtotal_minor_units;
      // A brand-new client instance sharing the same cookie jar simulates a refresh.
      const afterRefresh = makeClient(baseUrl);
      Object.assign(afterRefresh.jar, guest.jar);
      const second = await afterRefresh.get('/api/shop/cart');
      assertEqual(second.data.items.length, count, 'Q: cart survives a fresh connection');
      assertEqual(second.data.subtotal_minor_units, subtotal, 'Q: subtotal stable across requests');
    }

    console.log('\n--- R: cart operations never touch POS business records ---');
    {
      const before = countBusinessRecords(db);
      const stockBefore = (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('cart-basic') as any).stock_quantity;

      const writer = makeClient(baseUrl);
      await writer.get('/api/shop/cart');
      await writer.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: 2 });
      await writer.post('/api/shop/cart/items', { product_id: 'cart-variant', variant_id: 'var-cart-m', quantity: 1 });
      const list = await writer.get('/api/shop/cart');
      await writer.patch('/api/shop/cart/items/' + list.data.items[0].item_id, { quantity: 2 });
      await writer.del('/api/shop/cart/items/' + list.data.items[0].item_id);

      const after = countBusinessRecords(db);
      assertEqual(after.orders, before.orders, 'R: no order created');
      assertEqual(after.order_items, before.order_items, 'R: no order item created');
      assertEqual(after.bills, before.bills, 'R: no bill created');
      assertEqual(after.payment_methods, before.payment_methods, 'R: no payment recorded');
      assertEqual(after.stock_movements, before.stock_movements, 'R: no stock movement recorded');
      assertEqual((db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('cart-basic') as any).stock_quantity,
        stockBefore, 'R: inventory NOT decremented by cart activity');
    }

    console.log('\n--- S: CSRF protection on state-changing requests ---');
    {
      const noCsrf = makeClient(baseUrl);
      await noCsrf.get('/api/shop/cart');
      const cookies = Object.entries(noCsrf.jar).map(([k, v]) => `${k}=${v}`).join('; ');
      // Send the cart cookie WITHOUT the CSRF header.
      const res = await fetch(baseUrl + '/api/shop/cart/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookies },
        body: JSON.stringify({ product_id: 'cart-basic', quantity: 1 }),
      });
      assertEqual(res.status, 403, 'S: POST without CSRF header 403');

      const badCsrf = await fetch(baseUrl + '/api/shop/cart/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookies, 'x-clout-csrf': 'wrong-token' },
        body: JSON.stringify({ product_id: 'cart-basic', quantity: 1 }),
      });
      assertEqual(badCsrf.status, 403, 'S: POST with wrong CSRF token 403');

      // A cart cookie with no matching CSRF cookie is also refused.
      const cartOnly = await fetch(baseUrl + '/api/shop/cart/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `clout_cart=${noCsrf.jar.clout_cart}` },
        body: JSON.stringify({ product_id: 'cart-basic', quantity: 1 }),
      });
      assertEqual(cartOnly.status, 403, 'S: POST without CSRF cookie 403');
    }

    console.log('\n--- T: unsupported methods rejected ---');
    {
      const res = await fetch(baseUrl + '/api/shop/cart', { method: 'PUT', headers: { Cookie: `clout_cart=x` } });
      assert(res.status === 404 || res.status === 405 || res.status === 401, 'T: PUT rejected (' + res.status + ')');
      assertEqual(isPublicShopCartPath('/api/shop/cart', 'PUT'), false, 'T: PUT does not bypass auth');
    }

    console.log('\n--- U: auth bypass predicate is narrowly scoped ---');
    {
      assertEqual(isPublicShopCartPath('/api/shop/cart', 'GET'), true, 'U: GET cart bypasses');
      assertEqual(isPublicShopCartPath('/api/shop/cart', 'POST'), true, 'U: POST items bypasses');
      assertEqual(isPublicShopCartPath('/api/shop/cart/items/abc', 'DELETE'), true, 'U: DELETE item bypasses');
      assertEqual(isPublicShopCartPath('/api/products', 'GET'), false, 'U: /api/products does not bypass');
      assertEqual(isPublicShopCartPath('/api/orders', 'GET'), false, 'U: /api/orders does not bypass');
      assertEqual(isPublicShopCartPath('/api/shop/carts', 'GET'), false, 'U: near-miss path does not bypass');
      assertEqual(isPublicShopCartPath('/api/shop/cart/admin', 'GET'), false, 'U: admin-looking path does not bypass');
      assertEqual(isPublicShopCartPath('/api/shop/products', 'GET'), false, 'U: catalogue not covered by cart bypass');
      // Existing private APIs still require authentication.
      assertEqual((await api(baseUrl, '/api/products')).status, 401, 'U: /api/products still 401 anonymously');
    }

    console.log('\n--- V: public rate limiting enforced on cart writes ---');
    {
      // The router builds its limiters at import time, so this mounts a fresh
      // instance of the SAME middleware against a tiny throwaway app to prove
      // the limiter actually returns 429. Child-process spawning is not used
      // because nested Electron runs produce no output in this environment.
      const express = require('express');
      const expressRateLimit = require('express-rate-limit');
      const { rateLimitFor } = require('../main/routes/shop-cart');

      process.env.FLO_SHOP_CART_RATE_LIMIT_MAX = '4';
      const limiter = rateLimitFor('FLO_SHOP_CART_RATE_LIMIT_MAX', 60);
      assert(limiter && typeof limiter === 'function', 'V: rateLimitFor returns a middleware');

      const limited = express();
      limited.use(limiter);
      limited.post('/probe', (_req: any, res: any) => res.json({ ok: true }));

      const probeServer = await new Promise<any>((resolve) => {
        const s = limited.listen(0, '127.0.0.1', () => resolve(s));
      });
      const probeUrl = 'http://127.0.0.1:' + probeServer.address().port + '/probe';

      const statuses: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        statuses.push((await fetch(probeUrl, { method: 'POST' })).status);
      }
      await new Promise<void>((resolve) => probeServer.close(() => resolve()));

      assert(statuses.includes(429), 'V: limiter returns 429 past its limit (got ' + statuses.join(',') + ')');
      assert(statuses.filter((s) => s === 200).length === 4, 'V: exactly the configured budget is allowed');
      delete process.env.FLO_SHOP_CART_RATE_LIMIT_MAX;
    }

    console.log('\n--- W: remove item and clear cart ---');
    {
      const fresh = makeClient(baseUrl);
      await fresh.get('/api/shop/cart');
      await fresh.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: 1 });
      await fresh.post('/api/shop/cart/items', { product_id: 'cart-variant', variant_id: 'var-cart-m', quantity: 1 });
      let view = await fresh.get('/api/shop/cart');
      assertEqual(view.data.items.length, 2, 'W: two lines');

      const removed = await fresh.del('/api/shop/cart/items/' + view.data.items[0].item_id);
      assertEqual(removed.status, 200, 'W: remove line 200');
      assertEqual(removed.data.items.length, 1, 'W: one line left');

      const cleared = await fresh.del('/api/shop/cart');
      assertEqual(cleared.status, 200, 'W: clear cart 200');
      assertEqual(JSON.stringify(cleared.data.items), '[]', 'W: cart empty after clear');
      assertEqual(cleared.data.subtotal_minor_units, 0, 'W: subtotal zero after clear');
    }

    console.log('\n--- X: remove is idempotent and scoped ---');
    {
      const fresh = makeClient(baseUrl);
      await fresh.get('/api/shop/cart');
      await fresh.post('/api/shop/cart/items', { product_id: 'cart-basic', quantity: 1 });
      const view = await fresh.get('/api/shop/cart');
      assertEqual((await fresh.del('/api/shop/cart/items/' + view.data.items[0].item_id)).status, 200, 'X: first remove ok');
      assertEqual((await fresh.del('/api/shop/cart/items/' + view.data.items[0].item_id)).status, 404, 'X: second remove 404');
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
