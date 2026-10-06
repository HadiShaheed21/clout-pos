/**
 * Cookie-aware HTTP client for storefront tests.
 *
 * The shared `api()` helper in test-setup does not forward cookies, which the
 * guest-cart identity depends on. This client keeps a cookie jar and echoes the
 * CSRF cookie in the request header, exactly as a browser would.
 *
 * The jar is path-aware (RFC 6265): same-named cookies under different paths
 * are distinct entries, and the deepest path wins on send/read, matching real
 * browser ordering. A `Max-Age=0` (or expired) Set-Cookie removes only the
 * entry for its own path.
 */

interface JarEntry {
  value: string;
  path: string;
}

export function makeShopClient(baseUrl: string) {
  const store = new Map<string, JarEntry[]>();
  /** Flat view kept for assertions (`guest.jar.clout_cart`). */
  const jar: Record<string, string> = {};

  function pathOf(urlPath: string): string {
    return new URL(urlPath, baseUrl).pathname;
  }

  function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
    if (!requestPath.startsWith(cookiePath)) return false;
    if (cookiePath.endsWith('/')) return true;
    return requestPath.length === cookiePath.length || requestPath[cookiePath.length] === '/';
  }

  /** Visible cookies for a request path, longest path first (RFC 6265 §5.4:
   * the user agent sends ALL matching cookies, including same-named cookies
   * under different paths, with longer paths listed first). */
  function cookiesFor(requestPath: string): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    for (const [name, entries] of store) {
      const visible = entries.filter((e) => cookiePathMatches(e.path, requestPath));
      visible.sort((a, b) => b.path.length - a.path.length);
      for (const e of visible) out.push({ name, value: e.value });
    }
    return out;
  }

  /** Flat view for assertions: first value per name as the API would see it. */
  function refreshJarView(): void {
    for (const key of Object.keys(jar)) delete jar[key];
    const seen = new Set<string>();
    for (const { name, value } of cookiesFor('/api/shop/cart/items')) {
      if (!seen.has(name)) { seen.add(name); jar[name] = value; }
    }
  }

  function ingest(setCookies: string[]): void {
    for (const raw of setCookies) {
      const [pair, ...attrParts] = raw.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      let cookiePath = '/';
      let maxAge: number | null = null;
      for (const attr of attrParts) {
        const [k, v] = attr.trim().split('=');
        if (/^path$/i.test(k) && v) cookiePath = v.trim();
        if (/^max-age$/i.test(k)) maxAge = Number(v);
      }
      const entries = store.get(name) ?? [];
      const at = entries.findIndex((e) => e.path === cookiePath);
      if (maxAge === 0) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { value, path: cookiePath };
      } else {
        entries.push({ value, path: cookiePath });
      }
      if (entries.length === 0) store.delete(name);
      else store.set(name, entries);
    }
    refreshJarView();
  }

  async function call(method: string, urlPath: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const requestPath = pathOf(urlPath);
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Mirror the storefront's document.cookie read: first visible value wins.
    const csrf = cookiesFor('/shop/p/d1mrmf').find((c) => c.name === 'clout_cart_csrf');
    if (csrf) headers['x-clout-csrf'] = csrf.value;
    const cookies = cookiesFor(requestPath).map(({ name, value }) => `${name}=${value}`).join('; ');
    if (cookies) headers.Cookie = cookies;

    const response = await fetch(baseUrl + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    ingest(response.headers.getSetCookie?.() ?? []);

    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: response.status, data, headers: response.headers };
  }

  return {
    jar,
    /** Seed a cookie directly (path defaults to '/'), for negative tests. */
    setCookie: (name: string, value: string, cookiePath = '/') => {
      const entries = store.get(name) ?? [];
      const at = entries.findIndex((e) => e.path === cookiePath);
      if (at >= 0) entries[at] = { value, path: cookiePath };
      else entries.push({ value, path: cookiePath });
      store.set(name, entries);
      refreshJarView();
    },
    /** Copy another client's jar (simulates a browser refresh). */
    copyJarFrom: (other: { jar: Record<string, string> }) => {
      store.clear();
      for (const [name, value] of Object.entries(other.jar)) {
        store.set(name, [{ value, path: '/' }]);
      }
      refreshJarView();
    },
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b, h),
    patch: (p: string, b?: unknown, h?: Record<string, string>) => call('PATCH', p, b, h),
    del: (p: string, h?: Record<string, string>) => call('DELETE', p, undefined, h),
    raw: call,
  };
}
