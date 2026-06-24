# Security posture

A concise map of the application's security-relevant controls. The release gate
([F100](../release/F100-prerelease-audit.md)) re-verifies these before every tag.

## Authentication & sessions

| Surface | Mechanism |
|---|---|
| User auth | JWT access/refresh. The access token is sent in the `Authorization: Bearer` header — **not** an ambient cookie — so cross-site requests can't ride it (low CSRF surface). Secrets validated at boot (`config/env.ts`). |
| Passwords | bcrypt, peppered with an HKDF-derived key from `DATA_ENCRYPTION_SECRET`. |
| Admin panel | HTTP Basic-Auth, constant-time compare (`timingSafeEqual`), **fail-closed** when `ADMIN_PASSWORD` is empty/placeholder. Basic-Auth carries no ambient cookie → not CSRF-able. |
| Reviewer panel | Signed JWT in an `httpOnly`, `sameSite=lax` cookie, 7-day TTL. `lax` blocks the cookie on cross-site sub-requests while keeping top-level navigation working. |

## CSRF / same-site

The app is not vulnerable to classic cookie-riding CSRF:

- The **user API** authenticates via the `Authorization` header, which the
  browser never attaches automatically to cross-site requests.
- The **admin API** uses Basic-Auth (no ambient cookie).
- The **reviewer cookie** is `sameSite=lax`, so it is not sent on cross-site
  POST/PATCH/DELETE. All reviewer state changes are non-GET (`POST`/`PATCH`), so
  a cross-site top-level GET cannot mutate state.
- There are **no state-changing GET routes** — every mutation is `POST`/`PATCH`/
  `DELETE`, validated by Zod.

## Data protection at rest

| Data | Protection |
|---|---|
| BYOK provider keys | AES-256-GCM (`AI_KEY_ENCRYPTION_SECRET`), fresh IV per record. |
| User email (PII) | AES-256-GCM (key HKDF-derived from `DATA_ENCRYPTION_SECRET`); equality lookups via keyed HMAC. |

## Transport & headers

- Web responses carry HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and a
  Report-Only CSP — see [`csp.md`](./csp.md) and
  `apps/web/src/lib/security-headers.ts`.
- The API applies helmet (`apps/api/src/common/security.ts`) for defence in depth
  and CORS is locked to `APP_URL`.

## Input handling

- Every controller reads `@Body() body: unknown` and validates against a Zod
  schema from `packages/shared` (`ZodValidationPipe`). No raw `req.body` is
  trusted.
- No string-built SQL — all access goes through the typed Prisma client.

## Rate limiting

- Global `ThrottlerGuard` (window/limit from `RATE_LIMIT_*`).
- `/auth/*` tightened; meal-plan and AI-cost admin routes
  (`admin/drafts/{recipes,ingredient-names}/generate`) carry explicit `@Throttle`
  caps on top of the admin Basic-Auth gate.

## AI prompt-injection

Curation prompts are admin-only; the model selects ingredients **only** from an
in-prompt closed catalogue ("may NOT invent or rename") and all output is
re-validated and recomputed by the deterministic engine. The injection surface is
bounded — a poisoned model response cannot introduce uncatalogued data or alter
computed nutrition.
