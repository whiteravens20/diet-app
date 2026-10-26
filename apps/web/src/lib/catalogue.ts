// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { CatalogueDepth, DietType, MealCountKey } from '@diet-app/shared';
import { VARIETY_DEPTH } from '@diet-app/shared/constants';

/**
 * The diets that have a split of protein, fat and carbohydrate of their own.
 * The contract knows one more, `custom`, whose split is the profile's to say:
 * a form offers it where there is such a split, or a place to say one.
 */
export const NAMED_DIETS: readonly DietType[] = [
  'balanced',
  'high_protein',
  'low_carb',
  'vegetarian',
  'vegan',
  'keto',
  'mediterranean',
];

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
export function supplyOf(
  depth: CatalogueDepth | undefined,
  diet: DietType,
  mealCount: number,
): Supply | null {
  const byCount = depth?.[diet];
  const recipes = byCount?.[String(mealCount) as MealCountKey];
  if (byCount === undefined || recipes === undefined) return null;
  const fewerMeals =
    [4, 3, 2].find((count) => count < mealCount && byCount[String(count) as MealCountKey] > 0) ??
    null;
  return {
    supply: recipes === 0 ? 'none' : recipes < VARIETY_DEPTH ? 'thin' : 'enough',
    recipes,
    fewerMeals,
  };
}
