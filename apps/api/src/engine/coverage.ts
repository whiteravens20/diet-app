// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a catalogue can serve: for every diet and every meal, how many recipes
 * a plan has to choose from. A cell at zero means no plan can be made for
 * that diet with that meal; a cell below the variety a week asks for means
 * the same dish day after day.
 *
 * Pure, and the same rule (`fitsDiet`) as the planner's own pool.
 */
import { DietType, MEAL_SLOTS_BY_COUNT, MealType, fitsDiet } from '@diet-app/shared';

/**
 * The fewest recipes the shipped catalogue may have for any diet and meal.
 * The data lint fails below it. It stands at what the catalogue has today and
 * is raised with every batch of recipes, up to `COVERAGE_TARGET`.
 */
export const COVERAGE_FLOOR = 1;
/** What a release needs in every cell: a week without the same dish twice, and room to swap. */
export const COVERAGE_TARGET = 6;

export type CoverageMatrix = Record<DietType, Record<MealType, number>>;
/** For each diet and number of meals a day: the recipes its thinnest meal can choose from. */
export type CoverageDepth = Record<DietType, Record<number, number>>;

export function recipesPerDietAndMeal(
  recipes: readonly { dietTags: readonly string[]; mealTypes: readonly string[] }[],
): CoverageMatrix {
  const matrix = {} as CoverageMatrix;
  for (const diet of DietType.options) {
    const row = {} as Record<MealType, number>;
    for (const meal of MealType.options) {
      row[meal] = recipes.filter((recipe) => recipe.mealTypes.includes(meal) && fitsDiet(recipe.dietTags, diet)).length;
    }
    matrix[diet] = row;
  }
  return matrix;
}

export function depthByMealCount(matrix: CoverageMatrix): CoverageDepth {
  const depth = {} as CoverageDepth;
  for (const diet of DietType.options) {
    depth[diet] = Object.fromEntries(
      Object.entries(MEAL_SLOTS_BY_COUNT).map(([count, meals]) => [count, Math.min(...meals.map((meal) => matrix[diet][meal]))]),
    );
  }
  return depth;
}

/** The emptiest cell among the diets that need recipes of their own; the first in a fixed order when several are as empty. */
export function thinnestCell(matrix: CoverageMatrix): { diet: DietType; meal: MealType; recipes: number } {
  let thinnest: { diet: DietType; meal: MealType; recipes: number } | null = null;
  for (const diet of DietType.options) {
    if (diet === 'custom') continue;
    for (const meal of MealType.options) {
      if (!thinnest || matrix[diet][meal] < thinnest.recipes) thinnest = { diet, meal, recipes: matrix[diet][meal] };
    }
  }
  return thinnest!;
}
