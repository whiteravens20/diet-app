# Diet App — Documentation

The full design and reference set for the Diet App ecosystem. Start here.

## Map

| Area | Document |
|---|---|
| **Product** | [product/product-spec.md](product/product-spec.md) — spec, user stories, requirements, roadmap, risks |
| | [product/original-brief.md](product/original-brief.md) — the original product brief |
| **Architecture** | [architecture/overview.md](architecture/overview.md) — system design, information architecture, diagrams |
| | [architecture/data-model.md](architecture/data-model.md) — entities and the curated database |
| | [architecture/api.md](architecture/api.md) — REST API design and contracts |
| | [architecture/ai-orchestration.md](architecture/ai-orchestration.md) — provider abstraction, fallback, Ollama, prompts |
| | [architecture/algorithms.md](architecture/algorithms.md) — calorie engine, optimiser, shopping, substitution |
| **Decisions** | [adr/](adr/) — architecture decision records |
| **Design** | [design/design-system.md](design/design-system.md) — UI system, motion, example screens |
| **Operations** | [ops/deployment.md](ops/deployment.md) — Docker, self-hosting, Ollama |
| | [ops/env-reference.md](ops/env-reference.md) — every environment variable |
| | [ops/curation-shipping.md](ops/curation-shipping.md) — local vs. PR vs. zip ship modes, backup, migration |
| | [ops/testing.md](ops/testing.md) — testing strategy |
| | [ops/versions.md](ops/versions.md) — resolved dependency version matrix |
| **For LLM agents** | [llm/onboarding.md](llm/onboarding.md) — onboarding, conventions, coding standards |

The Android companion app is a **separate repository**:
[`whiteravens20/diet-app-android`](https://github.com/whiteravens20/diet-app-android).
Its docs live there; the API contract it consumes is [`packages/shared`](../packages/shared).

## The one rule to remember

The curated product database is the **source of truth for nutrition**. AI may draft
recipe *structure* and suggestions, but every calorie and macro is recomputed
deterministically from the database. See [architecture/ai-orchestration.md](architecture/ai-orchestration.md).
