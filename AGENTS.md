# AGENTS.md

Quick reference for AI coding agents (and humans) working in this repository.
Full onboarding: [docs/llm/onboarding.md](docs/llm/onboarding.md).

## What this repo is

Diet App — a self-hostable diet & meal-planning platform. Monorepo: `apps/web`
(Next.js), `apps/api` (NestJS + BullMQ worker), `packages/shared` (the Zod API contract).
The Android companion app is a separate repo (`whiteravens20/diet-app-android`).

## The one rule

The curated database is the **source of truth for nutrition**. Never write
calorie/macro values from code or AI — they are always computed by the deterministic
engine (`apps/api/src/engine`) from the ingredient table.

## Conventions (essentials)

- TypeScript `strict` everywhere; no unexplained `any`.
- Every request/response shape is a Zod schema in `packages/shared` — add it there first.
- Deterministic math lives only in `apps/api/src/engine`, as unit-tested pure functions.
- Files `kebab-case`; NestJS files suffixed by role; relative imports use `.js`.
- Conventional Commits, signed, **no `Co-Authored-By` trailers**.
- Branch off `dev`; PR into `dev`.

## Before you finish

```bash
npm run lint && npm run typecheck && npm test
```

For UI changes, also exercise the feature in a browser.

## Where things live

| Need | Path |
|---|---|
| API contract | `packages/shared/src` |
| Business logic | `apps/api/src/<feature>/*.service.ts` |
| Nutrition / planning math | `apps/api/src/engine` |
| AI providers & validation | `apps/api/src/ai` |
| Data model | `apps/api/prisma/schema.prisma` |
| Screens | `apps/web/src/app` |
| Design system | `apps/web/src/components` + `globals.css` |
| Decisions | `docs/adr` |
