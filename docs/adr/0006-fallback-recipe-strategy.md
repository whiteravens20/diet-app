# ADR 0006 — USDA importer + template composition

**Status:** superseded in part by [ADR-0008](0008-curation-queue.md) · 2026-05

> **Note (2026-05).** The "template composition for the no-AI fallback"
> half of this decision is superseded: the composer produced semantically
> nonsense combinations and is disabled by default behind
> `RECIPE_COMPOSER_ENABLED=false`. The curation queue (F18) replaces it.
> The "USDA Foundation Foods importer for the ingredient catalogue" half
> stands unchanged.

## Context

Two needs: a broad, trustworthy nutrition database, and a no-AI fallback library of 100+
meals so the deterministic engine can plan for every diet type and meal slot.

## Decision

**Nutrition database** — a curated baseline (`data/ingredients.json`, hand-authored
whole foods) plus a build-time importer (`apps/api/scripts/import-usda.ts`) that pulls
from **USDA FoodData Central** (Foundation + SR Legacy — public-domain, redistributable)
into `data/ingredients.generated.json`. The seed merges both, curated winning on a name
clash. Branded/noisy data is deliberately excluded.

**Fallback meals** — a hybrid: ~18 hand-curated "anchor" recipes plus a deterministic
**recipe-template composition engine** (`recipe-templates.ts`). Structural templates
("protein + grain + vegetable bowl", etc.) are filled from the curated database, yielding
100+ valid, diet-tagged recipes. Nutrition is computed by the seed pipeline.

## Rationale

- USDA FDC is authoritative and legally clean — no invented nutrition, no licensing risk.
- Template composition gives breadth without hand-authoring hundreds of recipes, and is
  fully reproducible (same database → same library). It matches the brief's "recipe
  templates + database-driven composition".

## Consequences

- The importer needs network + an `FDC_API_KEY` (or `DEMO_KEY`); it is a build-time tool,
  not a runtime dependency. The committed curated baseline keeps the app working offline.
- Composed recipes are functional but formulaic; anchor recipes provide hand-crafted
  variety. Phase 2 expands the anchor set.
