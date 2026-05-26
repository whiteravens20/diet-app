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
