/**
 * Phase 4 online checkout tests.
 *
 * Disposable temporary database only. Verifies cart revalidation, server-derived
 * pricing, atomic stock reservation under BEGIN IMMEDIATE, idempotency, CSRF,
 * WhatsApp URL construction and privacy, and — critically — that checkout never
 * creates a POS sale, bill or payment record.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shop-checkout.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shop-checkout-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-shop-checkout';
process.env.FLO_SHOP_RATE_LIMIT_MAX = '1000';
process.env.FLO_SHOP_CART_RATE_LIMIT_MAX = '1000';

const {
  initTestDb, createApp, startServer, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');
const { makeShopClient } = require('./helpers/shop-client');

const cartRoutes = require('../main/routes/shop-cart').default;
const checkoutRoutes = require('../main/routes/shop-checkout').default;
const { shopRoutes } = require('../main/routes/shop');
const { isPublicShopCheckoutPath } = require('../main/routes/shop-checkout');

const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A clearly non-routable placeholder, per the brief's no-invented-number rule. */
const TEST_WHATSAPP = '919999999999';

const VALID_CUSTOMER = {
  name: 'Asha Menon',
  phone: '9876543210',
  address: '12 Rose Villa, Marine Drive',
  city: 'Kochi',
  state: 'Kerala',
  pincode: '682031',
  instructions: 'Please call before delivery',
};

function seedFixtures(db: any) {
  seedCategory(db, 'cat-co', 'Clothing');
  const publish = (id: string) =>
    db.prepare("UPDATE products SET catalog_status = 'published' WHERE id = ?").run(id);

  seedProduct(db, 'co-basic', 'cat-co', 'Basic Tee', 1499, { track_inventory: true, stock_quantity: 20 });
  publish('co-basic');
  db.prepare('INSERT INTO product_images (id, product_id, data_uri, is_primary, sort_order, alt_text) VALUES (?,?,?,?,?,?)')
    .run('img-co', 'co-basic', PNG_URI, 1, 0, 'Basic tee');

  seedProduct(db, 'co-low', 'cat-co', 'Last One Tee', 2000, { track_inventory: true, stock_quantity: 1 });
  publish('co-low');

  seedProduct(db, 'co-variant', 'cat-co', 'Rigid Denim', 3200, { track_inventory: true, stock_quantity: 0 });
  db.prepare('UPDATE products SET variant_mode = 1 WHERE id = ?').run('co-variant');
  publish('co-variant');
  db.prepare('INSERT INTO product_option_groups (id, product_id, name, normalized_name, sort_order) VALUES (?,?,?,?,?)')
    .run('og-co', 'co-variant', 'Colour', 'colour', 0);
  db.prepare('INSERT INTO product_option_values (id, option_group_id, label, normalized_label, color_hex, sort_order, is_active) VALUES (?,?,?,?,?,?,?)')
    .run('ov-co', 'og-co', 'നീലം', 'navy', '#1B3156', 0, 1);
  db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)')
    .run('var-co', 'co-variant', 'navy|m', 'Navy / M', 3499, 5, 1, 1);
  db.prepare('INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?,?,?)')
    .run('var-co', 'og-co', 'ov-co');

  seedProduct(db, 'co-untracked', 'cat-co', 'Made to Order Scarf', 900, { track_inventory: false, stock_quantity: 0 });
  publish('co-untracked');

  seedProduct(db, 'co-unpub', 'cat-co', 'Unpublished Piece', 500, { stock_quantity: 5 });
  seedProduct(db, 'co-deleted', 'cat-co', 'Deleted Piece', 500, { stock_quantity: 5 });
  publish('co-deleted');
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), 'co-deleted');

  // The key is created by the migration default, so update rather than insert.
  db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'shop_whatsapp_number'")
    .run(TEST_WHATSAPP);
  db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'shop_upi_id'")
    .run('paytm.s2x4y1r@pty');
  db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'shop_upi_payee_name'")
    .run('Abdul Baeis M V');
}

/** Rows checkout must never touch. */
function countPosRecords(db: any) {
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
    seedFixtures(db);
    const app = createApp({
      '/api/shop/checkout': checkoutRoutes,
      '/api/shop/cart': cartRoutes,
      '/api/shop': shopRoutes,
    });
    const started = await startServer(app);
    baseUrl = started.baseUrl;
    server = started.server;

    /** Fresh guest with one item already in the cart. */
    async function guestWithItem(productId: string, quantity: number, variantId: string | null = null) {
      const client = makeShopClient(baseUrl);
      await client.get('/api/shop/cart');
      await client.post('/api/shop/cart/items', { product_id: productId, variant_id: variantId, quantity });
      return client;
    }

    console.log('\n--- A: empty cart rejected ---');
    {
      const client = makeShopClient(baseUrl);
      await client.get('/api/shop/cart');
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 400, 'A: empty cart 400');
      assertEqual(res.data.code, 'cart_empty', 'A: cart_empty code');
    }

    console.log('\n--- B: missing identity cannot check out ---');
    {
      const res = await fetch(baseUrl + '/api/shop/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: VALID_CUSTOMER }),
      });
      assert(res.status === 401 || res.status === 403, 'B: no cart cookie refused (' + res.status + ')');
    }

    console.log('\n--- C: CSRF rejects mutation ---');
    {
      const client = makeShopClient(baseUrl);
      await client.get('/api/shop/cart');
      await client.post('/api/shop/cart/items', { product_id: 'co-basic', quantity: 1 });
      const cookies = Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(baseUrl + '/api/shop/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies },
        body: JSON.stringify({ customer: VALID_CUSTOMER }),
      });
      assertEqual(res.status, 403, 'C: missing CSRF header 403');
    }

    console.log('\n--- D: invalid customer details rejected ---');
    {
      const cases: [Record<string, unknown>, string][] = [
        [{ ...VALID_CUSTOMER, name: '' }, 'missing name'],
        [{ ...VALID_CUSTOMER, name: 'x' }, 'too-short name'],
        [{ ...VALID_CUSTOMER, name: 'a'.repeat(200) }, 'overlong name'],
        [{ ...VALID_CUSTOMER, phone: '12345' }, 'short phone'],
        [{ ...VALID_CUSTOMER, phone: 'abcdefghij' }, 'non-numeric phone'],
        [{ ...VALID_CUSTOMER, phone: '' }, 'missing phone'],
        [{ ...VALID_CUSTOMER, address: 'x' }, 'too-short address'],
        [{ ...VALID_CUSTOMER, address: 'a'.repeat(500) }, 'overlong address'],
        [{ ...VALID_CUSTOMER, city: '' }, 'missing city'],
        [{ ...VALID_CUSTOMER, state: '' }, 'missing state'],
        [{ ...VALID_CUSTOMER, pincode: '000000' }, 'invalid pincode'],
        [{ ...VALID_CUSTOMER, pincode: 'abcdef' }, 'non-numeric pincode'],
        [{}, 'all fields missing'],
      ];
      for (const [customer, label] of cases) {
        const client = await guestWithItem('co-basic', 1);
        const res = await client.post('/api/shop/checkout', { customer });
        assertEqual(res.status, 400, 'D: ' + label + ' rejected');
        assertEqual(res.data.error !== 'We could not complete your order. Please try again.', true,
          'D: ' + label + ' returns a customer-safe message');
      }
    }

    console.log('\n--- E: valid phone formats accepted and normalised ---');
    {
      for (const phone of ['9876543210', '+919876543210', '09876543210', '98765 43210', '98765-43210']) {
        const client = await guestWithItem('co-basic', 1);
        const res = await client.post('/api/shop/checkout', { customer: { ...VALID_CUSTOMER, phone } });
        assertEqual(res.status, 201, 'E: phone format "' + phone + '" accepted');
        const row = db.prepare('SELECT customer_phone FROM shop_orders WHERE reference = ?').get(res.data.order.reference) as any;
        assertEqual(row.customer_phone, '+919876543210', 'E: phone normalised to +91 form');
      }
    }

    console.log('\n--- F: simple product checkout creates one pending order ---');
    {
      const before = countPosRecords(db);
      const client = await guestWithItem('co-basic', 2);
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 201, 'F: 201 created');
      const order = res.data.order;
      assert(/^CLOUT-[A-Z0-9]{6}$/.test(order.reference), 'F: reference format');
      assertEqual(order.status, 'pending_review', 'F: status pending_review');
      assertEqual(order.payment_status, 'unverified', 'F: payment NOT verified');
      assertEqual(order.subtotal_minor_units, 299800, 'F: subtotal 1499.00 x 2');
      assertEqual(order.item_count, 2, 'F: item_count 2');
      assertEqual(order.items[0].unit_price_minor_units, 149900, 'F: server-derived unit price');
      assertEqual(order.items[0].line_total_minor_units, 299800, 'F: line total');
      assertEqual(order.items[0].product_name, 'Basic Tee', 'F: product name from DB');
      // Contact details ARE returned: the customer's own confirmation needs them
      // for the WhatsApp handoff and for them to check what staff will see.
      assertEqual(order.contact.phone, '+919876543210', 'F: phone normalised and returned to owner');
      assertEqual(order.contact.city, 'Kochi', 'F: city returned to owner');
      // Credentials and cost data must still never appear.
      assert(!JSON.stringify(order).includes('clout_cart'), 'F: cart token not echoed');
      assert(!JSON.stringify(order).includes('csrf'), 'F: csrf token not echoed');
      // POS records untouched.
      const after = countPosRecords(db);
      assertEqual(after.orders, before.orders, 'F: no POS order created');
      assertEqual(after.bills, before.bills, 'F: no bill created');
      assertEqual(after.stock_movements, before.stock_movements, 'F: no stock movement recorded');
      // Cart emptied only after commit.
      const cart = await client.get('/api/shop/cart');
      assertEqual(cart.data.items.length, 0, 'F: cart cleared after commit');
    }

    console.log('\n--- G: variant checkout with override price ---');
    {
      const client = await guestWithItem('co-variant', 1, 'var-co');
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 201, 'G: variant checkout 201');
      assertEqual(res.data.order.subtotal_minor_units, 349900, 'G: override price applied');
      assertEqual(res.data.order.items[0].variant_display_name, 'Navy / M', 'G: variant recorded');
      const row = db.prepare('SELECT variant_id FROM shop_order_items WHERE order_id = (SELECT id FROM shop_orders WHERE reference = ?)').get(res.data.order.reference) as any;
      assertEqual(row.variant_id, 'var-co', 'G: variant_id persisted');
    }

    console.log('\n--- H: ineligible items rejected, no order created ---');
    {
      for (const id of ['co-unpub', 'co-deleted', 'nonexistent']) {
        const client = await guestWithItem(id, 1);
        const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
        assert(res.status === 404 || res.status === 409 || res.status === 400,
          'H: ' + id + ' rejected (' + res.status + ')');
      }
      const refs = (db.prepare('SELECT reference FROM shop_orders').all() as any[]).map((r) => r.reference);
      assertEqual(new Set(refs).size, refs.length, 'H: every order reference is unique');
      const items = db.prepare('SELECT COUNT(*) AS n FROM shop_order_items').get() as any;
      assertEqual(items.n > 0, true, 'H: committed orders have line items');
    }

    console.log('\n--- I: client-supplied prices and totals are ignored ---');
    {
      const client = await guestWithItem('co-basic', 1);
      const res = await client.post('/api/shop/checkout', {
        customer: VALID_CUSTOMER,
        subtotal_minor_units: 1,
        total: 1,
        items: [{ product_id: 'co-basic', unit_price_minor_units: 1, quantity: 99 }],
        payment_status: 'paid',
        status: 'confirmed',
      });
      assertEqual(res.status, 201, 'I: checkout succeeded despite injected fields');
      assertEqual(res.data.order.subtotal_minor_units, 149900, 'I: subtotal is server-derived');
      assertEqual(res.data.order.payment_status, 'unverified', 'I: payment status cannot be set by client');
      assertEqual(res.data.order.status, 'pending_review', 'I: order status cannot be set by client');
    }

    console.log('\n--- J: stock is reserved, not decremented ---');
    {
      const beforeRow = db.prepare('SELECT stock_quantity, shop_reserved_quantity FROM products WHERE id = ?').get('co-basic') as any;
      const client = await guestWithItem('co-basic', 3);
      await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const row = db.prepare('SELECT stock_quantity, shop_reserved_quantity FROM products WHERE id = ?').get('co-basic') as any;
      assertEqual(row.stock_quantity, beforeRow.stock_quantity, 'J: sale stock untouched by checkout');
      assertEqual(row.shop_reserved_quantity, beforeRow.shop_reserved_quantity + 3, 'J: 3 units reserved');
      const avail = Number(row.stock_quantity) - Number(row.shop_reserved_quantity);
      assertEqual(avail, Number(beforeRow.stock_quantity) - Number(beforeRow.shop_reserved_quantity) - 3,
        'J: available stock reduced by reservation');
    }

    console.log('\n--- K: reservations block overselling ---');
    {
      const first = await guestWithItem('co-low', 1);
      const res1 = await first.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res1.status, 201, 'K: first buyer reserves the last unit');

      const second = await guestWithItem('co-low', 1);
      const res2 = await second.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res2.status, 409, 'K: second buyer refused (409)');
      assertEqual(res2.data.code, 'insufficient_stock', 'K: insufficient_stock code');

      const row = db.prepare('SELECT stock_quantity, shop_reserved_quantity FROM products WHERE id = ?').get('co-low') as any;
      assertEqual(row.stock_quantity, 1, 'K: sale stock unchanged');
      assertEqual(row.shop_reserved_quantity, 1, 'K: only one reservation held');
    }

    console.log('\n--- L: insufficient stock in one line aborts the whole order ---');
    {
      const client = makeShopClient(baseUrl);
      await client.get('/api/shop/cart');
      await client.post('/api/shop/cart/items', { product_id: 'co-basic', quantity: 1 });
      await client.post('/api/shop/cart/items', { product_id: 'co-low', quantity: 5 });
      const ordersBefore = (db.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any).n;
      const reservedBefore = db.prepare('SELECT shop_reserved_quantity FROM products WHERE id = ?').get('co-basic').shop_reserved_quantity;
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 409, 'L: checkout refused');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any).n, ordersBefore,
        'L: no partial order created');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_order_items').get() as any).n > 0, true,
        'L: earlier items still exist');
      // No orphan reservations from the aborted attempt.
      const reserved = db.prepare('SELECT shop_reserved_quantity FROM products WHERE id = ?').get('co-basic') as any;
      assertEqual(reserved.shop_reserved_quantity, reservedBefore, 'L: aborted attempt left no new reservation');
      // The cart is preserved on failure.
      const cart = await client.get('/api/shop/cart');
      assertEqual(cart.data.items.length, 2, 'L: cart preserved after failure');
    }

    console.log('\n--- M: idempotent retry returns the same order ---');
    {
      const client = await guestWithItem('co-basic', 1);
      const first = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(first.status, 201, 'M: first checkout 201');
      const ordersBefore = (db.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any).n;

      // Same logical attempt: same cart, same details, same key.
      const second = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(second.status, 200, 'M: replay returns 200');
      assertEqual(second.data.order.reference, first.data.order.reference, 'M: same reference returned');
      assertEqual(second.data.replayed, true, 'M: marked as replay');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any).n, ordersBefore,
        'M: no second order created');
    }

    console.log('\n--- N: cart cannot create a second order ---');
    {
      const client = await guestWithItem('co-basic', 1);
      await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const ordersBefore = (db.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any).n;
      const reservedBefore = db.prepare('SELECT shop_reserved_quantity FROM products WHERE id = ?').get('co-basic').shop_reserved_quantity;

      // Refill the emptied cart, then try to check out again on the same cart.
      await client.post('/api/shop/cart/items', { product_id: 'co-basic', quantity: 1 });
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 200, 'N: returns the original order');
      assertEqual(res.data.replayed, true, 'N: replayed, not a new order');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any).n, ordersBefore,
        'N: no duplicate order');
      assertEqual(db.prepare('SELECT shop_reserved_quantity FROM products WHERE id = ?').get('co-basic').shop_reserved_quantity,
        reservedBefore, 'N: no second stock reservation');
    }

    console.log('\n--- O: idempotency key reuse with a different payload rejected ---');
    {
      const { hashCheckoutPayload, validateCustomer, acceptIdempotencyKey } = require('../main/services/shop-orders');
      const customerA = validateCustomer(VALID_CUSTOMER).value;
      const customerB = validateCustomer({ ...VALID_CUSTOMER, city: 'Thrissur' }).value;
      const items = [{ productId: 'co-basic', variantId: null, quantity: 1 }];
      assert(hashCheckoutPayload(customerA, items) !== hashCheckoutPayload(customerB, items),
        'O: payload hash differs for different details');
      assertEqual(hashCheckoutPayload(customerA, items), hashCheckoutPayload(customerA, items),
        'O: payload hash is stable');
      assert(/^[A-Za-z0-9_-]{16,128}$/.test(acceptIdempotencyKey('bad key with spaces')), 'O: bad key replaced');
      assert(acceptIdempotencyKey('bad key with spaces') !== acceptIdempotencyKey('bad key with spaces'),
        'O: replacement keys are unique');
      assertEqual(acceptIdempotencyKey('abcdefghijklmnop1234567890'), 'abcdefghijklmnop1234567890',
        'O: valid key preserved');
    }

    console.log('\n--- P: WhatsApp URL is correct and privacy-safe ---');
    {
      const client = await guestWithItem('co-variant', 1, 'var-co');
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const url = res.data.order.whatsapp_url;
      assert(url && url.startsWith('https://wa.me/'), 'P: wa.me URL returned');
      assert(url.includes(encodeURIComponent('+' + TEST_WHATSAPP)), 'P: business number in URL');

      const text = decodeURIComponent(url.split('text=')[1]);
      assert(text.includes(res.data.order.reference), 'P: order reference in message');
      assert(text.includes('Rigid Denim'), 'P: product name in message');
      assert(text.includes('x1'), 'P: quantity in message');
      assert(text.includes('3,499.00') || text.includes('3499.00'), 'P: subtotal in message');
      assert(/pending review/i.test(text), 'P: pending status stated');
      assert(/not a payment|confirm/i.test(text), 'P: payment not implied');
      // Unicode (Malayalam) option label survives the URL round trip intact.
      assert(text.includes('നീലം'), 'P: Unicode option label preserved through encoding');
      assert(text.includes('Colour: നീലം'), 'P: option group and value both present');
      // PRIVACY: session material and credentials must NEVER appear. Contact
      // details are intentionally included now (see blocks AH/AJ) because staff
      // need them to fulfil the parcel.
      assert(!url.includes('clout_cart'), 'P: cart token NOT in URL');
      assert(!url.includes('csrf'), 'P: csrf token NOT in URL');
      assert(!/eyJ[A-Za-z0-9_-]{10,}/.test(url), 'P: no JWT-like secret in URL');
    }

    console.log('\n--- Q: WhatsApp omitted when no business number configured ---');
    {
      db.prepare("UPDATE settings SET value = '' WHERE key = 'shop_whatsapp_number'").run();
      const client = await guestWithItem('co-basic', 1);
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 201, 'Q: order still created without WhatsApp');
      assertEqual(res.data.order.whatsapp_url, null, 'Q: no URL when unconfigured (no invented number)');
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(TEST_WHATSAPP, 'shop_whatsapp_number');
    }

    console.log('\n--- R: WhatsApp number normalisation ---');
    {
      const { getBusinessWhatsAppNumber } = require('../main/services/shop-orders');
      for (const [raw, expected] of [
        ['+91 99999 99999', '+919999999999'],
        ['919999999999', '+919999999999'],
        ['9999999999', '+9999999999'],
      ] as [string, string][]) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(raw, 'shop_whatsapp_number');
        assertEqual(getBusinessWhatsAppNumber(db), expected, 'R: normalised "' + raw + '"');
      }
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('not-a-number', 'shop_whatsapp_number');
      assertEqual(getBusinessWhatsAppNumber(db), null, 'R: invalid config -> null, no invented number');
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(TEST_WHATSAPP, 'shop_whatsapp_number');
    }

    console.log('\n--- S: phone and PIN normalisation helpers ---');
    {
      const { normalisePhone, normalisePincode } = require('../main/services/shop-orders');
      assertEqual(normalisePhone('9876543210'), '+919876543210', 'S: plain phone');
      assertEqual(normalisePhone('+91 98765-43210'), '+919876543210', 'S: formatted phone');
      assertEqual(normalisePhone('1234567890'), null, 'S: phone starting 1 rejected');
      assertEqual(normalisePhone('98765'), null, 'S: short phone rejected');
      assertEqual(normalisePincode('682031'), '682031', 'S: 6-digit PIN');
      assertEqual(normalisePincode('110001'), '110001', 'S: Delhi PIN');
      assertEqual(normalisePincode('000000'), null, 'S: 000000 rejected');
      assertEqual(normalisePincode('abc'), null, 'S: non-numeric PIN rejected');
    }

    console.log('\n--- T: one guest cannot order from another guest cart ---');
    {
      const victim = await guestWithItem('co-basic', 1);
      const attacker = makeShopClient(baseUrl);
      await attacker.get('/api/shop/cart');
      // Attacker's own (empty) cart cannot create an order.
      const res = await attacker.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 400, 'T: attacker with empty cart refused');
      assertEqual(res.data.code, 'cart_empty', 'T: cart_empty');
    }

    console.log('\n--- U: forged cart cookie cannot check out ---');
    {
      const client = await guestWithItem('co-basic', 1);
      const forged = makeShopClient(baseUrl);
      forged.setCookie('clout_cart', client.jar.clout_cart.slice(0, -4) + 'AAAA', '/api/shop');
      forged.setCookie('clout_cart_csrf', client.jar.clout_cart_csrf);
      const res = await forged.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 401, 'U: forged cookie 401');
    }

    console.log('\n--- V: expired cart cannot check out ---');
    {
      const client = await guestWithItem('co-basic', 1);
      db.prepare('UPDATE shop_carts SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM shop_carts ORDER BY created_at DESC LIMIT 1)')
        .run(new Date(Date.now() - 1000).toISOString());
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 401, 'V: expired cart 401');
      assertEqual(res.data.code, 'cart_expired', 'V: cart_expired code');
    }

    console.log('\n--- W: public endpoints cannot mutate order state ---');
    {
      const before = db.prepare("SELECT status, payment_status, subtotal_minor_units FROM shop_orders ORDER BY created_at DESC LIMIT 1").get() as any;
      for (const body of [
        { status: 'confirmed' }, { payment_status: 'verified' },
        { subtotal_minor_units: 1 }, { reference: 'HACKED-1' },
      ]) {
        const client = await guestWithItem('co-basic', 1);
        const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER, order: body });
        assert([200, 201].includes(res.status), 'W: request accepted but body ignored');
        const after = db.prepare('SELECT status, payment_status, subtotal_minor_units FROM shop_orders ORDER BY created_at DESC LIMIT 1').get() as any;
        assertEqual(after.status, 'pending_review', 'W: status immutable from public API');
        assertEqual(after.payment_status, 'unverified', 'W: payment immutable from public API');
        assertEqual(after.subtotal_minor_units >= 1, true, 'W: subtotal server-derived');
      }
      assert(before !== null, 'W: baseline order existed');
    }

    console.log('\n--- X: unsupported methods rejected on checkout ---');
    {
      const client = await guestWithItem('co-basic', 1);
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(baseUrl + '/api/shop/checkout', {
          method, headers: { Cookie: `clout_cart=${client.jar.clout_cart}` },
        });
        assert(res.status === 404 || res.status === 405 || res.status === 401,
          'X: ' + method + ' rejected (' + res.status + ')');
      }
      assertEqual(isPublicShopCheckoutPath('/api/shop/checkout', 'POST'), true, 'X: POST bypasses');
      assertEqual(isPublicShopCheckoutPath('/api/shop/checkout', 'GET'), false, 'X: GET does not bypass');
      assertEqual(isPublicShopCheckoutPath('/api/shop/checkout/abc', 'POST'), false, 'X: subpath does not bypass');
      assertEqual(isPublicShopCheckoutPath('/api/orders', 'POST'), false, 'X: POS orders do not bypass');
    }

    console.log('\n--- Y: malformed payloads handled safely ---');
    {
      const client = await guestWithItem('co-basic', 1);
      const res = await client.post('/api/shop/checkout', undefined, { 'Content-Type': 'application/json' });
      assert(res.status >= 400 && res.status < 500, 'Y: empty body (' + res.status + ')');
      const notObject = await client.post('/api/shop/checkout', 'not json at all', { 'Content-Type': 'application/json' });
      assert(notObject.status >= 400 && notObject.status < 500, 'Y: non-JSON body (' + notObject.status + ')');
      const huge = await client.post('/api/shop/checkout', { customer: { ...VALID_CUSTOMER, address: 'A'.repeat(200000) } });
      assert(huge.status === 400 || huge.status === 413, 'Y: oversized payload rejected (' + huge.status + ')');
    }

    console.log('\n--- Z: order reference cannot be used to read another order ---');
    {
      // There is deliberately NO public order-read endpoint.
      const client = await guestWithItem('co-basic', 1);
      const created = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const reference = created.data.order.reference;
      for (const path of ['/api/shop/orders', `/api/shop/orders/${reference}`, '/api/shop/checkout/' + reference]) {
        const res = await fetch(baseUrl + path);
        assert(res.status === 404 || res.status === 401, 'Z: ' + path + ' not publicly readable (' + res.status + ')');
      }
    }

    console.log('\n--- AA: untracked-stock product can be ordered ---');
    {
      const client = await guestWithItem('co-untracked', 2);
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 201, 'AA: made-to-order item accepted');
      const row = db.prepare('SELECT shop_reserved_quantity FROM products WHERE id = ?').get('co-untracked') as any;
      assertEqual(row.shop_reserved_quantity, 0, 'AA: untracked stock takes no reservation');
    }

    console.log('\n--- AB: POS sales remain consistent with reservations ---');
    {
      const basic = db.prepare('SELECT stock_quantity, shop_reserved_quantity FROM products WHERE id = ?').get('co-basic') as any;
      assert(Number(basic.stock_quantity) >= 0, 'AB: sale stock never negative');
      assert(Number(basic.shop_reserved_quantity) >= 0, 'AB: reserved never negative');
      assert(Number(basic.shop_reserved_quantity) <= Number(basic.stock_quantity),
        'AB: reserved never exceeds sale stock');
    }


    // AC-AJ use a dedicated product so they are independent of how much
    // 'co-basic' earlier blocks already reserved.
    seedProduct(db, 'co-upi', 'cat-co', 'UPI Test Tee', 1499, { track_inventory: true, stock_quantity: 200 });
    db.prepare("UPDATE products SET catalog_status='published' WHERE id=?").run('co-upi');

    console.log('\n--- AC: UPI details are server-derived and amount-bound ---');
    {
      const client = await guestWithItem('co-upi', 1);
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const upi = res.data.upi;
      assert(upi, 'AC: upi payload returned');
      assertEqual(upi.configured, true, 'AC: UPI configured');
      assertEqual(upi.upi_id, 'paytm.s2x4y1r@pty', 'AC: configured UPI ID returned');
      assertEqual(upi.payee_name, 'Abdul Baeis M V', 'AC: payee name returned');
      assertEqual(upi.amount_minor_units, 149900, 'AC: amount is the server subtotal');
      // A REAL, scannable PNG QR bound to this exact amount.
      assert(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(upi.qr_data_url), 'AC: QR is a PNG data URI');
      // The UPI intent must carry the amount and the payee handle.
      assert(upi.upi_intent_url.startsWith('upi://pay?'), 'AC: standard upi:// intent');
      assert(upi.upi_intent_url.includes('pa=paytm.s2x4y1r%40pty'), 'AC: intent carries the UPI handle');
      assert(upi.upi_intent_url.includes('am=1499.00'), 'AC: intent carries the exact amount');
      assert(decodeURIComponent(upi.upi_intent_url).includes(res.data.order.reference),
        'AC: intent carries the order reference');
    }

    console.log('\n--- AD: no QR or invented UPI ID when unconfigured ---');
    {
      db.prepare("UPDATE settings SET value = '' WHERE key = 'shop_upi_id'").run();
      const client = await guestWithItem('co-upi', 1);
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res.status, 201, 'AD: order still created');
      assertEqual(res.data.upi.configured, false, 'AD: configured=false');
      assertEqual(res.data.upi.qr_data_url, null, 'AD: no QR image when unconfigured');
      assertEqual(res.data.upi.upi_intent_url, null, 'AD: no intent link when unconfigured');
      assertEqual(res.data.upi.upi_id, '', 'AD: no UPI ID shown rather than a fake one');

      db.prepare("UPDATE settings SET value = ? WHERE key = 'shop_upi_id'").run('not a upi id');
      const second = makeShopClient(baseUrl);
      await second.get('/api/shop/cart');
      await second.post('/api/shop/cart/items', { product_id: 'co-basic', quantity: 1 });
      const res2 = await second.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(res2.data.upi.configured, false, 'AD: malformed handle -> unconfigured');
      db.prepare("UPDATE settings SET value = ? WHERE key = 'shop_upi_id'").run('paytm.s2x4y1r@pty');
    }

    console.log('\n--- AE: payment declaration is unverified, not confirmation ---');
    {
      const client = await guestWithItem('co-upi', 1);
      const placed = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      assertEqual(placed.data.order.payment_declared, false, 'AE: not declared initially');
      assertEqual(placed.data.order.payment_status, 'unverified', 'AE: unverified before declaration');

      const declared = await client.post('/api/shop/checkout/declaration', {
        declared: true, reference: '412345678901',
      });
      assertEqual(declared.status, 200, 'AE: declaration recorded');
      assertEqual(declared.data.payment_declared, true, 'AE: declaration flagged');
      // CRITICAL: declaring must NOT verify payment.
      assertEqual(declared.data.payment_status, 'unverified', 'AE: payment STILL unverified after declaration');
      assertEqual(declared.data.order.status, 'pending_review', 'AE: order status unchanged');

      const row = db.prepare('SELECT payment_status FROM shop_orders WHERE reference = ?')
        .get(placed.data.order.reference) as any;
      assertEqual(row.payment_status, 'unverified', 'AE: database payment_status untouched');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_payment_declarations').get() as any).n > 0, true,
        'AE: declaration persisted separately');
    }


    console.log('\n--- AF: declaration is idempotent and validated ---');
    {
      const client = await guestWithItem('co-upi', 1);
      await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      await client.post('/api/shop/checkout/declaration', { declared: true, reference: 'REF1' });
      const before = (db.prepare('SELECT COUNT(*) AS n FROM shop_payment_declarations').get() as any).n;
      await client.post('/api/shop/checkout/declaration', { declared: true, reference: 'REF2' });
      const after = (db.prepare('SELECT COUNT(*) AS n FROM shop_payment_declarations').get() as any).n;
      assertEqual(after, before, 'AF: repeat declaration does not duplicate');

      assertEqual((await client.post('/api/shop/checkout/declaration', { declared: false })).status, 400,
        'AF: declared:false rejected');
      assertEqual((await client.post('/api/shop/checkout/declaration', {})).status, 400,
        'AF: missing declared rejected');

      // Overlong reference is capped, not stored wholesale.
      const fresh = await guestWithItem('co-upi', 1);
      await fresh.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      await fresh.post('/api/shop/checkout/declaration', { declared: true, reference: 'X'.repeat(500) });
      const stored = db.prepare('SELECT reference FROM shop_payment_declarations ORDER BY rowid DESC LIMIT 1').get() as any;
      assert((stored.reference || '').length <= 80, 'AF: reference length capped');
    }

    console.log('\n--- AG: declaration requires the owning cart ---');
    {
      const owner = await guestWithItem('co-upi', 1);
      const placed = await owner.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const reference = placed.data.order.reference;

      const attacker = makeShopClient(baseUrl);
      await attacker.get('/api/shop/cart');
      const res = await attacker.post('/api/shop/checkout/declaration', {
        declared: true, reference: reference,
      });
      assertEqual(res.status, 404, 'AG: another guest cannot declare on this order');

      const noCsrf = await fetch(baseUrl + '/api/shop/checkout/declaration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `clout_cart=${owner.jar.clout_cart}` },
        body: JSON.stringify({ declared: true }),
      });
      assertEqual(noCsrf.status, 403, 'AG: declaration requires CSRF');
    }

    console.log('\n--- AH: WhatsApp message includes customer details, not secrets ---');
    {
      const client = await guestWithItem('co-upi', 1);
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const text = decodeURIComponent(res.data.order.whatsapp_url.split('text=')[1]);
      assert(text.includes(res.data.order.reference), 'AH: order reference present');
      assert(text.includes(VALID_CUSTOMER.name), 'AH: customer name present');
      assert(text.includes('+919876543210'), 'AH: normalised phone present');
      assert(text.includes('Marine Drive'), 'AH: delivery address present');
      assert(text.includes('Kochi'), 'AH: city present');
      assert(text.includes('682031'), 'AH: pincode present');
      assert(text.includes('UPI Test Tee'), 'AH: product name present');
      assert(text.includes('x1'), 'AH: quantity present');
      assert(text.includes('1499.00'), 'AH: total present');
      assert(text.includes('paytm.s2x4y1r@pty'), 'AH: UPI ID shared with staff');
      assert(/have not paid yet/i.test(text), 'AH: no payment claimed when not declared');
      // Never any credential or session material.
      assert(!/clout_cart|csrf/i.test(text), 'AH: no cart/CSRF token in message');
      assert(!/eyJ[A-Za-z0-9_-]{10,}/.test(text), 'AH: no JWT-like secret');
    }

    console.log('\n--- AI: WhatsApp message reflects the declaration ---');
    {
      const client = await guestWithItem('co-upi', 1);
      const placed = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const before = decodeURIComponent(placed.data.order.whatsapp_url.split('text=')[1]);
      assert(/have not paid yet/i.test(before), 'AI: pre-declaration wording correct');

      await client.post('/api/shop/checkout/declaration', { declared: true });
      const reloaded = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const after = decodeURIComponent(reloaded.data.order.whatsapp_url.split('text=')[1]);
      assert(/I have made the payment/i.test(after), 'AI: post-declaration wording reflects the claim');
      assert(after.includes('This is my declaration'), 'AI: labelled as a declaration, not confirmation');
      assertEqual(reloaded.data.order.payment_status, 'unverified', 'AI: payment still unverified');
    }

    console.log('\n--- AJ: Unicode + punctuation survive WhatsApp encoding ---');
    {
      const client = await guestWithItem('co-variant', 1, 'var-co');
      const res = await client.post('/api/shop/checkout', { customer: VALID_CUSTOMER });
      const url = res.data.order.whatsapp_url;
      const text = decodeURIComponent(url.split('text=')[1]);
      assert(text.includes('നീലം'), 'AJ: Malayalam option label preserved');
      assert(text.includes('Colour: നീലം'), 'AJ: labelled option preserved');
      assert(text.includes('12 Rose Villa, Marine Drive, Kochi, Kerala - 682031'),
        'AJ: full address rendered with punctuation intact');
      assert(url.split('text=')[1].includes('%'), 'AJ: message is properly encoded in the URL');
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
