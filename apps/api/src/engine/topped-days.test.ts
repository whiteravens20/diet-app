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
import { fullKindsOn, topAndSizeDay, topAssignments } from './topped-days.js';
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
