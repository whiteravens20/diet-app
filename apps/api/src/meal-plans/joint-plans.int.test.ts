// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  GeneratePlanRequest,
  ProfileInput,
  type MealPlan,
  type MealPlanPage,
  type PlannedMeal,
  type Profile,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfilesService } from '../profiles/profiles.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';

describe('a plan made together with another profile of the account', () => {
  let t: TestApp;
  let user: TestUser;
  let adam: Profile;
  let ewa: Profile;

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
    adam = await aProfile(t, user, { name: 'Adam', mealCount: 3 });
    ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
      mealCount: 4,
    });
  });

  const together = (overrides: Partial<GeneratePlanRequest> = {}): Promise<MealPlan> =>
    t.app.get(PlanGenerationService).generate(
      user.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: adam.id,
        withProfileId: ewa.id,
        startDate: '2026-01-05',
        durationDays: 3,
        ...overrides,
      }),
    );
  const read = (planId: string): Promise<MealPlan> =>
    t.app.get(MealPlansService).get(user.id, 'en', planId);
  const at = (plan: MealPlan, day: number, mealType: string): PlannedMeal | undefined =>
    plan.days[day]!.meals.find((meal) => meal.mealType === mealType);
  const save = (profile: Profile, change: Partial<ProfileInput>) =>
    t.app
      .get(ProfilesService)
      .update(
        user.id,
        profile.id,
        ProfileInput.parse({ ...ProfileInput.parse(profile), ...change }),
      );

  it('makes a plan for each, on the same days, each following its own profile, and says of each which the other is', async () => {
    const adams = await together();
    const ewas = await read(adams.joint!.planId);

    expect(adams.joint).toEqual({ planId: ewas.id, profileId: ewa.id, profileName: 'Ewa' });
    expect(ewas.joint).toEqual({ planId: adams.id, profileId: adam.id, profileName: 'Adam' });
    expect(ewas.days.map((day) => day.date)).toEqual(adams.days.map((day) => day.date));
    // Each plan follows its own profile: three meals a day for one, four for the other.
    expect(adams.days.map((day) => day.meals.length)).toEqual([3, 3, 3]);
    expect(ewas.days.map((day) => day.meals.length)).toEqual([4, 4, 4]);
    expect(adams.options.mealCount).toBeNull();
    expect(ewas.options.mealCount).toBeNull();
    expect(adams.report!.apart).toEqual([]);
  });

  it('holds the same dish at the times of day both have, linked as one meal, a portion sized to each', async () => {
    const adams = await together();
    const ewas = await read(adams.joint!.planId);

    for (const day of [0, 1, 2]) {
      for (const mealType of ['breakfast', 'lunch', 'dinner']) {
        const mine = at(adams, day, mealType)!;
        const hers = at(ewas, day, mealType)!;
        expect(hers.recipe!.id).toBe(mine.recipe!.id);
        expect(mine.shared).toMatchObject({
          apart: false,
          with: {
            mealId: hers.id,
            planId: ewas.id,
            profileName: 'Ewa',
            servings: hers.servings * hers.quantityScale,
            calories: hers.nutrition.calories,
            eaten: false,
          },
        });
        expect(hers.shared!.id).toBe(mine.shared!.id);
        expect(hers.shared!.with.mealId).toBe(mine.id);
      }
      // A time of day only one of them has is hers alone.
      expect(at(ewas, day, 'snack')!.shared).toBeNull();
    }
    // Her day is smaller than his: somewhere her portion of a shared dish is too.
    const portions = (plan: MealPlan) =>
      plan.days.flatMap((day) =>
        day.meals.filter((meal) => meal.shared).map((meal) => meal.servings * meal.quantityScale),
      );
    expect(portions(ewas).some((hers, index) => hers < portions(adams)[index]!)).toBe(true);
  });

  it('says what the pot of a shared dish takes: both portions together', async () => {
    const adams = await together();
    const ewas = await read(adams.joint!.planId);
    const mine = at(adams, 0, 'lunch')!;
    const hers = at(ewas, 0, 'lunch')!;
    // A plan that is not for cooking ahead cooks each meal for itself: the pot is the two portions of this meal.
    expect(mine.cookAhead).toBeNull();

    for (const line of mine.shared!.pot) {
      const own = mine.ingredients.find((one) => one.ingredientId === line.ingredientId)!;
      const theirs = hers.ingredients.find((one) => one.ingredientId === line.ingredientId)!;
      expect(line.quantity).toBeCloseTo(own.quantity + theirs.quantity, 6);
    }
    expect(hers.shared!.pot).toEqual(mine.shared!.pot);
  });

  it('plans apart a time of day no dish suits both at, and both plans say so', async () => {
    const oats = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'rolled-oats' } });
    // He skips oats and cannot have soy; she cannot have eggs or peanuts: no breakfast of the catalogue suits both.
    adam = await save(adam, {
      preferences: { ...adam.preferences, allergens: ['soy'], excludedIngredientIds: [oats.id] },
    });
    ewa = await save(ewa, { preferences: { ...ewa.preferences, allergens: ['eggs', 'peanuts'] } });

    const adams = await together();
    const ewas = await read(adams.joint!.planId);

    expect(adams.report!.apart).toEqual(['breakfast']);
    expect(ewas.report!.apart).toEqual(['breakfast']);
    for (const day of [0, 1, 2]) {
      expect(at(adams, day, 'breakfast')!.shared).toBeNull();
      expect(at(ewas, day, 'breakfast')!.shared).toBeNull();
      expect(at(adams, day, 'dinner')!.shared).not.toBeNull();
    }
  });

  it('holds a shared dish to what both may be given', async () => {
    ewa = await save(ewa, { preferences: { ...ewa.preferences, allergens: ['fish', 'dairy'] } });

    const adams = await together({ durationDays: 4 });
    const ewas = await read(adams.joint!.planId);

    for (const meal of adams.days.flatMap((day) => day.meals).filter((one) => one.shared)) {
      expect(meal.recipe!.allergens).not.toContain('fish');
      expect(meal.recipe!.allergens).not.toContain('dairy');
    }
    expect(
      ewas.days.flatMap((day) => day.meals).every((meal) => meal.restrictionConflicts.length === 0),
    ).toBe(true);
  });

  it('is listed with the plan it was made with', async () => {
    const adams = await together();

    const page: MealPlanPage = (
      await t.http().get(`/api/meal-plans?profileId=${ewa.id}`).set(as(user)).expect(200)
    ).body;
    expect(page.items[0]!.joint).toEqual({
      planId: adams.id,
      profileId: adam.id,
      profileName: 'Adam',
    });
  });

  it('leaves the other a plan of its own when one of the two is deleted, its shared meals its own again', async () => {
    const adams = await together();
    const ewasId = adams.joint!.planId;

    await t.http().delete(`/api/meal-plans/${adams.id}`).set(as(user)).expect(204);

    const ewas = await read(ewasId);
    expect(ewas.joint).toBeNull();
    expect(ewas.days.flatMap((day) => day.meals).every((meal) => meal.shared === null)).toBe(true);
    expect(await t.prisma.jointPlan.count()).toBe(0);
    expect(await t.prisma.sharedMeal.count()).toBe(0);
  });

  it('leaves the other a plan of its own when the profile of one of the two is deleted', async () => {
    const adams = await together();

    await t.http().delete(`/api/profiles/${ewa.id}`).set(as(user)).expect(204);

    const again = await read(adams.id);
    expect(again.joint).toBeNull();
    expect(again.days.flatMap((day) => day.meals).every((meal) => meal.shared === null)).toBe(true);
    expect(await t.prisma.jointPlan.count()).toBe(0);
    expect(await t.prisma.plannedMeal.count({ where: { sharedMealId: { not: null } } })).toBe(0);
  });

  it('uses up two of the makings of a plan a minute allows, being the work of two', async () => {
    const made = async (body: Record<string, string>): Promise<number> =>
      Number(
        (
          await t
            .http()
            .post('/api/meal-plans/generate')
            .set(as(user))
            .send({ startDate: '2026-01-05', durationDays: 2, ...body })
            .expect(201)
        ).headers['x-ratelimit-remaining'],
      );

    const afterOne = await made({ profileId: adam.id });
    const afterTwo = await made({ profileId: adam.id, withProfileId: ewa.id });

    expect(afterTwo).toBe(afterOne - 2);
  });

  it("is refused with another account's profile, with the same profile twice, and with settings of its days", async () => {
    const stranger = await aUser(t);
    const theirs = await aProfile(t, stranger);

    await expect(together({ withProfileId: theirs.id })).rejects.toMatchObject({
      response: { error: 'PROFILE_NOT_FOUND' },
    });
    await t
      .http()
      .post('/api/meal-plans/generate')
      .set(as(user))
      .send({
        profileId: adam.id,
        withProfileId: adam.id,
        startDate: '2026-01-05',
        durationDays: 3,
      })
      .expect(400);
    await t
      .http()
      .post('/api/meal-plans/generate')
      .set(as(user))
      .send({
        profileId: adam.id,
        withProfileId: ewa.id,
        startDate: '2026-01-05',
        durationDays: 3,
        dayOverrides: [{ date: '2026-01-05', dayType: 'training' }],
      })
      .expect(400);
    expect(await t.prisma.mealPlan.count()).toBe(0);
  });
});
