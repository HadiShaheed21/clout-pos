import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inventory-business-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'inventory-business-test-secret';

const express = require('express');
const jwt = require('jsonwebtoken');
const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
const { productRoutes } = require('../main/routes/products');
const { purchaseRoutes } = require('../main/routes/purchases');
const { expenseRoutes } = require('../main/routes/expenses');
const { reportRoutes } = require('../main/routes/reports');

async function run(): Promise<void> {
  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('inventory-owner', 'Owner', 'inventory-owner@flo.test', 'hash', 'owner', 1, datetime('now'), datetime('now'))`).run();
  const token = jwt.sign({ userId: 'inventory-owner', role: 'owner' }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.user = jwt.verify(req.get('Authorization')!.slice(7), process.env.JWT_SECRET); next(); });
  app.use('/products', productRoutes);
  app.use('/purchases', purchaseRoutes);
  app.use('/expenses', expenseRoutes);
  app.use('/reports', reportRoutes);
  const request = require('supertest');

  try {
    const created = await request(app).post('/products').set('Authorization', `Bearer ${token}`).send({
      name: 'Premium Beans', price: 10, quality: 'Grade A', track_inventory: true, stock_quantity: 5, low_stock_threshold: 2,
    });
    assert.equal(created.status, 201);
    const productId = created.body.product.id;
    assert.equal(created.body.product.quality, 'Grade A');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = ? AND movement_type = ?').get(productId, 'opening').count, 1);

    const edited = await request(app).put(`/products/${productId}`).set('Authorization', `Bearer ${token}`).send({ name: 'Premium Beans 2', stock_quantity: 999 });
    assert.equal(edited.status, 200);
    assert.equal(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity, 5, 'product edits do not mutate stock');

    const purchase = await request(app).post('/purchases').set('Authorization', `Bearer ${token}`).send({
      supplier: 'Bean supplier', items: [{ product_id: productId, quantity: 3, unit_cost: 6 }],
    });
    assert.equal(purchase.status, 201);
    assert.equal(db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity, 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = ? AND movement_type = ?').get(productId, 'purchase').count, 1);

    const expense = await request(app).post('/expenses').set('Authorization', `Bearer ${token}`).send({ amount: 125.5, category: 'Utilities', description: 'Electricity', expense_date: '2026-09-27' });
    assert.equal(expense.status, 201);
    const listed = await request(app).get('/expenses?start_date=2026-09-27&end_date=2026-09-27').set('Authorization', `Bearer ${token}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 125.5);
    const summary = await request(app).get('/reports/business-summary?date=2026-09-27').set('Authorization', `Bearer ${token}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.expenses, 125.5, 'business summary includes only active expenses for its date');
    assert.equal(summary.body.inventory.total_products, 1, 'business summary includes inventory counts');
    const voided = await request(app).post(`/expenses/${expense.body.expense.id}/void`).set('Authorization', `Bearer ${token}`).send({ reason: 'Entered twice' });
    assert.equal(voided.status, 200);
    assert.equal((await request(app).get('/expenses').set('Authorization', `Bearer ${token}`)).body.expenses.length, 0, 'voided expenses stay out of active totals');
    console.log('✅ Inventory, purchase, expense, and quality foundation tests passed');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exit(1); });
