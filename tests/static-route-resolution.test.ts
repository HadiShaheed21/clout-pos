const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => os.tmpdir() } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { resolveStaticPage } = require('../main/server');
const { slugFromShopPathname } = require('../frontend/src/lib/shop/slug-from-pathname');
const { fetchProduct } = require('../frontend/src/lib/shop/catalogue-client');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-static-routes-'));
const writePage = (route: string, content: string) => {
  const dir = path.join(fixture, route);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), content);
};

fs.writeFileSync(path.join(fixture, 'index.html'), 'root');
writePage('whatsapp', 'whatsapp');
writePage('shop', 'shop');
writePage('shop/p/product', 'product-shell');
writePage('shop/collections/collection', 'collection-shell');
writePage('shop/c/men', 'men');
writePage('dashboard', 'dashboard');
writePage('pos', 'pos');
writePage('auth/login', 'login');

assert.equal(resolveStaticPage(fixture, '/whatsapp'), path.join(fixture, 'whatsapp', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/whatsapp/'), path.join(fixture, 'whatsapp', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/unknown'), path.join(fixture, 'index.html'));
assert.equal(resolveStaticPage(fixture, '/../outside'), path.join(fixture, 'index.html'));

// Dynamic shop segments hydrate their seed shell instead of the root page,
// which would redirect the visitor into the POS/dashboard.
const productShell = path.join(fixture, 'shop', 'p', 'product', 'index.html');
const collectionShell = path.join(fixture, 'shop', 'collections', 'collection', 'index.html');
assert.equal(resolveStaticPage(fixture, '/shop/p/d1mrmf'), productShell);
assert.equal(resolveStaticPage(fixture, '/shop/p/prod-retail-linen-shirt'), productShell);
assert.equal(resolveStaticPage(fixture, '/shop/p/anything'), productShell);
assert.equal(resolveStaticPage(fixture, '/shop/collections/test'), collectionShell);

// Unknown categories stay inside the storefront; built routes resolve directly.
assert.equal(resolveStaticPage(fixture, '/shop/c/something'), path.join(fixture, 'shop', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/shop/c/men'), path.join(fixture, 'shop', 'c', 'men', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/shop'), path.join(fixture, 'shop', 'index.html'));

// POS/dashboard/auth resolution is unchanged.
assert.equal(resolveStaticPage(fixture, '/dashboard'), path.join(fixture, 'dashboard', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/pos'), path.join(fixture, 'pos', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/auth/login'), path.join(fixture, 'auth', 'login', 'index.html'));

async function verifyProductRequest(): Promise<void> {
  // The shell hydrates at the real URL: the product id must come from the live
  // pathname, so fetchProduct targets the real slug, never the build-time seed.
  const slug = slugFromShopPathname('/shop/p/d1mrmf', '/shop/p/');
  assert.equal(slug, 'd1mrmf');
  assert.notEqual(slug, 'product');
  assert.equal(slugFromShopPathname('/shop/p/product', '/shop/p/'), 'product');

  let requested: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ product: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await fetchProduct(slug as string);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requested, '/api/shop/products/d1mrmf');
  assert.notEqual(requested, '/api/shop/products/product');
}

verifyProductRequest()
  .then(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    console.log('✅ Static route resolution tests passed');
  })
  .catch((error: unknown) => {
    fs.rmSync(fixture, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
