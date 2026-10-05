const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fashion-catalogue-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, resetCounters, closeDatabase,
} = require('./helpers/test-setup');

async function main() {
  resetCounters();
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-fashion', 'Clothing');
  seedProduct(db, 'shirt-1', 'cat-fashion', 'Oxford Shirt', 1200, { track_inventory: true, stock_quantity: 6, barcode: 'CLOUT-SHIRT-1' });
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_type', 'fashion_retail', ?)").run(new Date().toISOString());
  const { catalogueRoutes } = require('../main/routes/catalogue');
  const { orderRoutes } = require('../main/routes/orders');
  const { purchaseRoutes } = require('../main/routes/purchases');
  const { billRoutes } = require('../main/routes/bills');
  const { refundRoutes } = require('../main/routes/refunds');
  const { productRoutes } = require('../main/routes/products');
  const app = createApp({ '/api/catalogue': catalogueRoutes, '/api/orders': orderRoutes, '/api/purchases': purchaseRoutes, '/api/products': productRoutes, '/api/bills': billRoutes, '/api/refunds': refundRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const converted = await api(baseUrl, '/api/catalogue/products/shirt-1/convert-to-variants', {
      method: 'POST', headers: authHeader,
      body: {
        option_groups: [{ name: 'Size', values: ['M', 'L'] }, { name: 'Colour', values: [{ label: 'Navy', color_hex: '#172554' }, { label: 'Red', color_hex: '#b91c1c' }] }],
        variants: [
          { options: { Size: 'M', Colour: 'Navy' }, sku: 'CLOUT-SHIRT-NAVY-M', barcode: 'CLOUT-NM', stock_quantity: 2, low_stock_threshold: 1 },
          { options: { Size: 'L', Colour: 'Navy' }, sku: 'CLOUT-SHIRT-NAVY-L', barcode: 'CLOUT-NL', stock_quantity: 4, low_stock_threshold: 1 },
        ],
      },
    });
    assertEqual(converted.status, 201, 'owner converts exact parent stock into variants');
    const variants = converted.data.variants;
    assertEqual(variants.length, 2, 'two variants were created');
    const navyMedium = variants.find((variant: any) => variant.sku === 'CLOUT-SHIRT-NAVY-M');
    assert(Boolean(navyMedium), 'the SKU identifies the intended variant independent of row order');
    assertEqual(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('shirt-1').stock_quantity, 0, 'parent stock is zero after conversion');
    assertEqual(db.prepare('SELECT variant_mode FROM products WHERE id = ?').get('shirt-1').variant_mode, 1, 'product is marked variant-managed');

    const parentStockBefore = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('shirt-1').stock_quantity;
    const ownerParentAdjustment = await api(baseUrl, '/api/products/shirt-1/stock', { method: 'POST', headers: authHeader, body: { action: 'increase', quantity: 1 } });
    assertEqual(ownerParentAdjustment.status, 409, 'owner cannot adjust variant-managed parent stock directly');
    const managerParentAdjustment = await api(baseUrl, '/api/products/shirt-1/stock', { method: 'POST', headers: manager.authHeader, body: { action: 'increase', quantity: 1 } });
    assertEqual(managerParentAdjustment.status, 409, 'manager cannot adjust variant-managed parent stock directly');
    assertEqual(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('shirt-1').stock_quantity, parentStockBefore, 'rejected parent adjustments do not change inventory');
    assertEqual((db.prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = ? AND reference_type = 'manual_adjustment'").get('shirt-1') as any).count, 0, 'rejected parent adjustments do not create stock movements');

    const managerIdentifierEdit = await api(baseUrl, `/api/catalogue/variants/${navyMedium.id}`, { method: 'PATCH', headers: manager.authHeader, body: { sku: 'MANAGER-CANNOT-REASSIGN' } });
    assertEqual(managerIdentifierEdit.status, 403, 'manager cannot reassign a variant identifier');
    const managerCreatesVariant = await api(baseUrl, '/api/catalogue/products/shirt-1/variants', { method: 'POST', headers: manager.authHeader, body: { options: { Size: 'M', Colour: 'Red' }, sku: 'CLOUT-SHIRT-RED-M', barcode: 'CLOUT-RM', stock_quantity: 1 } });
    assertEqual(managerCreatesVariant.status, 201, 'manager can create a new valid option combination');
    const duplicateVariant = await api(baseUrl, '/api/catalogue/products/shirt-1/variants', { method: 'POST', headers: manager.authHeader, body: { options: { Size: 'M', Colour: 'Red' }, stock_quantity: 1 } });
    assertEqual(duplicateVariant.status, 409, 'duplicate option combinations are rejected');

    const missingVariant = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'offline', items: [{ product_id: 'shirt-1', quantity: 1 }] } });
    assertEqual(missingVariant.status, 400, 'variant-managed product cannot be sold without selection');
    const order = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'offline', items: [{ product_id: 'shirt-1', variant_id: navyMedium.id, quantity: 1 }] } });
    assertEqual(order.status, 201, 'selected variant can be sold through retail POS');
    assertEqual(db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(navyMedium.id).stock_quantity, 1, 'sale deducts selected variant stock');
    assertEqual(db.prepare('SELECT variant_id FROM order_items WHERE order_id = ?').get(order.data.order.id).variant_id, navyMedium.id, 'order line snapshots selected variant ID');

    const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', headers: authHeader, body: { order_id: order.data.order.id } });
    const paid = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, { method: 'POST', headers: authHeader, body: { method: 'cash', amount: null } });
    const orderItem = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(order.data.order.id) as any;
    db.prepare("UPDATE order_items SET status = 'ready' WHERE id = ?").run(orderItem.id);
    const stockBeforeRefund = db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(navyMedium.id).stock_quantity;
    const variantRefund = await api(baseUrl, '/api/refunds', { method: 'POST', headers: authHeader, body: { bill_id: paid.data.bill.id, order_item_id: orderItem.id, method: 'cash', override_pin: '1234', manager_id: manager.userId } });
    assertEqual(variantRefund.status, 201, 'eligible variant item refund succeeds');
    assertEqual(db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(navyMedium.id).stock_quantity, stockBeforeRefund, 'variant item refund preserves existing no-restock behavior');
    const refundMirror = db.prepare("SELECT variant_id FROM order_items WHERE order_id = ? AND status = 'void_adjustment'").get(order.data.order.id) as any;
    assertEqual(refundMirror.variant_id, navyMedium.id, 'variant refund mirror preserves immutable variant attribution');

    const purchase = await api(baseUrl, '/api/purchases', { method: 'POST', headers: authHeader, body: { items: [{ product_id: 'shirt-1', variant_id: navyMedium.id, quantity: 3, unit_cost: 700 }] } });
    assertEqual(purchase.status, 201, 'variant purchase is accepted');
    assertEqual(db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(navyMedium.id).stock_quantity, 4, 'purchase adds selected variant stock');

    const managerAttempt = await api(baseUrl, '/api/catalogue/identifiers/barcode/release', { method: 'POST', headers: manager.authHeader, body: { value: 'CLOUT-NM', reason: 'test' } });
    assertEqual(managerAttempt.status, 403, 'manager cannot release an identifier');
    const released = await api(baseUrl, '/api/catalogue/identifiers/barcode/release', { method: 'POST', headers: authHeader, body: { value: 'CLOUT-NM', reason: 'Retiring sample label' } });
    assertEqual(released.status, 200, 'owner can release identifier with audit reason');
    assert((db.prepare("SELECT COUNT(*) AS count FROM catalog_audit_log WHERE action = 'released'").get() as any).count === 1, 'identifier release is audited without image data');

    const image = await api(baseUrl, '/api/catalogue/products/shirt-1/images', { method: 'POST', headers: authHeader, body: { data_uri: 'data:image/png;base64,iVBORw0KGgo=', alt_text: 'Navy Oxford shirt' } });
    assertEqual(image.status, 201, 'gallery image is added through an authenticated internal route');
    const primaryImage = await api(baseUrl, `/api/catalogue/products/shirt-1/images/${image.data.image.id}`, { method: 'PATCH', headers: authHeader, body: { is_primary: true, sort_order: 0 } });
    assertEqual(primaryImage.status, 200, 'gallery primary image can be selected');

    const collection = await api(baseUrl, '/api/catalogue/collections', { method: 'POST', headers: authHeader, body: { name: 'New Arrivals', slug: 'new-arrivals' } });
    assertEqual(collection.status, 201, 'owner creates internal collection');
    const member = await api(baseUrl, `/api/catalogue/collections/${collection.data.collection.id}/products`, { method: 'PUT', headers: authHeader, body: { product_ids: ['shirt-1'] } });
    assertEqual(member.status, 200, 'collection membership is stored internally');
    const noPublicRoute = await api(baseUrl, '/api/public/catalogue', { method: 'GET' });
    assertEqual(noPublicRoute.status, 401, 'no unauthenticated public catalogue route was added');
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  const results = getResults();
  if (results.failed) process.exitCode = 1;
  else console.log(`✅ Fashion catalogue foundation tests passed (${results.passed})`);
}
main().catch((error) => { console.error(error); process.exit(1); });
