// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  readReroll,
  rerollDayOf,
  rerollOutcome,
  type RerollAsked,
  type RerollDay,
  type RerollMeal,
} from './reroll-reading.js';

const RECIPE = '44444444-4444-4444-8444-444444444444';
const OTHER = '99999999-9999-4999-8999-999999999999';
const EATEN = new Date('2026-01-07T08:00:00Z');

/** A meal of the catalogue, unless `over` says otherwise. */
const aMeal = (mealType: string, over: Partial<RerollMeal> = {}): RerollMeal => ({
  mealType,
  recipeId: RECIPE,
  source: 'CATALOGUE',
  eatenAt: null,
  ...over,
});

/** A day of two meals, a breakfast and a dinner, unless `over` says otherwise. */
const aDay = (date: string, over: Partial<RerollDay> = {}): RerollDay => ({
  date,
  skipped: false,
  mealCount: 2,
  locks: [],
  meals: [aMeal('breakfast'), aMeal('dinner')],
  ...over,
});

/** Monday to Thursday. */
const week = (over: Record<string, Partial<RerollDay>> = {}): RerollDay[] =>
  ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((date) => aDay(date, over[date]));

/** The whole week, nothing let go that a re-roll keeps, unless `over` says otherwise. */
const asked = (over: Partial<RerollAsked> = {}): RerollAsked => ({
  first: '2026-01-05',
  last: '2026-01-08',
  includePast: false,
  replaceEaten: false,
  replaceCustom: false,
  ...over,
});

const WEDNESDAY = '2026-01-07';
const NOTHING_KEPT = { outside: 0, past: 0, skipped: 0, eaten: 0, custom: 0, locked: 0 };

describe('what a re-roll would do to a plan', () => {
  it('replaces every meal of every day of a plan that lies ahead', () => {
    expect(rerollOutcome(week(), asked(), '2026-01-01')).toEqual({
      days: 4,
      replaced: 8,
      kept: NOTHING_KEPT,
      couldGo: { past: false, eaten: false, custom: false },
    });
  });

  it('leaves the days that have passed as they are, unless it is told to make them again', () => {
    expect(rerollOutcome(week(), asked(), WEDNESDAY)).toMatchObject({
      days: 2,
      replaced: 4,
      kept: { past: 2 },
    });
    expect(rerollOutcome(week(), asked({ includePast: true }), WEDNESDAY)).toMatchObject({
      days: 4,
      replaced: 8,
      kept: { past: 0 },
    });
  });

  it('leaves the days outside the days asked for as they are', () => {
    expect(
      rerollOutcome(week(), asked({ first: WEDNESDAY, last: WEDNESDAY }), WEDNESDAY),
    ).toMatchObject({ days: 1, replaced: 2, kept: { outside: 3, past: 0 } });
    expect(rerollOutcome(week(), asked({ first: WEDNESDAY }), WEDNESDAY)).toMatchObject({
      days: 2,
      replaced: 4,
      kept: { outside: 2 },
    });
  });

  it("keeps a meal that was eaten and a meal of the user's own, each unless it is told otherwise", () => {
    const days = week({
      [WEDNESDAY]: {
        mealCount: 3,
        meals: [
          aMeal('breakfast', { eatenAt: EATEN }),
          aMeal('lunch', { source: 'USER_CUSTOM', recipeId: null }),
          aMeal('dinner'),
        ],
      },
    });
    const wednesday = (over: Partial<RerollAsked> = {}) =>
      rerollOutcome(days, asked({ first: WEDNESDAY, last: WEDNESDAY, ...over }), WEDNESDAY);

    expect(wednesday()).toMatchObject({ days: 1, replaced: 1, kept: { eaten: 1, custom: 1 } });
    expect(wednesday({ replaceEaten: true })).toMatchObject({
      replaced: 2,
      kept: { eaten: 0, custom: 1 },
    });
    expect(wednesday({ replaceCustom: true })).toMatchObject({
      replaced: 2,
      kept: { eaten: 1, custom: 0 },
    });
    expect(wednesday({ replaceEaten: true, replaceCustom: true })).toMatchObject({
      replaced: 3,
      kept: { eaten: 0, custom: 0 },
    });
  });

  it("counts a meal of the user's own that was eaten once, kept for as long as either is kept", () => {
    const days = week({
      [WEDNESDAY]: {
        meals: [aMeal('lunch', { source: 'USER_CUSTOM', recipeId: null, eatenAt: EATEN })],
      },
    });
    const wednesday = (over: Partial<RerollAsked>) =>
      rerollOutcome(days, asked({ first: WEDNESDAY, last: WEDNESDAY, ...over }), WEDNESDAY);

    expect(wednesday({})).toMatchObject({ replaced: 0, kept: { custom: 1, eaten: 0 } });
    expect(wednesday({ replaceCustom: true })).toMatchObject({
      replaced: 0,
      kept: { custom: 0, eaten: 1 },
    });
    expect(wednesday({ replaceEaten: true })).toMatchObject({
      replaced: 0,
      kept: { custom: 1, eaten: 0 },
    });
    expect(wednesday({ replaceEaten: true, replaceCustom: true })).toMatchObject({ replaced: 1 });
  });

  it("fills the meals of a day beside a meal of the user's own that stays: it holds no place", () => {
    const days = week({
      [WEDNESDAY]: { meals: [aMeal('lunch', { source: 'USER_CUSTOM', recipeId: null })] },
    });

    expect(
      rerollOutcome(days, asked({ first: WEDNESDAY, last: WEDNESDAY }), WEDNESDAY),
    ).toMatchObject({ days: 1, replaced: 0, kept: { custom: 1 } });
  });

  it('fills the place of a meal that was taken off a day whose other meals stay', () => {
    const days = week({ [WEDNESDAY]: { meals: [aMeal('breakfast', { eatenAt: EATEN })] } });

    expect(
      rerollOutcome(days, asked({ first: WEDNESDAY, last: WEDNESDAY }), WEDNESDAY),
    ).toMatchObject({ days: 1, replaced: 0, kept: { eaten: 1 } });
  });

  it('does not count a day every place of which is held by a meal that stays', () => {
    const days = week({
      [WEDNESDAY]: {
        meals: [aMeal('breakfast', { eatenAt: EATEN }), aMeal('dinner', { eatenAt: EATEN })],
      },
    });

    expect(
      rerollOutcome(days, asked({ first: WEDNESDAY, last: WEDNESDAY }), WEDNESDAY),
    ).toMatchObject({ days: 0, replaced: 0, kept: { eaten: 2 } });
  });

  it('keeps a meal that is locked to the recipe it has, and replaces one that was swapped away from its lock', () => {
    const locks = [{ mealType: 'breakfast' as const, recipeId: RECIPE }];
    const wednesday = (day: Partial<RerollDay>) =>
      rerollOutcome(
        week({ [WEDNESDAY]: { locks, ...day } }),
        asked({ first: WEDNESDAY, last: WEDNESDAY }),
        WEDNESDAY,
      );

    expect(wednesday({})).toMatchObject({ days: 1, replaced: 1, kept: { locked: 1 } });
    expect(
      wednesday({ meals: [aMeal('breakfast', { recipeId: OTHER }), aMeal('dinner')] }),
    ).toMatchObject({ days: 1, replaced: 2, kept: { locked: 0 } });
    // Every meal comes back as it is: the day is not changed by being asked for.
    expect(
      wednesday({ locks: [...locks, { mealType: 'dinner', recipeId: RECIPE }] }),
    ).toMatchObject({ days: 0, replaced: 0, kept: { locked: 2 } });
  });

  it('leaves a day the user skips as it is, with what was eaten of it, whatever it is told', () => {
    const days = week({
      [WEDNESDAY]: { skipped: true, meals: [aMeal('breakfast', { eatenAt: EATEN })] },
    });

    expect(
      rerollOutcome(
        days,
        asked({ first: WEDNESDAY, last: WEDNESDAY, replaceEaten: true }),
        WEDNESDAY,
      ),
    ).toEqual({
      days: 0,
      replaced: 0,
      kept: { ...NOTHING_KEPT, outside: 3, skipped: 1 },
      couldGo: { past: false, eaten: false, custom: false },
    });
  });

  it('fills a day that holds nothing and is not skipped', () => {
    expect(
      rerollOutcome(
        week({ [WEDNESDAY]: { meals: [] } }),
        asked({ first: WEDNESDAY, last: WEDNESDAY }),
        WEDNESDAY,
      ),
    ).toMatchObject({ days: 1, replaced: 0 });
  });
});

describe('what a re-roll can be asked to replace as well', () => {
  const days = week({
    '2026-01-05': { meals: [aMeal('breakfast', { eatenAt: EATEN })] },
    '2026-01-08': { meals: [aMeal('lunch', { source: 'USER_CUSTOM', recipeId: null })] },
  });
  const couldGo = (over: Partial<RerollAsked>) =>
    rerollOutcome(days, asked(over), WEDNESDAY).couldGo;

  it('is days that have passed only where the days asked for have any', () => {
    expect(couldGo({}).past).toBe(true);
    expect(couldGo({ first: WEDNESDAY }).past).toBe(false);
  });

  it("is eaten meals and meals of the user's own only where the days that would be filled hold them", () => {
    // The eaten breakfast is on a day that has passed: it comes into question once that day does.
    expect(couldGo({})).toEqual({ past: true, eaten: false, custom: true });
    expect(couldGo({ includePast: true })).toEqual({ past: true, eaten: true, custom: true });
    expect(couldGo({ first: WEDNESDAY, last: WEDNESDAY })).toEqual({
      past: false,
      eaten: false,
      custom: false,
    });
  });

  it('is not what a skipped day holds: it keeps that whatever is asked', () => {
    const skipped = week({
      [WEDNESDAY]: { skipped: true, meals: [aMeal('breakfast', { eatenAt: EATEN })] },
    });

    expect(rerollOutcome(skipped, asked({ first: WEDNESDAY }), WEDNESDAY).couldGo.eaten).toBe(
      false,
    );
  });
});

describe('a day of a plan, as a re-roll reads it', () => {
  it('holds the places of the meals of the catalogue that stay, and the locks of those places go with them', () => {
    const reading = readReroll(
      aDay(WEDNESDAY, {
        mealCount: 3,
        locks: [
          { mealType: 'breakfast', recipeId: RECIPE },
          { mealType: 'dinner', recipeId: RECIPE },
        ],
        meals: [aMeal('breakfast', { eatenAt: EATEN }), aMeal('dinner')],
      }),
      asked(),
      WEDNESDAY,
    );

    expect(reading).toMatchObject({
      fate: 'again',
      slots: ['lunch', 'dinner'],
      locks: [{ mealType: 'dinner', recipeId: RECIPE }],
    });
  });

  it('is skipped where the user skips it, keeping what was eaten of it and the meals of their own', () => {
    const meals = [
      aMeal('breakfast', { eatenAt: EATEN }),
      aMeal('lunch', { source: 'USER_CUSTOM', recipeId: null }),
    ];
    const reading = readReroll(
      aDay(WEDNESDAY, { skipped: true, meals }),
      asked({ replaceEaten: true, replaceCustom: true }),
      WEDNESDAY,
    );

    expect(reading).toMatchObject({ fate: 'skipped', staying: meals });
  });

  it('is made from the row of a day: skipped, locked and with the number of meals it is set for', () => {
    const meals = [aMeal('breakfast'), aMeal('lunch'), aMeal('dinner'), aMeal('snack')];

    expect(
      rerollDayOf(
        {
          overrides: { skip: true, lockedSlots: [{ mealType: 'lunch', recipeId: RECIPE }] },
          meals,
        },
        WEDNESDAY,
        null,
        3,
      ),
    ).toEqual({
      date: WEDNESDAY,
      skipped: true,
      // Its meals of the catalogue say how many it has, where neither the day nor the plan names a number.
      mealCount: 4,
      locks: [{ mealType: 'lunch', recipeId: RECIPE }],
      meals,
    });
    expect(rerollDayOf({ overrides: { mealCount: 5 }, meals }, WEDNESDAY, 3, 2).mealCount).toBe(5);
    expect(rerollDayOf({ overrides: null, meals: [] }, WEDNESDAY, null, 2).mealCount).toBe(2);
  });
});
