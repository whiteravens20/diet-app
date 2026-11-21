// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;
/** The day `offset` days from today: the API takes a client's date only near its own. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

describe('lunch, the main meal of a day', () => {
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

  /** What each time of day of the plan's first day holds, in kcal, as the meals are sized. */
  const energyOf = async (planId: string) => {
    const meals = await t.prisma.plannedMeal.findMany({
      where: { day: { planId, date: new Date(day(0)) } },
      include: { recipe: { select: { caloriesPerServing: true } } },
    });
    return new Map(
      meals.map((meal) => [
        meal.mealType,
        {
          id: meal.id,
          servings: meal.servings,
          kcal: meal.recipe!.caloriesPerServing * meal.servings * meal.quantityScale,
        },
      ]),
    );
  };

  it('sizes a day whose dinner stands above its lunch to a dinner no larger than lunch', async () => {
    const profile = await aProfile(t, user, { mealCount: 3 });
    const plan = await aPlan(t, user, profile, { startDate: day(0), durationDays: 1 });

    // A day whose lunch was given a small portion and whose dinner took the rest of the day.
    const made = await energyOf(plan.id);
    const quarters = (servings: number) => Math.min(3, Math.max(0.5, Math.round(servings * 4) / 4));
    await t.prisma.plannedMeal.update({
      where: { id: made.get('lunch')!.id },
      data: { servings: quarters(made.get('lunch')!.servings * 0.7), quantityScale: 1 },
    });
    await t.prisma.plannedMeal.update({
      where: { id: made.get('dinner')!.id },
      data: { servings: quarters(made.get('dinner')!.servings * 1.3), quantityScale: 1 },
    });
    const before = await energyOf(plan.id);
    expect(before.get('dinner')!.kcal).toBeGreaterThan(before.get('lunch')!.kcal * 1.2);

    const read = async () =>
      (
        await t
          .http()
          .get(`/api/meal-plans/${plan.id}`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .expect(200)
      ).body as MealPlan;
    await t
      .http()
      .post(`/api/meal-plans/${plan.id}/rebalance`)
      .set(as(user))
      .set('X-Client-Date', day(0))
      .send({ scope: 'day', date: day(0) })
      .expect(201);

    const after = await energyOf(plan.id);
    const target = (await read()).days[0]!.calorieTarget;
    expect(after.get('dinner')!.kcal).toBeLessThanOrEqual(after.get('lunch')!.kcal + 0.01 * target);
    const total = [...after.values()].reduce((sum, meal) => sum + meal.kcal, 0);
    expect(Math.abs(total - target)).toBeLessThanOrEqual(0.1 * target);
  });
});
