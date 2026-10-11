// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../testing/database.js';
import { PersonalRecipesService } from '../../recipes/personal-recipes.service.js';
import { aRecipeDraft, aUser, anIngredientNameDraft, asAdmin } from '../../testing/factories.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';

describe('shipping approved drafts', () => {
  let t: TestApp;

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
    // What an earlier test shipped into the catalogue.
    await t.prisma.recipe.deleteMany({ where: { origin: { in: ['ai', 'curated'] } } });
    await t.prisma.ingredientTranslation.deleteMany({ where: { source: 'MANUAL' } });
  });

  const ship = (kind: 'recipe' | 'ingredient-name', mode: 'local' | 'bundle') => t.http().post('/api/admin/drafts/ship').set(asAdmin).send({ kind, mode });
  /** A draft approved before the rules for recipe text existed: its title holds markup. */
  const anOldDraft = () => aRecipeDraft(t, { status: 'APPROVED', titles: { en: 'Bowl <img src=x onerror=alert(1)>', pl: 'Owsianka' } });

  describe('into this instance', () => {
    it('ships what passes the rules and holds back what does not, with the reason', async () => {
      const sound = await aRecipeDraft(t, { status: 'APPROVED', titles: { en: ' Oat\n bowl ', pl: 'Owsianka' } });
      const old = await anOldDraft();

      const res = await ship('recipe', 'local').expect(201);

      expect(res.body.shippedDraftIds).toEqual([sound.id]);
      expect(res.body.skipped).toEqual([{ draftId: old.id, slug: old.slug, reason: 'invalid-draft: titles.en: markup' }]);
      expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('APPROVED');
      const shipped = await t.prisma.recipe.findMany({ where: { origin: 'curated' }, include: { translations: true } });
      // The text that ships is the plain line, not what was stored.
      expect(shipped.map((recipe) => recipe.title)).toEqual(['Oat bowl']);
      expect(shipped[0]!.translations.map((row) => [row.locale, row.title]).sort()).toEqual([
        ['en', 'Oat bowl'],
        ['pl', 'Owsianka'],
      ]);
    });

    it('makes the draft a shared recipe that is recognised by what it is made of, and copies it to the instance\'s own files', async () => {
      const draft = await aRecipeDraft(t, { status: 'APPROVED' });

      const res = await ship('recipe', 'local').expect(201);

      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: draft.slug }, include: { ingredients: true } });
      expect(recipe).toMatchObject({ origin: 'curated', createdByUserId: null, caloriesPerServing: draft.caloriesPerServing, allergens: draft.allergens });
      expect(recipe.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(recipe.ingredients).toHaveLength(3);
      expect(await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: 'SHIPPED', promotedRecipeId: recipe.id });
      // The copy has the shape of a batch of the catalogue's data.
      expect(res.body.sidecarPaths).toHaveLength(1);
      expect(res.body.sidecarPaths[0]).toContain(process.env.INSTANCE_DATA_DIR);
      expect(JSON.parse(readFileSync(res.body.sidecarPaths[0], 'utf8'))).toEqual([expect.objectContaining({ slug: draft.slug, title: { en: 'Oat bowl', pl: 'Owsianka' } })]);
    });

    describe('a draft that would take the place of another recipe', () => {
      const milkPorridge = () => t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'milk-porridge' }, include: { ingredients: true } });

      it('is held back when its slug is another recipe\'s, and that recipe stays as it was', async () => {
        const before = await milkPorridge();
        const draft = await aRecipeDraft(t, { status: 'APPROVED', slug: 'milk-porridge' });

        const res = await ship('recipe', 'local').expect(201);

        expect(res.body).toMatchObject({ shippedDraftIds: [], skipped: [{ draftId: draft.id, slug: 'milk-porridge', reason: 'slug-taken: milk-porridge' }] });
        expect(await milkPorridge()).toEqual(before);
        expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('APPROVED');
      });

      it('is held back when its English title is another shared recipe\'s, however it is cased', async () => {
        const draft = await aRecipeDraft(t, { status: 'APPROVED', titles: { en: 'MILK porridge', pl: 'Owsianka na mleku' } });

        const res = await ship('recipe', 'local').expect(201);

        expect(res.body.skipped).toEqual([{ draftId: draft.id, slug: draft.slug, reason: 'title-taken: MILK porridge' }]);
        expect(await t.prisma.recipe.count({ where: { origin: 'curated' } })).toBe(0);
      });

      it('is held back when a shared recipe is already made the same way', async () => {
        const draft = await aRecipeDraft(t, { status: 'APPROVED', titles: { en: 'Morning oats', pl: 'Poranna owsianka' } }, [
          { slug: 'whole-milk', quantity: 250, unit: 'ml', note: null },
          { slug: 'rolled-oats', quantity: 60, unit: 'g', note: 'or more' },
        ]);

        const res = await ship('recipe', 'local').expect(201);

        expect(res.body.skipped).toEqual([{ draftId: draft.id, slug: draft.slug, reason: 'same-making-as: milk-porridge' }]);
      });

      it('lets the first of two drafts of one title in, and holds the second back', async () => {
        const first = await aRecipeDraft(t, { status: 'APPROVED' });
        const second = await aRecipeDraft(t, { status: 'APPROVED' }, [{ slug: 'rolled-oats', quantity: 80, unit: 'g', note: null }]);

        const res = await ship('recipe', 'local').expect(201);

        expect(res.body.shippedDraftIds).toEqual([first.id]);
        expect(res.body.skipped).toEqual([{ draftId: second.id, slug: second.slug, reason: 'title-taken: Oat bowl' }]);
      });
    });

    it('holds a draft back when its figures moved since it was reviewed, and names what moved', async () => {
      const draft = await aRecipeDraft(t, { status: 'APPROVED', caloriesPerServing: 100, allergens: ['dairy'] });

      const res = await ship('recipe', 'local').expect(201);

      expect(res.body.shippedDraftIds).toEqual([]);
      expect(res.body.skipped).toEqual([
        { draftId: draft.id, slug: draft.slug, reason: expect.stringMatching(/^facts-moved-since-review: calories 100 → \d+; allergens \+gluten -dairy$/) },
      ]);
    });

    it('holds a draft back when one of its ingredients has left the catalogue', async () => {
      const draft = await aRecipeDraft(t, { status: 'APPROVED' });
      await t.prisma.ingredient.update({ where: { slug: 'banana' }, data: { retiredAt: new Date() } });

      const res = await ship('recipe', 'local').expect(201);
      await t.prisma.ingredient.update({ where: { slug: 'banana' }, data: { retiredAt: null } });

      expect(res.body.skipped).toEqual([{ draftId: draft.id, slug: draft.slug, reason: 'unknown-slug-at-ship: banana' }]);
    });

    it('waits for an edit that holds the draft, and does not ship what the edit sent back to review', async () => {
      const draft = await aRecipeDraft(t, { status: 'APPROVED' });

      // The ship is started while the row is held, and is still waiting when the holder is done.
      const held = await t.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "RecipeDraft" WHERE "id" = ${draft.id} FOR UPDATE`;
        const shipping = ship('recipe', 'local').then((answer) => answer);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tx.recipeDraft.update({ where: { id: draft.id }, data: { status: 'PENDING' } });
        return { shipping };
      });

      const answer = await held.shipping;
      expect(answer.body).toMatchObject({ shippedDraftIds: [], skipped: [{ draftId: draft.id, reason: 'not-approved: PENDING' }] });
      expect(await t.prisma.recipe.count({ where: { origin: 'curated' } })).toBe(0);
    });

    it('answers that there is nothing to ship only when nothing was approved', async () => {
      const old = await anOldDraft();

      const res = await ship('recipe', 'local').expect(201);
      expect(res.body).toMatchObject({ shippedDraftIds: [], skipped: [{ draftId: old.id }], sidecarPaths: [] });

      await t.prisma.recipeDraft.deleteMany();
      expect((await ship('recipe', 'local')).body.error).toBe('SHIP_NO_APPROVED');
    });

    it('ships the name of an ingredient in the languages the draft was reviewed in, and in no other', async () => {
      // An English name stored on a draft made for Polish: nobody was asked to approve it.
      const draft = await anIngredientNameDraft(t, { status: 'APPROVED', suggestions: { name: { pl: ' Filet  z kurczaka ', en: 'Chicken fillet' }, storageHint: { en: 'Chilled.' } } });
      const marked = await anIngredientNameDraft(t, { status: 'APPROVED', ingredientSlug: 'salmon', suggestions: { name: { pl: '<b>Łosoś</b>' } } });

      const res = await ship('ingredient-name', 'local').expect(201);

      expect(res.body.shippedDraftIds).toEqual([draft.id]);
      expect(res.body.skipped).toEqual([{ draftId: marked.id, slug: 'salmon', reason: 'invalid-draft: name.pl: markup' }]);
      const written = await t.prisma.ingredientTranslation.findMany({ where: { source: 'MANUAL' }, select: { locale: true, name: true, storageHint: true } });
      expect(written).toEqual([{ locale: 'pl', name: 'Filet z kurczaka', storageHint: null }]);
    });
  });

  describe('as a bundle', () => {
    it('is the file itself, in the shape the data directory takes, given to whoever asked with the administrator\'s credentials', async () => {
      const sound = await aRecipeDraft(t, { status: 'APPROVED' });

      const res = await ship('recipe', 'bundle').expect(201);

      expect(res.body).toMatchObject({ mode: 'bundle', kind: 'recipe', draftIds: [sound.id], skipped: [] });
      expect(res.body.fileName).toMatch(/^bundle-[0-9TZ-]+\.json$/);
      // What `data/recipes/<name>` holds: the recipes, and nothing about the queue.
      expect(res.body.content).toEqual([
        expect.objectContaining({ slug: sound.slug, title: { en: 'Oat bowl', pl: 'Owsianka' }, servings: 1, ingredients: expect.any(Array) }),
      ]);
      expect(Object.keys(res.body.content[0]).sort()).toEqual(['cookMinutes', 'description', 'difficulty', 'ingredients', 'mealTypes', 'prepMinutes', 'servings', 'slug', 'steps', 'title']);
      // Making it ships nothing: that is a step of its own.
      expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: sound.id } })).status).toBe('APPROVED');
      // The link with a one-time token is gone: there is nothing to fetch without credentials.
      await t.http().get('/api/admin/drafts/ship/download/anything').set(asAdmin).expect(404);
      expect(res.body).not.toHaveProperty('downloadUrl');
      expect(res.body).not.toHaveProperty('token');
    });

    it('leaves out what does not pass the rules, and says so', async () => {
      const sound = await aRecipeDraft(t, { status: 'APPROVED' });
      const old = await anOldDraft();

      const res = await ship('recipe', 'bundle').expect(201);

      expect(res.body.draftIds).toEqual([sound.id]);
      expect(res.body.content).toHaveLength(1);
      expect(res.body.skipped).toEqual([{ draftId: old.id, slug: old.slug, reason: 'invalid-draft: titles.en: markup' }]);
    });

    it('leaves out a draft that would take the place of a recipe of this instance, and one that repeats another of the bundle', async () => {
      const taking = await aRecipeDraft(t, { status: 'APPROVED', titles: { en: 'Milk Porridge', pl: 'Owsianka na mleku' } });
      const first = await aRecipeDraft(t, { status: 'APPROVED' });
      const repeat = await aRecipeDraft(t, { status: 'APPROVED' }, [{ slug: 'rolled-oats', quantity: 90, unit: 'g', note: null }]);

      const res = await ship('recipe', 'bundle').expect(201);

      expect(res.body.draftIds).toEqual([first.id]);
      expect(res.body.skipped).toEqual([
        { draftId: taking.id, slug: taking.slug, reason: 'title-taken: Milk Porridge' },
        { draftId: repeat.id, slug: repeat.slug, reason: 'title-taken: Oat bowl' },
      ]);
    });

    it('is not made of nothing', async () => {
      await anOldDraft();

      const res = await ship('recipe', 'bundle');

      expect([res.status, res.body.error]).toEqual([409, 'NO_VALID_DRAFTS']);
    });

    it('holds the names of the languages a draft was reviewed in only', async () => {
      await anIngredientNameDraft(t, { status: 'APPROVED', suggestions: { name: { pl: 'Filet z kurczaka', en: 'Chicken fillet' } } });

      const res = await ship('ingredient-name', 'bundle').expect(201);

      // What is merged into `data/ingredient-overrides.json`.
      expect(res.body.fileName).toBe('ingredient-overrides.json');
      expect(res.body.content).toEqual({ 'chicken-breast': { name: { pl: 'Filet z kurczaka' } } });
    });
  });

  describe('a recipe users made, promoted to the shared library', () => {
    const promote = (id: string) => t.http().post(`/api/admin/drafts/recipes/${id}/promote`).set(asAdmin);
    const aUserDraft = (overrides: Parameters<typeof aRecipeDraft>[1] = {}, lines?: Parameters<typeof aRecipeDraft>[2]) =>
      aRecipeDraft(t, { source: 'AI_USER', status: 'APPROVED', ...overrides }, lines);

    it('is refused while its text breaks the rules, and nothing is created', async () => {
      const draft = await aUserDraft({ steps: { en: ['<svg onload=alert(1)>'], pl: ['Ugotuj.'] } });

      const res = await promote(draft.id);

      expect([res.status, res.body.error]).toEqual([400, 'DRAFT_INVALID']);
      expect(res.body.details.problems).toEqual([expect.objectContaining({ path: 'steps.en[0]', rule: 'markup' })]);
      expect(await t.prisma.recipe.count({ where: { origin: 'curated' } })).toBe(0);
      expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('APPROVED');
    });

    it('goes in with its text made plain when it passes', async () => {
      const draft = await aUserDraft({ titles: { en: ' Rice\tbowl ', pl: 'Miska ryżu' } });

      await promote(draft.id).expect(201);

      const curated = await t.prisma.recipe.findFirstOrThrow({ where: { origin: 'curated' }, include: { translations: true } });
      expect(curated.title).toBe('Rice bowl');
      expect(curated.translations.map((row) => row.title).sort()).toEqual(['Miska ryżu', 'Rice bowl']);
      // Approved by people in the queue: not text from the data files, which an update would rewrite.
      expect(curated.translations.map((row) => row.source)).toEqual(['MANUAL', 'MANUAL']);
    });

    it('is made of the lines the draft holds, whether or not a recipe it stands for still exists', async () => {
      const draft = await aUserDraft({ sourceRecipeIds: [] });

      const res = await promote(draft.id).expect(201);

      expect(res.body).toMatchObject({ id: draft.id, status: 'SHIPPED' });
      const curated = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: draft.slug }, include: { ingredients: { include: { ingredient: true } } } });
      expect(curated.ingredients.map((line) => [line.ingredient.slug, line.quantity, line.unit]).sort()).toEqual([
        ['banana', 120, 'g'],
        ['oat-drink', 200, 'ml'],
        ['rolled-oats', 60, 'g'],
      ]);
      expect(curated).toMatchObject({ origin: 'curated', caloriesPerServing: draft.caloriesPerServing });
      expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).promotedRecipeId).toBe(curated.id);
    });

    it('is the recipe a user is given when they make the same thing again', async () => {
      const draft = await aUserDraft();
      await promote(draft.id).expect(201);
      const curated = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: draft.slug }, include: { ingredients: true } });
      const user = await aUser(t);

      const given = await t.app.get(PersonalRecipesService).save({
        userId: user.id,
        origin: 'user',
        text: new Map([['en', { title: 'My oats', description: 'The same thing.', steps: ['Stir.'] }]]),
        servings: curated.servings,
        mealTypes: curated.mealTypes,
        prepMinutes: 5,
        cookMinutes: 5,
        difficulty: 'easy',
        ingredients: curated.ingredients.map((line) => ({ ingredientId: line.ingredientId, quantity: line.quantity, unit: line.unit, note: null })),
        facts: { perServing: { calories: 0, protein: 0, fat: 0, carbs: 0 }, allergens: [], dietTags: [] },
      });

      expect(given).toBe(curated.id);
      expect(await t.prisma.recipe.count({ where: { createdByUserId: user.id } })).toBe(0);
    });

    it('is refused when its figures moved since it was reviewed', async () => {
      const draft = await aUserDraft({ caloriesPerServing: 5 });

      const res = await promote(draft.id);

      expect([res.status, res.body.error]).toEqual([409, 'DRAFT_NOT_SHIPPABLE']);
      expect(res.body.details.reason).toMatch(/^facts-moved-since-review: calories 5 → \d+$/);
      expect(await t.prisma.recipe.count({ where: { origin: 'curated' } })).toBe(0);
    });

    it('is refused when the shared library already has a recipe made the same way', async () => {
      const draft = await aUserDraft({ titles: { en: 'Morning oats', pl: 'Poranna owsianka' } }, [
        { slug: 'rolled-oats', quantity: 60, unit: 'g', note: null },
        { slug: 'whole-milk', quantity: 250, unit: 'ml', note: null },
      ]);

      const res = await promote(draft.id);

      expect([res.status, res.body.error, res.body.details?.reason]).toEqual([409, 'DRAFT_NOT_SHIPPABLE', 'same-making-as: milk-porridge']);
    });

    it('happens once when it is asked for twice at the same moment', async () => {
      const draft = await aUserDraft();

      const answers = await Promise.all([promote(draft.id), promote(draft.id)]);

      expect(answers.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(answers.find((res) => res.status === 409)!.body.error).toBe('DRAFT_NOT_APPROVED');
      expect(await t.prisma.recipe.count({ where: { origin: 'curated' } })).toBe(1);
    });

    it('takes only a draft that came from users, and only an approved one', async () => {
      const generated = await aRecipeDraft(t, { status: 'APPROVED' });
      const waiting = await aUserDraft({ status: 'PENDING' });

      expect((await promote(generated.id)).body.error).toBe('DRAFT_NOT_PROMOTABLE');
      const res = await promote(waiting.id);
      expect([res.status, res.body.error]).toEqual([409, 'DRAFT_NOT_APPROVED']);
    });
  });
});
