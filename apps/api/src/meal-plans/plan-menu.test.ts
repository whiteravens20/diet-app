// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { cookingsOf, planPacks, type MenuMeal, type PackedLine } from './plan-menu.js';

/** The days of a plan of `n` days, from a Monday. */
const days = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `2026-01-${String(5 + i).padStart(2, '0')}`);

const chicken: PackedLine['ingredient'] = {
  name: 'Chicken breast',
  translations: [{ locale: 'pl', name: 'Pierś z kurczaka' }],
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  packSize: 500,
  perishable: true,
  keepDays: 2,
  category: 'meat',
};
const milk: PackedLine['ingredient'] = {
  name: 'Milk',
  canonicalUnit: 'ml',
  gramsPerPiece: null,
  density: 1.03,
  packSize: 1000,
  perishable: true,
  keepDays: 7,
  category: 'dairy',
};
const rice: PackedLine['ingredient'] = {
  name: 'Rice',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
  packSize: 1000,
  perishable: false,
  keepDays: null,
  category: 'grains',
};
const tomato: PackedLine['ingredient'] = {
  name: 'Tomato',
  canonicalUnit: 'g',
  gramsPerPiece: 120,
  density: null,
  packSize: null,
  perishable: false,
  keepDays: null,
  category: 'vegetables',
};
const egg: PackedLine['ingredient'] = {
  name: 'Egg',
  canonicalUnit: 'g',
  gramsPerPiece: 55,
  density: null,
  packSize: 550,
  perishable: true,
  keepDays: 28,
  category: 'dairy',
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
        { day: 0, factor: 0.5, lines: [line('chicken', chicken, 340), line('rice', rice, 160)] },
        {
          day: 0,
          factor: 0.75,
          lines: [line('chicken', chicken, 340), line('tomato', tomato, 2, 'piece')],
        },
        { day: 0, factor: 1, lines: [line('milk', milk, 250)] },
      ],
      days(1),
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
        // Opened on the menu's day, kept a week; what is given to the pantry is read from the plan.
        date: '2026-01-05',
        until: '2026-01-11',
        inPantry: false,
      },
      {
        ingredientId: 'chicken',
        name: 'Chicken breast',
        unit: 'g',
        packSize: 500,
        packs: 1,
        left: 75,
        wasted: false,
        date: '2026-01-05',
        until: '2026-01-06',
        inPantry: false,
      },
    ]);
  });

  it('names an ingredient in the language it is asked in', () => {
    expect(
      planPacks([{ day: 0, factor: 1, lines: [line('chicken', chicken, 200)] }], days(1), 'pl')
        .open[0]!.name,
    ).toBe('Pierś z kurczaka');
  });

  it('counts a line in pieces by what a piece weighs', () => {
    // Three eggs of a carton of ten.
    const packs = planPacks(
      [{ day: 0, factor: 1, lines: [line('egg', egg, 3, 'piece')] }],
      days(1),
      'en',
    );

    expect(packs).toMatchObject({ bought: 550, used: 165 });
    expect(packs.open[0]).toMatchObject({ left: 385, wasted: true });
  });

  it("leaves out a line whose unit cannot be brought to the ingredient's own", () => {
    // Chicken has no weight of a piece to count three pieces by.
    expect(
      planPacks(
        [{ day: 0, factor: 1, lines: [line('chicken', chicken, 3, 'piece')] }],
        days(1),
        'en',
      ),
    ).toEqual({ bought: 0, used: 0, open: [], frozen: [], fromFreezer: [] });
  });

  it('says what is left to the gram, and takes a pack that is left a fraction of one for finished', () => {
    // A third of 500 g three times over is 500 g, but for the noise of the division; 100.4 g are 100 g.
    const packs = planPacks(
      [
        {
          day: 0,
          factor: 1 / 3,
          lines: [
            line('chicken', chicken, 500),
            line('chicken', chicken, 500),
            line('chicken', chicken, 499.2),
          ],
        },
        { day: 0, factor: 1, lines: [line('milk', milk, 899.6)] },
      ],
      days(1),
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
        date: '2026-01-05',
        until: '2026-01-11',
        inPantry: false,
      },
    ]);
  });

  it('keeps a pack opened on the last days of the calendar no further than the calendar goes', () => {
    const packs = planPacks(
      [{ day: 0, factor: 1, lines: [line('milk', milk, 250)] }],
      ['2100-12-30', '2100-12-31'],
      'en',
    );

    expect(packs.open).toMatchObject([{ date: '2100-12-30', until: '2100-12-31' }]);
  });

  it('counts day by day: chicken of the first day and of the fourth takes two packs, the first thrown away', () => {
    // Chicken keeps two days once opened: what Monday leaves is gone by Thursday.
    const packs = planPacks(
      [
        { day: 0, factor: 1, lines: [line('chicken', chicken, 200)] },
        { day: 3, factor: 1, lines: [line('chicken', chicken, 200)] },
      ],
      days(4),
      'en',
    );

    expect(packs).toMatchObject({ bought: 1000, used: 400 });
    expect(packs.open.map((pack) => pack.left)).toEqual([300, 300]);
  });

  it('eats from one pack on the days it keeps', () => {
    const packs = planPacks(
      [
        { day: 0, factor: 1, lines: [line('chicken', chicken, 250)] },
        { day: 1, factor: 1, lines: [line('chicken', chicken, 250)] },
      ],
      days(2),
      'en',
    );

    expect(packs).toEqual({ bought: 500, used: 500, open: [], frozen: [], fromFreezer: [] });
  });

  it('counts by the kind of food where the database has no keep days yet: meat keeps two', () => {
    const unknown = { ...chicken, keepDays: null };
    const packs = planPacks(
      [
        { day: 0, factor: 1, lines: [line('chicken', unknown, 250)] },
        { day: 2, factor: 1, lines: [line('chicken', unknown, 250)] },
      ],
      days(3),
      'en',
    );

    expect(packs.bought).toBe(1000);
  });

  it('leaves out a meal on a day the menu does not have', () => {
    expect(
      planPacks([{ day: 5, factor: 1, lines: [line('chicken', chicken, 200)] }], days(2), 'en'),
    ).toEqual({ bought: 0, used: 0, open: [], frozen: [], fromFreezer: [] });
  });

  it('is nothing for a menu without such a pack', () => {
    expect(
      planPacks(
        [{ day: 0, factor: 1, lines: [line('rice', rice, 80), line('tomato', tomato, 240)] }],
        days(1),
        'en',
      ),
    ).toEqual({ bought: 0, used: 0, open: [], frozen: [], fromFreezer: [] });
    expect(planPacks([], days(1), 'en')).toEqual({
      bought: 0,
      used: 0,
      open: [],
      frozen: [],
      fromFreezer: [],
    });
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

describe('the packs of a plan that wastes nothing', () => {
  const freezes = (ingredient: { category?: string | null }): boolean =>
    ingredient.category === 'meat' || ingredient.category === 'fish';
  const meal = (day: number, mealId: string, rank: number, grams: number) => ({
    day,
    mealId,
    rank,
    factor: 1,
    lines: [line('chicken', chicken, grams), line('rice', rice, 80)],
  });
  const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('say what goes in the freezer with the meal that opens its pack, what a later meal takes of it and what is left', () => {
    // 500 g packs that keep two days: Monday's breakfast, the first meal of the day, opens one, its lunch takes from
    // it too, and Friday's dinner takes 100 g of what was frozen.
    const packs = planPacks(
      [meal(0, ids(2), 2, 100), meal(0, ids(1), 0, 100), meal(4, ids(3), 4, 100)],
      days(7),
      'en',
      freezes,
    );

    expect(packs.open).toEqual([]);
    expect(packs.frozen).toEqual([
      {
        ingredientId: 'chicken',
        name: 'Chicken breast',
        unit: 'g',
        date: '2026-01-05',
        mealId: ids(1),
        amount: 300,
        thawed: [{ date: '2026-01-09', mealId: ids(3), amount: 100 }],
        left: 200,
        // Whoever reads the plan says whether the pantry was given it.
        inPantry: false,
      },
    ]);
  });

  it('freeze nothing in a plan that does not waste nothing: what is left is left', () => {
    const packs = planPacks([meal(0, ids(1), 0, 200)], days(7), 'en');

    expect(packs.frozen).toEqual([]);
    expect(packs.open).toMatchObject([{ ingredientId: 'chicken', left: 300 }]);
  });
});

describe('what the pantry held in the freezer when a plan was made', () => {
  const meal = (day: number, mealId: string, rank: number, grams: number) => ({
    day,
    mealId,
    rank,
    factor: 1,
    lines: [line('chicken', chicken, grams)],
  });
  const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const package_ = (amount: number, parcel = 0) => ({ amount, parcel, bestBefore: null });
  const freezer = (from: string, grams: number) => ({
    from,
    stock: new Map([['chicken', [package_(grams)]]]),
  });

  it('is thawed whole for the first meal that takes it, and eaten while it keeps, before a pack is bought', () => {
    // 286 g frozen: Monday's 150 g; thawed, chicken keeps two days, and Wednesday's 150 g open a pack.
    const packs = planPacks(
      [meal(0, ids(1), 2, 150), meal(2, ids(2), 4, 150)],
      days(7),
      'en',
      undefined,
      freezer('2026-01-05', 286),
    );

    expect(packs.fromFreezer).toEqual([
      {
        ingredientId: 'chicken',
        name: 'Chicken breast',
        unit: 'g',
        date: '2026-01-05',
        mealId: ids(1),
        amount: 286,
        eaten: 150,
      },
    ]);
    expect(packs.bought).toBe(500);
    expect(packs.used).toBe(150);
    expect(packs.open).toMatchObject([{ ingredientId: 'chicken', left: 350 }]);
  });

  it('eats a portion over the days it keeps thawed, and buys nothing while it lasts', () => {
    const packs = planPacks(
      [meal(0, ids(1), 2, 150), meal(1, ids(2), 2, 120)],
      days(7),
      'en',
      undefined,
      freezer('2026-01-05', 286),
    );

    expect(packs.fromFreezer[0]).toMatchObject({ date: '2026-01-05', amount: 286, eaten: 270 });
    expect(packs.bought).toBe(0);
  });

  it('is thawed for no meal before the day the plan was made, and for none of what the menu does not take', () => {
    const packs = planPacks(
      [meal(0, ids(1), 2, 150), meal(2, ids(2), 2, 150)],
      days(7),
      'en',
      undefined,
      {
        from: '2026-01-06',
        stock: new Map([
          ['chicken', [package_(286)]],
          ['salmon', [package_(200)]],
        ]),
      },
    );

    expect(packs.fromFreezer).toEqual([
      expect.objectContaining({
        ingredientId: 'chicken',
        date: '2026-01-07',
        mealId: ids(2),
        eaten: 150,
      }),
    ]);
    expect(packs.bought).toBe(500);
  });

  it('comes before the freezer of a plan that wastes nothing, whose own rests are counted on what is left to eat', () => {
    // The 286 g come out for Thursday, whose 300 g eat them whole; Monday's 150 g open a pack, whose 350 g are
    // frozen, and Thursday takes from them the 14 g it still needs.
    const packs = planPacks(
      [meal(0, ids(1), 2, 150), meal(3, ids(2), 2, 300)],
      days(7),
      'en',
      (ingredient) => ingredient.category === 'meat',
      freezer('2026-01-05', 286),
    );

    expect(packs.fromFreezer).toMatchObject([{ date: '2026-01-08', amount: 286, eaten: 286 }]);
    expect(packs.frozen).toMatchObject([
      {
        date: '2026-01-05',
        mealId: ids(1),
        amount: 350,
        thawed: [{ date: '2026-01-08', amount: 14 }],
        left: 336,
      },
    ]);
    expect(packs.open).toEqual([]);
  });

  it('thaws its packages one after another, each for the meal whose day and the next eat it whole', () => {
    // Two packages of 200 g: Monday and Tuesday eat the first, Thursday and Friday the second; nothing is bought.
    const packs = planPacks(
      [
        meal(0, ids(1), 2, 150),
        meal(1, ids(2), 2, 50),
        meal(3, ids(3), 2, 150),
        meal(4, ids(4), 2, 50),
      ],
      days(7),
      'en',
      undefined,
      { from: '2026-01-05', stock: new Map([['chicken', [package_(200, 3), package_(200, 5)]]]) },
    );

    expect(packs.fromFreezer).toMatchObject([
      { date: '2026-01-05', mealId: ids(1), amount: 200, eaten: 200 },
      { date: '2026-01-08', mealId: ids(3), amount: 200, eaten: 200 },
    ]);
    expect(packs.bought).toBe(0);
  });

  it('is none where the pantry held nothing in the freezer', () => {
    expect(planPacks([meal(0, ids(1), 2, 150)], days(7), 'en').fromFreezer).toEqual([]);
    expect(
      planPacks([meal(0, ids(1), 2, 150)], days(7), 'en', undefined, null).fromFreezer,
    ).toEqual([]);
  });
});
