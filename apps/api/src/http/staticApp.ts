// Serving the built web app.
//
// Same origin as the API, deliberately: the session is a cookie and CSRF is a
// double-submit pair, and both are simplest and safest when there is no
// cross-origin story at all.
//
// THE CONTENT SECURITY POLICY IS A CONTROL, NOT DECORATION.
//
// The commercial engine's page loads Fira Sans from fonts.googleapis.com. For a
// hosted product that is a reasonable trade. For CE it is not:
//
//   * it tells Google the IP address of everyone who opens a self-hosted app
//   * it breaks on an air-gapped or firewalled installation
//   * it makes the Local-only badge a claim the page itself contradicts
//
// So CE fetches nothing from anywhere. `default-src 'self'` is what makes that
// checkable rather than a promise — a future edit that adds a CDN link gets
// blocked by the browser, and the e2e suite fails on the console error.
import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** `style-src` allows inline attributes because React sets `style={{…}}` for
 * the visual-viewport height on Talk. It still forbids an external stylesheet,
 * which is the property that matters here. `connect-src 'self'` keeps the app
 * talking only to its own API. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export interface StaticAppOptions {
  /** Where the built bundle lives. Absent or missing = API-only, which is what
   * the test suite and the migration container run as. */
  dir?: string;
}

export function mountWebApp(app: Express, opts: StaticAppOptions = {}): boolean {
  const dir = opts.dir ?? process.env.WEB_DIR ?? '/app/web';
  if (!existsSync(join(dir, 'index.html'))) return false;

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    // Belt and braces around the same idea: no referrer to anywhere, no MIME
    // sniffing, and no browser feature this app does not use.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    );
    next();
  });

  // Hashed assets are immutable; index.html must never be, or an upgrade leaves
  // people running last version's bundle against this version's API.
  app.use('/assets', express.static(join(dir, 'assets'), {
    immutable: true, maxAge: '1y', fallthrough: true,
  }));
  app.use(express.static(dir, { index: false, maxAge: '1h' }));

  // Client-side routing: anything that is not an API call and not a file gets
  // the shell. `/api` is excluded so a mistyped endpoint still returns the
  // API's JSON 404 rather than an HTML page a fetch() cannot read.
  app.get(/^(?!\/api\/).*/, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(dir, 'index.html'));
  });

  return true;
}
