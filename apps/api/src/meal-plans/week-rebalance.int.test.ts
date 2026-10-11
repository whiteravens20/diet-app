// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, RebalanceResult } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('a plan with skipped days, and the rebalance of a week', () => {
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

  const rebalanceWeek = async (plan: MealPlan, date?: string): Promise<RebalanceResult> =>
    (await t.http().post(`/api/meal-plans/${plan.id}/rebalance`).set(as(user)).send({ scope: 'week', ...(date ? { date } : {}) }).expect(201)).body;
  /** A lunch the user ate out: far more than a day's lunch. */
  const aHeavyMeal = async (plan: MealPlan, date: string): Promise<MealPlan> =>
    (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${date}/custom-meal`)
        .set(as(user))
        .send({ mealType: 'lunch', name: 'Dinner out', nutrition: { calories: 1900, protein: 60, fat: 90, carbs: 200 } })
        .expect(201)
    ).body.plan;
  const kcalOf = (plan: MealPlan) => new Map(plan.days.map((day) => [day.date, day.dayNutrition.calories]));
  const dayOf = (plan: MealPlan, mealId: string) => plan.days.find((day) => day.meals.some((meal) => meal.id === mealId))!.date;

  describe('a day the user skips', () => {
    it('is shown as skipped, is no shortfall, and is left out of the plan\'s average', async () => {
      const plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 3, dayOverrides: [{ date: '2026-01-06', skip: true }] });

      const [first, skipped, third] = plan.days;
      expect(skipped).toMatchObject({ skipped: true, meals: [], calorieDelta: 0 });
      expect([first!.skipped, third!.skipped]).toEqual([false, false]);
      const eaten = (first!.dayNutrition.calories + third!.dayNutrition.calories) / 2;
      expect(Math.abs(plan.averageDailyNutrition.calories - eaten)).toBeLessThanOrEqual(1);
    });

    it('is not filled by a rebalance of its week: the other days stay as they are', async () => {
      const plan = await aPlan(t, user, await aProfile(t, user), { dayOverrides: [{ date: '2026-01-07', skip: true }, { date: '2026-01-09', skip: true }] });

      const { rebalance, plan: after } = await rebalanceWeek(plan, '2026-01-05');

      expect(rebalance).toMatchObject({ scope: 'week', feasibility: 'in-window', changes: [], unabsorbedKcal: 0 });
      expect(kcalOf(after)).toEqual(kcalOf(plan));
    });
  });

  describe('a week in which one day went far over', () => {
    it('changes only the days from the one asked for to the end of that week of the plan', async () => {
      const plan = await aHeavyMeal(await aPlan(t, user, await aProfile(t, user), { durationDays: 14 }), '2026-01-13');

      const { rebalance, plan: after } = await rebalanceWeek(plan, '2026-01-13');

      // The second week of the plan runs from the 12th to the 18th; the 12th lies before the day asked for.
      const touched = [...new Set(rebalance!.changes.map((change) => dayOf(after, change.mealId)))].sort();
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.every((date) => date > '2026-01-13' && date <= '2026-01-18')).toBe(true);
      const before = kcalOf(plan);
      for (const day of after.days.filter((d) => d.date < '2026-01-13' || d.date > '2026-01-18')) {
        expect(day.dayNutrition.calories, day.date).toBe(before.get(day.date));
      }
    });

    it('takes none of the other days out of its own window, and says what the week could not make up for', async () => {
      const plan = await aHeavyMeal(await aPlan(t, user, await aProfile(t, user)), '2026-01-06');
      const heavy = plan.days.find((day) => day.date === '2026-01-06')!;
      expect(heavy.calorieDelta).toBeGreaterThan(heavy.calorieTarget * 0.1);

      const { rebalance, plan: after } = await rebalanceWeek(plan, '2026-01-05');

      for (const day of after.days.filter((d) => d.date !== '2026-01-06')) {
        // A whole kilocalorie of rounding, at most, beyond the tenth.
        expect(day.dayNutrition.calories, day.date).toBeGreaterThanOrEqual(day.calorieTarget * 0.9 - 2);
        expect(day.dayNutrition.calories, day.date).toBeLessThanOrEqual(plan.days.find((d) => d.date === day.date)!.dayNutrition.calories);
      }
      expect(rebalance).toMatchObject({ scope: 'week', feasibility: 'best-effort' });
      expect(rebalance!.unabsorbedKcal).toBeGreaterThanOrEqual(0);
    });

    it('starts from today when no day is named: a plan that lies in the past is left alone', async () => {
      const plan = await aHeavyMeal(await aPlan(t, user, await aProfile(t, user)), '2026-01-06');

      const { rebalance } = await rebalanceWeek(plan);

      expect(rebalance).toMatchObject({ changes: [], unabsorbedKcal: 0 });
    });
  });

  it('flags a day that a typed target has put under the lowest a calculated plan goes', async () => {
    // A man's floor is 1500.
    const profile = await aProfile(t, user);
    const typed = await aPlan(t, user, profile, { durationDays: 2, calorieTargetOverride: 1000, dayOverrides: [{ date: '2026-01-06', calorieTarget: 2400 }] });
    const calculated = await aPlan(t, user, profile, { durationDays: 2 });

    expect(typed.days.map((day) => day.belowSafetyFloor)).toEqual([true, false]);
    expect(calculated.days.map((day) => day.belowSafetyFloor)).toEqual([false, false]);
  });
});
