# `data/recipes/`

Shipped recipe batches from the **curation queue** (see [docs/ops/curation-shipping.md](../../docs/ops/curation-shipping.md)).

- One file per shipped batch, named `<batchId>.json`.
- Each file is an array of recipe rows in the same shape as
  [`data/recipes.json`](../recipes.json) (locale-keyed `title` /
  `description` / `steps`, structural metadata, ingredient slug
  references).
- Files are sorted by filename for deterministic upsert order during
  re-seed; the seeder reads `data/recipes.json` first (hand-curated
  anchors) and then globs this directory.

**Do not edit by hand.** Files in this directory are written by the
ship pipeline (`apps/api/src/admin/drafts/ship/recipe-batches.writer.ts`)
after every row was approved in the curation queue in every language it is
written in. Editing them by hand bypasses the record of those reviews, which
lives on `RecipeDraftLocaleReview` rows.

To add a new hand-curated recipe to the canonical baseline, edit
`data/recipes.json` directly — that is the hand-curation file.
