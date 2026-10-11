// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What every plan the optimiser makes has to hold, whatever the seed: the
 * days keep to their targets, the limits hold across meals, and limits give
 * way in one order and only when they may.
 */
import type { MealType } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import {
  OptimizerError,
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

describe('the limits of a plan', () => {
  /** Dishes that go at lunch and at dinner alike: what a limit counted per meal would let through twice as often. */
  const eitherMeal = Array.from({ length: 6 }, (_, i) => dish(`either-${i}`, ['lunch', 'dinner'], 560 + 20 * i));
  const recipes = [...CATALOGUE.filter((r) => r.mealTypes.includes('breakfast')), ...eitherMeal];
  const strict = (over: Partial<OptimizerInput> = {}) =>
    plan({ recipes, days: uniformDays(14, MEALS[3]!, 1900), allowRelaxations: new Set(), maxConsecutiveDaysSameMeal: 1, maxTimesPerWeekSameMeal: 3, ...over });

  it('count a recipe over all meals: never more than the weekly limit in any seven days, nor two days running', () => {
    for (let seed = 1; seed <= 15; seed += 1) {
      const result = optimisePlan(strict({ seed }));

      for (const recipe of eitherMeal) {
        const days = result.assignments.filter((a) => a.recipeId === recipe.id).map((a) => a.dayIndex);
        for (let start = 0; start <= 7; start += 1) {
          expect(days.filter((day) => day >= start && day < start + 7).length, `seed ${seed}, ${recipe.id}, from day ${start}`).toBeLessThanOrEqual(3);
        }
        expect(days.some((day, i) => i > 0 && day - days[i - 1]! === 1), `seed ${seed}, ${recipe.id} on two days running`).toBe(false);
      }
    }
  });

  it('keep a recipe from being eaten twice on one day, unless the plan is for cooking ahead', () => {
    const twiceADay = (result: OptimizerResult) =>
      Array.from({ length: 14 }, (_, day) => result.assignments.filter((a) => a.dayIndex === day).map((a) => a.recipeId)).some((ids) => new Set(ids).size < ids.length);

    for (let seed = 1; seed <= 15; seed += 1) expect(twiceADay(optimisePlan(strict({ seed }))), `seed ${seed}`).toBe(false);

    // One dish for both main meals, and cooking ahead: the same dish at lunch and at dinner is the point.
    const one = [...CATALOGUE.filter((r) => r.mealTypes.includes('breakfast')), eitherMeal[0]!];
    const ahead = optimisePlan(plan({ recipes: one, days: uniformDays(1, MEALS[3]!, 1900), mealPrepFriendly: true, allowRelaxations: new Set() }));
    expect(ahead.assignments.filter((a) => a.recipeId === 'either-0')).toHaveLength(2);
    expect(ahead.report.relaxations).toEqual([]);
  });

  /** What a plan was refused with, when limits would have had to give way that may not. */
  const refusalOf = (input: OptimizerInput): OptimizerError['blocked'] => {
    try {
      optimisePlan(input);
    } catch (err) {
      if (err instanceof OptimizerError) return err.blocked;
      throw err;
    }
    return undefined;
  };

  it('refuse the plan when limits would have to give way that may not, and say at which meals and which limits', () => {
    // Two dishes for lunch, and a limit of once in the whole plan: the third day and the fourth have none left.
    const two = [dish('b', ['breakfast'], 500), dish('l1', ['lunch'], 700), dish('l2', ['lunch'], 720), dish('d', ['dinner'], 600)];
    const input = plan({ recipes: two, days: uniformDays(4, ['lunch'], 700), maxRepeatsPerRecipe: 1, maxConsecutiveDaysSameMeal: 4, allowRelaxations: new Set() });

    expect(refusalOf(input)).toEqual({
      needs: ['variety_floor'],
      meals: [
        { dayIndex: 2, slot: 'lunch', gaveWay: ['variety_floor'] },
        { dayIndex: 3, slot: 'lunch', gaveWay: ['variety_floor'] },
      ],
    });
    // The same plan is made once that limit may give way.
    expect(optimisePlan({ ...input, allowRelaxations: new Set(['variety_floor']) }).assignments).toHaveLength(4);
  });

  it('name, of the limits that gave way at a meal, the ones that may not', () => {
    // One lunch dish, over the cooking time of every day: on the second day it is also eaten two days running.
    const days = [
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 },
    ];
    const input = plan({ recipes: [dish('slow', ['lunch'], 700, { totalMinutes: 90 })], days, maxConsecutiveDaysSameMeal: 1, allowRelaxations: new Set(['cook_time']) });

    expect(refusalOf(input)).toEqual({
      needs: ['consecutive_days'],
      meals: [{ dayIndex: 1, slot: 'lunch', gaveWay: ['cook_time', 'consecutive_days'] }],
    });
  });

  it('let limits give way in one order, the fewest that fill the meal, and say what gave way', () => {
    // One lunch dish is over the cooking time; the other was eaten yesterday and may not be eaten two days running.
    const lunches = [dish('slow', ['lunch'], 700, { totalMinutes: 90 }), dish('quick', ['lunch'], 700)];
    const days = [
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 },
    ];

    const result = optimisePlan(plan({ recipes: lunches, days, maxConsecutiveDaysSameMeal: 1 }));

    // The cooking time gives way before the days in a row do.
    expect(result.assignments.map((a) => a.recipeId)).toEqual(['quick', 'slow']);
    expect(result.report.relaxations).toEqual([{ dayIndex: 1, slot: 'lunch', gaveWay: ['cook_time'] }]);
    expect(refusalOf(plan({ recipes: lunches, days, maxConsecutiveDaysSameMeal: 1, allowRelaxations: new Set() }))?.needs).toEqual(['cook_time']);
  });

  it('let a limit that may give way do so before one that may not, whatever their order', () => {
    const lunches = [dish('slow', ['lunch'], 700, { totalMinutes: 90 }), dish('quick', ['lunch'], 700)];
    const days = [
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 },
    ];

    // The cooking time is to hold: the quick dish is eaten two days running instead.
    const result = optimisePlan(plan({ recipes: lunches, days, maxConsecutiveDaysSameMeal: 1, allowRelaxations: new Set(['consecutive_days']) }));

    expect(result.assignments.map((a) => a.recipeId)).toEqual(['quick', 'quick']);
    expect(result.report.relaxations).toEqual([{ dayIndex: 1, slot: 'lunch', gaveWay: ['consecutive_days'] }]);
  });

  it('take, of the recipes outside the limits, one that is outside fewer, and say of the meal the limits of its own recipe', () => {
    // Two dishes for three meals of one day, one of them over the cooking time. By the last meal both
    // were eaten today: the quick one is outside one limit, the slow one outside that and another.
    const meals: MealType[] = ['lunch', 'dinner', 'snack'];
    const dishes = [dish('quick', meals, 600), dish('slow', meals, 600, { totalMinutes: 90 })];
    const days = [{ mealSlots: meals, dailyCalorieTarget: 1800, cookTimeBudgetMinutes: 30 }];

    for (let seed = 1; seed <= 40; seed += 1) {
      const result = optimisePlan(plan({ recipes: dishes, days, seed }));
      expect(result.assignments.find((a) => a.slot === 'snack')!.recipeId, `seed ${seed}`).toBe('quick');
      expect(result.report.relaxations.find((entry) => entry.slot === 'snack')!.gaveWay, `seed ${seed}`).toEqual(['same_day']);
    }
  });

  it('take a recipe outside any number of earlier limits before one outside a later limit', () => {
    // On the second day the slow dish is over the cooking time and at its most for the plan; the quick one would be eaten two days running.
    const lunches = [dish('slow', ['lunch'], 700, { totalMinutes: 90 }), dish('quick', ['lunch'], 700)];
    const days = [
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, lockedSlots: [{ slot: 'lunch' as const, recipeId: 'slow' }] },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, lockedSlots: [{ slot: 'lunch' as const, recipeId: 'quick' }] },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 },
    ];

    const result = optimisePlan(plan({ recipes: lunches, days, maxRepeatsPerRecipe: 1, maxConsecutiveDaysSameMeal: 1 }));

    expect(result.assignments[2]!.recipeId).toBe('slow');
    expect(result.report.relaxations).toEqual([{ dayIndex: 2, slot: 'lunch', gaveWay: ['variety_floor', 'cook_time'] }]);
  });

  it('prefer the recipe used least so far when a limit gives way', () => {
    // Three lunch dishes, each allowed once; on the fourth day all are at the limit, and one of them was locked in twice already.
    const lunches = [dish('a', ['lunch'], 700), dish('b', ['lunch'], 700), dish('c', ['lunch'], 700)];
    const days = [
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, lockedSlots: [{ slot: 'lunch' as const, recipeId: 'a' }] },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, lockedSlots: [{ slot: 'lunch' as const, recipeId: 'a' }] },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, lockedSlots: [{ slot: 'lunch' as const, recipeId: 'b' }] },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700, lockedSlots: [{ slot: 'lunch' as const, recipeId: 'c' }] },
      { mealSlots: ['lunch' as const], dailyCalorieTarget: 700 },
    ];

    for (let seed = 1; seed <= 10; seed += 1) {
      const result = optimisePlan(plan({ recipes: lunches, days, maxRepeatsPerRecipe: 1, seed }));
      expect(['b', 'c']).toContain(result.assignments[4]!.recipeId);
      expect(result.report.relaxations).toEqual([{ dayIndex: 4, slot: 'lunch', gaveWay: ['variety_floor'] }]);
    }
  });

  it('take a dish that cannot reach its share before a limit gives way', () => {
    // The small dish stays far under the budget at its largest serving; the big one may be eaten once.
    const lunches = [dish('big', ['lunch'], 700), dish('small', ['lunch'], 150)];

    const result = optimisePlan(plan({ recipes: lunches, days: uniformDays(2, ['lunch'], 700), maxRepeatsPerRecipe: 1, allowRelaxations: new Set() }));

    expect(result.assignments.map((a) => a.recipeId)).toEqual(['big', 'small']);
    expect(result.report.relaxations).toEqual([]);
  });

  it('find the plan inside the limits where one order of choices would run out of recipes', () => {
    // A small catalogue: three breakfasts, three dishes for lunch and dinner alike, two for dinner alone.
    // A week inside the limits exists, and a run that spends the shared dishes on dinners early has no lunch left.
    const small = [
      ...[420, 460, 520].map((kcal, i) => dish(`breakfast-${i}`, ['breakfast'], kcal)),
      ...[540, 600, 660].map((kcal, i) => dish(`shared-${i}`, ['lunch', 'dinner'], kcal)),
      ...[580, 640].map((kcal, i) => dish(`dinner-${i}`, ['dinner'], kcal)),
    ];

    for (let seed = 1; seed <= 200; seed += 1) {
      const input = plan({ recipes: small, days: uniformDays(7, MEALS[3]!, 2000), maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3, allowRelaxations: new Set(), seed });
      expect(refusalOf(input), `seed ${seed}`).toBeUndefined();
    }
  });

  it('report the meals that had one recipe to choose from', () => {
    const recipes = [dish('only-breakfast', ['breakfast'], 500), ...CATALOGUE.filter((r) => !r.mealTypes.includes('breakfast'))];

    const { report } = optimisePlan(plan({ recipes, days: uniformDays(2, MEALS[3]!, 2000) }));

    expect(report.singleCandidate).toEqual([
      { dayIndex: 0, slot: 'breakfast' },
      { dayIndex: 1, slot: 'breakfast' },
    ]);
  });
});

describe('meals that are in the plan already and stay', () => {
  const lunch = (kept?: string): OptimizerInput['days'][number] =>
    kept ? { mealSlots: [], dailyCalorieTarget: 700, kept: [{ recipeId: kept, calories: 700 }] } : { mealSlots: ['lunch'], dailyCalorieTarget: 700 };
  const lunches = ['a', 'b', 'c'].map((id) => dish(id, ['lunch'], 700));
  const strict = (over: Partial<OptimizerInput>) => plan({ recipes: lunches, allowRelaxations: new Set(), ...over });

  it('are not chosen again: only the meals to fill are in the answer', () => {
    const result = optimisePlan(strict({ days: [lunch('a'), lunch(), lunch('b')] }));

    expect(result.assignments.map((a) => [a.dayIndex, a.slot])).toEqual([[1, 'lunch']]);
  });

  it('count for the days in a row, on the days before and on the days after', () => {
    // Twice running before the open day, and twice running after it: a third day in a row either way is one too many.
    const days = [lunch(), lunch('a'), lunch('a'), lunch(), lunch('b'), lunch('b'), lunch()];

    for (let seed = 1; seed <= 30; seed += 1) {
      const result = optimisePlan(strict({ days, maxConsecutiveDaysSameMeal: 2, seed }));
      expect(result.assignments.find((a) => a.dayIndex === 3)!.recipeId, `seed ${seed}`).toBe('c');
    }
  });

  it('count for the limit of seven days in every seven days that hold the day', () => {
    // The fourth day is open. One dish is eaten the day before and the day after it, another on the sixth
    // day and the ninth: either would be eaten a third time within seven days. The other days hold dishes of their own.
    const days = ['x0', 'x1', 'a', undefined, 'a', 'c', 'x6', 'x7', 'c', 'x9'].map((kept) => lunch(kept));

    for (let seed = 1; seed <= 30; seed += 1) {
      const result = optimisePlan(strict({ days, maxTimesPerWeekSameMeal: 2, maxConsecutiveDaysSameMeal: 7, seed }));
      expect(result.assignments.map((a) => a.recipeId), `seed ${seed}`).toEqual(['b']);
    }
    // Where the only dish is eaten on the two days that follow, the plan is refused for the open day.
    const onlyOne = strict({ recipes: lunches.slice(0, 1), days: [lunch(), lunch('a'), lunch('a')], maxTimesPerWeekSameMeal: 2, maxConsecutiveDaysSameMeal: 7 });
    expect(() => optimisePlan(onlyOne)).toThrow(OptimizerError);
  });

  it('count for the most times a recipe appears in the plan, and for once a day', () => {
    const everyMeal: MealType[] = ['breakfast', 'lunch', 'dinner'];
    const dishes = ['a', 'b', 'c'].map((id) => dish(id, everyMeal, 600));

    for (let seed = 1; seed <= 20; seed += 1) {
      // One of the three is on the plate already today: the two meals to fill take the other two.
      const sameDay = optimisePlan(plan({ recipes: dishes, days: [{ mealSlots: ['lunch', 'dinner'], dailyCalorieTarget: 1800, kept: [{ recipeId: 'a', calories: 600 }] }], allowRelaxations: new Set(), seed }));
      expect(sameDay.assignments.map((a) => a.recipeId).sort(), `seed ${seed}`).toEqual(['b', 'c']);

      // Each may appear once in the plan, and two already do.
      const once = optimisePlan(strict({ days: [lunch('a'), lunch(), lunch('b')], maxRepeatsPerRecipe: 1, seed }));
      expect(once.assignments[0]!.recipeId, `seed ${seed}`).toBe('c');
    }
  });

  it('take what they hold from the day before the other meals are budgeted', () => {
    // A breakfast of 1200 kcal was eaten: lunch and dinner share the 800 that are left.
    const days = [{ mealSlots: ['lunch' as const, 'dinner' as const], dailyCalorieTarget: 2000, kept: [{ recipeId: 'eaten', calories: 1200 }] }];

    for (let seed = 1; seed <= 25; seed += 1) {
      const result = optimisePlan(plan({ days, seed }));
      const filled = result.assignments.reduce((sum, a) => sum + CATALOGUE.find((r) => r.id === a.recipeId)!.caloriesPerServing * a.servings, 0);
      expect(Math.abs(1200 + filled - 2000), `seed ${seed}: ${filled} kcal in the two meals`).toBeLessThanOrEqual(200);
    }
  });

  it('count in the reuse of ingredients, as recipes of the plan', () => {
    const shared = [dish('a', ['lunch'], 700, { ingredientIds: ['rice', 'beans'] }), dish('b', ['lunch'], 700, { ingredientIds: ['rice', 'lentils'] })];

    const result = optimisePlan(plan({ recipes: shared, days: [lunch('a'), lunch()], maxConsecutiveDaysSameMeal: 1, allowRelaxations: new Set() }));

    // Rice is in both recipes of the plan, beans and lentils in one each.
    expect(result.assignments[0]!.recipeId).toBe('b');
    expect(result.ingredientReuseScore).toBeCloseTo(1 / 3);
  });
});

describe('the most of one ingredient in seven days', () => {
  const amounts = (lines: Record<string, number>) => ({ amounts: new Map(Object.entries(lines)), ingredientIds: Object.keys(lines) });
  /** Three dishes with 200 g of eggs in a serving and three without, for every meal of the day. */
  const meals: MealType[] = ['breakfast', 'lunch', 'dinner'];
  const dishes = [
    ...[0, 1, 2].map((i) => dish(`eggs-${i}`, meals, 620 + 20 * i, amounts({ eggs: 200, [`bread-${i}`]: 80 }))),
    ...[0, 1, 2].map((i) => dish(`beans-${i}`, meals, 600 + 20 * i, amounts({ [`beans-${i}`]: 250, [`rice-${i}`]: 70 }))),
  ];
  /** How much of the ingredient the meals of each seven days of the plan hold, at most. */
  const mostInSevenDays = (result: OptimizerResult, ingredient: string, days: number): number => {
    const perDay = Array.from({ length: days }, (_, day) =>
      result.assignments.filter((a) => a.dayIndex === day).reduce((sum, a) => sum + (dishes.find((d) => d.id === a.recipeId)!.amounts!.get(ingredient) ?? 0) * a.servings, 0),
    );
    return Math.max(...perDay.map((_, first) => perDay.slice(first, first + 7).reduce((sum, grams) => sum + grams, 0)));
  };
  const limited = (over: Partial<OptimizerInput> = {}) =>
    plan({ recipes: dishes, days: uniformDays(14, meals, 1900), maxIngredientPerWeek: 1500, maxConsecutiveDaysSameMeal: 7, maxTimesPerWeekSameMeal: 7, allowRelaxations: new Set(), ...over });

  it('holds over all meals, with the servings they are given', () => {
    let without = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      expect(mostInSevenDays(optimisePlan(limited({ seed })), 'eggs', 14), `seed ${seed}`).toBeLessThanOrEqual(1500);
      without = Math.max(without, mostInSevenDays(optimisePlan(limited({ seed, maxIngredientPerWeek: undefined })), 'eggs', 14));
    }
    // Without the limit the same plans hold more than that: the limit is what kept them under.
    expect(without).toBeGreaterThan(1500);
  });

  it('counts what stays in the plan, with its servings', () => {
    // Six days hold an egg dish of one and a half servings: 1800 g. With the smallest serving of another, the week would hold 1900.
    const stay = { mealSlots: [] as MealType[], dailyCalorieTarget: 1900, kept: [{ recipeId: 'eggs-0', calories: 930, servings: 1.5 }] };
    const days = [stay, stay, stay, { mealSlots: meals, dailyCalorieTarget: 1900 }, stay, stay, stay];

    for (let seed = 1; seed <= 20; seed += 1) {
      const result = optimisePlan(limited({ days, maxIngredientPerWeek: 1850, allowRelaxations: 'all', seed }));
      expect(result.assignments.map((a) => a.recipeId).filter((id) => id.startsWith('eggs')), `seed ${seed}`).toEqual([]);
      expect(result.report.relaxations).toEqual([]);
    }
  });

  it('gives way last, and only when it may', () => {
    // Nothing but egg dishes, one of them slow: by the last day every dish would take the week over the limit.
    const onlyEggs = [dish('eggs-quick', ['lunch'], 700, amounts({ eggs: 200 })), dish('eggs-slow', ['lunch'], 700, { ...amounts({ eggs: 200 }), totalMinutes: 90 })];
    const days = Array.from({ length: 4 }, () => ({ mealSlots: ['lunch' as const], dailyCalorieTarget: 700, cookTimeBudgetMinutes: 30 }));
    const input = plan({ recipes: onlyEggs, days, maxIngredientPerWeek: 600, maxConsecutiveDaysSameMeal: 7, maxTimesPerWeekSameMeal: 7 });

    const result = optimisePlan(input);
    // The cooking time is no way round the limit on the eggs: the quick dish is taken and the limit gives way alone.
    expect(result.assignments.map((a) => a.recipeId)).toEqual(['eggs-quick', 'eggs-quick', 'eggs-quick', 'eggs-quick']);
    expect(result.report.relaxations).toEqual([{ dayIndex: 3, slot: 'lunch', gaveWay: ['ingredient_cap'] }]);

    let refusal: OptimizerError | undefined;
    try {
      optimisePlan({ ...input, allowRelaxations: new Set(['cook_time', 'weekly_cap']) });
    } catch (err) {
      refusal = err as OptimizerError;
    }
    expect(refusal?.blocked?.needs).toEqual(['ingredient_cap']);
  });

  it('does not see a recipe whose amounts are not known', () => {
    const unknown = [dish('a', ['lunch'], 700), dish('b', ['lunch'], 700)];

    const result = optimisePlan(plan({ recipes: unknown, days: uniformDays(7, ['lunch'], 700), maxIngredientPerWeek: 1, allowRelaxations: new Set(), maxConsecutiveDaysSameMeal: 7, maxTimesPerWeekSameMeal: 7 }));

    expect(result.assignments).toHaveLength(7);
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

  it('makes one plan for one seed, and this is the plan for seed 7', () => {
    const result = optimisePlan(plan({ days: uniformDays(4, MEALS[4]!, 2100), seed: 7, maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3 }));

    expect(result).toEqual(optimisePlan(plan({ days: uniformDays(4, MEALS[4]!, 2100), seed: 7, maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3 })));
    expect(result.assignments.map((a) => `${a.dayIndex} ${a.slot} ${a.recipeId} ×${a.servings}`)).toMatchInlineSnapshot(`
      [
        "0 breakfast breakfast-3 ×1.25",
        "0 lunch main-5 ×1",
        "0 dinner dinner-0 ×1.5",
        "0 snack snack-3 ×0.75",
        "1 breakfast breakfast-5 ×1",
        "1 lunch lunch-2 ×1.25",
        "1 dinner dinner-1 ×1.25",
        "1 snack second-0 ×1",
        "2 breakfast breakfast-2 ×1.25",
        "2 lunch main-5 ×1",
        "2 dinner main-2 ×1.25",
        "2 snack snack-0 ×1.5",
        "3 breakfast breakfast-1 ×1.5",
        "3 lunch lunch-1 ×1.5",
        "3 dinner dinner-0 ×1.5",
        "3 snack second-2 ×0.75",
      ]
    `);
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
