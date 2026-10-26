// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, RebalanceResult } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;
/** The day `offset` days from today: the API takes a client's date only near its own. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

describe('a plan with skipped days, and the rebalance of the rest of a plan', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Rebalance the plan from `date` (today when left out) to its end. */
  const rebalanceRest = async (plan: MealPlan, date?: string): Promise<RebalanceResult> =>
    (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/rebalance`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ scope: 'plan', ...(date ? { date } : {}) })
        .expect(201)
    ).body;
  /** The scale of each meal of a plan. */
  const scalesOf = (plan: MealPlan) =>
    new Map(plan.days.flatMap((day) => day.meals.map((meal) => [meal.id, meal.quantityScale])));
  /** A lunch the user ate out: far more than a day's lunch. */
  const aHeavyMeal = async (plan: MealPlan, date: string): Promise<MealPlan> =>
    (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${date}/custom-meal`)
        .set(as(user))
        .send({
          mealType: 'lunch',
          name: 'Dinner out',
          nutrition: { calories: 1900, protein: 60, fat: 90, carbs: 200 },
        })
        .expect(201)
    ).body.plan;
  const kcalOf = (plan: MealPlan) =>
    new Map(plan.days.map((day) => [day.date, day.dayNutrition.calories]));
  const dayOf = (plan: MealPlan, mealId: string) =>
    plan.days.find((day) => day.meals.some((meal) => meal.id === mealId))!.date;

  describe('a day the user skips', () => {
    it("is shown as skipped, is no shortfall, and is left out of the plan's average", async () => {
      const plan = await aPlan(t, user, await aProfile(t, user), {
        durationDays: 3,
        dayOverrides: [{ date: '2026-01-06', skip: true }],
      });

      const [first, skipped, third] = plan.days;
      expect(skipped).toMatchObject({ skipped: true, meals: [], calorieDelta: 0, offTarget: null });
      // A day the plan was made for stands inside the window around its target.
      expect([first!.offTarget, third!.offTarget]).toEqual([null, null]);
      expect([first!.skipped, third!.skipped]).toEqual([false, false]);
      const eaten = (first!.dayNutrition.calories + third!.dayNutrition.calories) / 2;
      expect(Math.abs(plan.averageDailyNutrition.calories - eaten)).toBeLessThanOrEqual(1);
    });

    it('is not filled by a rebalance of the rest of the plan: the other days stay as they are', async () => {
      const plan = await aPlan(t, user, await aProfile(t, user), {
        startDate: day(0),
        dayOverrides: [
          { date: day(2), skip: true },
          { date: day(4), skip: true },
        ],
      });

      const { rebalance, plan: after } = await rebalanceRest(plan, day(0));

      expect(rebalance).toMatchObject({
        scope: 'plan',
        feasibility: 'in-window',
        changes: [],
        unabsorbedKcal: 0,
      });
      expect(kcalOf(after)).toEqual(kcalOf(plan));
    });
  });

  describe('a plan in which one day went far over', () => {
    it('changes only the days from the one asked for to the end of the plan, past the end of its week', async () => {
      // Today is the last day of the plan's first week, and the plan runs a week on.
      const plan = await aHeavyMeal(
        await aPlan(t, user, await aProfile(t, user), { startDate: day(-6), durationDays: 14 }),
        day(0),
      );

      const { rebalance, plan: after } = await rebalanceRest(plan, day(0));

      const touched = [
        ...new Set(rebalance!.changes.map((change) => dayOf(after, change.mealId))),
      ].sort();
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.every((date) => date >= day(0) && date <= day(7))).toBe(true);
      expect(touched.some((date) => date > day(0))).toBe(true);
      const before = kcalOf(plan);
      for (const earlier of after.days.filter((d) => d.date < day(0))) {
        expect(earlier.dayNutrition.calories, earlier.date).toBe(before.get(earlier.date));
      }
    });

    it('makes up for a day before today with the days from today on, and leaves its own meals as they are', async () => {
      const plan = await aHeavyMeal(
        await aPlan(t, user, await aProfile(t, user), { startDate: day(-2) }),
        day(-1),
      );

      const { rebalance, plan: after } = await rebalanceRest(plan, day(-1));

      const touched = new Set(rebalance!.changes.map((change) => dayOf(after, change.mealId)));
      expect(touched.size).toBeGreaterThan(0);
      expect([...touched].every((date) => date >= day(0))).toBe(true);
      const scales = scalesOf(plan);
      for (const meal of after.days.find((d) => d.date === day(-1))!.meals)
        expect(meal.quantityScale, meal.id).toBe(scales.get(meal.id));
    });

    it('takes none of the other days out of its own window, and says what the days could not make up for', async () => {
      const plan = await aHeavyMeal(
        await aPlan(t, user, await aProfile(t, user), { startDate: day(0) }),
        day(1),
      );
      const heavy = plan.days.find((d) => d.date === day(1))!;
      expect(heavy.calorieDelta).toBeGreaterThan(heavy.calorieTarget * 0.1);
      // The day says so itself, for as long as it stands over: no notice that goes away has to be caught.
      expect(heavy.offTarget).toBe('over');
      expect(plan.days.filter((d) => d.date !== day(1)).map((d) => d.offTarget)).toEqual(
        plan.days.slice(1).map(() => null),
      );

      const { rebalance, plan: after } = await rebalanceRest(plan, day(0));

      for (const other of after.days.filter((d) => d.date !== day(1))) {
        // A whole kilocalorie of rounding, at most, beyond the tenth.
        expect(other.dayNutrition.calories, other.date).toBeGreaterThanOrEqual(
          other.calorieTarget * 0.9 - 2,
        );
        expect(other.dayNutrition.calories, other.date).toBeLessThanOrEqual(
          plan.days.find((d) => d.date === other.date)!.dayNutrition.calories,
        );
      }
      expect(rebalance).toMatchObject({ scope: 'plan', feasibility: 'best-effort' });
      expect(rebalance!.unabsorbedKcal).toBeGreaterThanOrEqual(0);
    });

    it('starts from today when no day is named: a plan that lies in the past is left alone', async () => {
      const plan = await aHeavyMeal(
        await aPlan(t, user, await aProfile(t, user), { startDate: day(-10) }),
        day(-9),
      );

      const { rebalance } = await rebalanceRest(plan);

      expect(rebalance).toMatchObject({ changes: [], unabsorbedKcal: 0 });
    });
  });

  it('flags a day that a typed target has put under the lowest a calculated plan goes', async () => {
    // A man's floor is 1500.
    const profile = await aProfile(t, user);
    const typed = await aPlan(t, user, profile, {
      durationDays: 2,
      calorieTargetOverride: 1000,
      dayOverrides: [{ date: '2026-01-06', calorieTarget: 2400 }],
    });
    const calculated = await aPlan(t, user, profile, { durationDays: 2 });

    expect(typed.days.map((day) => day.belowSafetyFloor)).toEqual([true, false]);
    expect(calculated.days.map((day) => day.belowSafetyFloor)).toEqual([false, false]);
  });
});
