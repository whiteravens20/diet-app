// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  macrosOff,
  mealLabel,
  mealNutrition,
  restsOf,
  scaleRests,
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
