import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fashion-retail-orders-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api,
  closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');

async function run(): Promise<void> {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'shirts', 'Shirts');
  seedProduct(db, 'shirt-001', 'shirts', 'Cotton Shirt', 1299);
  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);

  const createOrder = (body: Record<string, unknown>) => api(baseUrl, '/api/orders', {
    method: 'POST', headers: authHeader, body: { items: [{ product_id: 'shirt-001', quantity: 1 }], ...body },
  });

  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_type', 'fashion_retail', ?)").run(now());

    const offline = await createOrder({ type: 'offline' });
    assert.equal(offline.status, 201, 'retail accepts an offline sale');
    assert.equal(offline.data.order.type, 'offline');

    const online = await createOrder({ type: 'online', online_platform: 'future-store', external_order_id: 'future-001' });
    assert.equal(online.status, 201, 'retail retains the future-compatible online order source');

    for (const type of ['dine_in', 'takeaway', 'delivery']) {
      const response = await createOrder({ type });
      assert.equal(response.status, 400, `retail rejects ${type} creation`);
    }

    const tableAttempt = await createOrder({ type: 'offline', table_id: 'legacy-table' });
    assert.equal(tableAttempt.status, 400, 'retail rejects table workflow fields');

    const guestAttempt = await createOrder({ type: 'offline', guest_count: 1 });
    assert.equal(guestAttempt.status, 400, 'retail rejects Pax workflow fields');

    db.prepare("UPDATE settings SET value = 'restaurant', updated_at = ? WHERE key = 'business_type'").run(now());
    const restaurant = await createOrder({ type: 'dine_in', guest_count: 2 });
    assert.equal(restaurant.status, 201, 'restaurant installations retain dine-in compatibility');
    const invalidRestaurantType = await createOrder({ type: 'offline' });
    assert.equal(invalidRestaurantType.status, 400, 'restaurant installations do not accept retail-only order types');

    console.log('✅ Fashion retail order-type tests passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
