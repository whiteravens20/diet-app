# Deterministic Algorithms

All in [`apps/api/src/engine`](../../apps/api/src/engine) — pure, unit-tested functions.
Same input → same output, always.

## 1. Calorie & macro engine (`nutrition.ts`)

```
BMR  = 10·kg + 6.25·cm − 5·age + sexOffset      (Mifflin-St Jeor)
       sexOffset = +5 male | −161 female | −78 unknown (unbiased midpoint)
TDEE = BMR × activityMultiplier                 (1.2 … 1.9)
deficit = weeklyLossKg × 7700 / 7               (1 kg fat ≈ 7700 kcal)
target  = manualOverride ?? max(TDEE − deficit, safetyFloor)
          safetyFloor = 1500 male | 1200 otherwise
macros  = split(target, dietType)               (per-diet protein/fat/carb %)
```

A manual override always wins and is tagged `manual_override`; otherwise `calculated`.
`safetyFloorApplied` flags clamped aggressive deficits.

## 2. Unit conversion (`units.ts`)

The database stores nutrition per 100 canonical units. `toCanonical(qty, unit,
ingredient)` converts any recipe quantity to the ingredient's canonical unit using
`gramsPerPiece` (piece↔mass) and `density` (g↔ml). A missing conversion factor throws —
the system never guesses. `nutritionFor(canonicalQty, per100)` scales nutrition linearly.

## 3. Meal-plan optimiser (`optimizer.ts`)

Greedy slot-filling with a multi-factor score, deterministic for a fixed `seed`:

```
for each day, for each meal slot:
    budget   = slotWeight · dailyTarget        (breakfast .25, lunch .35, …)
    score(r) = 0.45·calorieFit + 0.25·ingredientReuse + 0.15·variety
             + 0.10·favorite − 0.05·complexity + seededJitter(r, seed)
    pick the highest-scoring eligible recipe; servings quantised to ¼
```

- **calorieFit** — closeness of `servings · caloriesPerServing` to the slot budget.
- **ingredientReuse** — share of the recipe's ingredients already used in the plan
  (drives the waste-reduction goal).
- **variety** — penalises recipes used in the last 3 days.
- **favorite / complexity** — favorite bonus; `mealPrepFriendly` penalises hard recipes.
- **seededJitter** — deterministic per `(recipeId, seed)`; "regenerate" passes a new seed
  to explore alternative near-optimal plans without losing reproducibility.

`ingredientReuseScore` (0–1) reports the share of plan ingredients used in >1 recipe.

## 4. Recipe-template composition (`recipe-templates.ts`)

The no-AI fallback library. A handful of structural **templates** (e.g. "protein + grain
+ vegetable bowl", "breakfast bowl", "low-carb skillet") are filled from the curated
ingredient database: one recipe per `(template, hero ingredient)`, with a few variants
rotating the supporting cast. From ~55 curated ingredients this yields 100+ valid,
diet-tagged recipes. Each recipe's nutrition is then computed deterministically by the
seed pipeline. Fully reproducible — same database, same library.

## 5. Shopping-list aggregation (`shopping.ts`)

```
for each planned meal, for each recipe ingredient:
    scale     = plannedServings / recipeServings
    canonical = toCanonical(quantity · scale, unit, ingredient)
    accumulate per ingredientId
group by category; toBuy = max(0, total − alreadyHave)
```

Duplicate ingredients across recipes merge into one line; units normalise to canonical;
items group into aisle categories in a fixed display order.

## 6. Ingredient substitution (`substitution.ts`)

```
fromCanonical = toCanonical(quantity, unit, fromIngredient)
originalKcal  = nutritionFor(fromCanonical, fromIngredient).calories
toQuantity    = originalKcal / toIngredient.caloriesPer100 · 100   (calorie-preserving)
```

Returns before/after nutrition, the calorie + macro deltas, the adjusted quantity, and a
plain-language explanation. `constraintViolations()` rejects swaps that introduce an
allergen, use an excluded ingredient, or break the diet type — an invalid swap is
returned with `valid: false`, never applied silently.
