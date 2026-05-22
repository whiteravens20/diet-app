# ADR 0003 — Prisma 7 with the pg driver adapter

**Status:** accepted · 2026-05

## Context

The project pins newest-stable dependencies. Prisma 7 is the current major. It changed
how the database connection is configured: `url` is no longer accepted in the schema's
`datasource` block, and `PrismaClient` connects through a driver adapter.

## Decision

Adopt the Prisma 7 model:

- `apps/api/prisma/schema.prisma` — `datasource` has `provider` only, no `url`.
- `apps/api/prisma.config.ts` — supplies the connection URL to Prisma Migrate, read from
  `process.env.DATABASE_URL` directly (so `prisma generate`, which needs no database,
  works when the variable is unset).
- `PrismaService` and `seed.ts` construct `PrismaClient` with
  `new PrismaPg({ connectionString: process.env.DATABASE_URL })` from `@prisma/adapter-pg`.

## Consequences

- `pg` and `@prisma/adapter-pg` are runtime dependencies of `apps/api`.
- `binaryTargets` in the schema includes `linux-musl-openssl-3.0.x` for the Alpine image.
- `effect` (a transitive dependency of `@prisma/config`) hard-requires `fast-check`;
  with `ignore-scripts` enabled it is added explicitly as a devDependency.
