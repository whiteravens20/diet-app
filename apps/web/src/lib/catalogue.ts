// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { CatalogueSupply, DietType, MealCountKey, Supply } from '@diet-app/shared';

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

/**
 * How well the catalogue serves a diet at a number of meals a day, as the API
 * says it. Null before the configuration has answered, and for a number of
 * meals a day nobody can have.
 */
export function supplyOf(
  supply: CatalogueSupply | undefined,
  diet: DietType,
  mealCount: number,
): Supply | null {
  return supply?.[diet]?.[String(mealCount) as MealCountKey] ?? null;
}
