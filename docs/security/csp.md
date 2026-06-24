# Content-Security-Policy

The web app's security headers live in
[`apps/web/src/lib/security-headers.ts`](../../apps/web/src/lib/security-headers.ts)
and are applied to every response via `headers()` in `next.config.ts`. The CSP
currently ships as **`Content-Security-Policy-Report-Only`**.

## Why Report-Only first

An *enforcing* CSP that is wrong breaks the page silently. Two things make a
strict policy fragile here:

- **Inline bootstrap scripts.** Next.js App Router injects inline `<script>`
  chunks for hydration. With `script-src 'self'` (no `'unsafe-inline'`) these are
  blocked unless each carries a per-request nonce.
- **Inline styles.** `next/font`, Framer Motion, Recharts and `next-themes`
  inject un-nonced inline styles. `style-src` therefore allows `'unsafe-inline'`
  (style injection is far lower risk than script injection).

Report-Only lets the strict policy run and report violations to the browser
console without blocking anything, so the exact set of inline scripts that need a
nonce is visible before enforcement.

## Current policy

```
default-src 'self'; base-uri 'self'; object-src 'none';
frame-ancestors 'none'; form-action 'self';
script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self'; upgrade-insecure-requests
```

## What enforcement currently blocks (verified on the live stack, 2026-06-24)

Loading the production landing page in headless Chromium against the Report-Only
policy surfaced exactly two classes of violation — the page still rendered
correctly (Report-Only blocks nothing):

1. **~11 inline `<script>` blocks** — Next.js App Router's `self.__next_f`
   streaming chunks plus the `next-themes` bootstrap. Their content varies per
   render, so static hashes won't work — a **per-request nonce** is required.
2. **One bundled chunk evaluates a string as JavaScript** (`unsafe-eval`). It is
   served from `/_next/static/chunks/` (so `'self'` covers loading it, but the
   `eval`/`new Function` call inside needs `'unsafe-eval'`). Identify the
   dependency doing this before enforcing — either isolate it or accept
   `'unsafe-eval'` (which materially weakens the policy).

## Promotion to enforcing

1. Add a `middleware.ts` that generates a per-request nonce, forwards it on the
   request headers, and sets `script-src 'nonce-…' 'strict-dynamic'` — Next
   applies the nonce to its inline scripts automatically; pass the same nonce to
   the `next-themes` provider (`nonce` prop) for its bootstrap script. Move the
   CSP out of `next.config.ts` `headers()` (keep the other static headers there)
   so it isn't double-set.
2. Resolve the `unsafe-eval` source from finding 2 above.
3. Re-run the browser QA across every surface in **all 6 palettes × light/dark**
   until the console is clean.
4. Rename the header in `security-headers.ts` from
   `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
5. Update [`accepted-risks.md`](./accepted-risks.md) — delete AR-2.

The header set is asserted by
[`security-headers.test.ts`](../../apps/web/src/lib/security-headers.test.ts);
update that test's Report-Only assertions when promoting.
