# Contributing to Diet App

Thank you for considering a contribution to Diet App. This project stores **personal health-adjacent data** and its users' AI provider keys, and every calorie and macro it shows has to be reproducible. Please read this guide fully before opening a pull request.

---

## Table of Contents

- [Contributing to Diet App](#contributing-to-diet-app)
  - [Table of Contents](#table-of-contents)
  - [Before You Start](#before-you-start)
  - [Scope of Contributions](#scope-of-contributions)
  - [Development Setup](#development-setup)
    - [Requirements](#requirements)
    - [Local start](#local-start)
    - [Environment variables](#environment-variables)
  - [Project Structure](#project-structure)
  - [Coding Guidelines](#coding-guidelines)
    - [General](#general)
    - [Linting](#linting)
    - [TypeScript](#typescript)
    - [Naming conventions](#naming-conventions)
    - [Dependencies](#dependencies)
    - [Commits](#commits)
  - [Testing Requirements](#testing-requirements)
    - [Run the full suite](#run-the-full-suite)
    - [Coverage](#coverage)
    - [What to test](#what-to-test)
    - [Test style](#test-style)
  - [Secure Contributing](#secure-contributing)
    - [Nutrition integrity](#nutrition-integrity)
    - [Cryptography](#cryptography)
    - [Input handling and data isolation](#input-handling-and-data-isolation)
    - [Dependencies](#dependencies-1)
    - [Secrets and credentials](#secrets-and-credentials)
    - [AI-assisted code](#ai-assisted-code)
    - [Pull request security checklist](#pull-request-security-checklist)
  - [Submitting Changes](#submitting-changes)
    - [PR description must include](#pr-description-must-include)
  - [Reporting Security Vulnerabilities](#reporting-security-vulnerabilities)

---

## Before You Start

- Check the [open issues](https://github.com/whiteravens20/diet-app/issues) and [pull requests](https://github.com/whiteravens20/diet-app/pulls) to avoid duplicating work.
- For large changes or new features, open an issue first to discuss the approach before investing time in code.
- By contributing, you agree to the project [License](LICENSE), with the attribution term in [NOTICE](NOTICE), and to the [Code of Conduct](CODE_OF_CONDUCT.md).

> Diet App is in early development: the API, the data model and the deployment story still change. Coordinate on the issue tracker before starting major refactors.

---

## Scope of Contributions

Contributions that are **welcome**:

- Bug fixes (with a regression test)
- Security improvements or hardening
- Test coverage gaps
- Documentation corrections
- Translations: fixes to the Polish text, or a new locale with every string and every curated data key translated by hand
- Corrections to the curated data in `data/` (ingredients, recipes, substitutions)
- Accessibility improvements in the web app

Contributions we will **not accept**:

- Nutrition values produced by AI, or computed anywhere but the deterministic engine
- Analytics, tracking, or telemetry of any kind
- Features that send user data or provider keys anywhere but the AI provider the user configured
- Weakening of rate limiting, input validation or ownership checks
- Changes to instance data, generated data, local env files, build output or the protected workflows — a pull request that touches them is closed automatically
- AI-generated code submitted without manual review and a test (see [Secure Contributing](#secure-contributing))

---

## Development Setup

### Requirements

| Tool | Version |
|---|---|
| Node.js | ≥ 24.0.0 |
| npm | bundled with Node.js |
| Docker & Docker Compose | for PostgreSQL, and for building the image |

### Local start

```bash
cp .env.example .env            # then fill in the secrets
npm install
npm run db:generate             # Prisma client; install scripts are off, so it is not generated for you

docker compose -f infra/docker-compose.dev.yml up -d   # PostgreSQL
npm run db:migrate
npm run db:seed

npm run dev                     # web on http://localhost:3000, API on http://localhost:4000
```

### Environment variables

Every variable is listed in [`docs/ops/env-reference.md`](docs/ops/env-reference.md) and validated at start-up by [`apps/api/src/config/env.ts`](apps/api/src/config/env.ts); the API refuses to boot on an invalid value.

Security-sensitive variables (never commit these):

```
POSTGRES_PASSWORD=
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
AI_KEY_ENCRYPTION_SECRET=
DATA_ENCRYPTION_SECRET=
ADMIN_PASSWORD=
TURNSTILE_SECRET_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
```

---

## Project Structure

```
apps/api/src/
  main.ts            # API entrypoint (worker.ts runs the scheduled tasks)
  config/            # env-var parsing and validation
  common/            # crypto, security headers, exception filter
  engine/            # deterministic nutrition, optimiser, shopping, substitution
  ai/                # provider abstraction, router, validation, key store
  auth/              # registration, login, tokens, Turnstile
  <feature>/         # one module per feature: controller + service

apps/api/prisma/     # schema.prisma, migrations, seed.ts

apps/web/src/
  app/               # routes (Next.js App Router)
  components/        # UI components and the design system
  lib/               # API client, security headers, helpers

apps/web/messages/   # en.json, pl.json: every user-facing string
packages/shared/src/ # Zod schemas and types: the API contract
data/                # curated ingredients, recipes, substitutions
infra/               # Dockerfile and Compose files
```

---

## Coding Guidelines

### General

- **TypeScript** is mandatory everywhere — no `any` types and no type assertions without a comment explaining why.
- Keep functions small and single-purpose. Controllers stay thin: validate, delegate to a service, return.
- **The API contract is `packages/shared`.** Add or change the Zod schema there first, then use it on both sides.
- **All user-facing text is translated.** No English literals in `.ts` or `.tsx` for buttons, labels, toasts, exception messages or rendered enum labels. A new string lands in both `apps/web/messages/en.json` and `apps/web/messages/pl.json`; a new thrown exception gets a stable `error` code and a row in `messages.errors`.
- New persistent data means a Prisma model and a migration.
- No dead code or commented-out blocks in submitted PRs.
- Match the existing code style; ESLint is the source of truth.

### Linting

Every workspace enforces zero warnings:

```bash
npm run lint
npm run data:lint     # validates the curated data in data/
```

Fix all lint errors before opening a PR. The CI gate is `eslint --max-warnings 0`.

### TypeScript

```bash
npm run typecheck
```

No type errors are accepted.

### Naming conventions

| Context | Convention |
|---|---|
| Files | `kebab-case.ts`; NestJS files carry their role (`*.controller.ts`, `*.service.ts`, `*.module.ts`) |
| Variables / functions | `camelCase` |
| Classes / types / interfaces | `PascalCase` |
| Constants | `UPPER_SNAKE_CASE` |
| Environment variables | `UPPER_SNAKE_CASE` |

### Dependencies

- **Justify every new dependency** in the PR description.
- Prefer Node.js built-ins and already-present packages.
- Zero-dependency or small, auditable packages are strongly preferred.
- Do not add packages that phone home or include opt-out telemetry.
- Run `npm audit` before submitting — flag any findings in the PR.
- The repository's `.npmrc` turns install scripts off and refuses versions published less than seven days ago. Do not work around either.

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) style:

```
feat(meal-plans): let a plan skip a day
fix(api): scope favourite sets to recipes the user may see
docs: correct the Ollama address in the deployment guide
test(engine): cover unit conversion for volume-only ingredients
security: validate the Ollama base URL before dialling it
```

Keep commits focused — one logical change per commit. Avoid mixing refactors with feature changes in the same commit.

---

## Testing Requirements

**Every change must be covered by tests.** This is not optional.

### Run the full suite

```bash
npm test
```

It must pass **with zero failures** before submitting.

### Coverage

```bash
npm run test:cov
```

The API's coverage floors live in `apps/api/vitest.config.ts` and only move up. New code should not decrease coverage. PRs that add testable logic without corresponding tests will be asked to add them.

### What to test

- **Bug fixes** — add a regression test that fails on the original code and passes on the fix.
- **Engine functions** — unit-test every one, with seeded inputs: the same inputs must always give the same numbers.
- **Services** — test the success path, validation failure, and the ownership check that keeps one user out of another's data.
- **New error codes** — the catalogue test fails until the code has its translated message.
- **Web components** — test rendering, user interaction, and edge cases.
- **Security-critical paths** — test with boundary values, malformed input, and adversarial cases.

### Test style

- Use `describe` / `it` blocks with descriptive names.
- Prefer real logic over excessive mocking — mocks hide bugs.
- If you must mock, document why.
- Do not re-implement nutrition math in a test; assert against the engine.

---

## Secure Contributing

Diet App is a security-sensitive project. The following rules apply strictly.

### Nutrition integrity

- The curated database is the source of truth for nutrition. Calorie, macro and quantity math lives only in `apps/api/src/engine`, as pure functions.
- AI may draft the structure of a recipe only. Its output goes through the validation layer, which recomputes every number and rejects unknown ingredients. **Do not add a path around it.**
- Randomness in the engine is seeded. A change that makes the same inputs give different numbers is a bug.

### Cryptography

- **Do not change or replace cryptographic primitives** without opening a dedicated security issue first.
- E-mail addresses and AI provider keys are encrypted at rest with AES-256-GCM, looked up through an HMAC blind index, and passwords are peppered before bcrypt. These guarantees must be preserved.
- A provider key is write-only for the client: never return it and never log it.

### Input handling and data isolation

- All user-supplied input must be validated with a Zod schema from `packages/shared`.
- Scope every query to the authenticated user, in the service. An id in the request is never proof of ownership.
- A URL the server is going to fetch on a user's or an admin's word goes through the existing URL guard; do not add an unchecked `fetch`.
- No SQL built by string concatenation; use the Prisma client.

### Dependencies

- Audit new dependencies before adding them: check for known CVEs, evaluate the maintainer track record, and review the source.
- Verify the lockfile is committed with the change.
- Remove the dependency if it is no longer needed — do not leave unused packages in the tree.

### Secrets and credentials

- **Never commit secrets**, credentials, tokens, or private keys — not in code, not in comments, not in test fixtures.
- Use environment variables for all secrets. The `.env` file is in `.gitignore`.
- If you accidentally commit a secret, treat it as compromised immediately and rotate it. Then open a private security report.

### AI-assisted code

This project was partially built with AI assistance. The same standard applies to all contributions:

- AI-generated code **must be reviewed line by line** before submission.
- Security-critical files (`common/crypto.ts`, `auth/auth.service.ts`, `admin/basic-auth.guard.ts`, `ai/ollama-url.ts`, the engine) must be reviewed with extra care.
- Do not submit AI output that you cannot explain and defend in a PR review.
- AI slop (plausible-looking but logically broken code) is a known risk — tests are the primary guard against it.

### Pull request security checklist

Before opening a PR that touches security-relevant code, confirm the following in your PR description:

```
- [ ] No nutrition value is produced outside the deterministic engine
- [ ] Every new query is scoped to the authenticated user
- [ ] No provider key, password or token is logged or returned to the client
- [ ] No new unvalidated environment variable is introduced
- [ ] `npm audit` shows no new high/critical findings
- [ ] All tests pass
- [ ] ESLint passes with zero warnings
- [ ] TypeScript compiles with zero errors
```

---

## Submitting Changes

1. **Fork** the repository and create a branch from `dev` (not `main`).
2. Branch naming: `fix/short-description`, `feat/short-description`, `docs/short-description`, `security/short-description`.
3. Make your changes, following this guide.
4. Run the full test and lint suite.
5. Open a pull request against the `dev` branch.
6. Fill out the PR template completely — incomplete PRs will be asked to add missing information.
7. Respond to review comments. PRs that are not addressed within 30 days may be closed.

### PR description must include

- **What** changed and **why**.
- A reference to the related issue (`Closes #123` or `Relates to #123`).
- For security-related changes: the security checklist above.
- For dependency additions: justification and `npm audit` output.

---

## Reporting Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.**

Follow the process in [SECURITY.md](SECURITY.md).
