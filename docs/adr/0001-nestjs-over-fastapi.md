# ADR 0001 — NestJS over FastAPI

**Status:** accepted · 2026-05

## Context

The brief lists "NestJS or FastAPI" for the backend and "TypeScript preferred for
full-stack consistency". The front-end is Next.js/TypeScript.

## Decision

Use **NestJS** (TypeScript).

## Rationale

- One language across `apps/web`, `apps/api` and `packages/shared`. The API contract
  (`packages/shared`) is shared as real types, not regenerated bindings.
- The deterministic engine can be unit-tested in the same toolchain (Vitest) and, where
  useful, reused on the front-end.
- Matches the White Ravens "prefer Node tooling" convention.

## Consequences

- The deterministic numeric engine is plain TypeScript — adequate here; no scientific
  Python libraries are needed.
- `packages/shared` ships as a CommonJS build so both the CJS API and the bundled web app
  consume it without dual-package friction.
