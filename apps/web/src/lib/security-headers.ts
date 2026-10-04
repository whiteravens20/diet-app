// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * HTTP security headers applied to every web response (wired through
 * `next.config.ts` → `headers()`). Kept in a dependency-free module so the
 * security-headers test can assert the exact policy without booting Next.
 *
 * Two tiers:
 *  - {@link SECURITY_HEADERS} — always-safe headers, enforced. They constrain
 *    transport, framing, sniffing and referrer leakage without touching how the
 *    page renders.
 *  - {@link CSP_REPORT_ONLY} — the Content-Security-Policy, shipped in
 *    *Report-Only* mode. App Router emits inline bootstrap scripts and several
 *    libraries (next/font, Framer Motion, Recharts, next-themes) inject inline
 *    styles, so an enforcing CSP must first be validated in a browser across
 *    every palette + light/dark. Report-Only surfaces violations in the console
 *    without breaking the page. Promote to enforcing (ideally nonce-based via a
 *    middleware) once that QA pass is done — see docs/security/csp.md.
 */

/** `key`/`value` pairs in the shape Next's `headers()` expects. */
export interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * Content-Security-Policy value. Intentionally strict on scripts (`'self'`, no
 * `'unsafe-inline'`) so Report-Only violation reports reveal exactly which
 * inline scripts need a nonce before enforcement. Styles allow `'unsafe-inline'`
 * because the UI libraries inject un-nonced inline styles (low risk relative to
 * scripts).
 */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Same-origin only: the browser talks to the web origin, which proxies /api.
  "connect-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

/**
 * Always-enforced security headers. `Strict-Transport-Security` is sent
 * unconditionally — browsers ignore it over plain HTTP (so local/self-host HTTP
 * is unaffected) and honour it once the operator serves over TLS. `preload` is
 * deliberately omitted: committing a self-hoster's domain to the HSTS preload
 * list is their decision, not ours.
 */
export const SECURITY_HEADERS: readonly HeaderEntry[] = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Content-Security-Policy-Report-Only', value: CSP_REPORT_ONLY },
];
