// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the limits of a plan', () => {
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

  const generate = (body: Record<string, unknown>) =>
    t.http().post('/api/meal-plans/generate').set(as(user)).send({ profileId: profile.id, startDate: '2026-01-05', ...body });
  const regenerate = (plan: MealPlan, body?: Record<string, unknown>) => t.http().post(`/api/meal-plans/${plan.id}/regenerate`).set(as(user)).send(body);
  const fresh = async (plan: MealPlan): Promise<MealPlan> => (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body;

  // The catalogue has five breakfasts. Six days of breakfast and dinner with no recipe twice: the sixth
  // breakfast has none left, and nothing else is short.
  const sixBreakfasts = { durationDays: 6, mealCount: 2, maxRepeatsPerRecipe: 1 };
  const theSixth = { date: '2026-01-10', slot: 'breakfast', gaveWay: ['variety_floor'] };

  it('refuses a plan that could only be filled outside them, says which limits and which meals, and writes nothing', async () => {
    const refused = await generate(sixBreakfasts).expect(422);

    expect(refused.body).toMatchObject({
      error: 'PLAN_NEEDS_RELAXATION',
      details: { needs: ['variety_floor'], meals: [theSixth] },
    });
    expect(await t.prisma.mealPlan.count()).toBe(0);
  });

  it('makes the plan once the limits it named may give way, and lets none give way where it need not', async () => {
    const made: MealPlan = (await generate({ ...sixBreakfasts, allowRelaxations: ['variety_floor'] }).expect(201)).body;

    expect(made.options.allowRelaxations).toEqual(['variety_floor']);
    const breakfasts = made.days.map((day) => day.meals.find((meal) => meal.mealType === 'breakfast')!.recipe!.id);
    expect(new Set(breakfasts.slice(0, 5)).size).toBe(5);
    const dinners = made.days.map((day) => day.meals.find((meal) => meal.mealType === 'dinner')!.recipe!.id);
    expect(new Set(dinners).size).toBe(6);
  });

  it('does not let a limit give way that was not named', async () => {
    const refused = await generate({ ...sixBreakfasts, allowRelaxations: ['weekly_cap', 'cook_time'] }).expect(422);

    expect(refused.body.details.needs).toEqual(['variety_floor']);
  });

  it('refuses a limit it does not know', async () => {
    await generate({ ...sixBreakfasts, allowRelaxations: ['calories'] }).expect(400);
  });

  it('is made again with what it may let give way, and is refused, unchanged, once that is taken back', async () => {
    const made: MealPlan = (await generate({ ...sixBreakfasts, allowRelaxations: ['variety_floor'] }).expect(201)).body;

    const again: MealPlan = (await regenerate(made).expect(201)).body;

    const refused = await regenerate(again, { allowRelaxations: [] }).expect(422);
    expect(refused.body).toMatchObject({ error: 'PLAN_NEEDS_RELAXATION', details: { needs: ['variety_floor'], meals: [theSixth] } });
    const after = await fresh(again);
    expect(after.revision).toBe(again.revision);
    expect(after.options.allowRelaxations).toEqual(['variety_floor']);
    expect(after.days.map((day) => day.meals.map((meal) => meal.id))).toEqual(again.days.map((day) => day.meals.map((meal) => meal.id)));
  });

  it('keeps with the plan what a later regeneration let give way', async () => {
    // Made inside its limits; then the floor is as tight as before, by way of the profile's limit for a week.
    const strict: MealPlan = (await generate({ durationDays: 6, mealCount: 2 }).expect(201)).body;
    await t.prisma.profilePreference.update({ where: { profileId: profile.id }, data: { maxTimesPerWeekSameMeal: 1 } });

    expect((await regenerate(strict).expect(422)).body.details.needs).toEqual(['weekly_cap']);
    const allowed: MealPlan = (await regenerate(strict, { allowRelaxations: ['weekly_cap'] }).expect(201)).body;

    expect(allowed.options.allowRelaxations).toEqual(['weekly_cap']);
    // From here on the plan is made again without asking.
    await regenerate(allowed).expect(201);
  });

  describe('a day with less cooking time than any recipe takes', () => {
    // Every recipe of the catalogue takes twenty minutes.
    const aRushedDay = { durationDays: 2, dayOverrides: [{ date: '2026-01-06', cookTimeBudgetMinutes: 15 }] };
    const outsideOnTheSecondDay = ['breakfast', 'lunch', 'dinner'].map((slot) => ({ date: '2026-01-06', slot, gaveWay: ['cook_time'] }));

    it('is refused with every meal of that day named, and made once the cooking time may give way', async () => {
      const refused = await generate(aRushedDay).expect(422);
      expect(refused.body.details).toEqual({ needs: ['cook_time'], meals: outsideOnTheSecondDay });

      await generate({ ...aRushedDay, allowRelaxations: ['cook_time'] }).expect(201);
    });

    it('is changed on its own within what the plan may let give way, or within what the request says', async () => {
      const made: MealPlan = (await generate({ ...aRushedDay, allowRelaxations: ['cook_time'] }).expect(201)).body;
      const changeDay = (body?: Record<string, unknown>) => t.http().post(`/api/meal-plans/${made.id}/days/${made.days[1]!.id}/regenerate`).set(as(user)).send(body);

      await changeDay().expect(201);
      expect((await changeDay({ allowRelaxations: [] }).expect(422)).body.details).toEqual({ needs: ['cook_time'], meals: outsideOnTheSecondDay });
      // What a request says for one day is not kept with the plan.
      expect((await fresh(made)).options.allowRelaxations).toEqual(['cook_time']);
    });
  });
});
