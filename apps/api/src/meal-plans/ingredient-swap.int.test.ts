// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Locale, MealPlan, SwapIngredientResponse } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

interface Text {
  title: string;
  description: string;
  steps: string[];
}

/** What marks the prompt that asks for a rewording. */
const REWORDING = 'You polish cooking-recipe prose';

describe('the text of a recipe after an ingredient swap', () => {
  let t: TestApp;
  let plans: MealPlansService;
  let user: TestUser;
  let plan: MealPlan;
  let mealId: string;

  beforeAll(async () => {
    t = await createTestApp();
    plans = t.app.get(MealPlansService);
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
    await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    plan = await aPlan(t, user, await aProfile(t, user));
    // The tofu rice bowl in the first lunch: "Combine firm tofu, white rice,
    // broccoli, olive oil." and, in Polish, "Połącz: tofu twarde, ryż biały,
    // brokuł, oliwa z oliwek."
    mealId = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!.id;
    const bowl = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
    await t.prisma.plannedMeal.update({ where: { id: mealId }, data: { recipeId: bowl.id } });
  });

  const ingredientId = async (slug: string): Promise<string> => (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

  /** Swap the broccoli of the bowl for tomato and return the answer with the text of what the meal holds now. */
  async function broccoliForTomato(
    options: { locale?: Locale; rewriteWithAi?: boolean } = {},
  ): Promise<{ answer: SwapIngredientResponse; text: Record<string, Text> }> {
    const answer = await plans.applyIngredientSwap(user.id, options.locale ?? 'en', {
      planId: plan.id,
      plannedMealId: mealId,
      fromIngredientId: await ingredientId('broccoli'),
      toIngredientId: await ingredientId('tomato'),
      rewriteWithAi: options.rewriteWithAi ?? false,
    });
    const { recipeId } = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: mealId } });
    const rows = await t.prisma.recipeTranslation.findMany({ where: { recipeId: recipeId! } });
    return {
      answer,
      text: Object.fromEntries(rows.map((row) => [row.locale, { title: row.title, description: row.description, steps: row.steps }])),
    };
  }

  const everyWord = (text: Record<string, Text>): string =>
    Object.values(text)
      .flatMap((slice) => [slice.title, slice.description, ...slice.steps])
      .join(' ')
      .toLowerCase();

  it('names the substitute where the removed ingredient was, in English and in Polish', async () => {
    const { answer, text } = await broccoliForTomato();

    expect(text.en!.steps).toEqual(['Combine firm tofu, white rice, tomato, olive oil.']);
    // "brokuł" ends in a letter outside ASCII, next to a comma.
    expect(text.pl!.steps).toEqual(['Połącz: tofu twarde, ryż biały, pomidor, oliwa z oliwek.']);
    // The title names the substitute as the catalogue writes it.
    expect(text.en!.title).toBe('Tofu rice bowl (with Tomato)');
    expect(text.pl!.title).toBe('Tofu rice bowl (pl) (z Pomidor)');
    expect(everyWord(text)).not.toContain('broccoli');
    expect(everyWord(text)).not.toContain('brokuł');

    // No model was asked: nobody asked for one.
    expect(t.model.requests).toHaveLength(0);
    expect(answer.aiMeta).toBeNull();
  });

  it('answers without AI metadata over HTTP unless a rewording was asked for', async () => {
    const res = await t
      .http()
      .post('/api/meal-plans/swap-ingredient/apply')
      .set(as(user))
      .send({
        planId: plan.id,
        plannedMealId: mealId,
        fromIngredientId: await ingredientId('broccoli'),
        toIngredientId: await ingredientId('tomato'),
      })
      .expect(201);

    expect(res.body.aiMeta).toBeNull();
    expect(res.body.plan.id).toBe(plan.id);
    expect(t.model.requests).toHaveLength(0);
  });

  describe('when a rewording by a model is asked for', () => {
    const polish = {
      description: 'Miska ryżu z tofu, a do niej pomidor, dla jednej osoby.',
      steps: ['Połącz: tofu twarde, ryż biały i pokrojony pomidor, a na koniec oliwa z oliwek.'],
    };

    it('asks once, for the language of the request, and leaves the other language to plain replacement', async () => {
      t.model.reply({ match: REWORDING, text: JSON.stringify(polish), times: 5 });

      const { answer, text } = await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });

      expect(t.model.requests).toHaveLength(1);
      expect(t.model.requests[0]!.prompt).toContain('Polish');
      expect(text.pl).toEqual({ title: 'Tofu rice bowl (pl) (z Pomidor)', ...polish });
      expect(text.en!.steps).toEqual(['Combine firm tofu, white rice, tomato, olive oil.']);
      expect(answer.aiMeta).toMatchObject({ provider: 'ollama', usedDeterministicFallback: false, fallbackReason: null });
      // One call was made and paid for, not one for each language.
      expect(await t.prisma.aiUsageLog.count({ where: { userId: user.id, operation: 'swap-rewrite' } })).toBe(1);
    });

    it('rewords the English text for a request in English', async () => {
      const english = {
        description: 'A rice bowl with tofu and tomato, for one.',
        steps: ['Combine firm tofu and white rice, then fold in the tomato and olive oil.'],
      };
      t.model.reply({ match: REWORDING, text: JSON.stringify(english) });

      const { text } = await broccoliForTomato({ rewriteWithAi: true });

      expect(text.en).toEqual({ title: 'Tofu rice bowl (with Tomato)', ...english });
      expect(text.pl!.steps).toEqual(['Połącz: tofu twarde, ryż biały, pomidor, oliwa z oliwek.']);
    });

    it('keeps the plain replacement, and says why, when the rewording still names the removed ingredient', async () => {
      t.model.reply({
        match: REWORDING,
        text: JSON.stringify({ description: polish.description, steps: ['Połącz: tofu twarde, ryż biały, brokuł i pomidor.'] }),
      });

      const { answer, text } = await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });

      expect(text.pl!.steps).toEqual(['Połącz: tofu twarde, ryż biały, pomidor, oliwa z oliwek.']);
      expect(answer.aiMeta).toMatchObject({ provider: 'ollama', usedDeterministicFallback: true, fallbackReason: 'invalid_output' });
    });

    it.each([
      ['invents a quantity', { description: polish.description, steps: ['Połącz: tofu twarde, ryż biały i 250 g: pomidor.'] }],
      ['adds a step', { description: polish.description, steps: [...polish.steps, 'Podaj.'] }],
      ['is not an object of the shape asked for', ['pomidor']],
    ])('keeps the plain replacement when the rewording %s', async (_name, reply) => {
      t.model.reply({ match: REWORDING, text: JSON.stringify(reply) });

      const { answer, text } = await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });

      expect(text.pl!.steps).toEqual(['Połącz: tofu twarde, ryż biały, pomidor, oliwa z oliwek.']);
      expect(answer.aiMeta?.fallbackReason).toBe('invalid_output');
    });

    it('still swaps, asks no model and says so when the allowance is used up', async () => {
      const call = { userId: user.id, provider: 'ollama', model: 'test-model', operation: 'meal-swap', mode: 'admin' };
      await t.prisma.aiUsageLog.createMany({ data: Array.from({ length: 40 }, () => ({ ...call, outcome: 'COMPLETED' as const })) });

      const { answer, text } = await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });

      expect(t.model.requests).toHaveLength(0);
      expect(answer.aiMeta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'quota_exhausted' });
      expect(text.pl!.steps).toEqual(['Połącz: tofu twarde, ryż biały, pomidor, oliwa z oliwek.']);
    });

    it('still swaps and says that no provider is set up, for a user who has AI turned off', async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'none' } });

      const { answer, text } = await broccoliForTomato({ rewriteWithAi: true });

      expect(answer.aiMeta).toMatchObject({ usedDeterministicFallback: true, fallbackReason: 'no_provider' });
      expect(text.en!.steps).toEqual(['Combine firm tofu, white rice, tomato, olive oil.']);
    });

    it('still swaps when the provider fails', async () => {
      t.model.reply({ match: REWORDING, status: 500, text: 'out of memory' });

      const { answer, text } = await broccoliForTomato({ rewriteWithAi: true });

      expect(answer.aiMeta?.usedDeterministicFallback).toBe(true);
      expect(text.en!.steps).toEqual(['Combine firm tofu, white rice, tomato, olive oil.']);
    });
  });
});
