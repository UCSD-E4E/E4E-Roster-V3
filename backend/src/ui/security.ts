import type { NextFunction, Request, Response } from 'express';

const reactCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join('; ');

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function configuredProductionOrigin(): string | undefined {
  const host = process.env.ROSTER_HOST?.trim();
  // ROSTER_HOST is also used by Traefik's Host rule. Keep this strict so an
  // accidentally malformed environment value cannot expand the CSRF allowlist.
  return host && /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? `https://${host}` : undefined;
}

/**
 * React workspaces use no inline scripts or styles, so they can be protected
 * more tightly than the remaining legacy templates while those are migrated.
 */
export function setReactWorkspaceHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', reactCsp);
  // Pages can contain one-time provisioning passwords and directory details.
  res.setHeader('Cache-Control', 'private, no-store');
  next();
}

/** Reject cross-site state-changing requests before React Router actions run. */
export function requireSameOriginMutation(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const suppliedSource = req.get('origin') ?? req.get('referer');
  // The production edge can replace Host while forwarding to the container.
  // Use its configured public hostname rather than a mutable proxy hop header.
  const expectedOrigin = process.env.NODE_ENV === 'production'
    ? configuredProductionOrigin() ?? `${req.protocol}://${req.get('host')}`
    : `${req.protocol}://${req.get('host')}`;
  let sourceOrigin: string | undefined;
  try { sourceOrigin = suppliedSource ? new URL(suppliedSource).origin : undefined; } catch { /* invalid origins fail closed */ }
  // Some browser form navigations omit Origin and are suppressed from sending a
  // Referer by the privacy policy. Sec-Fetch-Site gives us the same browser
  // provenance signal without accepting an unknown or cross-site request.
  const sameOriginBrowserNavigation = !sourceOrigin && req.get('sec-fetch-site') === 'same-origin';
  const localPreviewProxy = process.env.NODE_ENV !== 'production'
    && sourceOrigin
    && isLoopbackHostname(new URL(sourceOrigin).hostname)
    && isLoopbackHostname(req.hostname);
  if (!sameOriginBrowserNavigation && !localPreviewProxy && (!sourceOrigin || sourceOrigin !== expectedOrigin)) {
    res.status(403).type('text').send('Cross-site form submission rejected.');
    return;
  }
  next();
}
