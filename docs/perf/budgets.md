# Performance budgets

The numeric budgets the [F100](../release/F100-prerelease-audit.md) gate checks
before a tag. A budget is a **ceiling**: crossing it is a regression to
investigate, not an automatic block, but it must be explained.

> Targets are set now; "measured" holds a first live reading taken 2026-06-24
> against the Docker stack with a seeded DB (405 ingredients, 18 recipes) — these
> are single-run, end-to-end (incl. HTTP), not yet p95-under-load. No premature
> micro-optimisation — every change carries a before/after number.

## Reference load

- Profile: 1 adult, 2000 kcal/day target, 5 meals/day.
- Plan: 28-day generation (the widest the UI offers).
- Catalogue: ~1k curated ingredients, ~30k composed recipes seeded.

## Server hot paths

| Path | Budget (p95) | Measured | Notes |
|---|---|---|---|
| `POST /meal-plans/generate` (28-day, 5 meals) | ≤ 1500 ms | **~183 ms** ✅ | Runs synchronously on the request path; optimiser + reuse scoring dominate. |
| `POST /meal-plans/generate` (7-day, 3 meals) | ≤ 800 ms | **~110 ms** ✅ | — |
| `engine/optimisePlan` (pure) | ≤ 400 ms | — | Deterministic; no I/O. (Bounded above by the generate timings.) |
| `engine/aggregateShoppingList` (28-day) | ≤ 50 ms | — | Pure aggregation over planned lines. |
| `POST /shopping-lists/generate` | ≤ 250 ms | sub-second ✅ | Aggregation + ownership check + read. |
| `GET /recipes` (search/paginate) | ≤ 200 ms | sub-second ✅ | Indexed lookups only. |
| Any single Prisma query | ≤ 50 ms | — | Anything above gets an index (see below). Re-measure at full catalogue scale (~7k ingredients / ~30k recipes); the live reading above was at the seeded baseline. |

## Database

- Every foreign key and every column used in a `where`/`orderBy` on a hot read
  must be indexed. Audit `apps/api/prisma/schema.prisma` against the queries in
  `meal-plans.service.ts`, `shopping-lists.service.ts`, `recipes.service.ts`.
- Slow-query check: log queries > 50 ms during the profiling run and add indexes.

## Web bundles

Budgets are gzipped first-load JS per route (from `next build` output).

| Route | Budget (first-load JS, gz) | Measured | Notes |
|---|---|---|---|
| `/` (landing) | ≤ 120 kB | — | Mostly static. |
| `/dashboard` | ≤ 200 kB | — | Recharts donut should be lazy-loaded. |
| `/meal-plans` | ≤ 220 kB | — | Board + Framer Motion. |
| `/shopping-lists` | ≤ 200 kB | — | `@react-pdf/renderer` (`pdf-document.tsx`) must be dynamically imported, not in the route's initial chunk. |
| Shared baseline | ≤ 110 kB | — | Framework + shared chunks. |

## Lazy-load targets (WI-E3)

These heavy modules must not sit in a route's initial chunk:

- `recharts` — the dashboard macro donut.
- `@react-pdf/renderer` — `apps/web/src/app/(app)/shopping-lists/pdf-document.tsx`.
- Framer-heavy views where the animation isn't above the fold.

## How to measure

```bash
# Bundles
npm run build -- --filter=@diet-app/web      # read the per-route first-load JS table

# Server hot paths — profile against a seeded DB (see docs/ops for seeding)
#   time a 28-day generate; log Prisma query durations; capture before/after.
```
