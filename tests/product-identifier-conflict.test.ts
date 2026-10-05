/**
 * Integration Test: duplicate catalog identifier conflicts on product create.
 *
 * Regression for the POST /api/products error mapping: a SKU or barcode that
 * is already reserved in catalog_identifier_assignments makes reserveIdentifier
 * throw a 409. The route previously swallowed that into a generic 500; it must
 * surface the conflict as 409 (matching the PUT /api/products/:id handler).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/product-identifier-conflict.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-identifier-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-product-identifier';

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { productRoutes } = require('../main/routes/products');
const { catalogueRoutes } = require('../main/routes/catalogue');

function productCount(db: any, name: string): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM products WHERE name = ?').get(name) as any).count;
}

async function main() {
  console.log('Integration Test: product identifier conflicts on create');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-id', 'Clothing');
  seedProduct(db, 'id-variant-shirt', 'cat-id', 'Variant Shirt', 100, { track_inventory: true, stock_quantity: 2 });

  const app = createApp({ '/api/products': productRoutes, '/api/catalogue': catalogueRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Scenario A: duplicate SKU on create returns 409, not 500 ───');
    {
      const first = await api(baseUrl, '/api/products', {
        method: 'POST', headers: authHeader,
        body: { category_id: 'cat-id', name: 'SKU Owner', price: 10, sku: 'DUP-SKU-1' },
      });
      assertEqual(first.status, 201, 'A: first product with the SKU is created');

      const duplicate = await api(baseUrl, '/api/products', {
        method: 'POST', headers: authHeader,
        body: { category_id: 'cat-id', name: 'SKU Thief', price: 10, sku: 'DUP-SKU-1' },
      });
      assertEqual(duplicate.status, 409, `A: duplicate SKU is a 409 conflict (got ${duplicate.status}, ${JSON.stringify(duplicate.data)})`);
      assert(!!duplicate.data.error, 'A: conflict response carries an error message');
      assertEqual(productCount(db, 'SKU Thief'), 0, 'A: rejected create rolled back and inserted no product');
    }

    console.log('\n─── Scenario B: product barcode colliding with a variant barcode returns 409 ───');
    {
      const converted = await api(baseUrl, '/api/catalogue/products/id-variant-shirt/convert-to-variants', {
        method: 'POST', headers: authHeader,
        body: {
          option_groups: [{ name: 'Size', values: ['M'] }],
          variants: [{ options: { Size: 'M' }, barcode: 'VAR-BC-1', stock_quantity: 2 }],
        },
      });
      assertEqual(converted.status, 201, 'B: product is converted to a variant carrying the barcode');

      const duplicate = await api(baseUrl, '/api/products', {
        method: 'POST', headers: authHeader,
        body: { category_id: 'cat-id', name: 'Barcode Thief', price: 10, barcode: 'VAR-BC-1' },
      });
      assertEqual(duplicate.status, 409, `B: barcode already held by a variant is a 409 conflict (got ${duplicate.status}, ${JSON.stringify(duplicate.data)})`);
      assert(!!duplicate.data.error, 'B: conflict response carries an error message');
      assertEqual(productCount(db, 'Barcode Thief'), 0, 'B: rejected create rolled back and inserted no product');
    }

    console.log('\n─── Scenario C: duplicate product barcode keeps its dedicated 400 ───');
    {
      const first = await api(baseUrl, '/api/products', {
        method: 'POST', headers: authHeader,
        body: { category_id: 'cat-id', name: 'Barcode Owner', price: 10, barcode: 'PROD-BC-1' },
      });
      assertEqual(first.status, 201, 'C: first product with the barcode is created');

      const duplicate = await api(baseUrl, '/api/products', {
        method: 'POST', headers: authHeader,
        body: { category_id: 'cat-id', name: 'Barcode Thief 2', price: 10, barcode: 'PROD-BC-1' },
      });
      assertEqual(duplicate.status, 400, 'C: duplicate product barcode still rejected as an ambiguous scan (400)');
      assertEqual(productCount(db, 'Barcode Thief 2'), 0, 'C: rejected create inserted no product');
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
