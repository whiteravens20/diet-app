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

A recipe's nutrition, allergens and diets are **not** stored here. The loader
([`apps/api/src/admin/seed/catalogue.ts`](../apps/api/src/admin/seed/catalogue.ts))
works all three out from the ingredient table for every recipe: calories and macros
per serving, the allergens of its ingredients, and the diets it qualifies for.
A recipe is vegetarian, vegan or mediterranean when every one of its ingredients
lists that diet; it is low-carb when at most 26 % of its energy comes from
carbohydrate, and keto when at most 10 % does. Balanced and high-protein plans take
any recipe. A `dietTags` or `allergens` key written into a recipe is ignored.
`npm run data:lint` prints how many recipes each diet can draw on for each meal.

The recipe library is the union of `data/recipes.json` (hand-curated anchors) and
`data/recipes/*.json` (curation-queue batches approved in-app and shipped).

## Ingredients that are counted, not weighed

Nobody cooks with "110 g of egg". An ingredient with a `displayUnit` is shown,
bought and kept in the pantry in pieces of its own:

| `displayUnit` | For | In `ingredients.json` |
|---|---|---|
| `piece` | what is used whole | egg, banana, avocado, apple, orange, onion, tortilla wrap |
| `slice` | bread | whole-grain bread |
| `clove` | garlic | garlic |
| `handful` | leafy greens | spinach |

It needs a `gramsPerPiece`: the weight of one piece, slice, clove or handful.
Nutrition is still worked out from grams, and a recipe may write the line in
grams or in pieces; only what is shown changes (`2 slices`, not `80 g`). An
amount too small to be half a piece stays in grams. Vegetables sold by weight
(tomato, potato, carrot) have a `gramsPerPiece` for recipes that count them, but
no `displayUnit`: they are shown in grams. The lint refuses a `displayUnit`
without a `gramsPerPiece`.

See [docs/ops/curation-shipping.md](../docs/ops/curation-shipping.md) for how the
curation queue ships its batches.

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

The reason `SR Legacy` is the trap to avoid: the catalogue is rendered into the
recipe-draft AI prompt as the allowed-ingredient whitelist, so every brand SKU and
hyper-specific cut becomes a candidate the model has to filter past. The number
of ingredients also drives seed time — Foundation seeds in seconds, the full
SR Legacy corpus takes ~11 minutes.

If a specific worldwide staple is missing (miso, tahini, plantain, kefir,
specific European fish), add it to `ingredients.json` rather than enabling
`SR Legacy` — you keep control of the name, density, allergen flags, and
diet-compatibility tags.
