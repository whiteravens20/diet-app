// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../testing/database.js';
import { aPrivateRecipe, aRecipeDraft, aUser, anIngredientNameDraft, asAdmin } from '../../testing/factories.js';
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
      expect(res.body.skipped).toEqual([{ draftId: old.id, reason: 'invalid-draft: titles.en: markup' }]);
      expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('APPROVED');
      const shipped = await t.prisma.recipe.findMany({ where: { origin: 'ai' }, include: { translations: true } });
      // The text that ships is the plain line, not what was stored.
      expect(shipped.map((recipe) => recipe.title)).toEqual(['Oat bowl']);
      expect(shipped[0]!.translations.map((row) => [row.locale, row.title]).sort()).toEqual([
        ['en', 'Oat bowl'],
        ['pl', 'Owsianka'],
      ]);
    });

    it('answers that there is nothing to ship only when nothing was approved', async () => {
      const old = await anOldDraft();

      const res = await ship('recipe', 'local').expect(201);
      expect(res.body).toMatchObject({ shippedDraftIds: [], skipped: [{ draftId: old.id }] });

      await t.prisma.recipeDraft.deleteMany();
      expect((await ship('recipe', 'local')).body.error).toBe('SHIP_NO_APPROVED');
    });

    it('ships the name of an ingredient in the languages the draft was reviewed in, and in no other', async () => {
      // An English name stored on a draft made for Polish: nobody was asked to approve it.
      const draft = await anIngredientNameDraft(t, { status: 'APPROVED', suggestions: { name: { pl: ' Filet  z kurczaka ', en: 'Chicken fillet' }, storageHint: { en: 'Chilled.' } } });
      const marked = await anIngredientNameDraft(t, { status: 'APPROVED', ingredientSlug: 'salmon', suggestions: { name: { pl: '<b>Łosoś</b>' } } });

      const res = await ship('ingredient-name', 'local').expect(201);

      expect(res.body.shippedDraftIds).toEqual([draft.id]);
      expect(res.body.skipped).toEqual([{ draftId: marked.id, reason: 'invalid-draft: name.pl: markup' }]);
      const written = await t.prisma.ingredientTranslation.findMany({ where: { source: 'MANUAL' }, select: { locale: true, name: true, storageHint: true } });
      expect(written).toEqual([{ locale: 'pl', name: 'Filet z kurczaka', storageHint: null }]);
    });
  });

  describe('as a bundle', () => {
    it('leaves out what does not pass the rules, and says so', async () => {
      const sound = await aRecipeDraft(t, { status: 'APPROVED' });
      const old = await anOldDraft();

      const res = await ship('recipe', 'bundle').expect(201);

      expect(res.body.draftIds).toEqual([sound.id]);
      expect(res.body.skipped).toEqual([{ draftId: old.id, reason: 'invalid-draft: titles.en: markup' }]);
    });

    it('is not made of nothing', async () => {
      await anOldDraft();

      const res = await ship('recipe', 'bundle');

      expect([res.status, res.body.error]).toEqual([409, 'NO_VALID_DRAFTS']);
    });

    it('holds the names of the languages a draft was reviewed in only', async () => {
      await anIngredientNameDraft(t, { status: 'APPROVED', suggestions: { name: { pl: 'Filet z kurczaka', en: 'Chicken fillet' } } });

      const res = await ship('ingredient-name', 'bundle').expect(201);
      const bundle = await t.http().get(`/api/admin/drafts/ship/download/${res.body.token}`).set(asAdmin).expect(200);

      expect(JSON.parse(bundle.text).ingredientOverrides).toEqual({ 'chicken-breast': { name: { pl: 'Filet z kurczaka' } } });
    });
  });

  describe('a recipe users made, promoted to the shared library', () => {
    it('is refused while its text breaks the rules, and nothing is created', async () => {
      const recipe = await aPrivateRecipe(t, await aUser(t));
      const draft = await aRecipeDraft(t, {
        source: 'AI_USER',
        status: 'APPROVED',
        sourceRecipeIds: [recipe.id],
        steps: { en: ['<svg onload=alert(1)>'], pl: ['Ugotuj.'] },
      });

      const res = await t.http().post(`/api/admin/drafts/recipes/${draft.id}/promote`).set(asAdmin);

      expect([res.status, res.body.error]).toEqual([400, 'DRAFT_INVALID']);
      expect(res.body.details.problems).toEqual([expect.objectContaining({ path: 'steps.en[0]', rule: 'markup' })]);
      expect(await t.prisma.recipe.count({ where: { origin: 'curated' } })).toBe(0);
      expect((await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('APPROVED');
    });

    it('goes in with its text made plain when it passes', async () => {
      const recipe = await aPrivateRecipe(t, await aUser(t));
      const draft = await aRecipeDraft(t, { source: 'AI_USER', status: 'APPROVED', sourceRecipeIds: [recipe.id], titles: { en: ' Rice\tbowl ', pl: 'Miska ryżu' } });

      await t.http().post(`/api/admin/drafts/recipes/${draft.id}/promote`).set(asAdmin).expect(201);

      const curated = await t.prisma.recipe.findFirstOrThrow({ where: { origin: 'curated' }, include: { translations: true } });
      expect(curated.title).toBe('Rice bowl');
      expect(curated.translations.map((row) => row.title).sort()).toEqual(['Miska ryżu', 'Rice bowl']);
    });
  });
});
