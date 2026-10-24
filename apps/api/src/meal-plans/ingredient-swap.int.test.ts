// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { SwapIngredientRequest, type Locale, type MealPlan, type SwapIngredientResponse } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PERSONAL_RECIPES } from '../recipes/personal-recipes.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { IngredientSwapService } from './ingredient-swap.service.js';
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
  let user: TestUser;
  let plan: MealPlan;
  let mealId: string;

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
    const answer = await t.app.get(IngredientSwapService).applyIngredientSwap(user.id, options.locale ?? 'en', SwapIngredientRequest.parse({
      planId: plan.id,
      plannedMealId: mealId,
      fromIngredientId: await ingredientId('broccoli'),
      toIngredientId: await ingredientId('tomato'),
      rewriteWithAi: options.rewriteWithAi ?? false,
    }));
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
    expect(text.pl!.title).toBe('Tofu rice bowl (pl) (zamiennik: Pomidor)');
    expect(everyWord(text)).not.toContain('broccoli');
    expect(everyWord(text)).not.toContain('brokuł');

    // No model was asked: nobody asked for one.
    expect(t.model.requests).toHaveLength(0);
    expect(answer.aiMeta).toBeNull();
  });

  /** Who wrote the text of the recipe the meal holds now, language by language. */
  const writers = async (): Promise<Record<string, string>> => {
    const { recipeId } = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: mealId } });
    const rows = await t.prisma.recipeTranslation.findMany({ where: { recipeId: recipeId! }, select: { locale: true, source: true } });
    return Object.fromEntries(rows.map((row) => [row.locale, row.source]));
  };

  it('stores the plain replacement as text no model wrote', async () => {
    await broccoliForTomato();

    expect(await writers()).toEqual({ en: 'MANUAL', pl: 'MANUAL' });
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

  describe('what the meal and its recipe say of a model\'s part in the swap', () => {
    /** The meal as the plan shows it now. */
    const theMeal = async () => (await t.app.get(MealPlansService).get(user.id, 'en', plan.id)).days[0]!.meals.find((meal) => meal.id === mealId)!;
    const swap = async (over: Record<string, unknown> = {}) =>
      t
        .http()
        .post('/api/meal-plans/swap-ingredient/apply')
        .set(as(user))
        .send({ planId: plan.id, plannedMealId: mealId, fromIngredientId: await ingredientId('broccoli'), toIngredientId: await ingredientId('tomato'), acceptChange: true, ...over });
    /** Ask a model what could stand in for the broccoli; it names the tomato, or `names`. */
    const suggestion = async (names?: string) => {
      t.model.reply({ text: names ?? JSON.stringify({ ingredientId: await ingredientId('tomato'), reason: 'In season.' }) });
      return (await t.http().post('/api/meal-plans/swap-ingredient/ai-suggest').set(as(user)).send({ planId: plan.id, plannedMealId: mealId, fromIngredientId: await ingredientId('broccoli') }).expect(201)).body;
    };

    it('is nothing for a recipe of the catalogue, and for a swap the user made by hand', async () => {
      expect((await theMeal()).recipe!.byModel).toBeNull();

      await swap().then((res) => expect(res.status).toBe(201));

      expect((await theMeal()).recipe).toMatchObject({ origin: 'user', byModel: null });
    });

    it('is "changed" when a model reworded the text around the substitute', async () => {
      t.model.reply({ match: REWORDING, text: JSON.stringify({ description: 'A bowl of rice and tofu with tomato.', steps: ['Combine firm tofu, white rice and chopped tomato, then olive oil.'] }) });

      await swap({ rewriteWithAi: true }).then((res) => expect(res.status).toBe(201));

      expect((await theMeal()).recipe!.byModel).toBe('changed');
    });

    it('is nothing when the rewording that was asked for was not usable: the text is the plain replacement', async () => {
      t.model.reply({ match: REWORDING, text: 'I would rather not.', times: 5 });

      await swap({ rewriteWithAi: true }).then((res) => expect(res.status).toBe(201));

      expect((await theMeal()).recipe!.byModel).toBeNull();
    });

    it('is "changed" when the substitute was a model\'s suggestion and is taken with the note that came with it', async () => {
      const suggested = await suggestion();
      expect(suggested).toMatchObject({ toIngredient: { name: 'Tomato' }, aiMeta: { usedDeterministicFallback: false, reason: 'In season.' }, pick: expect.any(String) });

      await swap({ pick: suggested.pick }).then((res) => expect(res.status).toBe(201));

      expect((await theMeal()).recipe!.byModel).toBe('changed');
    });

    it('comes with no note when the engine suggested in the model\'s place', async () => {
      expect(await suggestion('no idea')).toMatchObject({ aiMeta: { usedDeterministicFallback: true }, pick: null });
    });

    it('is nothing when the suggestion is taken without the note: the request does not say that a model chose', async () => {
      await suggestion();

      await swap().then((res) => expect(res.status).toBe(201));

      expect((await theMeal()).recipe!.byModel).toBeNull();
    });

    it('is refused on a note that is for another substitute, or for another ingredient, and writes nothing', async () => {
      const suggested = await suggestion();
      const before = await theMeal();

      const another = await swap({ toIngredientId: await ingredientId('chickpeas'), pick: suggested.pick });
      expect([another.status, another.body.error]).toEqual([400, 'MODEL_PICK_INVALID']);
      const elsewhere = await swap({ fromIngredientId: await ingredientId('white-rice'), pick: suggested.pick });
      expect([elsewhere.status, elsewhere.body.error]).toEqual([400, 'MODEL_PICK_INVALID']);

      expect((await theMeal()).recipe!.id).toBe(before.recipe!.id);
    });

    it('leaves the meal no longer a model\'s pick: the recipe is the user\'s own change from here on', async () => {
      await t.prisma.plannedMeal.update({ where: { id: mealId }, data: { modelPicked: true, modelReason: 'Lighter.' } });
      expect((await theMeal()).modelPick).toEqual({ reason: 'Lighter.' });

      await swap().then((res) => expect(res.status).toBe(201));

      expect((await theMeal()).modelPick).toBeNull();
    });
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
      expect(text.pl).toEqual({ title: 'Tofu rice bowl (pl) (zamiennik: Pomidor)', ...polish });
      expect(text.en!.steps).toEqual(['Combine firm tofu, white rice, tomato, olive oil.']);
      expect(answer.aiMeta).toMatchObject({ provider: 'ollama', usedDeterministicFallback: false, fallbackReason: null });
      // One call was made and paid for, not one for each language.
      expect(await t.prisma.aiUsageLog.count({ where: { userId: user.id, operation: 'swap-rewrite' } })).toBe(1);
    });

    it('stores what the model wrote as a model\'s text, and the other language as not', async () => {
      t.model.reply({ match: REWORDING, text: JSON.stringify(polish), times: 5 });

      await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });

      // What the decision on translations promises: model text can be told apart, and removed, by its source.
      expect(await writers()).toEqual({ en: 'MANUAL', pl: 'AI' });
    });

    it('stores nothing as a model\'s text when the rewording was not usable', async () => {
      t.model.reply({ match: REWORDING, text: 'I would rather not.', times: 5 });

      await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });

      expect(await writers()).toEqual({ en: 'MANUAL', pl: 'MANUAL' });
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

  describe('when the swap gives a recipe that is there already', () => {
    /** Put the bowl back in the meal, as it was before the swap. */
    async function theBowlAgain(): Promise<void> {
      const bowl = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
      await t.prisma.plannedMeal.update({ where: { id: mealId }, data: { recipeId: bowl.id } });
    }

    it('asks no model for a recipe the user has, and the meal holds it with the text it has', async () => {
      const polish = {
        description: 'Miska ryżu z tofu, a do niej pomidor, dla jednej osoby.',
        steps: ['Połącz: tofu twarde, ryż biały i pokrojony pomidor, a na koniec oliwa z oliwek.'],
      };
      t.model.reply({ match: REWORDING, text: JSON.stringify(polish), times: 5 });
      const first = await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });
      await theBowlAgain();

      const again = await broccoliForTomato({ locale: 'pl', rewriteWithAi: true });

      expect(t.model.requests).toHaveLength(1);
      expect(await t.prisma.aiUsageLog.count({ where: { userId: user.id } })).toBe(1);
      expect(again.text).toEqual(first.text);
      expect(again.answer.aiMeta).toBeNull();
    });

    it('asks no model for a recipe of the shared library, and the meal holds that recipe', async () => {
      await broccoliForTomato();
      const { recipeId: variant } = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: mealId } });
      // The same recipe is in the library now: the swap is recognised as it.
      await t.prisma.recipe.update({ where: { id: variant! }, data: { createdByUserId: null } });
      try {
        await theBowlAgain();

        const { answer } = await broccoliForTomato({ rewriteWithAi: true });

        expect(t.model.requests).toHaveLength(0);
        expect(answer.aiMeta).toBeNull();
        expect((await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: mealId } })).recipeId).toBe(variant);
      } finally {
        // The user's again, so that it goes with the user's data and no later test finds it in the library.
        await t.prisma.recipe.update({ where: { id: variant! }, data: { createdByUserId: user.id } });
      }
    });

    it('asks no model when the account has no room for another recipe, and refuses the swap', async () => {
      await t.prisma.recipe.createMany({
        data: Array.from({ length: MAX_PERSONAL_RECIPES }, (_, index) => ({
          title: `Filler ${index}`,
          description: '',
          servings: 1,
          prepMinutes: 1,
          cookMinutes: 1,
          origin: 'user' as const,
          createdByUserId: user.id,
        })),
      });

      await expect(broccoliForTomato({ rewriteWithAi: true })).rejects.toMatchObject({ status: 403, response: { error: 'PERSONAL_RECIPE_LIMIT' } });

      expect(t.model.requests).toHaveLength(0);
      expect(await t.prisma.aiUsageLog.count({ where: { userId: user.id } })).toBe(0);
    });
  });
});
