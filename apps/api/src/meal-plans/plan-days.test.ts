// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  macrosOff,
  mealLabel,
  mealNutrition,
  restsOf,
  scaleRests,
  whyMacrosOff,
  type MealOfDay,
  type StoredRest,
} from './plan-days.js';

describe('whether a day is far from its split', () => {
  // 150 g of protein, 145 g of fat and 20 g of carbohydrate: protein on low-carb's share, carbohydrate at a twentieth.
  const eggsAndFish = { protein: 150, fat: 145, carbs: 20 };

  it('is not said of a low-carb or keto day under its carbohydrate that holds its protein', () => {
    expect(macrosOff(eggsAndFish, { dietType: 'low_carb', macroSplit: null })).toBe(false);
    expect(
      macrosOff({ protein: 125, fat: 160, carbs: 15 }, { dietType: 'keto', macroSplit: null }),
    ).toBe(false);
  });

  it('is said of that day where carbohydrate is an aim, and of a low-carb day short of protein or over its carbohydrate', () => {
    expect(macrosOff(eggsAndFish, { dietType: 'balanced', macroSplit: null })).toBe(true);
    expect(
      macrosOff(eggsAndFish, {
        dietType: 'custom',
        macroSplit: { protein: 30, fat: 50, carbs: 20 },
      }),
    ).toBe(true);
    expect(
      macrosOff({ protein: 50, fat: 160, carbs: 20 }, { dietType: 'low_carb', macroSplit: null }),
    ).toBe(true);
    expect(
      macrosOff({ protein: 100, fat: 80, carbs: 200 }, { dietType: 'low_carb', macroSplit: null }),
    ).toBe(true);
  });

  it("goes by the day's own aim where it has one", () => {
    // The grams a low-carb day aims at: 30/50/20 of 2000 kcal.
    const aim = { protein: 150, fat: 111, carbs: 100 };
    expect(macrosOff(eggsAndFish, { dietType: 'low_carb', macroSplit: null }, aim)).toBe(false);
    expect(macrosOff(eggsAndFish, { dietType: 'balanced', macroSplit: null }, aim)).toBe(true);
  });
});

describe("what makes a day's macros off", () => {
  // The low-carb aim, 30/50/20 of the energy; carbohydrate a ceiling down to a tenth.
  const lowCarb = { protein: 0.3, fat: 0.5, carbs: 0.2 };
  /** A meal of the day the plan may change, chosen by the plan. */
  const planned = (calories: number, protein: number, fat: number, carbs: number): MealOfDay => ({
    nutrition: { calories, protein, fat, carbs },
    fixed: false,
    byHand: false,
  });
  // His day of 24 November: an omelet with bacon, one with gouda, one with cheddar and avocado.
  const omelets = [planned(703, 37, 59, 7), planned(1055, 68, 83, 8), planned(562, 26, 48, 13)];
  const sum = (meals: readonly MealOfDay[]) =>
    meals.reduce(
      (all, meal) => ({
        calories: all.calories + meal.nutrition.calories,
        protein: all.protein + meal.nutrition.protein,
        fat: all.fat + meal.nutrition.fat,
        carbs: all.carbs + meal.nutrition.carbs,
      }),
      { calories: 0, protein: 0, fat: 0, carbs: 0 },
    );
  const day = (over: Partial<Parameters<typeof whyMacrosOff>[0]> = {}) =>
    whyMacrosOff({
      held: sum(over.meals ?? omelets),
      aim: lowCarb,
      dietType: 'low_carb',
      meals: omelets,
      besides: null,
      overrides: null,
      usualMeals: 3,
      single: [],
      ...over,
    });

  it('names a limit on cooking time, and too much fat for too little protein as the diet measures it', () => {
    expect(day({ overrides: { cookTimeBudgetMinutes: 15 } })).toEqual({
      over: 'fat',
      under: 'protein',
      causes: [{ kind: 'cookTime', minutes: 15 }],
    });
  });

  it('names what the plan does not change where it holds a quarter of the day or more, itself far from the split', () => {
    // Eaten already: a breakfast of cheese, 85 % of its energy from fat, 43 % of the day's.
    const eaten = { ...planned(1000, 25, 95, 5), fixed: true };
    const why = day({ meals: [omelets[0]!, eaten, omelets[2]!] });
    expect(why.causes).toEqual([{ kind: 'fixed', share: 43 }]);
    // The diary's entries and other plans' meals are as fixed as a meal eaten: 27 % of the day here.
    const besides = { calories: 900, protein: 20, fat: 80, carbs: 20 };
    const all = sum(omelets);
    expect(
      day({
        held: {
          calories: all.calories + besides.calories,
          protein: all.protein + besides.protein,
          fat: all.fat + besides.fat,
          carbs: all.carbs + besides.carbs,
        },
        besides,
      }).causes,
    ).toEqual([{ kind: 'fixed', share: 27 }]);
    // A meal eaten that is itself near the split is no reason, however much of the day it holds.
    const near = { ...planned(1055, 68, 83, 8), fixed: true };
    expect(day({ meals: [omelets[0]!, near, omelets[2]!] }).causes).toEqual([{ kind: 'diet' }]);
  });

  it("names fewer meals than the plan's days have, the pantry used up, meals chosen by hand and dishes that fit alone", () => {
    const swapped = { ...omelets[1]!, byHand: true };
    expect(
      day({
        meals: [omelets[0]!, swapped, omelets[2]!],
        overrides: { mealCount: 2, useUpBy: true },
        single: ['lunch'],
      }).causes,
    ).toEqual([
      { kind: 'fewerMeals', count: 2 },
      { kind: 'useUp' },
      { kind: 'byHand', count: 1 },
      { kind: 'singleDish', slots: ['lunch'] },
    ]);
    // A day of more meals than the plan's is no fewer.
    expect(day({ overrides: { mealCount: 4 } }).causes).toEqual([{ kind: 'diet' }]);
  });

  it("names the diet's dishes where nothing else made the day", () => {
    expect(day().causes).toEqual([{ kind: 'diet' }]);
  });
});

describe('the rests of packs a meal finishes', () => {
  const chicken = '11111111-1111-4111-8111-111111111111';
  const rest: StoredRest = {
    ingredientId: chicken,
    amount: 30,
    unit: 'g',
    figures: { calories: 49.5, protein: 9.3, fat: 1.1, carbs: 0 },
    label: {
      fiber: { grams: 0, atLeast: false },
      sugars: null,
      salt: { grams: 0.1, atLeast: false },
      saturatedFat: { grams: 0.3, atLeast: false },
    },
  };
  const meal = {
    servings: 1,
    quantityScale: 1,
    plate: null,
    pieces: [],
    source: 'CATALOGUE',
    customMacros: null,
    recipe: {
      caloriesPerServing: 500,
      proteinPerServing: 30,
      fatPerServing: 15,
      carbsPerServing: 60,
      labelPerServing: {
        fiber: { grams: 4, atLeast: false },
        sugars: { grams: 5, atLeast: false },
        salt: { grams: 1, atLeast: false },
        saturatedFat: { grams: 3, atLeast: false },
      },
    },
  };

  it("count in the meal's figures and label, beside its recipe", () => {
    expect(mealNutrition({ ...meal, rests: [rest] })).toEqual({
      calories: 550,
      protein: 39,
      fat: 16,
      carbs: 60,
    });
    expect(mealNutrition({ ...meal, rests: null })).toEqual({
      calories: 500,
      protein: 30,
      fat: 15,
      carbs: 60,
    });
    // Sugars the rest says nothing of: the meal holds at least what its dish does.
    expect(mealLabel({ ...meal, rests: [rest] })).toEqual({
      fiber: { grams: 4, atLeast: false },
      sugars: { grams: 5, atLeast: true },
      salt: { grams: 1.1, atLeast: false },
      saturatedFat: { grams: 3.3, atLeast: false },
    });
  });

  it("count what the meal's pot takes whole of an egg in its figures and label: the whole pieces less the exact ones", () => {
    // An egg of 55 g: 143 kcal, 12.6 g protein, 9.5 g fat, 0.7 g carbohydrate, 0.4 g salt, 3.1 g saturated fat in 100 g.
    const egg = {
      ingredientId: 'egg',
      // A serving takes 1.5 eggs, which its pot takes as 2: a third more.
      exact: 82.5,
      factor: 2 / 1.5,
      per100: { calories: 143, protein: 12.6, fat: 9.5, carbs: 0.7 },
      label: { fiber: 0, sugars: null, salt: 0.4, saturatedFat: 3.1 },
    };
    // Half an egg more: 27.5 g, 39 kcal, 3.5 g protein, 2.6 g fat, 0.2 g carbohydrate.
    expect(mealNutrition({ ...meal, rests: null, pieces: [egg] })).toEqual({
      calories: 539,
      protein: 33,
      fat: 18,
      carbs: 60,
    });
    expect(mealLabel({ ...meal, rests: null, pieces: [egg] })).toEqual({
      fiber: { grams: 4, atLeast: false },
      // What the egg says nothing of moves nothing.
      sugars: { grams: 5, atLeast: false },
      salt: { grams: 1.1, atLeast: false },
      saturatedFat: { grams: 3.9, atLeast: false },
    });
    // A pot that takes less than its meals do exactly takes as much less: 2.5 eggs as 2.
    expect(
      mealNutrition({ ...meal, rests: null, pieces: [{ ...egg, exact: 137.5, factor: 2 / 2.5 }] }),
    ).toEqual({ calories: 461, protein: 27, fat: 12, carbs: 60 });
    // A factor of one is the meal as it was planned.
    expect(mealNutrition({ ...meal, rests: null, pieces: [{ ...egg, factor: 1 }] })).toEqual(
      mealNutrition({ ...meal, rests: null }),
    );
  });

  it("count a person's own plate of a shared dish in the meal's figures and label, as large as the portion", () => {
    // More of the protein, less of the starch: per serving 40 kcal less of carbohydrate, 40 kcal more of protein.
    const plate = {
      protein: 1.3,
      starch: 0.7,
      vegetables: 1,
      perServing: { calories: 0, protein: 10, fat: 0, carbs: -10 },
      labelPerServing: { fiber: -1, sugars: 0, salt: 0.2, saturatedFat: 0 },
    };
    expect(mealNutrition({ ...meal, rests: null, plate })).toEqual({
      calories: 500,
      protein: 40,
      fat: 15,
      carbs: 50,
    });
    // Two servings at three quarters: the plate's change as large as the portion.
    expect(
      mealNutrition({ ...meal, servings: 2, quantityScale: 0.75, rests: null, plate }),
    ).toEqual({
      calories: 750,
      protein: 60,
      fat: 23,
      carbs: 75,
    });
    expect(mealLabel({ ...meal, rests: null, plate })).toEqual({
      fiber: { grams: 3, atLeast: false },
      sugars: { grams: 5, atLeast: false },
      salt: { grams: 1.2, atLeast: false },
      saturatedFat: { grams: 3, atLeast: false },
    });
    // A plate of another shape is none: the meal is the recipe's.
    expect(mealNutrition({ ...meal, rests: null, plate: { protein: 3 } })).toEqual({
      calories: 500,
      protein: 30,
      fat: 15,
      carbs: 60,
    });
  });

  it('are none where a row keeps none, or something else', () => {
    expect(restsOf(null)).toEqual([]);
    expect(restsOf([{ ingredientId: chicken, amount: -1 }])).toEqual([]);
    expect(restsOf('rests')).toEqual([]);
  });

  it('are shared as a meal is: each amount and what it holds in its share, to a tenth', () => {
    expect(scaleRests([rest], 0.5)).toEqual([
      {
        ...rest,
        amount: 15,
        figures: { calories: 24.8, protein: 4.7, fat: 0.6, carbs: 0 },
        label: {
          fiber: { grams: 0, atLeast: false },
          sugars: null,
          salt: { grams: 0.1, atLeast: false },
          saturatedFat: { grams: 0.2, atLeast: false },
        },
      },
    ]);
    // A share too small to keep is no rest.
    expect(scaleRests([rest], 0.001)).toEqual([]);
  });
});
