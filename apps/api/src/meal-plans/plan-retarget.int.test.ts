// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { dayAfter, ProfileInput, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe("a running plan, once its profile's target moved", () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);
  const from = dayAfter(today, -2);
  /** A week from two days ago: a training day tomorrow, a rest day after it, a day with a target of its own. */
  const aWeek = {
    startDate: from,
    durationDays: 7,
    dayOverrides: [
      { date: dayAfter(today, 1), dayType: 'training' as const },
      { date: dayAfter(today, 2), dayType: 'rest' as const },
      { date: dayAfter(today, 3), calorieTarget: 1800 },
    ],
  };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    // 37 years, 190 cm, 91 kg, sedentary, half a kilogram a week: a target of 2135.
    profile = await aProfile(t, user, {
      age: 37,
      heightCm: 190,
      weightKg: 91,
      activityLevel: 'sedentary',
      weeklyLossTarget: '0.5',
    });
  });

  const http = () => t.http();
  const made = async (request: Record<string, unknown>): Promise<MealPlan> =>
    (
      await http()
        .post('/api/meal-plans/generate')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ profileId: profile.id, ...request })
        .expect(201)
    ).body;
  const read = async (plan: MealPlan): Promise<MealPlan> =>
    (
      await http()
        .get(`/api/meal-plans/${plan.id}`)
        .set(as(user))
        .set('X-Client-Date', today)
        .expect(200)
    ).body;
  const retarget = (plan: MealPlan, expected = 200) =>
    http()
      .post(`/api/meal-plans/${plan.id}/retarget`)
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ revision: plan.revision })
      .expect(expected);
  const save = async (change: Record<string, unknown>) =>
    http()
      .put(`/api/profiles/${profile.id}`)
      .set(as(user))
      .send({ ...ProfileInput.parse(profile), ...change })
      .expect(200);
  const dishes = (plan: MealPlan) =>
    plan.days.map((day) => day.meals.map((meal) => meal.recipe?.id ?? meal.customName));

  it("says that the profile's target moved, and takes the new one from today with the same dishes", async () => {
    const before = await made(aWeek);
    expect(before.targetMoved).toBeNull();

    // More activity: a target some three hundred kcal higher.
    await save({ activityLevel: 'light' });
    const told = await read(before);
    expect(told.targetMoved).toEqual({ profileTarget: expect.any(Number), planTarget: 2135 });
    const newTarget = told.targetMoved!.profileTarget;
    expect(newTarget - 2135).toBeGreaterThanOrEqual(100);

    const after = (await retarget(told)).body as MealPlan;
    expect(after.targetMoved).toBeNull();
    expect(after.weeks[0]!.target).toBe(newTarget);
    // The days from today aim at what a plan made now would give them, kinds of day kept.
    const now = await made(aWeek);
    for (const [index, day] of after.days.entries()) {
      if (day.date < today)
        expect(day.calorieTarget, day.date).toBe(before.days[index]!.calorieTarget);
      else expect(day.calorieTarget, day.date).toBe(now.days[index]!.calorieTarget);
    }
    // A day's own target is its own, and the dishes are those the plan had.
    expect(after.days.find((day) => day.date === dayAfter(today, 3))!.calorieTarget).toBe(1800);
    expect(dishes(after)).toEqual(dishes(before));
  });

  it('says nothing of a move under a hundred kcal', async () => {
    const plan = await made(aWeek);
    // A kilogram less moves the target by some ten kcal.
    await save({ weightKg: 90 });
    expect((await read(plan)).targetMoved).toBeNull();
  });

  it('says nothing for a plan whose target was typed for it, and leaves that target', async () => {
    const plan = await made({ ...aWeek, calorieTargetOverride: 1900 });
    await save({ activityLevel: 'light' });

    const told = await read(plan);
    expect(told.targetMoved).toBeNull();
    expect((await retarget(told, 409)).body.error).toBe('PLAN_TARGET_TYPED');
  });

  it('takes nothing from a revision of the plan that is not its own', async () => {
    const plan = await made(aWeek);
    await save({ activityLevel: 'light' });

    const stale = { ...(await read(plan)), revision: plan.revision + 5 };
    expect((await retarget(stale, 409)).body.error).toBe('PLAN_CHANGED');
  });
});
