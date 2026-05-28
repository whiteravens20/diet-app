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

## Production deploy (pre-built images)

For deploying to a server you do **not** need the repo or a build toolchain.
Official multi-arch images are published to GHCR and consumed by a
self-contained compose file at
[`infra/docker-compose.prod.yml`](infra/docker-compose.prod.yml):

- `ghcr.io/whiteravens20/diet-app/api:latest` — HTTP API + BullMQ worker
- `ghcr.io/whiteravens20/diet-app/web:latest` — Next.js frontend

On the target server:

```bash
mkdir diet-app && cd diet-app

# 1. Grab the compose file and an env template.
curl -O https://raw.githubusercontent.com/whiteravens20/diet-app/main/infra/docker-compose.prod.yml
curl -o .env https://raw.githubusercontent.com/whiteravens20/diet-app/main/.env.example

# 2. Fill in secrets (POSTGRES_PASSWORD, JWT_*, *_ENCRYPTION_SECRET,
#    ADMIN_PASSWORD, APP_URL/API_URL pointing at your public origin).
#    Generate each secret with: openssl rand -hex 32
nano .env

# 3. Pull and start.
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Web app → `http://<host>:3000`, API → `http://<host>:4000`. Front them with
your own reverse proxy (Traefik / Caddy / nginx) and terminate TLS there.

**Updating** — re-pull and restart; migrations apply automatically on boot:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

**Pinning a version** — `latest` follows the production release channel; set
`IMAGE_TAG=<release-tag>` in `.env` to pin both images to a known-good
version and bump manually after testing.

**Local self-hosted AI** — start with `--profile ollama` to add an Ollama
service on the same host; set `AI_DEFAULT_PROVIDER=ollama` and
`OLLAMA_BASE_URL=http://ollama:11434` in `.env`. Pull a model after boot:
`docker compose exec ollama ollama pull llama3.1:8b`.

After first boot, follow [First-run](#first-run-populate-the-curated-database)
below to populate the curated ingredient database from the admin panel.

## First-run: populate the curated database

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
