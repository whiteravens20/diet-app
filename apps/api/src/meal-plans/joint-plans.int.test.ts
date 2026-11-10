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
import { aProfile, aSwap, aUser, as, type TestUser } from '../testing/factories.js';
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

  it('no longer shares a meal given another dish in one plan alone, in either plan', async () => {
    const adams = await together();
    const lunch = at(adams, 0, 'lunch')!;

    const swapped = await aSwap(t, user, {
      planId: adams.id,
      plannedMealId: lunch.id,
      strategy: 'random',
    });

    const ewas = await read(adams.joint!.planId);
    expect(at(swapped.plan, 0, 'lunch')!.shared).toBeNull();
    expect(at(ewas, 0, 'lunch')!.shared).toBeNull();
    expect(await t.prisma.sharedMeal.count({ where: { id: lunch.shared!.id } })).toBe(0);
    // The others stay shared.
    expect(at(swapped.plan, 0, 'dinner')!.shared).not.toBeNull();
    expect(at(ewas, 0, 'dinner')!.shared).not.toBeNull();
  });

  it('marks a shared meal eaten for both, as "we ate", and lets each mark only their own', async () => {
    const adams = await together();
    const lunch = at(adams, 0, 'lunch')!;
    const eat = (eaten: boolean, forAll: boolean) =>
      t
        .http()
        .patch(`/api/meal-plans/${adams.id}/meals/${lunch.id}/eaten`)
        .set(as(user))
        .send({ eaten, forAll })
        .expect(200);

    await eat(true, true);
    const ewas = await read(adams.joint!.planId);
    expect(at(await read(adams.id), 0, 'lunch')!.eatenAt).not.toBeNull();
    expect(at(ewas, 0, 'lunch')!.eatenAt).not.toBeNull();
    expect(at(await read(adams.id), 0, 'lunch')!.shared!.with.eaten).toBe(true);

    await eat(false, false);
    expect(at(await read(adams.id), 0, 'lunch')!.eatenAt).toBeNull();
    expect(at(await read(ewas.id), 0, 'lunch')!.eatenAt).not.toBeNull();
  });

  it('says how a shared meal is cooked, the same in both plans, and of no meal it does not share', async () => {
    const adams = await together();
    const dinner = at(adams, 1, 'dinner')!;

    const answered: MealPlan = (
      await t
        .http()
        .patch(`/api/meal-plans/${adams.id}/shared-meals/${dinner.shared!.id}`)
        .set(as(user))
        .send({ apart: true })
        .expect(200)
    ).body;

    expect(at(answered, 1, 'dinner')!.shared!.apart).toBe(true);
    expect(at(await read(adams.joint!.planId), 1, 'dinner')!.shared!.apart).toBe(true);
    expect(at(answered, 0, 'dinner')!.shared!.apart).toBe(false);
    // Another account's shared meal is none of this plan's.
    const stranger = await aUser(t);
    const theirs = await aProfile(t, stranger, { name: 'A' });
    const second = await aProfile(t, stranger, { name: 'B' });
    const strangers = await t.app.get(PlanGenerationService).generate(
      stranger.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: theirs.id,
        withProfileId: second.id,
        startDate: '2026-01-05',
        durationDays: 1,
      }),
    );
    const notOurs = strangers.days[0]!.meals.find((meal) => meal.shared)!.shared!.id;
    await t
      .http()
      .patch(`/api/meal-plans/${adams.id}/shared-meals/${notOurs}`)
      .set(as(user))
      .send({ apart: true })
      .expect(404);
  });

  it('marks in the diary a shared meal cooked in one pot as a split, and one cooked apart as none', async () => {
    const adams = await together();
    const dinner = at(adams, 0, 'dinner')!;
    await t
      .http()
      .patch(`/api/meal-plans/${adams.id}/shared-meals/${dinner.shared!.id}`)
      .set(as(user))
      .send({ apart: true })
      .expect(200);

    const diary = (
      await t
        .http()
        .get(`/api/diary/day?profileId=${ewa.id}&date=2026-01-05`)
        .set(as(user))
        .expect(200)
    ).body as { plan: { meals: { mealType: string; fromPot: boolean }[] } };
    const fromPot = Object.fromEntries(
      diary.plan.meals.map((meal) => [meal.mealType, meal.fromPot]),
    );
    expect(fromPot).toEqual({ breakfast: true, lunch: true, snack: false, dinner: false });
  });

  describe('a dish changed for both', () => {
    const offerFor = async (plan: MealPlan, meal: PlannedMeal, ask: Record<string, unknown>) =>
      (
        await t
          .http()
          .post('/api/meal-plans/swap-meal/preview')
          .set(as(user))
          .send({ planId: plan.id, plannedMealId: meal.id, strategy: 'random', ...ask })
          .expect(201)
      ).body as { recipe: { id: string; allergens: string[] }; revision: number };
    const take = (
      plan: MealPlan,
      meal: PlannedMeal,
      recipeId: string,
      revision: number,
      ask: Record<string, unknown>,
    ) =>
      t
        .http()
        .post('/api/meal-plans/swap-meal')
        .set(as(user))
        .send({
          planId: plan.id,
          plannedMealId: meal.id,
          recipeId,
          revision,
          strategy: 'random',
          ...ask,
        });

    it('goes on both meals, each sized to what that meal held, and the meal stays shared', async () => {
      const adams = await together();
      const lunch = at(adams, 0, 'lunch')!;
      const herDayBefore = (await read(adams.joint!.planId)).days[0]!;

      const offered = await offerFor(adams, lunch, { forAll: true });
      await take(adams, lunch, offered.recipe.id, offered.revision, { forAll: true }).expect(201);

      const mine = at(await read(adams.id), 0, 'lunch')!;
      const herPlan = await read(adams.joint!.planId);
      const hers = at(herPlan, 0, 'lunch')!;
      expect(mine.recipe!.id).toBe(offered.recipe.id);
      expect(hers.recipe!.id).toBe(offered.recipe.id);
      expect(mine.shared!.id).toBe(lunch.shared!.id);
      expect(hers.shared!.with.mealId).toBe(mine.id);
      // Hers is a portion of her own, and her day keeps its total, as a swap keeps the total of any day.
      expect(hers.servings * hers.quantityScale).not.toBe(mine.servings * mine.quantityScale);
      expect(
        Math.abs(herPlan.days[0]!.dayNutrition.calories - herDayBefore.dayNutrition.calories),
      ).toBeLessThanOrEqual(herDayBefore.dayNutrition.calories * 0.1);
    });

    it('offers only what the other may be given, and refuses a favourite that she may not', async () => {
      ewa = await save(ewa, { preferences: { ...ewa.preferences, allergens: ['fish'] } });
      const adams = await together();
      const lunch = at(adams, 0, 'lunch')!;
      const salmon = (
        await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'salmon-with-rice' } })
      ).id;

      const skip: string[] = [];
      for (let asked = 0; asked < 4; asked += 1) {
        const offered = await offerFor(adams, lunch, { forAll: true, skip });
        expect(offered.recipe.allergens).not.toContain('fish');
        skip.push(offered.recipe.id);
      }
      const favourite = await t
        .http()
        .post('/api/meal-plans/swap-meal/preview')
        .set(as(user))
        .send({
          planId: adams.id,
          plannedMealId: lunch.id,
          strategy: 'favorite',
          favoriteRecipeId: salmon,
          forAll: true,
        })
        .expect(400);
      expect(favourite.body.error).toBe('OFF_DIET_FAVORITE_NOT_ALLOWED');
      // For him alone it may: the meal is then his own.
      const mineAlone = await take(adams, lunch, salmon, adams.revision, {
        strategy: 'favorite',
      }).expect(201);
      expect(at(mineAlone.body.plan, 0, 'lunch')!.shared).toBeNull();
    });

    it('is taken back in both plans', async () => {
      const adams = await together();
      const lunch = at(adams, 0, 'lunch')!;
      const offered = await offerFor(adams, lunch, { forAll: true });
      const swapped = (
        await take(adams, lunch, offered.recipe.id, offered.revision, { forAll: true }).expect(201)
      ).body as { plan: MealPlan };

      await t
        .http()
        .post('/api/meal-plans/swap-meal/undo')
        .set(as(user))
        .send({ planId: adams.id, revision: swapped.plan.revision })
        .expect(200);

      const mine = at(await read(adams.id), 0, 'lunch')!;
      const hers = at(await read(adams.joint!.planId), 0, 'lunch')!;
      expect(mine.recipe!.id).toBe(lunch.recipe!.id);
      expect(hers.recipe!.id).toBe(lunch.recipe!.id);
      expect(mine.shared!.id).toBe(lunch.shared!.id);
    });
  });

  it('takes a shared meal off both days when asked for both, and off one day alone otherwise', async () => {
    const adams = await together();
    const [lunch, dinner] = [at(adams, 0, 'lunch')!, at(adams, 0, 'dinner')!];

    await t
      .http()
      .delete(`/api/meal-plans/${adams.id}/meals/${lunch.id}?forAll=true`)
      .set(as(user))
      .expect(200);
    await t
      .http()
      .delete(`/api/meal-plans/${adams.id}/meals/${dinner.id}`)
      .set(as(user))
      .expect(200);

    const ewas = await read(adams.joint!.planId);
    expect(at(ewas, 0, 'lunch')).toBeUndefined();
    expect(at(ewas, 0, 'dinner')!.shared).toBeNull();
    expect(
      await t.prisma.sharedMeal.count({
        where: { id: { in: [lunch.shared!.id, dinner.shared!.id] } },
      }),
    ).toBe(0);
  });

  describe('days made again', () => {
    const again = (plan: MealPlan, forAll: boolean, date = '2026-01-06') =>
      t
        .http()
        .post(`/api/meal-plans/${plan.id}/regenerate`)
        .set(as(user))
        .send({ from: date, to: date, includePast: true, forAll })
        .expect(201);

    it('for both, at the times both have, hold one dish again, shared, and leave the other days as they were', async () => {
      const adams = await together();
      const before = await read(adams.joint!.planId);

      await again(adams, true);

      const mine = await read(adams.id);
      const hers = await read(adams.joint!.planId);
      for (const mealType of ['breakfast', 'lunch', 'dinner']) {
        const own = at(mine, 1, mealType)!;
        expect(at(hers, 1, mealType)!.recipe!.id).toBe(own.recipe!.id);
        expect(own.shared!.with.mealId).toBe(at(hers, 1, mealType)!.id);
      }
      expect(at(hers, 1, 'snack')!.shared).toBeNull();
      // The days not made again are as they were, still shared.
      expect(hers.days[0]!.meals.map((meal) => meal.id)).toEqual(
        before.days[0]!.meals.map((meal) => meal.id),
      );
      expect(at(mine, 2, 'lunch')!.shared).not.toBeNull();
    });

    it('for one alone keep shared a meal both ate on that day', async () => {
      const adams = await together();
      // A meal of today, the first day of the plan, can be eaten already.
      const lunch = at(adams, 0, 'lunch')!;
      await t
        .http()
        .patch(`/api/meal-plans/${adams.id}/meals/${lunch.id}/eaten`)
        .set(as(user))
        .send({ eaten: true, forAll: true })
        .expect(200);

      await again(adams, false, '2026-01-05');

      const mine = at(await read(adams.id), 0, 'lunch')!;
      expect(mine.id).toBe(lunch.id);
      expect(mine.shared!.id).toBe(lunch.shared!.id);
      expect(at(await read(adams.id), 0, 'dinner')!.shared).toBeNull();
    });

    it('for one alone, leave what that day shared its own, in both plans', async () => {
      const adams = await together();

      await again(adams, false);

      const mine = await read(adams.id);
      const hers = await read(adams.joint!.planId);
      expect(mine.days[1]!.meals.every((meal) => meal.shared === null)).toBe(true);
      expect(hers.days[1]!.meals.every((meal) => meal.shared === null)).toBe(true);
      expect(at(mine, 0, 'lunch')!.shared).not.toBeNull();
    });
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
