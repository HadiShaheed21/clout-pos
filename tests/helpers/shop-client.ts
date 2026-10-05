/**
 * Cookie-aware HTTP client for storefront tests.
 *
 * The shared `api()` helper in test-setup does not forward cookies, which the
 * guest-cart identity depends on. This client keeps a cookie jar and echoes the
 * CSRF cookie in the request header, exactly as a browser would.
 */

export function makeShopClient(baseUrl: string) {
  const jar: Record<string, string> = {};

  async function call(method: string, urlPath: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar.clout_cart_csrf) headers['x-clout-csrf'] = jar.clout_cart_csrf;
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;

    const response = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      if (index > 0) jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }

    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: response.status, data, headers: response.headers };
  }

  return {
    jar,
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b, h),
    patch: (p: string, b?: unknown, h?: Record<string, string>) => call('PATCH', p, b, h),
    del: (p: string, h?: Record<string, string>) => call('DELETE', p, undefined, h),
    raw: call,
  };
}
