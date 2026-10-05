/**
 * Phase 5 staff online-order management tests.
 *
 * Disposable temporary database only. Covers the migration rebuild, role-scoped
 * authorization, payment verification audit, the 2-hour reservation expiry, and
 * exactly-once stock consumption on fulfilment.
 *
 * Critically also asserts that online fulfilment NEVER creates a POS `orders` or
 * `bills` row, so in-store revenue and X/Z reporting stay untouched.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shop-online-orders-admin.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shop-admin-'));

Module._load = function (request) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

process.env.JWT_SECRET = 'test-secret-shop-admin';

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedStaffRole,
  seedCategory, seedProduct, api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');
const { makeShopClient } = require('./helpers/shop-client');

const cartRoutes = require('../main/routes/shop-cart').default;
const checkoutRoutes = require('../main/routes/shop-checkout').default;
const adminRoutes = require('../main/routes/shop-admin').default;

const CUSTOMER = {
  name: 'Asha Menon', phone: '9876543210',
  address: '12 Rose Villa, Marine Drive', city: 'Kochi', state: 'Kerala', pincode: '682031',
};

function seedFixtures(db) {
  seedCategory(db, 'cat-p5', 'Clothing');
  const publish = (id) => db.prepare("UPDATE products SET catalog_status='published' WHERE id=?").run(id);
  seedProduct(db, 'p5-tee', 'cat-p5', 'Heavy Tee', 1499, { track_inventory: true, stock_quantity: 10 });
  publish('p5-tee');
  seedProduct(db, 'p5-denim', 'cat-p5', 'Rigid Denim', 3200, { track_inventory: true, stock_quantity: 0 });
  db.prepare('UPDATE products SET variant_mode=1 WHERE id=?').run('p5-denim');
  publish('p5-denim');
  db.prepare('INSERT INTO product_option_groups (id, product_id, name, normalized_name, sort_order) VALUES (?,?,?,?,?)').run('og5','p5-denim','Colour','colour',0);
  db.prepare('INSERT INTO product_option_values (id, option_group_id, label, normalized_label, color_hex, sort_order, is_active) VALUES (?,?,?,?,?,?,?)').run('ov5','og5','Navy','navy','#1B3156',0,1);
  db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)').run('var5','p5-denim','navy|m','Navy / M',3499,4,1,1);
  db.prepare('INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?,?,?)').run('var5','og5','ov5');
  db.prepare("UPDATE settings SET value='919999999999' WHERE key='shop_whatsapp_number'").run();
  db.prepare("UPDATE settings SET value='paytm.s2x4y1r@pty' WHERE key='shop_upi_id'").run();
}

/** Places a real order through the public checkout path. */
async function placeOrder(baseUrl, productId, quantity, variantId) {
  const client = makeShopClient(baseUrl);
  await client.get('/api/shop/cart');
  await client.post('/api/shop/cart/items', { product_id: productId, quantity, variant_id: variantId || null });
  const res = await client.post('/api/shop/checkout', { customer: CUSTOMER });
  return { client, res };
}

function orderIdOf(db, reference) {
  return (db.prepare('SELECT id FROM shop_orders WHERE reference = ?').get(reference) as any).id;
}

function reservedOf(db, productId) {
  return Number((db.prepare('SELECT shop_reserved_quantity FROM products WHERE id=?').get(productId) as any).shop_reserved_quantity);
}
function stockOf(db, productId) {
  return Number((db.prepare('SELECT stock_quantity FROM products WHERE id=?').get(productId) as any).stock_quantity);
}
function posCounts(db) {
  const one = (sql) => (db.prepare(sql).get() as any).n;
  return { orders: one('SELECT COUNT(*) AS n FROM orders'), bills: one('SELECT COUNT(*) AS n FROM bills') };
}

async function main() {
  const db = initTestDb();
  let server;
  let baseUrl = '';

  try {
    seedFixtures(db);
    const owner = seedOwnerUser(db);
    const manager = seedStaffRole(db, 'manager');
    const cashier = seedStaffRole(db, 'cashier');
    const serverUser = seedStaffRole(db, 'server');

    const app = createApp({
      '/api/shop/admin': adminRoutes,
      '/api/shop/checkout': checkoutRoutes,
      '/api/shop/cart': cartRoutes,
    });
    const started = await startServer(app);
    baseUrl = started.baseUrl;
    server = started.server;

    console.log('\n--- A: migration v91 shape ---');
    {
      const cols = db.prepare('PRAGMA table_info(shop_orders)').all().map((c) => c.name);
      assert(cols.includes('reservation_expires_at'), 'A: reservation_expires_at added');
      assert(cols.includes('fulfilled_at'), 'A: fulfilled_at added');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'shop_order_%'").all().map((r) => r.name);
      for (const t of ['shop_order_reservations', 'shop_order_events', 'shop_order_payment_actions']) {
        assert(tables.includes(t), 'A: ' + t + ' created');
      }
      const fk = db.pragma('foreign_key_check');
      assertEqual(JSON.stringify(fk), '[]', 'A: foreign_key_check clean');
      // Online orders must not have polluted POS tables.
      assertEqual(posCounts(db).orders, 0, 'A: no POS orders created by migration');
    }

    console.log('\n--- B: reservation ledger is written at checkout ---');
    {
      const { res } = await placeOrder(baseUrl, 'p5-tee', 2);
      assertEqual(res.status, 201, 'B: order placed');
      const id = orderIdOf(db, res.data.order.reference);
      const rows = db.prepare('SELECT * FROM shop_order_reservations WHERE order_id = ? AND released_at IS NULL').all(id) as any[];
      assertEqual(rows.length, 1, 'B: one active ledger row');
      assertEqual(rows[0].quantity, 2, 'B: ledger quantity matches the order');
      assertEqual(reservedOf(db, 'p5-tee'), 2, 'B: counter moved by the same amount');
      const expiry = (db.prepare('SELECT reservation_expires_at FROM shop_orders WHERE id=?').get(id) as any).reservation_expires_at;
      assert(expiry, 'B: expiry recorded at checkout');
      const delta = new Date(expiry).getTime() - new Date(res.data.order.created_at).getTime();
      assert(Math.abs(delta - 2 * 3600 * 1000) < 2000, 'B: expiry is checkout + 2 hours');
    }

    console.log('\n--- C: anonymous access to admin API is refused ---');
    {
      assertEqual((await api(baseUrl, '/api/shop/admin/orders')).status, 401, 'C: anonymous list 401');
      const client = makeShopClient(baseUrl);
      await client.get('/api/shop/cart');
      assertEqual((await client.get('/api/shop/admin/orders/x')).status, 401, 'C: guest cannot read orders');
      assertEqual((await client.post('/api/shop/admin/orders/x/status', { status: 'accepted' })).status, 401,
        'C: guest cannot change status');
      assertEqual((await client.post('/api/shop/admin/orders/x/payment', { action: 'verified' })).status, 401,
        'C: guest cannot verify payment');
    }

    console.log('\n--- D: role-scoped list access ---');
    {
      const heads = { owner: owner.authHeader, manager: manager.authHeader, cashier: cashier.authHeader, server: serverUser.authHeader };
      for (const [role, auth] of Object.entries(heads)) {
        const res = await api(baseUrl, '/api/shop/admin/orders', { headers: auth as any });
        assertEqual(res.status, 200, 'D: ' + role + ' can list orders');
      }
      const list = await api(baseUrl, '/api/shop/admin/orders', { headers: owner.authHeader });
      assertEqual(list.data.orders.length >= 1, true, 'D: orders listed');
      assertEqual(list.data.orders[0].source, 'online', 'D: orders badged as online');
      assertEqual(list.data.pagination.total >= 1, true, 'D: pagination total present');
    }

    console.log('\n--- E: server sees packing data but no payment controls ---');
    {
      const list = await api(baseUrl, '/api/shop/admin/orders', { headers: serverUser.authHeader });
      const id = list.data.orders[0].id;
      const detail = await api(baseUrl, '/api/shop/admin/orders/' + id, { headers: serverUser.authHeader });
      assertEqual(detail.status, 200, 'E: server can read an order');
      assert(detail.data.customer.name, 'E: server sees customer name for handover');
      assert(Array.isArray(detail.data.packing_actions), 'E: packing actions present');
      assertEqual(JSON.stringify(detail.data.payment_actions), '[]', 'E: server sees NO payment actions');
      assertEqual(detail.data.declaration, null, 'E: server sees no payment declaration');
      assertEqual(JSON.stringify(detail.data.events), '[]', 'E: server sees no audit events');

      const verify = await api(baseUrl, '/api/shop/admin/orders/' + id + '/payment', {
        method: 'POST', headers: serverUser.authHeader, body: { action: 'verified', utr_reference: 'ABC123456' },
      });
      assertEqual(verify.status, 403, 'E: server cannot verify payment');
      // Dispatch and completion consume stock and release the reservation, so
      // they stay with owner/manager. A server packs and hands over only.
      for (const target of ['cancelled', 'rejected', 'dispatched', 'completed']) {
        const res = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
          method: 'PATCH', headers: serverUser.authHeader, body: { status: target, reason: 'nope' },
        });
        assertEqual(res.status, 403, 'E: server cannot ' + target);
      }
      // Only ever one forward step exists at a time, so assert the SET rather
      // than that both steps appear together.
      const offered = detail.data.packing_actions;
      assertEqual(Array.isArray(offered), true, 'E: packing actions present');
      assertEqual(offered.every((a) => ['preparing', 'packed'].includes(a)), true,
        'E: packing actions are limited to packing steps');
      for (const forbidden of ['dispatched', 'completed', 'cancelled', 'rejected', 'accepted']) {
        assertEqual(offered.includes(forbidden), false, 'E: ' + forbidden + ' not offered to a server');
        assertEqual(detail.data.allowed_transitions.includes(forbidden), false,
          'E: ' + forbidden + ' absent from the server transition list');
      }
    }

    console.log('\n--- F: declaration never verifies payment ---');
    let paymentOrderId;
    let denimOrderId;
    {
      const { client, res } = await placeOrder(baseUrl, 'p5-tee', 1);
      paymentOrderId = orderIdOf(db, res.data.order.reference);
      await client.post('/api/shop/checkout/declaration', { declared: true, reference: 'UPI999888777' });
      const detail = await api(baseUrl, '/api/shop/admin/orders/' + paymentOrderId, { headers: owner.authHeader });
      assert(detail.data.declaration, 'F: declaration visible to staff');
      assertEqual(detail.data.declaration.reference, 'UPI999888777', 'F: declaration reference shown');
      assertEqual(detail.data.payment_status, 'unverified', 'F: declaration did NOT verify payment');
    }

    console.log('\n--- G: verification requires a valid UTR, audits, and is atomic ---');
    {
      for (const bad of ['', 'abc', 'ABC12', 'ABC 123 456', '<script>x</script>', 'A'.repeat(41)]) {
        const res = await api(baseUrl, '/api/shop/admin/orders/' + paymentOrderId + '/payment', {
          method: 'POST', headers: cashier.authHeader, body: { action: 'verified', utr_reference: bad },
        });
        assertEqual(res.status, 400, 'G: invalid UTR "' + String(bad).slice(0, 12) + '" rejected');
      }
      const ok = await api(baseUrl, '/api/shop/admin/orders/' + paymentOrderId + '/payment', {
        method: 'POST', headers: cashier.authHeader,
        body: { action: 'verified', utr_reference: 'upi123456789', note: 'Seen in bank statement' },
      });
      assertEqual(ok.status, 200, 'G: cashier verified payment');
      assertEqual(ok.data.payment_status, 'verified', 'G: status now verified');

      const row = db.prepare('SELECT payment_status FROM shop_orders WHERE id=?').get(paymentOrderId) as any;
      assertEqual(row.payment_status, 'verified', 'G: persisted');
      const actions = db.prepare('SELECT * FROM shop_order_payment_actions WHERE order_id=?').all(paymentOrderId) as any[];
      assertEqual(actions.length, 1, 'G: exactly one audit row');
      assertEqual(actions[0].utr_reference, 'UPI123456789', 'G: UTR stored (normalised)');
      assertEqual(actions[0].note, 'Seen in bank statement', 'G: staff note stored');
      assertEqual(actions[0].actor_user_id, cashier.userId, 'G: actor recorded');
      assertEqual(actions[0].previous_payment_status, 'unverified', 'G: prior value recorded');
      assertEqual(actions[0].new_payment_status, 'verified', 'G: new value recorded');
    }

    console.log('\n--- H: repeated and conflicting payment actions ---');
    {
      const again = await api(baseUrl, '/api/shop/admin/orders/' + paymentOrderId + '/payment', {
        method: 'POST', headers: owner.authHeader, body: { action: 'verified', utr_reference: 'OTHER123456' },
      });
      assertEqual(again.status, 409, 'H: re-verifying refused');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_order_payment_actions WHERE order_id=?').get(paymentOrderId) as any).n, 1,
        'H: no duplicate audit row');

      const rejectVerified = await api(baseUrl, '/api/shop/admin/orders/' + paymentOrderId + '/payment', {
        method: 'POST', headers: owner.authHeader, body: { action: 'rejected' },
      });
      assertEqual(rejectVerified.status, 409, 'H: cannot reject an already-verified order');
    }

    console.log('\n--- I: rejection records audit and releases the reservation ---');
    {
      const { res } = await placeOrder(baseUrl, 'p5-tee', 1);
      const id = orderIdOf(db, res.data.order.reference);
      const reservedBefore = reservedOf(db, 'p5-tee');
      assert(reservedBefore >= 1, 'I: a reservation is held');

      const rejected = await api(baseUrl, '/api/shop/admin/orders/' + id + '/payment', {
        method: 'POST', headers: manager.authHeader, body: { action: 'rejected', note: 'No money received' },
      });
      assertEqual(rejected.status, 200, 'I: payment rejected');
      const cancel = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: manager.authHeader, body: { status: 'cancelled', reason: 'Customer unreachable' },
      });
      assertEqual(cancel.status, 200, 'I: order cancelled');
      assertEqual(reservedOf(db, 'p5-tee'), reservedBefore - 1, 'I: reservation released exactly once');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_order_reservations WHERE order_id=? AND released_at IS NULL').get(id) as any).n, 0,
        'I: ledger row marked released');
      const actions = db.prepare('SELECT * FROM shop_order_payment_actions WHERE order_id=?').all(id) as any[];
      assertEqual(actions[0].action, 'rejected', 'I: rejection audited');
    }

    console.log('\n--- J: status transition rules are enforced server-side ---');
    {
      const { res } = await placeOrder(baseUrl, 'p5-denim', 1, 'var5');
      const id = orderIdOf(db, res.data.order.reference);
      denimOrderId = id;
      // Skipping ahead is illegal.
      for (const target of ['packed', 'dispatched', 'completed']) {
        const bad = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
          method: 'PATCH', headers: owner.authHeader, body: { status: target },
        });
        assertEqual(bad.status, 409, 'J: cannot jump to ' + target);
      }
      // Expiry is never staff-settable.
      const expire = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'expired' },
      });
      assertEqual(expire.status, 400, 'J: expiry cannot be set manually');
      // Reason required for rejection/cancellation.
      const noReason = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'cancelled' },
      });
      assertEqual(noReason.status, 409, 'J: cancellation requires a reason');
      // Unverified payment cannot dispatch.
      const ship = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'accepted' },
      });
      assertEqual(ship.status, 200, 'J: accepted');
      for (const target of ['preparing', 'packed']) {
        const r = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
          method: 'PATCH', headers: owner.authHeader, body: { status: target },
        });
      }
      const dispatch = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'dispatched' },
      });
      assertEqual(dispatch.status, 409, 'J: cannot dispatch while payment unverified');
    }

    console.log('\n--- K: verified payment can progress to completion ---');
    {
      const id = denimOrderId;
      const before = await api(baseUrl, '/api/shop/admin/orders/' + id, { headers: owner.authHeader });
      assertEqual(before.data.status, 'packed', 'K: denim order reached packed');
      await api(baseUrl, '/api/shop/admin/orders/' + id + '/payment', {
        method: 'POST', headers: owner.authHeader, body: { action: 'verified', utr_reference: 'PAY555666777' },
      });
      const stockBefore = stockOf(db, 'p5-denim');
      const variantStockBefore = Number((db.prepare('SELECT stock_quantity FROM product_variants WHERE id=?').get('var5') as any).stock_quantity);
      const variantReservedBefore = Number((db.prepare('SELECT shop_reserved_quantity FROM product_variants WHERE id=?').get('var5') as any).shop_reserved_quantity);
      const movementsBefore = (db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='shop_order'").get() as any).n;
      const mvA = (db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='shop_order'").get() as any).n;
      const dispatched = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'dispatched' },
      });
      const mvB = (db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='shop_order'").get() as any).n;
      assertEqual(dispatched.status, 200, 'K: dispatched after verification');
      const ledgerAfter = db.prepare('SELECT product_id, variant_id, quantity, released_at FROM shop_order_reservations WHERE order_id = ?').all(id) as any[];
      assert(ledgerAfter.length > 0, 'K: ledger rows exist -> ' + JSON.stringify(ledgerAfter));
      // Fulfilment consumed the variant stock exactly once and released its hold.
      assertEqual(stockOf(db, 'p5-denim'), stockBefore, 'K: product-level stock untouched (variant order)');
      const variant = db.prepare('SELECT stock_quantity, shop_reserved_quantity FROM product_variants WHERE id=?').get('var5') as any;
      assertEqual(variant.stock_quantity, variantStockBefore - 1, 'K: variant stock decremented once');
      assertEqual(variant.shop_reserved_quantity, variantReservedBefore - 1, 'K: hold released');
      const mv = db.prepare('SELECT product_id, variant_id, quantity_delta, reference_type, reference_id FROM stock_movements').all() as any[];
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type=? AND reference_id=?').get('shop_order', id) as any).n, 1,
        'K: exactly one stock movement for this order -> ' + JSON.stringify(mv));

      // A retried dispatch must not deduct again.
      const mvC = (db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='shop_order'").get() as any).n;
      const retry = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'completed' },
      });
      const mvD = (db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='shop_order'").get() as any).n;
      assertEqual(retry.status, 200, 'K: completed');
      const retry2 = await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'dispatched' },
      });
      assertEqual(retry2.status, 409, 'K: cannot move back after completion');
      const variantAfter = db.prepare('SELECT stock_quantity FROM product_variants WHERE id=?').get('var5') as any;
      assertEqual(variantAfter.stock_quantity, variantStockBefore - 1, 'K: no double deduction');
      assertEqual((db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='shop_order'").get() as any).n, movementsBefore + 1,
        'K: no duplicate stock movement');
    }

    console.log('\n--- L: online fulfilment creates no POS order or bill ---');
    {
      const before = posCounts(db);
      const list = await api(baseUrl, '/api/shop/admin/orders?status=completed', { headers: owner.authHeader });
      assertEqual(list.data.orders.length >= 1, true, 'L: a completed online order exists');
      const after = posCounts(db);
      assertEqual(after.orders, before.orders, 'L: no POS orders created');
      assertEqual(after.bills, before.bills, 'L: no POS bills created');
      assertEqual(after.orders, 0, 'L: POS orders table still empty');
      assertEqual(after.bills, 0, 'L: POS bills table still empty');
    }

    console.log('\n--- M: event history is complete ---');
    {
      const creation = db.prepare(
        "SELECT from_status, to_status FROM shop_order_events WHERE order_id = ? AND from_status IS NULL",
      ).all(denimOrderId) as any[];
      assertEqual(creation.length, 1, 'M: exactly one creation event for the order');
      assertEqual(creation[0].to_status, 'pending_review', 'M: creation event recorded');
      const events = db.prepare('SELECT from_status, to_status FROM shop_order_events WHERE order_id = ?').all(denimOrderId) as any[];
      assert(events.length >= 2, 'M: staff transitions recorded for the order');
      assert(events.some((e) => e.to_status === 'verified' || e.to_status === 'accepted'), 'M: staff transitions recorded');
    }

    console.log('\n--- N: 2-hour expiry expires only pending orders ---');
    {
      const { res } = await placeOrder(baseUrl, 'p5-tee', 1);
      const pendingId = orderIdOf(db, res.data.order.reference);
      // An accepted order must NEVER auto-expire.
      const { res: accepted } = await placeOrder(baseUrl, 'p5-tee', 1);
      const acceptedId = orderIdOf(db, accepted.data.order.reference);
      await api(baseUrl, '/api/shop/admin/orders/' + acceptedId + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'accepted' },
      });

      const reservedBefore = reservedOf(db, 'p5-tee');
      // Backdate BOTH past the 2-hour window.
      db.prepare("UPDATE shop_orders SET reservation_expires_at = ? WHERE id IN (?, ?)")
        .run(new Date(Date.now() - 60_000).toISOString(), pendingId, acceptedId);

      const sweep = await api(baseUrl, '/api/shop/admin/reservations/sweep', {
        method: 'POST', headers: owner.authHeader, body: {},
      });
      assertEqual(sweep.status, 200, 'N: sweep runs');
      assertEqual(sweep.data.expired, 1, 'N: exactly one order expired');
      assertEqual(sweep.data.references.includes(res.data.order.reference), true, 'N: correct order expired');

      assertEqual((db.prepare('SELECT status FROM shop_orders WHERE id=?').get(pendingId) as any).status, 'expired',
        'N: pending order expired');
      assertEqual((db.prepare('SELECT status FROM shop_orders WHERE id=?').get(acceptedId) as any).status, 'accepted',
        'N: accepted order NOT expired');
      assertEqual(reservedOf(db, 'p5-tee'), reservedBefore - 1, 'N: only the expired hold released');
    }

    console.log('\n--- O: sweep is idempotent and cannot double-release ---');
    {
      const reservedBefore = reservedOf(db, 'p5-tee');
      const second = await api(baseUrl, '/api/shop/admin/reservations/sweep', {
        method: 'POST', headers: owner.authHeader, body: {},
      });
      assertEqual(second.data.expired, 0, 'O: second sweep finds nothing');
      assertEqual(reservedOf(db, 'p5-tee'), reservedBefore, 'O: stock unchanged on repeat sweep');

      // An expired order can never be accepted or fulfilled.
      const list = await api(baseUrl, '/api/shop/admin/orders?status=expired', { headers: owner.authHeader });
      const expiredId = list.data.orders[0].id;
      for (const target of ['accepted', 'preparing']) {
        const res = await api(baseUrl, '/api/shop/admin/orders/' + expiredId + '/status', {
          method: 'PATCH', headers: owner.authHeader, body: { status: target },
        });
        assertEqual(res.status, 409, 'O: expired order cannot move to ' + target);
      }
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_order_reservations WHERE order_id=? AND released_at IS NULL').get(expiredId) as any).n, 0,
        'O: expired order holds nothing');
    }

    console.log('\n--- P: only owner/manager may sweep manually ---');
    {
      for (const [role, auth] of [['cashier', cashier.authHeader], ['server', serverUser.authHeader]]) {
        const res = await api(baseUrl, '/api/shop/admin/reservations/sweep', { method: 'POST', headers: auth as any, body: {} });
        assertEqual(res.status, 403, 'P: ' + role + ' cannot sweep');
      }
    }

    console.log('\n--- Q: concurrent release cannot double-count ---');
    {
      const { res } = await placeOrder(baseUrl, 'p5-tee', 2);
      const id = orderIdOf(db, res.data.order.reference);
      const reservedBefore = reservedOf(db, 'p5-tee');
      // Fire cancel and expiry back to back; exactly one may release.
      const [cancelRes, sweepRes] = await Promise.all([
        api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
          method: 'PATCH', headers: owner.authHeader, body: { status: 'cancelled', reason: 'race test' },
        }),
        api(baseUrl, '/api/shop/admin/reservations/sweep', { method: 'POST', headers: owner.authHeader, body: {} }),
      ]);
      assertEqual(reservedOf(db, 'p5-tee'), reservedBefore - 2, 'Q: released exactly once despite the race');
      assertEqual((db.prepare('SELECT COUNT(*) AS n FROM shop_order_reservations WHERE order_id=? AND released_at IS NULL').get(id) as any).n, 0,
        'Q: no active ledger rows remain');
      const status = (db.prepare('SELECT status FROM shop_orders WHERE id=?').get(id) as any).status;
      assertEqual(['cancelled', 'expired'].includes(status), true, 'Q: ended in a single terminal state');
      assert(cancelRes.status === 200 || sweepRes.status === 200, 'Q: at least one actor succeeded');
    }

    console.log('\n--- R: input validation and safe errors ---');
    {
      // Hostile ids must never 500 or leak internals. The SPA fallback serves
      // HTML for unknown paths, so read the raw response rather than parsing JSON.
      for (const bad of ['..', '%2e%2e', "x'; DROP TABLE shop_orders;--", 'A'.repeat(65), 'a/b', 'a%22b']) {
        const res = await fetch(baseUrl + '/api/shop/admin/orders/' + bad, { headers: owner.authHeader });
        const body = await res.text();
        assert(res.status < 500, 'R: hostile id "' + bad.slice(0, 14) + '" must not 500 (got ' + res.status + ')');
        assert(!/SQLITE_|at Object\.|node_modules/.test(body), 'R: hostile id leaks no internals');
      }
      for (const query of ['limit=abc', 'limit=-1', 'limit=0', 'limit=9999', 'offset=-1', 'status=bogus', 'payment_status=bogus']) {
        const res = await api(baseUrl, '/api/shop/admin/orders?' + query, { headers: owner.authHeader });
        assertEqual(res.status, 400, 'R: ?' + query + ' rejected');
      }
      assert((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='shop_orders'").get() as any).n === 1,
        'R: shop_orders table intact');
      const missing = await api(baseUrl, '/api/shop/admin/orders/nope-does-not-exist', { headers: owner.authHeader });
      assertEqual(missing.status, 404, 'R: unknown order 404');
      assertEqual(JSON.stringify(missing.data).includes('SQLITE'), false, 'R: no SQL detail leaked');
    }

    console.log('\n--- S: public endpoints cannot alter order or payment status ---');
    {
      const { client, res } = await placeOrder(baseUrl, 'p5-tee', 1);
      const id = orderIdOf(db, res.data.order.reference);
      // Reuse the guest cookie against every admin mutation.
      for (const [method, path, body] of [
        ['PATCH', '/api/shop/admin/orders/' + id + '/status', { status: 'accepted' }],
        ['POST', '/api/shop/admin/orders/' + id + '/payment', { action: 'verified', utr_reference: 'ABC123456' }],
        ['POST', '/api/shop/admin/reservations/sweep', {}],
      ]) {
        const attempt = await client.post(path, body);
        assert(attempt.status === 401 || attempt.status === 403, 'S: guest ' + method + ' ' + path + ' refused (' + attempt.status + ')');
      }
      assertEqual((db.prepare('SELECT status FROM shop_orders WHERE id=?').get(id) as any).status, 'pending_review',
        'S: status unchanged');
      assertEqual((db.prepare('SELECT payment_status FROM shop_orders WHERE id=?').get(id) as any).payment_status, 'unverified',
        'S: payment unchanged');
    }

    console.log('\n--- T: in-store POS stock behaviour is unaffected ---');
    {
      // Online holds reduce AVAILABLE stock, never physical stock.
      const stockTeeBefore = stockOf(db, 'p5-tee');
      const { res } = await placeOrder(baseUrl, 'p5-tee', 3);
      const id = orderIdOf(db, res.data.order.reference);
      const stock = stockOf(db, 'p5-tee');
      const reserved = reservedOf(db, 'p5-tee');
      assert(reserved >= 3, 'T: online hold present');
      assertEqual(stock, stockTeeBefore, 'T: physical stock untouched by online checkout');

      // Cancelling restores availability without touching physical stock.
      await api(baseUrl, '/api/shop/admin/orders/' + id + '/status', {
        method: 'PATCH', headers: owner.authHeader, body: { status: 'cancelled', reason: 'stock test' },
      });
      assertEqual(stockOf(db, 'p5-tee'), stockTeeBefore, 'T: physical stock still untouched after cancel');
      assertEqual(reservedOf(db, 'p5-tee'), reserved - 3, 'T: availability restored');

      // A POS sale still works on the same product and writes a normal movement.
      const { createApp: _c } = { createApp };
      const posOrdersRoutes = require('../main/routes/orders');
      const stockRoutes = require('../main/routes/products');
      // The POS order route validates the order type against the tenant's
      // business type; fashion retail uses offline/online.
      db.prepare("UPDATE settings SET value = 'fashion_retail' WHERE key = 'business_type'").run();
      const posApp = createApp({ '/api/orders': posOrdersRoutes.orderRoutes, '/api/products': stockRoutes.productRoutes });
      const posStarted = await startServer(posApp);
      const created = await api(posStarted.baseUrl, '/api/orders', {
        method: 'POST', headers: owner.authHeader,
        body: {
          type: 'offline',
          items: [{ product_id: 'p5-tee', quantity: 2, price: 1499 }],
        },
      });
      await new Promise((r) => posStarted.server.close(r));
      assertEqual(created.status, 201, 'T: POS sale still accepted');
      assertEqual(stockOf(db, 'p5-tee'), stockTeeBefore - 2, 'T: POS sale decremented physical stock only');
      assertEqual((db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='order'").get() as any).n, 1,
        'T: POS sale recorded its own movement, separate from the online one');
    }

    console.log('\n--- U: online revenue never enters POS revenue queries ---');
    {
      // The exact query the X/Z report uses must stay at zero.
      const revenue = db.prepare(
        "SELECT COALESCE(SUM(paid_amount), 0) AS total FROM bills WHERE payment_status = 'paid' AND paid_at >= ? AND paid_at < ?",
      ).get(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString()) as any;
      assertEqual(Number(revenue.total), 0, 'U: X/Z revenue untouched by online orders');
      const completed = (db.prepare("SELECT COUNT(*) AS n FROM shop_orders WHERE status='completed'").get() as any).n;
      assert(completed >= 1, 'U: online revenue exists in the online schema');
    }

    console.log('\n--- V: available stock accounts for active reservations ---');
    {
      const { res } = await placeOrder(baseUrl, 'p5-tee', 2);
      const row = db.prepare('SELECT stock_quantity, shop_reserved_quantity FROM products WHERE id=?').get('p5-tee') as any;
      const available = Number(row.stock_quantity) - Number(row.shop_reserved_quantity);
      assertEqual(available >= 0, true, 'V: available stock is not negative');
      const detail = await api(baseUrl, '/api/shop/admin/orders?status=pending_review', { headers: owner.authHeader });
      assertEqual(detail.data.orders.length >= 1, true, 'V: pending orders visible for stock awareness');
    }

  } finally {
    await new Promise((resolve) => server?.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(results.passed + '/' + results.total + ' passed, ' + results.failed + ' failed');
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
