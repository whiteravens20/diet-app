# Product Specification

## 1. Vision

Diet App is a self-hostable diet and meal-planning platform. It turns a user's body
metrics and goals into a daily calorie target, generates calorie-targeted multi-day meal
plans from a curated recipe library, optimises ingredient reuse to cut food waste, and
produces consolidated shopping lists. AI is an optional assistant — the product is fully
functional with no AI key at all.

The **web application** is the primary product. An **Android companion app** (separate
repo, Phase 3) consumes the same API for offline viewing and later sync.

## 2. Principles

1. The curated product database is the single source of truth for nutrition.
2. AI never invents nutrition facts. It may draft recipes, substitutions and plan
   variations — all validated against the database afterward.
3. All calorie/macro/quantity math is deterministic and reproducible.
4. User-chosen targets (calories, macros, restrictions, meal count) are always preserved.
5. The app works without any external AI key (deterministic fallback engine).
6. Self-hosted and Docker-first; no vendor lock-in.

## 3. User stories

**Accounts & profiles**
- As a user, I register with email + password and sign in securely.
- As a user, I create one or more profiles, each with age, sex, height, weight, activity
  level, diet type, goal, preferences, allergens and excluded ingredients.

**Calorie target**
- As a user, I see my maintenance calories and a daily target derived from a weekly
  weight-loss goal (0.25–1.0 kg/week).
- As a user, I can override the daily calorie target manually at any time.
- As a user, I see clearly which numbers are calculated vs. manually entered.

**Meal planning**
- As a user, I pick a diet type, meal count (2–5) and a date range, and generate a plan.
- As a user, I can regenerate a plan or a single day to get variety.
- As a user, the plan respects my calorie target, allergens and excluded ingredients.

**Recipes, favorites, swapping**
- As a user, I browse and filter the recipe library and save favorites.
- As a user, I swap a planned meal for a random alternative or one of my favorites.
- As a user, I substitute an ingredient and see the calorie/macro delta before confirming.

**Shopping**
- As a user, I generate a consolidated, aisle-grouped shopping list for any date range.
- As a user, I mark items I already have and check items off.

**Inventory**
- As a user, ticking a shopping item off adds it to my inventory automatically.
- As a user, I add or remove items by hand (impulse buys, leftovers, things someone ate).
- As a user, new plans and meal swaps prefer recipes I can cook from what's already in.
- As a user, after a streak of inventory-biased generations the planner mixes things up
  so I don't end up eating the same five meals.

**AI (optional)**
- As a user, I add my own OpenAI / Anthropic / OpenRouter / Ollama key.
- As a user without a key, every core feature still works.

## 4. Functional requirements

| # | Requirement |
|---|---|
| F1 | Email/password auth with JWT access + rotating refresh tokens, password reset. |
| F2 | Multiple profiles per account; full preference/allergen/exclusion model. |
| F3 | Deterministic calorie engine (Mifflin-St Jeor) with manual override. |
| F4 | Meal-plan generation for 1–28 days, 2–5 meals/day, honouring constraints. |
| F5 | Recipe library: hand-curated anchors + AI-drafted-then-human-approved additions shipped through the **curation queue (F18)**. The deterministic template composer (`apps/api/src/engine/recipe-templates.ts`) is **deprecated** behind `RECIPE_COMPOSER_ENABLED=false` — it produced semantically nonsense combinations and is replaced by F18. The hand-curated baseline (~18 anchors, ~55 ingredients) gives the planner enough variety to function on day one; growth from there is by F18 batches reviewed in-app and shipped as additions to `data/recipes/<batchId>.json` via PR (long-term target: 1000–2000 curated recipes). See **§4.1 Content pipeline** for the staged rollout. |
| F6 | Meal swap (random / favorite) and ingredient substitution with delta preview. |
| F7 | Shopping-list aggregation: merge, unit-normalise, group, "already have" deductions. |
| F8 | Ingredient-reuse optimisation across the planning window. |
| F9 | Search/filter across recipes, ingredients, favorites, plans. |
| F10 | **AI provider abstraction (4 providers), per-user BYOK keys, failover, three-mode picker.** Four adapter implementations (OpenAI · Anthropic · OpenRouter · Ollama) behind one interface so the router can fail over between them, and a per-user mode picker in Settings with three choices: (a) **None** — every AI feature uses the deterministic engine, no provider calls ever leave the instance; (b) **Use the admin's provider** — the user's AI calls route through `AI_DEFAULT_PROVIDER` / `AI_DEFAULT_MODEL` (the same env-driven config the admin auto-translate uses), capped at a **per-user daily quota** of `AI_ADMIN_USER_DAILY_LIMIT` requests (default 20) to keep one user from burning the operator's whole budget — the cap is counted from `AiUsageLog` and enforced before each call, returning `AI_DAILY_LIMIT_REACHED` when hit; (c) **Bring your own** — the user supplies their own API key (OpenAI/Anthropic/OpenRouter) or Ollama base URL + model name, and their requests are unlimited (no per-user quota — they own the cost). BYOK rows already exist (`AiProviderConfig`) and stay AES-encrypted at rest; the new `User.aiMode` column (`none` \| `admin` \| `byok`, default `none`) is what `AiRouterService.resolveChain()` reads to decide which path to take. The Settings card gains a **Test connection** button that lights up the moment a key (or Ollama URL + model) is filled in — it hits the provider's models-list endpoint (`/v1/models` for OpenAI / OpenRouter, the existing `/api/tags` for Ollama, a small probe call for Anthropic which has no list endpoint), reports success + populates a model-name dropdown from the returned list, or surfaces the provider's error verbatim so the user can fix the credential before saving. Mode `admin` is hidden when the operator hasn't configured `AI_DEFAULT_PROVIDER`. **Quota UX:** the "N/20 admin AI requests used today" counter lives only inside the AI card on the Settings page — the dashboard stays clean. |
| F11 | Deterministic fallback for all AI-assisted features. |
| F12 | Dashboard with calorie target, macro split and plan summary. |
| F13 | **Favorite sets** — per-profile saved day-template: one favourited recipe per meal slot (e.g. *"Set 1"* = breakfast + lunch + dinner picked from favourites). Composable from the dashboard, applicable to one or more days of a plan in a single action so the user doesn't have to swap each meal individually. |
| F14 | **Internationalisation (i18n)** — every user-facing string routed through a translation layer (locale files, no inline copy); per-user language preference persisted on the account; first locales English + Polish; ingredient/recipe names localised via per-locale columns in the curated DB; units and dates formatted via `Intl`; the locale catalogue is the contract Android mirrors so both clients ship the same wording. |
| F15 | **Inventory (pantry-aware planning)** — per-profile stock of ingredients the user actually has: quantity + unit + optional best-before. Updated automatically when a shopping-list item is checked off ("bought 200 g rice → +200 g in inventory"), and editable by hand (add an impulse buy, decrement what someone ate, clear an item). Plan generation, recalculate, day-regenerate and swap then bias toward recipes the inventory can cover, scored by `coverage = covered_ingredient_mass / required_ingredient_mass`. After **N** consecutive inventory-biased generations on the same profile (default `N=5`, configurable per profile) the engine deliberately ignores the bias for one round so the menu doesn't collapse onto the same five recipes. Shopping lists subtract inventory before listing buy quantities (extends today's "already have" deduction); inventory decrements by the recipe's portion when a planned meal is marked eaten. |
| F16 | **Admin panel at `/admin`** — mirrors [archivum-null](https://github.com/whiteravens20/archivum-null)'s pattern: a separate set of admin-only routes under `/api/admin/*`, gated by HTTP Basic Auth checked against `ADMIN_USER` + `ADMIN_PASSWORD` env vars (constant-time compare, `WWW-Authenticate` challenge on 401). The panel is **disabled by default**: when `ADMIN_PASSWORD` is empty or the placeholder default, every admin route returns `403` and the `/admin` page surfaces a "set ADMIN_PASSWORD to enable" message — same fail-closed posture as archivum-null. The web client sends `Authorization: Basic …` headers on every `/api/admin/*` request (no JWT — admin is a separate identity space, not a flag on a user). **Privacy rule:** admin stats are strictly *instance* data — ingredient / recipe / substitution counts and seed bookkeeping. **No per-user signals** (no user / profile / plan / favorite / AI-usage counts), so the panel can never become a user-activity dashboard. The first concrete surface is the **curated-DB updater**: the stack boots fast (only `prisma migrate deploy` runs at startup — no auto-seed), and `POST /api/admin/db/update` is what populates the ingredient + recipe tables from `data/*.json`. It wipes seed-origin recipes and any curated ingredient that no user data references, then re-seeds; user-owned profiles / plans / favorites / inventory are preserved. A `SeedMeta` row holds the sha256 of the files at last-seed so `GET /api/admin/stats` can flag "update available" when the on-disk data changes (e.g. after running the USDA importer). Further surfaces (per-row ingredient / recipe curation, importer trigger from the UI, fallback-engine knobs) are left to follow-up edits of this row. |
| F17 | **Advanced meal-plan options** — the plan generator gets a "Show advanced options" disclosure (collapsed by default; the basic flow stays date-range + meal count + diet type, so a new user is never confronted with these knobs). When expanded the user can: (a) **override the meal count per day** — e.g. 5 meals on Mon/Wed/Fri training days, 3 meals on rest days — while the global meal count remains the fallback; (b) **override the daily calorie target per day** — refeed/training surplus, rest-day deficit — so a single weekly plan can hold a real periodisation pattern instead of being flat; (c) tag a day as **rest** or **refeed** so the calorie override carries semantic meaning for dashboard/stats and so the optimiser knows when a surplus is intentional; (d) **skip** a day entirely (still inside the range but the engine produces no meals — for restaurant nights, travel, social events) and the shopping list excludes it; (e) **lock a slot** on a specific day to a chosen recipe before generating, so the rest of the plan optimises around it. Two cross-day knobs round the panel out: a **variety floor** (`max_repeats_per_recipe` across the window, default 2) so the optimiser can't collapse onto two recipes when constraints are loose, and a **cook-time budget per day** (hard cap in minutes) so busy weekdays only get quick recipes. Schema impact: a single `overrides` JSON column on `meal_plan_days` is enough — none of these settings need first-class tables because they only feed the generator and the rendered plan. Per-day overrides surface as a compact editable list inside the disclosure with one row per planned date; each row falls back to "use plan default" when untouched. Re-roll honours overrides: regenerating a single day uses that day's overrides, regenerating the whole plan re-applies the per-day list. Composes with [[F13]] favorite-sets (a set can be dropped onto a specific day index from the advanced view, e.g. *"Set 1 → Monday, Set 2 → Wed–Fri"*), [[F15]] inventory (a *use-up-by* day flag biases the optimiser toward recipes that consume expiring inventory on the chosen date) and [[F16]] admin panel (operator-level default for `max_repeats_per_recipe` lives in the config surface). |
| F18 | **Curation queue** — admin-controlled draft pipeline at `/admin/curation` plus a reviewer-scoped surface at `/review`. Two draft kinds share one shape: recipe drafts (full recipes, all target locales in one batch, engine-recomputed nutrition) and ingredient-name overrides (friendly EN+PL names that replace ugly USDA FDC descriptions like *"Beef, loin, tenderloin roast, separable lean only, …"*). Admin triggers batch generation against `AI_DEFAULT_PROVIDER` (size + dietTags + mealTypes + cuisine + kcalRange + `targetLocales`), watches stats and ships approved batches; reviewers (gated by a separate runtime toggle + password from `/admin`, no `User` role) review one locale at a time inline (render-first preview, per-section edit, engine-recomputed nutrition strip, keyboard shortcuts). Translatable content lives in JSON columns keyed by locale code (`titles`, `descriptions`, `steps`, `suggestions`) and per-locale audit lives in `*LocaleReview` child tables unique on `(draftId, locale)` so adding a new locale (`de`, …) is enum + messages file only — zero schema migration. **Invariant**: AI proposes → human reviews in-app → PR ships to `data/*.json` → re-seed lands in DB; the deterministic engine owns nutrition end-to-end and the validator rejects any draft whose ingredient slugs don't resolve or whose volunteered macros diverge from engine values by more than 5%. PATCH to a draft's translatable fields wipes all `LocaleReview` rows for that draft (forces re-review of every locale). See [ADR-0008](../adr/0008-curation-queue.md) for the rationale (why AI drafts with human-final-approval rather than AI-only or curate-by-hand-only). |

## 4.1 Content pipeline

The recipe + ingredient catalogue is a product surface, not a one-off seed.
The baseline today (~18 hand-curated anchor recipes, ~55 hand-curated
ingredients, plus ~340 USDA Foundation Foods items with raw FDC
descriptions) is enough to prove the planner works, not enough to feel
rich. Growth from there is the [F18 curation queue](#f18-curation-queue),
which lets AI draft and humans approve at scale without compromising the
"first-impression UX" requirement that justifies hand curation in the
first place. Long-term target: **1000–2000 human-final-approved recipes**
and friendly EN+PL (and any future locale) names for every USDA-imported
ingredient.

### Stage 1 — Catalogue completeness (cheapest, biggest unlock)

1. **Add staple ingredients with PL translations.** Rice (white / brown /
   basmati / jasmine), potatoes (white / sweet / baby), pasta varieties,
   bread / bakery basics, dairy gaps (cottage cheese, feta, mozzarella,
   ricotta), legumes (lentils, chickpeas, beans), quinoa / couscous /
   bulgur. Target: **+30–40 hand-curated ingredients** in
   `data/ingredients.json`. Doable as a single repo PR; doesn't need the
   queue infra.
2. **Quarantine non-cookable items.** Raw wheat berries and flour appearing
   as standalone "cook this" entries is a data-quality bug. Add a
   `usableAs` discriminator (`'ingredient' | 'standalone'`) so flour /
   raw grains are only pickable inside another recipe's ingredient list,
   never as a meal anchor.
3. **`mealTypes` tagging audit.** One `jq` pass per slot to correct mistags
   (steak / fish were appearing as breakfast). Zero new content, immediate
   variety lift.

### Stage 2 — Friendly USDA ingredient names

The first F18 pipeline to ship. ~340 USDA Foundation rows have unusable
raw FDC descriptions (*"Beef, loin, tenderloin roast, separable lean only,
boneless, trimmed to 0\" fat, select, cooked, roasted"*); every recipe
that references one inherits the long name. The ingredient-name draft
runner asks AI for friendly `{ en, pl }` overrides, a human approves them
in the queue, and approved overrides ship as `data/ingredient-overrides.json`
applied at seed time as `IngredientTranslation` rows with
`source = 'MANUAL'`. Fixes 90 % of the "this catalogue feels wrong" UX
without authoring a single new recipe.

### Stage 3 — Recipe drafts via F18 queue

Once friendly names exist, recipe drafts become reviewable. Admin triggers
batches with a spec (count, dietTags, mealTypes, cuisine, kcalRange,
`targetLocales`), the generator produces drafts with all target locales
filled in, the validator runs (slug resolution + engine-recomputed
nutrition + 5%-delta sanity + diet-tag-vs-ingredient cross-check +
allergen autodetection), and the drafts land in the queue.

Coverage milestone (intermediate, not the cap):

```
                 balanced  vegetarian  vegan  keto  highProtein
breakfast            6         4          3      4         5
lunch                8         5          4      5         6
dinner               8         5          4      5         6
snack                4         3          3      3         4
                                                       ≈ 120 first checkpoint
```

The number falls out of the repetition caps ([[project_meal_plan_generator_rules]]:
≤3 per recipe in any 7-day window): a 4-week plan × 4 slots × 5 diet
types needs roughly this many distinct recipes to avoid repetition.
Generation batches target empty cells first; queue stops feeding a cell
once it hits the minimum and moves on. After ~120 the same pipeline
continues toward the 1000–2000 long-term target.

### Stage 4 — Reviewer scaling

The reviewer surface at `/review` (gated by a runtime toggle + password
set from `/admin`) lets the operator hire a Polish reviewer — or a
German one if `de` ships later — without giving them `ADMIN_PASSWORD`.
Each reviewer picks one locale at login; the queue is scoped to drafts
pending their locale. Admin keeps the control plane (generate, ship,
stats, toggle).

### How AI contributes to the curated set

The split mirrors [ADR-0007](../adr/0007-curated-vs-ai-translations.md):
**AI proposes, humans approve, PR ships.** The curated baseline stays
human-final-approved — drafts are never written to the live `Recipe` /
`Ingredient` tables; they ship as additions to `data/*.json` via PR and
flow through the existing seeder. The concerns that argued against
"AI-only authorship" still apply and are why a human reviews every row:

- Curated recipes are the first-impression UX; cultural authenticity and
  a human voice in cooking steps matter more than scale.
- AI invents plausible-but-wrong ingredient lists and portions; the
  deterministic engine catches macros but not "this combination doesn't
  make culinary sense" or "no Polish household cooks salmon for breakfast."
- Per-row human review cost is acceptable when the per-row value is
  high (every curated recipe is on every user's plan). It isn't
  acceptable at long-tail scale, but every curated row is long-tail-on-
  the-way-up: a draft an admin doesn't want to ship gets rejected, never
  reaches users.

**Invariants the pipeline guarantees** (full design in
[ADR-0008](../adr/0008-curation-queue.md)):

- The deterministic engine **recomputes** nutrition for every draft and
  every PATCH. AI-volunteered macros are discarded; the 5%-delta check
  catches lying about portions, not for trusting AI math.
- Every ingredient slug resolves before a draft is shown to a human.
- Diet-tag vs ingredient `dietCompatibility` cross-check catches "vegan
  recipe with chicken" before it reaches the queue.
- Translatable content is locale-generic in the draft tables (JSON keyed
  by locale code; per-locale `LocaleReview` audit child tables unique on
  `(draftId, locale)`). Adding a new locale is enum + messages file
  only — zero schema migration.

**Recommended model for the recipe generator.** v1 default for new
operators: `AI_DEFAULT_PROVIDER=openrouter` +
`AI_DEFAULT_MODEL=google/gemini-3.1-flash-lite`, with the queue's
"Catalogue" picker set to **Curated only**. Live-tested against the
curated baseline at $0.25 / $1.50 per 1 M tokens, it produces the full
default complexity mix (simple + medium + complex) on the first try.
Fallback if 3.1-flash-lite regresses or gets renamed:
`google/gemini-2.5-flash`. The full price/quality table (including
mid-tier `claude-haiku-4-5` and premium `claude-sonnet-4-6` for
higher-quality batches) lives in
[ADR-0008 § "Model recommendations"](../adr/0008-curation-queue.md#model-recommendations-recipe-generator).
Self-hosted Ollama models work for the ingredient-namer pipeline
(short single-field outputs) but struggle with the recipe generator's
nested structured shape — recipe generation against a remote API is
the pragmatic choice even on a privacy-first instance.

## 5. Non-functional requirements

- **Security** — see [SECURITY.md](../../SECURITY.md); encrypted AI keys, scoped data access.
- **Performance** — plan generation off the request path via a worker queue.
- **Scalability** — stateless API, horizontally scalable; Postgres + Redis.
- **Testability** — pure deterministic engines, unit-tested; typed API contract.
- **Accessibility** — semantic HTML, keyboard navigation, dark mode, sufficient contrast.
- **Localization-ready** — English first; copy is centralisable. Full i18n delivery is
  tracked as F14 (Phase 2) — English + Polish locales, per-user language preference,
  localised ingredient/recipe names in the curated DB.
- **Resilience** — every external input validated with Zod; AI failure degrades gracefully.

## 6. MVP scope & phased roadmap

**Phase 1 (web MVP)** — auth, profiles, calorie engine, manual override, diet/meal-count
selection, date-range planning, plan generation, shopping list, favorites, meal/ingredient
swapping, Docker deployment, BYOK AI, no-AI fallback.

**Phase 2** — favorite sets (F13: compose a day from favourites on the dashboard,
drop a whole set onto chosen days of a plan), i18n (F14: route every string through a
translation layer, ship English + Polish, persist a per-user language, localise
ingredient/recipe names in the curated DB), **inventory** (F15: per-profile pantry that
auto-fills from checked-off shopping items, decrements from eaten meals, biases plan
generation/recalculate/swap toward what's on hand, with an anti-monotony reset every N
rounds), **admin panel** (F16: `/admin` page + `/api/admin/*` routes gated by Basic
Auth against `ADMIN_PASSWORD`, mirroring archivum-null; scaffold gate + stats endpoint,
fill surfaces in a follow-up), **advanced meal-plan options** (F17: collapsed-by-default
"Show advanced options" disclosure on the plan generator with per-day overrides for meal
count, calorie target, rest/refeed tags, skip-day and pinned slots; cross-day variety
floor and per-day cook-time cap; persists as a single `overrides` JSON column on
`meal_plan_days`), improved ingredient-reuse optimisation, **curation queue**
(F18: AI-drafted-then-human-approved recipe + ingredient-name pipeline at
`/admin/curation` plus reviewer-scoped surface at `/review`; see §4.1 for
the staged content rollout — staples + composer kill first, then friendly
USDA names, then recipe drafts toward the matrix and the 1000–2000
long-term target), analytics, exports, in-browser offline (PWA), local
Ollama deployment guidance.

**Phase 3** — Android companion app, synchronisation, push notifications, offline-first
mobile experience.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| AI fabricates nutrition / unknown ingredients | Deterministic validation layer recomputes all nutrition; unknown ingredients rejected or remapped. |
| No-AI experience feels empty | ~~Template composition engine generates 100+ fallback meals.~~ **Deprecated** — composer is disabled by default (produced nonsense combinations) and the curation queue (F18) replaces it. Hand-curated baseline (~18 anchors + Stage 1 staples) is enough to bootstrap; curated growth via F18 ships AI-drafted, human-approved additions through PR. Self-hosters who haven't enabled the curation queue still get a usable but small library; instances that run it scale to thousands. |
| Optimiser cannot satisfy tight constraints | Surfaces the gap and reports calorie/macro deltas rather than failing silently. |
| Curated DB too small | USDA FoodData Central importer extends the **ingredient** catalogue from public-domain data (Foundation Foods subset, ~340 items); the **recipe** library grows via the F18 curation queue (AI drafts → in-app human review → PR ship). The deterministic engine owns nutrition end-to-end; humans approve every row; see [ADR-0008](../adr/0008-curation-queue.md) for the AI-proposes / human-approves / PR-ships invariant. |
| Bleeding-edge dependencies break | Versions pinned + verified; ecosystem gaps recorded in [adr/](../adr/). |
| Self-host misconfiguration | `.env.example`, health checks, and [ops/deployment.md](../ops/deployment.md). |
