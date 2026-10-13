// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recipeTranslation } from '../../ai/operations.js';
import { seedCatalogue } from '../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../testing/database.js';
import type { ModelRequest } from '../../testing/fake-model.js';
import { aRecipeDraft, asAdmin } from '../../testing/factories.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';
import { TRANSLATION_PROMPT_VERSION } from './translation.prompt.js';
import { TranslationRunner, type TranslationRunnerState } from './translation.runner.js';

const ENGLISH = { title: 'Oat bowl', description: 'Oats with a banana.', steps: ['Warm the drink.', 'Stir in the oats and the banana.'] };
const POLISH = { title: 'Owsianka', description: 'Płatki z bananem.', steps: ['Podgrzej napój.', 'Wmieszaj płatki i banana.'] };
/** A draft in English alone, as an import or a run for English leaves one. */
const inEnglish = { locales: ['en'], titles: { en: ENGLISH.title }, descriptions: { en: ENGLISH.description }, steps: { en: ENGLISH.steps } };

/** What a prompt asks to be translated: the recipe's text in English. */
const asked = (request: ModelRequest): typeof ENGLISH => {
  const mark = 'Translate this recipe:\n';
  return JSON.parse(request.prompt.slice(request.prompt.lastIndexOf(mark) + mark.length).split('\n')[0]!) as typeof ENGLISH;
};
/** A model that translates the one recipe the tests know, and answers in the shape it was asked for. */
const translator = (request: ModelRequest): string => {
  const recipe = asked(request);
  return JSON.stringify({ title: recipe.title === ENGLISH.title ? POLISH.title : `${POLISH.title} inaczej`, description: POLISH.description, steps: recipe.steps.map((_, index) => POLISH.steps[index % 2]) });
};

describe('the run that fills a language recipes lack', () => {
  let t: TestApp;
  let runner: TranslationRunner;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    runner = t.app.get(TranslationRunner);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.model.reset();
    await resetUserData(t.prisma);
    // What an earlier test shipped into the library.
    await t.prisma.recipe.deleteMany({ where: { origin: { in: ['ai', 'curated'] } } });
  });

  async function finished(): Promise<TranslationRunnerState> {
    for (let waited = 0; waited < 200; waited += 1) {
      const state = await runner.getState();
      if (state.status !== 'running') return state;
      await new Promise((tick) => setTimeout(tick, 25));
    }
    throw new Error('the run did not finish');
  }
  /** Where a run stands, asked over HTTP until it has counted what it takes on: a run is announced before it has. */
  async function counted(): Promise<TranslationRunnerState> {
    for (let asked = 0; asked < 100; asked += 1) {
      const state = (await t.http().get('/api/admin/drafts/translations/generate/status').set(asAdmin).expect(200)).body as TranslationRunnerState;
      if (state.total > 0 || state.status !== 'running') return state;
      await new Promise((tick) => setTimeout(tick, 10));
    }
    throw new Error('the run did not count what it takes on');
  }
  /** Over HTTP, which lets five runs a minute be asked for: the tests about the route itself go this way. */
  const start = (body: Record<string, unknown> = {}) => t.http().post('/api/admin/drafts/translations/generate').set(asAdmin).send({ locale: 'pl', ...body });
  const run = async (limit = 25): Promise<TranslationRunnerState> => {
    expect(await runner.start({ locale: 'pl', limit })).toBe(true);
    return finished();
  };
  const approve = (id: string, locale: 'en' | 'pl') =>
    t.http().post(`/api/admin/drafts/recipes/${id}/approve?locale=${locale}`).set(asAdmin).send({ reviewedByLabel: 'the administrator' }).expect(201);
  const ship = (mode: 'local' | 'bundle') => t.http().post('/api/admin/drafts/ship').set(asAdmin).send({ kind: 'recipe', mode });
  const draftOf = (id: string) => t.prisma.recipeDraft.findUniqueOrThrow({ where: { id }, include: { localeReviews: true } });

  /** A recipe of the instance's own library in English alone: a draft approved in English, shipped into the instance. */
  async function anOwnRecipe() {
    const draft = await aRecipeDraft(t, { ...inEnglish, status: 'APPROVED' });
    await ship('local').expect(201);
    return t.prisma.recipe.findUniqueOrThrow({ where: { slug: draft.slug }, include: { translations: true, ingredients: true } });
  }

  describe('for a draft that waits', () => {
    it('writes the text in the language into the draft, from its English alone, and the draft waits to be reviewed in it', async () => {
      const draft = await aRecipeDraft(t, inEnglish);
      await approve(draft.id, 'en');
      t.model.reply({ text: translator });

      const state = await run();

      expect(state).toMatchObject({ status: 'done', error: null, total: 1, processed: 1, written: 1, failed: 0, skipped: 0, note: null });
      expect(state.batchId).toMatch(/^tr-/);
      const after = await draftOf(draft.id);
      expect(after.locales).toEqual(['en', 'pl']);
      expect(after.titles).toEqual({ en: ENGLISH.title, pl: POLISH.title });
      expect(after.descriptions).toEqual({ en: ENGLISH.description, pl: POLISH.description });
      expect(after.steps).toEqual({ en: ENGLISH.steps, pl: POLISH.steps });
      // English was approved and none of it changed: the review stands, and the draft waits for the other language.
      expect(after.status).toBe('PENDING');
      expect(after.localeReviews.filter((review) => review.supersededAt === null).map((review) => [review.locale, review.action])).toEqual([['en', 'APPROVE']]);
    });

    it('sends the model the text and nothing a translation could change: no ingredient, no amount, no figure', async () => {
      await aRecipeDraft(t, inEnglish);
      t.model.reply({ text: translator });

      await run();

      const [request] = t.model.requests;
      expect(asked(request!)).toEqual(ENGLISH);
      expect(request!.prompt).not.toMatch(/rolled-oats|oat-drink|"quantity"|kcal\b.*\d/);
      expect(request!.maxTokens).toBe(recipeTranslation(ENGLISH.steps.length, 0.2).maxTokens);
      expect(request!.format).toBe('json');
    });

    it('asks once more when the answer is no use, and leaves the draft as it was when the second is none either', async () => {
      const draft = await aRecipeDraft(t, inEnglish);
      t.model.reply({ text: 'I am sorry, I cannot translate recipes.' });
      t.model.reply({ text: JSON.stringify({ ...POLISH, steps: [POLISH.steps[0]] }) });

      const state = await run();

      expect(state).toMatchObject({ status: 'done', total: 1, processed: 1, written: 0, failed: 1 });
      expect(t.model.requests).toHaveLength(2);
      expect(t.model.requests[0]!.prompt).not.toContain('Reminder');
      expect(t.model.requests[1]!.prompt).toContain('Reminder');
      expect((await draftOf(draft.id)).locales).toEqual(['en']);
    });

    it('takes the second answer when only the first was no use', async () => {
      const draft = await aRecipeDraft(t, inEnglish);
      t.model.reply({ text: JSON.stringify({ ...POLISH, steps: ['Podgrzej napój przez 5 minut.', POLISH.steps[1]] }) });
      t.model.reply({ text: translator });

      const state = await run();

      expect(state).toMatchObject({ written: 1, failed: 0 });
      expect((await draftOf(draft.id)).steps).toMatchObject({ pl: POLISH.steps });
    });

    it('does not take an answer that was cut off', async () => {
      const draft = await aRecipeDraft(t, inEnglish);
      t.model.reply({ text: JSON.stringify(POLISH), truncated: true, times: 2 });

      expect(await run()).toMatchObject({ written: 0, failed: 1 });
      expect((await draftOf(draft.id)).locales).toEqual(['en']);
    });

    it('takes on no more than it was asked to, the oldest first', async () => {
      const first = await aRecipeDraft(t, { ...inEnglish, createdAt: new Date('2026-01-01') });
      const second = await aRecipeDraft(t, { ...inEnglish, createdAt: new Date('2026-01-02') });
      const third = await aRecipeDraft(t, { ...inEnglish, createdAt: new Date('2026-01-03') });
      t.model.reply({ text: translator, times: 5 });

      const state = await run(2);

      expect(state).toMatchObject({ total: 2, written: 2 });
      expect((await Promise.all([first, second, third].map((draft) => draftOf(draft.id)))).map((draft) => draft.locales.includes('pl'))).toEqual([true, true, false]);
    });

    it('leaves alone what has the language, what was rejected and what has shipped, and says so when nothing lacks the language', async () => {
      await aRecipeDraft(t);
      await aRecipeDraft(t, { ...inEnglish, status: 'REJECTED' });
      await aRecipeDraft(t, { ...inEnglish, status: 'SHIPPED' });

      const state = await run();

      expect(state).toMatchObject({ status: 'done', total: 0, written: 0, failed: 0, note: 'nothing-to-translate' });
      expect(t.model.requests).toHaveLength(0);
    });
  });

  describe('for a recipe of the instance\'s own library', () => {
    it('makes a draft of the recipe as it is, with the new text beside its English, and writes nothing to the recipe', async () => {
      const recipe = await anOwnRecipe();
      t.model.reply({ text: translator });

      const state = await run();

      expect(state).toMatchObject({ status: 'done', total: 1, written: 1, failed: 0 });
      const drafts = await t.prisma.recipeDraft.findMany({ where: { slug: recipe.slug!, status: 'PENDING' } });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        locales: ['en', 'pl'],
        titles: { en: ENGLISH.title, pl: POLISH.title },
        steps: { en: ENGLISH.steps, pl: POLISH.steps },
        source: 'AI',
        generatorPrompt: TRANSLATION_PROMPT_VERSION,
        batchId: state.batchId,
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        caloriesPerServing: recipe.caloriesPerServing,
        allergens: recipe.allergens,
      });
      expect(drafts[0]!.ingredientsJson).toEqual([
        { slug: 'rolled-oats', quantity: 60, unit: 'g', note: null },
        { slug: 'oat-drink', quantity: 200, unit: 'ml', note: null },
        { slug: 'banana', quantity: 120, unit: 'g', note: null },
      ]);
      const after = await t.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id }, include: { translations: true } });
      expect(after.translations.map((row) => row.locale)).toEqual(['en']);
      expect(after.updatedAt).toEqual(recipe.updatedAt);
    });

    it('makes no second draft while one waits', async () => {
      await anOwnRecipe();
      t.model.reply({ text: translator, times: 2 });
      await run();

      const again = await run();

      expect(again).toMatchObject({ total: 0, note: 'nothing-to-translate' });
      expect(t.model.requests).toHaveLength(1);
    });

    it('gives the recipe its new language when the draft ships into the instance, and changes nothing else of it', async () => {
      const recipe = await anOwnRecipe();
      t.model.reply({ text: translator });
      await run();
      const draft = await t.prisma.recipeDraft.findFirstOrThrow({ where: { slug: recipe.slug!, status: 'PENDING' } });
      await approve(draft.id, 'en');
      await approve(draft.id, 'pl');

      const res = await ship('local').expect(201);

      expect(res.body).toMatchObject({ shippedDraftIds: [draft.id], skipped: [] });
      const after = await t.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id }, include: { translations: true, ingredients: true } });
      const polish = after.translations.find((row) => row.locale === 'pl')!;
      expect(polish).toMatchObject({ title: POLISH.title, description: POLISH.description, steps: POLISH.steps, source: 'MANUAL' });
      // The recipe itself was not written: its row and its lines are the ones it had.
      expect(after.updatedAt).toEqual(recipe.updatedAt);
      expect(after.ingredients.map((line) => line.id).sort()).toEqual(recipe.ingredients.map((line) => line.id).sort());
      expect(after.translations.find((row) => row.locale === 'en')!.updatedAt).toEqual(recipe.translations[0]!.updatedAt);
      expect(await t.prisma.recipe.count({ where: { origin: 'curated' } })).toBe(1);
      expect(await draftOf(draft.id)).toMatchObject({ status: 'SHIPPED', promotedRecipeId: recipe.id });
      // And nothing lacks the language any more.
      expect(await run()).toMatchObject({ total: 0, note: 'nothing-to-translate' });
    });

    it('does not ship the draft once the recipe has changed since, and says which recipe', async () => {
      const recipe = await anOwnRecipe();
      t.model.reply({ text: translator });
      await run();
      const draft = await t.prisma.recipeDraft.findFirstOrThrow({ where: { slug: recipe.slug!, status: 'PENDING' } });
      await approve(draft.id, 'en');
      await approve(draft.id, 'pl');
      await t.prisma.recipe.update({ where: { id: recipe.id }, data: { title: 'Oat bowl with honey' } });

      const res = await ship('local').expect(201);

      expect(res.body).toMatchObject({ shippedDraftIds: [], skipped: [{ draftId: draft.id, slug: recipe.slug, reason: `library-recipe-changed: ${recipe.slug}` }] });
      expect(await t.prisma.recipeTranslation.count({ where: { recipeId: recipe.id, locale: 'pl' } })).toBe(0);
    });

    it('stays out of a file for a repository, which holds whole recipes', async () => {
      const recipe = await anOwnRecipe();
      t.model.reply({ text: translator });
      await run();
      const draft = await t.prisma.recipeDraft.findFirstOrThrow({ where: { slug: recipe.slug!, status: 'PENDING' } });
      await approve(draft.id, 'en');
      await approve(draft.id, 'pl');

      const res = await ship('bundle').expect(409);

      expect(res.body).toMatchObject({ error: 'NO_VALID_DRAFTS', details: { skipped: [{ draftId: draft.id, reason: `adds-a-language: ${recipe.slug}` }] } });
    });

    it('leaves the recipes of the catalogue\'s data alone: their text is written by hand', async () => {
      const curated = await t.prisma.recipe.findFirstOrThrow({ where: { origin: 'seed' } });
      await t.prisma.recipeTranslation.deleteMany({ where: { recipeId: curated.id, locale: 'pl' } });
      try {
        expect(await run()).toMatchObject({ total: 0, note: 'nothing-to-translate' });
        expect(await t.prisma.recipeDraft.count()).toBe(0);
      } finally {
        await resetDatabase(t.prisma);
        await seedCatalogue(t.prisma);
      }
    });
  });

  describe('as a run', () => {
    it('is one at a time, can be asked where it stands, and stops when told to', async () => {
      for (let n = 0; n < 4; n += 1) await aRecipeDraft(t, inEnglish);
      t.model.reply({ text: translator, delayMs: 150, times: 10 });

      await start().expect(202);
      const second = await start().expect(409);
      expect(second.body).toMatchObject({ error: 'TRANSLATIONS_IN_PROGRESS' });
      expect(await counted()).toMatchObject({ status: 'running', total: 4, configured: true });

      await t.http().post('/api/admin/drafts/translations/generate/stop').set(asAdmin).expect(202);
      const state = await finished();

      expect(state).toMatchObject({ status: 'done', error: 'cancelled' });
      expect(state.written).toBeLessThan(4);
    });

    it('takes no English and no more than two hundred at once, and is the administrator\'s alone', async () => {
      await start({ locale: 'en' }).expect(400);
      await start({ limit: 201 }).expect(400);
      await t.http().get('/api/admin/drafts/translations/generate/status').expect(401);
      await t.http().post('/api/admin/drafts/translations/generate/stop').expect(401);
    });
  });
});
