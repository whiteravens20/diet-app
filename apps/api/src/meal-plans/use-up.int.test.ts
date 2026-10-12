// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile, UseUpSuggestions } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealSwapService } from './meal-swap.service.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { UseUpService } from './use-up.service.js';

/** The fixture recipes the menu below is made of. Chicken comes in packs of 500 g and milk by the litre; neither keeps. */
const PORRIDGE = 'milk-porridge'; // 250 ml of milk
const CHICKEN_RICE = 'chicken-rice-broccoli'; // 150 g of chicken, 600 kcal
const TOFU_BOWL = 'tofu-rice-bowl'; // 622 kcal
const STEW = 'chickpea-tomato-stew'; // 671 kcal
const BAKED_TOFU = 'baked-tofu-with-broccoli'; // 483 kcal

describe('the swaps that would use up what a plan opens', () => {
  let t: TestApp;
  let useUp: UseUpService;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    useUp = t.app.get(UseUpService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Give a day of the plan exactly these recipes, one serving each: breakfast, lunch, dinner. */
  async function menu(day: number, slugs: [string, string, string]): Promise<void> {
    for (const [index, mealType] of (['breakfast', 'lunch', 'dinner'] as const).entries()) {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: slugs[index]! } });
      const meal = plan.days[day]!.meals.find((planned) => planned.mealType === mealType)!;
      await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: recipe.id, servings: 1, quantityScale: 1, source: 'CATALOGUE', eatenAt: null } });
    }
  }
  const mealOf = (day: number, mealType: string) => plan.days[day]!.meals.find((meal) => meal.mealType === mealType)!;
  /** The suggestions as somebody is given them for whom it is the plan's first day. */
  const suggestions = (weigh = false, locale: 'en' | 'pl' = 'en'): Promise<UseUpSuggestions> => useUp.suggest(user.id, locale, plan.id, { weigh }, plan.startDate);

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    user = await aUser(t);
    profile = await aProfile(t, user);
    // One pack of chicken is opened for 150 g of it on the first day; the second day has none.
    plan = await aPlan(t, user, profile, { durationDays: 2 });
    await menu(0, [PORRIDGE, CHICKEN_RICE, TOFU_BOWL]);
    await menu(1, [PORRIDGE, STEW, BAKED_TOFU]);
  });

  describe('as the engine finds them', () => {
    it('name, for a meal, the recipe that takes from the pack and what is then left of it, the one that leaves the least first', async () => {
      const { suggestions: found, revision, aiMeta } = await suggestions();

      expect(revision).toBe(plan.revision);
      expect(aiMeta).toBeNull();
      expect(found.map((suggestion) => [suggestion.date, suggestion.mealType, suggestion.from.title, suggestion.to.title, suggestion.servings])).toEqual([
        [plan.days[1]!.date, 'lunch', 'Chickpea tomato stew', 'Chicken rice broccoli', 1],
        // A dinner of 483 kcal takes three quarters of a serving of it.
        [plan.days[1]!.date, 'dinner', 'Baked tofu with broccoli', 'Chicken rice broccoli', 0.75],
      ]);
      const [lunch, dinner] = found;
      expect(lunch).toMatchObject({ plannedMealId: mealOf(1, 'lunch').id, reason: null, pick: null });
      expect(lunch!.takes).toEqual([{ ingredientId: expect.any(String), name: 'Chicken breast', unit: 'g', amount: 150, left: 200 }]);
      expect(dinner!.takes).toEqual([{ ingredientId: expect.any(String), name: 'Chicken breast', unit: 'g', amount: 113, left: 238 }]);
      // A litre of milk and a pack of chicken are bought either way; more of the chicken is used.
      expect(lunch!.packs).toEqual({ before: { bought: 1500, used: 650, wasted: 2 }, after: { bought: 1500, used: 800, wasted: 2 } });
    });

    it('say what the meal holds now and what it would hold', async () => {
      const [lunch] = (await suggestions()).suggestions;

      // A serving of the stew, and a serving of the chicken dish.
      expect(lunch!.before.calories).toBe(671);
      expect(lunch!.after.calories).toBeGreaterThan(590);
      expect(lunch!.after.calories).toBeLessThan(610);
      expect(lunch!.after.protein).toBeGreaterThan(lunch!.before.protein);
    });

    it('offer for a meal no recipe that another meal of its day holds', async () => {
      // The dinner of the first day could be the chicken dish too, were it not that day's lunch.
      const found = (await suggestions()).suggestions;

      expect(found.map((suggestion) => suggestion.plannedMealId)).not.toContain(mealOf(0, 'dinner').id);
    });

    it('leave alone what was eaten and what lies before the day it is', async () => {
      await t.prisma.plannedMeal.update({ where: { id: mealOf(1, 'lunch').id }, data: { eatenAt: new Date() } });

      expect((await suggestions()).suggestions.map((suggestion) => suggestion.mealType)).toEqual(['dinner']);
      // On the day after the plan, nothing of it is left to change.
      expect((await useUp.suggest(user.id, 'en', plan.id, { weigh: false }, '2026-02-01')).suggestions).toEqual([]);
    });

    it('are none for a menu that opens no pack that does not keep', async () => {
      // Oats, an oat drink and a banana; chickpeas; tofu and rice: nothing of it comes in such a pack.
      await menu(0, ['oat-porridge-with-banana', STEW, TOFU_BOWL]);
      await menu(1, ['oat-porridge-with-banana', STEW, BAKED_TOFU]);

      expect((await suggestions()).suggestions).toEqual([]);
    });

    it('offer nothing that would open another pack and leave as much of that', async () => {
      // The chicken sandwich would take from the chicken, and open a loaf for three slices of it.
      const found = (await suggestions()).suggestions;

      expect(found.map((suggestion) => suggestion.to.title)).not.toContain('Chicken sandwich');
    });

    it('name recipes and ingredients in the language asked for', async () => {
      const [lunch] = (await suggestions(false, 'pl')).suggestions;

      expect(lunch!.to.title).toBe('Chicken rice broccoli (pl)');
      expect(lunch!.takes[0]!.name).toBe('Pierś z kurczaka');
    });

    it('are taken as any swap is: the meal gets the recipe, and no model is said to have chosen it', async () => {
      const { suggestions: found, revision } = await suggestions();
      const lunch = found[0]!;

      const { plan: after } = await t.app.get(MealSwapService).apply(user.id, 'en', { planId: plan.id, plannedMealId: lunch.plannedMealId, recipeId: lunch.to.id, revision, strategy: 'random', allowOffDiet: false });

      const meal = after.days[1]!.meals.find((planned) => planned.id === lunch.plannedMealId)!;
      expect(meal.recipe!.id).toBe(lunch.to.id);
      expect(meal.modelPick).toBeNull();
      expect(after.generationMode).toBe('deterministic');
    });

    it('are answered by the route, to the owner of the plan alone', async () => {
      // The route goes by the day it is: the days of this plan have passed, and nothing of them is left to change.
      const answer = await t.http().post(`/api/meal-plans/${plan.id}/use-up`).set(as(user)).send({}).expect(200);
      expect(answer.body).toEqual({ revision: plan.revision, suggestions: [], aiMeta: null });

      const other = await aUser(t);
      await t.http().post(`/api/meal-plans/${plan.id}/use-up`).set(as(other)).send({}).expect(404);
      await t.http().post(`/api/meal-plans/${plan.id}/use-up`).set(as(user)).send({ weigh: 'yes' }).expect(400);
    });
  });

  describe('as a model weighs them', () => {
    beforeEach(async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    });

    it('are put before the model under letters, with what the engine counted and nothing else', async () => {
      t.model.reply({ text: JSON.stringify({ order: ['a', 'b'] }) });

      await suggestions(true);

      expect(t.model.requests).toHaveLength(1);
      const { prompt, maxTokens } = t.model.requests[0]!;
      expect(prompt).toContain('- id=a | ');
      expect(prompt).toContain('"Chicken rice broccoli" in place of "Chickpea tomato stew"');
      expect(prompt).toContain('takes 150 g more of Chicken breast, leaving 200 g of its pack');
      expect(prompt).toContain('- id=b | ');
      expect(prompt).not.toContain(plan.id);
      expect(maxTokens).toBe(700);
    });

    it('come back in the model\'s order with its sentence on each, and what it put first is its pick', async () => {
      t.model.reply({ text: JSON.stringify({ order: ['b', 'a'], reasons: { b: 'Keeps the stew for lunch.', a: 'Uses more of the chicken.' } }) });

      const { suggestions: found, aiMeta } = await suggestions(true);

      expect(found.map((suggestion) => [suggestion.mealType, suggestion.reason])).toEqual([
        ['dinner', 'Keeps the stew for lunch.'],
        ['lunch', 'Uses more of the chicken.'],
      ]);
      expect(aiMeta).toMatchObject({ provider: 'ollama', usedDeterministicFallback: false, fallbackReason: null });
      expect(found[0]!.pick).toEqual(expect.any(String));
      expect(found[1]!.pick).toBeNull();
    });

    it('are written as the model\'s pick when the one it put first is taken with its note, and the plan says a model had a part in it', async () => {
      t.model.reply({ text: JSON.stringify({ order: ['b', 'a'], reasons: { b: 'Keeps the stew for lunch.' } }) });
      const { suggestions: found, revision } = await suggestions(true);
      const first = found[0]!;

      const { plan: after } = await t.app.get(MealSwapService).apply(user.id, 'en', { planId: plan.id, plannedMealId: first.plannedMealId, recipeId: first.to.id, revision, strategy: 'random', allowOffDiet: false, pick: first.pick! });

      expect(after.days[1]!.meals.find((planned) => planned.id === first.plannedMealId)!.modelPick).toEqual({ reason: 'Keeps the stew for lunch.' });
      expect(after.generationMode).toBe('ai_assisted');
      // A plan that is made again as a whole is the engine's again.
      const again = await t.app.get(PlanGenerationService).regenerate(user.id, 'en', plan.id, { includePast: true, replaceEaten: false, replaceCustom: false, dropIneligibleLocks: false }, plan.startDate);
      expect(again.generationMode).toBe('deterministic');
    });

    it('stay in the engine\'s order, without a pick, when the model\'s answer cannot be used', async () => {
      t.model.reply({ text: 'The second one, I think.' });

      const { suggestions: found, aiMeta } = await suggestions(true);

      expect(found.map((suggestion) => suggestion.mealType)).toEqual(['lunch', 'dinner']);
      expect(found.every((suggestion) => suggestion.pick === null && suggestion.reason === null)).toBe(true);
      expect(aiMeta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'invalid_output' });
    });

    it('ask no model where there is nothing to weigh', async () => {
      await t.prisma.plannedMeal.updateMany({ where: { day: { planId: plan.id } }, data: { eatenAt: new Date() } });

      expect(await suggestions(true)).toMatchObject({ suggestions: [], aiMeta: null });
      expect(t.model.requests).toHaveLength(0);
    });

    it('count against the account\'s allowance like any request to a model', async () => {
      t.model.reply({ text: JSON.stringify({ order: ['a', 'b'] }) });

      await suggestions(true);

      const calls = await t.prisma.aiUsageLog.findMany({ where: { userId: user.id } });
      expect(calls.map((call) => call.operation)).toEqual(['use-up-swaps']);
    });
  });

  it('are in the engine\'s order, and say that no model answered, for an account that has AI off', async () => {
    const { suggestions: found, aiMeta } = await suggestions(true);

    expect(found).toHaveLength(2);
    expect(aiMeta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'no_provider' });
    expect(t.model.requests).toHaveLength(0);
  });
});
