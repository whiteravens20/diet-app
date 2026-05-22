# Version Matrix

Resolved at scaffold time (2026-05) under the **newest-stable** policy: every component
is on its latest stable release, with Node on the newest LTS. Exact versions are pinned
in `package-lock.json`; the ranges below are the manifest pins.

## Runtime

| Component | Version |
|---|---|
| Node.js | 24 LTS |
| PostgreSQL | 18 |
| Redis | 8 |
| Docker base image | `node:24-alpine` |

## Toolchain

| Package | Pin |
|---|---|
| TypeScript | ^6.0.3 |
| Turborepo | ^2.9.14 |
| ESLint | **^9.39.4** — see [ADR 0004](../adr/0004-eslint-major-fallback.md) |
| Prettier | ^3.4.2 |

## Backend (`apps/api`)

| Package | Pin |
|---|---|
| NestJS | ^11.1.23 |
| Prisma / `@prisma/client` | ^7.8.0 — driver adapter, see [ADR 0003](../adr/0003-prisma7-driver-adapter.md) |
| BullMQ | ^5.77.0 |
| Zod | ^4.4.3 |
| Vitest | ^4.1.7 |
| `openai` / `@anthropic-ai/sdk` / `ollama` | ^6.39 / ^0.98 / ^0.6.3 |

## Frontend (`apps/web`)

| Package | Pin |
|---|---|
| Next.js | ^16.2.6 (App Router) |
| React | ^19.2.6 |
| Tailwind CSS | ^4.3.0 |
| Framer Motion | ^12.40.0 |
| TanStack Query | ^5.100.11 |
| Recharts | ^3.8.1 |

## Deviations from "absolute newest"

- **ESLint 9, not 10** — `eslint-config-next@16`'s plugin chain is not yet ESLint-10
  compatible. [ADR 0004](../adr/0004-eslint-major-fallback.md).
- **`min-release-age` not set** in `.npmrc` — it broke resolution of the newest releases
  with the current npm. Supply-chain hardening still relies on `ignore-scripts`,
  `npm audit signatures` and Trivy/CodeQL.

Regenerate this matrix when bumping majors; record any new deviation as an ADR.
