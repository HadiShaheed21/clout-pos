/**
 * Integration Test: product gallery read path.
 *
 * Regression for the gallery being write-only: uploaded product_images rows had no
 * route returning their bytes, so the catalogue page could list them but never show
 * them. Covers the authenticated read endpoint, its security controls (signature
 * verification, fixed content type, nosniff) and its error cases.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/product-gallery-read.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-gallery-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-product-gallery';

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { catalogueRoutes } = require('../main/routes/catalogue');

const PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_URI.split(',')[1], 'base64');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
// Declares PNG but carries no image bytes — must never be served.
const MISMATCHED_URI = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`;

async function main() {
  console.log('Integration Test: product gallery read path');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-gallery', 'Clothing');
  seedProduct(db, 'gallery-shirt', 'cat-gallery', 'Gallery Shirt', 1500);

  const app = createApp({ '/api/catalogue': catalogueRoutes });
  const { baseUrl, server } = await startServer(app);

  const upload = async (data_uri: string, alt_text: string): Promise<string> => {
    const res = await api(baseUrl, '/api/catalogue/products/gallery-shirt/images', {
      method: 'POST', headers: authHeader, body: { data_uri, alt_text },
    });
    assertEqual(res.status, 201, `upload of ${alt_text} is accepted`);
    return res.data.image.id as string;
  };

  const readImage = async (imageId: string, headers: Record<string, string>) =>
    fetch(`${baseUrl}/api/catalogue/products/gallery-shirt/images/${imageId}/data`, { headers });

  try {
    const primaryId = await upload(PNG_URI, 'Navy front');
    const secondId = await upload(PNG_URI, 'Navy back');

    console.log('\n─── A: authorized retrieval returns verified bytes and safe headers ───');
    {
      const res = await readImage(primaryId, authHeader as Record<string, string>);
      const bytes = Buffer.from(await res.arrayBuffer());
      assertEqual(res.status, 200, `A: gallery image is served (got ${res.status})`);
      assertEqual(res.headers.get('content-type'), 'image/png', 'A: content type is the verified raster type');
      assertEqual(res.headers.get('x-content-type-options'), 'nosniff', 'A: nosniff prevents content sniffing');
      assert(!!res.headers.get('etag'), 'A: an ETag is returned for revalidation');
      assert(!!res.headers.get('content-disposition')?.startsWith('inline'), 'A: image is served inline');
      assert(!(res.headers.get('content-type') || '').includes('svg'), 'A: content type is never an active-content type');
      assertEqual(bytes.equals(PNG_BYTES), true, 'A: served bytes match the stored image exactly');
      assertEqual(bytes.subarray(0, 8).equals(PNG_SIGNATURE), true, 'A: served bytes carry a real PNG signature');
    }

    console.log('\n─── B: list exposes primary status and ordering without returning bytes ───');
    {
      const res = await api(baseUrl, '/api/catalogue/products/gallery-shirt/images', { headers: authHeader });
      assertEqual(res.status, 200, 'B: image list is readable');
      const listed = res.data.images as any[];
      assertEqual(listed.length, 2, 'B: both uploaded images are listed');
      assertEqual(listed[0].sort_order, 0, 'B: list is ordered by sort_order');
      assertEqual(listed[0].is_primary, 1, 'B: primary status is reported');
      assertEqual(listed[0].data_uri, undefined, 'B: the list never returns raw stored image data');
      assert(!!listed[1].alt_text, 'B: alt text is returned for labelling');
    }

    console.log('\n─── C: non-primary images are also retrievable ───');
    {
      const res = await readImage(secondId, authHeader as Record<string, string>);
      const bytes = Buffer.from(await res.arrayBuffer());
      assertEqual(res.status, 200, 'C: a non-primary gallery image is served');
      assertEqual(bytes.equals(PNG_BYTES), true, 'C: non-primary image bytes are correct');
    }

    console.log('\n─── D: unauthorized access is rejected ───');
    {
      const anonymous = await readImage(primaryId, {});
      assertEqual(anonymous.status, 401, 'D: unauthenticated read is rejected');
    }

    console.log('\n─── E: manager role may read the gallery ───');
    {
      const res = await readImage(primaryId, manager.authHeader as Record<string, string>);
      assertEqual(res.status, 200, 'E: an owner/manager role can read gallery bytes');
    }

    console.log('\n─── F: missing product and missing image are 404 ───');
    {
      const missingProduct = await api(baseUrl, '/api/catalogue/products/does-not-exist/images/any/data', { headers: authHeader });
      assertEqual(missingProduct.status, 404, 'F: missing product returns 404');

      const missingImage = await api(baseUrl, '/api/catalogue/products/gallery-shirt/images/does-not-exist/data', { headers: authHeader });
      assertEqual(missingImage.status, 404, 'F: missing image returns 404');
    }

    console.log('\n─── G: a payload whose bytes are not an approved image is refused ───');
    {
      const mismatchedId = await upload(MISMATCHED_URI, 'Mismatched prefix');
      const mismatched = await api(baseUrl, `/api/catalogue/products/gallery-shirt/images/${mismatchedId}/data`, { headers: authHeader });
      assertEqual(mismatched.status, 415, 'G: non-image bytes are refused rather than served');
      assertEqual(mismatched.data.data_uri, undefined, 'G: a refusal never echoes the stored payload');
    }

    console.log('\n─── H: a JPEG upload is served with the verified image/jpeg type ───');
    {
      const jpegId = await upload(JPEG_URI, 'Detail shot');
      const res = await readImage(jpegId, authHeader as Record<string, string>);
      assertEqual(res.status, 200, 'H: a JPEG gallery image is served');
      assertEqual(res.headers.get('content-type'), 'image/jpeg', 'H: JPEG is served as image/jpeg');
      assertEqual(res.headers.get('x-content-type-options'), 'nosniff', 'H: JPEG is also nosniff');
    }

    console.log('\n─── I: changing the primary image is reflected on the next read ───');
    {
      const promoted = await api(baseUrl, `/api/catalogue/products/gallery-shirt/images/${secondId}`, {
        method: 'PATCH', headers: authHeader, body: { is_primary: true },
      });
      assertEqual(promoted.status, 200, 'I: primary can be changed');

      const listed = await api(baseUrl, '/api/catalogue/products/gallery-shirt/images', { headers: authHeader });
      const primaryRow = (listed.data.images as any[]).find((image) => image.is_primary);
      assertEqual(primaryRow?.id, secondId, 'I: the promoted image is reported as primary');
      const bytes = Buffer.from(await (await readImage(primaryRow.id, authHeader as Record<string, string>)).arrayBuffer());
      assertEqual(bytes.equals(PNG_BYTES), true, 'I: the new primary still serves correct bytes');
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

