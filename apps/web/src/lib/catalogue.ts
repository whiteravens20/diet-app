// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { VARIETY_DEPTH, type CatalogueDepth, type DietType, type MealCountKey } from '@diet-app/shared';

export interface Supply {
  supply: 'none' | 'thin' | 'enough';
  /** What the meal with the fewest recipes can choose from. */
  recipes: number;
  /** The largest smaller number of meals a day the catalogue can make a plan for on this diet, or null when there is none. */
  fewerMeals: number | null;
}

/**
 * How well the catalogue serves a diet at a number of meals a day, by the meal
 * it has the fewest recipes for. `none`: that meal has no recipe, so no plan
 * can be made from the catalogue. `thin`: it has too few for a week inside the
 * default limit on repeats. Null while the catalogue's answer is not known.
 */
export function supplyOf(depth: CatalogueDepth | undefined, diet: DietType, mealCount: number): Supply | null {
  const byCount = depth?.[diet];
  const recipes = byCount?.[String(mealCount) as MealCountKey];
  if (byCount === undefined || recipes === undefined) return null;
  const fewerMeals = [4, 3, 2].find((count) => count < mealCount && byCount[String(count) as MealCountKey] > 0) ?? null;
  return { supply: recipes === 0 ? 'none' : recipes < VARIETY_DEPTH ? 'thin' : 'enough', recipes, fewerMeals };
}
