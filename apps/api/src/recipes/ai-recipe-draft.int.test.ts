// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { AiDraftRecipeRequest, type AiDraftRecipeResponse, type Locale, type Profile } from '@diet-app/shared';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recipeDraft } from '../ai/operations.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import type { ModelRequest } from '../testing/fake-model.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AiRecipeDraftService } from './ai-recipe-draft.service.js';

/** The ingredient names a prompt offers, in the order it lists them. */
const offered = (request: ModelRequest): string[] =>
  [...request.prompt.matchAll(/^- (.+?) \([a-z_]+, \d+ kcal\/100g/gm)].map((match) => match[1]!);

/** A draft a careful model would write: three offered ingredients, 100 g of each. */
function draft(request: ModelRequest, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Scripted bowl',
    description: 'A quick bowl from three things in the cupboard.',
    servings: 1,
    mealTypes: ['lunch'],
    dietTags: ['balanced'],
    prepMinutes: 5,
    cookMinutes: 10,
    difficulty: 'easy',
    ingredients: offered(request)
      .slice(0, 3)
      .map((ingredientName) => ({ ingredientName, quantity: 100, unit: 'g', note: null })),
    steps: ['Prepare the ingredients.', 'Cook everything together and serve.'],
    ...overrides,
  };
}

/** Every line of a draft with another quantity. */
const withQuantity = (request: ModelRequest, quantity: number): Record<string, unknown> =>
  draft(request, {
    ingredients: offered(request)
      .slice(0, 3)
      .map((ingredientName) => ({ ingredientName, quantity, unit: 'g', note: null })),
  });

describe('drafting a recipe with a model', () => {
  let t: TestApp;
  let drafts: AiRecipeDraftService;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    drafts = t.app.get(AiRecipeDraftService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    user = await aUser(t);
    profile = await aProfile(t, user);
    await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
  });

  const ask = (overrides: Partial<AiDraftRecipeRequest> = {}, locale: Locale = 'en'): Promise<AiDraftRecipeResponse> =>
    drafts.draftFromPrompt(user.id, locale, AiDraftRecipeRequest.parse({ profileId: profile.id, ...overrides }));

  /** The error code of a refused draft. */
  async function refusal(call: Promise<unknown>): Promise<{ status: number; error: string; message: string }> {
    try {
      await call;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const body = (err as HttpException).getResponse() as { error: string; message: string };
      return { status: (err as HttpException).getStatus(), ...body };
    }
    throw new Error('the draft was expected to be refused');
  }

  const stored = (): Promise<number> => t.prisma.recipe.count({ where: { createdByUserId: user.id } });

  it('stores a private recipe with the nutrition and allergens the engine works out', async () => {
    t.model.reply({ text: (request) => JSON.stringify(draft(request)) });

    const res = await t
      .http()
      .post('/api/recipes/drafts/from-prompt')
      .set(as(user))
      .send({ profileId: profile.id })
      .expect(201);
    const { recipe, aiMeta } = res.body as AiDraftRecipeResponse;

    expect(recipe.title).toBe('Scripted bowl');
    expect(recipe.ingredients).toHaveLength(3);
    expect(recipe.nutritionPerServing.calories).toBeGreaterThan(30);
    expect(aiMeta).toMatchObject({ provider: 'ollama', usedDeterministicFallback: false });
    expect(await stored()).toBe(1);

    // The numbers are the catalogue's, whatever the model might have claimed.
    const rows = await t.prisma.ingredient.findMany({ where: { id: { in: recipe.ingredients.map((i) => i.ingredientId) } } });
    const kcal = rows.reduce((sum, row) => sum + row.caloriesPer100 * (row.canonicalUnit === 'ml' ? 100 / (row.density ?? 1) / 100 : 1), 0);
    expect(recipe.nutritionPerServing.calories).toBeCloseTo(kcal, -1);
    expect([...recipe.allergens].sort()).toEqual([...new Set(rows.flatMap((row) => row.allergens))].sort());
  });

  it('asks for more output when the recipe is written in two languages', async () => {
    t.model.reply({ text: (request) => JSON.stringify(draft(request)) });
    await ask();
    expect(t.model.requests[0]!.maxTokens).toBe(recipeDraft(1).maxTokens);

    t.model.reply({
      text: (request) =>
        JSON.stringify(
          draft(request, {
            title: undefined,
            description: undefined,
            titles: { en: 'Scripted stew', pl: 'Gulasz ze skryptu' },
            descriptions: { en: 'A stew.', pl: 'Gulasz.' },
            steps: { en: ['Chop.', 'Simmer.'], pl: ['Pokrój.', 'Duś.'] },
            ingredients: offered(request)
              .slice(3, 6)
              .map((ingredientName) => ({ ingredientName, quantity: 100, unit: 'g', note: null })),
          }),
        ),
    });
    const polish = await ask({}, 'pl');

    expect(t.model.requests[1]!.maxTokens).toBe(recipeDraft(2).maxTokens);
    expect(polish.recipe.title).toBe('Gulasz ze skryptu');
  });

  describe('when the model was not asked, or did not answer', () => {
    it('says that the monthly allowance is used up', async () => {
      const call = { userId: user.id, provider: 'ollama', model: 'test-model', operation: 'recipe-draft', mode: 'admin' };
      await t.prisma.aiUsageLog.createMany({ data: Array.from({ length: 40 }, () => ({ ...call, outcome: 'COMPLETED' as const })) });

      const res = await t.http().post('/api/recipes/drafts/from-prompt').set(as(user)).send({ profileId: profile.id });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('AI_MONTHLY_LIMIT_REACHED');
      expect(t.model.requests).toHaveLength(0);
    });

    it('says that no provider is set up, for a user who has AI turned off', async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'none' } });

      expect(await refusal(ask())).toMatchObject({ status: 409, error: 'AI_NOT_CONFIGURED' });
    });

    it('says that a saved key has to be entered again when it can no longer be read', async () => {
      await t
        .http()
        .put('/api/ai/providers')
        .set(as(user))
        .send({ provider: 'openai', apiKey: 'sk-test-key', model: 'gpt-4o-mini' })
        .expect(200);
      await t.http().patch('/api/users/me').set(as(user)).send({ aiMode: 'byok' }).expect(200);
      await t.prisma.aiProviderConfig.updateMany({ data: { encryptedKey: '00:00:00' } });

      expect(await refusal(ask())).toMatchObject({ status: 409, error: 'AI_KEY_UNREADABLE' });
    });

    it('says that the provider did not respond', async () => {
      t.model.reply({ status: 500, text: 'out of memory' });

      expect(await refusal(ask())).toMatchObject({ status: 503, error: 'AI_UNAVAILABLE' });
    });
  });

  describe('when the answer is not a usable recipe', () => {
    it.each<[string, (request: ModelRequest) => string]>([
      ['is prose', () => 'Here is a lovely recipe: take some rice…'],
      ['has a quantity that is not finite', (r) => JSON.stringify(withQuantity(r, 100)).replaceAll('"quantity":100', '"quantity":1e400')],
      ['has a quantity no serving holds', (r) => JSON.stringify(withQuantity(r, 5_000))],
      ['has a quantity below zero', (r) => JSON.stringify(withQuantity(r, -5))],
      ['has a title as long as a page', (r) => JSON.stringify(draft(r, { title: 'T'.repeat(5_000) }))],
      ['has a description as long as a chapter', (r) => JSON.stringify(draft(r, { description: 'D'.repeat(5_000) }))],
      ['has a step as long as a page', (r) => JSON.stringify(draft(r, { steps: ['Chop.', 'S'.repeat(1_000)] }))],
      ['has forty steps', (r) => JSON.stringify(draft(r, { steps: Array.from({ length: 40 }, (_, i) => `Step ${i}.`) }))],
      ['has a single step', (r) => JSON.stringify(draft(r, { steps: ['Just eat it.'] }))],
      ['has no ingredients', (r) => JSON.stringify(draft(r, { ingredients: [] }))],
      ['names a unit that does not exist', (r) => JSON.stringify(draft(r)).replaceAll('"unit":"g"', '"unit":"cup"')],
    ])('refuses a draft that %s, and stores nothing', async (_name, text) => {
      t.model.reply({ text });

      expect(await refusal(ask())).toMatchObject({ status: 400, error: 'AI_DRAFT_INVALID' });
      expect(await stored()).toBe(0);
    });

    it('refuses an ingredient that is not in the catalogue, without repeating what the model called it', async () => {
      t.model.reply({
        text: (request) =>
          JSON.stringify(
            draft(request, {
              ingredients: [
                ...offered(request).slice(0, 2).map((ingredientName) => ({ ingredientName, quantity: 100, unit: 'g' })),
                { ingredientName: '<script>alert(1)</script> dragon fruit', quantity: 100, unit: 'g' },
              ],
            }),
          ),
      });

      const refused = await refusal(ask());

      expect(refused).toMatchObject({ status: 400, error: 'AI_DRAFT_UNKNOWN_INGREDIENT' });
      expect(refused.message).not.toContain('dragon');
      expect(refused.message).not.toContain('<');
      expect(await stored()).toBe(0);
    });

    it('refuses a draft far from the calories that were asked for', async () => {
      // Three ingredients at 800 g each: well over a thousand kilocalories.
      t.model.reply({ text: (request) => JSON.stringify(withQuantity(request, 800)) });

      expect(await refusal(ask({ kcalTarget: 300 }))).toMatchObject({ status: 400, error: 'AI_DRAFT_OFF_TARGET' });
      expect(await stored()).toBe(0);
    });

    it('refuses a draft that is no serving of anything', async () => {
      t.model.reply({ text: (request) => JSON.stringify(withQuantity(request, 0.5)) });

      expect(await refusal(ask())).toMatchObject({ status: 400, error: 'AI_DRAFT_OFF_TARGET' });
    });

    it('folds line breaks in the text into spaces and drops a note that is too long', async () => {
      t.model.reply({
        text: (request) =>
          JSON.stringify(
            draft(request, {
              title: 'Two\nline title',
              ingredients: offered(request)
                .slice(0, 3)
                .map((ingredientName) => ({ ingredientName, quantity: 100, unit: 'g', note: 'n'.repeat(500) })),
            }),
          ),
      });

      const { recipe } = await ask();

      expect(recipe.title).toBe('Two line title');
      expect(recipe.ingredients.map((line) => line.note)).toEqual([null, null, null]);
    });
  });
});
