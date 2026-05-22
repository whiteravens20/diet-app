# Onboarding — for Developers & LLM Agents

Read this first if you are a person or an AI agent about to work on this repo.

## What this is

Diet App — a self-hostable diet & meal-planning platform. Web app + backend in this repo;
the Android companion is in `whiteravens20/diet-app-android`. Full design set in
[`docs/`](../README.md).

## The non-negotiable rule

The curated database is the source of truth for nutrition. **Never** let code (AI-driven
or not) write calorie/macro values directly — they are always computed by the engine from
the ingredient table. If you add a feature that produces nutrition numbers, route it
through `apps/api/src/engine`. See [ADR 0005](../adr/0005-curated-db-source-of-truth.md).

## Repository map

```
apps/web         Next.js front-end
apps/api         NestJS API + BullMQ worker
  src/engine     Deterministic pure functions — calorie, optimiser, shopping, substitution
  src/ai         AI provider abstraction, router, validation, encrypted key store
  src/<feature>  One module per feature: controller + service (+ module)
  prisma         schema.prisma, seed.ts, prisma.config.ts
packages/shared  Zod schemas + types — the API contract
data             Curated ingredient / recipe / substitution seed data
infra            Dockerfiles, compose, Traefik
docs             This documentation set
```

## Conventions

- **Language** — TypeScript everywhere, `strict`. No `any` without a written reason.
- **Naming** — files `kebab-case`; classes/types `PascalCase`; variables/functions
  `camelCase`; NestJS files suffixed by role (`*.controller.ts`, `*.service.ts`,
  `*.module.ts`).
- **API contract** — every request/response is a Zod schema in `packages/shared`. Add the
  schema there first, then use it on both sides. Validate inbound payloads with
  `ZodValidationPipe`.
- **Determinism** — calorie/macro/quantity math lives only in `apps/api/src/engine` as
  pure functions; unit-test it. Randomness must be seeded.
- **Errors** — throw NestJS `HttpException`s with a stable `error` code; the global
  filter renders the `ApiError` envelope.
- **Imports** — the API and `packages/shared` are CommonJS with explicit `.js` extensions
  on relative imports (`node16` resolution). Keep that.
- **Commits** — [Conventional Commits](https://www.conventionalcommits.org/), signed. No
  `Co-Authored-By` trailers.
- **Branches** — branch off `dev`; PR into `dev`; `dev → main` for releases.

## Coding standards

- Reuse the engine — do not re-implement nutrition or unit math.
- Keep controllers thin: validate → delegate to a service → return. Business logic and
  ownership checks live in services.
- New persistent data → a Prisma model + migration; never an ad-hoc table.
- Run `npm run lint && npm run typecheck && npm test` before pushing.
- For UI work, exercise the feature in a browser — a green typecheck is not proof.

## Where to start a task

| Task | Start here |
|---|---|
| New API feature | `packages/shared` (schema) → `apps/api/src/<feature>` |
| Change planning logic | `apps/api/src/engine/optimizer.ts` (+ its test) |
| Change nutrition math | `apps/api/src/engine/nutrition.ts` / `units.ts` (+ tests) |
| Add an AI provider | `apps/api/src/ai/providers/` — implement `AiProviderAdapter` |
| New screen | `apps/web/src/app/(app)/…` + components in `apps/web/src/components` |
| Schema change | `apps/api/prisma/schema.prisma` → `prisma migrate dev` |

## Prompt engineering

AI prompts use constrained generation: supply the allowed ingredient list + targets +
constraints, request **structure only** as JSON, and rely on `AiValidationService` to
recompute nutrition and reject unknown ingredients. See
[architecture/ai-orchestration.md](../architecture/ai-orchestration.md). Keep prompt
templates in code, versioned with the logic that builds them.

## Verifying your change

See [ops/testing.md](../ops/testing.md). Minimum: lint + typecheck + tests green, and for
behaviour changes, the relevant engine test updated. For end-to-end: bring up
`infra/docker-compose.dev.yml`, migrate + seed, and exercise the flow.
