// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { GeneratePlanRequest } from '@diet-app/shared';
import { planDates } from '@/lib/plan-dates';
import { buildAdvancedRequest, type AdvancedValue } from './advanced-options';

const RECIPE = '00000000-0000-4000-8000-000000000001';
const dates = planDates('2026-03-02', 3);
/** The request the form would send, checked as the API checks it. */
const asSent = (value: AdvancedValue) =>
  GeneratePlanRequest.safeParse({
    profileId: '00000000-0000-4000-8000-000000000002',
    startDate: '2026-03-02',
    durationDays: 3,
    ...buildAdvancedRequest(value, dates),
  });

describe('what the plan form says of single days', () => {
  it('names the days of the plan one after another', () => {
    expect(dates).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
    expect(planDates('2026-12-31', 2)).toEqual(['2026-12-31', '2027-01-01']);
    expect(planDates('not a day', 3)).toEqual([]);
  });

  it('is nothing for days the user left alone', () => {
    expect(buildAdvancedRequest({ days: {} }, dates)).toEqual({
      maxRepeatsPerRecipe: undefined,
      allowRelaxations: undefined,
      dayOverrides: undefined,
    });
    expect(
      buildAdvancedRequest({ days: { '2026-03-03': {} } }, dates).dayOverrides,
    ).toBeUndefined();
  });

  it('carries a locked meal for a day that is planned', () => {
    const request = buildAdvancedRequest(
      { days: { '2026-03-03': { lockSlot: 'lunch', lockRecipeId: RECIPE, dayKind: 'training' } } },
      dates,
    );

    expect(request.dayOverrides).toEqual([
      {
        date: '2026-03-03',
        dayType: 'training',
        lockedSlots: [{ mealType: 'lunch', recipeId: RECIPE }],
      },
    ]);
  });

  it('leaves a lock out of a day that was switched to skip after the lock was picked: the API would refuse the two together', () => {
    const value: AdvancedValue = {
      days: { '2026-03-03': { lockSlot: 'lunch', lockRecipeId: RECIPE, dayKind: 'skip' } },
    };

    expect(buildAdvancedRequest(value, dates).dayOverrides).toEqual([
      { date: '2026-03-03', skip: true },
    ]);
    expect(asSent(value).success).toBe(true);
  });

  it('says nothing of a day that is no longer a day of the plan', () => {
    const value: AdvancedValue = {
      days: { '2026-03-09': { mealCount: 2 }, '2026-03-04': { mealCount: 4 } },
    };

    expect(buildAdvancedRequest(value, dates).dayOverrides).toEqual([
      { date: '2026-03-04', mealCount: 4 },
    ]);
    expect(asSent(value).success).toBe(true);
  });

  describe('with a favourite set for a day', () => {
    const sets = [
      {
        id: 's1',
        profileId: 'p',
        label: 'Workday',
        slots: { breakfast: 'r-breakfast', lunch: 'r-lunch', second_breakfast: 'r-second' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const locked = (value: AdvancedValue, mealsADay = 3) =>
      buildAdvancedRequest(value, dates, sets, mealsADay).dayOverrides?.[0]?.lockedSlots;

    it("locks the set's recipes for the meals the day has, and leaves out the ones for meals it has not", () => {
      // Three meals a day are breakfast, lunch and dinner: no second breakfast.
      expect(locked({ days: { '2026-03-03': { setId: 's1' } } })).toEqual([
        { mealType: 'breakfast', recipeId: 'r-breakfast' },
        { mealType: 'lunch', recipeId: 'r-lunch' },
      ]);
    });

    it('goes by the number of meals the day itself was given', () => {
      const meals = locked({ days: { '2026-03-03': { setId: 's1', mealCount: 5 } } })!.map(
        (lock) => lock.mealType,
      );

      expect(meals).toContain('second_breakfast');
    });

    it("lets a meal locked by hand go before the set's recipe for the same meal", () => {
      expect(
        locked({
          days: { '2026-03-03': { setId: 's1', lockSlot: 'lunch', lockRecipeId: RECIPE } },
        }),
      ).toEqual([
        { mealType: 'breakfast', recipeId: 'r-breakfast' },
        { mealType: 'lunch', recipeId: RECIPE },
      ]);
    });

    it('locks nothing on a day that is skipped, and nothing for a set the profile no longer has', () => {
      expect(
        buildAdvancedRequest(
          { days: { '2026-03-03': { setId: 's1', dayKind: 'skip' } } },
          dates,
          sets,
        ).dayOverrides,
      ).toEqual([{ date: '2026-03-03', skip: true }]);
      expect(
        buildAdvancedRequest({ days: { '2026-03-03': { setId: 'gone' } } }, dates, sets)
          .dayOverrides,
      ).toBeUndefined();
    });
  });
});
