// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('what a profile would rather not eat', () => {
  let t: TestApp;
  let user: TestUser;
  let tofu: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    tofu = (await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'firm-tofu' } })).id;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
  });

  const read = async (plan: MealPlan): Promise<MealPlan> =>
    (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body;
  const meals = (plan: MealPlan) => plan.days.flatMap((day) => day.meals);
  const holds = (meal: MealPlan['days'][number]['meals'][number], ingredientId: string): boolean =>
    meal.ingredients.some((line) => line.ingredientId === ingredientId);
  const dislike = (profile: Profile, dislikedIngredientIds: string[]) =>
    t
      .http()
      .patch(`/api/profiles/${profile.id}/preferences`)
      .set(as(user))
      .send({ dislikedIngredientIds })
      .expect(200);

  it('is in no meal of a plan that has another recipe for every meal', async () => {
    // Every meal of the catalogue has several recipes without tofu: a week of three meals a day can do without it.
    const profile = await aProfile(t, user, {
      preferences: { dislikedIngredientIds: [tofu] } as Profile['preferences'],
    });

    const plan = await aPlan(t, user, profile);

    expect(meals(plan)).toHaveLength(7 * 3);
    expect(meals(plan).filter((meal) => holds(meal, tofu))).toEqual([]);
    expect(meals(plan).every((meal) => meal.dislikedIngredientIds.length === 0)).toBe(true);
  });

  it('is planned all the same where the diet leaves nothing else: a dislike is no exclusion', async () => {
    // The vegan lunches and dinners of the catalogue without tofu are the same two recipes. A day takes both, and
    // neither may be eaten three days in a row: on the third day only what holds tofu is left inside the limits.
    const profile = await aProfile(t, user, {
      dietType: 'vegan',
      preferences: { dislikedIngredientIds: [tofu] } as Profile['preferences'],
    });

    const plan = await aPlan(t, user, profile, { durationDays: 3 });

    const withTofu = meals(plan).filter((meal) => holds(meal, tofu));
    expect(meals(plan)).toHaveLength(3 * 3);
    // No limit gave way for the sake of a dislike.
    expect(plan.report?.relaxations).toEqual([]);
    expect(withTofu.length).toBeGreaterThan(0);
    // The plan says of each such meal what it holds that the profile would rather not eat.
    for (const meal of withTofu) expect(meal.dislikedIngredientIds).toEqual([tofu]);
    for (const meal of meals(plan).filter((other) => !holds(other, tofu)))
      expect(meal.dislikedIngredientIds).toEqual([]);
  });

  it('is said of a meal that was planned before the profile came to dislike it, and the plan is not rewritten', async () => {
    const profile = await aProfile(t, user);
    const plan = await aPlan(t, user, profile);
    const first = meals(plan)[0]!;
    const ingredient = first.ingredients[0]!.ingredientId;
    expect(first.dislikedIngredientIds).toEqual([]);

    await dislike(profile, [ingredient]);

    const after = await read(plan);
    expect(meals(after).map((meal) => meal.recipe?.id)).toEqual(
      meals(plan).map((meal) => meal.recipe?.id),
    );
    for (const meal of meals(after))
      expect(meal.dislikedIngredientIds).toEqual(holds(meal, ingredient) ? [ingredient] : []);
    expect(meals(after)[0]!.dislikedIngredientIds).toEqual([ingredient]);
    // A dislike is not a restriction: nothing is in conflict with the profile.
    expect(meals(after).every((meal) => meal.restrictionConflicts.length === 0)).toBe(true);
  });

  it('is kept with the profile as ingredients, and only as ingredients', async () => {
    const profile = await aProfile(t, user);

    const changed = await dislike(profile, [tofu]);
    const refused = await t
      .http()
      .patch(`/api/profiles/${profile.id}/preferences`)
      .set(as(user))
      .send({ dislikedIngredientIds: ['liver'] })
      .expect(400);

    expect(changed.body.preferences.dislikedIngredientIds).toEqual([tofu]);
    expect(refused.body.issues[0].path).toBe('dislikedIngredientIds.0');
  });
});
