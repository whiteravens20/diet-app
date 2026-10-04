# F100 — Security & Optimization Audit · Run 002

| | |
|---|---|
| **Run** | 002 |
| **Date** | 2026-06-26 |
| **Branch / commit** | `dev` @ `31f19d2` |
| **Auditor** | Claude Code (static analysis + manual review — no DAST/runtime) |
| **Scope** | Full codebase: auth surfaces, crypto, admin + reviewer paths, AI BYOK + test probes, pull-overrides SSRF, exception handling, rate-limiting, schema indexes, pagination logic |
| **Baseline** | [Run 001](F100-prerelease-audit.md) @ `7137e74` (2026-06-24) |
| **Verdict (initial)** | **🟠 NOT YET** — 0 new Critical; 2 new High findings (SSRF + fetch-timeout DoS); 6 new Medium; all pre-existing blockers from Run 001 remain open. |
| **Verdict (after remediation)** | **🟢 security/opt findings closed** — all 8 of this run's findings (S-F1…S-F6, O-F1, O-F2) fixed + verified; new operator `OLLAMA_USER_POLICY` adds back BYOK liberty safely. Run 001 **test-coverage** blockers (WI-B4…B7) + CSP enforcement remain the open ship-gate. See [§ Remediation log](#remediation-log--run-002). |

---

## Remediation log — Run 002

Executed 2026-06-26 on `dev`. Full suite green afterwards: `npm run lint`
(`--max-warnings 0`), `npm run typecheck`, `npm test` (api 211 + web + shared),
plus a new `ollama-url.test.ts` (24 cases).

### Resolved ✅

| Finding | Fix | Evidence |
|---|---|---|
| **S-F1** SSRF via Ollama `baseUrl` | New `OLLAMA_USER_POLICY` (`off` / `allowlist` / `public`) + `assertAllowedOllamaUrl` guard. Default `allowlist` pins the operator host:port + `OLLAMA_ALLOWED_HOSTS`; `public` allows any host except private/loopback/link-local/CGNAT/single-label/`.local`/`.internal` (IPv4 + IPv6 incl. v4-mapped). Wired into the `/ai/test` probe, BYOK `upsert` (write-time), and the router (dial-time, defence-in-depth). | [`ai/ollama-url.ts`](../../apps/api/src/ai/ollama-url.ts)(`.test.ts`), `ai/ai-test.service.ts`, `ai/ai-key.service.ts`, `ai/ai-router.service.ts`, `config/env.ts` |
| **S-F2** Missing fetch timeouts | `AbortSignal.timeout(10_000)` on all three `/ai/test` probes. | `ai/ai-test.service.ts` |
| **S-F3** Swagger in prod | `SWAGGER_ENABLED` env, defaults **off in production**. | `main.ts`, `config/env.ts` |
| **S-F4** Secret fan-out | `REVIEWER_SESSION_SECRET` (optional, independent of `JWT_ACCESS_SECRET`) via a single `resolveReviewerSecret` resolver used by the controller + guard; `SHIP_DOWNLOAD_TOKEN_SECRET` documented. | `review/session.ts`, `review/review.controller.ts`, `review/reviewer-session.guard.ts`, `.env.example` |
| **S-F5** Residual `process.env.SEED_DATA_DIR` | Wrapped in a single annotated, typed `seedDataDirOverride()` boundary (non-DI CLI helper — `ConfigService` unavailable). | `admin/seed/data-hash.ts` |
| **S-F6** Reviewer login unthrottled | `@Throttle({ limit: 5, ttl: 60_000 })` on `POST /review/auth`. | `review/review.controller.ts` |
| **O-F1** `PlannedMeal.recipeId` unindexed | `@@index([recipeId])` + migration `20260626120000_planned_meal_recipe_index`. | `prisma/schema.prisma`, migration |
| **O-F2** Pagination count/items mismatch | `includeReviewed` filter moved into the Prisma `where` (`localeReviews: { none: … }`) for both reviewer list endpoints, so `total` matches the page. (Favorites had no such bug — Run 002 note was speculative.) | `review/review.controller.ts` |
| **S-F7 / S-F8** | AR-3 (admin repo-pull full-URL) recorded in [`accepted-risks.md`](../security/accepted-risks.md); `.env.example` "Phase E" marker reworded. | `docs/security/accepted-risks.md`, `.env.example` |

New error codes `OLLAMA_HOST_NOT_ALLOWED` + `OLLAMA_USER_DISABLED` added to
`en.json`/`pl.json` (catalogue test green). Policy exposed via `GET /api/config`
(`PublicConfig.ai.ollamaUserPolicy`) so the UI can hide BYOK-Ollama when `off`.
New accepted risk **AR-4** records the `public`-mode DNS-rebinding residual.

### Still open (Run 001 carry-over — the real ship gate) ⛔

Test-coverage floors (WI-B4 services ≥85%, WI-B5 controllers ≥80%, WI-B6 web ≥70%,
WI-B7 e2e), perf profiling/bundle (WI-E2/E3), and CSP enforcement (AR-2). These
are tracked below and in Run 001.

---

## Delta from Run 001

Commits since `7137e74`:
- `7c82961` — security headers, helmet, config-routed secrets, AI-route throttle
- `3903790` — coverage gate, engine and web tests, CI doc-link/marker guards
- `614cacc` — drop dead BullMQ queue, remove Redis
- `31f19d2` — strip phase markers, README feature matrix, fix stale links

**Resolved in remediation (confirmed green this run):**

| Finding | Evidence |
|---|---|
| WI-F1 Security headers | `next.config.ts` wires `SECURITY_HEADERS` (HSTS, nosniff, DENY, Referrer-Policy, Permissions-Policy) + CSP Report-Only on every route; `helmet` in `main.ts`; both tested. |
| WI-F2 `process.env` (partial) | USDA runner and BYOK runner keys now via `ConfigService`; ESLint `no-restricted-syntax` guard active. Two residual reads remain — see S-F5. |
| WI-F3 AI-generate throttle | `@Throttle({ default: { limit: 5, ttl: 60_000 } })` on both generate endpoints in `drafts.controller.ts`. |
| WI-D1 Dead worker stack | BullMQ/ioredis removed; `worker.ts` cleaned to a legitimate weight-reminder cron (not dead code — the audit had mis-flagged it). |
| WI-C1/C2 Lint | `--max-warnings 0` enforced; eslint-disable directives annotated. |
| WI-G1 Phase markers in source | Stripped from source; CI guard added. One residual in `.env.example` — see S-F8. |
| WI-B1/B2/B3 Coverage gate + engine tests | Provider installed; thresholds enforced; engine glob ≥95% met. |

---

## Headline findings this run

### 🔴 Release blockers (carry-over from Run 001 — not yet resolved)

All six blockers from Run 001 remain open. See §Carry-over below.

### 🟠 New high findings

| ID | Area | Severity |
|---|---|---|
| S-F1 | SSRF via user-controlled Ollama `baseUrl` in `POST /api/ai/test` | 🟠 High |
| S-F2 | Missing fetch timeout on AI test probes — resource exhaustion | 🟠 High |

### 🟡 New medium findings

| ID | Area | Severity |
|---|---|---|
| S-F3 | Swagger UI unconditionally mounted in production | 🟡 Medium |
| S-F4 | `JWT_ACCESS_SECRET` fan-out to reviewer cookie + bundle tokens | 🟡 Medium |
| S-F5 | Residual `process.env.SEED_DATA_DIR` in `data-hash.ts` (WI-F2 incomplete) | 🟡 Medium |
| S-F6 | Reviewer login not explicitly rate-limited | 🟡 Medium |
| O-F1 | `PlannedMeal.recipeId` has no DB index | 🟡 Medium |
| O-F2 | Pagination count mismatch in reviewer list endpoints | 🟡 Medium |

---

## Security findings

### S-F1 🟠 SSRF — user-controlled Ollama `baseUrl` in `POST /api/ai/test`

[`apps/api/src/ai/ai-test.service.ts:66-79`](../../apps/api/src/ai/ai-test.service.ts#L66)

```ts
private async testOllama(baseUrl: string | undefined): Promise<AiTestConnectionResponse> {
  const root = baseUrl ?? this.config.get('OLLAMA_BASE_URL', { infer: true });
  // ...
  const res = await fetch(`${root.replace(/\/$/, '')}/api/tags`);  // ← no URL validation
```

An authenticated user submits `{ provider: 'ollama', baseUrl: 'http://10.0.0.1:9090' }` to
`POST /api/ai/test` and the API makes an outbound HTTP request to that host from inside the
container network. Standard SSRF: can enumerate internal services, hit metadata endpoints
(`http://169.254.169.254`), or relay to adjacent containers.

The endpoint is `@UseGuards(JwtAuthGuard)` — requires a valid user session — but any
registered user can exploit it.

**Acceptance test:** a request with `baseUrl: 'http://localhost:9999/internal'` must return a
400 or have the fetch blocked before it leaves the process.

#### WI-S1 — Validate Ollama `baseUrl` against an allowlist / deny-list 🟠

Option A (strict): only permit `http://localhost:*` and `http://ollama:*` by default; allow
operators to extend via `OLLAMA_ALLOWED_HOSTS` env.

Option B (default-deny internal): parse the URL, resolve the hostname, and reject loopback,
link-local, private-IP ranges (`10/8`, `172.16/12`, `192.168/16`) and `169.254/16`.

Option B is more self-host-friendly. Implement using Node's `dns.lookup` + a private-range
check, or use the `is-ip`/`ipaddr.js` library already likely in the transitive tree.

Add the same guard to `AiRouterService.sendChat` when the provider is Ollama, since the
persisted `baseUrl` from `AiProviderConfig` is also operator-controlled.

---

### S-F2 🟠 Missing fetch timeout — resource exhaustion in AI test probes

[`apps/api/src/ai/ai-test.service.ts:52-64, 89-106`](../../apps/api/src/ai/ai-test.service.ts#L52)

`testOpenAiCompatible` and `testAnthropic` call `fetch(url, { headers })` with no `signal`.
Unlike `pull-overrides.ts` (which uses `AbortSignal.timeout(15_000)`), a slow or adversarial
endpoint can hold the connection open indefinitely. Under the global rate limiter the burst
surface per user is modest, but without a timeout a single "hang" blocks that request slot
in the Node event loop for the duration of the OS TCP timeout.

#### WI-S2 — Add `AbortSignal.timeout(10_000)` to all test-probe fetches 🟠

```ts
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${apiKey}` },
  signal: AbortSignal.timeout(10_000),
});
```

Apply to `testOpenAiCompatible`, `testAnthropic`, and `testOllama`. Mirror what
`pull-overrides.ts` already does.

---

### S-F3 🟡 Swagger UI unconditionally mounted in production

[`apps/api/src/main.ts:22-29`](../../apps/api/src/main.ts#L22)

`SwaggerModule.setup` is called regardless of `NODE_ENV`. In production this exposes every
route's request/response shape, auth requirements, and parameter names to unauthenticated
users at `/api/docs` and `/api/docs-json`. This is reconnaissance-enabling, not directly
exploitable, but contradicts a security-first posture.

#### WI-S3 — Gate Swagger behind `NODE_ENV !== 'production'` 🟡

```ts
if (config.get('NODE_ENV', { infer: true }) !== 'production') {
  // SwaggerModule.setup(...)
}
```

Or gate behind an explicit `SWAGGER_ENABLED=true` env flag so operators who want the docs in
production can opt in knowingly.

---

### S-F4 🟡 `JWT_ACCESS_SECRET` fan-out to reviewer cookie and bundle download tokens

[`apps/api/src/review/review.controller.ts:127`](../../apps/api/src/review/review.controller.ts#L127),
[`apps/api/src/admin/drafts/drafts.controller.ts:892`](../../apps/api/src/admin/drafts/drafts.controller.ts#L892)

Both the reviewer-session cookie and the bundle download one-shot token fall back to
`JWT_ACCESS_SECRET` when their dedicated secrets are not set:

```ts
// review.controller.ts:127
const secret = this.config.get('JWT_ACCESS_SECRET', { infer: true });

// drafts.controller.ts:892-895
private bundleSecret(): string {
  const explicit = this.config.get('SHIP_DOWNLOAD_TOKEN_SECRET', { infer: true });
  if (explicit && explicit.length > 0) return explicit;
  return this.config.get('JWT_ACCESS_SECRET', { infer: true })!;
}
```

A stolen `.env` (or a rotated `JWT_ACCESS_SECRET`) simultaneously invalidates user access
tokens, reviewer sessions, and any outstanding bundle download links. More critically, a
reviewer-cookie forger who knows `JWT_ACCESS_SECRET` can craft a valid reviewer JWT that
`verifyReviewerCookie` will accept.

#### WI-S4 — Dedicated secrets for reviewer cookie and bundle tokens 🟡

1. Add `REVIEWER_SESSION_SECRET: z.string().min(16)` to `env.ts` (default-none, falls back to
   `JWT_ACCESS_SECRET` only in dev).
2. Add `SHIP_DOWNLOAD_TOKEN_SECRET` guidance to `.env.example` (it already exists but is blank —
   note that leaving it blank reuses the access-token secret, and recommend generating a
   dedicated one).
3. Wire `REVIEWER_SESSION_SECRET` in `review.controller.ts` and `reviewer-session.guard.ts`.

---

### S-F5 🟡 Residual `process.env.SEED_DATA_DIR` — WI-F2 incomplete

[`apps/api/src/admin/seed/data-hash.ts:49`](../../apps/api/src/admin/seed/data-hash.ts#L49)

```ts
if (process.env.SEED_DATA_DIR) return resolve(process.env.SEED_DATA_DIR);
```

This is a CLI-path helper that runs outside the NestJS DI container (called from `seed.ts`
before the app is bootstrapped), so `ConfigService` injection isn't directly available. But
the ESLint `no-restricted-syntax` rule that now bans raw `process.env` in `apps/api/src/`
hits this file. If the lint guard targets `apps/api/src/**` this file is already in scope.

The other two surviving `process.env` reads at `upstream-mode.ts:376,387` are the legitimate
`...process.env` subprocess-env spread and are correctly annotated as such.

#### WI-S5 — Fix `data-hash.ts` to use a typed accessor 🟡

Since this helper is non-DI, introduce a lightweight typed wrapper:
```ts
const SEED_DATA_DIR: string | undefined =
  typeof process.env.SEED_DATA_DIR === 'string' ? process.env.SEED_DATA_DIR : undefined;
```
Or read from the validated `Env` type via an exported `getDataDir(env: Pick<Env, 'SEED_DATA_DIR'>)`
that the seeder passes in after DI. Either satisfies the lint guard.

---

### S-F6 🟡 Reviewer login not explicitly rate-limited

[`apps/api/src/review/review.controller.ts:100`](../../apps/api/src/review/review.controller.ts#L100)

`POST /api/review/auth` (reviewer password check) has no `@Throttle` decorator. It falls
through to the global `120 req/60s` limit — lenient enough for password enumeration against a
bcrypt-hashed reviewer password. Compare to the auth controller which explicitly tightens to
`10 req/60s`.

#### WI-S6 — Add explicit throttle to reviewer login 🟡

```ts
@Post('auth')
@Throttle({ default: { limit: 5, ttl: 60_000 } })  // matches auth pattern
@HttpCode(204)
async login(...) { ... }
```

---

### S-F7 🟢 Pull-overrides full-URL mode allows internal network reach (admin-only, accepted)

[`apps/api/src/admin/drafts/ship/pull-overrides.ts:57-68`](../../apps/api/src/admin/drafts/ship/pull-overrides.ts#L57)

When `source` is a `http(s)://` URL, `resolvePullSource` validates it is a parseable URL but
performs no IP/host allowlist check. An admin operator could enter `http://localhost:5432/`
and get a TCP response from Postgres. Risk is bounded by `BasicAuthGuard` (admin-only) and
the `AbortSignal.timeout(15_000)` already present. For a self-hosted single-operator
deployment this is an accepted risk. **Document it in `docs/security/accepted-risks.md`.**

---

### S-F8 🟢 `Phase E` marker surviving in `.env.example` (informational)

[`.env.example:97`](../../.env.example#L97)

```
# ── Curation-queue ship mechanism (Phase E) ──────────────────────────────────
```

The CI guard (WI-G1) protects `apps/**/src/**`, not docs or dotfiles. This is a minor
cosmetic residue; reword on next pass of `.env.example`.

---

## Security posture — passing 🟢

These controls were reviewed and confirmed green this run:

| ID | Control | Evidence |
|---|---|---|
| SP-1 | AES-256-GCM email + BYOK key encryption, HKDF key derivation | `common/crypto.ts` |
| SP-2 | Bcrypt + pepper password hashing; constant-time compare on miss | `auth.service.ts:91-102`, `DUMMY_HASH` |
| SP-3 | BasicAuth timing-safe compare, fail-closed on empty/placeholder password | `basic-auth.guard.ts:21-31, 40-48` |
| SP-4 | Reviewer cookie `Secure` flag correctly derived from `APP_URL` | `review.controller.ts:137` |
| SP-5 | `AllExceptionsFilter` strips stack traces — generic 500 on unhandled | `all-exceptions.filter.ts:38-43` |
| SP-6 | Advisory lock uses `Prisma.sql` parameterized template — no SQL injection | `dedup.ts:45-47` |
| SP-7 | Zod validation on every controller input; no trusted raw `req.body` | controllers passim |
| SP-8 | Pull-overrides PAT only attached to GitHub hosts | `pull-overrides.ts:100` |
| SP-9 | Refresh token rotation on use; revocation on logout + password-reset | `auth.service.ts:113-124, 215-223` |
| SP-10 | Turnstile fail-closed: missing secret key returns `false` | `turnstile.service.ts:29-31` |
| SP-11 | Security headers enforced (HSTS, nosniff, X-Frame-Options, CSP Report-Only) | `next.config.ts`, `main.ts` |
| SP-12 | `0 vulnerabilities` prod and full dep tree | `npm audit` |
| SP-13 | CORS restricted to `APP_URL` only | `main.ts:20` |

---

## Optimization findings

### O-F1 🟡 `PlannedMeal.recipeId` has no index

[`apps/api/prisma/schema.prisma:533`](../../apps/api/prisma/schema.prisma#L533)

`PlannedMeal` declares `@@index([dayId])` but not `@@index([recipeId])`. The swap-history
deduplication checks `swapHistory` (an array column on the same row), not a join, so most
read paths access planned meals via `planId → MealPlanDay → PlannedMeal (dayId)` and are
indexed. However any cross-plan query of "all meals using recipe X" (e.g., a future
admin report, or a recipe-delete cascade check) would full-scan `PlannedMeal`.

**Acceptance:** add `@@index([recipeId])` to `PlannedMeal` and run a migration before tag.
Cost: one background index build on an initially empty table in production.

---

### O-F2 🟡 Pagination count/items mismatch in reviewer list endpoints

[`apps/api/src/review/review.controller.ts:199-220`](../../apps/api/src/review/review.controller.ts#L199)

```ts
const [items, total] = await Promise.all([
  this.prisma.recipeDraft.findMany({ where, skip, take: pageSize, ... }),
  this.prisma.recipeDraft.count({ where }),
]);
const filtered = includeReviewed
  ? items
  : items.filter(row => !row.localeReviews.some(...));  // ← post-DB filter
```

`total` is the unfiltered count; `items` is the filtered slice. A caller requesting page 1
with `pageSize=25&includeReviewed=false` may receive 3 items but `total=100`, giving the
impression there are 97 more when there are actually 0 (the rest are already-reviewed).
The UI cursor advances to page 2 and gets nothing.

**Fix:** move the `includeReviewed` filter into the Prisma `where` clause:

```ts
const reviewedFilter = includeReviewed
  ? {}
  : { localeReviews: { none: { locale, action: 'APPROVE' } } };
const where = { status: { in: ['PENDING', 'APPROVED'] }, locales: { has: locale }, ...reviewedFilter };
```

This makes `total` and `items` consistent and removes the N+1 in-memory filter.

**Note:** `Favorite` and `IngredientNameDraft` reviewer list endpoints have the identical
pattern — fix both at the same time.

---

### O-F3 🟢 Schema index coverage — comprehensive

All hot-path FK columns have matching `@@index`:

| Table | Indexed FKs |
|---|---|
| `RefreshToken` | `userId` |
| `PasswordResetToken` | `userId` |
| `EmailVerificationToken` | `userId` |
| `EmailChangeToken` | `userId` |
| `Profile` | `userId` |
| `WeightEntry` | `profileId, recordedAt` |
| `Notification` | `profileId, readAt`; `profileId, createdAt` |
| `RecipeIngredient` | `recipeId`; `ingredientId` |
| `MealPlan` | `profileId` |
| `MealPlanDay` | `planId` |
| `PlannedMeal` | `dayId` (**missing** `recipeId` — O-F1) |
| `Favorite` | `profileId` |
| `FavoriteSet` | `profileId` |
| `InventoryItem` | `profileId`; `profileId, ingredientId` |
| `ShoppingList` | `planId` |
| `ShoppingListItem` | `listId` |
| `AiProviderConfig` | `userId` |
| `AiUsageLog` | `userId`; `createdAt`; `userId, mode, createdAt` (quota query) |
| `RecipeDraft` | `status`; `batchId`; `source`; `createdByUserId` |
| `IngredientNameDraft` | `status`; `batchId`; `ingredientSlug` |

---

### O-F4 🟢 Worker hourly scan — indexed

`WeightReminderService.scan()` runs every 1 hour via `worker.ts`. The query hits
`Profile` and `Notification` tables filtered by `lastWeightReminderAt` and
`weightReminderCadence`. The `@@index([profileId, createdAt(sort: Desc)])` on
`Notification` and `@@index([userId])` on `Profile` support these patterns. No
full-table scans expected at moderate scale.

---

## Carry-over open items from Run 001 (unchanged)

These blockers were not addressed between Run 001 and Run 002:

| WI | Scope | Status |
|---|---|---|
| WI-B4 | Service tests ≥ 85% | ⛔ Open |
| WI-B5 | Controller tests ≥ 80% | ⛔ Open |
| WI-B6 | Web tests ≥ 70% | ⛔ Open |
| WI-B7 | E2E golden-path smoke | ⛔ Open |
| WI-E2 | Hot-path profiling + DB indexes under load | ⛔ Open |
| WI-E3 | Bundle analysis + lazy-load | ⛔ Open |
| CSP enforcement | Promote from Report-Only after browser QA | ⛔ Open |
| Screenshots | Seeded instance needed | ⛔ Open |
| WI-A1 | Security risk register (`docs/security/accepted-risks.md`) | ⛔ Open |

---

## Updated release-blocker list

Adding new findings to the list from Run 001:

1. **WI-S1** — Fix SSRF in Ollama `baseUrl` test probe. 🟠
2. **WI-S2** — Add fetch timeouts to `testOpenAiCompatible` + `testAnthropic`. 🟠
3. **WI-B4…B7** — Coverage floors + e2e smoke. 🔴
4. **WI-E2/E3** — Perf profiling + bundle. 🟠
5. **CSP enforcement** — Promote after QA. 🟡
6. **WI-A1** — Security register populated + sign-off. 🟡

Items 3–6 carry over unchanged. Items 1–2 are new from this run. The Mediums (S-F3–S-F6,
O-F1, O-F2) should be cleared before tag but are not individually ship-stoppers.

---

## Suggested execution order (pick-up from Run 002)

1. **WI-S2** — fetch timeout (30 min; no schema change; unblocks the DoS surface).
2. **WI-S1** — Ollama URL validation (2–4 h; closes the SSRF).
3. **WI-S6** — reviewer throttle (5 min; one decorator line).
4. **WI-S3** — Swagger gate on `NODE_ENV` (5 min; one `if` block).
5. **O-F2** — fix reviewer pagination (1–2 h; Prisma `where` clause refactor + test).
6. **O-F1** — add `PlannedMeal.recipeId` index + migration (15 min).
7. **WI-S4** — dedicated reviewer + bundle secrets (1 h; env schema + wiring).
8. **WI-S5** — `data-hash.ts` `process.env` (15 min).
9. Continue with Run 001 backlog: WI-B4 → WI-B5 → WI-B6 → WI-B7 → WI-E2 → WI-E3 → WI-A1.

---

## Appendix — what was reviewed this run

- `npm audit --omit=dev` and `npm audit` — both `found 0 vulnerabilities`
- Source grep: `process.env` outside `config/` (2 residual, 1 flagged), shell invocation patterns, raw SQL
- Manual review: `auth.service.ts`, `auth.controller.ts`, `common/crypto.ts`, `basic-auth.guard.ts`,
  `review/session.ts`, `review/review.controller.ts`, `all-exceptions.filter.ts`,
  `config/env.ts`, `common/security.ts`, `main.ts`, `app.module.ts`,
  `ai/ai-test.service.ts`, `ai/ai-key.service.ts`, `ai/ai.controller.ts`,
  `admin/drafts/drafts.controller.ts`, `admin/drafts/dedup.ts`,
  `admin/drafts/ship/pull-overrides.ts`, `admin/seed/data-hash.ts`,
  `apps/web/next.config.ts`, `apps/web/src/lib/security-headers.ts`,
  `auth/jwt.strategy.ts`, `auth/turnstile.service.ts`, `prisma/schema.prisma` (full)
- Not done this run: runtime DAST, bundle measurement, live coverage %, DB query timing under load.
