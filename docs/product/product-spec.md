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
| ~~F1~~ | Email/password auth with JWT access + rotating refresh tokens, password reset. |
| ~~F2~~ | Multiple profiles per account; full preference/allergen/exclusion model. |
| ~~F3~~ | Deterministic calorie engine (Mifflin-St Jeor) with manual override. |
| ~~F4~~ | Meal-plan generation for 1–28 days, 2–5 meals/day, honouring constraints. |
| ~~F5~~ | Recipe library: hand-curated anchors + AI-drafted-then-human-approved additions shipped through the **curation queue (F18)**. The deterministic template composer that previously fabricated recipes from structural slots was **removed in 2026-06** — it produced semantically nonsense combinations and is replaced by F18. The hand-curated baseline (~18 anchors, ~55 ingredients) gives the planner enough variety to function on day one; growth from there is by F18 batches reviewed in-app and shipped as additions to `data/recipes/<batchId>.json` via PR (long-term target: 1000–2000 curated recipes). See **§4.1 Content pipeline** for the staged rollout. |
| ~~F6~~ | Meal swap (random / favorite) and ingredient substitution with delta preview. |
| ~~F7~~ | Shopping-list aggregation: merge, unit-normalise, group, "already have" deductions. |
| ~~F8~~ | Ingredient-reuse optimisation across the planning window. |
| ~~F9~~ | Search/filter across recipes, ingredients, favorites, plans. |
| ~~F10~~ | **AI provider abstraction (4 providers), per-user BYOK keys, failover, three-mode picker.** Four adapter implementations (OpenAI · Anthropic · OpenRouter · Ollama) behind one interface so the router can fail over between them, and a per-user mode picker in Settings with three choices: (a) **None** — every AI feature uses the deterministic engine, no provider calls ever leave the instance; (b) **Use the admin's provider** — the user's AI calls route through `AI_DEFAULT_PROVIDER` / `AI_DEFAULT_MODEL` (the same env-driven config the admin auto-translate uses), capped at a **per-user monthly quota** of `AI_ADMIN_USER_MONTHLY_LIMIT` requests (default 40, rolling 30 days) to keep one user from burning the operator's whole budget — the cap is counted from `AiUsageLog` rows with `mode='admin'` and `userId=<user>` in the last 30 days, enforced before each call, returning `AI_MONTHLY_LIMIT_REACHED` when hit; (c) **Bring your own** — the user supplies their own API key (OpenAI/Anthropic/OpenRouter) or Ollama base URL + model name, and their requests are unlimited (no per-user quota — they own the cost). BYOK rows already exist (`AiProviderConfig`) and stay AES-encrypted at rest; the new `User.aiMode` column (`none` \| `admin` \| `byok`, default `none`) is what `AiRouterService.resolveChain()` reads to decide which path to take. The Settings card gains a **Test connection** button that lights up the moment a key (or Ollama URL + model) is filled in — it hits the provider's models-list endpoint (`/v1/models` for OpenAI / OpenRouter, the existing `/api/tags` for Ollama, a small probe call for Anthropic which has no list endpoint), reports success + populates a model-name dropdown from the returned list, or surfaces the provider's error verbatim so the user can fix the credential before saving. Mode `admin` is hidden when the operator hasn't configured `AI_DEFAULT_PROVIDER`. **Quota UX:** whenever `aiMode !== 'none'` the app shell renders a small chip next to the language switcher — admin-mode shows `✨ N/40 this month` with the rolling reset date as a tooltip, BYOK shows `✨ BYOK` (no quota). The Settings AI card holds the authoritative counter (with the rolling reset date stated in full) plus the mode picker, Test-connection button and model dropdown. Composes with [[F20]] which is the first user-facing surface that actually consumes the quota. |
| ~~F11~~ | Deterministic fallback for all AI-assisted features. |
| ~~F12~~ | Dashboard with calorie target, macro split and plan summary. |
| ~~F13~~ | **Favorite sets** — per-profile saved day-template: one favourited recipe per meal slot (e.g. *"Set 1"* = breakfast + lunch + dinner picked from favourites). Composable from the dashboard, applicable to one or more days of a plan in a single action so the user doesn't have to swap each meal individually. |
| ~~F14~~ | **Internationalisation (i18n)** — every user-facing string routed through a translation layer (locale files, no inline copy); per-user language preference persisted on the account; first locales English + Polish; ingredient/recipe names localised via per-locale columns in the curated DB; units and dates formatted via `Intl`; the locale catalogue is the contract Android mirrors so both clients ship the same wording. |
| ~~F15~~ | **Inventory (pantry-aware planning)** — per-profile stock of ingredients the user actually has: quantity + unit + optional best-before. **Manual only**: the user owns what enters and leaves the pantry; the application never auto-decrements when meals are cooked and never auto-adds the full shopping check-off. The pantry's role is to surface real-world *leftovers* (over-bought a 700 g pack for a recipe that needed 650 g → 50 g lives in the pantry, ready for the next plan to lean on). The optimiser weights recipes by `coverage = covered_ingredient_mass / required_ingredient_mass`. Shopping lists pre-fill `alreadyHaveQuantity` from the pantry so the buy column is reduced by what's already on hand. **Shipped 2026-06**: `InventoryItem` table, `/inventory` CRUD page (profile picker, category-grouped list, inline qty/best-before edit, add-form with ingredient typeahead), optimiser coverage scoring on `generate`/`regenerate`/`regenerateDay`, swap-pool re-rank (deterministic random path + `aiSwapMeal` + `aiSuggestIngredient`) — AI features see pantry-friendly candidates first via pool pre-sort (engine builds the pool, AI ranks), never the pantry directly. `respectInventory` boolean on every relevant request schema (`GeneratePlanRequest`, `SwapMealRequest`, `AiSwapMealRequest`, `AiSuggestIngredientRequest`) with **UI toggles**: a *Prefer recipes that use my pantry* checkbox on the plan-generation form (defaults on) and a page-level *Bias swaps toward what's in my pantry* checkbox on the meal-plans page that applies to every deterministic swap AND every AI swap on every plan card. Both default-on, both togglable any time. There is **no Delete-meal button and no Mark-eaten button** — inventory is not a per-meal consumption ledger; the only automatic decrement happens on shopping-list check-off (the plan "uses" what was already on hand), shipped under [[F15.1]] alongside the over-buy auto-leftover, the anti-monotony rotation and the best-before urgency pill. |
| ~~F15.1~~ | **Inventory follow-ups** — three correlated jobs gated on F15's manual baseline. **Shipped 2026-06.** **(a) Shopping ↔ pantry consumption / over-buy.** Closes the loop between the shopping list and the pantry. Each shopping-list row gains an inline numeric **"bought"** input next to **"have"**. On check-off, the world stock change for that line is `purchasedQuantity − totalQuantity` (signed). With `purchasedQuantity` defaulting to `toBuyQuantity` when the user hasn't filled it, the pantry portion (`alreadyHaveQuantity`) is decremented automatically — the plan "uses" what was already on hand. An over-buy (`purchased > toBuy`) lands the positive diff as a leftover row in the pantry. Idempotent on uncheck / re-check via a signed `inventoryDelta` snapshot on the row: any later edit to `purchased`, `alreadyHave` or `checked` re-derives the target delta and applies only the difference. Subsequent shopping lists generated for the same profile pick up the now-reduced pantry via the existing `pantryCoverageByItemUnit` pre-fill, so the user is never asked to buy something the previous list already consumed. *Schema*: `purchasedQuantity Float?` + `inventoryDelta Float @default(0)` on `ShoppingListItem`. *API*: `PATCH /shopping-lists/:listId/items/:itemId` accepts `purchasedQuantity` alongside `alreadyHaveQuantity` / `checked`. *Note*: a `source` enum on `InventoryItem` was considered for tagging shopping-derived rows but dropped — aggregating into the existing per-`(profile, ingredient, unit)` row keeps the model simpler; provenance lives on the shopping row (`inventoryDelta`) instead. **(b) Anti-monotony rotation for inventory-biased generation.** After **N** consecutive plan-level generations that actually applied a pantry bias on the same profile (default `N=5`, configurable per profile via `inventoryBiasResetEvery`) the optimiser drops the bias for the next round so the menu doesn't collapse onto the same handful of pantry-friendly recipes; the streak resets and the round after resumes biasing. Scoped to plan-level paths (`generate` / `regenerate` / `regenerateDay`) — per-meal swap doesn't increment the streak. `0` disables the rotation entirely. *Schema*: `Profile.inventoryBiasStreak Int @default(0)` transient counter, `ProfilePreference.inventoryBiasResetEvery Int @default(5)` threshold. *Service*: `resolveInventoryBias` reads streak + threshold, returns `undefined` (and resets) when the threshold is hit, otherwise computes the coverage map and bumps the counter. **(c) UX polish** — a "from pantry" chip on shopping items whose `alreadyHaveQuantity > 0`; a numeric input on the profile preferences card for `inventoryBiasResetEvery`; a red urgency pill on inventory rows whose `bestBefore ≤ today + 2 days` (composes with [[F17]]'s *use-up-by* day flag when that lands). Composes with [[F15]]'s coverage bias — (a) keeps the pantry honest, (b) keeps the bias from over-fitting, (c) makes the state visible. |
| ~~F16~~ | **Admin panel at `/admin`** — mirrors [archivum-null](https://github.com/whiteravens20/archivum-null)'s pattern: a separate set of admin-only routes under `/api/admin/*`, gated by HTTP Basic Auth checked against `ADMIN_USER` + `ADMIN_PASSWORD` env vars (constant-time compare, `WWW-Authenticate` challenge on 401). The panel is **disabled by default**: when `ADMIN_PASSWORD` is empty or the placeholder default, every admin route returns `403` and the `/admin` page surfaces a "set ADMIN_PASSWORD to enable" message — same fail-closed posture as archivum-null. The web client sends `Authorization: Basic …` headers on every `/api/admin/*` request (no JWT — admin is a separate identity space, not a flag on a user). **Privacy rule:** admin stats are strictly *instance* data — ingredient / recipe / substitution counts and seed bookkeeping. **No per-user signals** (no user / profile / plan / favorite / AI-usage counts), so the panel can never become a user-activity dashboard. The first concrete surface is the **curated-DB updater**: the stack boots fast (only `prisma migrate deploy` runs at startup — no auto-seed), and `POST /api/admin/db/update` is what populates the ingredient + recipe tables from `data/*.json`. It wipes seed-origin recipes and any curated ingredient that no user data references, then re-seeds; user-owned profiles / plans / favorites / inventory are preserved. A `SeedMeta` row holds the sha256 of the files at last-seed so `GET /api/admin/stats` can flag "update available" when the on-disk data changes (e.g. after running the USDA importer). Further surfaces (per-row ingredient / recipe curation, importer trigger from the UI, fallback-engine knobs) are left to follow-up edits of this row. |
| F17 | **Advanced meal-plan options** — the plan generator gets a "Show advanced options" disclosure (collapsed by default; the basic flow stays date-range + meal count + diet type, so a new user is never confronted with these knobs). When expanded the user can: (a) **override the meal count per day** — e.g. 5 meals on Mon/Wed/Fri training days, 3 meals on rest days — while the global meal count remains the fallback; (b) **override the daily calorie target per day** — refeed/training surplus, rest-day deficit — so a single weekly plan can hold a real periodisation pattern instead of being flat; (c) tag a day as **rest** or **refeed** so the calorie override carries semantic meaning for dashboard/stats and so the optimiser knows when a surplus is intentional; (d) **skip** a day entirely (still inside the range but the engine produces no meals — for restaurant nights, travel, social events) and the shopping list excludes it; (e) **lock a slot** on a specific day to a chosen recipe before generating, so the rest of the plan optimises around it. Two cross-day knobs round the panel out: a **variety floor** (`max_repeats_per_recipe` across the window, default 2) so the optimiser can't collapse onto two recipes when constraints are loose, and a **cook-time budget per day** (hard cap in minutes) so busy weekdays only get quick recipes. Schema impact: a single `overrides` JSON column on `meal_plan_days` is enough — none of these settings need first-class tables because they only feed the generator and the rendered plan. Per-day overrides surface as a compact editable list inside the disclosure with one row per planned date; each row falls back to "use plan default" when untouched. Re-roll honours overrides: regenerating a single day uses that day's overrides, regenerating the whole plan re-applies the per-day list. Composes with [[F13]] favorite-sets (a set can be dropped onto a specific day index from the advanced view, e.g. *"Set 1 → Monday, Set 2 → Wed–Fri"*), [[F15]] inventory (a *use-up-by* day flag biases the optimiser toward recipes that consume expiring inventory on the chosen date) and [[F16]] admin panel (operator-level default for `max_repeats_per_recipe` lives in the config surface). |
| ~~F18~~ | **Curation queue** — admin-controlled draft pipeline at `/admin/curation` plus a reviewer-scoped surface at `/review`. Two draft kinds share one shape: recipe drafts (full recipes, all target locales in one batch, engine-recomputed nutrition) and ingredient-name overrides (friendly EN+PL names that replace ugly USDA FDC descriptions like *"Beef, loin, tenderloin roast, separable lean only, …"*). Admin triggers batch generation against `AI_DEFAULT_PROVIDER` (size + dietTags + mealTypes + cuisine + kcalRange + `targetLocales`), watches stats and ships approved batches; reviewers (gated by a separate runtime toggle + password from `/admin`, no `User` role) review one locale at a time inline (render-first preview, per-section edit, engine-recomputed nutrition strip, keyboard shortcuts). Translatable content lives in JSON columns keyed by locale code (`titles`, `descriptions`, `steps`, `suggestions`) and per-locale audit lives in `*LocaleReview` child tables unique on `(draftId, locale)` so adding a new locale (`de`, …) is enum + messages file only — zero schema migration. **Invariant**: AI proposes → human reviews in-app → PR ships to `data/*.json` → re-seed lands in DB; the deterministic engine owns nutrition end-to-end and the validator rejects any draft whose ingredient slugs don't resolve or whose volunteered macros diverge from engine values by more than 5%. PATCH to a draft's translatable fields wipes all `LocaleReview` rows for that draft (forces re-review of every locale). See [ADR-0008](../adr/0008-curation-queue.md) for the rationale (why AI drafts with human-final-approval rather than AI-only or curate-by-hand-only). |
| ~~F19~~ | **Beautiful UI + notifications** — a coordinated visual + interaction pass plus a notification surface that the future Android app reuses. Scope: **(a) layout breathing room** — widen the primary content column on dashboard, meal plans, recipes, shopping lists and settings; tighten typographic scale (consistent heading sizes, line-height, body weight) so dense lists read as scannable rather than cramped; per-section text formatting pass (clear hierarchy: section title → subtitle → body, no naked unstyled `<p>` blocks). **(b) Weight tracking on the dashboard** — a new per-profile weight log (timestamped entries, kg or lb depending on locale) rendered as a trend chart placed next to the macros pie (`grid-cols-2` on `lg`, stacked on mobile). Inline "Log weight today" form at the top of the card; chart shows last 90 days with a 7-day moving average overlay; target weight (from profile) drawn as a horizontal reference line. Schema: new `WeightEntry { id, profileId, kg, recordedAt }` table — no derived stats stored, the chart computes from raw rows. **(c) Weight reminders** — per-profile cadence (`off | daily | weekly`, default `weekly`, configurable in Settings); cron walks profiles whose last entry is older than the cadence and emits a `Notification` row (`profileId`, `type='weight_reminder'`, `payload`, `readAt`). Delivery channels are pluggable: web client polls `/notifications/unread` and surfaces a toast + bell-icon counter in the app shell; the Android app (separate repo) reads the same endpoint via FCM-triggered fetch, so the *contract* is the notification table + endpoint, not a web-specific push surface — see Android contract mirror. **(d) Meal-plan rows** — replace the ingredient list under each planned meal with a compact macros chip strip (`P/F/C/kcal`) so the day-row stays scannable; tapping the meal opens an **animated modal** (Framer Motion: scale-95→100 + opacity over 180ms, dismiss on backdrop click / Esc) that renders the full recipe (title, hero photo placeholder, ingredients with quantities, steps, full nutrition, swap/substitute actions). The modal is the single recipe surface — `/recipes/[id]` becomes a thin route wrapper around the same component for deep-linking. **(e) Decorative produce art** — minimalist hand-drawn / soft-shadow SVG illustrations of vegetables and fruits (~12 motifs, single-color line + accent fill) positioned absolutely in the top-right corner of dashboard, meal plans, recipes and shopping lists. Colours pulled from the active CSS-var theme (`--color-primary` line, `--color-accent` fill) so light/dark themes both stay coherent; motifs are decorative-only (`aria-hidden`, `pointer-events: none`), responsive-hidden on `sm`. **(f) Empty-state polish** — every "no data yet" surface (empty plan, empty inventory, empty favourites) gets a centred illustration + one-sentence prompt + primary CTA instead of today's plain-text placeholders. **Out of scope this row:** push notifications via web-push (browser permission flow lives in a future follow-up if ever needed — the polling channel is enough for v1); per-entry weight notes (raw `kg` only for now); food photography (placeholder until F18 ships approved recipes with image URLs). |
| F19.1 | **Visual identity polish — "radiates diet app"** — a graphical follow-up to [[F19]]. The original F19 (e) shipped with hand-rolled stroke glyphs that read as clip-art rather than product personality, so the motif layer was removed; F19.1 reintroduces the visual layer with real assets and broadens the scope beyond corner decoration. **(a) Real decorative SVGs.** Replace the removed glyph component with professionally-drawn food / produce illustrations sourced externally (e.g. unDraw, Streamline, Heroicons food set, or hand-illustrated commissions); each asset ships in the repo under `apps/web/public/illustrations/` with attribution captured in a `CREDITS.md` block when the licence requires it. Render at ~140–200 px in the top-right corner of dashboard / meal-plans / recipes / shopping-lists / inventory using `currentColor` (or palette-aware fills) so light/dark themes + the active `data-palette` stay coherent; baseline opacity around 8–15 % so the art recedes behind content. Decorative-only (`aria-hidden`, `pointer-events: none`), responsive-hidden below `sm`. **(b) Empty-state illustrations** get richer art (real produce / cooking imagery instead of a single Lucide glyph) — same source pool, larger render, no behaviour change to the `EmptyState` component contract. **(c) Hero / first-impression surfaces** — the landing page and the new-user `/dashboard` welcome state pick up at least one warm food-adjacent visual (illustration or low-noise photo) so the very first paint reads as a *diet / nutrition* tool rather than a generic SaaS dashboard. **(d) Iconography cohesion pass** — sidebar / nav Lucide icons audited against a "kitchen / food / health" reading; orphan corporate glyphs swapped for food-domain or neutral alternatives. **(e) Optional micro-illustrations** under sectioned cards (e.g. a small olive sprig beside the *Nutrition* heading on the recipe modal) — tiny, monochrome, never competing with data. **Goal**: a first-time visitor lands on `/dashboard` and instantly reads the product as *food / health / dieting*, not "generic admin panel with a kcal column." **Out of scope this row:** generated imagery pipeline (assets land via PR, not at runtime); food photography of curated recipes (still parked behind [[F18]] image URLs); motion / scroll-driven art (static only for v1.1); palette-keyed multi-asset variants (use `currentColor` instead). |
| ~~F20~~ | **AI smart-macros assistant** — three user-facing features that ride on [[F10]]'s router and respect its mode + quota: **(a) AI meal swap** — on a planned meal, "Swap with AI" calls a deterministic candidate engine first (compatible recipes inside the user's diet + meal type + ±15% kcal of the slot's target), then AI ranks one pick with a one-sentence reason; the engine recomputes day macros so the swap never breaks the calorie window. **(b) AI ingredient swap** — on the F19 recipe modal, per-ingredient "Find substitute" picks one ingredient from the live curated DB (slugs only — never invented), engine recomputes the recipe's per-serving macros and rejects substitutes that move kcal/macros by more than 10% unless the user opts in to override. **(c) Recipe draft from a prompt** — `/recipes` gets a "Draft with AI" CTA; the user enters a free-text prompt (`"Thai chicken & broccoli, ~600 kcal, 30 min"`), the AI returns a recipe whose ingredient slugs must resolve against the live `Ingredient` table; reusing the F18 validator chain (engine-recomputed nutrition + 5% sanity check + diet/allergen cross-check) the draft lands in the user's *favourites* with `source='AI'`, not in the F18 admin curation queue — it's per-user content, not a baseline contribution. **Provenance**: every artefact produced by these features carries `source='AI'` and renders a small `✨ AI-assisted` chip on the meal-plan row, recipe card, and modal title. **Fallback (F11)**: each feature has a deterministic-only path so `aiMode='none'` users still get a working version — meal swap falls back to the existing random-from-compatible swap, ingredient swap to the existing substitution-engine top pick, recipe draft falls back to disabled-with-tooltip ("Turn on AI in Settings to draft recipes"). **Logging**: every call writes one `AiUsageLog` row with `feature='meal_swap' | 'ingredient_swap' | 'recipe_draft'`, `mode`, `tokensIn`, `tokensOut` — the same log the F10 quota guard reads. Out of scope this row: AI coach/explainer over the dashboard (parked); writing user-drafted recipes back to the curation queue (a future "promote to community" action, not v1). |
| ~~F21~~ | **Footer + Terms of Service** — a persistent footer on every authenticated and public route plus a `/terms` page that registration links to. **Footer layout** (single `<footer>` component mounted by [apps/web/src/app/layout.tsx](../../apps/web/src/app/layout.tsx) so it appears under both `(app)` and `(auth)` route groups): one centred horizontal row of link groups separated by literal `|` glyphs with `gap-3` between groups; each group is a Lucide icon (`h-3.5 w-3.5`, `aria-hidden`, `pointer-events-none` on the icon itself) padded left of the label with `gap-1.5`. Default link set: **Source** (`Github` icon → `https://github.com/whiteravens20/diet-app`) · **Documentation** (`BookOpen` icon → `https://wrservices.link`) · **Terms of Service** (`Scale` icon → `/terms`) · **Support us** (`Heart` icon → White Ravens ko-fi profile, exact URL TBD on implementation — env-overridable via `NEXT_PUBLIC_SUPPORT_URL` so forks can repoint). Below that row, a second centred line: `© White Ravens` (links to `/`, the public landing page) and a small muted-color **version chip** rendering `v{package.json.version}` resolved at build time via a Next public env (`NEXT_PUBLIC_APP_VERSION`, injected by `next.config.ts` reading the workspace root `package.json`). All link labels routed through i18n (`footer.source`, `footer.docs`, `footer.terms`, `footer.support`, `footer.copyright`) per the must-follow rules; icons are decorative only and never carry text content. Responsive: on `sm` the row stays single-line (labels are short — "Source · Docs · Terms · Support"); below `sm` the separators collapse and groups wrap vertically with the same icon-left treatment. **Terms of Service page** at `/terms` (server component, public, no auth) mirrors the structure of [archivum-null's ToS](https://github.com/whiteravens20/archivum-null) (table-of-contents sidebar + numbered sections + last-updated date header) but tailored to this codebase's actual surface: **(§1) what this is** — a self-hosted meal-planning application; the operator of *this* instance is responsible for its uptime, data, and any service guarantees; the upstream project provides the code under MIT, no warranty. **(§2) accounts** — account creation requires an email and password; you are responsible for keeping credentials safe; account deletion is hard-delete with full cascade across profiles / plans / favorites / inventory / AI usage logs (matches the F-account-settings cascade rule). **(§3) BYOK keys + admin AI mode** — when you enable BYOK in Settings you are sending your own API key to your own chosen provider; the operator of this instance stores the key AES-encrypted at rest but does not insulate you from your provider's terms or costs. When using `aiMode='admin'` the operator is paying for your calls within their configured monthly quota; abuse of that mode is grounds for the operator to disable your account. **(§4) nutrition is not medical advice** — every calorie, macro, and micronutrient value rendered by the application is computed by a deterministic engine from a curated ingredient database; values are best-effort and not validated for any medical, clinical, or therapeutic purpose; consult a qualified professional before making dietary changes that affect a medical condition. **(§5) AI-assisted content** — AI-drafted recipes, ingredient substitutions and meal swaps carry an `✨ AI-assisted` chip; review them before consumption; the deterministic engine recomputes nutrition for every AI artefact and rejects nutrition the model invented, but ingredient choices and preparation steps remain AI-authored and should be sanity-checked. **(§6) curated content licence** — `data/recipes/` and `data/ingredients.json` ship under the repository's MIT licence; user-contributed recipes (F18 promotion path) are contributed under the same licence by submission. **(§7) data residency** — your data lives in the database of the instance you're using; the upstream project has no access to it. **(§8) liability + warranty** — same disclaimer block as archivum-null (provided "as is", no warranty, operator + upstream not liable for damages arising from use), reduced to plain language with a "TL;DR: this is a free, open-source tool; use your head" lead. **(§9) changes** — the ToS may be updated; material changes are announced via the CHANGELOG; continued use after a published change constitutes acceptance. **(§10) contact** — operator email placeholder (`NEXT_PUBLIC_OPERATOR_CONTACT` env, surfaced on the page only when set so forks don't have to mock one). All sections written in EN+PL with the same `messages/{en,pl}.json` discipline as the rest of the app; section keys live under `terms.section{N}.{title,body}` so future locales add a translation file with zero schema churn. **Registration consent** — the registration form ([apps/web/src/app/(auth)/register/page.tsx](../../apps/web/src/app/(auth)/register/page.tsx)) gains a single line below the submit button: `By creating an account you agree to the {tosLink}` rendered with `t.rich()` (same pattern as the existing in-app disclaimers), where `{tosLink}` opens `/terms` in a new tab. No checkbox — the line is informational, the act of submission is the consent (matches archivum-null's pattern; avoids dark-pattern-adjacent friction for what is a self-hosted tool). **Out of scope this row:** cookie banner (the app uses one functional cookie `NEXT_LOCALE` and the auth session cookies — both functional, no consent banner required under GDPR's strict-necessity carve-out, documented in the ToS); privacy-policy as a separate page (folded into ToS §7 for v1; can split later when self-hosters request a separable policy document for compliance reasons); operator-customisable ToS overlays (forks edit `data/terms-overrides.json` if they want to append jurisdiction-specific clauses — parked as a follow-up). |
| F100 | **Release-readiness pass** — a repeatable, never-struck pre-release sweep that takes the codebase from "feature-complete" to "shippable." Treated as a recurring goal, not a one-shot ticket: every release candidate re-runs the whole pass and only ships when each scope item is green. Scope: **(a) Full security audit** — run the full `/security-review` skill across the working tree and every reachable surface (auth, BYOK key handling, admin Basic-Auth, reviewer session cookie, all `/api/*` controllers, file writers under `data/`, gh-mode ship runner, USDA importer, AI prompt construction); fix every Critical and High finding before tag, document accepted Mediums in `docs/security/accepted-risks.md`. Includes a dependency audit (`npm audit --omit=dev`, Dependabot baseline) with all Highs patched. **(b) Full test coverage + updates** — bring every workspace to a documented coverage floor (engine ≥ 95%, services ≥ 85%, controllers ≥ 80%, web components ≥ 70%) measured by `vitest --coverage`, with a CI gate that fails the build on regression. Stale tests are deleted or rewritten — no `.skip` / `xfail` / `it.todo` reaches `main`. Adds end-to-end smoke coverage for the golden path of every shipped F-row (sign-up → profile → plan → shopping list → swap → settings). **(c) Lint + typecheck clean** — `npm run lint` and `npm run typecheck` exit zero across all workspaces with zero warnings; ESLint disable comments are reviewed individually and either removed or annotated with a one-line `// disable: <why>`. No `any`, no `@ts-ignore`, no `@ts-expect-error` without an issue link. **(d) De-slop pass** — sweep the diff for over-engineered abstractions, dead code, speculative interfaces, unused exports, multi-paragraph docstrings, half-finished fallbacks, and backwards-compat shims that no longer have a caller; delete rather than refactor when the surface isn't justified. Includes a `knip` / `ts-prune` run with all unused exports either removed or explicitly re-exported with intent. **(e) Code optimisation** — measurable hot-path review: profile the meal-plan generator and shopping-list aggregator under realistic load (28-day plan, 5 meals/day, 1k ingredients), index any Prisma query that crosses 50 ms, lazy-load every non-critical web bundle, ship `next build --turbopack` clean with bundle-analyzer thresholds documented in [docs/perf/budgets.md](../perf/budgets.md). No premature micro-optimisation — every change carries a before/after number in the PR. **(f) Hack-safe codebase** — defence-in-depth review aligned to OWASP Top 10: every controller validates input through a `packages/shared` Zod schema (no raw `req.body` reads), every Prisma query that takes user input goes through a typed-input layer (no string-built SQL anywhere), secrets resolved only through the env-validation layer (no `process.env.*` reads outside `apps/api/src/config/`), CSRF + same-site cookie posture verified for `/review` and `/api/admin/*`, rate limits on `/auth/*` and `/api/admin/translations/fill`, security headers (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`) set by the Next middleware and asserted by an integration test. AI prompt-injection surface (recipe-draft user prompt, ingredient names that flow into prompts) is bounded by the structured-filter input model — no free-text user content reaches model context unsanitised. **(g) Docs refresh** — `README.md` rewritten as the canonical entry point: project tagline, one-paragraph what-it-is, feature matrix (every shipped F-row as a one-line bullet linking to its detail page under `/docs`), self-host quickstart (docker-compose), screenshots of dashboard / plan / shopping list, license. Every `/docs` subtree (`/docs/product`, `/docs/architecture`, `/docs/adr`, `/docs/security`, `/docs/perf`, `/docs/llm`, `/docs/design`) re-read and brought current with what `main` actually ships — broken links fail the docs CI. **No `Phase` / `F-XX` / `coming soon` / `TODO` markers in code comments or shipped docs** — release prep means scope is locked; any deferred work belongs in the issue tracker, not in a comment. The product spec's struck-through rows survive as historical record; new follow-up work opens a new row (F21+). This row itself never gets struck — it's the closing gate before every tag (`v1.0.0`, `v1.1.0`, …) and is re-run in full each cycle. |

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

**Parked for v1.1** — designs that are sized but intentionally not on the
phased roadmap above live in [v1.1-candidates.md](v1.1-candidates.md).
Currently parked: external-source recipe importer (TheMealDB et al.)
as a third draft kind alongside AI and ingredient-name drafts.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| AI fabricates nutrition / unknown ingredients | Deterministic validation layer recomputes all nutrition; unknown ingredients rejected or remapped. |
| No-AI experience feels empty | ~~Template composition engine generates 100+ fallback meals.~~ **Removed** in 2026-06 — the composer produced nonsense combinations; the curation queue (F18) replaces it. Hand-curated baseline (~18 anchors + Stage 1 staples) is enough to bootstrap; curated growth via F18 ships AI-drafted, human-approved additions through PR. Self-hosters who haven't enabled the curation queue still get a usable but small library; instances that run it scale to thousands. |
| Optimiser cannot satisfy tight constraints | Surfaces the gap and reports calorie/macro deltas rather than failing silently. |
| Curated DB too small | USDA FoodData Central importer extends the **ingredient** catalogue from public-domain data (Foundation Foods subset, ~340 items); the **recipe** library grows via the F18 curation queue (AI drafts → in-app human review → PR ship). The deterministic engine owns nutrition end-to-end; humans approve every row; see [ADR-0008](../adr/0008-curation-queue.md) for the AI-proposes / human-approves / PR-ships invariant. |
| Bleeding-edge dependencies break | Versions pinned + verified; ecosystem gaps recorded in [adr/](../adr/). |
| Self-host misconfiguration | `.env.example`, health checks, and [ops/deployment.md](../ops/deployment.md). |
