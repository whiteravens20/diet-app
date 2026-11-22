// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { type DiaryDay, type MealPlan, type PlanCalendar, type Profile } from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/** What a person ate from a plan is theirs, not the plan's: it counts on its day whichever plan it came from. */
describe('what was eaten from a plan', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  afterAll(async () => {
    await t.close();
  });

  const read = async (planId: string): Promise<MealPlan> =>
    (await t.http().get(`/api/meal-plans/${planId}`).set(as(user)).expect(200)).body as MealPlan;
  const diaryOf = async (date: string, of: Profile = profile): Promise<DiaryDay> =>
    (await t.http().get(`/api/diary/day?profileId=${of.id}&date=${date}`).set(as(user)).expect(200))
      .body as DiaryDay;
  /** What every reader of a day takes from the diary: what was eaten, its label figures, the limits they cross. */
  const eatenOf = (day: DiaryDay) => ({
    eaten: day.eaten,
    eatenLabel: day.eatenLabel,
    labelNotes: day.labelNotes,
    estimated: day.estimated,
  });
  const calendarOf = async (from: string, to: string): Promise<PlanCalendar> =>
    (
      await t
        .http()
        .get(`/api/meal-plans/calendar?profileId=${profile.id}&from=${from}&to=${to}`)
        .set(as(user))
        .expect(200)
    ).body as PlanCalendar;
  const eat = (planId: string, mealId: string) =>
    t
      .http()
      .patch(`/api/meal-plans/${planId}/meals/${mealId}/eaten`)
      .set(as(user))
      .send({ eaten: true })
      .expect(200);

  it("counts what an older plan had eaten on a day in the diary's day, in the newer plan's day and in the calendar", async () => {
    const older = await aPlan(t, user, profile, { durationDays: 2 });
    const breakfast = older.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
    await eat(older.id, breakfast.id);
    const newer = await aPlan(t, user, profile, { durationDays: 2 });
    const date = older.days[0]!.date;

    const diary = await diaryOf(date);
    expect(diary.plan!.id).toBe(newer.id);
    expect(diary.otherPlans.map((meal) => [meal.planId, meal.id, meal.eaten])).toEqual([
      [older.id, breakfast.id, true],
    ]);
    // Nothing of the newer plan is eaten: what the day ate is the older plan's breakfast.
    expect(diary.eaten).toEqual(diary.otherPlans[0]!.nutrition);
    const day = (await read(newer.id)).days[0]!;
    expect(day.diary!.otherPlans.map((meal) => meal.id)).toEqual([breakfast.id]);
    expect(day.diary!.nutrition).toEqual(diary.otherPlans[0]!.nutrition);
    expect(day.diary!.entries).toBe(0);
    const calendar = await calendarOf(date, date);
    // The calendar's day counts it as the plan's day does.
    expect(calendar.days[0]!.calories).toBe(day.dayNutrition.calories);
  });

  it("sizes the newer plan's day of today again once a meal of the older plan is marked eaten on it, as an entry of the diary does", async () => {
    const older = await aPlan(t, user, profile, { durationDays: 2 });
    const newer = await aPlan(t, user, profile, { durationDays: 2 });
    const before = (await read(newer.id)).days[0]!;
    const planned = (day: MealPlan['days'][number]) =>
      day.meals.reduce((sum, meal) => sum + meal.nutrition.calories, 0);

    await eat(older.id, older.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!.id);

    const after = await read(newer.id);
    // Its meals make room for the breakfast eaten from the older plan.
    expect(planned(after.days[0]!)).toBeLessThan(planned(before));
    expect(after.days[0]!.diary!.otherPlans).toHaveLength(1);
  });

  it("copies a day's eaten meals with the figures the day counted for them, eggs taken whole among them", async () => {
    const plan = await aPlan(t, user, profile, { durationDays: 1 });
    const date = plan.days[0]!.date;
    const breakfast = plan.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
    // A serving and three quarters of eggs on toast: 5.25 eggs, cooked as five.
    const eggs = await t.prisma.recipe.findUniqueOrThrow({
      where: { slug: 'scrambled-eggs-on-toast' },
    });
    await t.prisma.plannedMeal.update({
      where: { id: breakfast.id },
      data: {
        recipeId: eggs.id,
        servings: 1.75,
        quantityScale: 1,
        source: 'CATALOGUE',
        plate: Prisma.DbNull,
      },
    });
    for (const meal of plan.days[0]!.meals) await eat(plan.id, meal.id);
    const from = await diaryOf(date);
    // A day no plan holds, of the year back the diary takes.
    const to = '2026-01-10';

    await t
      .http()
      .post('/api/diary/copy')
      .set(as(user))
      .send({ profileId: profile.id, from: date, to })
      .expect(201);

    expect(eatenOf(await diaryOf(to))).toEqual(eatenOf(from));
  });
});
