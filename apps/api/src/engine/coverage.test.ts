// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { depthByMealCount, recipesPerDietAndMeal, thinnestCell } from './coverage.js';

const recipe = (mealTypes: string[], dietTags: string[] = []) => ({ mealTypes, dietTags });

describe('how many recipes each diet has for each meal', () => {
  const catalogue = [
    recipe(['breakfast'], ['vegetarian', 'vegan']),
    recipe(['breakfast'], ['vegetarian']),
    recipe(['lunch', 'dinner'], ['vegan', 'vegetarian', 'mediterranean']),
    recipe(['lunch', 'dinner']),
    recipe(['dinner'], ['keto', 'low_carb']),
    recipe(['snack'], ['vegetarian']),
  ];
  const matrix = recipesPerDietAndMeal(catalogue);

  it('counts a recipe for every meal it is for, under every diet it suits', () => {
    expect(matrix.vegan).toEqual({ breakfast: 1, lunch: 1, dinner: 1, snack: 0, second_breakfast: 0 });
    expect(matrix.vegetarian).toEqual({ breakfast: 2, lunch: 1, dinner: 1, snack: 1, second_breakfast: 0 });
    expect(matrix.keto).toEqual({ breakfast: 0, lunch: 0, dinner: 1, snack: 0, second_breakfast: 0 });
  });

  it('counts every recipe under the diets that take any', () => {
    expect(matrix.balanced).toEqual({ breakfast: 2, lunch: 2, dinner: 3, snack: 1, second_breakfast: 0 });
    expect(matrix.high_protein).toEqual(matrix.balanced);
    expect(matrix.custom).toEqual(matrix.balanced);
  });

  it('gives, for a number of meals a day, what the thinnest of those meals can choose from', () => {
    const depth = depthByMealCount(matrix);

    // two meals: breakfast and dinner; three add lunch; four a snack; five a second breakfast
    expect(depth.vegetarian).toEqual({ 2: 1, 3: 1, 4: 1, 5: 0 });
    expect(depth.balanced).toEqual({ 2: 2, 3: 2, 4: 1, 5: 0 });
    expect(depth.keto).toEqual({ 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it('names the thinnest cell of the diets a catalogue has to serve', () => {
    // Nobody has a second breakfast here: the first diet in the fixed order names the gap.
    expect(thinnestCell(matrix)).toEqual({ diet: 'balanced', meal: 'second_breakfast', recipes: 0 });
    const full = recipesPerDietAndMeal([recipe(['breakfast', 'lunch', 'dinner', 'snack', 'second_breakfast'], ['vegetarian', 'vegan', 'mediterranean', 'low_carb', 'keto']), recipe(['lunch'])]);
    expect(thinnestCell(full)).toEqual({ diet: 'balanced', meal: 'breakfast', recipes: 1 });
    // `custom` takes any recipe and is nobody's to curate for: it is never the one named.
    expect(thinnestCell(recipesPerDietAndMeal([])).diet).not.toBe('custom');
  });
});
