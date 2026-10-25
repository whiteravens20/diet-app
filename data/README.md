# Curated seed data

The source of truth for nutrition. Loaded into the database by the catalogue
update of the administrator's panel, or by `npm run db:seed`
([`apps/api/prisma/seed.ts`](../apps/api/prisma/seed.ts)); both read and check
the files the same way ([`apps/api/src/admin/seed/`](../apps/api/src/admin/seed/)).

| File                         | Role                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingredients.json`           | Hand-curated whole-food ingredients (the committed baseline).                                                                                                                                                                                                                                                                                                                                                           |
| `ingredients.generated.json` | Written by `npm run import:usda` — paginates the USDA FDC search API across the configured `FDC_DATA_TYPES` (default `Foundation`), maps every food into a `IngredientSeed` row, and clamps measurement-noise negative carbs to zero. Merged on top of the baseline; the baseline wins on a name clash, and a food that a curated ingredient names in `importedAs` is left out (see "Foods the catalogue already has"). |
| `recipes.json`               | Hand-curated "anchor" recipes.                                                                                                                                                                                                                                                                                                                                                                                          |
| `recipes/*.json`             | Batches of recipes that were approved in the curation queue and shipped, one file a batch.                                                                                                                                                                                                                                                                                                                              |
| `ingredient-overrides.json`  | Names of ingredients in other languages that were approved in the curation queue: the Polish names of the foods a `Foundation` import brings. An instance without those foods leaves them unused.                                                                                                                                                                                                                       |
| `substitutions.json`         | Ingredient substitution rules.                                                                                                                                                                                                                                                                                                                                                                                          |
| `import-aliases.json`        | Other names of the ingredients, for recipes taken in from elsewhere. No part of the catalogue: see "Recipes from elsewhere".                                                                                                                                                                                                                                                                                            |

Run `npm run data:lint` to validate every row against the Zod schemas in
[`apps/api/scripts/validate-data.ts`](../apps/api/scripts/validate-data.ts) — it
also runs on every push (CI `api` job), so a bad hand edit or a malformed
import is caught before it reaches the seeder.

A recipe's nutrition, allergens and diets are **not** stored here. The loader
([`apps/api/src/admin/seed/catalogue.ts`](../apps/api/src/admin/seed/catalogue.ts))
works all three out from the ingredient table for every recipe: calories and macros
per serving, the allergens of its ingredients, and the diets it qualifies for.
A recipe is vegetarian, vegan or mediterranean when every one of its ingredients
lists that diet; it is low-carb when under 26 % of its energy comes from
carbohydrate, and keto when under 10 % does. Those are the limits of the nutrition
literature, about 130 g and 50 g of carbohydrate a day at 2,000 kcal (Feinman et
al., _Nutrition_ 31, 2015). Balanced and high-protein plans take any recipe. A
`dietTags` or `allergens` key written into a recipe is ignored.
`npm run data:lint` prints how many recipes each diet can draw on for each meal,
and fails when a diet has fewer than six for a meal: a week without the same dish
twice, and room to swap
([`apps/api/src/engine/coverage.ts`](../apps/api/src/engine/coverage.ts)). It also refuses two recipes of the same making: the
same ingredients and amounts, for the same meals and servings, under two names;
and a recipe whose English text tells another dish than its list holds: a title,
a description or a step that names an ingredient the list lacks ("a pinch of
salt" without salt), or an ingredient of the list that no step uses.

Every diet aims at a split of a day's energy between protein, fat and
carbohydrate, and the planner chooses recipes for it. How near a plan comes
depends on what there is to choose from, so the lint also prints, for each diet,
that split and what a week's plan reaches with the recipes here, and warns when
the two are more than ten points of energy apart: such a diet needs recipes
nearer its split, and no setting makes up for them. A low-carb day aims at a
fifth of its energy from carbohydrate, three tenths from protein and half from
fat: inside the limit above with room on both sides, and with protein inside the
10 to 35 % that the reference intakes give for it. A high-protein day stands at
the top of that range, 35 %, with three tenths from fat. The splits are in
[`apps/api/src/engine/nutrition.ts`](../apps/api/src/engine/nutrition.ts). The weight the planner gives
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
energy. Canned beans, chickpeas and tuna are given as they come out of the can,
drained, and frozen edamame as it is in the bag.
Meat, fish and shellfish are raw: a chicken breast holds 120 kcal and 22.5 g of
protein in 100 g as it is bought, and 165 kcal and 31 g once it is roasted,
because the pan drives water out of it while a recipe weighs it before.

What is poured is measured in millilitres (milk, an oil, soy sauce), and its
figures are for 100 ml: those of 100 g times its `density`, the weight of one
millilitre in grams. A litre of oil weighs about 920 g, so 100 ml of it hold 92 g
of fat and not 100. The `density` is also what a recipe that weighs such an
ingredient in grams is converted with.

`npm run data:lint` refuses a grain or a pulse that keeps in its pack and holds
under 300 kcal in 100 g. One that keeps and is not dry (frozen edamame) is named
in [`apps/api/src/admin/seed/dry-staples.ts`](../apps/api/src/admin/seed/dry-staples.ts)
with what it is. It also refuses meat or fish sold in a pack that holds more than
25 g of protein in 100 g, which raw meat does not
([`apps/api/src/admin/seed/raw-meat.ts`](../apps/api/src/admin/seed/raw-meat.ts)).

## What a model drafted

109 of the recipes (the two files of `recipes/`: seventy of 2026-10-13, and
thirty-nine vegan and keto dishes of 2026-10-14) and the Polish names of the
imported foods (`ingredient-overrides.json`) were drafted by language models
inside the application and shipped through its curation queue.

- The recipes were written by `openai/gpt-6-luna`, in English and Polish, from
  the ingredients of `ingredients.json` alone, and held to the generator's rules
  by its validator. Their figures, allergens and diets are worked out by the
  engine, as those of every recipe are.
- The names were written by `google/gemini-3.1-flash-lite` for the foods a
  `Foundation` import gave on 2026-10-13, and by `openai/gpt-6-luna` for the six
  fats an import has given besides since it takes fats. 272 ship: one for every
  food of an import that the catalogue does not hold already.
- Every recipe was reviewed in both languages, and every name against the
  description of its food, before it was approved; what the review found was
  corrected first, in 43 of the 109 recipes and in 44 of the 272 names.

## Where the figures are from

The figures of the ingredients below are those of
[USDA FoodData Central](https://fdc.nal.usda.gov/), of its SR Legacy data set
(canned black beans of its Foundation set, which has them drained), each by the
id of its food there. What is measured in millilitres was worked
out from the figures of 100 g and from what the database says a cup of the food
weighs; the weight of a lemon, of a lime and of a slice of rye bread are the
database's as well.

| Ingredient            | FDC id  | The food in the database                                                      |
| --------------------- | ------- | ----------------------------------------------------------------------------- |
| `chicken-breast`      | 171077  | Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw        |
| `turkey-breast`       | 174515  | Turkey, retail parts, breast, meat only, raw                                  |
| `ground-beef`         | 171796  | Beef, ground, 85% lean meat / 15% fat, raw                                    |
| `shrimp`              | 175179  | Crustaceans, shrimp, raw                                                      |
| `canned-tuna`         | 173709  | Fish, tuna, light, canned in water, drained solids                            |
| `chickpeas`           | 173800  | Chickpeas (garbanzo beans, bengal gram), mature seeds, canned, drained solids |
| `kidney-beans`        | 174285  | Beans, kidney, red, mature seeds, canned, drained solids                      |
| `black-beans`         | 2644285 | Beans, black, canned, sodium added, drained and rinsed                        |
| `edamame`             | 168410  | Edamame, frozen, unprepared                                                   |
| `tofu`                | 172475  | Tofu, raw, firm, prepared with calcium sulfate                                |
| `whole-milk`          | 171265  | Milk, whole, 3.25% milkfat, with added vitamin D                              |
| `olive-oil`           | 171413  | Oil, olive, salad or cooking                                                  |
| `coconut-oil`         | 171412  | Oil, coconut                                                                  |
| `lemon`               | 167746  | Lemons, raw, without peel                                                     |
| `lime`                | 168155  | Limes, raw                                                                    |
| `salt`                | 173468  | Salt, table                                                                   |
| `black-pepper`        | 170931  | Spices, pepper, black                                                         |
| `apple-cider-vinegar` | 173469  | Vinegar, cider                                                                |
| `soy-sauce`           | 174277  | Soy sauce made from soy and wheat (shoyu)                                     |
| `parsley`             | 170416  | Parsley, fresh                                                                |
| `basil`               | 172232  | Basil, fresh                                                                  |
| `dill`                | 172233  | Dill weed, fresh                                                              |
| `dried-oregano`       | 171328  | Spices, oregano, dried                                                        |
| `paprika`             | 171329  | Spices, paprika                                                               |
| `cinnamon`            | 171320  | Spices, cinnamon, ground                                                      |
| `ginger`              | 169231  | Ginger root, raw                                                              |
| `sour-cream`          | 171257  | Cream, sour, cultured                                                         |
| `heavy-cream`         | 170859  | Cream, fluid, heavy whipping                                                  |
| `kefir`               | 170904  | Kefir, lowfat, plain, LIFEWAY                                                 |
| `gouda-cheese`        | 171241  | Cheese, gouda                                                                 |
| `rapeseed-oil`        | 172336  | Oil, canola                                                                   |
| `sunflower-oil`       | 171025  | Oil, sunflower, linoleic, (approx. 65%)                                       |
| `cocoa-powder`        | 169593  | Cocoa, dry powder, unsweetened                                                |
| `coconut-milk`        | 170173  | Nuts, coconut milk, canned (liquid expressed from grated meat and water)      |
| `rye-bread`           | 172684  | Bread, rye                                                                    |
| `buckwheat-groats`    | 170685  | Buckwheat groats, roasted, dry                                                |
| `millet`              | 169702  | Millet, raw                                                                   |
| `raisins`             | 168165  | Raisins, dark, seedless (Includes foods for USDA's Food Distribution Program) |
| `herring-fillet`      | 175116  | Fish, herring, Atlantic, raw                                                  |
| `mackerel-fillet`     | 175119  | Fish, mackerel, Atlantic, raw                                                 |
| `trout-fillet`        | 173717  | Fish, trout, rainbow, farmed, raw                                             |
| `smoked-salmon`       | 173687  | Fish, salmon, chinook, smoked                                                 |
| `pork-tenderloin`     | 168249  | Pork, fresh, loin, tenderloin, separable lean only, raw                       |
| `chicken-thigh`       | 172385  | Chicken, broilers or fryers, thigh, meat and skin, raw                        |
| `bacon`               | 168277  | Pork, cured, bacon, unprepared                                                |
| `black-olives`        | 169094  | Olives, ripe, canned (small-extra large)                                      |
| `romaine-lettuce`     | 169247  | Lettuce, cos or romaine, raw                                                  |
| `canned-tomatoes`     | 170051  | Tomatoes, red, ripe, canned, packed in tomato juice                           |
| `pumpkin-seeds`       | 170556  | Seeds, pumpkin and squash seed kernels, dried                                 |

Curd cheese (`curd-cheese`, twaróg półtłusty) is not in that database. Its
figures are those of the Polish tables of the composition of food, as the
National Centre for Nutrition Education prints them
([Przetwory mleczne](https://ncez.pzh.gov.pl/abc-zywienia/przetwory-mleczne-co-wybierac-czego-unikac/);
Kunachowicz H., Nadolna I., Przygoda B., Iwanow K., _Wartość odżywcza wybranych
produktów spożywczych i typowych potraw_, PZWL, Warszawa 2012).

## Ingredients that are counted, not weighed

Nobody cooks with "110 g of egg". An ingredient with a `displayUnit` is shown,
bought and kept in the pantry in pieces of its own:

| `displayUnit` | For                | In `ingredients.json`                                                  |
| ------------- | ------------------ | ---------------------------------------------------------------------- |
| `piece`       | what is used whole | egg, banana, avocado, apple, orange, lemon, lime, onion, tortilla wrap |
| `slice`       | bread              | whole-grain bread, rye bread                                           |
| `clove`       | garlic             | garlic                                                                 |
| `handful`     | leafy greens       | spinach                                                                |

It needs a `gramsPerPiece`: the weight of one piece, slice, clove or handful.
Nutrition is still worked out from grams, and a recipe may write the line in
grams or in pieces; only what is shown changes (`2 slices`, not `80 g`). An
amount too small to be half a piece stays in grams. Vegetables sold by weight
(tomato, potato, carrot) have a `gramsPerPiece` for recipes that count them, but
no `displayUnit`: they are shown in grams. The lint refuses a `displayUnit`
without a `gramsPerPiece`.

## Ingredients measured with a teaspoon

Nobody weighs out 2 g of paprika either. An ingredient with a `perTeaspoon` is
shown in teaspoons in a recipe and a planned meal: a quarter or a half of one,
then whole ones to the nearest half, up to four; below a quarter of a teaspoon a
dry one is shown in pinches, a sixteenth of a teaspoon each, and more than four
teaspoons by weight or volume. `perTeaspoon` is how much a level teaspoon holds in
the canonical unit, from the household measures of USDA SR Legacy:

| Ingredient              | `perTeaspoon` | SR Legacy                                    |
| ----------------------- | ------------- | -------------------------------------------- |
| salt                    | 6 g           | Salt, table: 1 tsp = 6 g                     |
| black pepper            | 2.3 g         | Spices, pepper, black: 1 tsp, ground = 2.3 g |
| paprika                 | 2.3 g         | Spices, paprika: 1 tsp = 2.3 g               |
| cinnamon                | 2.6 g         | Spices, cinnamon, ground: 1 tsp = 2.6 g      |
| dried oregano           | 1 g           | Spices, oregano, dried: 1 tsp, leaves = 1 g  |
| lemon juice, lime juice | 5 ml          | a teaspoon of 5 ml                           |

Nutrition, the shopping list and the pantry go on by weight or volume. The lint
refuses a `perTeaspoon` on what is counted in pieces.

Lemon and lime juice are ingredients of their own (SR Legacy "Lemon juice, raw"
and "Lime juice, raw", per 100 ml with their density): a recipe that uses only
the juice of the fruit names the juice, in millilitres; a recipe that grates the
zest as well keeps the fruit.

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
packs against what it uses. A pack used to four fifths counts as used: what is
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

| dataType                   | Size   | What you get                                                                                                                                                                                                                                                                                              | Use it?                           |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **`Foundation`** (default) | ~330   | Clean generic names — `Beef, ground, raw`, `Spinach, raw`. USDA's modern curated subset.                                                                                                                                                                                                                  | **Yes.**                          |
| `SR Legacy`                | ~7 000 | The retired (2019) Standard Reference release. Dominated by brand SKUs (`HERSHEY'S POT OF GOLD Almond Bar`, `Cereals ready-to-eat, POST, Shredded Wheat`) and hyper-specific cuts (`Beef, New Zealand, imported, brisket point end, separable lean and fat, trimmed to 0" fat, choice, cooked, grilled`). | **No, unless you have a reason.** |
| `Branded`                  | ~1.5 M | Entirely brand-name packaged products.                                                                                                                                                                                                                                                                    | No — not a whole-food source.     |
| `Survey (FNDDS)`           | ~7 000 | Composed meals / mixed dishes for dietary recall surveys, not ingredients.                                                                                                                                                                                                                                | No.                               |

The reason `SR Legacy` is the trap to avoid: the catalogue is rendered into the
recipe-draft AI prompt as the allowed-ingredient whitelist, so every brand SKU and
hyper-specific cut becomes a candidate the model has to filter past. The number
of ingredients also drives seed time — Foundation seeds in seconds, the full
SR Legacy corpus takes ~11 minutes.

### What an import leaves out

A food whose record lacks protein, fat or carbohydrate is left out and named in
the report of the run: stored as zero, the missing one would make every recipe
that uses the food wrong. About sixty of the four hundred foods of the
`Foundation` set are left out so: records that hold no figures yet (bread,
pasta, raisins) and fruit and vegetables without their carbohydrate.

A fat is taken all the same. The set reports an oil's fat and nothing else, and
butter's fat and water, because there is next to nothing else in them; what is
fat for four fifths of its weight or more is taken with no protein and no
carbohydrate where its record names none. An oil's row then holds the fat of a
nutrition label, 93 to 95 g in 100 g: a few per cent under what the bottle
holds, which is all fat.

### Foods the catalogue already has

An import brings foods the curated file has under a name of its own: raw
chicken breast, strawberries, white rice. Left as two rows they are two foods to
the pantry, to a shopping list and to a plan, each with figures of its own. A
curated ingredient therefore names the rows of an import that are the same food,
by their slugs:

```json
{ "slug": "strawberries", "importedAs": ["strawberries-raw"] }
```

The catalogue leaves those rows out, and a recipe that names one of them means
the curated ingredient. Name a food only when it is the same in the form the
curated row describes: raw for raw, canned for canned. A variety (Fuji apples),
another cut (a chicken breast with its skin) or another fat level (milk at 2 %)
is a food of its own. `npm run data:lint` says how many foods of an import were
left out so, and refuses a name that is an ingredient of the curated file or
that two of them claim.

If a specific worldwide staple is missing (miso, tahini, plantain, kefir,
specific European fish), add it to `ingredients.json` rather than enabling
`SR Legacy` — you keep control of the name, density, allergen flags, and
diet-compatibility tags.
