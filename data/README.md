# Curated seed data

The source of truth for nutrition. Loaded into the database by the catalogue
update of the administrator's panel, or by `npm run db:seed`
([`apps/api/prisma/seed.ts`](../apps/api/prisma/seed.ts)); both read and check
the files the same way ([`apps/api/src/admin/seed/`](../apps/api/src/admin/seed/)).

| File | Role |
|---|---|
| `ingredients.json` | Hand-curated whole-food ingredients (the committed baseline). |
| `ingredients.generated.json` | Written by `npm run import:usda` — paginates the USDA FDC search API across the configured `FDC_DATA_TYPES` (default `Foundation`), maps every food into a `IngredientSeed` row, and clamps measurement-noise negative carbs to zero. Merged on top of the baseline; the baseline wins on a name clash. |
| `recipes.json` | Hand-curated "anchor" recipes. |
| `substitutions.json` | Ingredient substitution rules. |
| `import-aliases.json` | Other names of the ingredients, for recipes taken in from elsewhere. No part of the catalogue: see "Recipes from elsewhere". |

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
`npm run data:lint` prints how many recipes each diet can draw on for each meal,
and fails when a diet has fewer for a meal than the floor in
[`apps/api/src/engine/coverage.ts`](../apps/api/src/engine/coverage.ts) (1 today,
to rise with the catalogue). It also refuses two recipes of the same making: the
same ingredients and amounts, for the same meals and servings, under two names.

Every diet aims at a split of a day's energy between protein, fat and
carbohydrate, and the planner chooses recipes for it. How near a plan comes
depends on what there is to choose from, so the lint also prints, for each diet,
that split and what a week's plan reaches with the recipes here, and warns when
the two are more than ten points of energy apart: such a diet needs recipes
nearer its split, and no setting makes up for them. The weight the planner gives
the split was chosen with
[`apps/api/scripts/tune-macro-weight.ts`](../apps/api/scripts/tune-macro-weight.ts),
which prints what each weight does to the plans of every diet; run it again when
the catalogue has grown.

The recipe library is the union of `data/recipes.json` (hand-curated anchors) and
`data/recipes/*.json` (curation-queue batches approved in-app and shipped).

## An ingredient is given as it is bought

The figures of an ingredient are for 100 g (or 100 ml) of the food as it is
bought, because that is what a recipe weighs and what a shopping list buys.
Rice, pasta, quinoa, couscous and lentils are dry: about 360 kcal in 100 g, from
USDA FoodData Central. The cooked food holds about a third of that, and figures
taken from a "cooked" row would give every dish made of it a third of its
energy. Canned beans and chickpeas are given as they come out of the can.

What is poured is measured in millilitres (milk, an oil), and its
figures are for 100 ml: those of 100 g times its `density`, the weight of one
millilitre in grams. A litre of oil weighs about 920 g, so 100 ml of it hold 92 g
of fat and not 100. The `density` is also what a recipe that weighs such an
ingredient in grams is converted with.

`npm run data:lint` refuses a grain or a pulse that keeps in its pack and holds
under 300 kcal in 100 g. One that keeps and is not dry (frozen edamame) is named
in [`apps/api/src/admin/seed/dry-staples.ts`](../apps/api/src/admin/seed/dry-staples.ts)
with what it is.

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

## Packs

`packSize` is what one buys of an ingredient at a time, in its canonical unit:
500 for a tray of chicken, 550 for a carton of ten eggs, 1000 for a litre of
milk. A shopping list says how many packs a row takes, and whoever buys them
has the rest in the pantry. What is sold loose or by weight (tomato, potato,
apple, garlic) has no `packSize`.

`perishable: true` marks a pack that does not keep once it is opened: meat,
fish, dairy, bread, tofu, a punnet of berries, a head of broccoli, an opened
tin. What a plan leaves of such a pack is what it wastes, so the planner leans
towards meals that use an opened pack up, and a plan says what it buys of these
packs against what it uses. A pack used to seven tenths counts as used: what is
left of it is no reason for another meal. Rice, pasta, oil, nuts and eggs keep,
and are left unmarked. The lint refuses `perishable` without a `packSize`.

The lint prints, for each diet, how much of these packs a week's plan uses. The
weight the planner gives them was chosen with
[`apps/api/scripts/tune-pack-weight.ts`](../apps/api/scripts/tune-pack-weight.ts),
which prints what each weight does to the packs, to the split and to the variety
of the plans of every diet; run it again when the catalogue has grown.

See [docs/ops/curation-shipping.md](../docs/ops/curation-shipping.md) for how the
curation queue ships its batches.

## Recipes from elsewhere

A recipe that was taken in from somewhere else says so:

```json
"source": { "url": "https://recipes.example/salmon-rice-bowl", "license": "https://creativecommons.org/licenses/by/4.0/" }
```

`license` is the licence the recipe may be passed on under, by its address or
its name; `url`, when there is one, begins with `http://` or `https://`. Both
are shown with the recipe wherever it is read. A recipe written here has no
`source`. The curation queue writes the key for a draft that came from an
import; nothing else needs to.

`import-aliases.json` is what an import goes by when a recipe calls an
ingredient something the catalogue does not:

```json
{ "courgette": "zucchini", "prawns": "shrimp" }
```

A name on the left is matched in full, in a plain form: lower case, one of a
thing, without the words that say how it is cut or how big it is ("2 large
ripe courgettes, sliced" is `courgette`). The slug on the right has to be an
ingredient of the catalogue; `npm run data:lint` refuses the file otherwise.
Write down a name only when it is the same food: "dried apricots" are not
`apricot`, and "milk" is not `whole-milk`. A recipe whose ingredient is still
not known after that is refused by the import, with the name it did not know.
The file changes no recipe that exists and is not read by a database update.

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
