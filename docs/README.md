# Diet App — Documentation

What an operator needs to run Diet App. Start with deployment.

| Document | What it covers |
|---|---|
| [ops/deployment.md](ops/deployment.md) | Docker, self-hosting, Ollama |
| [ops/env-reference.md](ops/env-reference.md) | Every environment variable |
| [ops/ai-models.md](ops/ai-models.md) | Model recommendations by surface and hardware tier |
| [ops/curation-shipping.md](ops/curation-shipping.md) | The three ways approved drafts ship, backing up what an instance added, moving to a new server |
| [api/](api/README.md) | The contract of the API: an OpenAPI description, the list of routes, the codes a request is refused with |

The product specification and the architecture and design documents are not
published while the project is in development; they join the repository with
v1.0.0.

The Android companion app is a **separate repository**:
[`whiteravens20/diet-app-android`](https://github.com/whiteravens20/diet-app-android).
Its docs live there; the contract of the API it asks is in [`api/`](api/README.md).

## The one rule to remember

The curated product database is the **source of truth for nutrition**. AI may draft
recipe *structure* and suggestions, but every calorie and macro is recomputed
deterministically from the database.
