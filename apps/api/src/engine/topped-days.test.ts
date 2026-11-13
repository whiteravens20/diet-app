// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Macros } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { energyShares, MACROS_OFF, splitDistance } from './nutrition.js';
import type { OptimizerDay, OptimizerRecipe } from './optimizer.js';
import {
  REBALANCE_TOLERANCE,
  sizeDay,
  type RebalanceMeal,
  type SizedAssignment,
} from './rebalance.js';
import { packKitchen } from './close-packs.js';
import { fullKindsOn, topAndSizeDay, topAssignments } from './topped-days.js';
import { plateChange, type PlateDish } from './plates.js';
import {
  TOPPING_BY_KEY,
  type ToppingDish,
  type ToppingEater,
  type ToppingOption,
} from './toppings.js';

const anyone: ToppingEater = {
  diet: 'balanced',
  allergens: [],
  excluded: new Set(),
  disliked: new Set(),
  fullKinds: new Set(),
};
const PLATE: ToppingDish = {
  taste: 'savoury',
  form: 'plate',
  starchBase: 'none',
  meatStandIn: false,
};

/** Turkey and bread, as the catalogue has them. */
const OPTIONS: ToppingOption[] = [
  {
    topping: TOPPING_BY_KEY.get('turkey')!,
    food: {
      id: 'turkey',
      allergens: [],
      dietCompatibility: ['balanced', 'high_protein'],
      proteinKind: 'turkey',
    },
    per100: { calories: 114, protein: 23.3, fat: 2.3, carbs: 0 },
  },
  {
    topping: TOPPING_BY_KEY.get('rye_bread')!,
    food: { id: 'rye', allergens: ['gluten'], dietCompatibility: ['balanced'], proteinKind: null },
    per100: { calories: 259, protein: 8.5, fat: 3.3, carbs: 48.3 },
  },
];

/** Dishes low in protein: a pasta lunch and a vegetable dinner, 1,000 kcal and 800 kcal a serving. */
const meal = (id: string, calories: number, macros: Macros): RebalanceMeal => ({
  id,
  calories,
  servings: 1,
  quantityScale: 1,
  locked: false,
  macros,
});
const LUNCH = meal('lunch', 1000, { protein: 30, fat: 35, carbs: 143 });
const DINNER = meal('dinner', 800, { protein: 20, fat: 30, carbs: 112 });
// A high-protein day of 2,000 kcal: 175 g of protein, 67 g of fat, 175 g of carbohydrate.
const HIGH_PROTEIN: Macros = { protein: 175, fat: 67, carbs: 175 };

const held = (meals: readonly RebalanceMeal[], scales: ReadonlyMap<string, number>) =>
  meals.reduce(
    (sum, one) => {
      const amount = one.servings * (scales.get(one.id) ?? one.quantityScale);
      return {
        calories: sum.calories + one.calories * amount,
        protein: sum.protein + one.macros!.protein * amount,
        fat: sum.fat + one.macros!.fat * amount,
        carbs: sum.carbs + one.macros!.carbs * amount,
      };
    },
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );
const distance = (figures: Macros, aim: Macros) =>
  splitDistance(energyShares(figures)!, energyShares(aim)!);

describe('a day topped and sized', () => {
  it('puts a topping on a shared plate of a day off its split, and sizes the day again around it to its target', () => {
    const before = sizeDay([LUNCH, DINNER], 2000, HIGH_PROTEIN).scales;
    expect(distance(held([LUNCH, DINNER], before), HIGH_PROTEIN)).toBeGreaterThan(MACROS_OFF);

    const { scales, toppings } = topAndSizeDay(
      [LUNCH, DINNER],
      2000,
      HIGH_PROTEIN,
      [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
      OPTIONS,
      anyone,
    );
    expect(toppings).toEqual([{ mealId: 'lunch', key: 'turkey', amount: 150 }]);
    expect([...scales.keys()].sort()).toEqual(['dinner', 'lunch']);

    const turkey = { calories: 171, protein: 34.95, fat: 3.45, carbs: 0 };
    const meals = held([LUNCH, DINNER], scales);
    const after = {
      calories: meals.calories + turkey.calories,
      protein: meals.protein + turkey.protein,
      fat: meals.fat + turkey.fat,
      carbs: meals.carbs + turkey.carbs,
    };
    expect(Math.abs(after.calories - 2000)).toBeLessThanOrEqual(REBALANCE_TOLERANCE * 2000);
    expect(distance(after, HIGH_PROTEIN)).toBeLessThan(
      distance(held([LUNCH, DINNER], before), HIGH_PROTEIN),
    );
  });

  it('puts on a day that needs two another topping for the second, where another brings it back as well', () => {
    // 16 % of the dishes' energy from protein: the day takes a topping at each of its two plates.
    const share = (id: string, kcal: number) =>
      meal(id, kcal, {
        protein: (kcal * 0.16) / 4,
        fat: (kcal * 0.31) / 9,
        carbs: (kcal * 0.53) / 4,
      });
    const alike: ToppingOption[] = ['turkey', 'tofu'].map((key) => ({
      ...OPTIONS[0]!,
      topping: TOPPING_BY_KEY.get(key)!,
      food: { ...OPTIONS[0]!.food, id: key, proteinKind: null },
    }));
    const { toppings } = topAndSizeDay(
      [share('lunch', 1000), share('dinner', 800)],
      2000,
      HIGH_PROTEIN,
      [
        { mealId: 'lunch', meal: 'lunch', dish: PLATE },
        { mealId: 'dinner', meal: 'dinner', dish: PLATE },
      ],
      alike,
      anyone,
    );
    expect(toppings.map((choice) => choice.key)).toEqual(['turkey', 'tofu']);
  });

  it('puts at most one topping on a place, and none where there is no place or the day stands on its split', () => {
    const one = topAndSizeDay(
      [LUNCH, DINNER],
      2000,
      HIGH_PROTEIN,
      [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
      OPTIONS,
      anyone,
    );
    expect(one.toppings.filter((choice) => choice.mealId === 'lunch')).toHaveLength(1);
    expect(topAndSizeDay([LUNCH, DINNER], 2000, HIGH_PROTEIN, [], OPTIONS, anyone)).toEqual({
      scales: sizeDay([LUNCH, DINNER], 2000, HIGH_PROTEIN).scales,
      toppings: [],
    });
    const ownSplit = held([LUNCH, DINNER], new Map());
    const aimed = { protein: ownSplit.protein, fat: ownSplit.fat, carbs: ownSplit.carbs };
    expect(
      topAndSizeDay(
        [LUNCH, DINNER],
        1800,
        aimed,
        [{ mealId: 'lunch', meal: 'lunch', dish: PLATE }],
        OPTIONS,
        anyone,
      ).toppings,
    ).toEqual([]);
  });
});

describe('the meals of a plan topped', () => {
  const recipes: OptimizerRecipe[] = [
    {
      id: 'pasta',
      caloriesPerServing: 1000,
      proteinPerServing: 30,
      fatPerServing: 35,
      carbsPerServing: 143,
    },
    {
      id: 'veg',
      caloriesPerServing: 800,
      proteinPerServing: 20,
      fatPerServing: 30,
      carbsPerServing: 112,
    },
  ].map((recipe) => ({
    ...recipe,
    mealTypes: ['lunch', 'dinner'],
    dietTags: [],
    ingredientIds: [],
    difficulty: 'easy',
    isFavorite: false,
    totalMinutes: 30,
  }));
  const day: OptimizerDay = {
    mealSlots: ['lunch', 'dinner'],
    dailyCalorieTarget: 2000,
    macroAim: HIGH_PROTEIN,
  };
  const sized: SizedAssignment[] = [0, 1].flatMap((dayIndex) => [
    { dayIndex, slot: 'lunch' as const, recipeId: 'pasta', servings: 1, quantityScale: 1 },
    { dayIndex, slot: 'dinner' as const, recipeId: 'veg', servings: 1, quantityScale: 1 },
  ]);
  const split = energyShares(HIGH_PROTEIN)!;

  it('tops only the days and meals that are places, the rest as sized', () => {
    const topped = topAssignments(
      [day, day],
      recipes,
      sized,
      split,
      (meal) => (meal.dayIndex === 0 && meal.slot === 'lunch' ? PLATE : null),
      OPTIONS,
      () => anyone,
    );
    expect(topped.find((one) => one.dayIndex === 0 && one.slot === 'lunch')!.topping).toEqual({
      key: 'turkey',
      amount: 150,
    });
    expect(topped.filter((one) => one.topping !== null)).toHaveLength(1);
    expect(topped.filter((one) => one.dayIndex === 1)).toEqual(
      sized.filter((one) => one.dayIndex === 1).map((one) => ({ ...one, topping: null })),
    );
  });
});

describe('the meals of a plan plated', () => {
  const recipes: OptimizerRecipe[] = [
    {
      id: 'chicken-pasta',
      caloriesPerServing: 1000,
      proteinPerServing: 30,
      fatPerServing: 35,
      carbsPerServing: 143,
      amounts: new Map([
        ['chicken', 100],
        ['pasta', 120],
        ['oil', 25],
      ]),
    },
    {
      id: 'bean-stew',
      caloriesPerServing: 1010,
      proteinPerServing: 70,
      fatPerServing: 30,
      carbsPerServing: 100,
    },
  ].map((recipe) => ({
    ...recipe,
    mealTypes: ['lunch', 'dinner'],
    dietTags: [],
    ingredientIds: [],
    difficulty: 'easy',
    isFavorite: false,
    totalMinutes: 30,
  }));
  /** The pasta's parts: a little chicken, much pasta, some broccoli and the oil of the sauce. */
  const part = (protein: number, fat: number, carbs: number) => ({
    protein,
    fat,
    carbs,
    calories: protein * 4 + fat * 9 + carbs * 4,
  });
  const none = { fiber: 0, sugars: 0, salt: 0, saturatedFat: 0 };
  const PASTA: PlateDish = {
    parts: {
      protein: part(20, 5, 0),
      starch: part(8, 2, 130),
      vegetables: part(2, 1, 13),
      rest: part(0, 27, 0),
    },
    labels: { protein: none, starch: none, vegetables: none, rest: none },
    partOf: new Map([
      ['chicken', 'protein'],
      ['pasta', 'starch'],
      ['oil', 'rest'],
    ]),
  };
  const day: OptimizerDay = {
    mealSlots: ['lunch', 'dinner'],
    dailyCalorieTarget: 2000,
    macroAim: HIGH_PROTEIN,
  };
  const sized: SizedAssignment[] = [
    { dayIndex: 0, slot: 'lunch', recipeId: 'chicken-pasta', servings: 1, quantityScale: 1 },
    { dayIndex: 0, slot: 'dinner', recipeId: 'bean-stew', servings: 1, quantityScale: 1 },
  ];
  const lunchOnly = (meal: SizedAssignment) => (meal.slot === 'lunch' ? PLATE : null);
  const run = (plated: boolean, kitchen?: ReturnType<typeof packKitchen>) =>
    topAssignments(
      [day],
      recipes,
      sized,
      energyShares(HIGH_PROTEIN)!,
      lunchOnly,
      OPTIONS,
      () => anyone,
      kitchen,
      (meal) => (plated && meal.slot === 'lunch' ? PASTA : null),
    );

  /** How far the day of a run is from its split: its meals at their portions and plates, with their toppings. */
  const awayOf = (meals: ReturnType<typeof run>): number => {
    const day = { protein: 0, fat: 0, carbs: 0 };
    for (const meal of meals) {
      const recipe = recipes.find((one) => one.id === meal.recipeId)!;
      const change = meal.plate ? plateChange(PASTA, meal.plate).perServing : null;
      const amount = meal.servings * meal.quantityScale;
      const topping = meal.topping
        ? OPTIONS.find((one) => one.topping.key === meal.topping!.key)
        : null;
      const part = (meal.topping?.amount ?? 0) / 100;
      day.protein +=
        (recipe.proteinPerServing + (change?.protein ?? 0)) * amount +
        (topping?.per100.protein ?? 0) * part;
      day.fat +=
        (recipe.fatPerServing + (change?.fat ?? 0)) * amount + (topping?.per100.fat ?? 0) * part;
      day.carbs +=
        (recipe.carbsPerServing + (change?.carbs ?? 0)) * amount +
        (topping?.per100.carbs ?? 0) * part;
    }
    return splitDistance(energyShares(day)!, energyShares(HIGH_PROTEIN)!);
  };

  it('give a shared dish served on a plate the person’s own plate first, and a topping only where the day stays off', () => {
    const lunch = run(true).find((meal) => meal.slot === 'lunch')!;

    expect(lunch.plate!.protein).toBeGreaterThan(1);
    expect(lunch.plate!.starch).toBeLessThan(1);
    // The day the topping brought back without the plate is brought back by the plate, with no more food.
    expect(run(false).find((meal) => meal.slot === 'lunch')!.topping).not.toBeNull();
    expect(lunch.topping).toBeNull();
    expect(awayOf(run(true))).toBeLessThanOrEqual(MACROS_OFF);
    // The plate is the person's at the dish both eat, and nowhere else.
    expect(run(false).find((meal) => meal.slot === 'lunch')!.plate).toBeUndefined();
    expect(run(true).find((meal) => meal.slot === 'dinner')!.plate).toBeUndefined();
  });

  it('take what the plate holds more of an ingredient from the kitchen’s packs, and give back what it holds less of', () => {
    const needs = new Map<string, number[]>();
    const lunch = run(true, packKitchen(needs, 1)).find((meal) => meal.slot === 'lunch')!;

    expect(needs.get('chicken')![0]).toBeCloseTo(100 * (lunch.plate!.protein - 1), 6);
    expect(needs.get('pasta')![0]).toBeCloseTo(120 * (lunch.plate!.starch - 1), 6);
    expect(needs.get('oil')).toBeUndefined();
  });
});

describe('the toppings of a run, day after day', () => {
  // Dishes just off a high-protein split: 22.5 % of their energy from protein, 31 % from fat, 46.5 % from carbohydrate.
  const recipes: OptimizerRecipe[] = [
    {
      id: 'lunch-dish',
      caloriesPerServing: 1000,
      proteinPerServing: 56.25,
      fatPerServing: 34.4,
      carbsPerServing: 116.25,
    },
    {
      id: 'dinner-dish',
      caloriesPerServing: 800,
      proteinPerServing: 45,
      fatPerServing: 27.6,
      carbsPerServing: 93,
    },
  ].map((recipe) => ({
    ...recipe,
    mealTypes: ['lunch', 'dinner'],
    dietTags: [],
    ingredientIds: [],
    difficulty: 'easy',
    isFavorite: false,
    totalMinutes: 30,
  }));
  const day: OptimizerDay = {
    mealSlots: ['lunch', 'dinner'],
    dailyCalorieTarget: 2000,
    macroAim: HIGH_PROTEIN,
  };
  const sized: SizedAssignment[] = [0, 1, 2].flatMap((dayIndex) => [
    { dayIndex, slot: 'lunch' as const, recipeId: 'lunch-dish', servings: 1, quantityScale: 1 },
    { dayIndex, slot: 'dinner' as const, recipeId: 'dinner-dish', servings: 1, quantityScale: 1 },
  ]);
  // Two toppings alike: either brings such a day back onto its split, as near.
  const alike: ToppingOption[] = ['turkey', 'tofu'].map((key) => ({
    ...OPTIONS[0]!,
    topping: TOPPING_BY_KEY.get(key)!,
    food: { ...OPTIONS[0]!.food, id: key, proteinKind: null },
  }));

  it('are given in turn where more than one brings a day back, the one had least of late first', () => {
    const topped = topAssignments(
      [day, day, day],
      recipes,
      sized,
      energyShares(HIGH_PROTEIN)!,
      (meal) => (meal.slot === 'lunch' ? PLATE : null),
      alike,
      () => anyone,
    );
    expect(topped.flatMap((one) => (one.topping ? [one.topping.key] : []))).toEqual([
      'turkey',
      'tofu',
      'turkey',
    ]);
  });
  it('in a plan that wastes less, come from a pack the kitchen opened while it keeps, before one had less of late', () => {
    // Turkey in packs of 500 g that keep two days once opened, tofu in packs of 300 g for four.
    const packed = alike.map((one) => ({
      ...one,
      pack: one.topping.key === 'turkey' ? { size: 500, keepDays: 2 } : { size: 300, keepDays: 4 },
    }));
    const topped = topAssignments(
      [day, day, day],
      recipes,
      sized,
      energyShares(HIGH_PROTEIN)!,
      (meal) => (meal.slot === 'lunch' ? PLATE : null),
      packed,
      () => anyone,
      packKitchen(new Map(), 3),
    );
    // The second day takes from the pack the first opened; by the third it no longer keeps.
    expect(topped.flatMap((one) => (one.topping ? [one.topping.key] : []))).toEqual([
      'turkey',
      'turkey',
      'tofu',
    ]);
  });
});

describe('the kinds of protein a day has no more meals of', () => {
  const meals = [
    { dayIndex: 0, recipeId: 'omelette' },
    { dayIndex: 0, recipeId: 'salmon' },
    { dayIndex: 3, recipeId: 'omelette' },
    { dayIndex: 9, recipeId: 'omelette' },
  ];
  const kindsOf = (recipeId: string) => (recipeId === 'omelette' ? ['eggs'] : ['fish']);

  it('are those its day, or seven days it is one of, hold as many meals of as their limits allow', () => {
    expect(fullKindsOn(0, meals, kindsOf, new Map([['fish', { perDay: 1 }]]))).toEqual(
      new Set(['fish']),
    );
    expect(fullKindsOn(1, meals, kindsOf, new Map([['fish', { perDay: 1 }]]))).toEqual(new Set());
    // Days 0 and 3 hold eggs: day 6 is in their seven days, day 10 in none that holds two.
    expect(fullKindsOn(6, meals, kindsOf, new Map([['eggs', { perWeek: 2 }]]))).toEqual(
      new Set(['eggs']),
    );
    expect(fullKindsOn(10, meals, kindsOf, new Map([['eggs', { perWeek: 2 }]]))).toEqual(new Set());
  });
});
