/**
 * Phase 4 end-to-end demonstration on a disposable database.
 *
 * Walks the whole customer journey and prints what actually happened: cart,
 * server-derived pricing, pending order creation, stock reservation,
 * idempotent retry, and the privacy properties of the WhatsApp URL.
 *
 * This is a DEMONSTRATION, not an assertion suite (see shop-checkout.test.ts).
 * It contacts no external service and sends no message.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shop-checkout-demo.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shop-demo-'));

Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'demo-secret';

const { initTestDb, createApp, startServer, seedCategory, seedProduct, closeDatabase } = require('./helpers/test-setup');
const { makeShopClient } = require('./helpers/shop-client');
const cartRoutes = require('../main/routes/shop-cart').default;
const checkoutRoutes = require('../main/routes/shop-checkout').default;

const CUSTOMER = {
  name: 'Asha Menon', phone: '9876543210',
  address: '12 Rose Villa, Marine Drive', city: 'Kochi', state: 'Kerala', pincode: '682031',
};

function line(text: string) { console.log('\n== ' + text + ' =='); }

async function main() {
  const db = initTestDb();
  let server: any;
  try {
    seedCategory(db, 'cat-demo', 'Clothing');
    seedProduct(db, 'demo-tee', 'cat-demo', 'Heavyweight Box Tee', 1499, { track_inventory: true, stock_quantity: 12 });
    db.prepare("UPDATE products SET catalog_status='published' WHERE id=?").run('demo-tee');
    seedProduct(db, 'demo-denim', 'cat-demo', 'Rigid Denim', 3200, { track_inventory: true, stock_quantity: 0 });
    db.prepare('UPDATE products SET variant_mode=1, catalog_status=? WHERE id=?').run('published', 'demo-denim');
    db.prepare('INSERT INTO product_option_groups (id, product_id, name, normalized_name, sort_order) VALUES (?,?,?,?,?)').run('og-d','demo-denim','Colour','colour',0);
    db.prepare('INSERT INTO product_option_values (id, option_group_id, label, normalized_label, color_hex, sort_order, is_active) VALUES (?,?,?,?,?,?,?)').run('ov-d','og-d','നീലം','navy','#1B3156',0,1);
    db.prepare('INSERT INTO product_variants (id, product_id, option_signature, display_name, price_override, stock_quantity, track_inventory, is_active) VALUES (?,?,?,?,?,?,?,?)').run('var-d','demo-denim','navy|m','Navy / M',3499,4,1,1);
    db.prepare('INSERT INTO product_variant_option_values (variant_id, option_group_id, option_value_id) VALUES (?,?,?)').run('var-d','og-d','ov-d');
    db.prepare("UPDATE settings SET value='919999999999' WHERE key='shop_whatsapp_number'").run();
    db.prepare("UPDATE settings SET value='paytm.s2x4y1r@pty' WHERE key='shop_upi_id'").run();
    db.prepare("UPDATE settings SET value='Abdul Baeis M V' WHERE key='shop_upi_payee_name'").run();

    const app = createApp({ '/api/shop/checkout': checkoutRoutes, '/api/shop/cart': cartRoutes });
    const started = await startServer(app);
    server = started.server;
    const base = started.baseUrl;

    const posCount = () => ({
      orders: (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n,
      bills: (db.prepare('SELECT COUNT(*) AS n FROM bills').get() as any).n,
      stock_moves: (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as any).n,
    });
    const stockOf = (id: string) => db.prepare('SELECT stock_quantity, shop_reserved_quantity FROM products WHERE id=?').get(id);

    line('1-3. BROWSE AND ADD TO CART');
    const shopper = makeShopClient(base);
    await shopper.get('/api/shop/cart');
    await shopper.post('/api/shop/cart/items', { product_id: 'demo-tee', quantity: 2 });
    await shopper.post('/api/shop/cart/items', { product_id: 'demo-denim', variant_id: 'var-d', quantity: 1 });
    const bag = await shopper.get('/api/shop/cart');
    console.log('cart lines      :', bag.data.items.length);
    console.log('item count      :', bag.data.item_count);
    console.log('server subtotal :', bag.data.subtotal_minor_units, bag.data.currency);

    line('4-7. REVIEW, THEN SUBMIT DELIVERY DETAILS');
    const stockBefore = stockOf('demo-tee');
    const posBefore = posCount();
    console.log('stock before    :', JSON.stringify(stockBefore));

    line('8-10. BACKEND CREATES ONE PENDING ORDER');
    const placed = await shopper.post('/api/shop/checkout', { customer: CUSTOMER });
    console.log('http status     :', placed.status);
    console.log('order reference :', placed.data.order.reference);
    console.log('order status    :', placed.data.order.status);
    console.log('payment status  :', placed.data.order.payment_status);
    console.log('subtotal        :', placed.data.order.subtotal_minor_units);
    for (const item of placed.data.order.items) {
      console.log('  line          :', item.product_name, '|', item.variant_display_name ?? '-',
        '| x' + item.quantity, '| unit', item.unit_price_minor_units, '| total', item.line_total_minor_units);
    }

    line('11-12. STOCK: RESERVED, NOT DECREMENTED');
    console.log('stock after     :', JSON.stringify(stockOf('demo-tee')));
    console.log('sale stock same :', stockOf('demo-tee').stock_quantity === stockBefore.stock_quantity);


    line('STEP 3. QR CODE + UPI PAYMENT DETAILS');
    console.log('upi configured :', placed.data.upi.configured);
    console.log('upi id         :', placed.data.upi.upi_id);
    console.log('payable to     :', placed.data.upi.payee_name);
    console.log('exact amount   :', placed.data.upi.amount_minor_units, '(minor units)');
    console.log('qr is real png :', /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(placed.data.upi.qr_data_url || ''));
    console.log('qr bytes       :', (placed.data.upi.qr_data_url || '').length, 'chars');
    console.log('upi intent     :', decodeURIComponent(placed.data.upi.upi_intent_url || ''));

    line('STEP 5. PAYMENT DECLARATION (stays unverified)');
    console.log('before         : declared=' + placed.data.order.payment_declared + ' payment_status=' + placed.data.order.payment_status);
    const declared = await shopper.post('/api/shop/checkout/declaration', { declared: true, reference: '412345678901' });
    console.log('after declare  : declared=' + declared.data.payment_declared + ' payment_status=' + declared.data.payment_status);
    console.log('order status   :', declared.data.order.status);
    console.log('db row         :', JSON.stringify(db.prepare('SELECT payment_status FROM shop_orders WHERE reference=?').get(placed.data.order.reference)));

    line('13-15. RETRY WITH SAME ATTEMPT');
    const retry = await shopper.post('/api/shop/checkout', { customer: CUSTOMER });
    console.log('retry http      :', retry.status);
    console.log('replayed        :', retry.data.replayed);
    console.log('same reference  :', retry.data.order.reference === placed.data.order.reference);
    console.log('total orders    :', (db.prepare('SELECT COUNT(*) AS n FROM shop_orders').get() as any).n);
    console.log('payment status  :', (db.prepare('SELECT payment_status FROM shop_orders WHERE reference=?').get(placed.data.order.reference) as any).payment_status);

    line('16-17. WHATSAPP URL (privacy checked, nothing sent)');
    const url = placed.data.order.whatsapp_url;
    const text = decodeURIComponent(url.split('text=')[1]);
    const text2 = decodeURIComponent(declared.data.order.whatsapp_url.split('text=')[1]);
    console.log(text);
    console.log('---');
    // Contact details are shared with staff ON PURPOSE so the order can be
    // fulfilled. What must never appear is any credential or session material.
    console.log('shares name/phone/address :', text.includes('Asha Menon') && text.includes('+919876543210') && text.includes('Marine Drive'));
    console.log('leaks cart/csrf/token     :', /clout_cart|csrf|eyJ[A-Za-z0-9_-]{10,}/i.test(url));

    line('19. POS RECORDS UNCHANGED');
    console.log('before :', JSON.stringify(posBefore));
    console.log('after  :', JSON.stringify(posCount()));

    line('POST-DECLARATION WHATSAPP MESSAGE');
    console.log(text2);

    line('SUMMARY');
    console.log('pending order created, stock reserved, UPI QR shown, declaration recorded,');
    console.log('payment still unverified, no POS records touched.');
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
