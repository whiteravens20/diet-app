# Architecture Overview

## System shape

```
                    ┌──────────────┐
   Browser ───────▶ │  web (Next)  │ ──┐
                    └──────────────┘   │  REST /api  (typed by packages/shared)
   Android app ─────────────────────────┼────────────┐
                                        ▼            │
                                 ┌──────────────┐    │
                                 │  api (Nest)  │────┤
                                 └──────┬───────┘    │
              enqueue plan jobs ───────▶│            │
                                 ┌──────▼───────┐    │
                                 │ worker (Nest)│    │
                                 └──────┬───────┘    │
                       ┌────────────────┼────────────┼───────────┐
                       ▼                ▼            ▼           ▼
                  ┌─────────┐     ┌──────────┐  ┌─────────┐  ┌────────┐
                  │ Postgres│     │  Redis   │  │ Ollama  │  │ AI SaaS│
                  │ (Prisma)│     │ (BullMQ) │  │ (local) │  │  APIs  │
                  └─────────┘     └──────────┘  └─────────┘  └────────┘
```

## Components

| Component | Tech | Responsibility |
|---|---|---|
| `apps/web` | Next.js 16, React 19, Tailwind 4 | UI: dashboard, wizard, planner, shopping list. |
| `apps/api` | NestJS 11, Prisma 7 | REST API, auth, deterministic engine, AI orchestration. |
| `apps/api` (worker) | NestJS + BullMQ | Background meal-plan generation. Same codebase, `worker.ts` entry. |
| `packages/shared` | TypeScript + Zod | The API contract: every request/response schema + type. |
| Postgres | 18 | Curated database + user data. |
| Redis | 8 | Cache + BullMQ job queue. |
| Ollama | optional | Local self-hosted AI models. |

## Layering inside the API

```
Controller        HTTP shell — validates input against packages/shared (Zod)
   │
Service           Use-case orchestration, ownership checks, persistence
   │
Engine (pure)     Deterministic math — calorie, optimiser, shopping, substitution
   │
Prisma            Data access
```

The **engine** (`apps/api/src/engine`) is pure functions only: no I/O, no randomness
beyond explicit seeds, no AI. This is what makes calorie/macro results reproducible. The
**AI layer** (`apps/api/src/ai`) sits beside services as an optional assistant whose
output always passes back through the engine for validation.

## Information architecture (web)

```
/                       Landing (public)
/login  /register       Auth
/dashboard              Calorie target, macro split, plan summary
/profile                Profile manager + create wizard
/meal-plans             Generate / view / regenerate plans
/recipes                Recipe library, search, favorites
/shopping-lists         Consolidated lists
/settings               Account + AI provider (BYOK) configuration
```

## Request lifecycle — "generate a plan"

1. `web` POSTs `GeneratePlanRequest` to `/api/meal-plans/generate`.
2. `MealPlansController` validates it against the Zod schema from `packages/shared`.
3. `MealPlansService` loads the profile, runs the deterministic calorie engine, loads
   eligible recipes, and calls the optimiser engine (`optimisePlan`).
4. The plan is persisted (`MealPlan` → `MealPlanDay` → `PlannedMeal`) and returned.
5. (Optional, Phase 2) Large jobs are enqueued on Redis/BullMQ and run in the `worker`.

## Why these choices

See [adr/](../adr/) for the recorded decisions: NestJS over FastAPI, two repos, Prisma 7
driver adapters, the ESLint major-version fallback, and curated-DB-as-source-of-truth.
