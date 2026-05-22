# Testing Strategy

## Layers

| Layer | Tool | What it covers |
|---|---|---|
| Engine unit tests | Vitest | The deterministic core — calorie engine, unit conversion, optimiser, shopping aggregation, substitution, recipe-template composition, AES crypto. |
| Contract tests | Vitest | `packages/shared` Zod schemas accept/reject the right shapes. |
| API typecheck | `tsc --noEmit` | The whole API compiles against the Prisma + shared types. |
| Web build + typecheck | `next build`, `tsc` | Every route compiles and renders. |
| Lint | ESLint 9 (flat) | Code quality across all workspaces. |
| Docker build | CI `docker` job | `api` and `web` images build from a clean context. |

## Priorities

The **deterministic engine is the most heavily tested** part — it is pure, fast to test,
and the correctness guarantee the whole product rests on. Every engine function has unit
tests asserting known reference values (e.g. Mifflin-St Jeor BMR), determinism (same
input → same output), and edge cases (safety-floor clamping, missing unit-conversion
factors, constraint violations).

## Running

```bash
npm test            # all workspaces (Turbo)
npm test -- --filter=@diet-app/api
npm run typecheck
npm run lint
```

## CI

`.github/workflows/test.yml` runs three jobs — `api`, `web`, `docker` — which are the
required status checks on the protected `main` branch. The `api` job spins up Postgres 18
and Redis 8 service containers, generates the Prisma client, then lints, typechecks,
tests and builds.

## Roadmap

- API e2e tests (Supertest) for the auth → profile → plan → shopping-list happy path,
  against the CI Postgres service.
- Component tests for the web design system.
- A deterministic snapshot test pinning a generated plan for a fixed seed + database.
