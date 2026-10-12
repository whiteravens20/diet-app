// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, MealSwapPreview, PlannedMeal } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

describe('putting another recipe in the place of a planned meal', () => {
  let t: TestApp;
  let user: TestUser;
  let plan: MealPlan;
  /** The lunch of the plan's only day. */
  let lunch: PlannedMeal;

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
    t.model.reset();
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 1 });
    lunch = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
  });

  const now = (): Promise<MealPlan> => t.app.get(MealPlansService).get(user.id, 'en', plan.id);
  const asked = (over: Record<string, unknown> = {}) => ({ planId: plan.id, plannedMealId: lunch.id, strategy: 'random', ...over });
  const offer = (over: Record<string, unknown> = {}) => t.http().post('/api/meal-plans/swap-meal/preview').set(as(user)).send(asked(over));
  const take = (preview: MealSwapPreview, over: Record<string, unknown> = {}) =>
    t.http().post('/api/meal-plans/swap-meal').set(as(user)).send({ ...asked(), recipeId: preview.recipe.id, revision: preview.revision, ...over });
  const recipeId = async (slug: string): Promise<string> => (await t.prisma.recipe.findUniqueOrThrow({ where: { slug } })).id;
  /** The lunches the catalogue has besides the one on the plate and the recipes of the day's other meals. */
  const otherLunches = async (): Promise<string[]> => {
    const onTheDay = (await now()).days[0]!.meals.map((meal) => meal.recipe!.id);
    return (await t.prisma.recipe.findMany({ where: { mealTypes: { has: 'lunch' }, id: { notIn: onTheDay } }, orderBy: { id: 'asc' } })).map((recipe) => recipe.id);
  };
  /** Make the day's dinner a recipe that would do for its lunch as well, and is not its lunch. */
  const aLunchForDinner = async (): Promise<string> => {
    const both = await t.prisma.recipe.findFirstOrThrow({ where: { mealTypes: { hasEvery: ['lunch', 'dinner'] }, id: { not: lunch.recipe!.id } }, orderBy: { slug: 'asc' } });
    const dinner = plan.days[0]!.meals.find((meal) => meal.mealType === 'dinner')!;
    await t.prisma.plannedMeal.update({ where: { id: dinner.id }, data: { recipeId: both.id } });
    return both.id;
  };

  describe('the offer', () => {
    it('names a recipe and says what the swap would do to the meal and to the day', async () => {
      const preview: MealSwapPreview = (await offer().expect(201)).body;
      const day = plan.days[0]!;

      expect(preview.recipe.id).not.toBe(lunch.recipe!.id);
      expect(preview.recipe.mealTypes).toContain('lunch');
      expect(preview.before).toEqual(lunch.nutrition);
      expect(preview.after.calories).toBe(Math.round(preview.recipe.nutritionPerServing.calories * preview.servings));
      expect(preview.dayBefore).toEqual(day.dayNutrition);
      expect(preview.dayAfter.calories).toBe(day.dayNutrition.calories - lunch.nutrition.calories + preview.after.calories);
      expect(preview.dayAfter.protein).toBe(day.dayNutrition.protein - lunch.nutrition.protein + preview.after.protein);
      expect(preview).toMatchObject({ calorieTarget: day.calorieTarget, revision: plan.revision });
    });

    it('writes nothing', async () => {
      await offer().expect(201);

      const after = await now();
      expect(after.revision).toBe(plan.revision);
      expect(after.days[0]!.meals.map((meal) => meal.recipe!.id)).toEqual(plan.days[0]!.meals.map((meal) => meal.recipe!.id));
    });

    it('is a recipe of which a serving holds about as much as the meal does', async () => {
      // Every other lunch of the catalogue is offered in turn.
      const others = await otherLunches();
      const seen: string[] = [];
      for (let round = 0; round < others.length; round += 1) {
        const preview: MealSwapPreview = (await offer({ skip: seen }).expect(201)).body;
        expect(Math.abs(preview.after.calories - preview.before.calories), preview.recipe.title).toBeLessThanOrEqual(preview.before.calories * 0.15 + 1);
        seen.push(preview.recipe.id);
      }
      expect(others.length).toBeGreaterThanOrEqual(5);
      expect([...seen].sort()).toEqual(others);
    });

    it('goes round again once every recipe was offered', async () => {
      const all = await otherLunches();

      const preview: MealSwapPreview = (await offer({ skip: all }).expect(201)).body;

      expect(all).toContain(preview.recipe.id);
    });

    it('is never a recipe another meal of the day holds', async () => {
      const dinner = await aLunchForDinner();

      const seen: string[] = [];
      for (let round = 0; round < 7; round += 1) seen.push(((await offer({ skip: seen }).expect(201)).body as MealSwapPreview).recipe.id);

      expect(seen).not.toContain(dinner);
    });

    it.each([
      ['is for cooking ahead', { mealPrepFriendly: true }],
      ['was let have a recipe twice a day', { allowRelaxations: ['same_day'] }],
    ])('may be one where the plan %s', async (_, option) => {
      const kept = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      await t.prisma.mealPlan.update({ where: { id: plan.id }, data: { options: { ...(kept.options as object), ...option } } });
      const dinner = await aLunchForDinner();

      const seen: string[] = [];
      for (let round = 0; round < 7; round += 1) seen.push(((await offer({ skip: seen }).expect(201)).body as MealSwapPreview).recipe.id);

      expect(seen).toContain(dinner);
    });

    it('is refused where no recipe holds about as much, and a favourite picked by hand is offered all the same', async () => {
      // A lunch of a hundred kilocalories: half a serving of anything the catalogue has holds twice that.
      await t.prisma.plannedMeal.update({ where: { id: lunch.id }, data: { servings: 0.5, quantityScale: 0.3 } });

      expect((await offer().expect(404)).body.error).toBe('NO_ALTERNATIVE');

      const byHand: MealSwapPreview = (await offer({ strategy: 'favorite', favoriteRecipeId: await recipeId('egg-fried-rice') }).expect(201)).body;
      expect(byHand.servings).toBe(0.5);
      expect(byHand.after.calories).toBeGreaterThan(byHand.before.calories * 1.15);
    });

    it('says that the plan changed where the plan went while the offer was being made', async () => {
      // The meal is there when the swap looks it up, and gone with its day when the plan is read for the offer.
      const plans = t.app.get(MealPlansService);
      const read = plans.get.bind(plans);
      const spy = vi.spyOn(plans, 'get').mockImplementationOnce(async (...args) => {
        await t.prisma.mealPlanDay.deleteMany({ where: { planId: plan.id } });
        return read(...args);
      });
      try {
        expect((await offer().expect(409)).body.error).toBe('PLAN_CHANGED');
      } finally {
        spy.mockRestore();
      }
    });

    it('is refused for a favourite the profile rules out, with the rule', async () => {
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      await t.prisma.profilePreference.update({ where: { profileId: profile.id }, data: { allergens: ['fish'] } });

      const refused = await offer({ strategy: 'favorite', favoriteRecipeId: await recipeId('salmon-with-rice') }).expect(400);

      expect(refused.body).toMatchObject({ error: 'OFF_DIET_FAVORITE_NOT_ALLOWED', details: { violations: ['allergen'] } });
    });
  });

  describe('taking the offer', () => {
    it('puts the offered recipe in the place of the meal, in the servings that were offered', async () => {
      const preview: MealSwapPreview = (await offer().expect(201)).body;

      const taken = await take(preview).expect(201);

      const meal = (taken.body.plan as MealPlan).days[0]!.meals.find((candidate) => candidate.id === lunch.id)!;
      expect(meal.recipe!.id).toBe(preview.recipe.id);
      expect(meal.servings).toBe(preview.servings);
      expect((taken.body.plan as MealPlan).revision).toBe(plan.revision + 1);
      // Before the day is balanced around it, the meal holds what the offer said.
      expect(Math.round(meal.nutrition.calories / meal.quantityScale)).toBeCloseTo(preview.after.calories, -1);
    });

    it('is refused on a plan that changed since the offer, and nothing is written', async () => {
      const preview: MealSwapPreview = (await offer().expect(201)).body;
      const breakfast = plan.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
      await t.http().patch(`/api/meal-plans/${plan.id}/meals/${breakfast.id}/eaten`).set(as(user)).send({ eaten: true }).expect(200);

      expect((await take(preview).expect(409)).body.error).toBe('PLAN_CHANGED');
      expect((await now()).days[0]!.meals.find((meal) => meal.id === lunch.id)!.recipe!.id).toBe(lunch.recipe!.id);
    });

    it('judges the recipe again: what the profile rules out is refused whatever was offered', async () => {
      const preview: MealSwapPreview = (await offer().expect(201)).body;
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      await t.prisma.profilePreference.update({ where: { profileId: profile.id }, data: { allergens: preview.recipe.allergens.length > 0 ? preview.recipe.allergens : ['fish'] } });

      const refused = await take(preview, preview.recipe.allergens.length > 0 ? {} : { recipeId: await recipeId('salmon-with-rice') }).expect(400);

      expect(refused.body).toMatchObject({ error: 'RECIPE_NOT_ELIGIBLE', details: { violations: ['allergen'] } });
    });

    it('refuses a recipe that was not offered because no serving of it holds about as much as the meal', async () => {
      await t.prisma.plannedMeal.update({ where: { id: lunch.id }, data: { servings: 0.5, quantityScale: 0.3 } });
      const fresh = await now();

      const refused = await t
        .http()
        .post('/api/meal-plans/swap-meal')
        .set(as(user))
        .send({ ...asked(), recipeId: await recipeId('egg-fried-rice'), revision: fresh.revision })
        .expect(400);
      expect(refused.body.error).toBe('RECIPE_NOT_ELIGIBLE');

      // Picked by hand as a favourite, the same recipe is the user's own choice.
      await t
        .http()
        .post('/api/meal-plans/swap-meal')
        .set(as(user))
        .send({ ...asked({ strategy: 'favorite' }), recipeId: await recipeId('egg-fried-rice'), revision: fresh.revision })
        .expect(201);
    });

    it('refuses a recipe that was not offered because another meal of the day holds it, unless it was picked by hand', async () => {
      const dinner = await aLunchForDinner();
      const send = (strategy: string) => t.http().post('/api/meal-plans/swap-meal').set(as(user)).send({ ...asked({ strategy }), recipeId: dinner, revision: plan.revision });

      const refused = await send('random');
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('RECIPE_NOT_ELIGIBLE');

      const taken = await send('favorite');
      expect(taken.status).toBe(201);
      expect((taken.body.plan as MealPlan).days[0]!.meals.filter((meal) => meal.recipe!.id === dinner)).toHaveLength(2);
    });
  });

  describe('with a model asked', () => {
    beforeEach(async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    });

    it('offers the recipe the model named, says who picked, and writes nothing', async () => {
      const named = (await otherLunches())[2]!;
      t.model.reply({ text: JSON.stringify({ recipeId: named, reason: 'Lighter.' }) });

      const preview = (await t.http().post('/api/meal-plans/ai-swap-meal/preview').set(as(user)).send({ planId: plan.id, plannedMealId: lunch.id }).expect(201)).body;

      expect(preview.recipe.id).toBe(named);
      expect(preview.aiMeta).toMatchObject({ usedDeterministicFallback: false, reason: 'Lighter.' });
      expect(preview.revision).toBe(plan.revision);
      expect((await now()).revision).toBe(plan.revision);

      await take(preview).expect(201);
      expect((await now()).days[0]!.meals.find((meal) => meal.id === lunch.id)!.recipe!.id).toBe(named);
    });

    describe('what the meal says of who chose its recipe', () => {
      const lunchNow = async (): Promise<PlannedMeal> => (await now()).days[0]!.meals.find((meal) => meal.id === lunch.id)!;
      /** An offer a model picked, with the note that came with it. */
      const aModelsOffer = async (reason: unknown = 'Lighter.') => {
        t.model.reply({ text: JSON.stringify({ recipeId: (await otherLunches())[2]!, reason }) });
        return (await t.http().post('/api/meal-plans/ai-swap-meal/preview').set(as(user)).send({ planId: plan.id, plannedMealId: lunch.id }).expect(201)).body as MealSwapPreview & { pick: string | null };
      };

      it('is nothing for a meal the plan was made with', async () => {
        expect(plan.days[0]!.meals.map((meal) => meal.modelPick)).toEqual(plan.days[0]!.meals.map(() => null));
      });

      it('is the model, with its reason, once its offer is taken with the note that came with it', async () => {
        const preview = await aModelsOffer();
        expect(preview.pick).toEqual(expect.any(String));

        await take(preview, { pick: preview.pick }).expect(201);

        expect((await lunchNow()).modelPick).toEqual({ reason: 'Lighter.' });
      });

      it('is the model without a reason when it gave none', async () => {
        const preview = await aModelsOffer(null);

        await take(preview, { pick: preview.pick }).expect(201);

        expect((await lunchNow()).modelPick).toEqual({ reason: null });
      });

      it('is nothing when the offer is taken without the note: the request does not say that a model chose', async () => {
        const preview = await aModelsOffer();

        await take(preview).expect(201);

        expect((await lunchNow()).modelPick).toBeNull();
      });

      it('comes with no note when the engine picked in the model\'s place', async () => {
        t.model.reply({ text: 'no idea' });

        const preview = (await t.http().post('/api/meal-plans/ai-swap-meal/preview').set(as(user)).send({ planId: plan.id, plannedMealId: lunch.id }).expect(201)).body;

        expect(preview.aiMeta.usedDeterministicFallback).toBe(true);
        expect(preview.pick).toBeNull();
      });

      it('is refused on a note that is for another recipe, another meal, the plan as it was, another account, or is none at all', async () => {
        const preview = await aModelsOffer();
        const [other] = (await otherLunches()).filter((id) => id !== preview.recipe.id);
        const dinner = plan.days[0]!.meals.find((meal) => meal.mealType === 'dinner')!;
        const stranger = await aUser(t);
        const refused = async (send: PromiseLike<{ status: number; body: { error?: string } }>): Promise<void> => {
          const res = await send;
          expect([res.status, res.body.error]).toEqual([400, 'MODEL_PICK_INVALID']);
        };

        // Another recipe than the one the model picked.
        await refused(take(preview, { recipeId: other, pick: preview.pick }));
        // Another meal of the same plan.
        await refused(take(preview, { plannedMealId: dinner.id, pick: preview.pick }));
        // The plan as it was said to stand at another revision.
        await refused(take(preview, { revision: preview.revision + 1, pick: preview.pick }));
        // A note that was changed, and one that never was one.
        await refused(take(preview, { pick: `${preview.pick!.slice(0, -3)}abc` }));
        await refused(take(preview, { pick: 'made-up' }));
        // An access token is signed with the same key, and is no note.
        await refused(take(preview, { pick: user.accessToken }));
        // Somebody else's note, on a plan of their own.
        const theirs = await aPlan(t, stranger, await aProfile(t, stranger), { durationDays: 1 });
        const theirLunch = theirs.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
        await refused(
          t.http().post('/api/meal-plans/swap-meal').set(as(stranger)).send({ planId: theirs.id, plannedMealId: theirLunch.id, strategy: 'random', recipeId: preview.recipe.id, revision: theirs.revision, pick: preview.pick }),
        );

        // Nothing was written by any of them.
        expect((await now()).revision).toBe(plan.revision);
        expect((await lunchNow()).modelPick).toBeNull();
      });

      it('is nothing again once the meal gets another recipe some other way', async () => {
        const preview = await aModelsOffer();
        await take(preview, { pick: preview.pick }).expect(201);
        expect((await lunchNow()).modelPick).not.toBeNull();

        const next: MealSwapPreview = (await offer().expect(201)).body;
        await take(next).expect(201);

        expect((await lunchNow()).modelPick).toBeNull();
      });
    });

    it('is not shown the recipes this sitting has offered already, nor one another meal of the day holds', async () => {
      const dinner = await aLunchForDinner();
      const others = await otherLunches();
      const seen = others.slice(0, 3);
      t.model.reply({ text: 'no idea' });

      await t.http().post('/api/meal-plans/ai-swap-meal/preview').set(as(user)).send({ planId: plan.id, plannedMealId: lunch.id, skip: seen }).expect(201);

      const prompt = t.model.requests.at(-1)!.prompt;
      for (const id of [...seen, dinner]) expect(prompt).not.toContain(`id=${id}`);
      expect(others.length).toBeGreaterThan(3);
      for (const id of others.slice(3)) expect(prompt).toContain(`id=${id}`);
    });
  });
});
