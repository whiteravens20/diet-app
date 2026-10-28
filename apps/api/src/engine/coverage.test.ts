// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  MACRO_OUT_OF_REACH,
  macroReachByDiet,
  recipesPerDietAndMeal,
  supplyByMealCount,
  thinnestCell,
  type CoverageMatrix,
} from './coverage.js';
import { macroSplitOf } from './nutrition.js';
import { VARIETY_DEPTH, type MealType } from '@diet-app/shared';

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
    expect(matrix.vegan).toEqual({
      breakfast: 1,
      lunch: 1,
      dinner: 1,
      snack: 0,
      second_breakfast: 0,
    });
    expect(matrix.vegetarian).toEqual({
      breakfast: 2,
      lunch: 1,
      dinner: 1,
      snack: 1,
      second_breakfast: 0,
    });
    expect(matrix.keto).toEqual({
      breakfast: 0,
      lunch: 0,
      dinner: 1,
      snack: 0,
      second_breakfast: 0,
    });
  });

  it('counts every recipe under the diets that take any', () => {
    expect(matrix.balanced).toEqual({
      breakfast: 2,
      lunch: 2,
      dinner: 3,
      snack: 1,
      second_breakfast: 0,
    });
    expect(matrix.high_protein).toEqual(matrix.balanced);
    expect(matrix.custom).toEqual(matrix.balanced);
  });

  it('gives, for a number of meals a day, what the thinnest of those meals can choose from', () => {
    const supply = supplyByMealCount(matrix);
    const recipes = (diet: 'vegetarian' | 'balanced' | 'keto') =>
      Object.fromEntries(
        Object.entries(supply[diet]).map(([count, cell]) => [count, cell.recipes]),
      );

    // two meals: breakfast and dinner; three add lunch; four a snack; five a second breakfast
    expect(recipes('vegetarian')).toEqual({ 2: 1, 3: 1, 4: 1, 5: 0 });
    expect(recipes('balanced')).toEqual({ 2: 2, 3: 2, 4: 1, 5: 0 });
    expect(recipes('keto')).toEqual({ 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it('names the thinnest cell of the diets a catalogue has to serve', () => {
    // Nobody has a second breakfast here: the first diet in the fixed order names the gap.
    expect(thinnestCell(matrix)).toEqual({
      diet: 'balanced',
      meal: 'second_breakfast',
      recipes: 0,
    });
    const full = recipesPerDietAndMeal([
      recipe(
        ['breakfast', 'lunch', 'dinner', 'snack', 'second_breakfast'],
        ['vegetarian', 'vegan', 'mediterranean', 'low_carb', 'keto'],
      ),
      recipe(['lunch']),
    ]);
    expect(thinnestCell(full)).toEqual({ diet: 'balanced', meal: 'breakfast', recipes: 1 });
    // `custom` takes any recipe and is nobody's to curate for: it is never the one named.
    expect(thinnestCell(recipesPerDietAndMeal([])).diet).not.toBe('custom');
  });
});

describe('what the plans of a diet reach of its split, with the recipes there are', () => {
  /** A dish of `kcal` whose energy is split as the shares say. */
  const dish = (
    id: string,
    mealTypes: MealType[],
    kcal: number,
    [protein, fat, carbs]: [number, number, number],
    dietTags: string[] = [],
  ) => ({
    id,
    mealTypes,
    dietTags,
    caloriesPerServing: kcal,
    proteinPerServing: (kcal * protein) / 4,
    fatPerServing: (kcal * fat) / 9,
    carbsPerServing: (kcal * carbs) / 4,
  });
  /** Five dishes for each of the three meals, all of one kind. */
  const allOf = (kind: string, shares: [number, number, number], dietTags: string[] = []) =>
    (['breakfast', 'lunch', 'dinner'] as const).flatMap((meal) =>
      [0, 1, 2, 3, 4].map((i) =>
        dish(`${kind}-${meal}-${i}`, [meal], 500 + 40 * i, shares, dietTags),
      ),
    );

  it('is the average day of the weeks the optimiser makes, and how far that is from the split', () => {
    const reach = macroReachByDiet([
      ...allOf('even', [0.25, 0.3, 0.45]),
      ...allOf('lean', [0.45, 0.3, 0.25]),
    ]);

    // Both kinds are there: a balanced plan and a high-protein one each find their own.
    expect(reach.balanced!.distance).toBeLessThan(0.05);
    expect(reach.high_protein!.protein).toBeGreaterThan(reach.balanced!.protein + 0.05);
    expect(reach.high_protein!.distance).toBeLessThan(MACRO_OUT_OF_REACH);
    const { protein, fat, carbs } = reach.balanced!;
    expect(protein + fat + carbs).toBeCloseTo(1);
  });

  it('says how far short a catalogue leaves a diet that it has no recipes for', () => {
    // Nothing but dishes with a fifth of their energy from protein: a high-protein plan gets a fifth, not seven twentieths.
    const reach = macroReachByDiet(allOf('starchy', [0.2, 0.3, 0.5]));

    expect(reach.high_protein!.protein).toBeCloseTo(0.2, 2);
    expect(reach.high_protein!.distance).toBeCloseTo(0.15, 2);
    expect(reach.high_protein!.distance).toBeGreaterThan(MACRO_OUT_OF_REACH);
    expect(reach.balanced!.distance).toBeCloseTo(0.05, 2);
  });

  it('says how much the weeks use of what they buy in packs that do not keep, where it is told the packs', () => {
    // Every dish takes 150 g of chicken a serving, and chicken comes in packs of 500 g.
    const withChicken = allOf('even', [0.25, 0.3, 0.45]).map((known) => ({
      ...known,
      ingredientIds: ['chicken'],
      amounts: new Map([['chicken', 150]]),
    }));

    const reach = macroReachByDiet(withChicken, new Map([['chicken', 500]]));

    // Three meals a day for a week: the packs are used but for what is left of the last.
    expect(reach.balanced!.packsUsed).toBeGreaterThan(0.8);
    expect(reach.balanced!.packsUsed).toBeLessThanOrEqual(1);
    // Not told the packs, and told of none the weeks buy.
    expect(macroReachByDiet(withChicken).balanced!.packsUsed).toBeNull();
    expect(
      macroReachByDiet(withChicken, new Map([['yogurt', 500]])).balanced!.packsUsed,
    ).toBeNull();
  });

  it('is not there for a diet no plan can be made for', () => {
    const reach = macroReachByDiet(allOf('even', [0.25, 0.3, 0.45]));

    expect(reach.vegan).toBeNull();
    expect(reach.keto).toBeNull();
  });

  it('looks only at the recipes the diet may have', () => {
    const fatty: [number, number, number] = [0.25, 0.7, 0.05];
    const reach = macroReachByDiet([
      ...allOf('even', [0.25, 0.3, 0.45]),
      ...allOf('fatty', fatty, ['keto', 'low_carb']),
    ]);

    expect(reach.keto!.distance).toBeCloseTo(0, 2);
    expect(reach.keto!.fat).toBeCloseTo(macroSplitOf('keto').fat, 2);
  });
});

describe('how well the catalogue serves a diet at a number of meals a day', () => {
  const meals = (counts: Partial<Record<MealType, number>>): Record<MealType, number> => ({
    breakfast: 9,
    lunch: 9,
    dinner: 9,
    snack: 9,
    second_breakfast: 9,
    ...counts,
  });
  const matrix = Object.fromEntries(
    Object.keys(recipesPerDietAndMeal([])).map((diet) => [diet, meals({})]),
  ) as CoverageMatrix;
  // Four meals add a snack to three, five a second breakfast to four.
  matrix.vegan = meals({ lunch: VARIETY_DEPTH - 1, snack: 1, second_breakfast: 0 });
  matrix.keto = meals({ breakfast: 0 });
  matrix.mediterranean = meals({ lunch: 0 });
  const supply = supplyByMealCount(matrix);

  it('is none when one of the meals of the day has no recipe', () => {
    expect(supply.vegan['5']).toMatchObject({ level: 'none', recipes: 0 });
  });

  it('is thin under what a week without too many repeats needs', () => {
    expect(supply.vegan['4']).toMatchObject({ level: 'thin', recipes: 1 });
    expect(supply.vegan['3']).toMatchObject({ level: 'thin', recipes: VARIETY_DEPTH - 1 });
  });

  it('is enough from there on', () => {
    expect(supply.vegan['2']).toEqual({ level: 'enough', recipes: 9, fewerMeals: null });
    expect(supply.balanced['5']).toEqual({ level: 'enough', recipes: 9, fewerMeals: 4 });
    matrix.balanced = meals({ lunch: VARIETY_DEPTH });
    expect(supplyByMealCount(matrix).balanced['3']).toMatchObject({
      level: 'enough',
      recipes: VARIETY_DEPTH,
    });
  });

  it('names the largest smaller number of meals a day that can be planned', () => {
    expect(supply.vegan['5'].fewerMeals).toBe(4);
    expect(supply.mediterranean['5'].fewerMeals).toBe(2);
    expect(supply.mediterranean['3'].fewerMeals).toBe(2);
  });

  it('names none when fewer meals would not help: the meal without a recipe is part of every day', () => {
    expect(supply.keto['5'].fewerMeals).toBeNull();
    expect(supply.mediterranean['2'].fewerMeals).toBeNull();
  });
});
