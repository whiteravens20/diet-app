// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { readCatalogue } from '../src/admin/seed/catalogue.js';
import {
  amountsPerServing,
  requirementsPerServing,
  type OptimizerRecipe,
} from '../src/engine/optimizer.js';
import { keepDaysOf, type Pack } from '../src/engine/packs.js';

type Catalogue = NonNullable<ReturnType<typeof readCatalogue>['catalogue']>;

/**
 * A catalogue as the planner reads it, for the scripts that measure what its
 * plans come to: the recipes with what a serving takes of each ingredient,
 * and the pack of every ingredient whose opened pack does not keep, with the days an opened one keeps. An
 * ingredient is known by its slug here, as it is in the data.
 */
export function plannable(catalogue: Catalogue): {
  recipes: OptimizerRecipe[];
  perishablePacks: Map<string, Pack>;
} {
  const bySlug = new Map(catalogue.ingredients.map((ingredient) => [ingredient.slug, ingredient]));
  const recipes = catalogue.recipes.map((recipe): OptimizerRecipe => {
    const lines = recipe.lines.map((line) => {
      const of = bySlug.get(line.slug)!;
      return {
        ingredientId: line.slug,
        quantity: line.quantity,
        unit: line.unit,
        ingredient: {
          canonicalUnit: of.canonicalUnit,
          gramsPerPiece: of.gramsPerPiece ?? null,
          density: of.density ?? null,
        },
      };
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
      amounts: amountsPerServing(
        requirementsPerServing({ servings: recipe.seed.servings, ingredients: lines }),
      ),
      difficulty: recipe.seed.difficulty,
      isFavorite: false,
      totalMinutes: recipe.seed.prepMinutes + recipe.seed.cookMinutes,
    };
  });
  const perishablePacks = new Map(
    catalogue.ingredients.flatMap((ingredient) =>
      ingredient.perishable && ingredient.packSize
        ? [
            [
              ingredient.slug,
              { size: ingredient.packSize, keepDays: keepDaysOf(ingredient) },
            ] as const,
          ]
        : [],
    ),
  );
  return { recipes, perishablePacks };
}

/**
 * What a plan's meals take of each ingredient on each of its `days` days, as `packUse` counts it. What a pantry
 * holds of an ingredient is taken first, from the first day on: only the rest is bought.
 */
export function dailyNeeds(
  assignments: readonly { dayIndex: number; recipeId: string; servings: number }[],
  recipes: ReadonlyMap<string, OptimizerRecipe>,
  days: number,
  pantry: ReadonlyMap<string, number> = new Map(),
): Map<string, number[]> {
  const needs = new Map<string, number[]>();
  for (const placed of assignments)
    for (const [ingredientId, perServing] of recipes.get(placed.recipeId)?.amounts ?? []) {
      let row = needs.get(ingredientId);
      if (!row) {
        row = Array.from({ length: days }, () => 0);
        needs.set(ingredientId, row);
      }
      row[placed.dayIndex]! += perServing * placed.servings;
    }
  for (const [ingredientId, held] of pantry) {
    const row = needs.get(ingredientId);
    let left = held;
    for (let day = 0; row && day < days && left > 0; day += 1) {
      const taken = Math.min(left, row[day]!);
      row[day]! -= taken;
      left -= taken;
    }
  }
  return needs;
}
