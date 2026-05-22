# Data Model

Defined in [`apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma).
PostgreSQL via Prisma 7.

## Entity groups

```
Accounts        User ─< RefreshToken
                User ─< PasswordResetToken

Profiles        User ─< Profile ─1 ProfilePreference
                Profile ─< Favorite

Curated DB      Ingredient ─< NutritionFact          (SEED DATA — source of truth)
(seed data)     Ingredient ─< SubstitutionRule >─ Ingredient
                Allergen
                Recipe ─< RecipeIngredient >─ Ingredient

Planning        Profile ─< MealPlan ─< MealPlanDay ─< PlannedMeal >─ Recipe
                MealPlan ─< ShoppingList ─< ShoppingListItem

AI / audit      User ─< AiProviderConfig
                User ─< AiUsageLog
                User ─< AuditLog
```

## Curated vs. generated data

| Stored as static seed data | Generated / user data |
|---|---|
| `Ingredient`, `NutritionFact`, `Allergen` | `User`, `Profile`, `ProfilePreference` |
| `SubstitutionRule` | `MealPlan`, `MealPlanDay`, `PlannedMeal` |
| `Recipe` (origin `seed`) — anchors + template-composed | `Recipe` (origin `ai` / `user`) |
| `RecipeIngredient` of seed recipes | `ShoppingList`, `ShoppingListItem`, `Favorite` |

The seed pipeline ([`apps/api/prisma/seed.ts`](../../apps/api/prisma/seed.ts)) loads the
curated ingredient set, **computes** every recipe's per-serving nutrition from the
ingredient table, and never stores AI-authored nutrition.

## Ingredient record

Each `Ingredient` carries: `name`, `category`, `canonicalUnit` (g/ml/piece), nutrition
per 100 canonical units (`caloriesPer100`, `proteinPer100`, `fatPer100`, `carbsPer100`),
`gramsPerPiece` and `density` for unit conversion, `allergens`, `dietCompatibility`,
`tags`, optional `packSize`, `brand`, `storageHint`. `NutritionFact` mirrors this with
explicit serving rows for auditing and alternate serving sizes.

## Nutrition is always derived

`Recipe.caloriesPerServing` (and macros) are **computed** — never authored:

```
recipeNutrition = Σ ingredients( nutritionFor(toCanonical(quantity, unit), ingredient) )
perServing      = recipeNutrition / servings
```

`toCanonical` and `nutritionFor` live in [`apps/api/src/engine/units.ts`](../../apps/api/src/engine/units.ts).
The same functions run in `seed.ts`, in AI-output validation, and in plan totals — one
implementation, one result.

## Key constraints

- `Ingredient.name` is unique (the natural key the seed upserts on).
- `SubstitutionRule` is unique per `(fromIngredientId, toIngredientId)`.
- `Favorite` is unique per `(profileId, recipeId)`.
- `AiProviderConfig.encryptedKey` holds AES-256-GCM ciphertext only — never plaintext.
- All cascade deletes flow from `User`; deleting an account removes all owned data.

## Migrations

`prisma migrate dev` (local) / `prisma migrate deploy` (CI & production). The connection
URL is supplied via `prisma.config.ts` (Prisma 7 — no `url` in the schema). See
[adr/0003-prisma7-driver-adapter.md](../adr/0003-prisma7-driver-adapter.md).
