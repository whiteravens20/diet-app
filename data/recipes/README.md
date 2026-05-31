# `data/recipes/`

Shipped recipe batches from the **curation queue** (F18, [ADR-0008](../../docs/adr/0008-curation-queue.md)).

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
after a human reviewer has approved every locale of every row. Editing
them by hand bypasses the review audit trail that lives on
`RecipeDraftLocaleReview` rows.

To add a new hand-curated recipe to the canonical baseline, edit
`data/recipes.json` directly — that is the hand-curation file.
