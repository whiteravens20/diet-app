# ADR 0007 — Curated translations are hand-authored; long-tail translations are AI

**Status:** accepted · 2026-05

## Context

F14 ships English + Polish (extensible to any locale in `packages/shared/src/settings.ts`'s
`Locale` enum). The product mixes two very different translation surfaces:

- **UI strings** in `apps/web/messages/{locale}.json` — author once per release.
- **Curated DB strings** — ingredient names + storage hints, recipe titles +
  descriptions + cooking steps. ~73 hand-curated rows.
- **USDA-imported DB strings** — ~340 (Foundation only) to ~7k (with SR Legacy)
  ingredient names, generated at runtime on each operator's instance by the USDA
  importer (`scripts/import-usda.ts`).

We need a defensible split between "translations a human wrote and reviewed" and
"translations a machine generated" — and the writer/reader/admin flows must reflect that
boundary, not blur it.

## Decision

- **UI strings** and **curated DB strings** are hand-authored, reviewed in git PRs,
  stored alongside the source in `apps/web/messages/{locale}.json` and `data/*.json`
  respectively, and bundled into the build artefact.
- **USDA-imported strings** are EN-only by default. Operators on a self-hosted instance
  can fill non-English translations via the admin panel's auto-translate action, which
  calls the `AI_DEFAULT_PROVIDER` / `AI_DEFAULT_MODEL` configured in `.env` (defaults
  to Ollama; see [`docs/ops/env-reference.md`](../ops/env-reference.md)).
- Every translation row carries a `source` (`CURATED_JSON | AI | MANUAL`) so origin is
  always answerable. The seeder's wipe-and-rewrite step only touches `CURATED_JSON`
  rows; AI / MANUAL rows survive a re-seed.

## Reasoning

In priority order:

1. **"Nutrition is never invented" extends to AI in general** ([ADR
   0005](./0005-curated-db-source-of-truth.md)). The deterministic engine owns every
   quantitative claim. We honour that by sending *only names and free-form short text*
   (ingredient name, recipe title / description / steps) to the AI translator —
   never quantities, units, enum values, allergen flags, or diet-compatibility tags.
   A translated name does not change a calorie calculation; a translated unit could.
   The runner enforces a strict whitelist of AI-translatable fields, and the
   post-validator rejects any output that introduces digits absent from the source
   (see `apps/api/src/admin/translate/validate.ts`).

2. **Curated baseline = first-impression UX; long-tail = utility.** The 18 curated
   recipes + ~55 curated ingredients are what every new user sees on day one. Their
   Polish must read like a person wrote it — cooking-step instructions especially
   carry connotation an LLM can flatten. Cost of human review per row is low
   (~73 rows). The ~340-7k USDA-imported ingredients are long-tail — most users never
   see most of them. Cost of human review per row is identical, value per row is
   dramatically lower. AI is the right cost/value trade for the long tail;
   human-reviewed git is the right one for the baseline.

3. **Self-host privacy stays intact by default.** The admin-default provider is
   Ollama, running on the operator's own hardware. The operator's ingredient
   catalogue (mostly identical to everyone else's, but still) is not shipped to a
   third party unless they explicitly set `AI_DEFAULT_PROVIDER=openai`.

4. **Provenance is preserved.** The `source` enum makes every translation row
   answerable for "where did this come from." Operators can audit, re-run, or
   manually override AI rows. If a USDA ingredient becomes commonly used, its slug
   can be PR'd into the curated repo (`data/ingredients.json`), and the AI row is
   naturally overwritten on the next seed.

5. **Determinism is preserved.** Translations affect display strings only. Two
   instances seeding the same `data/*.json` produce identical nutrition /
   shopping-list / plan output regardless of how their translation rows were
   filled. The deterministic engine never reads translated text.

6. **Reversibility.** AI translations live only in the DB. Wiping them is
   `DELETE FROM "IngredientTranslation" WHERE source = 'AI'`. The operator never
   has a JSON file polluted with AI output they didn't approve, so contributing
   back upstream doesn't require a "did this string come from a human?" audit.

## Alternatives rejected

- **All-human translations.** Doesn't scale past the curated baseline; blocks
  self-hosters who want a usable Polish UI without contributing back upstream.
- **All-AI translations including curated.** Degrades the first-impression UX and
  weakens the product's quality positioning; cooking-step instructions specifically
  lose nuance.
- **AI writes back into `data/*.json`.** Conflates "reviewed-and-shipped" data
  with "machine-generated on this instance" data; complicates the contribution
  workflow. A future per-row inline editor (parked) is the better surface for the
  upstream-contribution flow.
- **Translate at request time (per query).** Latency, cost (per-user instead of
  per-instance), inconsistency between reloads.

## Prompt + validation contract

Per `apps/api/src/admin/translate/prompt.ts` and `validate.ts`:

- **Temperature pinned low** (0.2 across all four providers) to reduce reinterpretation
  and JSON-format drift.
- **`response_format: 'json_object'`** on providers that support it; explicit "respond
  with valid JSON only" reminder otherwise.
- **Few-shot examples** per target locale anchor terminology — currently 5 PL pairs in
  `few-shot/pl.json`; adding a new locale ships a `few-shot/<code>.json` for quality.
- **Post-validator** rejects: malformed JSON, missing/extra keys, LLM yapping
  (`Note:` / `I cannot` / `As an AI`), added quotes, identical-to-source (unless
  source is a passthrough unit/number), **invented digits** (critical to the
  nutrition rule above), length blow-up (<0.4× or >3× source), English stopword
  leak into a non-English target. Failures retry once with a stricter reminder,
  then the row is skipped (counted in the run's `failed` total).

## Consequences

- The admin panel's translation-status card breaks coverage down by
  source (`CURATED_JSON` / `AI` / `MANUAL`) so it's obvious at a glance which rows
  the operator owns.
- "Adding a new locale" is a 3-step recipe (extend the `Locale` enum, drop in
  `messages/<code>.json`, hand-translate `<code>` keys in `data/*.json` for the
  curated baseline) — the admin auto-translate action handles the USDA rest
  without backend changes.
- AI translation cost is bounded to the long tail and only spent when an operator
  explicitly clicks the button. Self-hosted instances using Ollama pay nothing.
