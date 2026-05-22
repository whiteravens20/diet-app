# ADR 0002 — Two repositories

**Status:** accepted · 2026-05

## Context

The brief mandates two repositories: a web platform (front-end + backend + infra) and an
Android companion app. The Android app is Phase 3 and must not be a dependency of the web
app.

## Decision

- **`whiteravens20/diet-app`** — web platform. A monorepo (npm workspaces + Turborepo)
  containing `apps/web`, `apps/api`, `packages/shared`, `infra/` and `docs/`.
- **`whiteravens20/diet-app-android`** — the Android companion app, separate repo.

## Rationale

- The brief's "Repository 1" explicitly bundles front-end + backend + infra — a monorepo
  satisfies it while keeping the shared API contract in one place.
- A separate Android repo keeps mobile work independent and out of the web release cycle.
- The API contract (`packages/shared`) is the integration seam; the Android repo mirrors
  it under `docs/contracts/`.

## Consequences

- A contract change is a coordinated change across two repos — bump deliberately.
- Each repo carries the full White Ravens baseline (license, CI, `.github`).
