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
  Open Recipe Format, RecipeNLG). Designed and parked in
  [v1.1-candidates.md § "External-source recipe importer"](../product/v1.1-candidates.md#external-source-recipe-importer-phase-f-of-the-curation-queue-plan).
  The AI generator already produces unbounded supply at higher quality
  (EN+PL first-class); external datasets are mostly EN-only,
  American/British comfort food, and would need a PL pass per row.
  Worth revisiting once the queue starves.
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

## Model recommendations (recipe generator)

The recipe-generator prompt asks the model to author N recipes in one shot:
locale-keyed titles / descriptions / steps, structural metadata, an
ingredient list strictly drawn from the in-prompt catalogue, and exact
field shapes that the validator pins. This is a *long-context structured
output* job, not a casual chat task. Live testing against the openrouter
endpoint, count=3–5 on `catalogueScope: 'curated'`, produced the
following picture:

| Model | $/1M in→out (May 2026) | Behaviour observed |
|---|---|---|
| `google/gemini-2.5-flash-lite` | $0.10 / $0.40 | Cheapest. Fast. **Failed every run** — produced 2-ingredient recipes below the simple band, dropped `difficulty`, used `tbsp` for `unit`. Even with tightened prompt + catalogue scope, 0 / 3 written. Skip. |
| `google/gemini-2.5-flash` | $0.30 / $2.50 | Reliable. 3 / 3 written on first try, sensible 3- to 7-ingredient recipes with EN + PL. Was the recommendation before live-testing 3.1-flash-lite. |
| **`google/gemini-3.1-flash-lite`** | **$0.25 / $1.50** | **Recommended.** Cheaper than 2.5-flash on both input and output. Live test: 5 / 5 written first try, default complexity mix honoured (2 simple + 2 medium + 1 complex), and authored a genuine 10-ingredient *Hearty Beef Stew* in the complex band — a materially harder task than the 5- to 7-ingredient mediums other models produced. Generational jump over 2.5-flash-lite is real. |
| `google/gemini-3-flash-preview` | $0.50 / $3.00 | "Preview" suffix — not stable for production. Skip until promoted. |
| `google/gemini-3.5-flash` | $1.50 / $9.00 | Top flash tier; 5× the price of 3.1-flash-lite. Overkill for v1; revisit if the queue starts producing batches the recommended model can't write. |
| `anthropic/claude-haiku-4-5` | ~$1.00 / $5.00 | Cleanest JSON output of the mid tier. Reliable difficulty + unit. Worth it when the operator wants 10-recipe batches with zero babysitting. |
| `openai/gpt-4o-mini` | $0.15 / $0.60 | Cheap and JSON-disciplined; tends to write blander recipe text and over-uses `easy` difficulty. Acceptable for bulk-fill once the curated baseline is mature. |
| `anthropic/claude-sonnet-4-6` | $3.00 / $15.00 | Highest recipe quality observed in side-tests. Useful when the operator wants generation to feel like a senior recipe editor wrote it — not the day-to-day pick. |

**Default operator recommendation** for v1: set
`AI_DEFAULT_PROVIDER=openrouter` +
`AI_DEFAULT_MODEL=google/gemini-3.1-flash-lite` and run with
`catalogueScope: 'curated'` until the USDA rows have approved friendly
names via the ingredient-namer pipeline. That combination — newer
architecture, sub-$1 input pricing, reliable structured-output discipline
— is the current $ × quality × throughput sweet spot. If 3.1-flash-lite
quality regresses or it gets renamed / deprecated, fall back to
`google/gemini-2.5-flash` (proven stable).

Cheaper or self-hosted alternatives (Ollama `qwen2.5:14b`, `llama3.1:8b`)
work for the ingredient-namer pipeline (short single-field outputs) but
struggle with the recipe-generator's nested structured shape — recipe
generation against a remote API is the pragmatic choice even on a
self-hosted instance.

## Where do my recipes actually live? (self-hoster storage)

Phase E ships three ship modes; the operator picks per ship action. Two
deployment shapes covering the most common self-hoster questions:

### A. Everything local, no extra repo

The default. Works for every self-hoster who just wants their generated
content on their own instance and doesn't care about git history.

1. Generate a batch in `/admin/curation`.
2. Review + approve drafts.
3. Click **Ship to this instance**.

What happens:

- Approved rows land in the live `Recipe` / `Ingredient` / translation
  tables with `origin = ai`, translations `source = MANUAL`. They show
  up immediately at `/recipes` for every user on the instance.
- A sidecar JSON file is dropped under
  `INSTANCE_DATA_DIR/recipes/<batchId>.json` (default
  `./instance-data/recipes/…`) and `INSTANCE_DATA_DIR/ingredient-overrides.json`.
  This directory is **gitignored** — those files never leak into the
  public repo.
- The sidecar is pure operator backup. The seeder does NOT read it back
  on re-seed in v1; the DB is the source of truth on a running instance.
- Re-seeds from `data/*.json` only touch `CURATED_JSON` rows, so a
  `POST /api/admin/db/update` does NOT wipe locally-shipped recipes.
  They survive every upstream pull.

Recovery / migration paths:

- **Same host, fresh DB:** restore from `pg_dump` is the canonical
  recovery path. The sidecar is a secondary backup; a small import
  script can re-apply it (parked for v1.1 if anyone asks).
- **New host, same content:** `rsync` `instance-data/` over and `pg_dump
  | restore` the database. Two simple operations, no git involved.

No env vars to set beyond the defaults — the local ship mode is always
available.

### B. Local + private repo as a backup / sync layer

Some operators want git history for their generated content but don't
want to push to the public diet-app repo (and shouldn't — the canonical
baseline lives under maintainer review).

The pattern:

1. Create a **private** repo on GitHub / GitLab / Gitea (or just
   `git init` a local repo on a NAS) that contains *only* the
   `instance-data/` directory layout. Something like:

   ```
   my-diet-content/
     recipes/
       ship-2026-05-30T19-22-04Z.json
       ship-2026-06-04T08-14-11Z.json
     ingredient-overrides.json
   ```

2. Symlink (or bind-mount in Docker) `instance-data/` in the diet-app
   working dir to your private repo's working tree.

   **`npm run dev` (host-run API):** the API writes to
   `<repo>/instance-data/` via `process.cwd()`. Replace that directory
   with a symlink:

   ```sh
   rm -rf /opt/diet-app/instance-data
   ln -s /opt/my-diet-content /opt/diet-app/instance-data
   ```

   **`docker compose -f infra/docker-compose.yml up` (full local
   stack):** the API container bind-mounts `../instance-data` from the
   compose file. Override that path with your private repo via a
   `docker-compose.override.yml` next to the base file:

   ```yaml
   # infra/docker-compose.override.yml
   services:
     api:
       volumes:
         - /opt/my-diet-content:/app/instance-data
     worker:
       volumes:
         - /opt/my-diet-content:/app/instance-data
   ```

   **`docker compose -f infra/docker-compose.prod.yml up` (production
   stack on a server):** the API uses a named volume `instance-data`
   by default. Override the volume to a host bind-mount the same way:

   ```yaml
   # infra/docker-compose.prod.override.yml
   services:
     api:
       volumes:
         - /var/lib/diet-app/my-content:/app/instance-data
     worker:
       volumes:
         - /var/lib/diet-app/my-content:/app/instance-data
   volumes:
     instance-data: !reset null
   ```

   Then `git init` inside the bind-mounted directory, point it at your
   private remote, commit on whatever cadence suits you.

3. Ship as usual. The sidecar writes go into your private repo's
   working tree. Run `git add . && git commit -m "feat: batch …" &&
   git push` from `instance-data/` on whatever cadence you want
   (manually, via cron, via `inotify`).

4. **Do not set `SHIP_UPSTREAM_ENABLED=true` for this case** — that
   flag is for opening PRs against the canonical diet-app repo, which
   is the maintainer-only contribution path. Local ship + your own
   commits is the right pattern here.

If your "private repo" *is* a separate clone of diet-app on your
machine (e.g. you forked it and want batches as PRs against your fork's
`main`), you can flip `SHIP_UPSTREAM_REMOTE` to point at your fork and
`SHIP_UPSTREAM_ENABLED=true` — `upstream-pr` mode then opens PRs against
your fork instead of the canonical repo. The mode is repo-agnostic; the
default just happens to be `origin`.

### C. What about the canonical-baseline maintainer?

The maintainer instance runs the same code as every other self-host.
Pushing AI-drafted content to the canonical `whiteravens20/diet-app`
repo is hard-disabled at runtime, with **no escape hatch**:

- The upstream-PR runner resolves `git remote get-url <remote>` and
  matches it against a hardcoded canonical-repo pattern.
- A match returns `SHIP_UPSTREAM_BLOCKED_CANONICAL` whether or not
  every other env var is correct. The block applies to every instance,
  including the maintainer's.
- The canonical baseline grows through **hand-authored PRs** that
  modify `data/recipes.json` / `data/ingredients.json` directly. AI
  drafting is for instance-local content only.

This is intentional: it removes the foot-gun where a self-hoster might
accidentally leave `origin` pointing at the canonical repo and ship a
batch of AI slop into review. The maintainer's own instance keeps
generated content in a private mirror (config B) — the same shape every
other self-hoster gets.

If the maintainer ever needs to grow the canonical baseline from
in-app review, the recommended workflow is: review approved drafts in
the admin queue, export the bundle (config C of the storage section —
download a JSON), then hand-curate the rows into a normal PR against
`data/recipes.json`. The bundle file is what makes that step easy; it
already matches the on-disk shape the canonical baseline uses.

### What is *not* shipped via gh PRs

Anything generated locally on a self-hoster instance is **never**
expected to reach the canonical diet-app repo. The default refuses
upstream pushes (`SHIP_UPSTREAM_ENABLED=false`); even when enabled, the
canonical-remote check refuses to ship if `SHIP_UPSTREAM_REMOTE` still
resolves to `whiteravens20/diet-app`. The only way upstream-PR mode
opens a PR is when it's pointing at a fork, a private mirror, or a
self-hosted gitea — which is exactly the use case the mode exists for.

### The canonical-remote guard is a foot-gun bumper, not a security control

Anyone who clones this repo can edit `CANONICAL_REMOTE_PATTERNS` in
[`apps/api/src/admin/drafts/ship/upstream-mode.ts`](../../apps/api/src/admin/drafts/ship/upstream-mode.ts),
recompile, and ship to whatever remote they want. That's an inherent
property of open source — runtime code in the operator's hands is
never a real security boundary.

What the guard does protect against is the **accident**: a self-hoster
who forks diet-app, forgets to change `SHIP_UPSTREAM_REMOTE`, flips
`SHIP_UPSTREAM_ENABLED=true`, and clicks Ship. Without the guard, that
sequence would open an AI-slop PR against the canonical repo. With the
guard, it returns `SHIP_UPSTREAM_BLOCKED_CANONICAL` and the operator
has to consciously edit code to reach upstream — which is no longer
"an accident."

The real defences against malicious or careless upstream contributions
are **GitHub-side**, not code-side:

- **Push permissions.** Forks can't push branches to
  `whiteravens20/diet-app`; the network rejects unauthorised pushes
  regardless of what the runtime does.
- **Branch protection on `main`.** Required CODEOWNER review, required
  signed commits, required status checks (CodeQL, Trivy, `npm audit`,
  the test matrix). See
  [.github/workflows/branch-protection-audit.yml](../../.github/workflows/branch-protection-audit.yml).
- **CODEOWNERS.** Every PR touching sensitive paths (`/.github/`,
  `/apps/api/src/{auth,ai,engine}/`, `/apps/api/prisma/`,
  `/SECURITY.md`, `/LICENSE`) requires maintainer approval.
- **Forbidden-path auto-close.** A workflow rejects PRs that touch
  paths that should never reach this repo (operator-private
  `instance-data/`, generated files, etc.). See
  [.github/workflows/forbidden-paths.yml](../../.github/workflows/forbidden-paths.yml).

In short: the runtime check is "don't shoot yourself in the foot"; the
GitHub-side checks are "even if you do, nothing gets merged."

## References

- Implementation plan: [`/home/pavlojs/.claude/plans/plan-md-contains-actual-prompt-purring-ocean.md`](../../home/pavlojs/.claude/plans/plan-md-contains-actual-prompt-purring-ocean.md)
- F18 functional row in [product-spec.md §4](../product/product-spec.md)
- Content roadmap in [product-spec.md §4.1](../product/product-spec.md)
- Translation provenance design: [ADR-0007](0007-curated-vs-ai-translations.md)
- Composer being replaced: `apps/api/src/engine/recipe-templates.ts`
- Composer gate: `RECIPE_COMPOSER_ENABLED` in `apps/api/src/config/env.ts`
