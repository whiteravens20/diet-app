# Architecture Decision Records

Each ADR records one significant decision: context, the choice, and consequences.
Newest changes append a new file; superseded ADRs are marked, not deleted.

| ADR | Decision |
|---|---|
| [0001](0001-nestjs-over-fastapi.md) | NestJS (TypeScript) for the backend, not FastAPI |
| [0002](0002-two-repositories.md) | Two repositories — web platform and Android companion |
| [0003](0003-prisma7-driver-adapter.md) | Prisma 7 with the `pg` driver adapter + `prisma.config.ts` |
| [0004](0004-eslint-major-fallback.md) | ESLint pinned to 9.x (not 10.x) for ecosystem compatibility |
| [0005](0005-curated-db-source-of-truth.md) | Curated database is the source of truth; AI never writes nutrition |
| [0006](0006-fallback-recipe-strategy.md) | USDA importer + template composition for the no-AI fallback |
