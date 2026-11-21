// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, MealPlanPage, PlanOverview, RebalanceResult } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;
/** The day `offset` days from today: the API takes a client's date only near its own. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

describe("a plan's average day", () => {
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

  it('counts each day as it stands, its diary included: a day resized around the diary is no shortfall', async () => {
    const profile = await aProfile(t, user);
    const plan = await aPlan(t, user, profile, { startDate: day(0), durationDays: 2 });

    // Something eaten beside the plan today, and the day's meals resized to make room for it.
    await t
      .http()
      .post('/api/diary/entries')
      .set(as(user))
      .set('X-Client-Date', day(0))
      .send({
        profileId: profile.id,
        date: day(0),
        mealType: 'snack',
        kind: 'meal',
        name: 'Cake at work',
        nutrition: { calories: 800, protein: 10, fat: 40, carbs: 100 },
      })
      .expect(201);
    const resized = (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/rebalance`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ scope: 'day', date: day(0) })
        .expect(201)
    ).body as RebalanceResult;
    expect(resized.rebalance).toMatchObject({ scope: 'day' });

    const shown = (
      await t
        .http()
        .get(`/api/meal-plans/${plan.id}`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .expect(200)
    ).body as MealPlan;
    const [today, tomorrow] = shown.days;
    // The meals of today alone are far under the day's target: the diary holds the rest.
    const mealsToday = today!.meals.reduce((sum, meal) => sum + meal.nutrition.calories, 0);
    expect(mealsToday).toBeLessThan(today!.calorieTarget * 0.8);
    expect(today!.offTarget).toBeNull();

    // The average is of the days as they stand, and stands at the target.
    const asTheyStand = (today!.dayNutrition.calories + tomorrow!.dayNutrition.calories) / 2;
    expect(Math.abs(shown.averageDailyNutrition.calories - asTheyStand)).toBeLessThanOrEqual(1);
    expect(shown.averageOff.calories).toBeNull();

    // The list and the dashboard say the same average.
    const page = (
      await t
        .http()
        .get('/api/meal-plans')
        .query({ profileId: profile.id })
        .set(as(user))
        .set('X-Client-Date', day(0))
        .expect(200)
    ).body as MealPlanPage;
    expect(page.items.find((item) => item.id === plan.id)!.averageDailyNutrition).toEqual(
      shown.averageDailyNutrition,
    );
    const overview = (
      await t
        .http()
        .get('/api/meal-plans/overview')
        .query({ profileId: profile.id })
        .set(as(user))
        .set('X-Client-Date', day(0))
        .expect(200)
    ).body as { overview: PlanOverview | null };
    expect(overview.overview!.energy.planned).toBe(shown.averageDailyNutrition.calories);
  });
});
