// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { aimOnDiet, energyShares } from '../engine/nutrition.js';
import {
  dayMealCount,
  macrosOff,
  mealLabel,
  planMealCount,
  planSettingsOff,
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

  it("names the settings of the plan and its profile that keep its days off the split, the diet's dishes no more", () => {
    const settings = { noWaste: true, repeats: 1, proteinKinds: true };
    expect(day({ settings }).causes).toEqual([
      { kind: 'noWaste' },
      { kind: 'repeats', count: 1 },
      { kind: 'proteinKinds' },
    ]);
    // After what the day itself holds.
    expect(day({ settings, overrides: { useUpBy: true } }).causes[0]).toEqual({ kind: 'useUp' });
    expect(
      day({ settings: { noWaste: false, repeats: null, proteinKinds: false } }).causes,
    ).toEqual([{ kind: 'diet' }]);
  });

  it('takes as such settings the ones measured to keep days off: no waste, a recipe once, every protein held to two a day or ten a week', () => {
    const none = { maxMealsPerDaySameKind: null, maxMealsPerWeekSameKind: null };
    expect(planSettingsOff({}, null)).toEqual({
      noWaste: false,
      repeats: null,
      proteinKinds: false,
    });
    expect(planSettingsOff({ noWaste: true }, none).noWaste).toBe(true);
    expect(planSettingsOff({ maxRepeatsPerRecipe: 1 }, none).repeats).toBe(1);
    expect(planSettingsOff({ maxRepeatsPerRecipe: 2 }, none).repeats).toBeNull();
    expect(planSettingsOff({}, { ...none, maxMealsPerDaySameKind: 2 }).proteinKinds).toBe(true);
    expect(planSettingsOff({}, { ...none, maxMealsPerWeekSameKind: 10 }).proteinKinds).toBe(true);
    // Looser than measured: no cause.
    expect(
      planSettingsOff({}, { maxMealsPerDaySameKind: 3, maxMealsPerWeekSameKind: 11 }).proteinKinds,
    ).toBe(false);
  });

  describe('what a day holds too much and too little of', () => {
    const SPLITS = {
      balanced: { protein: 0.25, fat: 0.3, carbs: 0.45 },
      low_carb: lowCarb,
      keto: { protein: 0.25, fat: 0.7, carbs: 0.05 },
    } as const;
    /** A day of one meal of these grams, on a diet, as the plan asks why it is off. */
    const lean = (dietType: keyof typeof SPLITS, protein: number, fat: number, carbs: number) => {
      const meal = planned(protein * 4 + fat * 9 + carbs * 4, protein, fat, carbs);
      const plan = { dietType, macroSplit: null };
      expect(macrosOff(meal.nutrition, plan)).toBe(true);
      const { over, under } = whyMacrosOff({
        held: meal.nutrition,
        aim: SPLITS[dietType],
        dietType,
        meals: [meal],
        besides: null,
        overrides: null,
        usualMeals: 1,
        single: [],
      });
      return { over, under };
    };

    it('names any of the three either way where carbohydrate is an aim', () => {
      // Pasta: 73 % of the energy from carbohydrate, 9 % from protein.
      expect(lean('balanced', 50, 40, 400)).toEqual({ over: 'carbs', under: 'protein' });
      // Meat: 40 % from protein, 14 % from fat.
      expect(lean('balanced', 200, 30, 230)).toEqual({ over: 'protein', under: 'fat' });
    });

    it('names carbohydrate on low-carb only over its ceiling or under its floor', () => {
      // 13 % of carbohydrate, under the ceiling of 20 %: no shortfall of it, the day short of protein.
      expect(lean('low_carb', 80, 170, 70)).toEqual({ over: 'fat', under: 'protein' });
      expect(lean('low_carb', 100, 80, 200)).toEqual({ over: 'carbs', under: 'fat' });
      // None at all, under the floor of a tenth: short of the floor, not of the ceiling.
      expect(lean('low_carb', 135, 162, 0)).toEqual({ over: 'fat', under: 'carbs' });
      expect(lean('low_carb', 60, 196, 0)).toEqual({ over: 'fat', under: 'protein' });
    });

    it('names carbohydrate on keto only over its ceiling', () => {
      expect(lean('keto', 60, 190, 10)).toEqual({ over: 'fat', under: 'protein' });
      expect(lean('keto', 100, 120, 100)).toEqual({ over: 'carbs', under: 'fat' });
    });

    it('names of every day off its split one it holds too much of and one it holds too little of', () => {
      for (const dietType of Object.keys(SPLITS) as (keyof typeof SPLITS)[]) {
        for (let protein = 0; protein <= 250; protein += 25) {
          for (let fat = 0; fat <= 250; fat += 25) {
            for (let carbs = 0; carbs <= 500; carbs += 50) {
              const nutrition = {
                calories: protein * 4 + fat * 9 + carbs * 4,
                protein,
                fat,
                carbs,
              };
              if (!macrosOff(nutrition, { dietType, macroSplit: null })) continue;
              const { over, under } = whyMacrosOff({
                held: nutrition,
                aim: SPLITS[dietType],
                dietType,
                meals: [{ nutrition, fixed: false, byHand: false }],
                besides: null,
                overrides: null,
                usualMeals: 1,
                single: [],
              });
              // Too much and too little against the split as the diet measures the day.
              const shares = energyShares(nutrition)!;
              const against = aimOnDiet(shares, SPLITS[dietType], dietType);
              expect(shares[over]).toBeGreaterThan(against[over]);
              expect(shares[under]).toBeLessThan(against[under]);
            }
          }
        }
      }
    });
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

describe('how many meals a day of a plan is set for', () => {
  const day = (meals: [string, string][], overrides: unknown = null) => ({
    overrides,
    meals: meals.map(([mealType, source]) => ({ mealType, source })),
  });
  const of = (mealType: string): [string, string] => [mealType, 'CATALOGUE'];
  const own = (mealType: string): [string, string] => [mealType, 'USER_CUSTOM'];
  const three = day([of('breakfast'), of('lunch'), of('dinner')]);
  const plan = (
    days: ReturnType<typeof day>[],
    over: { mealCount?: number; made?: number } = {},
  ) => ({
    options: {
      dietType: null,
      mealCount: over.mealCount ?? null,
      calorieTargetOverride: null,
      mealPrepFriendly: false,
      respectExclusions: true,
      respectFavorites: true,
      respectInventory: true,
      maxRepeatsPerRecipe: null,
      allowRelaxations: [],
    },
    report: over.made === undefined ? null : { mealCount: over.made },
    days,
  });

  it('is the number asked for the plan, else the one its days were made with', () => {
    expect(planMealCount(plan([three], { mealCount: 4, made: 3 }))).toBe(4);
    expect(planMealCount(plan([day([of('lunch'), of('dinner')])], { made: 3 }))).toBe(3);
  });

  it('is, of a plan kept before, the number of meals of the catalogue most of its days hold', () => {
    // A breakfast given to a meal of one's own, and a lunch taken off: the days keep the plan's three.
    const ownBreakfast = day([own('breakfast'), own('breakfast'), of('lunch'), of('dinner')]);
    const noLunch = day([of('breakfast'), of('dinner')]);
    expect(planMealCount(plan([ownBreakfast, noLunch, three, three]))).toBe(3);
    // A snack of one's own beside three meals is no fourth meal of the plan.
    expect(
      planMealCount(plan([day([of('breakfast'), of('lunch'), of('dinner'), own('snack')])])),
    ).toBe(3);
  });

  it('takes the larger of two numbers as common, and leaves out the days of a number of their own', () => {
    const four = day([of('breakfast'), of('lunch'), of('dinner'), of('snack')]);
    const five = day(
      [of('breakfast'), of('second_breakfast'), of('lunch'), of('snack'), of('dinner')],
      { mealCount: 5 },
    );
    expect(planMealCount(plan([three, four, five, five]))).toBe(4);
  });

  it('is none for a plan no day of which holds a meal of the catalogue', () => {
    expect(planMealCount(plan([day([own('lunch')]), day([])]))).toBeNull();
  });

  it("gives a day its own number, else the plan's, else as many as it has from the catalogue, else the profile's", () => {
    expect(dayMealCount({ overrides: { mealCount: 4 }, meals: [] }, 3, 5)).toBe(4);
    expect(dayMealCount(day([of('breakfast'), of('dinner')]), 3, 5)).toBe(3);
    expect(dayMealCount(three, null, 5)).toBe(3);
    expect(dayMealCount(day([own('lunch')]), null, 4)).toBe(4);
  });
});
