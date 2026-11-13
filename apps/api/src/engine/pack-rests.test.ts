// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealType } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import type { OptimizerDay, OptimizerRecipe } from './optimizer.js';
import { LESS_WASTE_RESTS, packRests, type RestPlan } from './pack-rests.js';
import type { Pack } from './packs.js';
import type { SizedAssignment } from './rebalance.js';

/** Chicken in packs of 500 g that keep two days once opened; 165 kcal in 100 g. */
const PACKS = new Map<string, Pack>([['chicken', { size: 500, keepDays: 2 }]]);
const ENERGY = new Map([['chicken', 165]]);

const recipe = (
  id: string,
  mealTypes: MealType[],
  calories: number,
  of: Record<string, number> = {},
): OptimizerRecipe => ({
  id,
  slug: id,
  mealTypes,
  dietTags: [],
  caloriesPerServing: calories,
  proteinPerServing: (calories * 0.2) / 4,
  fatPerServing: (calories * 0.3) / 9,
  carbsPerServing: (calories * 0.5) / 4,
  ingredientIds: Object.keys(of),
  amounts: new Map(Object.entries(of)),
  difficulty: 'easy',
  isFavorite: false,
  totalMinutes: 20,
});
/** A lunch that takes 470 g of the pack, a dinner of none, and a smaller lunch of 250 g. */
const roast = recipe('chicken-roast', ['lunch'], 1000, { chicken: 470 });
const soup = recipe('lentil-soup', ['dinner'], 900, { lentils: 120 });
const salad = recipe('chicken-salad', ['dinner'], 600, { chicken: 250 });
const RECIPES = [roast, soup, salad];

const days = (count: number, more: Partial<OptimizerDay> = {}): OptimizerDay[] =>
  Array.from({ length: count }, () => ({
    mealSlots: ['lunch', 'dinner'] as MealType[],
    dailyCalorieTarget: 2000,
    ...more,
  }));
const placed = (
  dayIndex: number,
  slot: MealType,
  recipeId: string,
  servings = 1,
  quantityScale = 1,
): SizedAssignment => ({ dayIndex, slot, recipeId, servings, quantityScale });
const plan = (more: Partial<RestPlan> = {}): RestPlan => ({
  recipes: RECIPES,
  days: days(1),
  assignments: [placed(0, 'lunch', 'chicken-roast'), placed(0, 'dinner', 'lentil-soup')],
  mealPrepFriendly: false,
  ...more,
});
const rests = (plans: RestPlan[], more: Partial<Parameters<typeof packRests>[0]> = {}) =>
  packRests({ plans, packs: PACKS, energyPer100: ENERGY, caps: LESS_WASTE_RESTS, ...more });
const given = (found: ReturnType<typeof packRests>, plan = 0) =>
  [...found[plan]!].map(([index, of]) => [
    index,
    of.map((rest) => [rest.ingredientId, Math.round(rest.amount)]),
  ]);

describe('the rest of a pack, into the meal that finishes it', () => {
  it('goes into the meal that takes from the pack last while it keeps', () => {
    // The roast leaves 30 g of the pack: 50 kcal, within a tenth of the meal and 3 % of the day.
    expect(given(rests([plan()]))).toEqual([[0, [['chicken', 30]]]]);

    // Over two days the salad of the second evening takes from the pack the lunch opened: it finishes it.
    const twoDays = plan({
      days: days(2),
      assignments: [
        placed(0, 'lunch', 'chicken-roast', 0.5),
        placed(0, 'dinner', 'lentil-soup'),
        placed(1, 'lunch', 'chicken-roast', 0.5),
        placed(1, 'dinner', 'chicken-salad', 0.4),
      ],
    });
    // 235 + 235 + 100 = 570 g: a second pack on the second day, of which 430 g are left: too much for the salad.
    expect(given(rests([twoDays]))).toEqual([]);
  });

  it('goes into the last of the meals that take from the pack, not the one that opened it', () => {
    const lunch = recipe('chicken-bowl', ['lunch'], 1000, { chicken: 200 });
    const stew = recipe('chicken-stew', ['dinner'], 900, { chicken: 270 });
    // The bowl opens the pack on the first day, the stew of the second takes 270 g of the 300 left.
    const twoDays = plan({
      recipes: [lunch, stew, soup],
      days: days(2),
      assignments: [
        placed(0, 'lunch', 'chicken-bowl'),
        placed(0, 'dinner', 'lentil-soup'),
        placed(1, 'lunch', 'chicken-bowl', 0),
        placed(1, 'dinner', 'chicken-stew'),
      ],
    });
    expect(given(rests([twoDays]))).toEqual([[3, [['chicken', 30]]]]);
  });

  it('is no more than half of what the meal takes of the ingredient, nor a tenth more of its energy', () => {
    // The salad alone leaves 250 g, as much as it takes.
    const alone = plan({ assignments: [placed(0, 'dinner', 'chicken-salad')] });
    expect(given(rests([alone]))).toEqual([]);

    // A lighter roast: the 30 g left, 50 kcal, are more than a tenth of its 400 kcal.
    const light = recipe('chicken-roast', ['lunch'], 400, { chicken: 470 });
    expect(given(rests([plan({ recipes: [light, soup, salad] })]))).toEqual([]);

    // Spinach in bags of 200 g, 23 kcal in 100 g: a salad of 40 g leaves 160 g, 37 kcal, which would fit the
    // meal's energy and the day, but is four times what the salad takes.
    const spinach = recipe('spinach-salad', ['dinner'], 600, { spinach: 40 });
    const greens = plan({
      recipes: [spinach],
      assignments: [placed(0, 'dinner', 'spinach-salad')],
    });
    const bags = new Map<string, Pack>([['spinach', { size: 200, keepDays: 3 }]]);
    expect(
      given(rests([greens], { packs: bags, energyPer100: new Map([['spinach', 23]]) })),
    ).toEqual([]);
    // Taking as much again as it takes, it would.
    expect(
      given(
        rests([greens], {
          packs: bags,
          energyPer100: new Map([['spinach', 23]]),
          caps: { ofOwn: 4, ofMeal: 0.1, ofDay: 0.03 },
        }),
      ),
    ).toEqual([[0, [['spinach', 160]]]]);
  });

  it('adds no more to a day than 3 % of its target, and keeps the day in its window', () => {
    // The roast alone on a day of 1500 kcal: its 50 kcal more are over 3 % of the day (45).
    const small = plan({
      days: days(1, { dailyCalorieTarget: 1500 }),
      assignments: [placed(0, 'lunch', 'chicken-roast')],
    });
    expect(given(rests([small]))).toEqual([]);
    // Looser caps let the same rest in.
    expect(given(rests([small], { caps: { ofOwn: 1, ofMeal: 0.15, ofDay: 0.05 } }))).toEqual([
      [0, [['chicken', 30]]],
    ]);
    // A day 9 % over its target already: 50 kcal more would take it out of its window.
    expect(given(rests([plan({ days: days(1, { kept: [{ calories: 280 }] }) })]))).toEqual([]);
  });

  it('counts what stays in the plan and the toppings in the kitchen', () => {
    // Something that stays takes the 30 g on the same day: nothing is left.
    expect(given(rests([plan()], { fixed: new Map([['chicken', [30]]]) }))).toEqual([]);
    // A topping of 30 g of chicken on the dinner finishes it as well.
    const topped = plan({
      toppings: new Map([[1, { ingredientId: 'chicken', amount: 30, calories: 50 }]]),
    });
    expect(given(rests([topped]))).toEqual([]);
  });

  it('is none of a pack no meal of the plans takes from, of a rest too small to speak of, or of a food of unknown energy', () => {
    // What stays opens the pack, and no meal placed takes from it.
    expect(
      given(
        rests([plan({ assignments: [placed(0, 'dinner', 'lentil-soup')] })], {
          fixed: new Map([['chicken', [200]]]),
        }),
      ),
    ).toEqual([]);
    // Half a gram left, and 24 g: less than a spoonful of the pack of 500 g.
    const nearly = recipe('chicken-roast', ['lunch'], 1000, { chicken: 499.5 });
    expect(given(rests([plan({ recipes: [nearly, soup, salad] })]))).toEqual([]);
    const spoonful = recipe('chicken-roast', ['lunch'], 1000, { chicken: 476 });
    expect(given(rests([plan({ recipes: [spoonful, soup, salad] })]))).toEqual([]);
    const more = recipe('chicken-roast', ['lunch'], 1000, { chicken: 474 });
    expect(given(rests([plan({ recipes: [more, soup, salad] })]))).toEqual([
      [0, [['chicken', 26]]],
    ]);
    // Nothing said of the energy of chicken.
    expect(given(rests([plan()], { energyPer100: new Map() }))).toEqual([]);
  });

  it('goes into the pot of a dish cooked ahead, each portion its share by its size', () => {
    // The roast is cooked on the first day for the second as well: 2 × 235 g, and 30 g left of the second pack...
    const ahead = plan({
      days: days(2),
      mealPrepFriendly: true,
      recipes: [recipe('chicken-roast', ['lunch'], 1000, { chicken: 235 }), soup, salad],
      assignments: [
        placed(0, 'lunch', 'chicken-roast', 1),
        placed(0, 'dinner', 'lentil-soup'),
        placed(1, 'lunch', 'chicken-roast', 1),
        placed(1, 'dinner', 'lentil-soup'),
      ],
    });
    // ...of one pack: 470 g of 500 cooked on the first day, the 30 g left shared by the two portions.
    expect(given(rests([ahead]))).toEqual([
      [0, [['chicken', 15]]],
      [2, [['chicken', 15]]],
    ]);
  });

  it('goes into the pot of a meal both people of a joint plan eat, each portion its share', () => {
    const half = recipe('chicken-roast', ['lunch'], 1000, { chicken: 235 });
    const ours = plan({
      recipes: [half, soup, salad],
      assignments: [placed(0, 'lunch', 'chicken-roast', 1.2)],
    });
    const theirs = plan({
      recipes: [half, soup, salad],
      assignments: [placed(0, 'lunch', 'chicken-roast', 0.8)],
    });
    // 282 + 188 = 470 g of the pack: the 30 g left, three fifths of them for the larger portion.
    expect(
      [0, 1].map((p) =>
        given(rests([ours, theirs], { shared: [{ dayIndex: 0, slot: 'lunch' }] }), p),
      ),
    ).toEqual([[[0, [['chicken', 18]]]], [[0, [['chicken', 12]]]]]);
  });
});
