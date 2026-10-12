// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { readCatalogue } from '../src/admin/seed/catalogue.js';
import { amountsPerServing, requirementsPerServing, type OptimizerRecipe } from '../src/engine/optimizer.js';

type Catalogue = NonNullable<ReturnType<typeof readCatalogue>['catalogue']>;

/**
 * A catalogue as the planner reads it, for the scripts that measure what its
 * plans come to: the recipes with what a serving takes of each ingredient,
 * and the pack of every ingredient whose opened pack does not keep. An
 * ingredient is known by its slug here, as it is in the data.
 */
export function plannable(catalogue: Catalogue): { recipes: OptimizerRecipe[]; perishablePacks: Map<string, number> } {
  const bySlug = new Map(catalogue.ingredients.map((ingredient) => [ingredient.slug, ingredient]));
  const recipes = catalogue.recipes.map((recipe): OptimizerRecipe => {
    const lines = recipe.lines.map((line) => {
      const of = bySlug.get(line.slug)!;
      return { ingredientId: line.slug, quantity: line.quantity, unit: line.unit, ingredient: { canonicalUnit: of.canonicalUnit, gramsPerPiece: of.gramsPerPiece ?? null, density: of.density ?? null } };
    });
    return {
      id: recipe.slug,
      mealTypes: recipe.seed.mealTypes,
      dietTags: recipe.dietTags,
      caloriesPerServing: recipe.nutrition.calories,
      proteinPerServing: recipe.nutrition.protein,
      fatPerServing: recipe.nutrition.fat,
      carbsPerServing: recipe.nutrition.carbs,
      ingredientIds: recipe.lines.map((line) => line.slug),
      amounts: amountsPerServing(requirementsPerServing({ servings: recipe.seed.servings, ingredients: lines })),
      difficulty: recipe.seed.difficulty,
      isFavorite: false,
      totalMinutes: recipe.seed.prepMinutes + recipe.seed.cookMinutes,
    };
  });
  const perishablePacks = new Map(catalogue.ingredients.flatMap((ingredient) => (ingredient.perishable && ingredient.packSize ? [[ingredient.slug, ingredient.packSize] as const] : [])));
  return { recipes, perishablePacks };
}
