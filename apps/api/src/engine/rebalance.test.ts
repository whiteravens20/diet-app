// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  rebalanceDays,
  sizeAssignments,
  sizeDay,
  type RebalanceMeal,
  type DayToRebalance,
} from './rebalance.js';
import type { OptimizerAssignment, OptimizerDay, OptimizerRecipe } from './optimizer.js';

function meal(
  id: string,
  calories: number,
  opts: Partial<Omit<RebalanceMeal, 'id' | 'calories'>> = {},
): RebalanceMeal {
  return {
    id,
    calories,
    servings: opts.servings ?? 1,
    quantityScale: opts.quantityScale ?? 1,
    locked: opts.locked ?? false,
    ...(opts.macros ? { macros: opts.macros } : {}),
  };
}

/** A day that aims at nothing in particular: only its energy counts. */
const NO_AIM = { protein: 0, fat: 0, carbs: 0 };

const dayKcal = (meals: RebalanceMeal[], scales: Map<string, number>) =>
  meals.reduce((s, m) => s + m.calories * m.servings * (scales.get(m.id) ?? m.quantityScale), 0);

describe('sizing the meals of a day', () => {
  it('brings a day inside the ±10% window to its target as well', () => {
    const meals = [meal('a', 700), meal('b', 700), meal('c', 650)]; // 2050 vs 2000 → 2.5%
    const { scales, feasibility } = sizeDay(meals, 2000, NO_AIM);
    expect(feasibility).toBe('in-window');
    expect(dayKcal(meals, scales)).toBeCloseTo(2000, 5);
  });

  it('scales unlocked meals down to pull an over-target day back into the window', () => {
    const meals = [meal('a', 1000), meal('b', 1000), meal('c', 1000)]; // 3000 vs 2000 → +50%
    const { scales, feasibility } = sizeDay(meals, 2000, NO_AIM);
    expect(feasibility).toBe('in-window');
    expect(dayKcal(meals, scales)).toBeCloseTo(2000, 5);
    // uniform factor preserves relative proportions
    expect(scales.get('a')).toBeCloseTo(2 / 3, 5);
    expect(scales.get('a')).toBeCloseTo(scales.get('b')!, 5);
  });

  it('scales unlocked meals up to close a deficit (the ±20% case)', () => {
    const meals = [meal('a', 800), meal('b', 800)]; // 1600 vs 2000 → -20%
    const { scales, feasibility } = sizeDay(meals, 2000, NO_AIM);
    expect(feasibility).toBe('in-window');
    expect(dayKcal(meals, scales)).toBeCloseTo(2000, 5);
  });

  it('pins eaten / custom meals and only scales the rest', () => {
    const meals = [meal('eaten', 1300, { locked: true }), meal('flex', 1000)]; // 2300 vs 2000 → +15% (outside): eaten fixed at 1300, flex must become 700
    const { scales, feasibility } = sizeDay(meals, 2000, NO_AIM);
    expect(feasibility).toBe('in-window');
    expect(scales.get('eaten')).toBe(1); // untouched
    expect(scales.get('flex')).toBeCloseTo(0.7, 5);
    expect(dayKcal(meals, scales)).toBeCloseTo(2000, 5);
  });

  it('returns best-effort when an impossible gap cannot be closed', () => {
    // A 2600 kcal locked custom meal already overshoots a 2000 target; the lone
    // flex meal can only scale down to SERVING_MIN (0.5), never below zero.
    const meals = [meal('huge', 2600, { locked: true }), meal('flex', 600)];
    const { scales, feasibility } = sizeDay(meals, 2000, NO_AIM);
    expect(feasibility).toBe('best-effort');
    expect(scales.get('flex')).toBeCloseTo(0.5, 5); // clamped to the floor
    expect(dayKcal(meals, scales)).toBeGreaterThan(2000 * 1.1);
  });

  it('is a no-op (best-effort) when every meal on the day is locked', () => {
    const meals = [meal('a', 1500, { locked: true }), meal('b', 1500, { locked: true })];
    const { scales, feasibility } = sizeDay(meals, 2000, NO_AIM);
    expect(feasibility).toBe('best-effort');
    expect([...scales.values()]).toEqual([1, 1]);
  });

  it('respects the per-meal serving clamp and redistributes the residual', () => {
    // 'small' starts at 0.5 servings → can scale up to 6× (3.0 servings cap),
    // 'big' starts at 2 servings → capped at 1.5× (3.0 servings). Target forces
    // 'big' to clamp; 'small' must absorb the residual.
    const meals = [meal('big', 500, { servings: 2 }), meal('small', 500, { servings: 0.5 })];
    // Max achievable = both at 3 servings = 1500 + 1500 = 3000. A 3500 target is
    // out of reach: both clamp to the 3-serving ceiling, landing best-effort.
    const target = 3500;
    const { scales, feasibility } = sizeDay(meals, target, NO_AIM);
    const bigServings = 2 * scales.get('big')!;
    const smallServings = 0.5 * scales.get('small')!;
    expect(bigServings).toBeCloseTo(3, 5); // clamped to the ceiling
    expect(smallServings).toBeCloseTo(3, 5);
    expect(feasibility).toBe('best-effort'); // can't reach 3500 within the band
  });
});

describe('sizing the meals of a day for its macros', () => {
  // One meal nearly all protein, one nearly all carbohydrate, one nearly all fat, each 600 kcal a serving.
  const lean = { protein: 130, fat: 3, carbs: 5 };
  const starch = { protein: 10, fat: 2, carbs: 135 };
  const rich = { protein: 3, fat: 64, carbs: 3 };
  const day = () => [
    meal('lean', 600, { macros: lean }),
    meal('starch', 600, { macros: starch }),
    meal('rich', 600, { macros: rich }),
  ];
  const held = (meals: RebalanceMeal[], scales: Map<string, number>) =>
    meals.reduce(
      (sum, one) => {
        const amount = one.servings * scales.get(one.id)!;
        return {
          protein: sum.protein + one.macros!.protein * amount,
          fat: sum.fat + one.macros!.fat * amount,
          carbs: sum.carbs + one.macros!.carbs * amount,
        };
      },
      { protein: 0, fat: 0, carbs: 0 },
    );
  // What the day comes to with every meal at the same portion, and a target that wants more protein.
  const aim = { protein: 190, fat: 55, carbs: 130 };
  const away = (macros: { protein: number; fat: number; carbs: number }) =>
    4 * Math.abs(macros.protein - aim.protein) +
    9 * Math.abs(macros.fat - aim.fat) +
    4 * Math.abs(macros.carbs - aim.carbs);

  it('gives the meal that holds what the day lacks more of the same energy', () => {
    const meals = day();
    const even = sizeDay(
      meals.map(({ macros: _macros, ...rest }) => rest),
      1800,
      aim,
    ).scales;
    const { scales } = sizeDay(meals, 1800, aim);

    expect(scales.get('lean')!).toBeGreaterThan(even.get('lean')!);
    expect(away(held(meals, scales))).toBeLessThan(away(held(meals, even)) - 10);
    expect(dayKcal(meals, scales)).toBeCloseTo(1800, 5);
  });

  it('moves no meal more than a quarter from the portion that shares the day evenly', () => {
    const meals = day();
    const { scales } = sizeDay(meals, 1800, { protein: 400, fat: 0, carbs: 0 });

    for (const one of meals) {
      expect(scales.get(one.id)!).toBeGreaterThanOrEqual(0.75 - 1e-9);
      expect(scales.get(one.id)!).toBeLessThanOrEqual(1.25 + 1e-9);
    }
  });

  it('counts what a pinned meal holds, and leaves it alone', () => {
    const meals = [
      meal('eaten', 600, { locked: true, macros: rich, quantityScale: 1 }),
      meal('lean', 600, { macros: lean }),
      meal('starch', 600, { macros: starch }),
    ];
    const { scales } = sizeDay(meals, 1800, { protein: 200, fat: 64, carbs: 100 });

    expect(scales.get('eaten')).toBe(1);
    expect(scales.get('lean')!).toBeGreaterThan(scales.get('starch')!);
    expect(dayKcal(meals, scales)).toBeCloseTo(1800, 5);
  });

  it('stays inside the bounds of a serving', () => {
    const meals = [
      meal('lean', 600, { macros: lean, servings: 2.9 }),
      meal('starch', 600, { macros: starch, servings: 0.55 }),
    ];
    const { scales } = sizeDay(meals, 2070, { protein: 900, fat: 0, carbs: 0 });

    expect(2.9 * scales.get('lean')!).toBeLessThanOrEqual(3 + 1e-9);
    expect(0.55 * scales.get('starch')!).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it('sizes a day the same however often it is asked, whatever portions it had', () => {
    const meals = day();
    const first = sizeDay(meals, 1800, aim).scales;
    const again = sizeDay(
      meals.map((one) => ({ ...one, quantityScale: first.get(one.id)! })),
      1800,
      aim,
    ).scales;

    for (const one of meals) expect(again.get(one.id)!).toBeCloseTo(first.get(one.id)!, 9);
  });

  it('leaves a day on its target as it is where its macros have nothing much to gain', () => {
    const meals = [
      meal('a', 600, { macros: lean, quantityScale: 1.01 }),
      meal('b', 600, { macros: lean, quantityScale: 0.98 }),
    ];
    const { scales } = sizeDay(meals, 1200, { protein: 260, fat: 6, carbs: 10 });

    expect(scales.get('a')).toBe(1.01);
    expect(scales.get('b')).toBe(0.98);
  });

  it('shares a day evenly where nothing would bring it nearer', () => {
    const meals = [meal('a', 600, { macros: lean }), meal('b', 600, { macros: lean })];
    const { scales } = sizeDay(meals, 1200, { protein: 260, fat: 6, carbs: 10 });

    expect(scales.get('a')).toBeCloseTo(1, 9);
    expect(scales.get('b')).toBeCloseTo(1, 9);
  });

  it('leaves one meal to what is left of the target', () => {
    const meals = [meal('only', 600, { macros: lean })];
    const { scales } = sizeDay(meals, 900, aim);

    expect(scales.get('only')).toBeCloseTo(1.5, 9);
  });
});

describe('sizing what a run of the planner placed', () => {
  const recipe = (id: string, per: { kcal: number; protein: number; fat: number; carbs: number }) =>
    ({
      id,
      caloriesPerServing: per.kcal,
      proteinPerServing: per.protein,
      fatPerServing: per.fat,
      carbsPerServing: per.carbs,
    }) as OptimizerRecipe;
  const recipes = [
    recipe('lean', { kcal: 600, protein: 130, fat: 3, carbs: 5 }),
    recipe('starch', { kcal: 600, protein: 10, fat: 2, carbs: 135 }),
  ];
  const split = { protein: 0.5, fat: 0.05, carbs: 0.45 };
  const placed: OptimizerAssignment[] = [
    { dayIndex: 0, slot: 'lunch', recipeId: 'lean', servings: 1.75 },
    { dayIndex: 0, slot: 'dinner', recipeId: 'starch', servings: 1.75 },
  ];
  const day = (over: Partial<OptimizerDay> = {}): OptimizerDay => ({
    mealSlots: ['lunch', 'dinner'],
    dailyCalorieTarget: 2200,
    ...over,
  });

  it('brings the day to its target with a factor of two places, the servings as they were placed', () => {
    const sized = sizeAssignments([day()], recipes, placed, split);

    const kcal = sized.reduce((sum, meal) => sum + 600 * meal.servings * meal.quantityScale, 0);
    expect(Math.abs(kcal - 2200)).toBeLessThanOrEqual(12);
    expect(sized.map((meal) => meal.servings)).toEqual([1.75, 1.75]);
    for (const meal of sized)
      expect(Math.round(meal.quantityScale * 100) / 100).toBe(meal.quantityScale);
  });

  it('leaves a day it sized as it is when the day is sized again', () => {
    const sized = sizeAssignments([day()], recipes, placed, split);
    const meals = sized.map((one) => {
      const of = recipes.find((recipe) => recipe.id === one.recipeId)!;
      return meal(one.slot, of.caloriesPerServing, {
        servings: one.servings,
        quantityScale: one.quantityScale,
        macros: { protein: of.proteinPerServing, fat: of.fatPerServing, carbs: of.carbsPerServing },
      });
    });
    const { scales } = sizeDay(meals, 2200, {
      protein: (2200 * split.protein) / 4,
      fat: (2200 * split.fat) / 9,
      carbs: (2200 * split.carbs) / 4,
    });

    for (const one of sized) expect(scales.get(one.slot)).toBe(one.quantityScale);
  });

  it('counts the meals that stay on the day', () => {
    const sized = sizeAssignments(
      [
        day({
          kept: [{ calories: 1000, servings: 1, macros: { protein: 40, fat: 40, carbs: 100 } }],
        }),
      ],
      recipes,
      placed,
      split,
    );

    const kcal = sized.reduce((sum, meal) => sum + 600 * meal.servings * meal.quantityScale, 0);
    expect(Math.abs(kcal - 1200)).toBeLessThanOrEqual(12);
  });

  it('sizes each day of the plan by its own target and meals', () => {
    const sized = sizeAssignments(
      [day(), day()],
      recipes,
      [...placed, { dayIndex: 1, slot: 'lunch', recipeId: 'lean', servings: 3 }],
      split,
    );

    expect(sized).toHaveLength(3);
    expect(sized[2]!.dayIndex).toBe(1);
    expect(sized[2]!.servings * sized[2]!.quantityScale).toBeLessThanOrEqual(3);
  });
});

describe('rebalancing a run of days', () => {
  const TARGET = 2000;
  /** A day of three meals that add up to its target. */
  const onTarget = (name: string): DayToRebalance => ({
    target: TARGET,
    meals: [meal(`${name}-1`, 700), meal(`${name}-2`, 700), meal(`${name}-3`, 600)],
  });
  /** A day the user skips: it has no meals, and keeps its target. */
  const skipped = (): DayToRebalance => ({ target: TARGET, meals: [] });
  const totals = (days: DayToRebalance[], scales: Map<string, number>) =>
    days.map((day) => Math.round(dayKcal(day.meals, scales)));
  const insideItsWindow = (day: DayToRebalance, scales: Map<string, number>) =>
    Math.abs(dayKcal(day.meals, scales) - day.target) <= 0.1 * day.target + 1e-6;

  it('leaves days alone of which every one is inside its window', () => {
    const days = [
      { target: TARGET, meals: [meal('a', 700), meal('b', 700), meal('c', 650)] },
      onTarget('d2'),
    ];

    const result = rebalanceDays(days);

    expect(result).toMatchObject({ feasibility: 'in-window', unabsorbed: 0 });
    expect([...result.scales.values()].every((scale) => scale === 1)).toBe(true);
  });

  it('does not fill a skipped day with the meals of the others', () => {
    // Before, six days on target and one skipped day gave every eaten day 2333 kcal; two skipped days gave 2800.
    for (const skips of [1, 2]) {
      const eaten = Array.from({ length: 7 - skips }, (_, i) => onTarget(`d${i}`));
      const days = [...eaten, ...Array.from({ length: skips }, skipped)];

      const result = rebalanceDays(days);

      expect(result.feasibility).toBe('in-window');
      expect(totals(eaten, result.scales)).toEqual(eaten.map(() => TARGET));
    }
  });

  it('brings a day that is over back with its own meals, and leaves the other days as they are', () => {
    // Day 1 was corrected earlier: a custom meal of 900 kcal, and its two meals scaled to 0.55 to make room.
    const corrected: DayToRebalance = {
      target: TARGET,
      meals: [
        meal('custom', 900, { locked: true }),
        meal('c1', 1000, { quantityScale: 0.55 }),
        meal('c2', 1000, { quantityScale: 0.55 }),
      ],
    };
    // Day 5 has just taken a snack of 600 kcal: 30 % over.
    const over: DayToRebalance = {
      target: TARGET,
      meals: [meal('snack', 600, { locked: true }), meal('o1', 1000), meal('o2', 1000)],
    };
    const days = [
      corrected,
      onTarget('d2'),
      onTarget('d3'),
      onTarget('d4'),
      over,
      onTarget('d6'),
      onTarget('d7'),
    ];

    const result = rebalanceDays(days);

    expect(result).toMatchObject({ feasibility: 'in-window', unabsorbed: 0 });
    expect(totals(days, result.scales)).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000]);
    // The earlier correction stands: one factor for all the days would have reset it.
    expect(result.scales.get('c1')).toBe(0.55);
    expect(result.scales.get('o1')).toBeCloseTo(0.7, 6);
    expect(result.scales.get('d2-1')).toBe(1);
  });

  it('spreads what a day cannot absorb itself over the others, and takes none of them out of its window', () => {
    // A custom lunch of 1500 kcal on a day of 1570; its three other meals cannot go under half a serving.
    const heavy: DayToRebalance = {
      target: 1570,
      meals: [
        meal('lunch', 1500, { locked: true }),
        meal('h1', 400),
        meal('h2', 400),
        meal('h3', 370),
      ],
    };
    // A day that was at the lower edge already: 7.4 % under.
    const low: DayToRebalance = {
      target: 1570,
      meals: [meal('l1', 500), meal('l2', 500), meal('l3', 454)],
    };
    const others = Array.from({ length: 5 }, (_, i): DayToRebalance => ({
      target: 1570,
      meals: [meal(`n${i}-1`, 550), meal(`n${i}-2`, 550), meal(`n${i}-3`, 470)],
    }));
    const days = [low, heavy, ...others];

    const result = rebalanceDays(days);

    // The heavy day is at the least its meals allow, and still over.
    expect(result.scales.get('h1')).toBe(0.5);
    expect(dayKcal(heavy.meals, result.scales)).toBeCloseTo(1500 + 585, 5);
    expect(result.feasibility).toBe('best-effort');
    // Every other day gave something, and each is still inside its own window.
    for (const day of [low, ...others]) {
      expect(dayKcal(day.meals, result.scales)).toBeLessThan(dayKcal(day.meals, new Map()));
      expect(insideItsWindow(day, result.scales)).toBe(true);
    }
    // The day with the least room gave the least.
    const given = (day: DayToRebalance) =>
      dayKcal(day.meals, new Map()) - dayKcal(day.meals, result.scales);
    expect(given(low)).toBeLessThan(given(others[0]!));
    // What the days could not take is said, not hidden.
    const absorbed = [low, ...others].reduce((sum, day) => sum + given(day), 0);
    expect(result.unabsorbed).toBeCloseTo(1500 + 585 - 1570 - absorbed, 3);
    expect(result.unabsorbed).toBeGreaterThanOrEqual(0);
  });

  it('absorbs a surplus whole when the other days have the room', () => {
    // 300 kcal over on a day whose meals are all eaten; six days with room for 200 each.
    const eaten: DayToRebalance = {
      target: TARGET,
      meals: [meal('e1', 1150, { locked: true }), meal('e2', 1150, { locked: true })],
    };
    const others = Array.from({ length: 6 }, (_, i) => onTarget(`d${i}`));

    const result = rebalanceDays([eaten, ...others]);

    expect(result.unabsorbed).toBeCloseTo(0, 6);
    expect(totals(others, result.scales)).toEqual(others.map(() => 1950));
    // The eaten day stays over: nothing of it can be changed.
    expect(result.feasibility).toBe('best-effort');
  });

  it('says what is left when the other days have not the room for it', () => {
    // 2000 kcal over, all of it eaten; six days with room for 200 each.
    const eaten: DayToRebalance = {
      target: TARGET,
      meals: [meal('e1', 2000, { locked: true }), meal('e2', 2000, { locked: true })],
    };
    const others = Array.from({ length: 6 }, (_, i) => onTarget(`d${i}`));

    const result = rebalanceDays([eaten, ...others]);

    // Each of them went to the edge of its window and no further.
    expect(totals(others, result.scales)).toEqual(others.map(() => 1800));
    expect(result.unabsorbed).toBeCloseTo(800, 6);
  });

  it('spreads a shortfall the same way, upwards', () => {
    const short: DayToRebalance = {
      target: TARGET,
      meals: [meal('s1', 700, { locked: true }), meal('s2', 700, { locked: true })],
    };
    const others = Array.from({ length: 6 }, (_, i) => onTarget(`d${i}`));

    const result = rebalanceDays([short, ...others]);

    expect(totals(others, result.scales)).toEqual(others.map(() => 2100));
    expect(result.unabsorbed).toBeCloseTo(0, 6);
  });
});
