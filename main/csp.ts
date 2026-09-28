import { Request } from 'express';

/** Matches a safe Host header to prevent directive smuggling. */
const SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/;

/** Builds CSP header, allowing LAN devices to connect via connect-src. */
export function buildCspHeader(req: Request): string {
  const host = req.get('Host');
  // Railway/Vercel terminate TLS before Express. Honor only the canonical
  // forwarded protocol values when constructing the connection origin.
  const forwardedProto = req.get('X-Forwarded-Proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto === 'https' ? 'https' : 'http';
  const connectSrc = host && SAFE_HOST.test(host)
    ? `'self' ${protocol}://${host} ${protocol === 'https' ? 'wss' : 'ws'}://${host}`
    : "'self'";
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
  ].join('; ');
}
