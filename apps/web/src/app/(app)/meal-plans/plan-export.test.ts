// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { MealPlan } from '@diet-app/shared';
import { dishOf, lastDayOf, planTable, servingsOf, type PlanWords } from './plan-export';

type Day = MealPlan['days'][number];
type Meal = Day['meals'][number];

const words: PlanWords = {
  head: ['Date', 'Meal', 'Dish', 'Servings', 'kcal', 'Protein (g)', 'Fat (g)', 'Carbohydrate (g)', 'Eaten'],
  meal: (type) => type.toUpperCase(),
  ownMeal: 'A meal of my own',
  yes: 'Yes',
  no: 'No',
  skipped: 'Skipped',
};

const aMeal = (over: Partial<Meal> = {}): Meal =>
  ({
    id: 'meal',
    mealType: 'breakfast',
    recipe: { title: 'Oat porridge' },
    customName: null,
    servings: 1,
    quantityScale: 1,
    eatenAt: null,
    nutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
    ...over,
  }) as Meal;

const aDay = (date: string, meals: Meal[], skipped = false): Day => ({ id: date, date, meals, skipped }) as Day;
const aPlan = (days: Day[]): MealPlan => ({ startDate: days[0]?.date ?? '2026-01-05', days }) as MealPlan;

describe('a plan as a table', () => {
  it('has a row for each meal under the heads, with the numbers the API worked out', () => {
    const table = planTable(aPlan([aDay('2026-01-05', [aMeal(), aMeal({ mealType: 'dinner', recipe: { title: 'Tofu bowl' } as Meal['recipe'], nutrition: { calories: 640, protein: 31, fat: 22, carbs: 70 } })])]), words);

    expect(table).toEqual([
      [...words.head],
      ['2026-01-05', 'BREAKFAST', 'Oat porridge', 1, 230, 8, 4, 40, 'No'],
      ['2026-01-05', 'DINNER', 'Tofu bowl', 1, 640, 31, 22, 70, 'No'],
    ]);
  });

  it('says of a meal that it was eaten, and how many servings a rebalance left it at', () => {
    const [, row] = planTable(aPlan([aDay('2026-01-05', [aMeal({ servings: 2, quantityScale: 0.85, eatenAt: '2026-01-05T08:00:00.000Z' })])]), words);

    expect(row).toEqual(['2026-01-05', 'BREAKFAST', 'Oat porridge', 1.7, 230, 8, 4, 40, 'Yes']);
  });

  it('names a meal of the user\'s own by the name it was given, or as such a meal', () => {
    const own = aMeal({ recipe: null, customName: 'Soup from the canteen' });
    const unnamed = aMeal({ recipe: null, customName: null });

    expect(dishOf(own, words)).toBe('Soup from the canteen');
    expect(dishOf(unnamed, words)).toBe('A meal of my own');
  });

  it('has one row for a day the plan skips, which says so', () => {
    const table = planTable(aPlan([aDay('2026-01-05', [aMeal()]), aDay('2026-01-06', [], true)]), words);

    expect(table[2]).toEqual(['2026-01-06', 'Skipped', null, null, null, null, null, null, null]);
    expect(table).toHaveLength(3);
  });

  it('is of nothing but its heads for a plan without days', () => {
    expect(planTable(aPlan([]), words)).toEqual([[...words.head]]);
  });
});

describe('what a table of a plan is made of', () => {
  it('is the servings of a meal to the hundredth', () => {
    expect(servingsOf(aMeal({ servings: 1, quantityScale: 1.0666 }))).toBe(1.07);
  });

  it('is the last day of the plan, or its first when it has none', () => {
    expect(lastDayOf(aPlan([aDay('2026-01-05', []), aDay('2026-01-07', [])]))).toBe('2026-01-07');
    expect(lastDayOf(aPlan([]))).toBe('2026-01-05');
  });
});
