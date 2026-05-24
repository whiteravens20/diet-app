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
| F5 | Recipe library: curated anchors + template-composed fallback meals (100+). |
| F6 | Meal swap (random / favorite) and ingredient substitution with delta preview. |
| F7 | Shopping-list aggregation: merge, unit-normalise, group, "already have" deductions. |
| F8 | Ingredient-reuse optimisation across the planning window. |
| F9 | Search/filter across recipes, ingredients, favorites, plans. |
| F10 | AI provider abstraction (4 providers), per-user BYOK keys, failover. |
| F11 | Deterministic fallback for all AI-assisted features. |
| F12 | Dashboard with calorie target, macro split and plan summary. |
| F13 | **Favorite sets** — per-profile saved day-template: one favourited recipe per meal slot (e.g. *"Set 1"* = breakfast + lunch + dinner picked from favourites). Composable from the dashboard, applicable to one or more days of a plan in a single action so the user doesn't have to swap each meal individually. |
| F14 | **Internationalisation (i18n)** — every user-facing string routed through a translation layer (locale files, no inline copy); per-user language preference persisted on the account; first locales English + Polish; ingredient/recipe names localised via per-locale columns in the curated DB; units and dates formatted via `Intl`; the locale catalogue is the contract Android mirrors so both clients ship the same wording. |
| F15 | **Inventory (pantry-aware planning)** — per-profile stock of ingredients the user actually has: quantity + unit + optional best-before. Updated automatically when a shopping-list item is checked off ("bought 200 g rice → +200 g in inventory"), and editable by hand (add an impulse buy, decrement what someone ate, clear an item). Plan generation, recalculate, day-regenerate and swap then bias toward recipes the inventory can cover, scored by `coverage = covered_ingredient_mass / required_ingredient_mass`. After **N** consecutive inventory-biased generations on the same profile (default `N=5`, configurable per profile) the engine deliberately ignores the bias for one round so the menu doesn't collapse onto the same five recipes. Shopping lists subtract inventory before listing buy quantities (extends today's "already have" deduction); inventory decrements by the recipe's portion when a planned meal is marked eaten. |
| F16 | **Admin panel at `/admin`** — mirrors [archivum-null](https://github.com/whiteravens20/archivum-null)'s pattern: a separate set of admin-only routes under `/api/admin/*`, gated by HTTP Basic Auth checked against `ADMIN_USER` + `ADMIN_PASSWORD` env vars (constant-time compare, `WWW-Authenticate` challenge on 401). The panel is **disabled by default**: when `ADMIN_PASSWORD` is empty or the placeholder default, every admin route returns `403` and the `/admin` page surfaces a "set ADMIN_PASSWORD to enable" message — same fail-closed posture as archivum-null. The web client sends `Authorization: Basic …` headers on every `/api/admin/*` request (no JWT — admin is a separate identity space, not a flag on a user). Scaffold the gate, env vars, an empty `/admin` page, and one trivial endpoint (`GET /api/admin/stats` returning user/profile/plan counts) so the wiring is provable end-to-end; the actual admin surfaces (user list, ingredient/recipe curation, AI usage logs, etc.) are left to a follow-up edit of this row. |

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
fill surfaces in a follow-up), improved ingredient-reuse optimisation, richer recipe
library, analytics, exports, in-browser offline (PWA), local Ollama deployment guidance.

**Phase 3** — Android companion app, synchronisation, push notifications, offline-first
mobile experience.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| AI fabricates nutrition / unknown ingredients | Deterministic validation layer recomputes all nutrition; unknown ingredients rejected or remapped. |
| No-AI experience feels empty | Template composition engine generates 100+ fallback meals from the curated DB. |
| Optimiser cannot satisfy tight constraints | Surfaces the gap and reports calorie/macro deltas rather than failing silently. |
| Curated DB too small | USDA FoodData Central importer extends it from public-domain data. |
| Bleeding-edge dependencies break | Versions pinned + verified; ecosystem gaps recorded in [adr/](../adr/). |
| Self-host misconfiguration | `.env.example`, health checks, and [ops/deployment.md](../ops/deployment.md). |
