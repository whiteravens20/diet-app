// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, RebalanceResult } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DATE = '2026-01-06';

describe("a meal of the user's own in the place of a planned one, and a meal taken off its day", () => {
  let t: TestApp;
  let user: TestUser;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user));
  });

  afterAll(async () => {
    await t.close();
  });

  const dayOf = (of: MealPlan, date = DATE) => of.days.find((day) => day.date === date)!;
  const ownMeal = (replaces?: string, status = 201) =>
    t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${DATE}/custom-meal`)
      .set(as(user))
      .send({
        name: 'Pizza out',
        mealType: 'dinner',
        nutrition: { calories: 900, protein: 35, fat: 35, carbs: 110 },
        ...(replaces ? { replaces } : {}),
      })
      .expect(status);

  it('takes the planned meal off the day when the own one is eaten in its place, and fits the rest of the day around it', async () => {
    const dinner = dayOf(plan).meals.find((meal) => meal.mealType === 'dinner')!;

    const { plan: after } = (await ownMeal(dinner.id)).body as RebalanceResult;

    const day = dayOf(after);
    expect(day.meals.some((meal) => meal.id === dinner.id)).toBe(false);
    expect(
      day.meals.filter((meal) => meal.source === 'USER_CUSTOM').map((meal) => meal.customName),
    ).toEqual(['Pizza out']);
    expect(Math.abs(day.dayNutrition.calories - day.calorieTarget)).toBeLessThanOrEqual(
      day.calorieTarget * 0.1,
    );
  });

  it('puts the own meal beside the others when it takes no place', async () => {
    const { plan: after } = (await ownMeal()).body as RebalanceResult;
    expect(dayOf(after).meals).toHaveLength(dayOf(plan).meals.length + 1);
  });

  it('refuses to take the place of a meal of another day, and changes nothing', async () => {
    const other = dayOf(plan, '2026-01-07').meals[0]!;

    expect((await ownMeal(other.id, 404)).body.error).toBe('MEAL_NOT_FOUND');

    const after = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;
    expect(after.days.map((day) => day.meals.map((meal) => meal.id))).toEqual(
      plan.days.map((day) => day.meals.map((meal) => meal.id)),
    );
  });

  it('takes a meal off its day, and the meals that are left take its share', async () => {
    const lunch = dayOf(plan).meals.find((meal) => meal.mealType === 'lunch')!;

    const { plan: after, rebalance } = (
      await t
        .http()
        .delete(`/api/meal-plans/${plan.id}/meals/${lunch.id}`)
        .set(as(user))
        .expect(200)
    ).body as RebalanceResult;

    expect(dayOf(after).meals.map((meal) => meal.mealType)).toEqual(['breakfast', 'dinner']);
    expect(rebalance).toMatchObject({ scope: 'day' });
    expect(dayOf(after).dayNutrition.calories).toBeGreaterThan(
      dayOf(plan).dayNutrition.calories - lunch.nutrition.calories,
    );
    expect(after.revision).toBe(plan.revision + 1);
  });

  it("takes the user's own meal off its day as well", async () => {
    const { plan: withOwn } = (await ownMeal()).body as RebalanceResult;
    const own = dayOf(withOwn).meals.find((meal) => meal.source === 'USER_CUSTOM')!;

    const { plan: after } = (
      await t.http().delete(`/api/meal-plans/${plan.id}/meals/${own.id}`).set(as(user)).expect(200)
    ).body as RebalanceResult;

    expect(dayOf(after).meals.some((meal) => meal.source === 'USER_CUSTOM')).toBe(false);
  });
});
