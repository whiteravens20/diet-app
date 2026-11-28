// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  dayAfter,
  ProfileInput,
  type ChangedPlan,
  type MealPlan,
  type Profile,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShoppingListsService } from '../shopping-lists/shopping-lists.service.js';
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

  it('says in its answer the lists the target taken made stop matching', async () => {
    const before = await made(aWeek);
    const list = await t.app.get(ShoppingListsService).generate(user.id, 'en', {
      planId: before.id,
      fromDate: today,
      toDate: before.days.at(-1)!.date,
    });
    await save({ activityLevel: 'light' });

    const after = (await retarget(await read(before))).body as ChangedPlan;

    expect(after.effects?.lists.map((one) => one.id)).toEqual([list.id]);
  });

  it("says that the profile's target moved, and takes the new one from today with the same dishes", async () => {
    const before = await made(aWeek);
    expect(before.targetMoved).toBeNull();

    // More activity: a target some three hundred kcal higher.
    await save({ activityLevel: 'light' });
    const told = await read(before);
    expect(told.targetMoved).toEqual({ profileTarget: expect.any(Number), planTarget: 2135 });
    const newTarget = told.targetMoved!.profileTarget;
    expect(newTarget - 2135).toBeGreaterThanOrEqual(100);
    const diaryOf = async (date: string) =>
      (
        await http()
          .get(`/api/diary/day?profileId=${profile.id}&date=${date}`)
          .set(as(user))
          .set('X-Client-Date', today)
          .expect(200)
      ).body.target as unknown;
    const diaryBefore = await diaryOf(from);

    const after = (await retarget(told)).body as MealPlan;
    // The diary's day before today aims at what it did as well.
    expect(await diaryOf(from)).toEqual(diaryBefore);
    expect(after.targetMoved).toBeNull();
    expect(after.weeks[0]!.target).toBe(newTarget);
    // The days from today aim at what a plan made now would give them, kinds of day kept.
    const now = await made(aWeek);
    for (const [index, day] of after.days.entries()) {
      // The days before today aim at what they did, the grams of protein of the plan's target then included.
      if (day.date < today) {
        expect(day.calorieTarget, day.date).toBe(before.days[index]!.calorieTarget);
        expect(day.targetMacros, day.date).toEqual(before.days[index]!.targetMacros);
      } else expect(day.calorieTarget, day.date).toBe(now.days[index]!.calorieTarget);
    }
    // A day's own target is its own, and the dishes are those the plan had.
    expect(after.days.find((day) => day.date === dayAfter(today, 3))!.calorieTarget).toBe(1800);
    expect(dishes(after)).toEqual(dishes(before));
  });

  it('keeps what the days before today aimed at when the whole plan is made again under the diet its profile has now', async () => {
    const before = await made(aWeek);
    // A dish with meat on a day before today, which the diet the profile takes now would not plan.
    const chicken = await t.prisma.recipe.findUniqueOrThrow({
      where: { slug: 'chicken-rice-broccoli' },
    });
    const gone = before.days[0]!;
    await t.prisma.plannedMeal.update({
      where: { id: gone.meals[0]!.id },
      data: { recipeId: chicken.id },
    });
    const kept = await read(before);
    expect(kept.days[0]!.meals[0]!.dietOverride).toBe(false);
    /** A meal of one's own of 600 kcal written into the diary of the first day: its macros estimated by the day's split. */
    const estimated = async () =>
      (
        await http()
          .post('/api/diary/entries')
          .set(as(user))
          .set('X-Client-Date', today)
          .send({
            profileId: profile.id,
            date: from,
            mealType: 'snack',
            kind: 'meal',
            name: 'Kanapka',
            nutrition: { calories: 600 },
          })
          .expect(201)
      ).body.nutrition as unknown;
    const estimatedBefore = await estimated();
    await save({ dietType: 'vegetarian', activityLevel: 'light' });

    const after = (
      await http()
        .post(`/api/meal-plans/${before.id}/regenerate`)
        .set(as(user))
        .set('X-Client-Date', today)
        .send({})
        .expect(201)
    ).body as MealPlan;

    expect(after.dietType).toBe('vegetarian');
    // The diary's day before today estimates by the split it had.
    expect(await estimated()).toEqual(estimatedBefore);
    for (const [index, day] of after.days.entries()) {
      if (day.date >= today) continue;
      expect(
        day.meals.map((meal) => meal.recipe?.id),
        day.date,
      ).toEqual(kept.days[index]!.meals.map((meal) => meal.recipe?.id));
      expect(day.targetMacros, day.date).toEqual(kept.days[index]!.targetMacros);
      expect(
        day.meals.map((meal) => meal.dietOverride),
        day.date,
      ).toEqual(kept.days[index]!.meals.map((meal) => meal.dietOverride));
    }
    // The days from today are made under the new diet.
    expect(
      after.days.filter((day) => day.date >= today).flatMap((day) => day.meals),
    ).not.toContainEqual(expect.objectContaining({ dietOverride: true }));
  });

  it("says that the profile's protein per kilogram moved on the custom diet, the target not, and takes it from today", async () => {
    // 80 kg at 1.6 g a kilogram: 128 g of protein a day.
    profile = await aProfile(t, user, {
      age: 37,
      heightCm: 190,
      weightKg: 80,
      activityLevel: 'sedentary',
      weeklyLossTarget: '0.5',
      dietType: 'custom',
      customMacroSplit: { protein: 25, fat: 30, carbs: 45 },
      customProteinPerKg: 1.6,
    });
    const before = await made(aWeek);
    expect(before.splitMoved).toBe(false);
    expect(before.days.find((day) => day.date === today)!.targetMacros.protein).toBe(128);

    // 0.8 g a kilogram: 64 g, and the same target.
    await save({ customProteinPerKg: 0.8 });
    const told = await read(before);
    expect([told.targetMoved, told.splitMoved]).toEqual([null, true]);

    const after = (await retarget(told)).body as MealPlan;
    expect(after.splitMoved).toBe(false);
    for (const [index, day] of after.days.entries()) {
      if (day.date < today)
        expect(day.targetMacros, day.date).toEqual(before.days[index]!.targetMacros);
      else expect(day.targetMacros.protein, day.date).toBe(64);
    }
  });

  it("takes the profile's split on the custom diet from today, a target typed for the plan staying", async () => {
    profile = await aProfile(t, user, {
      age: 37,
      heightCm: 190,
      weightKg: 80,
      activityLevel: 'sedentary',
      weeklyLossTarget: '0.5',
      dietType: 'custom',
      customMacroSplit: { protein: 25, fat: 30, carbs: 45 },
    });
    const before = await made({ ...aWeek, dayOverrides: [], calorieTargetOverride: 2000 });
    expect(before.splitMoved).toBe(false);

    await save({ customMacroSplit: { protein: 35, fat: 30, carbs: 35 } });
    const told = await read(before);
    expect([told.targetMoved, told.splitMoved]).toEqual([null, true]);

    const after = (await retarget(told)).body as MealPlan;
    expect(after.splitMoved).toBe(false);
    for (const [index, day] of after.days.entries()) {
      expect(day.calorieTarget, day.date).toBe(before.days[index]!.calorieTarget);
      if (day.date < today)
        expect(day.targetMacros, day.date).toEqual(before.days[index]!.targetMacros);
      // A third of 2000 kcal and more in protein: 175 g, against 125 g before.
      else expect(day.targetMacros.protein, day.date).toBe(175);
    }
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

  it('says that no loss is planned any more for somebody under 18, whatever the difference, a typed target too', async () => {
    // 18 years, 180 cm, 80 kg, moderately active: maintenance 2944, 2952 at 17; a target typed 52 kcal under that.
    profile = await aProfile(t, user, {
      age: 18,
      heightCm: 180,
      weightKg: 80,
      weeklyLossTarget: '0.5',
    });
    const plan = await made({ ...aWeek, dayOverrides: [], calorieTargetOverride: 2900 });
    expect(plan.targetMoved).toBeNull();

    await save({ age: 17 });
    const told = await read(plan);
    expect(told.targetMoved).toEqual({ profileTarget: 2952, planTarget: 2900 });

    const after = (await retarget(told)).body as MealPlan;
    expect(after.targetMoved).toBeNull();
    for (const day of after.days.filter((one) => one.date >= today))
      expect(day.calorieTarget, day.date).toBe(2950);
  });

  it('takes nothing from a revision of the plan that is not its own', async () => {
    const plan = await made(aWeek);
    await save({ activityLevel: 'light' });

    const stale = { ...(await read(plan)), revision: plan.revision + 5 };
    expect((await retarget(stale, 409)).body.error).toBe('PLAN_CHANGED');
  });
});
