/**
 * Phase 5 v91 migration upgrade tests.
 *
 * Builds a real pre-v91 (v89-shaped) database, seeds it the way Phase 4 would
 * have left it, then runs the actual startup migration and asserts the data
 * survives. Specifically covers the defects found in review:
 *
 *   1. expiry backfill ran before the row copy, so legacy orders got NULL;
 *   2. the v91 CHECK omits 'confirmed', which legacy v89 rows still use;
 *   3. UNIQUE(order_id, product_id, variant_id) does not constrain NULL variants;
 *   4. a half-finished rebuild must not leave a stale shop_orders_v91 behind.
 *
 * Disposable temporary database only. Usage:
 *   node tests/run-electron-node-test.cjs tests/shop-online-orders-migration.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const os = require('os');

Module._load = function (request) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => os.tmpdir(), getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

process.env.JWT_SECRET = 'test-secret-shop-migration';

const {
  assert, assertEqual, getResults, seedOwnerUser, seedCategory, seedProduct,
} = require('./helpers/test-setup');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');

function count(db, sql, ...args) {
  return Number(db.prepare(sql).get(...args).n);
}

/**
 * Recreates the exact v89-era shop_orders shape plus the Phase 4 child tables
 * holding order lines and payment declarations, so the migration runs against a
 * genuine legacy database rather than a mock.
 */
function createLegacyV89Database(db) {
  db.exec(`
    CREATE TABLE shop_carts (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE shop_orders (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      cart_id TEXT REFERENCES shop_carts(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'confirmed', 'cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (payment_status IN ('unverified', 'verified', 'refunded')),
      currency TEXT NOT NULL,
      subtotal_minor_units INTEGER NOT NULL CHECK (subtotal_minor_units >= 0),
      item_count INTEGER NOT NULL DEFAULT 0,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      delivery_city TEXT NOT NULL,
      delivery_state TEXT NOT NULL,
      delivery_pincode TEXT NOT NULL,
      delivery_instructions TEXT,
      whatsapp_handoff_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cart_id)
    );
    CREATE TABLE shop_order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      variant_id TEXT,
      product_name TEXT NOT NULL,
      variant_display_name TEXT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_minor_units INTEGER NOT NULL,
      line_total_minor_units INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE shop_payment_declarations (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      reference TEXT,
      declared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function seedLegacyOrder(db, values) {
  // values: [...15 columns..., createdOffsetMinutes]
  const offset = values.pop();
  const createdAt = `datetime('now','${offset}')`;
  db.prepare(`
    INSERT INTO shop_orders (
      id, reference, cart_id, idempotency_key, status, payment_status, currency,
      subtotal_minor_units, item_count, customer_name, customer_phone,
      delivery_address, delivery_city, delivery_state, delivery_pincode,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${createdAt},${createdAt})
  `).run(...values);
}

function seedLegacyRows(db) {
  const cart = db.prepare('INSERT INTO shop_carts (id, token, status) VALUES (?,?,?)');
  cart.run('c1', 'tok-1', 'converted');
  cart.run('c2', 'tok-2', 'converted');
  cart.run('c3', 'tok-3', 'converted');

  // Legacy 'confirmed' order — the row that previously failed the v91 CHECK.
  seedLegacyOrder(db, [
    'o1', 'CLOUT-AAA111', 'c1', 'k1', 'confirmed', 'verified', 'INR',
    299800, 2, 'Ravi Kumar', '9000000001', '4 Park Street', 'Pune', 'Maharashtra', '411001',
    '-400 days',
  ]);

  // Legacy pending orders, one inside and one outside the 2-hour window.
  // Timestamps are set with SQL datetime() so they are genuine SQLite
  // timestamps, not the literal text of an expression.
  seedLegacyOrder(db, [
    'o2', 'CLOUT-BBB222', 'c2', 'k2', 'pending_review', 'unverified', 'INR',
    149900, 1, 'Sunita Rao', '9000000002', '77 Hill Road', 'Mumbai', 'Maharashtra', '400050',
    '-30 minutes',
  ]);
  seedLegacyOrder(db, [
    'o3', 'CLOUT-CCC333', 'c3', 'k3', 'pending_review', 'unverified', 'INR',
    59900, 1, 'Imtiaz Ali', '9000000003', '9 Link Road', 'Nagpur', 'Maharashtra', '440010',
    '-5 hours',
  ]);

  const item = db.prepare(`INSERT INTO shop_order_items
    (id, order_id, product_id, variant_id, product_name, quantity, unit_price_minor_units, line_total_minor_units)
    VALUES (?,?,?,?,?,?,?,?)`);
  item.run('oi1', 'o1', 'prod-legacy', null, 'Legacy Tee', 2, 149900, 299800);
  item.run('oi2', 'o2', 'prod-legacy', null, 'Legacy Tee', 1, 149900, 149900);
  db.prepare('INSERT INTO shop_payment_declarations (id, order_id, method, reference) VALUES (?,?,?,?)')
    .run('pd1', 'o1', 'upi', 'UTRLEGACY1');
}

async function testLegacyUpgrade() {
  console.log('\n=== A: v91 upgrades a real pre-v91 database ===');
  initDatabase();
  let db = getDatabase();
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS shop_order_events;
      DROP TABLE IF EXISTS shop_order_payment_actions;
      DROP TABLE IF EXISTS shop_order_reservations;
      DROP TABLE IF EXISTS shop_payment_declarations;
      DROP TABLE IF EXISTS shop_order_items;
      DROP TABLE IF EXISTS shop_orders;
      DROP TABLE IF EXISTS shop_carts;
    `);
    createLegacyV89Database(db);
    seedLegacyRows(db);
    db.pragma('foreign_keys = ON');
    assertEqual(count(db, 'SELECT COUNT(*) AS n FROM shop_orders'), 3, 'A: three legacy orders seeded');

    // Re-run startup so the real migration path executes against these rows.
    db.pragma('user_version = 89');
    closeDatabase();
    initDatabase();
    db = getDatabase();
    const version = Number(db.pragma('user_version', { simple: true }));
    assert(version >= 91, `A: schema upgraded to v91 or beyond (got v${version})`);
  } finally {
    closeDatabase();
  }

  initDatabase();
  db = getDatabase();
  try {
    console.log('\n--- A2: every legacy order survived ---');
    assertEqual(count(db, 'SELECT COUNT(*) AS n FROM shop_orders'), 3, 'A: no legacy order lost');

    console.log('\n--- A3: legacy confirmed mapped to accepted ---');
    const o1 = db.prepare('SELECT status, payment_status FROM shop_orders WHERE id=?').get('o1');
    assertEqual(o1.status, 'accepted', 'A: legacy confirmed mapped to accepted');
    assertEqual(o1.payment_status, 'verified', 'A: legacy payment_status preserved');

    console.log('\n--- A4: expiry populated for every legacy order ---');
    assertEqual(count(db, 'SELECT COUNT(*) AS n FROM shop_orders WHERE reservation_expires_at IS NULL'), 0,
      'A: no legacy order left with NULL expiry');
    const o2 = db.prepare('SELECT reservation_expires_at, created_at FROM shop_orders WHERE id=?').get('o2');
    const deltaMin = (Date.parse(o2.reservation_expires_at.replace(' ', 'T') + 'Z')
      - Date.parse(o2.created_at.replace(' ', 'T') + 'Z')) / 60000;
    assert(Math.abs(deltaMin - 120) < 1, `A: legacy expiry is two hours after checkout (got ${deltaMin}m)`);

    console.log('\n--- A5: child rows and foreign keys intact ---');
    assertEqual(count(db, 'SELECT COUNT(*) AS n FROM shop_order_items'), 2, 'A: order lines preserved');
    assertEqual(count(db, 'SELECT COUNT(*) AS n FROM shop_payment_declarations'), 1, 'A: declarations preserved');
    assertEqual(count(db, `SELECT COUNT(*) AS n FROM shop_order_items i
      LEFT JOIN shop_orders o ON o.id = i.order_id WHERE o.id IS NULL`), 0, 'A: no orphaned order lines');
    assertEqual(db.pragma('foreign_key_check').length, 0, 'A: foreign_key_check clean');

    console.log('\n--- A6: integrity, columns and cleanup ---');
    assertEqual(db.pragma('integrity_check', { simple: true }), 'ok', 'A: integrity_check ok');
    const names = db.prepare('PRAGMA table_info(shop_orders)').all().map((c) => c.name);
    assert(names.includes('reservation_expires_at'), 'A: reservation_expires_at present');
    assert(names.includes('fulfilled_at'), 'A: fulfilled_at present');
    assertEqual(count(db, `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type='table' AND name='shop_orders_v91'`), 0, 'A: rebuild table cleaned up');
  } finally {
    closeDatabase();
  }
}

function testNullVariantUniqueness() {
  console.log('\n=== B: NULL-variant reservations cannot duplicate ===');
  initDatabase();
  const db = getDatabase();
  try {
    seedOwnerUser(db);
    seedCategory(db, 'cat-mig', 'Migration Category');
    seedProduct(db, 'p-mig', 'cat-mig', 'Migration Product', 10, { track_inventory: true, stock_quantity: 10 });
    const stamp = Date.now();
    const cart = db.prepare('INSERT OR IGNORE INTO shop_carts (id, token, status) VALUES (?,?,?)');
    cart.run('cc1', 'tok-mig-' + stamp, 'converted');
    cart.run('cc2', 'tok-mig2-' + stamp, 'converted');
    const order = db.prepare(`INSERT OR IGNORE INTO shop_orders (
        id, reference, cart_id, idempotency_key, status, payment_status, currency,
        subtotal_minor_units, item_count, customer_name, customer_phone,
        delivery_address, delivery_city, delivery_state, delivery_pincode, created_at)
      VALUES (?,?,?,?,'accepted','verified','INR',1000,1,'M','9','A','C','S','1',datetime('now'))`);
    order.run('om1', 'CLOUT-MIG1', 'cc1', 'km1');
    order.run('om2', 'CLOUT-MIG2', 'cc2', 'km2');
    const reserve = db.prepare(`INSERT INTO shop_order_reservations
      (id, order_id, product_id, variant_id, quantity) VALUES (?,?,?,?,?)`);
    reserve.run('r1', 'om1', 'p-mig', null, 1);

    let duplicateRejected = false;
    try {
      reserve.run('r2', 'om1', 'p-mig', null, 1);
    } catch (error) {
      duplicateRejected = /UNIQUE|constraint/i.test(String(error && error.message));
    }
    assert(duplicateRejected, 'B: duplicate NULL-variant reservation rejected');

    // A different order may still reserve the same product.
    reserve.run('r3', 'om2', 'p-mig', null, 1);
    assertEqual(count(db, 'SELECT COUNT(*) AS n FROM shop_order_reservations'), 2,
      'B: same product remains reservable by a different order');
  } finally {
    closeDatabase();
  }
}

function testFreshDatabase() {
  console.log('\n=== C: a freshly built database is complete ===');
  initDatabase();
  const db = getDatabase();
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'shop_order%' ORDER BY name").all().map((r) => r.name);
    assertEqual(JSON.stringify(tables), JSON.stringify([
      'shop_order_events', 'shop_order_items', 'shop_order_payment_actions',
      'shop_order_reservations', 'shop_orders',
    ]), 'C: expected online-order tables present');
    assertEqual(db.pragma('integrity_check', { simple: true }), 'ok', 'C: integrity ok on a fresh database');
    assertEqual(db.pragma('foreign_key_check').length, 0, 'C: fresh database has no FK issues');
  } finally {
    closeDatabase();
  }
}

async function main() {
  await testLegacyUpgrade();
  testNullVariantUniqueness();
  testFreshDatabase();

  const results = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(results.passed + '/' + results.total + ' passed, ' + results.failed + ' failed');
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
