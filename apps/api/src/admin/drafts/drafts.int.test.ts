// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RECIPE_LIMITS } from '@diet-app/shared';
import { seedCatalogue } from '../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../testing/database.js';
import { aRecipeDraft, aReviewer, anIngredientNameDraft, asAdmin, race } from '../../testing/factories.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';

describe('the curation queue', () => {
  let t: TestApp;
  let reviewer: { Cookie: string };

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
    reviewer = await aReviewer(t, 'Anna');
  });

  // --- what the two kinds of people send
  const admin = {
    recipe: (id: string) => t.http().get(`/api/admin/drafts/recipes/${id}`).set(asAdmin),
    name: (id: string) => t.http().get(`/api/admin/drafts/ingredient-names/${id}`).set(asAdmin),
    review: (kind: 'recipes' | 'ingredient-names', id: string, verdict: 'approve' | 'reject', locale: string, reason?: string) =>
      t.http().post(`/api/admin/drafts/${kind}/${id}/${verdict}?locale=${locale}`).set(asAdmin).send({ reviewedByLabel: 'Pavlo', reason }),
    edit: (id: string, patch: Record<string, unknown>, dryRun = false) =>
      t.http().patch(`/api/admin/drafts/recipes/${id}${dryRun ? '?dryRun=true' : ''}`).set(asAdmin).send(patch),
    editName: (id: string, suggestions: Record<string, unknown>) =>
      t.http().patch(`/api/admin/drafts/ingredient-names/${id}`).set(asAdmin).send({ suggestions }),
  };
  const asReviewer = {
    recipe: (id: string, locale = 'pl') => t.http().get(`/api/review/drafts/recipes/${id}?locale=${locale}`).set(reviewer),
    name: (id: string, locale = 'pl') => t.http().get(`/api/review/drafts/ingredient-names/${id}?locale=${locale}`).set(reviewer),
    review: (kind: 'recipes' | 'ingredient-names', id: string, verdict: 'approve' | 'reject', locale = 'pl', reason?: string) =>
      t.http().post(`/api/review/drafts/${kind}/${id}/${verdict}?locale=${locale}`).set(reviewer).send(reason ? { reason } : {}),
    edit: (id: string, patch: Record<string, unknown>, locale = 'pl') =>
      t.http().patch(`/api/review/drafts/recipes/${id}?locale=${locale}`).set(reviewer).send(patch),
    editName: (id: string, patch: Record<string, unknown>, locale = 'pl') =>
      t.http().patch(`/api/review/drafts/ingredient-names/${id}?locale=${locale}`).set(reviewer).send(patch),
  };
  const recipeRow = (id: string) => t.prisma.recipeDraft.findUniqueOrThrow({ where: { id } });
  const reviewsOf = (draftId: string) => t.prisma.recipeDraftLocaleReview.findMany({ where: { draftId }, orderBy: { reviewedAt: 'asc' } });

  describe('reviews', () => {
    it('make a recipe approved once the administrator approved English and a reviewer every other language', async () => {
      const draft = await aRecipeDraft(t);

      const first = await admin.review('recipes', draft.id, 'approve', 'en').expect(201);
      expect(first.body.status).toBe('PENDING');
      const second = await asReviewer.review('recipes', draft.id, 'approve').expect(201);

      expect(second.body.status).toBe('APPROVED');
      expect((await admin.recipe(draft.id)).body).toMatchObject({
        status: 'APPROVED',
        localeReviews: [
          { locale: 'en', action: 'APPROVE', byRole: 'ADMIN', reviewedByLabel: 'Pavlo' },
          { locale: 'pl', action: 'APPROVE', byRole: 'REVIEWER', reviewedByLabel: 'Anna' },
        ],
      });
    });

    it('of English are the administrator\'s alone', async () => {
      const draft = await aRecipeDraft(t);

      const refused = await asReviewer.review('recipes', draft.id, 'approve', 'en');

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('INVALID_LOCALE');
      expect(await reviewsOf(draft.id)).toEqual([]);
    });

    it('make the name of an ingredient approved with the reviewer\'s word alone, and nobody reviews its English', async () => {
      const draft = await anIngredientNameDraft(t);

      expect((await admin.review('ingredient-names', draft.id, 'approve', 'en')).body.error).toBe('INVALID_LOCALE');
      const approved = await asReviewer.review('ingredient-names', draft.id, 'approve').expect(201);

      expect(approved.body.status).toBe('APPROVED');
    });

    it('reject the draft as soon as one language is rejected, with the reason kept', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      const rejected = await asReviewer.review('recipes', draft.id, 'reject', 'pl', 'The steps are in the wrong order.').expect(201);

      expect(rejected.body.status).toBe('REJECTED');
      expect((await admin.recipe(draft.id)).body.localeReviews).toContainEqual(
        expect.objectContaining({ locale: 'pl', action: 'REJECT', byRole: 'REVIEWER', reason: 'The steps are in the wrong order.' }),
      );
    });

    it('are refused for a language the draft is not in', async () => {
      const draft = await aRecipeDraft(t, { locales: ['en'], titles: { en: 'Oat bowl' }, descriptions: { en: 'Oats.' }, steps: { en: ['Stir.'] } });

      const refused = await asReviewer.review('recipes', draft.id, 'approve', 'pl');

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('LOCALE_NOT_IN_DRAFT');
    });

    it('keep what was decided before: a second review takes the place of the first, which stays on record', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'reject', 'en', 'Too salty.').expect(201);

      const second = await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      expect(second.body.status).toBe('PENDING');
      expect(second.body.localeReviews).toEqual([expect.objectContaining({ locale: 'en', action: 'APPROVE' })]);
      expect(second.body.pastReviews).toEqual([expect.objectContaining({ locale: 'en', action: 'REJECT', reason: 'Too salty.', byRole: 'ADMIN', reviewedByLabel: 'Pavlo' })]);
      const rows = await reviewsOf(draft.id);
      expect(rows.map((row) => [row.action, row.supersededAt !== null])).toEqual([
        ['REJECT', true],
        ['APPROVE', false],
      ]);
    });

    it('given at the same moment by the administrator and a reviewer leave no draft half approved', async () => {
      const drafts = await Promise.all(Array.from({ length: 12 }, () => aRecipeDraft(t)));

      const answers = await race(drafts.length * 2, (index) => {
        const draft = drafts[Math.floor(index / 2)]!;
        return index % 2 === 0 ? admin.review('recipes', draft.id, 'approve', 'en') : asReviewer.review('recipes', draft.id, 'approve');
      });

      expect(answers.map((answer) => (answer.status === 'fulfilled' ? answer.value.status : answer.status))).toEqual(Array(drafts.length * 2).fill(201));
      const statuses = await t.prisma.recipeDraft.findMany({ where: { id: { in: drafts.map((draft) => draft.id) } }, select: { status: true } });
      expect(statuses.map((row) => row.status)).toEqual(Array(drafts.length).fill('APPROVED'));
      // One current review per language, however the requests overlapped.
      for (const draft of drafts) {
        const current = (await reviewsOf(draft.id)).filter((row) => row.supersededAt === null);
        expect(current.map((row) => row.locale).sort()).toEqual(['en', 'pl']);
      }
    });
  });

  describe('an edit by the administrator', () => {
    it('sends an approved draft back to be reviewed, and the reviews it had stay on record', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);
      await asReviewer.review('recipes', draft.id, 'approve').expect(201);

      const edited = await admin.edit(draft.id, { titles: { pl: 'Owsianka z bananem' } }).expect(200);

      expect(edited.body).toMatchObject({ status: 'PENDING', localeReviews: [] });
      expect(edited.body.pastReviews).toHaveLength(2);
      expect((await reviewsOf(draft.id)).every((row) => row.supersededAt !== null)).toBe(true);
    });

    it('of one language leaves the text of the others as it was', async () => {
      const draft = await aRecipeDraft(t);

      const edited = await admin.edit(draft.id, { titles: { pl: 'Owsianka z bananem' }, steps: { pl: ['Wymieszaj.'] } }).expect(200);

      expect(edited.body.titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka z bananem' });
      expect(edited.body.steps).toEqual({ en: ['Warm the drink.', 'Stir in the oats and the banana.'], pl: ['Wymieszaj.'] });
    });

    it('that breaks a rule is refused with every problem named, and the draft stays as it was', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      const refused = await admin.edit(draft.id, {
        titles: { en: 'Bowl <img src=x onerror=alert(1)>' },
        descriptions: { pl: 'o'.repeat(RECIPE_LIMITS.description + 1) },
        servings: 500,
        ingredients: [{ slug: 'rolled-oats', quantity: 10_000, unit: 'g' }, { slug: 'oat-drink', quantity: 200, unit: 'ml' }, { slug: 'banana', quantity: 120, unit: 'g' }],
      });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('DRAFT_INVALID');
      expect(refused.body.details.problems.map((problem: { path: string; rule: string }) => `${problem.path}: ${problem.rule}`)).toEqual([
        'titles.en: markup',
        'descriptions.pl: text-too-long',
        'servings: servings-out-of-range',
      ]);
      const row = await recipeRow(draft.id);
      expect(row.titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka' });
      expect(row.servings).toBe(1);
      expect((await reviewsOf(draft.id)).filter((review) => review.supersededAt === null)).toHaveLength(1);
    });

    it('is checked the same way when it is only tried out', async () => {
      const draft = await aRecipeDraft(t);

      const refused = await admin.edit(draft.id, { steps: { en: ['<svg onload=alert(1)>'] } }, true);

      expect(refused.status).toBe(400);
      expect(refused.body.details.problems).toEqual([expect.objectContaining({ path: 'steps.en[0]', rule: 'markup' })]);
    });

    it('of the ingredients has the engine work the figures out again, and a try-out stores nothing', async () => {
      const draft = await aRecipeDraft(t);
      const lighter = [{ slug: 'rolled-oats', quantity: 30, unit: 'g' }, { slug: 'oat-drink', quantity: 200, unit: 'ml' }, { slug: 'banana', quantity: 120, unit: 'g' }];

      const tried = await admin.edit(draft.id, { ingredients: lighter }, true).expect(200);
      expect(tried.body.caloriesPerServing).toBeLessThan(draft.caloriesPerServing);
      expect((await recipeRow(draft.id)).caloriesPerServing).toBe(draft.caloriesPerServing);

      const stored = await admin.edit(draft.id, { ingredients: lighter }).expect(200);
      expect(stored.body.caloriesPerServing).toBe(tried.body.caloriesPerServing);
      expect((await recipeRow(draft.id)).caloriesPerServing).toBe(tried.body.caloriesPerServing);
    });

    it('cannot bring in an ingredient the catalogue does not have', async () => {
      const draft = await aRecipeDraft(t);

      const refused = await admin.edit(draft.id, { ingredients: [{ slug: 'unicorn-steak', quantity: 100, unit: 'g' }, { slug: 'oat-drink', quantity: 200, unit: 'ml' }, { slug: 'banana', quantity: 120, unit: 'g' }] });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('UNKNOWN_SLUG');
    });

    it('of the text of a recipe users made works whatever its size, and its ingredients stay theirs', async () => {
      // Two ingredients: fewer than any band of generated recipes has.
      const draft = await aRecipeDraft(t, {
        source: 'AI_USER',
        complexity: 'medium',
        ingredientsJson: [{ slug: 'rolled-oats', quantity: 60, unit: 'g', note: null }, { slug: 'banana', quantity: 120, unit: 'g', note: null }],
      });

      const edited = await admin.edit(draft.id, { titles: { pl: 'Owsianka domowa' } }).expect(200);
      expect(edited.body.titles.pl).toBe('Owsianka domowa');
      expect(edited.body.complexity).toBe('medium');

      const refused = await admin.edit(draft.id, { servings: 2 });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('DRAFT_STRUCTURAL_EDIT_FORBIDDEN');
    });

    it('of the name of an ingredient keeps only the languages the draft is in, and wants each of them', async () => {
      const draft = await anIngredientNameDraft(t);

      const edited = await admin.editName(draft.id, { name: { pl: 'Filet z kurczaka', en: 'Chicken fillet' }, storageHint: { en: 'Chilled.' } }).expect(200);
      // An English name on a draft made for Polish would ship without anybody having approved it.
      expect(edited.body.suggestions).toEqual({ name: { pl: 'Filet z kurczaka' } });

      const refused = await admin.editName(draft.id, { name: { en: 'Chicken fillet' } });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('DRAFT_INVALID');
      expect(refused.body.details.problems).toEqual([expect.objectContaining({ path: 'name.pl', rule: 'missing-locale' })]);

      const markup = await admin.editName(draft.id, { name: { pl: '<b>Filet</b>' } });
      expect(markup.body.details.problems).toEqual([expect.objectContaining({ path: 'name.pl', rule: 'markup' })]);
    });
  });

  describe('an edit by a reviewer', () => {
    it('changes the text of their language only, and the draft is to be reviewed again', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      const edited = await asReviewer.edit(draft.id, { title: 'Owsianka bananowa', steps: ['Podgrzej.', 'Wymieszaj.'] }).expect(200);

      expect(edited.body).toMatchObject({ title: 'Owsianka bananowa', titleSource: 'Oat bowl', status: 'PENDING', alreadyReviewed: false });
      const row = await recipeRow(draft.id);
      expect(row.titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka bananowa' });
      expect(row.steps).toEqual({ en: ['Warm the drink.', 'Stir in the oats and the banana.'], pl: ['Podgrzej.', 'Wymieszaj.'] });
      expect((await reviewsOf(draft.id)).map((review) => review.supersededAt !== null)).toEqual([true]);
    });

    it('is held to the same rules as any other text', async () => {
      const draft = await aRecipeDraft(t);

      const markup = await asReviewer.edit(draft.id, { title: 'Owsianka <script>alert(1)</script>' });
      expect(markup.status).toBe(400);
      expect(markup.body.error).toBe('DRAFT_INVALID');
      expect(markup.body.details.problems).toEqual([expect.objectContaining({ path: 'titles.pl', rule: 'markup' })]);

      const long = await asReviewer.edit(draft.id, { title: 'o'.repeat(RECIPE_LIMITS.title + 1), steps: ['k'.repeat(RECIPE_LIMITS.step + 1)] });
      expect(long.body.details.problems.map((problem: { path: string; rule: string }) => `${problem.path}: ${problem.rule}`)).toEqual(['titles.pl: text-too-long', 'steps.pl[0]: text-too-long']);
      expect((await recipeRow(draft.id)).titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka' });
    });

    it('of the name of an ingredient is held to them too', async () => {
      const draft = await anIngredientNameDraft(t);

      const edited = await asReviewer.editName(draft.id, { name: ' Filet  z kurczaka ', storageHint: 'W lodówce.' }).expect(200);
      expect(edited.body).toMatchObject({ name: 'Filet z kurczaka', storageHint: 'W lodówce.', status: 'PENDING' });

      const refused = await asReviewer.editName(draft.id, { name: 'Filet <i>z kurczaka</i>' });
      expect(refused.status).toBe(400);
      expect(refused.body.details.problems).toEqual([expect.objectContaining({ path: 'name.pl', rule: 'markup' })]);
    });
  });

  describe('a draft that has shipped', () => {
    const shippedAt = new Date('2026-09-01T10:00:00Z');

    it('is not edited, reviewed or deleted, by anybody', async () => {
      const draft = await aRecipeDraft(t, { status: 'SHIPPED', shippedAt });

      const attempts = [
        await admin.edit(draft.id, { titles: { pl: 'Inna' } }),
        await admin.review('recipes', draft.id, 'reject', 'en'),
        await asReviewer.edit(draft.id, { title: 'Inna' }),
        await asReviewer.review('recipes', draft.id, 'approve'),
        await t.http().delete(`/api/admin/drafts/recipes/${draft.id}`).set(asAdmin),
      ];

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(Array(5).fill([409, 'DRAFT_SHIPPED']));
      expect(await recipeRow(draft.id)).toMatchObject({ status: 'SHIPPED', shippedAt, titles: { en: 'Oat bowl', pl: 'Owsianka' } });
    });

    it('is not edited when it is the name of an ingredient either', async () => {
      const draft = await anIngredientNameDraft(t, { status: 'SHIPPED', shippedAt });

      const attempts = [
        await admin.editName(draft.id, { name: { pl: 'Inna nazwa' } }),
        await admin.review('ingredient-names', draft.id, 'reject', 'pl'),
        await asReviewer.editName(draft.id, { name: 'Inna nazwa' }),
        await asReviewer.review('ingredient-names', draft.id, 'approve'),
        await t.http().delete(`/api/admin/drafts/ingredient-names/${draft.id}`).set(asAdmin),
      ];

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(Array(5).fill([409, 'DRAFT_SHIPPED']));
      const row = await t.prisma.ingredientNameDraft.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row).toMatchObject({ status: 'SHIPPED', shippedAt, suggestions: { name: { pl: 'Pierś z kurczaka' } } });
    });
  });

  describe('a draft the administrator rejected', () => {
    it('is out of a reviewer\'s reach: not read, edited or reviewed, and the rejection stands with its reason', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'reject', 'en', 'Serves undercooked chicken.').expect(201);

      const attempts = [
        await asReviewer.recipe(draft.id),
        await asReviewer.edit(draft.id, { title: 'x' }),
        await asReviewer.review('recipes', draft.id, 'approve'),
        await asReviewer.review('recipes', draft.id, 'reject'),
      ];

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(Array(4).fill([409, 'DRAFT_REJECTED']));
      expect((await admin.recipe(draft.id)).body).toMatchObject({
        status: 'REJECTED',
        titles: { en: 'Oat bowl', pl: 'Owsianka' },
        localeReviews: [{ locale: 'en', action: 'REJECT', reason: 'Serves undercooked chicken.', byRole: 'ADMIN' }],
      });
    });

    it('is out of their reach when it is the name of an ingredient too', async () => {
      const draft = await anIngredientNameDraft(t);
      await admin.review('ingredient-names', draft.id, 'reject', 'pl', 'Not what it is called.').expect(201);

      const attempts = [await asReviewer.name(draft.id), await asReviewer.editName(draft.id, { name: 'Inna' }), await asReviewer.review('ingredient-names', draft.id, 'approve')];

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(Array(3).fill([409, 'DRAFT_REJECTED']));
    });

    it('can be reopened by the administrator\'s own edit, and what was decided stays on record', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'reject', 'en', 'Serves undercooked chicken.').expect(201);

      const reopened = await admin.edit(draft.id, { steps: { en: ['Cook it through.'] } }).expect(200);

      expect(reopened.body).toMatchObject({ status: 'PENDING', localeReviews: [] });
      expect(reopened.body.pastReviews).toEqual([expect.objectContaining({ action: 'REJECT', reason: 'Serves undercooked chicken.', byRole: 'ADMIN' })]);
      await asReviewer.recipe(draft.id).expect(200);
    });
  });

  describe('the lists', () => {
    it('take a status, a batch and a complexity, each checked', async () => {
      await aRecipeDraft(t);
      await aRecipeDraft(t, { status: 'APPROVED', batchId: 'another-batch', complexity: 'medium' });

      const list = (query: string) => t.http().get(`/api/admin/drafts/recipes${query}`).set(asAdmin);

      expect((await list('').expect(200)).body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect((await list('?status=APPROVED').expect(200)).body.total).toBe(1);
      expect((await list('?batchId=another-batch&complexity=medium').expect(200)).body.total).toBe(1);
      expect((await list('?page=2&pageSize=1').expect(200)).body).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [expect.anything()] });
    });

    it.each(['?status=pending', '?status=FOO', '?batchId=a&batchId=b', '?complexity=hardest', '?page=0', '?pageSize=1000', '?page=one'])(
      'answer %s with what is wrong, not with a failure of the server',
      async (query) => {
        const recipes = await t.http().get(`/api/admin/drafts/recipes${query}`).set(asAdmin);
        expect([recipes.status, recipes.body.error]).toEqual([400, 'VALIDATION_FAILED']);

        if (!query.includes('complexity')) {
          const names = await t.http().get(`/api/admin/drafts/ingredient-names${query}`).set(asAdmin);
          expect([names.status, names.body.error]).toEqual([400, 'VALIDATION_FAILED']);
        }
      },
    );

    it('show a reviewer what waits for their language, and want to know which language that is', async () => {
      const waiting = await aRecipeDraft(t);
      await aRecipeDraft(t, { status: 'REJECTED' });
      await aRecipeDraft(t, { status: 'SHIPPED' });
      const done = await aRecipeDraft(t);
      await asReviewer.review('recipes', done.id, 'approve').expect(201);

      const list = (query: string) => t.http().get(`/api/review/drafts/recipes${query}`).set(reviewer);

      expect((await list('?locale=pl').expect(200)).body.items.map((item: { id: string }) => item.id)).toEqual([waiting.id]);
      expect((await list('?locale=pl&includeReviewed=true').expect(200)).body.total).toBe(2);
      for (const query of ['', '?locale=en', '?locale=xx', '?locale=pl&page=0', '?locale=pl&pageSize=500']) {
        expect((await list(query)).status).toBe(400);
      }
    });
  });

  describe('a run that writes names for ingredients', () => {
    it('is not started for English: nobody could approve what it wrote', async () => {
      const refused = await t.http().post('/api/admin/drafts/ingredient-names/generate').set(asAdmin).send({ scope: 'all-usda-missing', targetLocales: ['en', 'pl'] });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('INVALID_SPEC');
    });
  });
});
