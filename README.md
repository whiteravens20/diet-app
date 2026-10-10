# Diet App

> Self-hostable diet & meal-planning platform with deterministic nutrition and BYOK AI.

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![CI](https://github.com/whiteravens20/diet-app/actions/workflows/test.yml/badge.svg)](https://github.com/whiteravens20/diet-app/actions)
[![CodeQL](https://github.com/whiteravens20/diet-app/actions/workflows/codeql.yml/badge.svg)](https://github.com/whiteravens20/diet-app/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/whiteravens20/diet-app/badge)](https://scorecard.dev/viewer/?uri=github.com/whiteravens20/diet-app)

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
- **Shopping lists and a pantry** — merged and category-grouped, counted the way one
  shops (eggs and slices of bread in pieces, weights rounded up to 5 g), with what the
  pantry already holds taken off, what was bought beyond the need put into it, and PDF
  export.
- **Meal & ingredient swapping** — random/favorite meal swaps and ingredient substitutions
  that preserve calories and report the macro delta.
- **BYOK AI** — per-user OpenAI / Anthropic / OpenRouter / Ollama keys with failover, and a
  full deterministic fallback so the app works with **no AI key at all**.
- **Self-hosted, Docker-first** — `docker compose up` boots the whole stack.

## Architecture

Diet App is one image started in several roles, plus PostgreSQL. The web front-end is a Next.js server and the only thing a browser talks to: it renders the pages and passes every `/api` request on to the API over the internal network, so there is a single origin and no CORS to configure. The API is a NestJS service that validates each request against schemas it shares with the web, checks who owns what, and runs the planning logic. A worker runs the scheduled tasks from the same code, and a one-shot job applies database migrations before either of them starts.

Every calorie and macro comes from one place. The curated ingredient database is the source of truth, and a deterministic engine inside the API computes nutrition, meal plans, shopping lists and substitutions from it as pure functions, so the same inputs always give the same numbers. AI is optional and never writes nutrition. When a user brings their own provider key, the model is asked only for the structure of a recipe, built from the ingredients it was given; a validation layer then rejects anything it does not know and recomputes every number from the database. With no key at all, the app runs on the engine alone.

PostgreSQL holds the accounts, profiles, plans and the curated data. E-mail addresses and AI provider keys are stored encrypted and passwords hashed. A provider key is used inside the API to call the provider its owner chose, and is never sent back to the browser.

## Install

```bash
git clone https://github.com/whiteravens20/diet-app
cd diet-app
sh scripts/init-env.sh        # writes .env with freshly generated secrets
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
The official image is published to GHCR and consumed by a self-contained
compose file at [`infra/docker-compose.prod.yml`](infra/docker-compose.prod.yml):

- `ghcr.io/whiteravens20/diet-app:latest` — one image for the HTTP API, the
  scheduled-tasks worker, the migration job and the Next.js frontend; each
  service starts it with its own command

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
`IMAGE_TAG=<release-tag>` in `.env` to pin the whole application to a
known-good version and bump manually after testing.

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

- [docs/ops/deployment.md](docs/ops/deployment.md) — Docker, self-hosting, Ollama
- [docs/ops/env-reference.md](docs/ops/env-reference.md) — every environment variable
- [docs/ops/ai-models.md](docs/ops/ai-models.md) — model recommendations by surface and hardware tier
- [docs/ops/curation-shipping.md](docs/ops/curation-shipping.md) — curation queue ship modes, backup, migration

The product specification and the architecture and design documents are not
published while the project is in development; they join the repository with
v1.0.0.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy.

## How the code is written and checked

Diet App is built by one maintainer using AI coding tools. The tools write most of the
code, tests and documentation; the maintainer decides what gets built and is responsible
for everything that lands here. The project is in early development: there is no release
yet, no independent security review and no second human reviewer.

**What a change goes through**

- Every push and pull request runs lint with no warnings allowed, type checking, the
  unit tests and a build for the API and for the web app, checks that the database
  migrations match the schema, and builds the Docker image
  ([test.yml](.github/workflows/test.yml)).
- CodeQL, `npm audit`, package signature checks and Trivy scans of the repository and of
  the image run on every push and pull request, and again every week
  ([codeql.yml](.github/workflows/codeql.yml),
  [security.yml](.github/workflows/security.yml)).
- Commits are signed, and the [OpenSSF
  Scorecard](https://scorecard.dev/viewer/?uri=github.com/whiteravens20/diet-app)
  results are public.

**What the maintainer decided and read**

- Nutrition never comes from a language model. The maintainer specified that every
  calorie and macro is computed by the engine in `apps/api/src/engine` from the curated
  database. A model may only draft the structure of a recipe, and a validation layer
  then recomputes every number.
- Each engine module has its own unit tests.
- `apps/api/src/common/crypto.ts` and `apps/api/src/auth/auth.service.ts` (e-mail
  encryption, password peppering, blind-index lookups) are read line by line by the
  maintainer whenever they change.

**Before a release**

- There is no release yet. Before the first one, the whole application is audited and
  tested on running instances, not only in unit tests.
- The latest audit found problems that have to be fixed first, which is why the project
  is still marked as not production ready.
- A release will be cut from `main`, which requires CodeQL, `npm audit` and both Trivy
  scans on top of the tests.

If something looks wrong, open an issue. For a vulnerability, follow
[SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0-only), with one
additional term in [NOTICE](NOTICE) — © 2026 White Ravens.

You are free to self-host, change and share Diet App. If you run a changed version for
other people, the licence requires you to offer them its source code, and every copy has
to keep the attribution "Diet App by White Ravens" together with the address of this
repository.
