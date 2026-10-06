/**
 * Dynamic shop routes export a single seed shell for every URL, so the
 * build-time param is only a seed — the live pathname carries the real slug.
 */
export function slugFromShopPathname(
  pathname: string | null | undefined,
  prefix: string,
): string | null {
  const match = pathname?.match(new RegExp(`^${prefix}([^/?#]+)`));
  return match ? match[1] : null;
}
