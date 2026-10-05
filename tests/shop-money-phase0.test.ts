/**
 * Phase 0 ecommerce foundation tests — money, pricing and availability.
 *
 * Runs entirely against a disposable temporary database; it never touches the
 * live POS database. Verifies integer-paise derivation, price-override
 * precedence and coarse availability WITHOUT writing to any product row.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shop-money-phase0.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shop-money-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-shop-money-phase0';

const {
  initTestDb, seedOwnerUser, seedCategory, seedProduct,
  assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const {
  rupeesToMinorUnits, minorUnitsToRupees, isRepresentableInMinorUnits,
  multiplyMinorUnits, sumMinorUnits,
} = require('../main/services/shop-money');
const {
  resolvePriceMinorUnits, resolveAvailability, rollUpAvailability, lowestPriceMinorUnits,
} = require('../main/services/shop-pricing');

async function main() {
  console.log('Phase 0 ecommerce foundation tests');
  console.log('='.repeat(60));

  const db = initTestDb();
  seedOwnerUser(db);
  seedCategory(db, 'cat-shop-money', 'Clothing');

  try {
    console.log('\n--- A: rupees -> integer minor units (INR) ---');
    assertEqual(rupeesToMinorUnits(1499, 'INR'), 149900, 'A: 1499 -> 149900 paise');
    assertEqual(rupeesToMinorUnits(0, 'INR'), 0, 'A: zero price is representable');
    assertEqual(rupeesToMinorUnits(0.5, 'INR'), 50, 'A: fractional rupee converts to paise');
    assertEqual(rupeesToMinorUnits(1499.99, 'INR'), 149999, 'A: two-decimal value is exact');
    assertEqual(rupeesToMinorUnits(1500, 'JPY'), 1500, 'A: JPY (0 decimals) factor is 1');

    console.log('\n--- B: unrepresentable / unsafe money refused, never coerced ---');
    assertEqual(rupeesToMinorUnits(10.005, 'INR'), null, 'B: sub-paise value refused');
    assertEqual(rupeesToMinorUnits(-1, 'INR'), null, 'B: negative refused');
    assertEqual(rupeesToMinorUnits(NaN, 'INR'), null, 'B: NaN refused');
    assertEqual(rupeesToMinorUnits(Infinity, 'INR'), null, 'B: Infinity refused');
    assertEqual(rupeesToMinorUnits('1499', 'INR'), null, 'B: string input refused');
    assertEqual(rupeesToMinorUnits(null, 'INR'), null, 'B: null refused');
    assertEqual(isRepresentableInMinorUnits(1499, 'INR'), true, 'B: whole rupee representable');
    assertEqual(isRepresentableInMinorUnits(10.005, 'INR'), false, 'B: sub-paise flagged unrepresentable');

    console.log('\n--- C: round-trip and integer-only arithmetic ---');
    assertEqual(minorUnitsToRupees(149900, 'INR'), 1499, 'C: paise -> rupees round trip');
    assertEqual(sumMinorUnits([10, 20]), 30, 'C: integer sum has no float drift');
    assertEqual(multiplyMinorUnits(149900, 3), 449700, 'C: unit price * quantity exact');
    assertEqual(multiplyMinorUnits(149900, -1), null, 'C: negative quantity refused');
    assertEqual(sumMinorUnits([1.5]), null, 'C: non-integer minor unit refused');

    console.log('\n--- D: price selection honours variant override, nullish ---');
    assertEqual(resolvePriceMinorUnits({ price: 1499 }, null, 'INR').minorUnits, 149900, 'D: product price when no variant');
    assertEqual(resolvePriceMinorUnits({ price: 1499 }, { price_override: 2000 }, 'INR').minorUnits, 200000, 'D: variant override wins');
    assertEqual(resolvePriceMinorUnits({ price: 1499 }, { price_override: 0 }, 'INR').minorUnits, 0, 'D: zero override respected (not falsy)');
    assertEqual(resolvePriceMinorUnits({ price: 1499 }, { price_override: null }, 'INR').source, 'product_price', 'D: null override falls back to product');
    assertEqual(resolvePriceMinorUnits({ price: 1499 }, { price_override: 2000 }, 'INR').source, 'variant_override', 'D: price source reported');
    assertEqual(resolvePriceMinorUnits({ price: 10.005 }, null, 'INR'), null, 'D: unrepresentable product price withheld');

    console.log('\n--- E: coarse availability buckets (no exact counts) ---');
    assertEqual(resolveAvailability({ is_active: 1, stock_quantity: 12, low_stock_threshold: 3, track_inventory: 1 }), 'in_stock', 'E: well-stocked in_stock');
    assertEqual(resolveAvailability({ is_active: 1, stock_quantity: 2, low_stock_threshold: 3, track_inventory: 1 }), 'low_stock', 'E: at threshold low_stock');
    assertEqual(resolveAvailability({ is_active: 1, stock_quantity: 0, low_stock_threshold: 3, track_inventory: 1 }), 'out_of_stock', 'E: zero out_of_stock');
    assertEqual(resolveAvailability({ is_active: 0, stock_quantity: 99 }), 'out_of_stock', 'E: inactive out_of_stock');
    assertEqual(resolveAvailability({ stock_quantity: 0, deleted_at: '2026-01-01' }), 'out_of_stock', 'E: soft-deleted out_of_stock');
    assertEqual(resolveAvailability({ stock_quantity: 0, track_inventory: 0 }), 'in_stock', 'E: untracked treated in_stock');

    console.log('\n--- F: roll-up across variants + lowest price ---');
    assertEqual(rollUpAvailability(['out_of_stock', 'in_stock']), 'in_stock', 'F: any in-stock wins');
    assertEqual(rollUpAvailability(['out_of_stock', 'low_stock']), 'low_stock', 'F: low-stock over out');
    assertEqual(rollUpAvailability(['out_of_stock']), 'out_of_stock', 'F: all sold out stays out');
    assertEqual(rollUpAvailability([]), 'out_of_stock', 'F: empty set out_of_stock');
    assertEqual(
      lowestPriceMinorUnits([{ minorUnits: 200000, source: 'product_price' }, { minorUnits: 150000, source: 'product_price' }]),
      150000,
      'F: lowest sellable price computed',
    );
    assertEqual(lowestPriceMinorUnits([]), null, 'F: no prices yields null');

    console.log('\n--- G: read-only guarantee — no product row mutated ---');
    seedProduct(db, 'shop-money-prod', 'cat-shop-money', 'Test Tee', 1499);
    db.prepare('UPDATE products SET price = ?, stock_quantity = ? WHERE id = ?').run(1499, 5, 'shop-money-prod');
    const before = db.prepare('SELECT price, stock_quantity FROM products WHERE id = ?').get('shop-money-prod');
    resolvePriceMinorUnits({ price: before.price }, null, 'INR');
    resolveAvailability({ stock_quantity: before.stock_quantity, low_stock_threshold: 2, track_inventory: 1, is_active: 1 });
    const after = db.prepare('SELECT price, stock_quantity FROM products WHERE id = ?').get('shop-money-prod');
    assertEqual(after.price, before.price, 'G: product price unchanged after projection');
    assertEqual(after.stock_quantity, before.stock_quantity, 'G: product stock unchanged after projection');
  } finally {
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
