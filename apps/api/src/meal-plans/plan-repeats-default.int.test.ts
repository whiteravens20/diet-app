// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the most a recipe repeats in a plan, where the operator set a number', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp({ DEFAULT_MAX_REPEATS_PER_RECIPE: '1' });
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
    t
      .http()
      .post('/api/meal-plans/generate')
      .set(as(user))
      .send({ profileId: profile.id, startDate: '2026-01-05', ...body });

  // The catalogue has five breakfasts: six days of breakfast and dinner with no recipe twice leave the sixth breakfast without one.
  const sixDays = { durationDays: 6, mealCount: 2 };
  const theSixth = { date: '2026-01-10', slot: 'breakfast', gaveWay: ['variety_floor'] };
  const breakfasts = (plan: MealPlan) =>
    plan.days.map((day) => day.meals.find((meal) => meal.mealType === 'breakfast')!.recipe!.id);

  it('is published, so that the form of a plan can say it', async () => {
    const { plans } = (await t.http().get('/api/config').expect(200)).body;

    expect(plans).toEqual({ maxRepeatsPerRecipe: 1 });
  });

  it('holds a plan that names no number of its own: it is refused as one that named it would be', async () => {
    const refused = await generate(sixDays).expect(422);

    expect(refused.body).toMatchObject({
      error: 'PLAN_NEEDS_RELAXATION',
      details: { needs: ['variety_floor'], meals: [theSixth] },
    });
    expect(await t.prisma.mealPlan.count()).toBe(0);
  });

  it('gives way where the plan lets it, and the plan keeps that it named no number', async () => {
    const made: MealPlan = (
      await generate({ ...sixDays, allowRelaxations: ['variety_floor'] }).expect(201)
    ).body;

    expect(made.options.maxRepeatsPerRecipe).toBeNull();
    expect(made.report).toMatchObject({ relaxations: [theSixth] });
    expect(new Set(breakfasts(made).slice(0, 5)).size).toBe(5);
  });

  it('holds the plan when it is made again', async () => {
    const made: MealPlan = (
      await generate({ ...sixDays, allowRelaxations: ['variety_floor'] }).expect(201)
    ).body;

    const again: MealPlan = (
      await t.http().post(`/api/meal-plans/${made.id}/regenerate`).set(as(user)).send().expect(201)
    ).body;

    // Outside the limit where it has to be, as before: a plan held to no number would have nothing to say.
    expect(again.report).toMatchObject({ relaxations: [theSixth] });
    expect(new Set(breakfasts(again).slice(0, 5)).size).toBe(5);
  });

  it('leaves a plan that names its own number to that number', async () => {
    const made: MealPlan = (await generate({ ...sixDays, maxRepeatsPerRecipe: 2 }).expect(201))
      .body;

    expect(made.options.maxRepeatsPerRecipe).toBe(2);
    expect(made.report).toMatchObject({ relaxations: [] });
    expect(new Set(breakfasts(made)).size).toBeLessThan(6);
  });
});
