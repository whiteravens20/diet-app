# F100 — Pre-release Readiness Audit · Run 001

> **F100** is the recurring release-readiness gate (see the F100 row in
> [`docs/product/product-spec.md`](../product/product-spec.md)). It is re-run **in full**
> before every tag (`v1.0.0`, `v1.1.0`, …) and only ships when every scope item is green.
> This file is **Run 001** — the inaugural audit. It is a findings + remediation document:
> it changes no application code. Future sessions execute the work items below, then
> re-run the gate and append a new run section (or supersede this file).

| | |
|---|---|
| **Run** | 001 (first pre-release audit) |
| **Date** | 2026-06-24 |
| **Branch / commit** | `dev` @ `7137e74` |
| **Target tag** | `v1.0.0` (not yet cut) |
| **Method** | Static analysis + dependency audit + manual review of security-sensitive surfaces. No DAST/runtime fuzzing this run. |
| **Verdict (initial)** | **🔴 NO-GO** — release blockers open in scopes (b), (e), (f), (g). |
| **Verdict (after remediation)** | **🟠 NOT YET** — scopes (a)(c)(d)(f)(g) brought to green; remaining blockers are the test-coverage floors + e2e (b), runtime profiling (e), and CSP enforcement + screenshots. See [§ Remediation log](#remediation-log--run-001). |

---

## Remediation log — Run 001

A remediation pass (2026-06-24, on `dev`) executed the work items below. Full
suite green afterwards: `lint` (0 warnings, `--max-warnings 0`), `typecheck`,
`test` (api 193 + shared 5 + web 13), API `build`, `knip`, and the new
`check:docs` link check.

### Resolved ✅

| Scope | Work | Evidence |
|---|---|---|
| (d) | Dead BullMQ queue stripped from `worker.ts` (weight-reminder cron **kept** — the audit had mis-flagged the whole file as dead); `bullmq`/`ioredis`/`@nestjs/bullmq` + Redis removed from env, CI, all compose files, `.env.example`, docs. `page-placeholder.tsx` + orphaned i18n removed. | `worker.ts`, `infra/docker-compose*.yml`, `.github/workflows/test.yml` |
| (d) | Unused deps pruned (`ollama`, `fast-check`, `nestjs-zod`, web `zod`, `@eslint/eslintrc`); unlisted deps declared (`express`, `@types/express`, `@nestjs/schematics`, `postcss`); `pg`/`@types/pg` + `@nestjs/testing` documented in `knip.jsonc`. | `knip.jsonc`, package.json × 3 |
| (f) | Security headers: web `headers()` (HSTS, nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy enforced; CSP **Report-Only**) + helmet on the API. Two integration tests. | `apps/web/src/lib/security-headers.ts(.test.ts)`, `apps/api/src/common/security.ts(.test.ts)` |
| (f) | `process.env` routed through `ConfigService` (Prisma adapter, BYOK runner keys, USDA importer); `FDC_*`/`SEED_DATA_DIR` schema-validated; ESLint `no-restricted-syntax` bans new `process.env` in `apps/api/src`. | `config/env.ts`, `prisma.service.ts`, runners, `eslint.config.mjs` |
| (f) | Explicit `@Throttle` (5/60s) on the AI-cost admin generate routes. | `drafts.controller.ts` |
| (a) | `docs/security/` created: posture, CSP rollout, accepted-risks register, Run 001 sign-off (0 open Critical/High). | `docs/security/*` |
| (b) | Coverage provider (`@vitest/coverage-v8`) installed; thresholds + Turbo `test:cov` task + CI gate wired; **engine glob ≥95%** met (added `shopping.ts` + `units.ts` tests). | `apps/api/vitest.config.ts`, `turbo.json`, `test.yml` |
| (c) | `--max-warnings 0` on every workspace lint script; all 8 `eslint-disable` directives annotated with a reason. | package.json × 3, source |
| (e) | `docs/perf/budgets.md` with numeric hot-path + bundle budgets. | `docs/perf/budgets.md` |
| (g) | All ~35 `Phase X` markers stripped from source comments; CI marker guard added; **build bug fixed** (`nest-cli.json` few-shot assets pointed at a stale `admin/translate` path — they weren't bundled into `dist`); **leaked local plan path removed** from ADR-0008; README feature matrix; doc link-check (`check:docs`) + CI. | source, `nest-cli.json`, `docs/adr/0008`, `README.md`, `scripts/check-doc-links.mjs` |

### Remaining release blockers ⛔ (need a running stack / multi-session)

| Scope | Work item | Why not done here |
|---|---|---|
| (b) | **WI-B4** services → 85%, **WI-B5** controllers → 80% | ~20 services + 19 controllers; controller tests need a Nest e2e harness (vitest here isn't wired for Nest DI decorator metadata — see `security.test.ts` note). Gate is in place to enforce as suites land. |
| (b) | **WI-B6** web → 70% | Runner + first tests landed (Button, `cn`, security-headers); reaching 70% is the bulk of the component tree. |
| (b) | **WI-B7** e2e golden-path smoke | Needs the `docker compose` stack (api+web+postgres) running; can't be authored-and-verified statically. |
| (e) | **WI-E2/E3** profiling + indexes + bundle analysis | Needs a seeded DB under load and a real `next build` bundle measurement. Budgets are documented; numbers are pending. |
| (f) | **CSP enforcement** | Report-Only until browser-QA'd across 6 palettes × light/dark, then promote (see [csp.md](../security/csp.md), accepted-risk AR-2). |
| (g) | **Screenshots** | Need a seeded instance to capture dashboard/plan/shopping-list. |

> Knip's remaining "unused exports/types" list is the intentional documented
> remainder — module-surface result/option types and test-support helpers.

---

## How to read this document

- Each scope **(a)–(g)** maps 1:1 to the F100 spec sub-items.
- Every finding has a **severity** and, where actionable, a **Work Item** `WI-<scope><n>`
  with concrete steps and an **Acceptance** line (the objective "done" test).
- **Severity scale:** 🔴 Blocker (must be green before tag) · 🟠 High · 🟡 Medium ·
  🟢 Pass / informational.
- Work items are independent enough to be picked up one-per-session. Suggested order is
  in [§ Prioritised backlog](#prioritised-backlog).

## Headline result

The **code-level security and type posture is strong** — far better than a first audit
usually finds. The gaps are almost entirely about **release machinery that was never
built**: a real test/coverage gate, HTTP security headers, perf budgets, and a docs
refresh. None of the blockers are deep design problems; they are bounded, well-scoped
additions.

_Status shown as initial → post-remediation (see [§ Remediation log](#remediation-log--run-001))._

| Scope | Status | One-line |
|---|---|---|
| (a) Security audit | 🟠 → 🟢 | Register + CSP doc + posture + Run 001 sign-off created; 0 open Critical/High. |
| (b) Test coverage | 🔴 → 🟠 | Gate built + enforced (provider/thresholds/Turbo/CI); engine ≥95%; **service/controller/web floors + e2e remain**. |
| (c) Lint + typecheck | 🟢 → 🟢 | `--max-warnings 0` on every workspace; all 8 `eslint-disable` annotated; 0 `@ts-ignore`/`any` in source. |
| (d) De-slop | 🟡 → 🟢 | Dead worker queue + Redis removed, deps pruned, unlisted declared, knip deps clean (export remainder documented). |
| (e) Code optimisation | 🟠 → 🟠 | `docs/perf/budgets.md` written; **profiling/indexes/bundle measurement remain** (need runtime). |
| (f) Hack-safe | 🔴 → 🟢¹ | Security headers (helmet + web `headers()`) + tests; `process.env` routed through config + ESLint guard; AI-route throttle. ¹CSP enforcing pending QA (AR-2). |
| (g) Docs refresh | 🟠 → 🟢² | Phase markers stripped + CI guard; README feature matrix; doc link-check + CI; fixed a build bug + a leaked local path. ²Screenshots remain. |

---

## 0 · How to re-run the gate

```bash
# Baseline (all must exit 0)
npm run lint
npm run typecheck
npm test
npm audit --omit=dev          # production deps
npm audit                     # full tree

# Dead-code / unused (read-only, via npx cache — installs nothing into the repo)
npx --yes knip@5 --no-progress

# Coverage — NOTE: provider is not installed yet; see WI-B1. Once installed:
npm test -- --coverage        # per-workspace thresholds enforced by vitest.config
```

Evidence captured this run is reproducible with the commands inline in each section.

---

## (a) · Full security audit

### Passes 🟢

| ID | Area | Finding | Evidence |
|---|---|---|---|
| A1 | Dependencies | **0 vulnerabilities**, prod and full tree. | `npm audit --omit=dev` → `found 0 vulnerabilities`; `npm audit` → same. |
| A2 | Secrets / crypto | BYOK keys **AES-256-GCM encrypted at rest** (`AI_KEY_ENCRYPTION_SECRET`); PII (email) encrypted at rest (`DATA_ENCRYPTION_SECRET`); passwords hashed + peppered; equality lookups via keyed HMAC (fresh per-call IV). | [`apps/api/src/common/crypto.ts`](../../apps/api/src/common/crypto.ts), [`apps/api/src/ai/ai-key.service.ts:48,124`](../../apps/api/src/ai/ai-key.service.ts), [`apps/api/src/config/env.ts:26-30`](../../apps/api/src/config/env.ts) |
| A3 | Admin Basic-Auth | `timingSafeEqual` constant-time compare; **fail-closed** when `ADMIN_PASSWORD` empty/placeholder; user+pass compared unconditionally (no username-leak via early exit). | [`apps/api/src/admin/basic-auth.guard.ts`](../../apps/api/src/admin/basic-auth.guard.ts) |
| A4 | Reviewer session | Signed JWT cookie, `httpOnly` + `sameSite=lax`, 7-day TTL. | [`apps/api/src/review/session.ts`](../../apps/api/src/review/session.ts) |
| A5 | Ship runner (gh-mode) | Git/gh invoked via `spawnSync('git', [args])` — **array args, no shell** → not command-injection-prone. | [`apps/api/src/admin/drafts/ship/upstream-mode.ts:67,387,409`](../../apps/api/src/admin/drafts/ship/upstream-mode.ts) |
| A6 | AI prompt construction | Recipe/ingredient prompts are **admin-only** (curation), the model picks ingredients **only from an in-prompt closed catalogue** ("may NOT invent or rename"), and output is **validated + recomputed by the deterministic engine**. Prompt-injection surface is bounded. | [`apps/api/src/admin/drafts/recipe-generator.prompt.ts:237`](../../apps/api/src/admin/drafts/recipe-generator.prompt.ts) |
| A7 | Input validation | Controllers take `@Body() body: unknown` and validate via Zod / `ZodValidationPipe` — no raw trusted `req.body`. | See (f) and `auth.controller.ts:33,63`. |

### Findings

- **A-F1 🟡 No `docs/security/accepted-risks.md`.** The gate requires accepted Mediums to be
  documented. There are currently no accepted risks recorded.
- **A-F2 🟡 No security sign-off artifact.** A full `/security-review`-style pass should be
  recorded per run with a reviewer + date.

#### WI-A1 — Create the security risk register 🟡
1. Create [`docs/security/accepted-risks.md`](../security/accepted-risks.md) with a table:
   `ID | Finding | Severity | Why accepted | Compensating control | Review-by date | Owner`.
2. Seed it with the Mediums from this audit that are **accepted rather than fixed**
   (e.g. if F-F2 `process.env` reads are deferred — see (f)).
3. Add a `docs/security/README.md` index linking the register + this audit.
- **Acceptance:** `docs/security/` is non-empty; every 🟡 in this report is either fixed or
  has a row in `accepted-risks.md`.

#### WI-A2 — Record a security sign-off 🟡
1. Run the `/security-review` skill (or `wr-pentest` against a locally-run instance) across
   the surfaces named in the F100 spec: auth, BYOK key handling, admin Basic-Auth, reviewer
   cookie, all `/api/*` controllers, `data/` file writers, gh-mode ship runner, USDA
   importer, AI prompt construction.
2. Fix every Critical/High before tag; append the dated result to this file as
   "Run 001 — security sign-off".
- **Acceptance:** Each named surface has an explicit pass/fix line; no open Critical/High.

---

## (b) · Test coverage + updates  🔴 (release blocker)

### Current state

```
api:    17 test files   ·  shared: 1   ·  web: 0 (no test runner configured)
e2e:    none
coverage provider: NOT installed (vitest --coverage currently hangs on the install prompt)
CI gate: none — test.yml runs `npm test` for @diet-app/api only; the `web` job has no test step
```

**Floors (from F100 spec):** engine ≥ 95% · services ≥ 85% · controllers ≥ 80% · web ≥ 70%.
None are measured or enforced today.

#### File-level gap map (proxy for coverage — sibling `*.test.ts` presence)

- **Engine** (`apps/api/src/engine`): tested ✓ `nutrition`, `optimizer`, `rebalance`,
  `substitution`, `units`. **✗ `shopping.ts` has NO test** — and it is the F7 shopping-list
  aggregator, a core deterministic surface. `index.ts` is re-exports only.
- **Services**: only `users.service` and `notifications/weight-reminder.service` are tested.
  **20 services untested**, including the large core ones: `meal-plans.service.ts`,
  `shopping-lists.service.ts`, `auth.service.ts`, `inventory.service.ts`, `recipes.service.ts`,
  `profiles.service.ts`, all `ai/ai-*.service.ts`.
- **Controllers**: **0 of 19** have unit/integration tests.
- **Web**: **0** test files, no `vitest.config`, no Testing Library deps.

#### WI-B1 — Install coverage provider + thresholds 🔴
1. Add dev dep at the **root** (shared by workspaces): `@vitest/coverage-v8` (pin to the
   installed `vitest` major).
2. In [`apps/api/vitest.config.ts`](../../apps/api/vitest.config.ts) add:
   ```ts
   test: {
     // …existing…
     coverage: {
       provider: 'v8',
       reporter: ['text-summary', 'text', 'json-summary', 'html'],
       include: ['src/**/*.ts'],
       exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/**/*.module.ts', 'src/**/*.dto.ts'],
       thresholds: {
         // global floor; raise per-glob as suites land
         lines: 60, functions: 60, branches: 60, statements: 60,
         'src/engine/**': { lines: 95, functions: 95, branches: 90, statements: 95 },
       },
     },
   }
   ```
   Start the global floor at **today's real number** (measure first), then ratchet up toward
   the spec floors as WI-B3…B6 land — never lower it (that's the "fails on regression" gate).
3. Add `"test:cov": "vitest run --coverage"` to `apps/api/package.json`.
- **Acceptance:** `npm test -- --coverage -w apps/api` prints a summary and **fails** when a
  threshold regresses.

#### WI-B2 — CI coverage gate 🔴
1. In [`.github/workflows/test.yml`](../../.github/workflows/test.yml) `api` job, replace the
   `npm run test` step with `npm run test:cov -- --filter=@diet-app/api`.
2. Add a `test` step to the **`web`** job (after WI-B6 gives it a runner) and a `shared` test
   step (`packages/shared` already has `contract.test.ts`).
3. Optionally upload `coverage/` as an artifact for the PR.
- **Acceptance:** CI red on a coverage regression; green at current numbers.

#### WI-B3 — Engine `shopping.ts` unit tests 🟠
1. Add `apps/api/src/engine/shopping.test.ts` covering: merge of duplicate ingredients,
   unit normalisation, aisle/group ordering, and "already have" deduction (F7). Use seeded
   inputs (determinism rule).
2. Push the `src/engine/**` coverage to ≥ 95%.
- **Acceptance:** engine glob threshold met with `shopping.ts` exercised.

#### WI-B4 — Service-layer tests to ≥ 85% 🟠
Prioritise by risk/size: `meal-plans.service` (generator orchestration), `shopping-lists.service`,
`auth.service`, `inventory.service`, `ai/ai-router.service` + `ai/ai-quota.service`,
`recipes.service`, `profiles.service`. Mock Prisma (`@nestjs/testing` is already a dep — note
it's currently flagged unused by knip; this work re-justifies it). Keep nutrition assertions
delegating to the engine (never re-implement macro math in tests).
- **Acceptance:** services glob ≥ 85%.

#### WI-B5 — Controller integration tests to ≥ 80% 🟠
Use Nest's `Test.createTestingModule` + `supertest` against an in-memory app. Cover happy path
+ a validation-rejection (Zod 400) + an authz rejection per controller. The security-headers
integration test (WI-F1) lives here too.
- **Acceptance:** controllers glob ≥ 80%; every controller has ≥ 1 happy + 1 rejection test.

#### WI-B6 — Web test runner + component tests to ≥ 70% 🟠
1. Add to `apps/web`: `vitest`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`,
   `@testing-library/user-event`, `@testing-library/jest-dom`.
2. Create `apps/web/vitest.config.ts` (`environment: 'jsdom'`, `setupFiles` for jest-dom +
   `next-intl` test provider) and add `"test": "vitest run"` to its `package.json`.
3. Cover the design-system primitives and high-traffic surfaces: `components/ui/*`,
   `empty-state.tsx`, `page-banner.tsx`, `sidebar.tsx`, the dashboard stat cards, and the
   meal-plan board. Assert i18n keys render (both `en`/`pl` load).
- **Acceptance:** `npm test -w apps/web` runs; web coverage ≥ 70%.

#### WI-B7 — E2E golden-path smoke 🟠
1. Add Playwright at the repo root (`playwright.config.ts`, `e2e/` dir) wired against
   `docker compose` (api + web + postgres).
2. One smoke spec per shipped F-row's golden path. Minimum set:

   | Flow | Path |
   |---|---|
   | Sign-up + email verify (F1) | register → verify-email token → login |
   | Profile (F2) | create profile → calorie target shown |
   | Plan (F3/F4/F17/F22) | generate 7-day plan → per-day delta visible |
   | Recipes/swap/sub (F5/F6) | open recipe → substitute ingredient → delta preview |
   | Shopping (F7) | generate list → check item → "already have" |
   | Inventory (F8/F15) | tick shopping item → appears in inventory |
   | Favorites/sets (F13) | favourite a recipe → build a set |
   | Settings/i18n (F14) | switch locale → UI re-renders in `pl` |
   | AI BYOK (F10) | add key → `hasKey` true → core still works without key |
   | Admin/curation/review (F16/F18) | Basic-Auth gate → draft → reviewer approve |

3. Run the smoke job in CI (can be a separate workflow gated on `dev`/`main`).
- **Acceptance:** the golden path of every shipped F-row has a passing smoke test in CI.

> **Note (`it.skip`/`xfail`):** ✅ already clean — a scan found **zero** skipped/`todo`/`only`
> tests in the codebase (the 24 `skip` hits are all domain logic: meal-plan "skip day" and
> USDA "skipped" counts, not test annotations).

---

## (c) · Lint + typecheck clean  🟢 (nearly there)

### Passes 🟢
- `npm run lint` and `npm run typecheck` **exit 0** across all 3 workspaces.
- **Source `@ts-ignore` / `@ts-expect-error`: 0.** (The 35 hits in a raw grep are all inside
  `apps/web/.next/` generated build artifacts — not source. Exclude `.next/` when scanning.)
- **Source `any`: 0 meaningful.** (Two grep hits are a doc-comment word "any" and a `.d.ts`
  in `dist/` build output.)

### Findings
- **C-F1 🟡 `--max-warnings 0` not proven.** Exit 0 means no *errors*; the spec wants **zero
  warnings**.
- **C-F2 🟡 8 `eslint-disable` directives unannotated.** Locations:
  - `apps/api/src/users/users.service.test.ts:67,81,102,112` — `no-explicit-any` for Prisma
    mocks (test-only; acceptable, annotate).
  - `apps/web/src/app/admin/admin-panel.tsx:366` — `react-hooks/exhaustive-deps`.
  - `apps/web/src/app/(app)/settings/page.tsx:148` — `react-hooks/set-state-in-effect`.
  - `apps/web/src/components/theme-toggle.tsx:16` — `set-state-in-effect` (hydration).
  - `apps/web/src/components/language-switcher.tsx:103` — `set-state-in-effect` (hydration).

#### WI-C1 — Enforce zero warnings 🟡
1. Add `--max-warnings 0` to each workspace `lint` script (`eslint src --max-warnings 0`,
   `eslint . --max-warnings 0`).
2. Fix or annotate anything it surfaces.
- **Acceptance:** lint scripts carry `--max-warnings 0` and exit 0.

#### WI-C2 — Annotate the disables 🟡
Add a one-line `// disable: <why>` (or `eslint-disable-next-line <rule> -- <why>`) above each
of the 8 directives. The web hydration ones are legitimate; document why rather than remove.
- **Acceptance:** every `eslint-disable` has an inline justification.

---

## (d) · De-slop pass  🟡

Source: `npx --yes knip@5 --no-progress` (full output reproduced below; verify before deleting —
knip can false-positive on dynamically-loaded / runtime-peer deps).

### Dead files
- `apps/api/src/worker.ts` — the never-wired BullMQ/Redis "Phase 2" worker.
- `apps/web/src/components/page-placeholder.tsx` — unused component.

### Unused dependencies (verified 0 source imports unless noted)
| Dep | Workspace | Note |
|---|---|---|
| `@nestjs/bullmq`, `bullmq`, `ioredis` | api | Tied to the dead `worker.ts`. `bullmq`'s only import **is** `worker.ts`. |
| `ollama` | api | 0 imports — the Ollama adapter uses `fetch`, not this SDK. |
| `nestjs-zod` | api | 0 imports — replaced by the hand-rolled `ZodValidationPipe`. **Verify** before removing. |
| `pg` / `@types/pg` | api | 0 direct imports, **but** likely a runtime peer of `@prisma/adapter-pg` (`PrismaPg`). **Do NOT remove without testing a real DB connection.** |
| `fast-check` | api (dev) | 0 usages — property-testing lib never adopted. |
| `@nestjs/testing` | api (dev) | 0 usages **today**; WI-B4/B5 will use it — keep, or add when those land. |
| `zod` | web | 0 direct imports — web validates via `packages/shared`. |
| `@eslint/eslintrc` | web (dev) | 0 usages. |

### Unlisted dependencies (used but not declared — should be direct deps)
- `express` — imported in `drafts.controller.ts`, `all-exceptions.filter.ts`, `review.controller.ts`,
  `reviewer-session.guard.ts` (typed `Request`/`Response`). Add `express` + `@types/express`.
- `@nestjs/schematics` (in `nest-cli.json`), `postcss` (in `postcss.config.mjs`) — declare them.

### Unused exports / types
- **24 unused exports** and **54 unused exported types** (full list in
  `/tmp/.../scratchpad/f100/knip.log` at audit time; re-run knip to regenerate). Many are
  internal helpers exported only for tests (`__clearBundleStashForTests`, `scoreRecipe`,
  `reuseScore`, `seededJitter`, engine constants `KCAL_PER_GRAM` / `TRAINING_DAY_FACTOR` /
  `REST_DAY_FACTOR`) — keep those exported but consider `@internal` JSDoc; the rest
  (DTO/interface types never imported) should be down-scoped to non-exported or deleted.

#### WI-D1 — Remove dead files + vestigial worker stack 🟡
1. Delete `apps/api/src/worker.ts` and `apps/web/src/components/page-placeholder.tsx`.
2. Remove `@nestjs/bullmq`, `bullmq`, `ioredis` from `apps/api/package.json`.
3. Remove the now-vestigial **Redis service + `REDIS_URL`** from
   [`.github/workflows/test.yml`](../../.github/workflows/test.yml) and from any
   `docker-compose`/env docs that provision Redis solely for the worker. (Confirm nothing
   else uses Redis first.)
- **Acceptance:** knip no longer lists these; `npm run build`/typecheck/test still green; CI
  no longer spins an unused Redis.

#### WI-D2 — Prune the remaining unused deps 🟡
Remove `ollama`, `fast-check`, `@eslint/eslintrc`, web `zod`. **Verify-then-remove**
`nestjs-zod`, `pg`/`@types/pg` (run the app against a real Postgres after removing `pg` — if it
breaks, restore and add a knip ignore with a comment).
- **Acceptance:** `npm audit`/build/test green; intentionally-kept deps are in knip's ignore
  list with a reason.

#### WI-D3 — Fix unlisted deps + prune exports 🟢/🟡
1. Add `express`(+`@types/express`), declare `@nestjs/schematics`, `postcss`.
2. Down-scope or delete the 24 exports / 54 types that are never imported (keep test-only
   helpers exported, tagged `@internal`).
- **Acceptance:** knip "Unlisted dependencies" and "Unused exports/types" sections shrink to
  an intentional, documented remainder.

---

## (e) · Code optimisation  🟠

No work has been done here. None of the spec's deliverables exist yet.

#### WI-E1 — Create `docs/perf/budgets.md` 🟠
Document bundle-size budgets per route and the hot-path latency targets (28-day plan,
5 meals/day, ~1k ingredients). This is the artifact the gate references.
- **Acceptance:** `docs/perf/budgets.md` exists with numeric budgets.

#### WI-E2 — Profile the hot paths 🟠
1. Profile `meal-plans.service` generation and `engine/shopping.ts` aggregation under the
   realistic load above; capture before/after numbers.
2. Any Prisma query crossing **50 ms** gets an index (review `schema.prisma` for missing
   indexes on FKs and the planner's lookup columns).
- **Acceptance:** a perf note with before/after numbers; indexes added for >50 ms queries.

#### WI-E3 — Bundle analysis + lazy-load 🟠
1. Run `next build --turbopack` with bundle analysis; record thresholds in `budgets.md`.
2. Lazy-load non-critical web bundles (e.g. Recharts donut, the PDF document
   `shopping-lists/pdf-document.tsx`, Framer-heavy views).
- **Acceptance:** bundle-analyzer thresholds documented; no route over budget.

> No premature micro-optimisation — every change must carry a before/after number.

---

## (f) · Hack-safe codebase  🔴 (release blocker)

### Passes 🟢
| ID | Control | Evidence |
|---|---|---|
| F1 | **Zod validation everywhere** — controllers read `@Body() body: unknown` then validate; no trusted raw `req.body`. | `auth.controller.ts:33,63`; `@Body() body: unknown` across `drafts`/`review`/`instance-settings` controllers. |
| F2 | **Rate limiting** — global `ThrottlerGuard`; `/auth/*` tightened to 10/60s; meal-plan routes throttled. | `app.module.ts:36-68`, `auth.controller.ts:19`, `meal-plans.controller.ts:54+`. |
| F3 | **No SQL string-building** — all queries via Prisma typed client. | (no raw SQL found) |
| F4 | **Cookie posture** — reviewer cookie `httpOnly` + `sameSite=lax`. | `review/session.ts`. |
| F5 | **Secrets via env-validation layer** — `config/env.ts` Zod-validates all secrets at boot. | `config/env.ts`. |

### Findings
- **F-F1 🔴 No security headers / no Next middleware.** There is **no** `apps/web/middleware.ts`
  and **no** `headers()` in `apps/web/next.config.ts`; no `helmet` on the API. So
  `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`,
  `Referrer-Policy` are all unset. The F100 spec names this explicitly and requires an
  integration test. **This is a release blocker.**
- **F-F2 🟡 `process.env` read outside `config/` (12 sites).** The spec wants secrets resolved
  only through `apps/api/src/config/`. Locations:
  - `prisma/prisma.service.ts:13` (`DATABASE_URL`)
  - `admin/seed/data-hash.ts:48` (`SEED_DATA_DIR`)
  - `admin/usda/runner.ts:60,61` (`FDC_API_KEY`, `FDC_DATA_TYPES`)
  - `admin/drafts/ingredient-namer.runner.ts:352,354,356` and
    `admin/drafts/recipe-generator.runner.ts:496,498,500` (BYOK provider keys)
  - `admin/drafts/ship/upstream-mode.ts:375,385` (passing `process.env` to git subprocess — benign).
- **F-F3 🟡 Verify rate limits on `/api/admin/*` and `/api/admin/translations/fill`.** Global
  throttler covers them, but the spec calls these out specifically — confirm the limits are
  appropriate (the `translations/fill` route invokes the AI provider).
- **F-F4 🟡 CSRF/same-site posture for `/review` and `/api/admin/*` not documented.** Cookie is
  `sameSite=lax`; admin is Basic-Auth (not cookie, so low CSRF risk). Document the reasoning.

#### WI-F1 — Security headers via Next middleware + integration test 🔴
1. Add `apps/web/middleware.ts` (or `headers()` in `next.config.ts`) setting:
   - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Content-Security-Policy` — start in `Content-Security-Policy-Report-Only` to avoid
     breaking next/font, next/image, Framer Motion (inline styles), and Recharts, then
     promote to enforcing. Baseline: `default-src 'self'; img-src 'self' data:;
     style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' <api-origin>;
     frame-ancestors 'none'; base-uri 'self'`. Tune script/style to the app's actual needs
     (prefer a nonce over `'unsafe-inline'` for scripts).
   - Consider `X-Frame-Options: DENY` (or rely on `frame-ancestors 'none'`).
2. Add `helmet` to the NestJS API (`main.ts`) for defence-in-depth on `/api/*` responses.
3. **Integration test** asserting every required header is present on a representative
   web route (and the API). This satisfies the spec's "asserted by an integration test".
4. New user-facing strings? None expected (headers are not UI). If any error copy is added,
   it lands in **both** `en.json` and `pl.json` per CLAUDE.md.
- **Acceptance:** all four headers present on web responses; integration test green; CSP
  enforced (not report-only) before tag.

#### WI-F2 — Route `process.env` through `config/` 🟡
Move the reads in F-F2 behind the typed config layer (extend `env.ts` schema + inject
`ConfigService`), **except** the git-subprocess `...process.env` spread (that's legitimate
process plumbing — annotate it). For the BYOK runner keys, resolve via the existing
`AiKeyService`/config rather than direct `process.env`.
- **Acceptance:** no `process.env.*` outside `apps/api/src/config/` (except the annotated
  subprocess spread); add an ESLint `no-restricted-syntax`/`no-process-env` rule scoped
  outside `config/` to keep it that way.

#### WI-F3 — Confirm admin/AI-route rate limits 🟡
Verify (and test) throttles on `/api/admin/*` and especially `/api/admin/translations/fill`
(AI-cost endpoint). Tighten if the global default is too loose.
- **Acceptance:** explicit throttle on the AI-fill route + a test.

#### WI-F4 — Document CSRF/same-site posture 🟡
Add a short section to `docs/security/` explaining: admin = Basic-Auth (no ambient cookie →
low CSRF), reviewer = `sameSite=lax` signed cookie, JWT access via `Authorization` header
(not cookie). Note any state-changing GET to fix (there should be none).
- **Acceptance:** documented in `docs/security/`.

---

## (g) · Docs refresh  🟠

### Findings
- **G-F1 🟠 `Phase X` markers in code comments (~10).** The spec forbids `Phase` / `F-XX` /
  `coming soon` / `TODO` in code comments. Locations (reword to describe behaviour, not the
  historical phase):
  - `meal-plans/meal-plans.service.ts:1440` ("Phase I.6 / I.7")
  - `meal-plans/swap-rewrite.ts:12` ("Phase I.5 mode B")
  - `instance-settings/instance-settings.service.ts:3` ("Phase H")
  - `review/session.ts:2` ("Phase H")
  - `admin/drafts/drafts.controller.ts:4,6,9` ("Phase C/D/E/H")
  - `admin/drafts/ship/recipe-batches.writer.ts:2` ("Phase E")
  - `web/src/app/admin/curation-card.tsx:8,10` ("Phase C/D")
- **G-F2 🟠 README not release-grade.** [`README.md`](../../README.md) (181 lines) has badges
  but **no screenshots**, no one-line feature matrix linking each F-row to a `/docs` detail
  page, and the self-host quickstart should be re-verified.
- **G-F3 🟡 Empty `/docs` subtrees.** `docs/security` and `docs/perf` are empty (created by
  WI-A1 / WI-E1).
- **G-F4 🟡 `Phase` in shipped docs.** `docs/architecture/overview.md:75` ("Optional, Phase 2")
  and `docs/adr/0006`, `0002` reference phases as roadmap. ADRs/briefs that are explicitly
  **historical record** (`docs/product/original-brief.md`) are exempt; the architecture
  overview should be made present-tense.
- **G-F5 🟡 No broken-link CI for docs.** Spec: "broken links fail the docs CI."

#### WI-G1 — Strip `Phase` markers from code comments 🟠
Reword each comment in G-F1 to describe what the code does now (e.g. "Reviewer-session cookie
helpers." not "(Phase H)."). Add a CI grep guard (`forbidden-paths.yml` already exists — extend
it) that fails on `Phase [A-Z0-9]`/`F-XX`/`coming soon`/`TODO` in `apps/**/src/**`.
- **Acceptance:** 0 phase/TODO markers in source comments; CI guard in place.

#### WI-G2 — Rewrite README as the canonical entry point 🟠
Tagline, one-paragraph what-it-is, **feature matrix** (every shipped F-row → one bullet linking
its `/docs` page), docker-compose self-host quickstart (re-tested), **screenshots** of
dashboard / plan / shopping list, license. Reuse the committed imagery where appropriate but
add real app screenshots.
- **Acceptance:** README renders with screenshots + feature matrix; quickstart verified on a
  clean checkout.

#### WI-G3 — Refresh every `/docs` subtree + add link-check CI 🟡
Re-read `/docs/{product,architecture,adr,security,perf,llm,design,ops}` against what `main`
ships; fix staleness and the G-F4 phase references; add a markdown link-checker to docs CI.
- **Acceptance:** docs match shipped behaviour; link-check CI green and gating.

---

## Release blockers

These **must be green** before cutting `v1.0.0`:

1. **WI-B1 + WI-B2** — coverage provider + CI gate exist and enforce floors. *(b)*
2. **WI-B3…B7** — coverage floors actually met (engine 95 / svc 85 / ctrl 80 / web 70) and
   e2e golden-path smoke in CI. *(b)*
3. **WI-F1** — security headers via Next middleware (CSP enforced) + integration test. *(f)*
4. **WI-E1…E3** — perf budgets documented and met; no >50 ms unindexed query. *(e)*
5. **WI-G2 + WI-G3** — README + docs are release-grade and link-checked. *(g)*
6. **WI-A1 + WI-A2** — security register populated; full security sign-off recorded with no
   open Critical/High. *(a)*

Everything in (c) and (d) and the remaining 🟡s should be cleared too, but they are not, by
themselves, ship-stoppers.

## Prioritised backlog

Suggested execution order (each is a self-contained session):

1. **WI-F1** — security headers + test (small, high-value, unblocks the (f) blocker).
2. **WI-B1 → WI-B2** — stand up the coverage gate at today's numbers (unblocks measurement).
3. **WI-D1** — delete dead worker stack + vestigial Redis (shrinks surface before writing tests).
4. **WI-B3** — engine `shopping.ts` tests (closest floor to reach).
5. **WI-C1/C2 + WI-D2/D3 + WI-F2** — cheap cleanups (warnings, deps, `process.env`).
6. **WI-B4 → WI-B5** — service then controller tests (the long pole).
7. **WI-B6 → WI-B7** — web tests + e2e smoke.
8. **WI-E1 → WI-E3** — perf budgets + profiling + bundle.
9. **WI-G1 → WI-G3** — docs sweep + README + link-check.
10. **WI-A1 → WI-A2** — finalise security register + sign-off (the closing step).

## Appendix — what was checked

- Baseline: `npm run lint`, `npm run typecheck`, `npm test`, `npm audit [--omit=dev]`.
- Dead code: `npx knip@5`.
- Source scans (excluding `.next/`, `dist/`, `node_modules/`): `@ts-ignore`/`@ts-expect-error`
  (0), `any` (0 meaningful), `eslint-disable` (8), test `skip`/`only`/`todo` (0),
  `process.env` outside `config/` (12), `Phase`/`TODO` markers.
- Manual review: `crypto.ts`, `ai-key.service.ts`, `basic-auth.guard.ts`, `review/session.ts`,
  `upstream-mode.ts` (git exec), `recipe-generator.prompt.ts`, file writers, `next.config.ts`,
  `test.yml`, `vitest.config.ts`.
- **Not done this run** (future): runtime DAST/fuzzing, live coverage percentages (provider
  not installed), bundle-size measurement, load profiling.
