// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { MealPlan } from '@diet-app/shared';
import {
  fromTodayRefused,
  rerollBody,
  rerollOutcome,
  spanOf,
  whatCouldGo,
  type RerollChoice,
} from './reroll';

type Day = MealPlan['days'][number];
type Meal = Day['meals'][number];

const RECIPE = '44444444-4444-4444-8444-444444444444';

/** A meal of the catalogue, unless `over` says otherwise. */
const aMeal = (mealType: Meal['mealType'], over: Partial<Meal> = {}): Meal =>
  ({
    id: `${mealType}`,
    mealType,
    recipe: { id: RECIPE },
    source: 'CATALOGUE',
    eatenAt: null,
    ...over,
  }) as Meal;

/** A day with a breakfast and a dinner, unless `over` says otherwise. */
const aDay = (date: string, over: Partial<Day> = {}): Day =>
  ({
    id: date,
    date,
    meals: [aMeal('breakfast'), aMeal('dinner')],
    skipped: false,
    overrides: null,
    ...over,
  }) as Day;

/** Monday to Thursday. */
const week = (over: Record<string, Partial<Day>> = {}): Day[] =>
  ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((date) => aDay(date, over[date]));

const choose = (over: Partial<RerollChoice> = {}): RerollChoice => ({
  scope: 'whole',
  from: '2026-01-05',
  to: '2026-01-08',
  day: '2026-01-05',
  includePast: false,
  replaceEaten: false,
  replaceCustom: false,
  ...over,
});

const WEDNESDAY = '2026-01-07';

describe('the days a re-roll asks for', () => {
  it('are all of the plan for the whole of it, and the days named for a part or for one day', () => {
    expect(spanOf(week(), choose(), WEDNESDAY)).toEqual({
      first: '2026-01-05',
      last: '2026-01-08',
    });
    expect(
      spanOf(week(), choose({ scope: 'range', from: '2026-01-06', to: '2026-01-07' }), WEDNESDAY),
    ).toEqual({ first: '2026-01-06', last: '2026-01-07' });
    expect(spanOf(week(), choose({ scope: 'day', day: '2026-01-08' }), WEDNESDAY)).toEqual({
      first: '2026-01-08',
      last: '2026-01-08',
    });
  });

  it('begin today for what is left of a plan that is under way', () => {
    expect(spanOf(week(), choose({ scope: 'from_today' }), WEDNESDAY)).toEqual({
      first: WEDNESDAY,
      last: '2026-01-08',
    });
  });

  it('are not on offer from today for a plan that has not begun, nor for one that is over', () => {
    expect(fromTodayRefused(week(), '2026-01-04')).toBe('not_begun');
    // On its first day what is left of the plan is the whole of it.
    expect(fromTodayRefused(week(), '2026-01-05')).toBe('not_begun');
    expect(fromTodayRefused(week(), '2026-01-06')).toBeNull();
    expect(fromTodayRefused(week(), '2026-01-08')).toBeNull();
    expect(fromTodayRefused(week(), '2026-01-09')).toBe('over');
  });
});

describe('what a re-roll would do to a plan', () => {
  it('replaces every meal of every day of a plan that lies ahead', () => {
    expect(rerollOutcome(week(), choose(), '2026-01-01')).toEqual({
      days: 4,
      replaced: 8,
      keptOutside: 0,
      keptPast: 0,
      keptSkipped: 0,
      keptEaten: 0,
      keptCustom: 0,
      keptLocked: 0,
    });
  });

  it('leaves the days that have passed as they are, unless it is told to make them again', () => {
    expect(rerollOutcome(week(), choose(), WEDNESDAY)).toMatchObject({
      days: 2,
      replaced: 4,
      keptPast: 2,
    });
    expect(rerollOutcome(week(), choose({ includePast: true }), WEDNESDAY)).toMatchObject({
      days: 4,
      replaced: 8,
      keptPast: 0,
    });
  });

  it('leaves the days outside a part of the plan as they are', () => {
    expect(
      rerollOutcome(
        week(),
        choose({ scope: 'range', from: '2026-01-07', to: '2026-01-07' }),
        WEDNESDAY,
      ),
    ).toMatchObject({ days: 1, replaced: 2, keptOutside: 3, keptPast: 0 });
    expect(rerollOutcome(week(), choose({ scope: 'from_today' }), WEDNESDAY)).toMatchObject({
      days: 2,
      replaced: 4,
      keptOutside: 2,
    });
    expect(
      rerollOutcome(week(), choose({ scope: 'day', day: '2026-01-08' }), WEDNESDAY),
    ).toMatchObject({ days: 1, replaced: 2, keptOutside: 3 });
  });

  it("keeps a meal that was eaten and a meal of the user's own, each unless it is told otherwise", () => {
    const days = week({
      [WEDNESDAY]: {
        meals: [
          aMeal('breakfast', { eatenAt: '2026-01-07T08:00:00.000Z' }),
          aMeal('lunch', { source: 'USER_CUSTOM', recipe: null }),
          aMeal('dinner'),
        ],
      },
    });
    const wednesday = (over: Partial<RerollChoice> = {}) =>
      rerollOutcome(days, choose({ scope: 'day', day: WEDNESDAY, ...over }), WEDNESDAY);

    expect(wednesday()).toMatchObject({ days: 1, replaced: 1, keptEaten: 1, keptCustom: 1 });
    expect(wednesday({ replaceEaten: true })).toMatchObject({
      replaced: 2,
      keptEaten: 0,
      keptCustom: 1,
    });
    expect(wednesday({ replaceCustom: true })).toMatchObject({
      replaced: 2,
      keptEaten: 1,
      keptCustom: 0,
    });
    expect(wednesday({ replaceEaten: true, replaceCustom: true })).toMatchObject({
      replaced: 3,
      keptEaten: 0,
      keptCustom: 0,
    });
  });

  it("counts a meal of the user's own that was eaten once, and keeps it for as long as either is kept", () => {
    const days = week({
      [WEDNESDAY]: {
        meals: [
          aMeal('lunch', {
            source: 'USER_CUSTOM',
            recipe: null,
            eatenAt: '2026-01-07T12:00:00.000Z',
          }),
        ],
      },
    });
    const wednesday = (over: Partial<RerollChoice>) =>
      rerollOutcome(days, choose({ scope: 'day', day: WEDNESDAY, ...over }), WEDNESDAY);

    expect(wednesday({})).toMatchObject({ days: 0, replaced: 0, keptCustom: 1, keptEaten: 0 });
    expect(wednesday({ replaceCustom: true })).toMatchObject({
      days: 0,
      replaced: 0,
      keptCustom: 0,
      keptEaten: 1,
    });
    expect(wednesday({ replaceEaten: true })).toMatchObject({
      days: 0,
      replaced: 0,
      keptCustom: 1,
      keptEaten: 0,
    });
    expect(wednesday({ replaceEaten: true, replaceCustom: true })).toMatchObject({
      days: 1,
      replaced: 1,
    });
  });

  it('keeps a meal that is locked to the recipe it has, and replaces one that was swapped away from its lock', () => {
    const locked = { lockedSlots: [{ mealType: 'breakfast' as const, recipeId: RECIPE }] };
    const kept = week({ [WEDNESDAY]: { overrides: locked } });
    const swapped = week({
      [WEDNESDAY]: {
        overrides: locked,
        meals: [
          aMeal('breakfast', {
            recipe: { id: '99999999-9999-4999-8999-999999999999' } as Meal['recipe'],
          }),
          aMeal('dinner'),
        ],
      },
    });

    expect(rerollOutcome(kept, choose({ scope: 'day', day: WEDNESDAY }), WEDNESDAY)).toMatchObject({
      days: 1,
      replaced: 1,
      keptLocked: 1,
    });
    expect(
      rerollOutcome(swapped, choose({ scope: 'day', day: WEDNESDAY }), WEDNESDAY),
    ).toMatchObject({ days: 1, replaced: 2, keptLocked: 0 });
  });

  it('leaves a day the user skips empty, and does not count a day on which every meal stays', () => {
    const days = week({
      [WEDNESDAY]: { skipped: true, meals: [] },
      '2026-01-08': { meals: [aMeal('breakfast', { eatenAt: '2026-01-08T08:00:00.000Z' })] },
    });

    expect(rerollOutcome(days, choose({ scope: 'from_today' }), WEDNESDAY)).toMatchObject({
      days: 0,
      replaced: 0,
      keptSkipped: 1,
      keptEaten: 1,
    });
  });

  it('fills a day that holds nothing and is not skipped', () => {
    expect(
      rerollOutcome(
        week({ [WEDNESDAY]: { meals: [] } }),
        choose({ scope: 'day', day: WEDNESDAY }),
        WEDNESDAY,
      ),
    ).toMatchObject({ days: 1, replaced: 0 });
  });
});

describe('what a re-roll can be asked to replace as well', () => {
  const days = week({
    '2026-01-05': { meals: [aMeal('breakfast', { eatenAt: '2026-01-05T08:00:00.000Z' })] },
    '2026-01-08': { meals: [aMeal('lunch', { source: 'USER_CUSTOM', recipe: null })] },
  });

  it('is days that have passed only where the days chosen have any', () => {
    expect(whatCouldGo(days, choose(), WEDNESDAY).past).toBe(true);
    expect(whatCouldGo(days, choose({ scope: 'from_today' }), WEDNESDAY).past).toBe(false);
  });

  it("is eaten meals and meals of the user's own only where the days that would be filled hold them", () => {
    // The eaten breakfast is on a day that has passed: it comes into question once that day does.
    expect(whatCouldGo(days, choose(), WEDNESDAY)).toEqual({
      past: true,
      eaten: false,
      custom: true,
    });
    expect(whatCouldGo(days, choose({ includePast: true }), WEDNESDAY)).toEqual({
      past: true,
      eaten: true,
      custom: true,
    });
    expect(whatCouldGo(days, choose({ scope: 'day', day: WEDNESDAY }), WEDNESDAY)).toEqual({
      past: false,
      eaten: false,
      custom: false,
    });
  });
});

describe('what a re-roll sends', () => {
  it('is nothing at all when it asks for nothing of its own', () => {
    expect(rerollBody({ planId: 'p' })).toBeUndefined();
    expect(rerollBody({ planId: 'p', dayId: 'd' })).toBeUndefined();
  });

  it('is what was chosen, and nothing that was not', () => {
    expect(
      rerollBody({
        planId: 'p',
        from: '2026-01-06',
        to: '2026-01-07',
        includePast: true,
        replaceEaten: true,
        replaceCustom: false,
        allowRelaxations: [],
      }),
    ).toEqual({
      from: '2026-01-06',
      to: '2026-01-07',
      includePast: true,
      replaceEaten: true,
      allowRelaxations: [],
    });
  });
});
