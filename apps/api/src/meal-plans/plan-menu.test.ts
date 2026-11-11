// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { cookAhead, cookingsOf, planPacks, type MenuMeal, type PackedLine } from './plan-menu.js';

const chicken: PackedLine['ingredient'] = {
  name: 'Chicken breast',
  translations: [{ locale: 'pl', name: 'Pierś z kurczaka' }],
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  packSize: 500,
  perishable: true,
};
const milk: PackedLine['ingredient'] = {
  name: 'Milk',
  canonicalUnit: 'ml',
  gramsPerPiece: null,
  density: 1.03,
  packSize: 1000,
  perishable: true,
};
const rice: PackedLine['ingredient'] = {
  name: 'Rice',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  packSize: 1000,
  perishable: false,
};
const tomato: PackedLine['ingredient'] = {
  name: 'Tomato',
  canonicalUnit: 'g',
  gramsPerPiece: 120,
  density: null,
  packSize: null,
  perishable: false,
};
const egg: PackedLine['ingredient'] = {
  name: 'Egg',
  canonicalUnit: 'g',
  gramsPerPiece: 55,
  density: null,
  packSize: 550,
  perishable: true,
};
const line = (
  ingredientId: string,
  ingredient: PackedLine['ingredient'],
  quantity: number,
  unit: PackedLine['unit'] = ingredient.canonicalUnit,
): PackedLine => ({ ingredientId, quantity, unit, ingredient });

describe('what a menu comes to in packs that do not keep', () => {
  it('adds up what the meals take of each, scaled to the meal, and counts whole packs against it', () => {
    const packs = planPacks(
      [
        // A recipe for two that takes 340 g of chicken, planned as one serving and as one and a half.
        { factor: 0.5, lines: [line('chicken', chicken, 340), line('rice', rice, 160)] },
        {
          factor: 0.75,
          lines: [line('chicken', chicken, 340), line('tomato', tomato, 2, 'piece')],
        },
        { factor: 1, lines: [line('milk', milk, 250)] },
      ],
      'en',
    );

    // 425 g of chicken from one pack of 500, 250 ml of milk from a litre: the rice keeps and the tomatoes are loose.
    expect(packs.bought).toBe(1500);
    expect(packs.used).toBe(675);
    expect(packs.open).toEqual([
      {
        ingredientId: 'milk',
        name: 'Milk',
        unit: 'ml',
        packSize: 1000,
        packs: 1,
        left: 750,
        wasted: true,
      },
      {
        ingredientId: 'chicken',
        name: 'Chicken breast',
        unit: 'g',
        packSize: 500,
        packs: 1,
        left: 75,
        wasted: false,
      },
    ]);
  });

  it('names an ingredient in the language it is asked in', () => {
    expect(
      planPacks([{ factor: 1, lines: [line('chicken', chicken, 200)] }], 'pl').open[0]!.name,
    ).toBe('Pierś z kurczaka');
  });

  it('counts a line in pieces by what a piece weighs', () => {
    // Three eggs of a carton of ten.
    const packs = planPacks([{ factor: 1, lines: [line('egg', egg, 3, 'piece')] }], 'en');

    expect(packs).toMatchObject({ bought: 550, used: 165 });
    expect(packs.open[0]).toMatchObject({ left: 385, wasted: true });
  });

  it("leaves out a line whose unit cannot be brought to the ingredient's own", () => {
    // Chicken has no weight of a piece to count three pieces by.
    expect(planPacks([{ factor: 1, lines: [line('chicken', chicken, 3, 'piece')] }], 'en')).toEqual(
      { bought: 0, used: 0, open: [] },
    );
  });

  it('says what is left to the gram, and takes a pack that is left a fraction of one for finished', () => {
    // A third of 500 g three times over is 500 g, but for the noise of the division; 100.4 g are 100 g.
    const packs = planPacks(
      [
        {
          factor: 1 / 3,
          lines: [
            line('chicken', chicken, 500),
            line('chicken', chicken, 500),
            line('chicken', chicken, 499.2),
          ],
        },
        { factor: 1, lines: [line('milk', milk, 899.6)] },
      ],
      'en',
    );

    expect(packs.open).toEqual([
      {
        ingredientId: 'milk',
        name: 'Milk',
        unit: 'ml',
        packSize: 1000,
        packs: 1,
        left: 100,
        wasted: false,
      },
    ]);
  });

  it('is nothing for a menu without such a pack', () => {
    expect(
      planPacks(
        [{ factor: 1, lines: [line('rice', rice, 80), line('tomato', tomato, 240)] }],
        'en',
      ),
    ).toEqual({ bought: 0, used: 0, open: [] });
    expect(planPacks([], 'en')).toEqual({ bought: 0, used: 0, open: [] });
  });
});

const marksOf = (days: (string | null)[][]) => cookAhead(days).marks;

describe('what is cooked once for two meals', () => {
  it('is cooked on the first of two days running and eaten from on the second', () => {
    expect(
      marksOf([
        ['oats', 'stew'],
        ['oats', 'stew'],
        ['eggs', 'soup'],
      ]),
    ).toEqual([
      ['cook', 'cook'],
      ['cooked', 'cooked'],
      [null, null],
    ]);
  });

  it('is cooked anew on the third day running, for that day and the one after', () => {
    expect(marksOf([['stew'], ['stew'], ['stew'], ['stew']])).toEqual([
      ['cook'],
      ['cooked'],
      ['cook'],
      ['cooked'],
    ]);
    expect(marksOf([['stew'], ['stew'], ['stew']])).toEqual([['cook'], ['cooked'], [null]]);
  });

  it('is cooked once for two meals of one day, and for the day after with them', () => {
    expect(marksOf([['oats', 'stew', 'stew']])).toEqual([[null, 'cook', 'cooked']]);
    expect(marksOf([['stew', 'stew'], ['stew']])).toEqual([['cook', 'cooked'], ['cooked']]);
  });

  it('does not reach over a day between, nor over one without meals', () => {
    expect(marksOf([['stew'], ['soup'], ['stew']])).toEqual([[null], [null], [null]]);
    expect(marksOf([['stew'], [], ['stew']])).toEqual([[null], [], [null]]);
  });

  it('says nothing of a meal without a recipe', () => {
    expect(
      marksOf([
        [null, 'stew'],
        [null, 'stew'],
      ]),
    ).toEqual([
      [null, 'cook'],
      [null, 'cooked'],
    ]);
  });

  it('names the meals each cooking feeds', () => {
    expect(
      cookAhead([
        ['oats', 'stew'],
        ['oats', 'soup'],
        ['eggs', 'soup', 'soup'],
      ]).cookings,
    ).toEqual([
      [
        { day: 0, meal: 0 },
        { day: 1, meal: 0 },
      ],
      [
        { day: 1, meal: 1 },
        { day: 2, meal: 1 },
        { day: 2, meal: 2 },
      ],
    ]);
  });

  it('has no cooking for a meal cooked for itself', () => {
    expect(cookAhead([['stew'], ['soup']]).cookings).toEqual([]);
  });
});

describe('what a leftover makes of cooking ahead', () => {
  const on = (date: string) => new Date(`${date}T00:00:00Z`);
  const day = (date: string, ...meals: (Partial<MenuMeal> & { id: string })[]) => ({
    date: on(date),
    meals: meals.map((meal): MenuMeal => ({
      mealType: 'dinner',
      recipeId: null,
      leftoverFromDate: null,
      leftoverFromMealType: null,
      ...meal,
    })),
  });
  const leftover = (id: string, mealType: string, from: string) => ({
    id,
    mealType,
    recipeId: 'stew',
    leftoverFromDate: on(from),
    leftoverFromMealType: 'dinner',
  });

  it('cooks nothing for a leftover, which was cooked with the meal it was left of', () => {
    const { marks, cookings } = cookingsOf([
      day('2026-01-06', { id: 'tuesday', recipeId: 'stew' }),
      day('2026-01-07', leftover('lunch', 'lunch', '2026-01-06'), {
        id: 'wednesday',
        recipeId: 'stew',
      }),
    ]);

    expect(Object.fromEntries(marks)).toEqual({
      tuesday: 'cook',
      lunch: null,
      wednesday: 'cooked',
    });
    expect(cookings.map((places) => places.map((place) => [place.meal.id, place.stand]))).toEqual([
      [
        ['tuesday', false],
        ['wednesday', false],
      ],
    ]);
  });

  it('stands, done, where the meal it was left of was, once that meal left its day, so what was cooked there stays cooked', () => {
    const { marks, cookings } = cookingsOf([
      day('2026-01-06', { id: 'breakfast', mealType: 'breakfast', recipeId: 'oats' }),
      day('2026-01-07', leftover('lunch', 'lunch', '2026-01-06'), {
        id: 'wednesday',
        recipeId: 'stew',
      }),
    ]);

    expect(Object.fromEntries(marks)).toEqual({
      breakfast: null,
      lunch: null,
      wednesday: 'cooked',
    });
    expect(
      cookings.map((places) => places.map((place) => [place.day, place.meal.id, place.stand])),
    ).toEqual([
      [
        [0, 'lunch', true],
        [1, 'wednesday', false],
      ],
    ]);
  });

  it('stands for nothing where a meal of the dish holds that place, nor where the place is of no day of the plan', () => {
    const held = cookingsOf([
      day('2026-01-06', { id: 'tuesday', recipeId: 'stew' }),
      day('2026-01-07', leftover('lunch', 'lunch', '2026-01-06'), {
        id: 'wednesday',
        recipeId: 'stew',
      }),
    ]);
    expect(held.cookings.flat().filter((place) => place.stand)).toEqual([]);

    const outside = cookingsOf([
      day('2026-01-07', leftover('lunch', 'lunch', '2026-01-06'), {
        id: 'wednesday',
        recipeId: 'stew',
      }),
    ]);
    expect(outside.cookings).toEqual([]);
    expect(outside.marks.get('wednesday')).toBeNull();
  });
});
