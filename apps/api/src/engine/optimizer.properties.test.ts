// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What every plan the optimiser makes has to hold, whatever the seed: the
 * days keep to their targets.
 */
import type { MealType } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import {
  calorieFit,
  optimisePlan,
  reuseScore,
  seededJitter,
  uniformDays,
  type OptimizerInput,
  type OptimizerRecipe,
  type OptimizerResult,
} from './optimizer.js';

const dish = (id: string, mealTypes: MealType[], kcal: number, over: Partial<OptimizerRecipe> = {}): OptimizerRecipe => ({
  id,
  mealTypes,
  dietTags: [],
  caloriesPerServing: kcal,
  proteinPerServing: 20,
  fatPerServing: 15,
  carbsPerServing: 40,
  ingredientIds: [`${id}-a`, `${id}-b`],
  difficulty: 'easy',
  isFavorite: false,
  totalMinutes: 20,
  ...over,
});

/** A catalogue as a small instance has one: a handful of dishes for each meal, some for two meals. */
const CATALOGUE: OptimizerRecipe[] = [
  ...[320, 380, 410, 450, 500, 540].map((kcal, i) => dish(`breakfast-${i}`, ['breakfast'], kcal)),
  ...[180, 210, 240, 280].map((kcal, i) => dish(`second-${i}`, ['second_breakfast', 'snack'], kcal)),
  ...[480, 520, 560, 610, 650, 700].map((kcal, i) => dish(`main-${i}`, ['lunch', 'dinner'], kcal)),
  ...[430, 470, 590].map((kcal, i) => dish(`lunch-${i}`, ['lunch'], kcal)),
  ...[440, 500, 620].map((kcal, i) => dish(`dinner-${i}`, ['dinner'], kcal)),
  ...[120, 150, 190, 230].map((kcal, i) => dish(`snack-${i}`, ['snack'], kcal)),
];

const MEALS: Record<number, MealType[]> = {
  2: ['breakfast', 'dinner'],
  3: ['breakfast', 'lunch', 'dinner'],
  4: ['breakfast', 'lunch', 'dinner', 'snack'],
  5: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
};

const plan = (over: Partial<OptimizerInput> = {}): OptimizerInput => ({
  recipes: CATALOGUE,
  days: uniformDays(14, MEALS[3]!, 2000),
  targetMacros: { protein: 120, fat: 60, carbs: 220 },
  dietType: 'balanced',
  mealPrepFriendly: false,
  seed: 1,
  ...over,
});

const kcalOfDay = (result: OptimizerResult, recipes: OptimizerRecipe[], day: number): number =>
  result.assignments
    .filter((a) => a.dayIndex === day)
    .reduce((sum, a) => sum + recipes.find((r) => r.id === a.recipeId)!.caloriesPerServing * a.servings, 0);

describe('the fit of a meal to its budget', () => {
  it('costs nothing inside a tenth of the budget, either way', () => {
    expect(calorieFit(600, 600)).toBe(1);
    expect(calorieFit(540, 600)).toBe(1);
    expect(calorieFit(660, 600)).toBe(1);
  });

  it('costs more the further outside the meal is, in a straight line', () => {
    expect(calorieFit(720, 600)).toBeCloseTo(1 - 0.1 / 0.9, 6);
    expect(calorieFit(480, 600)).toBeCloseTo(1 - 0.1 / 0.9, 6);
    expect(calorieFit(900, 600)).toBeCloseTo(1 - 0.4 / 0.9, 6);
    expect(calorieFit(1200, 600)).toBe(0);
    expect(calorieFit(5000, 600)).toBe(0);
  });
});

describe('the days of a plan', () => {
  it.each([
    [2, 1800],
    [3, 1500],
    [3, 2000],
    [4, 2200],
    [5, 1700],
    [5, 2800],
  ])('are each inside a tenth of their target, with %i meals and %i kcal, whatever the seed', (meals, target) => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const input = plan({ days: uniformDays(14, MEALS[meals]!, target), seed, maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3 });

      const result = optimisePlan(input);

      for (let day = 0; day < 14; day += 1) {
        const kcal = kcalOfDay(result, CATALOGUE, day);
        expect(Math.abs(kcal - target) / target, `seed ${seed}, day ${day}: ${kcal} kcal`).toBeLessThanOrEqual(0.1);
      }
    }
  });

  it('make up at the next meals for a meal that ran far over, and leave the snack what is left', () => {
    // A locked lunch whose smallest serving is 1200 kcal, on a day of 2000 with four meals.
    const days = [{ mealSlots: MEALS[4]!, dailyCalorieTarget: 2000, lockedSlots: [{ slot: 'lunch' as const, recipeId: 'feast' }] }];
    const recipes = [...CATALOGUE, dish('feast', ['lunch'], 2400)];
    const kcalOf = (result: OptimizerResult, slot: MealType) => {
      const meal = result.assignments.find((a) => a.slot === slot)!;
      return recipes.find((r) => r.id === meal.recipeId)!.caloriesPerServing * meal.servings;
    };

    for (let seed = 1; seed <= 10; seed += 1) {
      const result = optimisePlan(plan({ recipes, days, seed }));

      // With a fixed share for every meal the day would have ended near 2500.
      expect(Math.abs(kcalOfDay(result, recipes, 0) - 2000), `seed ${seed}`).toBeLessThanOrEqual(200);
      expect(kcalOf(result, 'lunch')).toBe(1200);
      // Breakfast and dinner took less than their shares of an empty day, 500 and 600.
      expect(kcalOf(result, 'breakfast')).toBeLessThan(400);
      expect(kcalOf(result, 'dinner')).toBeLessThan(450);
      // The meals come back in the order of the day, not in the order they were filled in.
      expect(result.assignments.map((a) => a.slot)).toEqual(MEALS[4]);
    }
  });

  it('make up for a meal that cannot reach its share: light lunches leave more for dinner and the snack', () => {
    // Three servings of the largest lunch are 480 kcal, where the lunch of a day of 2000 would be 700.
    const recipes = [...CATALOGUE.filter((r) => !r.mealTypes.includes('lunch')), dish('salad', ['lunch'], 140), dish('soup', ['lunch'], 160)];

    for (let seed = 1; seed <= 20; seed += 1) {
      const result = optimisePlan(plan({ recipes, days: uniformDays(7, MEALS[4]!, 2000), seed, maxConsecutiveDaysSameMeal: 7, maxTimesPerWeekSameMeal: 7 }));

      for (let day = 0; day < 7; day += 1) {
        // With a fixed share for every meal each day would have ended about 220 kcal short, outside the tenth.
        expect(Math.abs(kcalOfDay(result, recipes, day) - 2000), `seed ${seed}, day ${day}`).toBeLessThanOrEqual(200);
      }
    }
  });

  it('do not take a dish that stays far under the budget even at the largest serving', () => {
    // Three servings of the broth are 180 kcal; the lunch of this day wants about 700.
    const recipes = [dish('broth', ['lunch'], 60), dish('stew', ['lunch'], 650), ...CATALOGUE.filter((r) => !r.mealTypes.includes('lunch'))];

    for (let seed = 1; seed <= 10; seed += 1) {
      const result = optimisePlan(plan({ recipes, days: uniformDays(1, MEALS[3]!, 2000), seed }));
      expect(result.assignments.find((a) => a.slot === 'lunch')!.recipeId).toBe('stew');
    }
  });
});

describe('the seed of a plan', () => {
  it('gives each recipe an offset under 0.12 that is the same for the same seed', () => {
    for (const seed of [0, 1, 7, 2 ** 31 - 1, 2 ** 32 - 1, 123456789]) {
      const offset = seededJitter('main-3', seed);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(0.12);
      expect(seededJitter('main-3', seed)).toBe(offset);
    }
  });

  it('spreads the offsets of the recipes, and changes them all with the seed', () => {
    const ids = CATALOGUE.map((r) => r.id);
    const offsets = (seed: number) => ids.map((id) => seededJitter(id, seed));
    // Not all alike for one seed, and not in the same order for the next.
    expect(new Set(offsets(1).map((o) => o.toFixed(4))).size).toBeGreaterThan(ids.length * 0.8);
    const order = (seed: number) => [...ids].sort((a, b) => seededJitter(a, seed) - seededJitter(b, seed)).join(',');
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(order)).size).toBe(8);
    // Seeds that differ only in their high bits give different offsets: none of the seed is lost.
    expect(seededJitter('main-3', 1)).not.toBe(seededJitter('main-3', 1 + 2 ** 31));
  });
});

describe('the reuse of ingredients in a plan', () => {
  const eggs = dish('eggs', ['breakfast'], 400, { ingredientIds: ['egg', 'butter'] });
  const omelette = dish('omelette', ['lunch'], 600, { ingredientIds: ['egg', 'cheese'] });
  const at = (dayIndex: number, recipeId: string) => ({ dayIndex, slot: 'breakfast' as const, recipeId, servings: 1 });

  it('is the share of ingredients that more than one recipe uses', () => {
    expect(reuseScore([at(0, 'eggs'), at(0, 'omelette')], [eggs, omelette])).toBeCloseTo(1 / 3, 6);
  });

  it('does not count a recipe that is eaten again as reuse', () => {
    expect(reuseScore([at(0, 'eggs'), at(1, 'eggs'), at(2, 'eggs')], [eggs, omelette])).toBe(0);
  });
});
