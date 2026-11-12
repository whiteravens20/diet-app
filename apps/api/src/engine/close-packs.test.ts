// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealType, ProteinKind } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { closePacks, packKitchen, type ClosingPlan } from './close-packs.js';
import { macroSplitOf } from './nutrition.js';
import type { OptimizerDay, OptimizerRecipe } from './optimizer.js';
import { packsLeft, packUse, type Pack } from './packs.js';
import type { SizedAssignment } from './rebalance.js';

/** Chicken in packs of 500 g that keep two days once opened. */
const PACKS = new Map<string, Pack>([['chicken', { size: 500, keepDays: 2 }]]);
const SPLIT = macroSplitOf('balanced');

/** A recipe whose energy is split as `shares` (the balanced split when left out), taking `of` of the packs a serving. */
const recipe = (
  id: string,
  mealTypes: MealType[],
  calories: number,
  of: Record<string, number> = {},
  more: Partial<OptimizerRecipe> & {
    shares?: { protein: number; fat: number; carbs: number };
  } = {},
): OptimizerRecipe => {
  const { shares = SPLIT, ...rest } = more;
  return {
    id,
    slug: id,
    mealTypes,
    dietTags: [],
    caloriesPerServing: calories,
    proteinPerServing: (calories * shares.protein) / 4,
    fatPerServing: (calories * shares.fat) / 9,
    carbsPerServing: (calories * shares.carbs) / 4,
    ingredientIds: Object.keys(of),
    amounts: new Map(Object.entries(of)),
    difficulty: 'easy',
    isFavorite: false,
    totalMinutes: 20,
    ...rest,
  };
};

/** A lunch of chicken that takes 250 g a serving, a dinner without anything that does not keep, and one with 250 g of chicken. */
const chickenRice = recipe('chicken-rice', ['lunch'], 500, { chicken: 250 });
const lentilSoup = recipe('lentil-soup', ['dinner'], 500, { lentils: 120 });
const chickenSalad = recipe('chicken-salad', ['dinner'], 500, { chicken: 250 });
const RECIPES = [chickenRice, lentilSoup, chickenSalad];

const days = (count: number, more: Partial<OptimizerDay> = {}): OptimizerDay[] =>
  Array.from({ length: count }, () => ({
    mealSlots: ['lunch', 'dinner'] as MealType[],
    dailyCalorieTarget: 1000,
    ...more,
  }));
const placed = (
  dayIndex: number,
  slot: MealType,
  recipeId: string,
  servings = 1,
  quantityScale = 1,
): SizedAssignment => ({ dayIndex, slot, recipeId, servings, quantityScale });

const plan = (more: Partial<ClosingPlan> = {}): ClosingPlan => ({
  recipes: RECIPES,
  days: days(1),
  assignments: [placed(0, 'lunch', 'chicken-rice'), placed(0, 'dinner', 'lentil-soup')],
  split: SPLIT,
  dietType: 'balanced',
  mealPrepFriendly: false,
  limits: { consecutive: 7, perWeek: 7 },
  ...more,
});
const recipesOf = (meals: readonly SizedAssignment[]) => meals.map((meal) => meal.recipeId);

/** What the chicken of these meals leaves, in packs: each meal on its own day. */
const chickenLeft = (
  meals: readonly SizedAssignment[],
  count: number,
  recipes = RECIPES,
): number => {
  const row = Array.from({ length: count }, () => 0);
  for (const meal of meals) {
    const own = recipes.find((one) => one.id === meal.recipeId)!;
    row[meal.dayIndex]! += (own.amounts?.get('chicken') ?? 0) * meal.servings * meal.quantityScale;
  }
  return packsLeft(packUse(new Map([['chicken', row]]), PACKS));
};

describe('closing the packs of a plan', () => {
  it('gives a meal the recipe that finishes the pack another meal opened', () => {
    const before = plan();
    expect(chickenLeft(before.assignments, 1)).toBe(0.5);

    const [after] = closePacks({ plans: [before], packs: PACKS });

    expect(recipesOf(after!)).toEqual(['chicken-rice', 'chicken-salad']);
    expect(chickenLeft(after!, 1)).toBe(0);
  });

  it('keeps the energy of the meal it swaps, at a serving within a tenth of it', () => {
    const lighter = recipe('chicken-wrap', ['dinner'], 400, { chicken: 140 });
    const [after] = closePacks({
      plans: [
        plan({
          recipes: [chickenRice, lentilSoup, lighter],
          assignments: [
            placed(0, 'lunch', 'chicken-rice'),
            placed(0, 'dinner', 'lentil-soup', 1.5, 0.9),
          ],
        }),
      ],
      packs: PACKS,
    });

    const dinner = after![1]!;
    expect(dinner.recipeId).toBe('chicken-wrap');
    // The soup held 500 × 1.5 × 0.9 = 675 kcal: the wrap at 1.75 servings holds 700, and its portion brings it to 675,
    // to the hundredth of a portion.
    expect(dinner.servings).toBe(1.75);
    expect(dinner.quantityScale).toBe(0.96);
    expect(Math.abs(400 * dinner.servings * dinner.quantityScale - 675)).toBeLessThan(675 * 0.01);
  });

  it('swaps nothing for less than a spoonful of a pack', () => {
    // The lunch takes 480 g: 20 g are left, a twenty-fifth of the pack.
    const big = recipe('chicken-rice', ['lunch'], 500, { chicken: 480 });
    const [after] = closePacks({
      plans: [
        plan({
          recipes: [big, lentilSoup, recipe('chicken-broth', ['dinner'], 500, { chicken: 20 })],
        }),
      ],
      packs: PACKS,
    });

    expect(recipesOf(after!)).toEqual(['chicken-rice', 'lentil-soup']);
  });

  it('counts what stays in the plan with the meals it places', () => {
    // A meal that stays takes the other 250 g of the pack on the same day: nothing is left to close.
    const fixed = new Map([['chicken', [250]]]);
    const [after] = closePacks({ plans: [plan()], packs: PACKS, fixed });

    expect(recipesOf(after!)).toEqual(['chicken-rice', 'lentil-soup']);
  });

  it('leaves a meal locked to its place, a favourite, and a meal whose recipe is not offered', () => {
    const locked = plan({
      days: days(1, { lockedSlots: [{ slot: 'dinner', recipeId: 'lentil-soup' }] }),
    });
    expect(recipesOf(closePacks({ plans: [locked], packs: PACKS })[0]!)).toEqual([
      'chicken-rice',
      'lentil-soup',
    ]);

    const favourite = plan({
      recipes: [chickenRice, { ...lentilSoup, isFavorite: true }, chickenSalad],
    });
    expect(recipesOf(closePacks({ plans: [favourite], packs: PACKS })[0]!)).toEqual([
      'chicken-rice',
      'lentil-soup',
    ]);

    const often = plan({
      recipes: [chickenRice, { ...lentilSoup, eatenOften: true }, chickenSalad],
    });
    expect(recipesOf(closePacks({ plans: [often], packs: PACKS })[0]!)).toEqual([
      'chicken-rice',
      'lentil-soup',
    ]);
  });

  it('brings in no recipe the day is to do without, the profile would rather not eat, or the diet does not admit', () => {
    const avoided = plan({ days: days(1, { avoid: new Set(['chicken-salad']) }) });
    expect(recipesOf(closePacks({ plans: [avoided], packs: PACKS })[0]!)).toEqual([
      'chicken-rice',
      'lentil-soup',
    ]);

    const disliked = plan({
      recipes: [
        chickenRice,
        lentilSoup,
        recipe('chicken-salad', ['dinner'], 500, { chicken: 250, celery: 40 }),
      ],
      dislikedIngredientIds: new Set(['celery']),
    });
    expect(recipesOf(closePacks({ plans: [disliked], packs: PACKS })[0]!)).toEqual([
      'chicken-rice',
      'lentil-soup',
    ]);

    const vegan = plan({
      dietType: 'vegan',
      recipes: [
        { ...chickenRice, dietTags: ['vegan'] },
        { ...lentilSoup, dietTags: ['vegan'] },
        chickenSalad,
      ],
    });
    expect(recipesOf(closePacks({ plans: [vegan], packs: PACKS })[0]!)).toEqual([
      'chicken-rice',
      'lentil-soup',
    ]);
  });

  it('keeps the day near its split: no further than 0.02 past where the planner left it', () => {
    // Half of the day's energy from a dinner that is half protein takes the day 0.15 off the balanced split.
    const lean = recipe(
      'chicken-salad',
      ['dinner'],
      500,
      { chicken: 250 },
      { shares: { protein: 0.5, fat: 0.3, carbs: 0.2 } },
    );
    const [after] = closePacks({
      plans: [plan({ recipes: [chickenRice, lentilSoup, lean] })],
      packs: PACKS,
    });

    expect(recipesOf(after!)).toEqual(['chicken-rice', 'lentil-soup']);
  });

  it('takes no less of what the pantry holds', () => {
    // The lentils of the soup are at home: a salad in its place would finish the chicken, and leave them there.
    const pantry = new Map([['lentils', 500]]);
    const [after] = closePacks({ plans: [plan()], packs: PACKS, pantry });
    expect(recipesOf(after!)).toEqual(['chicken-rice', 'lentil-soup']);

    // A pantry of what neither meal takes is no reason to keep the soup.
    const [other] = closePacks({ plans: [plan()], packs: PACKS, pantry: new Map([['oats', 500]]) });
    expect(recipesOf(other!)).toEqual(['chicken-rice', 'chicken-salad']);
  });

  it('keeps every limit of the plan: days in a row, times a week, a kind of protein a day', () => {
    // Chicken that keeps one day: the salad, the dinner of the second day, opens a pack of its own.
    const oneDay = new Map<string, Pack>([['chicken', { size: 500, keepDays: 1 }]]);
    const twoDays = {
      days: days(2),
      assignments: [
        placed(0, 'lunch', 'chicken-rice'),
        placed(0, 'dinner', 'lentil-soup'),
        placed(1, 'lunch', 'lentil-bowl'),
        placed(1, 'dinner', 'chicken-salad'),
      ],
      // The first lunch is a favourite, and stays.
      recipes: [
        { ...chickenRice, isFavorite: true },
        lentilSoup,
        chickenSalad,
        recipe('lentil-bowl', ['lunch'], 500, { lentils: 120 }),
      ],
    };
    expect(recipesOf(closePacks({ plans: [plan(twoDays)], packs: oneDay })[0]!)).toEqual([
      'chicken-rice',
      'chicken-salad',
      'chicken-rice',
      'chicken-salad',
    ]);
    const inARow = plan({ ...twoDays, limits: { consecutive: 1, perWeek: 7 } });
    expect(recipesOf(closePacks({ plans: [inARow], packs: oneDay })[0]!)).toEqual(
      recipesOf(twoDays.assignments),
    );
    const once = plan({ ...twoDays, limits: { consecutive: 7, perWeek: 1 } });
    expect(recipesOf(closePacks({ plans: [once], packs: oneDay })[0]!)).toEqual(
      recipesOf(twoDays.assignments),
    );

    const poultry: ProteinKind[] = ['chicken'];
    const kinds = plan({
      recipes: [
        { ...chickenRice, proteinKinds: poultry },
        lentilSoup,
        { ...chickenSalad, proteinKinds: poultry },
      ],
      limits: { consecutive: 7, perWeek: 7, perKind: new Map([['chicken', { perDay: 1 }]]) },
    });
    expect(recipesOf(closePacks({ plans: [kinds], packs: PACKS })[0]!)).toEqual([
      'chicken-rice',
      'lentil-soup',
    ]);
  });

  it('puts no recipe twice on one day where the plan does not allow it', () => {
    // A dinner of the lunch's own dish would finish the pack too.
    const both = recipe('chicken-rice', ['lunch', 'dinner'], 500, { chicken: 250 });
    const [after] = closePacks({ plans: [plan({ recipes: [both, lentilSoup] })], packs: PACKS });
    expect(recipesOf(after!)).toEqual(['chicken-rice', 'lentil-soup']);
  });

  it('swaps a dish cooked ahead at every meal it feeds, and cooks ahead as before', () => {
    const tray = recipe('chicken-tray', ['lunch'], 500, { chicken: 250 });
    const roast = recipe('chicken-roast', ['lunch'], 500, { chicken: 300 });
    const potatoes = recipe('potatoes', ['dinner'], 500, { potatoes: 300 });
    const recipes = [tray, roast, potatoes, lentilSoup];
    // Cooked on the first day for two: 600 g of a pack of 500 opens two and leaves 400 g.
    const ahead = plan({
      recipes,
      days: days(2),
      mealPrepFriendly: true,
      assignments: [
        placed(0, 'lunch', 'chicken-roast'),
        placed(0, 'dinner', 'potatoes'),
        placed(1, 'lunch', 'chicken-roast'),
        placed(1, 'dinner', 'lentil-soup'),
      ],
    });
    const [after] = closePacks({ plans: [ahead], packs: PACKS });

    expect(recipesOf(after!)).toEqual(['chicken-tray', 'potatoes', 'chicken-tray', 'lentil-soup']);
  });

  it('makes no dish cooked ahead of one that was not', () => {
    // Chicken that keeps one day: a salad on the first evening as well would finish the lunch's pack, and be cooked
    // on the first day for the second.
    const oneDay = new Map<string, Pack>([['chicken', { size: 500, keepDays: 1 }]]);
    const ahead = plan({
      recipes: [
        { ...chickenRice, isFavorite: true },
        lentilSoup,
        chickenSalad,
        recipe('lentil-bowl', ['lunch'], 500, { lentils: 120 }),
      ],
      days: days(2),
      mealPrepFriendly: true,
      assignments: [
        placed(0, 'lunch', 'chicken-rice'),
        placed(0, 'dinner', 'lentil-soup'),
        placed(1, 'lunch', 'lentil-bowl'),
        placed(1, 'dinner', 'chicken-salad'),
      ],
    });
    const [after] = closePacks({ plans: [ahead], packs: oneDay });

    expect(recipesOf(after!)).toEqual(recipesOf(ahead.assignments));
  });

  it('counts the packs of two plans together and swaps a shared meal in both', () => {
    // Each plan's lunch takes 200 g, together 400 of one pack: 100 g are left, not 300 in each.
    const small = recipe('chicken-rice', ['lunch'], 500, { chicken: 200 });
    const bowl = recipe('chicken-bowl', ['lunch'], 500, { chicken: 250 });
    const recipes = [small, bowl, lentilSoup];
    const ours = plan({ recipes });
    const theirs = plan({
      recipes,
      // The other plan's lunch is the first plan's dish: its lock is the sharing.
      days: days(1, { lockedSlots: [{ slot: 'lunch', recipeId: 'chicken-rice' }] }),
    });
    const [first, second] = closePacks({
      plans: [ours, theirs],
      shared: [{ dayIndex: 0, slot: 'lunch' }],
      packs: PACKS,
    });

    // The bowl in both takes 500 g: the pack is finished.
    expect(recipesOf(first!)).toEqual(['chicken-bowl', 'lentil-soup']);
    expect(recipesOf(second!)).toEqual(['chicken-bowl', 'lentil-soup']);
  });

  it('never gives a shared meal two dishes', () => {
    // The bowl in the first plan alone would finish the pack the two lunches open; in both it opens a second.
    const small = recipe('chicken-rice', ['lunch'], 500, { chicken: 200 });
    const bowl = recipe('chicken-bowl', ['lunch'], 500, { chicken: 300 });
    const recipes = [small, bowl, lentilSoup];
    const [first, second] = closePacks({
      plans: [
        plan({ recipes }),
        plan({
          recipes,
          days: days(1, { lockedSlots: [{ slot: 'lunch', recipeId: 'chicken-rice' }] }),
        }),
      ],
      shared: [{ dayIndex: 0, slot: 'lunch' }],
      packs: PACKS,
    });

    expect(recipesOf(first!)).toEqual(['chicken-rice', 'lentil-soup']);
    expect(recipesOf(second!)).toEqual(['chicken-rice', 'lentil-soup']);
  });

  it('gives a shared meal only a recipe both plans may be given', () => {
    // Feta in packs of 200 g: the shared salad takes 50 g in each plan; a dish of chicken and feta would finish the pack.
    const packs = new Map<string, Pack>([['feta', { size: 200, keepDays: 4 }]]);
    const salad = recipe('feta-salad', ['lunch'], 500, { feta: 50 }, { dietTags: ['vegetarian'] });
    const chickenFeta = recipe('chicken-feta', ['lunch'], 500, { feta: 100 });
    const recipes = [salad, chickenFeta, lentilSoup];
    const assignments = [placed(0, 'lunch', 'feta-salad'), placed(0, 'dinner', 'lentil-soup')];
    const [first, second] = closePacks({
      plans: [
        plan({ recipes, assignments }),
        plan({
          recipes: recipes.map((one) => ({
            ...one,
            dietTags: [...one.dietTags, ...(one === chickenFeta ? [] : ['vegetarian'])],
          })),
          assignments,
          dietType: 'vegetarian',
        }),
      ],
      shared: [{ dayIndex: 0, slot: 'lunch' }],
      packs,
    });

    expect(recipesOf(first!)).toEqual(['feta-salad', 'lentil-soup']);
    expect(recipesOf(second!)).toEqual(['feta-salad', 'lentil-soup']);
  });

  it('does not count a pack one plan opens as left when the other plan of the kitchen finishes it', () => {
    // The other plan's dinner takes the other half of the pack the first plan's lunch opens.
    const theirs = plan({ assignments: [placed(0, 'dinner', 'chicken-salad')] });
    const [first] = closePacks({ plans: [plan(), theirs], packs: PACKS });

    expect(recipesOf(first!)).toEqual(['chicken-rice', 'lentil-soup']);
  });

  it('comes to the same plan every time, whatever order the recipes come in', () => {
    const other = recipe('chicken-stew', ['dinner'], 500, { chicken: 250 });
    const one = closePacks({
      plans: [plan({ recipes: [chickenRice, lentilSoup, other, chickenSalad] })],
      packs: PACKS,
    });
    const two = closePacks({
      plans: [plan({ recipes: [chickenSalad, other, lentilSoup, chickenRice] })],
      packs: PACKS,
    });

    expect(one).toEqual(two);
    expect(recipesOf(one[0]!)).toEqual(['chicken-rice', 'chicken-salad']);
  });
});

describe('the packs of a kitchen as toppings are given', () => {
  it('says how much more its packs leave with more of an ingredient on a day, and takes it', () => {
    // A meal of the first day opens a pack of chicken and leaves 250 g of it, for the second day as well.
    const kitchen = packKitchen(new Map([['chicken', [250, 0]]]), 2);
    const chicken = PACKS.get('chicken')!;

    // 100 g on the second day come from the open pack: a fifth of a pack less is left.
    expect(kitchen.leavesMore('chicken', chicken, 1, 100)).toBeCloseTo(-0.2, 6);
    // 300 g finish it and open another, of which 450 g are left.
    expect(kitchen.leavesMore('chicken', chicken, 1, 300)).toBeCloseTo(0.4, 6);
    // Feta nobody takes yet: 50 g open a pack of 200 and leave the rest.
    expect(kitchen.leavesMore('feta', { size: 200, keepDays: 4 }, 0, 50)).toBeCloseTo(0.75, 6);

    // Taken, the 250 g finish the pack: 100 g more would open another.
    kitchen.take('chicken', 1, 250);
    expect(kitchen.leavesMore('chicken', chicken, 1, 100)).toBeCloseTo(0.8, 6);
  });
});
