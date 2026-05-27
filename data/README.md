# Curated seed data

The source of truth for nutrition. Loaded by
[`apps/api/prisma/seed.ts`](../apps/api/prisma/seed.ts).

| File | Role |
|---|---|
| `ingredients.json` | Hand-curated whole-food ingredients (the committed baseline). |
| `ingredients.generated.json` | Written by `npm run import:usda` — paginates the USDA FDC search API across the configured `FDC_DATA_TYPES` (default `Foundation`), maps every food into a `IngredientSeed` row, and clamps measurement-noise negative carbs to zero. Merged on top of the baseline; the baseline wins on a name clash. |
| `recipes.json` | Hand-curated "anchor" recipes. |
| `substitutions.json` | Ingredient substitution rules. |

Run `npm run data:lint` to validate every row against the Zod schemas in
[`apps/api/scripts/validate-data.ts`](../apps/api/scripts/validate-data.ts) — it
also runs on every push (CI `api` job), so a bad hand edit or a malformed
import is caught before it reaches the seeder.

Recipe nutrition is **not** stored here — `seed.ts` computes every recipe's per-serving
calories and macros from the ingredient table. The bulk of the recipe library is
generated deterministically at seed time by the template composition engine
([`apps/api/src/engine/recipe-templates.ts`](../apps/api/src/engine/recipe-templates.ts)).

See [docs/adr/0006-fallback-recipe-strategy.md](../docs/adr/0006-fallback-recipe-strategy.md).

## Choosing `FDC_DATA_TYPES`

The importer defaults to `Foundation` because that's the only FDC dataset
that's a good fit for a generic, worldwide meal planner. The other dataTypes
are documented here mostly so the choice doesn't get re-litigated:

| dataType | Size | What you get | Use it? |
|---|---|---|---|
| **`Foundation`** (default) | ~340 | Clean generic names — `Beef, ground, raw`, `Spinach, raw`. USDA's modern curated subset. | **Yes.** |
| `SR Legacy` | ~7 000 | The retired (2019) Standard Reference release. Dominated by brand SKUs (`HERSHEY'S POT OF GOLD Almond Bar`, `Cereals ready-to-eat, POST, Shredded Wheat`) and hyper-specific cuts (`Beef, New Zealand, imported, brisket point end, separable lean and fat, trimmed to 0" fat, choice, cooked, grilled`). | **No, unless you have a reason.** |
| `Branded` | ~1.5 M | Entirely brand-name packaged products. | No — not a whole-food source. |
| `Survey (FNDDS)` | ~7 000 | Composed meals / mixed dishes for dietary recall surveys, not ingredients. | No. |

The reason `SR Legacy` is the trap to avoid: the recipe library is generated
by [`composeRecipes`](../apps/api/src/engine/recipe-templates.ts) as
`templates × hero ingredients`, so every junk ingredient becomes the hero of
several nonsense recipes ("Pan-seared HERSHEY'S bar with kale"). The number
of ingredients also drives seed time — Foundation seeds in seconds, the full
SR Legacy corpus takes ~11 minutes.

If a specific worldwide staple is missing (miso, tahini, plantain, kefir,
specific European fish), add it to `ingredients.json` rather than enabling
`SR Legacy` — you keep control of the name, density, allergen flags, and
diet-compatibility tags.
