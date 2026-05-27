# Diet App

> Self-hostable diet & meal-planning platform with deterministic nutrition and BYOK AI.

[![License](https://img.shields.io/badge/license-PolyForm--NC--1.0.0-blue)](LICENSE)
[![CI](https://github.com/whiteravens20/diet-app/actions/workflows/test.yml/badge.svg)](https://github.com/whiteravens20/diet-app/actions)
[![CodeQL](https://github.com/whiteravens20/diet-app/actions/workflows/codeql.yml/badge.svg)](https://github.com/whiteravens20/diet-app/actions/workflows/codeql.yml)

Diet App generates calorie-targeted meal plans, optimises ingredient reuse across a
planning window, and produces consolidated shopping lists — all from a **curated product
database** so every calorie and macro is deterministic and reproducible. AI is an optional
assistant for recipe drafting and substitution ideas; it never invents nutrition facts.

The companion Android app lives in a separate repository:
[`whiteravens20/diet-app-android`](https://github.com/whiteravens20/diet-app-android).

> [!WARNING]
> **Early development — not production ready.** Diet App is under active
> development. The API, data model and deployment story may change without
> notice, and the project has not had a security review. Self-host it to
> experiment, not for anything you depend on yet.

## Features

- **Profiles & calorie engine** — Mifflin-St Jeor BMR, activity multipliers, weekly
  weight-loss targets (0.25–1.0 kg/wk) converted to a daily deficit, manual override.
- **Meal planning** — multi-day plans honouring calorie/macro targets and diet type, with
  an optimiser that maximises ingredient reuse and minimises waste.
- **Recipes from a curated DB** — deterministic nutrition; AI may draft recipes only from
  approved ingredients, then a validation layer recomputes every number.
- **Shopping lists** — merged, unit-normalised, category-grouped, with "already at home"
  deductions and export.
- **Meal & ingredient swapping** — random/favorite meal swaps and ingredient substitutions
  that preserve calories and report the macro delta.
- **BYOK AI** — per-user OpenAI / Anthropic / OpenRouter / Ollama keys with failover, and a
  full deterministic fallback so the app works with **no AI key at all**.
- **Self-hosted, Docker-first** — `docker compose up` boots the whole stack.

## Install

```bash
git clone https://github.com/whiteravens20/diet-app
cd diet-app
cp .env.example .env          # then edit secrets
```

## Run

Docker (recommended):

```bash
docker compose -f infra/docker-compose.dev.yml up --build
```

Local (Node 24 LTS):

```bash
npm install
npm run db:migrate
npm run dev
```

Web app → `http://localhost:3000`, API → `http://localhost:4000`.

### First-run: populate the curated database

The stack boots empty by design — only `prisma migrate deploy` runs at startup
(seeding ~7 k ingredients × ~30 k composed recipes would block boot for
minutes). Loading the curated database is a one-click admin action:

1. Set `ADMIN_PASSWORD` in `.env` (and optionally `ADMIN_USER`, defaults to `admin`).
2. (Optional) Run the USDA importer to add public-domain whole foods:
   ```bash
   FDC_API_KEY=<key> npm run import:usda
   ```
   Defaults to USDA **Foundation** (~340 clean generic foods). Without an importer
   run, only the hand-curated baseline (~55 ingredients) seeds. See
   [data/README.md](data/README.md#choosing-fdc_data_types) before enabling
   `SR Legacy` — it adds ~7 k entries but most are brand SKUs or hyper-specific
   cuts that inflate template-generated recipes with nonsense.
3. Open <http://localhost:3000/admin>, sign in, click **Update Database**.

The admin panel surfaces ingredient/recipe/substitution counts and a
data-hash check so subsequent edits or re-imports show "update available"
without any guessing. User accounts and plans are preserved across updates.

The CLI alternative is `npm run db:seed`. See
[docs/ops/deployment.md](docs/ops/deployment.md) for production and GPU/Ollama setups.

## Documentation

- [docs/architecture/](docs/architecture/) — system design, data model, API, AI orchestration
- [docs/product/](docs/product/) — spec, user stories, roadmap
- [docs/llm/onboarding.md](docs/llm/onboarding.md) — onboarding for developers & LLM agents
- [AGENTS.md](AGENTS.md) — quick reference for AI coding agents

## Development with AI Assistance

> [!NOTE]
> **This project was developed with AI assistance.**
>
> AI-generated code can contain subtle bugs, insecure patterns, or
> plausible-looking nonsense ("AI slop"). Here is what keeps the bar high — and
> what to check when auditing:
>
> - **The deterministic core is human-specified.** Nutrition is computed by the
>   engine (`apps/api/src/engine`) from a curated database — AI never invents
>   calorie or macro values. That rule was a design decision, not an AI default.
> - **Tests are mandatory.** `npm run lint && npm run typecheck && npm test`
>   must pass before any commit lands; every engine function is unit-tested.
> - **ESLint enforces standards.** All workspaces lint with zero warnings.
> - **Security-critical code is read line by line.** `common/crypto.ts` and
>   `auth/auth.service.ts` (email encryption, password peppering, blind-index
>   lookups) were reviewed manually after generation.
>
> If you find a slop pattern, a logical bug, or a security issue, please open an
> issue or see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — © 2026 White Ravens. Free for personal and
non-commercial self-hosting; commercial use requires a separate license.
