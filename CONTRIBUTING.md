# Contributing to Diet App

Thank you for considering a contribution. Please read this guide before opening a PR.

## Before You Start

- Open an issue for non-trivial changes so the approach can be agreed first.
- By contributing you agree your work is licensed under the project
  [LICENSE](LICENSE) (PolyForm Noncommercial 1.0.0).

## Development Setup

**Requirements:** Node 24 LTS, Docker + Docker Compose, Git with signed commits.

```bash
git clone https://github.com/whiteravens20/diet-app
cd diet-app
cp .env.example .env
npm install
# Either: run everything in Docker …
docker compose -f infra/docker-compose.dev.yml up
# … or run services on the host (Postgres + Redis still via Docker):
npm run db:migrate && npm run db:seed
npm run dev
```

## Monorepo Layout

| Path | Purpose |
|---|---|
| `apps/web` | Next.js front-end |
| `apps/api` | NestJS API + BullMQ worker |
| `packages/shared` | Zod schemas + types — the API contract |
| `packages/config` | Shared ESLint / Prettier / tsconfig |
| `prisma/` (in `apps/api`) | Schema, migrations, seed |
| `infra/` | Docker & Traefik |
| `docs/` | Architecture, product, ADRs, LLM onboarding |

## Coding Guidelines

- **TypeScript everywhere**, `strict` mode. No `any` without a written reason.
- **Determinism rule:** all calorie/macro/quantity math lives in `apps/api/src/engine`
  as pure, unit-tested functions. AI code must never produce nutrition numbers.
- Lint + format before pushing: `npm run lint && npm run format`.
- Validate every external input with a Zod schema from `packages/shared`.

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
`chore:`, `docs:`, `refactor:`, `test:`, `ci:`. Commits must be **signed**.
Do **not** add `Co-Authored-By` trailers.

### Branches

`main` is protected and releasable. Branch off `dev` as `feature/*`, `fix/*` or
`chore/*`; PR back into `dev`. Releases promote `dev → main`.

## Testing

- Unit-test every engine function and any non-trivial service.
- `npm test` must pass. The `api`, `web` and `docker` CI checks must be green before
  a PR can merge.

## Security

Never commit secrets. Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
