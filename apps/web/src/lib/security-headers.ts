// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The security headers of the web application. Kept free of imports, so that
 * the tests hold the exact policy without starting the framework.
 *
 * Two kinds:
 *  - {@link SECURITY_HEADERS} are the same for every response, and are set
 *    once, through `next.config.ts`.
 *  - What depends on the request or on the instance is set for each page by
 *    `src/proxy.ts`: the content security policy, which names a nonce made
 *    for that one response ({@link contentSecurityPolicy}), and the headers
 *    that only an instance served over https may send
 *    ({@link TRANSPORT_HEADERS}).
 */

/** `key`/`value` pairs in the shape Next's `headers()` expects. */
export interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

/** Sent with every response, whatever the instance. They limit framing, sniffing and what a referrer tells. */
export const SECURITY_HEADERS: readonly HeaderEntry[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
];

/** Where a browser sends its reports of what the policy blocked: a route of the API, reached through the web server. */
export const POLICY_REPORTS = '/api/csp-reports';

/**
 * Sent only by an instance whose public address is https. Over plain http a
 * browser ignores the first and has no use for the second: a home instance
 * on a LAN address runs that way. `preload` is left out on purpose: putting
 * a domain on the browsers' preload list is its owner's decision.
 */
export const TRANSPORT_HEADERS: readonly HeaderEntry[] = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // The name `report-to` of the policy refers to.
  { key: 'Reporting-Endpoints', value: `csp="${POLICY_REPORTS}"` },
];

/** Where Cloudflare's Turnstile loads its challenge from, in a frame. */
const TURNSTILE = 'https://challenges.cloudflare.com';

/** What the policy of one response depends on. */
export interface PolicySettings {
  /** Made for this response alone: the scripts of the page carry it, and nothing else can know it. */
  nonce: string;
  /** The instance's public address is https. */
  https: boolean;
  /** Sign-in and registration show a Turnstile challenge. */
  turnstile: boolean;
}

/**
 * The content security policy of a page, enforced.
 *
 * Scripts: only those that carry the response's nonce run, and what such a
 * script loads in turn (`strict-dynamic`): the framework's own, and
 * Turnstile's when it is on. A script that got into the page any other way
 * (an injected tag, an inline handler) does not run, and no script may make
 * code from text. `'self'` is for a browser that does not know
 * `strict-dynamic`; one that does ignores it. `wasm-unsafe-eval` lets a
 * script compile WebAssembly, which is all it allows: the library that lays
 * out the printed shopping list is WebAssembly, and reads it from a `data:`
 * address, which is why `connect-src` names that too (nothing leaves the
 * browser for such an address).
 *
 * Styles: a `<style>` tag needs the nonce like a script does; a `style`
 * attribute is allowed, since the framework's image component and the charts
 * write them into the page's HTML. `style-src` says the same for a browser
 * that does not know the two finer directives.
 *
 * Everything else comes from the application's own address: it talks to its
 * API through the web server, runs no worker but its own, frames nothing
 * (but Turnstile's challenge), and may itself be framed by nobody.
 */
export function contentSecurityPolicy({ nonce, https, turnstile }: PolicySettings): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data:",
    // The application starts no worker, a service worker included, and neither may anything else in its pages.
    "worker-src 'none'",
    `frame-src ${turnstile ? TURNSTILE : "'none'"}`,
    `report-uri ${POLICY_REPORTS}`,
    // A report to a named endpoint, and the upgrade of http requests, are for https only: on an
    // http instance the second would turn the application's own requests into ones nothing answers.
    ...(https ? ['report-to csp', 'upgrade-insecure-requests'] : []),
  ].join('; ');
}
