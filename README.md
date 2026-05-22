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
npm run db:migrate && npm run db:seed
npm run dev
```

Web app → `http://localhost:3000`, API → `http://localhost:4000`.
See [docs/ops/deployment.md](docs/ops/deployment.md) for production and GPU/Ollama setups.

## Documentation

- [docs/architecture/](docs/architecture/) — system design, data model, API, AI orchestration
- [docs/product/](docs/product/) — spec, user stories, roadmap
- [docs/llm/onboarding.md](docs/llm/onboarding.md) — onboarding for developers & LLM agents
- [AGENTS.md](AGENTS.md) — quick reference for AI coding agents

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — © 2026 White Ravens. Free for personal and
non-commercial self-hosting; commercial use requires a separate license.
