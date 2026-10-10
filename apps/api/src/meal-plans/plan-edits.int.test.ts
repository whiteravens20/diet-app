// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  AiSuggestIngredientRequest,
  AiSwapMealRequest,
  SwapMealRequest,
  type Locale,
  type MealPlan,
} from '@diet-app/shared';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import type { ModelRequest } from '../testing/fake-model.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

/** How each request ended: `ok`, or the error code it was refused with. */
function outcomes(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .map((r) => {
      if (r.status === 'fulfilled') return 'ok';
      const response = r.reason instanceof HttpException ? r.reason.getResponse() : undefined;
      return typeof response === 'object' && response !== null && 'error' in response
        ? String(response.error)
        : `unexpected: ${String(r.reason)}`;
    })
    .sort();
}

describe('editing a plan', () => {
  let t: TestApp;
  let plans: MealPlansService;
  let user: TestUser;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    plans = t.app.get(MealPlansService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user));
  });

  afterAll(async () => {
    await t.close();
  });

  const swap = (plannedMealId: string) =>
    plans.swapMeal(user.id, 'en', SwapMealRequest.parse({ planId: plan.id, plannedMealId, strategy: 'random' }));

  it('lets one of two overlapping swaps of a meal through', async () => {
    const meal = plan.days[0]!.meals[0]!;

    const results = await race(2, () => swap(meal.id));

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    const after = await plans.get(user.id, 'en', plan.id);
    expect(after.revision).toBe(1);
    expect(after.days[0]!.meals).toHaveLength(3);
    expect(after.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);
  });

  it('marks a meal eaten once, however often it is asked', async () => {
    const meal = plan.days[0]!.meals[1]!;
    const path = `/api/meal-plans/${plan.id}/meals/${meal.id}/eaten`;

    const first = await t.http().patch(path).set(as(user)).send({ eaten: true }).expect(200);
    const again = await t.http().patch(path).set(as(user)).send({ eaten: true }).expect(200);

    const eatenAt = (body: { plan: MealPlan }) => body.plan.days[0]!.meals.find((m) => m.id === meal.id)!.eatenAt;
    expect(eatenAt(first.body)).not.toBeNull();
    expect(eatenAt(again.body)).toBe(eatenAt(first.body));
    // The repeat changed nothing, so it did not count as a change either.
    expect(again.body.plan.revision).toBe(first.body.plan.revision);

    const undone = await t.http().patch(path).set(as(user)).send({ eaten: false }).expect(200);
    expect(eatenAt(undone.body)).toBeNull();
  });

  it('ends eaten when two requests to mark a meal eaten overlap', async () => {
    const meal = plan.days[1]!.meals[0]!;

    const results = await race(2, () => plans.setEaten(user.id, 'en', plan.id, meal.id, true));

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    expect((await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: meal.id } })).eatenAt).not.toBeNull();
  });

  it('refuses an eaten request that does not say which state is wanted', async () => {
    const meal = plan.days[0]!.meals[0]!;
    await t
      .http()
      .patch(`/api/meal-plans/${plan.id}/meals/${meal.id}/eaten`)
      .set(as(user))
      .send({})
      .expect(400);
  });

  it('keeps the plan whole when a custom meal and a regeneration overlap', async () => {
    const date = plan.days[3]!.date;
    const customMeal = {
      name: 'Birthday cake',
      mealType: 'snack' as const,
      nutrition: { calories: 420, protein: 5, fat: 20, carbs: 55 },
      servings: 1,
    };

    const results = await Promise.allSettled([
      plans.addCustomMeal(user.id, 'en', plan.id, date, customMeal),
      plans.regenerate(user.id, 'en', plan.id),
    ]);

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    const after = await plans.get(user.id, 'en', plan.id);
    expect(after.days).toHaveLength(7);
    const day = after.days[3]!;
    const cakeAdded = results[0].status === 'fulfilled';
    expect(day.meals.filter((m) => m.source === 'USER_CUSTOM')).toHaveLength(cakeAdded ? 1 : 0);
    expect(day.meals.filter((m) => m.source === 'CATALOGUE')).toHaveLength(3);
  });

  it('writes the scales an undo names, under the same revision check', async () => {
    const [first, second] = plan.days[0]!.meals;
    const restore = [
      { mealId: first!.id, scale: 1.25 },
      { mealId: second!.id, scale: 0.75 },
    ];
    const undo = () => plans.rebalance(user.id, 'en', plan.id, { scope: 'day', date: plan.days[0]!.date, restore });

    const results = await race(2, undo);

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    for (const r of restore) {
      const row = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: r.mealId } });
      expect(row.quantityScale).toBe(r.scale);
    }
    expect((await plans.get(user.id, 'en', plan.id)).revision).toBe(1);
  });

  // Repeated: only some interleavings reach the half-deleted plan this guards against.
  it('never answers an edit that overlaps a delete with a server error', { repeats: 25 }, async () => {
    const meal = plan.days[0]!.meals[0]!;

    const results = await Promise.allSettled([swap(meal.id), plans.remove(user.id, plan.id)]);

    for (const outcome of outcomes(results)) {
      expect(['ok', 'PLAN_CHANGED', 'PLAN_NOT_FOUND', 'MEAL_NOT_FOUND']).toContain(outcome);
    }
    expect(await t.prisma.mealPlan.count({ where: { id: plan.id } })).toBe(0);
  });

  describe('substituting an ingredient of a planned meal', () => {
    const ingredientId = async (slug: string) => (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

    /** Put the fixture recipe `slug` into the first lunch of the plan and return that meal's id. */
    async function planned(slug: string): Promise<string> {
      const meal = plan.days[0]!.meals.find((m) => m.mealType === 'lunch')!;
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug } });
      await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: recipe.id } });
      return meal.id;
    }

    async function substitute(plannedMealId: string, from: string, to: string) {
      const result = await plans.applyIngredientSwap(user.id, 'en', {
        planId: plan.id,
        plannedMealId,
        fromIngredientId: await ingredientId(from),
        toIngredientId: await ingredientId(to),
      });
      const meal = result.plan.days[0]!.meals.find((m) => m.id === plannedMealId)!;
      return t.prisma.recipe.findUniqueOrThrow({ where: { id: meal.recipe!.id }, include: { ingredients: true } });
    }

    it('gives the variant the diets of its own ingredients, not those of the recipe it came from', async () => {
      const source = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
      expect(source.dietTags).toEqual(expect.arrayContaining(['vegetarian', 'vegan']));

      const variant = await substitute(await planned('tofu-rice-bowl'), 'firm-tofu', 'chicken-breast');

      expect(variant.id).not.toBe(source.id);
      expect(variant.createdByUserId).toBe(user.id);
      // Chicken in place of tofu: no longer for vegetarians, and the soy is gone.
      expect(variant.dietTags).not.toContain('vegan');
      expect(variant.dietTags).not.toContain('vegetarian');
      expect(variant.allergens).not.toContain('soy');
      expect(source.allergens).toContain('soy');
    });

    it('lets a variant gain a diet its source did not have', async () => {
      const source = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'chicken-rice-broccoli' } });
      expect(source.dietTags).not.toContain('vegan');

      const variant = await substitute(await planned('chicken-rice-broccoli'), 'chicken-breast', 'firm-tofu');

      expect(variant.dietTags).toEqual(expect.arrayContaining(['vegetarian', 'vegan']));
      expect(variant.allergens).toContain('soy');
    });

    it('never offers a variant with meat to a vegan plan of the same account', async () => {
      const variant = await substitute(await planned('tofu-rice-bowl'), 'firm-tofu', 'chicken-breast');
      const veganProfile = await aProfile(t, user, { name: 'Vegan', dietType: 'vegan' });

      const veganPlan = await aPlan(t, user, veganProfile, { durationDays: 14 });

      const plannedIds = veganPlan.days.flatMap((day) => day.meals.map((meal) => meal.recipe!.id));
      expect(plannedIds).not.toContain(variant.id);
    });

    it('stores the nutrition the engine works out for the variant', async () => {
      const variant = await substitute(await planned('tofu-rice-bowl'), 'firm-tofu', 'chicken-breast');
      const lines = await t.prisma.recipeIngredient.findMany({
        where: { recipeId: variant.id },
        include: { ingredient: true },
      });

      // Every fixture ingredient here is weighed in grams or measured in millilitres of its own unit.
      const kcal = lines.reduce((sum, line) => sum + (line.quantity * line.ingredient.caloriesPer100) / 100, 0);
      expect(variant.caloriesPerServing).toBe(Math.round(kcal / variant.servings));
    });
  });

  describe('with a model behind the swap', () => {
    beforeEach(async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    });

    const aiSwap = (plannedMealId: string, locale: Locale = 'en') =>
      plans.aiSwapMeal(user.id, locale, AiSwapMealRequest.parse({ planId: plan.id, plannedMealId }));

    /** The first candidate the prompt offers, as a model that follows the prompt would pick it. */
    const firstOffered = (request: ModelRequest): string => /id=([0-9a-f-]{36})/.exec(request.prompt)![1]!;

    it('returns the rebalance summary together with the swapped plan', async () => {
      const meal = plan.days[0]!.meals[0]!;

      const result = await aiSwap(meal.id);

      expect(t.model.requests).toHaveLength(1);
      expect(result).toHaveProperty('rebalance');
      expect(result.plan.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);
    });

    it.each([
      ['a long run of spaces after the object', '```json\n{"recipeId":"x"}' + ' '.repeat(120_000) + 'x'],
      ['a long run of opening braces', '{'.repeat(120_000)],
      ['five megabytes of text', 'A'.repeat(5_000_000)],
    ])('stays responsive and still swaps when the model answers with %s', async (_name, text) => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({ text });

      const started = performance.now();
      const result = await aiSwap(meal.id);

      // Read with a backtracking pattern, the first two took ten seconds each.
      expect(performance.now() - started).toBeLessThan(3_000);
      // The answer was unusable, so the engine picked: the user still gets a swap.
      expect(result.plan.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);
    });

    it("makes the model's pick and passes on its reason", async () => {
      const meal = plan.days[0]!.meals[0]!;
      let picked = '';
      t.model.reply({
        text: (request) => {
          picked = firstOffered(request);
          return JSON.stringify({ recipeId: picked, reason: 'Closest to the calorie budget of the slot.' });
        },
      });

      const result = await aiSwap(meal.id);

      expect(result.plan.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).toBe(picked);
      expect(result.aiMeta).toMatchObject({
        provider: 'ollama',
        model: 'test-model',
        usedDeterministicFallback: false,
        fallbackReason: null,
        reason: 'Closest to the calorie budget of the slot.',
      });
    });

    it('passes on a reason as one plain line of at most 200 characters, whatever the model wrote', async () => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({
        text: (request) =>
          JSON.stringify({ recipeId: firstOffered(request), reason: `Line one.\n\u0007Line two. ${'very '.repeat(80)}long.` }),
      });

      const { reason } = (await aiSwap(meal.id)).aiMeta;

      expect(reason).toMatch(/^Line one\. Line two\. very /);
      expect(reason!.length).toBeLessThanOrEqual(200);
      expect(reason!.endsWith('…')).toBe(true);
    });

    it('takes a pick that comes without a reason, or with one that is not text', async () => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({ text: (request) => JSON.stringify({ recipeId: firstOffered(request), reason: { why: 'nested' } }) });

      const result = await aiSwap(meal.id);

      expect(result.aiMeta).toMatchObject({ usedDeterministicFallback: false, reason: null });
    });

    it.each([
      ['named a recipe that was not on offer', '{"recipeId":"not-on-the-list","reason":"It sounded nice."}'],
      ['answered in prose', 'I would go with the porridge.'],
      ['answered with the wrong shape', '{"recipe":"oat-porridge"}'],
    ])('says that the engine picked when the model %s', async (_name, text) => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({ text });

      const result = await aiSwap(meal.id);

      // The user still gets a swap, and is not told that the model chose it.
      expect(result.plan.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);
      expect(result.aiMeta).toMatchObject({
        provider: 'ollama',
        usedDeterministicFallback: true,
        fallbackReason: 'invalid_output',
        reason: null,
      });
    });

    it('says that the engine picked, and names no provider, when the provider failed', async () => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({ status: 500, text: 'out of memory' });

      const result = await aiSwap(meal.id);

      expect(result.aiMeta).toMatchObject({
        provider: null,
        usedDeterministicFallback: true,
        fallbackReason: 'all_providers_failed',
        failoverChain: ['ollama'],
        reason: null,
      });
    });

    it('still swaps, and says that a saved key has to be entered again, when that key can no longer be read', async () => {
      const meal = plan.days[0]!.meals[0]!;
      await t
        .http()
        .put('/api/ai/providers')
        .set(as(user))
        .send({ provider: 'openai', apiKey: 'sk-test-key', model: 'gpt-4o-mini' })
        .expect(200);
      await t.http().patch('/api/users/me').set(as(user)).send({ aiMode: 'byok' }).expect(200);
      // As after a change of the instance's encryption secret.
      await t.prisma.aiProviderConfig.updateMany({ data: { encryptedKey: '00:00:00' } });

      const res = await t
        .http()
        .post('/api/meal-plans/ai-swap-meal')
        .set(as(user))
        .send({ planId: plan.id, plannedMealId: meal.id })
        .expect(201);

      expect(res.body.aiMeta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'key_unreadable' });
      const providers = await t.http().get('/api/ai/providers').set(as(user)).expect(200);
      expect(providers.body).toEqual([expect.objectContaining({ provider: 'openai', hasKey: true, keyUnreadable: true })]);
    });

    it("asks for the reason in the user's language", async () => {
      const meal = plan.days[0]!.meals[0]!;

      await aiSwap(meal.id, 'pl');

      expect(t.model.requests[0]!.prompt).toContain('write it in Polish');
      expect(t.model.requests[0]!.prompt).toContain('"reason"');
    });

    describe('suggesting a substitute for an ingredient', () => {
      /** A planned meal and one of its ingredients that the catalogue has substitutes for. */
      async function aLineWithSubstitutes(): Promise<{ plannedMealId: string; fromIngredientId: string }> {
        for (const meal of plan.days.flatMap((day) => day.meals)) {
          for (const line of meal.recipe?.ingredients ?? []) {
            const ingredient = await t.prisma.ingredient.findUniqueOrThrow({ where: { id: line.ingredientId } });
            if (['grains', 'vegetables', 'legumes'].includes(ingredient.category)) {
              return { plannedMealId: meal.id, fromIngredientId: line.ingredientId };
            }
          }
        }
        throw new Error('the fixture plan has no ingredient with a substitute');
      }

      const suggest = async () =>
        plans.aiSuggestIngredient(
          user.id,
          'en',
          AiSuggestIngredientRequest.parse({ planId: plan.id, ...(await aLineWithSubstitutes()) }),
        );

      it("returns the model's pick with its reason", async () => {
        let picked = '';
        t.model.reply({
          text: (request) => {
            picked = firstOffered(request);
            return JSON.stringify({ ingredientId: picked, reason: 'The closest in texture.' });
          },
        });

        const result = await suggest();

        expect(result.toIngredient.id).toBe(picked);
        expect(result.aiMeta).toMatchObject({ usedDeterministicFallback: false, reason: 'The closest in texture.' });
      });

      it('says that the engine picked when the model named an ingredient that was not on offer', async () => {
        t.model.reply({ text: '{"ingredientId":"not-on-the-list"}' });

        const result = await suggest();

        expect(result.toIngredient.id).toBeTruthy();
        expect(result.aiMeta).toMatchObject({
          provider: 'ollama',
          usedDeterministicFallback: true,
          fallbackReason: 'invalid_output',
          reason: null,
        });
      });
    });

    it('does not write a pick the model returned after the plan changed', async () => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({ delayMs: 600, text: '{"recipeId":"too-late"}' });

      const pending = aiSwap(meal.id);
      // The model is still "thinking": change the plan underneath it.
      await new Promise((done) => setTimeout(done, 150));
      const regenerated = await plans.regenerate(user.id, 'en', plan.id);

      await expect(pending).rejects.toMatchObject({ response: { error: 'PLAN_CHANGED' } });
      const after = await plans.get(user.id, 'en', plan.id);
      expect(after.revision).toBe(regenerated.revision);
      expect(after.days.flatMap((d) => d.meals.map((m) => m.id)).sort()).toEqual(
        regenerated.days.flatMap((d) => d.meals.map((m) => m.id)).sort(),
      );
    });
  });
});
