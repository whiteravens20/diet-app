# ADR 0008 — Recipe + ingredient curation via AI drafts + in-app human review + PR ship

**Status:** accepted · 2026-05

## Context

The curated recipe library and the USDA-imported ingredient catalogue both
have quality problems that surface to end users:

- The deterministic template composer at `apps/api/src/engine/recipe-templates.ts`
  produces semantically nonsense recipes ("cucumber baked with coconut oil",
  "fish with 25 g of olive oil") because its slot-filling algorithm has no
  cuisine, cooking-method, or flavour-pair constraints. It contributes ~100
  recipes on top of 18 hand-curated anchors.
- USDA Foundation Foods (~340 imported items) ship with raw FDC descriptions
  ("Beef, loin, tenderloin roast, separable lean only, boneless, trimmed to 0\"
  fat, select, cooked, roasted", "Pears, raw, bartlett"). Every recipe that
  references one inherits the long name.
- The hand-curated baseline (~18 recipes) is too small to feel rich; growing
  to a 1000–2000-recipe target by hand isn't realistic.

Three credible content strategies are on the table:

1. **All hand-curated.** Highest quality, doesn't scale past a few dozen
   recipes per maintainer-year.
2. **All AI-generated, written directly to the DB.** Scales, but degrades
   first-impression UX, risks fabricated ingredient combinations the
   deterministic engine can't catch (nutrition is recomputed but
   "salmon for breakfast" or "vegan recipe with chicken" isn't a numerical
   error), and removes the operator's ability to vet content before it
   reaches users.
3. **AI drafts + human review + PR ship.** AI does the scale-work,
   humans do the quality gate, git remains the audit log.

The same trade-off applies to ingredient-name overrides (340 friendly
EN+PL strings to replace USDA's bureaucratic descriptions).

## Decision

Adopt option 3. Build a **curation queue** as a single feature
(F18 in [product-spec.md](../product/product-spec.md)) covering both
draft kinds (recipes + ingredient-name overrides) with one pipeline shape.

The pipeline's **invariant**:

**AI proposes → human reviews in-app → PR ships to `data/*.json` →
re-seed lands in DB.**

Concretely:

1. **AI never writes to live tables.** Drafts live in new `RecipeDraft` /
   `IngredientNameDraft` tables. The live `Recipe` / `Ingredient` tables
   are only populated by the existing seeder from `data/*.json`.
2. **The deterministic engine owns nutrition.** Every draft's
   `caloriesPerServing` / macros are recomputed by `engine/units.ts +
   engine/nutrition.ts` from the ingredient DB. AI-volunteered macros are
   discarded; the validator's 5 % delta check catches the AI lying about
   *portions*, not about math.
3. **The validator rejects bad drafts before a human sees them.** Every
   ingredient slug must resolve against the live `Ingredient` table;
   diet-tag vs ingredient `dietCompatibility` is cross-checked (vegan
   recipe with chicken rejected); allergen autodetection unions the
   recipe's ingredient allergens; missing target locales are rejected.
4. **Humans approve every row that ships.** Drafts surface in an in-app
   queue with render-first preview, per-section edit, live nutrition
   recompute, slug-resolution status, and approve/reject actions.
   Reviewers can edit before approving; the validator re-runs on PATCH.
5. **Approved drafts ship via PR.** A ship action writes the approved
   rows to `data/recipes/<batchId>.json` (one file per batch — concurrent
   batches can't merge-conflict) or merges into the slug-keyed
   `data/ingredient-overrides.json`. The repo PR is reviewed and merged
   through the normal git flow; on next `POST /api/admin/db/update` the
   seeder picks up the new content. Two ship modes: `gh` CLI (server-side,
   for instances with `gh` + git credentials) and ZIP download (universal
   fallback — operator commits + opens the PR by hand).
6. **Translatable content is locale-generic.** Draft tables store
   `titles / descriptions / steps / suggestions` as JSON columns keyed
   by locale code; per-locale review audit lives in `*LocaleReview`
   child tables unique on `(draftId, locale)`. Adding a new locale (e.g.
   `de`) is an enum + messages file change — zero schema migration. The
   reviewer's session cookie is scoped to one locale at login.

The deterministic template composer is **deprecated** and gated behind
`RECIPE_COMPOSER_ENABLED=false`. Old composed seed recipes that no user
data references are pruned by the existing orphan-cleanup pass on the
next admin DB update.

## Why not (alternatives)

- **Composer with cuisine / flavour-pair rules added.** Authoring a
  combinatorics-grade compatibility matrix for Polish-language cooking
  would take longer than reviewing AI-drafted recipes one by one, and
  the deterministic output would still feel formulaic. Killing it frees
  engineering attention for the pipeline that does scale.
- **AI writes directly to the live DB.** Trips every "nutrition is
  never invented" / "first-impression UX" objection above. Even with
  perfect macros, a recipe nobody approved isn't a curated recipe.
- **External recipe-database import as the primary source** (TheMealDB,
  Open Recipe Format, RecipeNLG). Considered for Phase F of the
  implementation plan; deferred to v1.1. The AI generator already
  produces unbounded supply at higher quality (EN+PL first-class).
  External datasets are mostly EN-only, mostly American/British comfort
  food, and would need a PL pass for every imported row. Worth
  revisiting once the queue starves.
- **Community contribution from anonymous users.** Out of scope. The
  queue is reachable by admins (Basic Auth) and invited reviewers
  (toggle + password from `/admin`); no public submission path. May
  revisit when curated crosses ~500 recipes.

## Consequences

- **The 100-recipe composer pool drops on next admin DB update.** Existing
  planned / favorited composed recipes survive the orphan prune; the rest
  go. Self-hosters who relied on the composer can set
  `RECIPE_COMPOSER_ENABLED=true` as a temporary escape hatch.
- **The curated baseline gets smaller before it gets bigger.** Day 0
  after the composer flip = ~18 anchor recipes only. Stage 1 of
  §4.1 (staple ingredients) lands first, then Stage 2 (USDA name
  overrides via the queue), then Stage 3 (recipe drafts via the queue
  toward the matrix target and beyond).
- **Reviewer onboarding is enable-by-toggle, not user-account.** The
  reviewer interface (`/review`) is gated by a runtime toggle +
  password set from `/admin`, mirroring the admin panel's own pattern.
  No `User` role; revocation is one PATCH on `InstanceSettings`.
- **PR review remains the audit log.** Every shipped row lands in a
  reviewable PR with the batchId, model used, and row counts in the
  body. Drafts never approved or shipped stay in the DB until an admin
  deletes them.
- **Existing translation infra is reused, not duplicated.** The
  per-locale `IngredientTranslation` / `RecipeTranslation` tables and
  the AI auto-translate runner from [ADR-0007](0007-curated-vs-ai-translations.md)
  cover missing-locale fill-in for already-shipped rows. The curation
  queue is for *new* rows; the translation runner is for *missing locale
  on existing rows*. Two distinct surfaces, one for each problem.

## References

- Implementation plan: [`/home/pavlojs/.claude/plans/plan-md-contains-actual-prompt-purring-ocean.md`](../../home/pavlojs/.claude/plans/plan-md-contains-actual-prompt-purring-ocean.md)
- F18 functional row in [product-spec.md §4](../product/product-spec.md)
- Content roadmap in [product-spec.md §4.1](../product/product-spec.md)
- Translation provenance design: [ADR-0007](0007-curated-vs-ai-translations.md)
- Composer being replaced: `apps/api/src/engine/recipe-templates.ts`
- Composer gate: `RECIPE_COMPOSER_ENABLED` in `apps/api/src/config/env.ts`
