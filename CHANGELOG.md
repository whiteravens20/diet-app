# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial monorepo scaffold: Next.js web app, NestJS API, shared contracts package.
- Prisma data model covering profiles, the curated product database, recipes, meal
  plans, shopping lists, substitution rules and AI provider configuration.
- Deterministic engine: calorie/macro calculation, meal-plan optimiser, shopping-list
  aggregator, ingredient substitution.
- AI provider abstraction (OpenAI, Anthropic, OpenRouter, Ollama) with failover and a
  no-key deterministic fallback.
- Docker-first infrastructure: compose files, per-service Dockerfiles, Traefik, optional
  GPU-enabled Ollama.
- Full design documentation set and LLM onboarding guide.

[Unreleased]: https://github.com/whiteravens20/diet-app/compare/HEAD
