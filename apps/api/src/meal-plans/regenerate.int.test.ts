// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { HttpException } from '@nestjs/common';
import { AddCustomMealRequest, ProfileInput, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfilesService } from '../profiles/profiles.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aSwap, aUser, race } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';

describe('regenerating a plan', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('replaces the meals and keeps one day per date', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 14 });

    const regenerated = await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id);

    expect(regenerated.days.map((day) => day.date)).toEqual(plan.days.map((day) => day.date));
    expect(await t.prisma.mealPlanDay.count({ where: { planId: plan.id } })).toBe(14);
  });

  it('advances the revision by one for each change', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));
    expect(plan.revision).toBe(0);

    const once = await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id);
    const twice = await t.app
      .get(PlanGenerationService)
      .regenerateDay(user.id, 'en', plan.id, once.days[0]!.id);

    expect(once.revision).toBe(1);
    expect(twice.revision).toBe(2);
  });

  it('keeps one day per date when two regenerations overlap', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 28 });
    const plans = t.app.get(MealPlansService);

    for (let round = 0; round < 3; round += 1) {
      const results = await race(2, () =>
        t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id),
      );

      // One request wins. The other is told the plan changed; it never writes.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(refusals(results)).toEqual(['PLAN_CHANGED']);
      expect(await t.prisma.mealPlanDay.count({ where: { planId: plan.id } })).toBe(28);
    }
    expect((await plans.get(user.id, 'en', plan.id)).revision).toBe(3);
  });

  it('keeps one meal per slot when two re-rolls of a day overlap', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));
    const day = plan.days[2]!;

    const results = await race(2, () =>
      t.app.get(PlanGenerationService).regenerateDay(user.id, 'en', plan.id, day.id),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refusals(results)).toEqual(['PLAN_CHANGED']);
    const meals = await t.prisma.plannedMeal.findMany({ where: { dayId: day.id } });
    expect(meals.map((m) => m.mealType).sort()).toEqual(['breakfast', 'dinner', 'lunch']);
  });

  it('answers 409 over HTTP to a change computed from an older revision', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));

    const results = await race(2, () =>
      t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id),
    );
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;

    expect(refused.reason).toBeInstanceOf(HttpException);
    expect((refused.reason as HttpException).getStatus()).toBe(409);
  });

  describe('asks again for what the plan was asked for', () => {
    const recipeId = async (slug: string): Promise<string> =>
      (await t.prisma.recipe.findUniqueOrThrow({ where: { slug } })).id;
    const targets = (plan: MealPlan) => plan.days.map((day) => day.calorieTarget);
    const catalogueMeals = (plan: MealPlan) =>
      plan.days.map((day) => day.meals.filter((meal) => meal.source === 'CATALOGUE').length);
    const mealOf = (plan: MealPlan, day: number, mealType: string) =>
      plan.days[day]!.meals.find((meal) => meal.mealType === mealType)!;
    const save = (userId: string, profile: Profile, change: Partial<ProfileInput>) =>
      t.app
        .get(ProfilesService)
        .update(
          userId,
          profile.id,
          ProfileInput.parse({ ...ProfileInput.parse(profile), ...change }),
        );

    it('shows what it was asked for, and what was left to the profile', async () => {
      const user = await aUser(t);
      const profile = await aProfile(t, user);
      const asked = await aPlan(t, user, profile, {
        dietType: 'vegan',
        mealCount: 4,
        calorieTargetOverride: 1900,
        mealPrepFriendly: true,
        respectExclusions: false,
        respectFavorites: false,
        respectInventory: false,
        maxRepeatsPerRecipe: 3,
      });
      const left = await aPlan(t, user, profile, { startDate: '2026-02-02' });

      const shown = async (plan: MealPlan) =>
        (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body.options;

      expect(await shown(asked)).toEqual({
        dietType: 'vegan',
        mealCount: 4,
        calorieTargetOverride: 1900,
        mealPrepFriendly: true,
        respectExclusions: false,
        respectFavorites: false,
        respectInventory: false,
        maxRepeatsPerRecipe: 3,
        allowRelaxations: [],
      });
      expect(await shown(left)).toEqual({
        dietType: null,
        mealCount: null,
        calorieTargetOverride: null,
        mealPrepFriendly: false,
        respectExclusions: true,
        respectFavorites: true,
        respectInventory: true,
        maxRepeatsPerRecipe: null,
        allowRelaxations: [],
      });
      expect(
        (await t.app.get(PlanGenerationService).regenerate(user.id, 'en', asked.id)).options,
      ).toEqual(asked.options);
    });

    it('keeps a target that was typed for the plan', async () => {
      const user = await aUser(t);
      const plan = await aPlan(t, user, await aProfile(t, user), {
        durationDays: 3,
        calorieTargetOverride: 1800,
      });
      expect(targets(plan)).toEqual([1800, 1800, 1800]);

      expect(
        targets(await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id)),
      ).toEqual([1800, 1800, 1800]);
    });

    it('keeps the diet it was asked for, and follows the profile where the diet was left to the profile', async () => {
      const user = await aUser(t);
      const profile = await aProfile(t, user);
      const asked = await aPlan(t, user, profile, { dietType: 'vegan' });
      const left = await aPlan(t, user, profile, { startDate: '2026-02-02' });
      await save(user.id, profile, { dietType: 'vegetarian' });

      const askedAgain = await t.app.get(PlanGenerationService).regenerate(user.id, 'en', asked.id);
      const leftAgain = await t.app.get(PlanGenerationService).regenerate(user.id, 'en', left.id);

      expect(askedAgain.dietType).toBe('vegan');
      for (const day of askedAgain.days)
        for (const meal of day.meals) expect(meal.recipe!.dietTags).toContain('vegan');
      expect(leftAgain.dietType).toBe('vegetarian');
      for (const day of leftAgain.days)
        for (const meal of day.meals) expect(meal.recipe!.dietTags).toContain('vegetarian');
    });

    it('gives a day the number of meals the plan was asked for, where the day has none to count', async () => {
      const user = await aUser(t);
      const plan = await aPlan(t, user, await aProfile(t, user), {
        durationDays: 2,
        mealCount: 5,
        dayOverrides: [{ date: '2026-01-06', skip: true }],
      });
      const plans = t.app.get(MealPlansService);
      // A meal of the user's own makes the skipped day a day again, with no meal of the catalogue on it.
      const soup = AddCustomMealRequest.parse({
        name: 'Soup',
        mealType: 'lunch',
        nutrition: { calories: 300, protein: 10, fat: 10, carbs: 40 },
      });
      expect(
        catalogueMeals(
          (await plans.addCustomMeal(user.id, 'en', plan.id, '2026-01-06', soup)).plan,
        ),
      ).toEqual([5, 0]);

      expect(
        catalogueMeals(
          await t.app
            .get(PlanGenerationService)
            .regenerateDay(user.id, 'en', plan.id, plan.days[1]!.id),
        ),
      ).toEqual([5, 5]);
      expect(
        catalogueMeals(await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id)),
      ).toEqual([5, 5]);
    });

    it('goes on leaving the skipped ingredients aside, when it is made again and when a meal of it is changed', async () => {
      const user = await aUser(t);
      const banana = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'banana' } });
      const profile = await aProfile(t, user);
      const skipping = await save(user.id, profile, {
        preferences: { ...profile.preferences, excludedIngredientIds: [banana.id] },
      });
      const porridge = await recipeId('oat-porridge-with-banana');
      const plan = await aPlan(t, user, skipping, {
        durationDays: 2,
        respectExclusions: false,
        dayOverrides: [
          { date: '2026-01-05', lockedSlots: [{ mealType: 'breakfast', recipeId: porridge }] },
        ],
      });
      // The meal holds what the profile skips because the plan was asked to: that is no conflict.
      expect(mealOf(plan, 0, 'breakfast')).toMatchObject({
        recipe: { id: porridge },
        restrictionConflicts: [],
      });

      const again = await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id);
      expect(mealOf(again, 0, 'breakfast')).toMatchObject({
        recipe: { id: porridge },
        restrictionConflicts: [],
      });
      const oneDay = await t.app
        .get(PlanGenerationService)
        .regenerateDay(user.id, 'en', plan.id, again.days[0]!.id);
      expect(mealOf(oneDay, 0, 'breakfast').recipe!.id).toBe(porridge);

      const toast = await recipeId('peanut-butter-toast');
      const swapped = await aSwap(t, user, {
        planId: plan.id,
        plannedMealId: mealOf(oneDay, 1, 'breakfast').id,
        strategy: 'favorite',
        favoriteRecipeId: toast,
      });
      expect(mealOf(swapped.plan, 1, 'breakfast')).toMatchObject({
        recipe: { id: toast },
        restrictionConflicts: [],
      });
    });

    it('keeps the most times a recipe may appear in it', async () => {
      const user = await aUser(t);
      const plan = await aPlan(t, user, await aProfile(t, user), { maxRepeatsPerRecipe: 2 });
      const most = (of: MealPlan): number => {
        const times = new Map<string, number>();
        for (const day of of.days)
          for (const meal of day.meals)
            times.set(meal.recipe!.id, (times.get(meal.recipe!.id) ?? 0) + 1);
        return Math.max(...times.values());
      };
      expect(most(plan)).toBeLessThanOrEqual(2);

      expect(
        most(await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id)),
      ).toBeLessThanOrEqual(2);
    });

    it('draws each generation with a value of its own, and keeps the value', async () => {
      const user = await aUser(t);
      const plan = await aPlan(t, user, await aProfile(t, user));
      const seed = async () =>
        (await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).seed;
      const first = await seed();

      await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id);

      expect(Number.isInteger(first)).toBe(true);
      expect(await seed()).not.toBe(first);
    });
  });

  it('refuses a second day for a date the plan already has', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));

    await expect(
      t.prisma.mealPlanDay.create({
        data: { planId: plan.id, date: new Date(plan.days[0]!.date), calorieTarget: 2000 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

/** The error codes of the requests that were refused. */
function refusals(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => {
      const response = r.reason instanceof HttpException ? r.reason.getResponse() : undefined;
      return typeof response === 'object' && response !== null && 'error' in response
        ? String(response.error)
        : String(r.reason);
    });
}
