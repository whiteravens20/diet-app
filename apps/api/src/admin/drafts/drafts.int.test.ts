// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RECIPE_LIMITS } from '@diet-app/shared';
import { seedCatalogue } from '../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../testing/database.js';
import {
  aRecipeDraft,
  aReviewer,
  anIngredientNameDraft,
  asAdmin,
  race,
} from '../../testing/factories.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';
import { DraftService } from './draft.service.js';
import { IngredientNamerRunner, type IngredientNamerStartSpec } from './ingredient-namer.runner.js';

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
    review: (
      kind: 'recipes' | 'ingredient-names',
      id: string,
      verdict: 'approve' | 'reject',
      locale: string,
      reason?: string,
    ) =>
      t
        .http()
        .post(`/api/admin/drafts/${kind}/${id}/${verdict}?locale=${locale}`)
        .set(asAdmin)
        .send({ reviewedByLabel: 'Pavlo', reason }),
    edit: (id: string, patch: Record<string, unknown>, dryRun = false) =>
      t
        .http()
        .patch(`/api/admin/drafts/recipes/${id}${dryRun ? '?dryRun=true' : ''}`)
        .set(asAdmin)
        .send(patch),
    editName: (id: string, suggestions: Record<string, unknown>) =>
      t.http().patch(`/api/admin/drafts/ingredient-names/${id}`).set(asAdmin).send({ suggestions }),
  };
  const asReviewer = {
    recipe: (id: string, locale = 'pl') =>
      t.http().get(`/api/review/drafts/recipes/${id}?locale=${locale}`).set(reviewer),
    name: (id: string, locale = 'pl') =>
      t.http().get(`/api/review/drafts/ingredient-names/${id}?locale=${locale}`).set(reviewer),
    review: (
      kind: 'recipes' | 'ingredient-names',
      id: string,
      verdict: 'approve' | 'reject',
      locale = 'pl',
      reason?: string,
    ) =>
      t
        .http()
        .post(`/api/review/drafts/${kind}/${id}/${verdict}?locale=${locale}`)
        .set(reviewer)
        .send(reason ? { reason } : {}),
    edit: (id: string, patch: Record<string, unknown>, locale = 'pl') =>
      t.http().patch(`/api/review/drafts/recipes/${id}?locale=${locale}`).set(reviewer).send(patch),
    editName: (id: string, patch: Record<string, unknown>, locale = 'pl') =>
      t
        .http()
        .patch(`/api/review/drafts/ingredient-names/${id}?locale=${locale}`)
        .set(reviewer)
        .send(patch),
  };
  const recipeRow = (id: string) => t.prisma.recipeDraft.findUniqueOrThrow({ where: { id } });
  const reviewsOf = (draftId: string) =>
    t.prisma.recipeDraftLocaleReview.findMany({
      where: { draftId },
      orderBy: { reviewedAt: 'asc' },
    });

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

    it("of English are the administrator's alone", async () => {
      const draft = await aRecipeDraft(t);

      const refused = await asReviewer.review('recipes', draft.id, 'approve', 'en');

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        error: 'VALIDATION_FAILED',
        issues: [{ path: 'locale' }],
      });
      expect(await reviewsOf(draft.id)).toEqual([]);
    });

    it("make the name of an ingredient approved with the reviewer's word alone, and nobody reviews its English", async () => {
      const draft = await anIngredientNameDraft(t);

      expect(
        (await admin.review('ingredient-names', draft.id, 'approve', 'en')).body,
      ).toMatchObject({ error: 'VALIDATION_FAILED', issues: [{ path: 'locale' }] });
      const approved = await asReviewer.review('ingredient-names', draft.id, 'approve').expect(201);

      expect(approved.body.status).toBe('APPROVED');
    });

    it('reject the draft as soon as one language is rejected, with the reason kept', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      const rejected = await asReviewer
        .review('recipes', draft.id, 'reject', 'pl', 'The steps are in the wrong order.')
        .expect(201);

      expect(rejected.body.status).toBe('REJECTED');
      expect((await admin.recipe(draft.id)).body.localeReviews).toContainEqual(
        expect.objectContaining({
          locale: 'pl',
          action: 'REJECT',
          byRole: 'REVIEWER',
          reason: 'The steps are in the wrong order.',
        }),
      );
    });

    it('are refused for a language the draft is not in', async () => {
      const draft = await aRecipeDraft(t, {
        locales: ['en'],
        titles: { en: 'Oat bowl' },
        descriptions: { en: 'Oats.' },
        steps: { en: ['Stir.'] },
      });

      const refused = await asReviewer.review('recipes', draft.id, 'approve', 'pl');

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('LOCALE_NOT_IN_DRAFT');
    });

    it('keep what was decided before: a second review takes the place of the first, which stays on record', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'reject', 'en', 'Too salty.').expect(201);

      const second = await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      expect(second.body.status).toBe('PENDING');
      expect(second.body.localeReviews).toEqual([
        expect.objectContaining({ locale: 'en', action: 'APPROVE' }),
      ]);
      expect(second.body.pastReviews).toEqual([
        expect.objectContaining({
          locale: 'en',
          action: 'REJECT',
          reason: 'Too salty.',
          byRole: 'ADMIN',
          reviewedByLabel: 'Pavlo',
        }),
      ]);
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
        return index % 2 === 0
          ? admin.review('recipes', draft.id, 'approve', 'en')
          : asReviewer.review('recipes', draft.id, 'approve');
      });

      expect(
        answers.map((answer) =>
          answer.status === 'fulfilled' ? answer.value.status : answer.status,
        ),
      ).toEqual(Array(drafts.length * 2).fill(201));
      const statuses = await t.prisma.recipeDraft.findMany({
        where: { id: { in: drafts.map((draft) => draft.id) } },
        select: { status: true },
      });
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

      const edited = await admin
        .edit(draft.id, { titles: { pl: 'Owsianka z bananem' } })
        .expect(200);

      expect(edited.body).toMatchObject({ status: 'PENDING', localeReviews: [] });
      expect(edited.body.pastReviews).toHaveLength(2);
      expect((await reviewsOf(draft.id)).every((row) => row.supersededAt !== null)).toBe(true);
    });

    it('of one language leaves the text of the others as it was', async () => {
      const draft = await aRecipeDraft(t);

      const edited = await admin
        .edit(draft.id, { titles: { pl: 'Owsianka z bananem' }, steps: { pl: ['Wymieszaj.'] } })
        .expect(200);

      expect(edited.body.titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka z bananem' });
      expect(edited.body.steps).toEqual({
        en: ['Warm the drink.', 'Stir in the oats and the banana.'],
        pl: ['Wymieszaj.'],
      });
    });

    it('that breaks a rule is refused with every problem named, and the draft stays as it was', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      const refused = await admin.edit(draft.id, {
        titles: { en: 'Bowl <img src=x onerror=alert(1)>' },
        descriptions: { pl: 'o'.repeat(RECIPE_LIMITS.description + 1) },
        servings: 500,
        ingredients: [
          { slug: 'rolled-oats', quantity: 10_000, unit: 'g' },
          { slug: 'oat-drink', quantity: 200, unit: 'ml' },
          { slug: 'banana', quantity: 120, unit: 'g' },
        ],
      });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('DRAFT_INVALID');
      expect(
        refused.body.details.problems.map(
          (problem: { path: string; rule: string }) => `${problem.path}: ${problem.rule}`,
        ),
      ).toEqual([
        'titles.en: markup',
        'descriptions.pl: text-too-long',
        'servings: servings-out-of-range',
      ]);
      const row = await recipeRow(draft.id);
      expect(row.titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka' });
      expect(row.servings).toBe(1);
      expect(
        (await reviewsOf(draft.id)).filter((review) => review.supersededAt === null),
      ).toHaveLength(1);
    });

    it('is checked the same way when it is only tried out', async () => {
      const draft = await aRecipeDraft(t);

      const refused = await admin.edit(
        draft.id,
        { steps: { en: ['<svg onload=alert(1)>'] } },
        true,
      );

      expect(refused.status).toBe(400);
      expect(refused.body.details.problems).toEqual([
        expect.objectContaining({ path: 'steps.en[0]', rule: 'markup' }),
      ]);
    });

    it('of the ingredients has the engine work the figures out again, and a try-out stores nothing', async () => {
      const draft = await aRecipeDraft(t);
      const lighter = [
        { slug: 'rolled-oats', quantity: 30, unit: 'g' },
        { slug: 'oat-drink', quantity: 200, unit: 'ml' },
        { slug: 'banana', quantity: 120, unit: 'g' },
      ];

      const tried = await admin.edit(draft.id, { ingredients: lighter }, true).expect(200);
      expect(tried.body.caloriesPerServing).toBeLessThan(draft.caloriesPerServing);
      expect((await recipeRow(draft.id)).caloriesPerServing).toBe(draft.caloriesPerServing);

      const stored = await admin.edit(draft.id, { ingredients: lighter }).expect(200);
      expect(stored.body.caloriesPerServing).toBe(tried.body.caloriesPerServing);
      expect((await recipeRow(draft.id)).caloriesPerServing).toBe(tried.body.caloriesPerServing);
    });

    it('cannot bring in an ingredient the catalogue does not have', async () => {
      const draft = await aRecipeDraft(t);

      const refused = await admin.edit(draft.id, {
        ingredients: [
          { slug: 'unicorn-steak', quantity: 100, unit: 'g' },
          { slug: 'oat-drink', quantity: 200, unit: 'ml' },
          { slug: 'banana', quantity: 120, unit: 'g' },
        ],
      });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('UNKNOWN_SLUG');
    });

    it('of the text of a recipe users made works whatever its size, and its ingredients stay theirs', async () => {
      // Two ingredients: fewer than any band of generated recipes has.
      const draft = await aRecipeDraft(t, {
        source: 'AI_USER',
        complexity: 'medium',
        ingredientsJson: [
          { slug: 'rolled-oats', quantity: 60, unit: 'g', note: null },
          { slug: 'banana', quantity: 120, unit: 'g', note: null },
        ],
      });

      const edited = await admin.edit(draft.id, { titles: { pl: 'Owsianka domowa' } }).expect(200);
      expect(edited.body.titles.pl).toBe('Owsianka domowa');
      expect(edited.body.complexity).toBe('medium');

      const refused = await admin.edit(draft.id, { servings: 2 });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('DRAFT_STRUCTURAL_EDIT_FORBIDDEN');
    });

    it('of the text of a recipe users made has the engine work its figures out again', async () => {
      // Stored with figures the catalogue no longer gives it.
      const draft = await aRecipeDraft(t, {
        source: 'AI_USER',
        caloriesPerServing: 5,
        allergens: ['dairy'],
      });
      const figures = await aRecipeDraft(t);

      const edited = await admin.edit(draft.id, { titles: { pl: 'Owsianka domowa' } }).expect(200);

      expect(edited.body).toMatchObject({
        caloriesPerServing: figures.caloriesPerServing,
        allergens: figures.allergens,
        status: 'PENDING',
      });
    });

    it('of the slug alone leaves the reviews standing: reviewers answer for the text', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);
      await asReviewer.review('recipes', draft.id, 'approve').expect(201);

      const renamed = await admin.edit(draft.id, { slug: 'oat-bowl-with-banana' }).expect(200);

      expect(renamed.body).toMatchObject({ slug: 'oat-bowl-with-banana', status: 'APPROVED' });
      expect(renamed.body.localeReviews).toHaveLength(2);
      expect((await recipeRow(draft.id)).slug).toBe('oat-bowl-with-banana');
    });

    it('of the cuisine alone leaves the reviews standing too, and can take the cuisine away again', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);
      await asReviewer.review('recipes', draft.id, 'approve').expect(201);

      const tagged = await admin.edit(draft.id, { cuisine: 'asian' }).expect(200);

      expect(tagged.body).toMatchObject({ cuisine: 'asian', status: 'APPROVED' });
      expect(tagged.body.localeReviews).toHaveLength(2);
      expect((await recipeRow(draft.id)).cuisine).toBe('asian');

      const cleared = await admin.edit(draft.id, { cuisine: null }).expect(200);
      expect(cleared.body).toMatchObject({ cuisine: null, status: 'APPROVED' });
    });

    it('keeps the cuisine through an edit of the text, and refuses one the application does not know', async () => {
      const draft = await aRecipeDraft(t, { cuisine: 'polish' });

      const edited = await admin
        .edit(draft.id, { titles: { en: 'Oat bowl with banana' } })
        .expect(200);
      const refused = await admin.edit(draft.id, { cuisine: 'martian' }).expect(400);

      expect(edited.body).toMatchObject({ cuisine: 'polish', status: 'PENDING' });
      expect(refused.body.error).toBe('VALIDATION_FAILED');
      expect((await recipeRow(draft.id)).cuisine).toBe('polish');
    });

    it('of the slug works for a recipe users made, and with other changes sends the draft back to review', async () => {
      const fromUsers = await aRecipeDraft(t, { source: 'AI_USER', status: 'APPROVED' });
      const generated = await aRecipeDraft(t, { status: 'APPROVED' });

      expect(
        (await admin.edit(fromUsers.id, { slug: 'home-oats' }).expect(200)).body,
      ).toMatchObject({ slug: 'home-oats', status: 'APPROVED' });
      expect(
        (await admin.edit(generated.id, { slug: 'oats-for-two', servings: 2 }).expect(200)).body,
      ).toMatchObject({ slug: 'oats-for-two', servings: 2, status: 'PENDING' });
    });

    it('of the slug to something that is no slug is refused', async () => {
      const draft = await aRecipeDraft(t);

      for (const slug of ['Oat Bowl', '../recipes', 'oat--bowl', '', 'a'.repeat(81)]) {
        const res = await admin.edit(draft.id, { slug });
        expect([slug, res.status, res.body.error]).toEqual([slug, 400, 'DRAFT_INVALID']);
        expect(res.body.details.problems).toEqual([
          expect.objectContaining({ path: 'slug', rule: 'invalid-slug' }),
        ]);
      }
      expect((await recipeRow(draft.id)).slug).toBe(draft.slug);
    });

    it('of the name of an ingredient keeps only the languages the draft is in, and wants each of them', async () => {
      const draft = await anIngredientNameDraft(t);

      const edited = await admin
        .editName(draft.id, {
          name: { pl: 'Filet z kurczaka', en: 'Chicken fillet' },
          storageHint: { en: 'Chilled.' },
        })
        .expect(200);
      // An English name on a draft made for Polish would ship without anybody having approved it.
      expect(edited.body.suggestions).toEqual({ name: { pl: 'Filet z kurczaka' } });

      const refused = await admin.editName(draft.id, { name: { en: 'Chicken fillet' } });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('DRAFT_INVALID');
      expect(refused.body.details.problems).toEqual([
        expect.objectContaining({ path: 'name.pl', rule: 'missing-locale' }),
      ]);

      const markup = await admin.editName(draft.id, { name: { pl: '<b>Filet</b>' } });
      expect(markup.body.details.problems).toEqual([
        expect.objectContaining({ path: 'name.pl', rule: 'markup' }),
      ]);
    });
  });

  describe('an edit by a reviewer', () => {
    it('changes the text of their language only, and the draft is to be reviewed again', async () => {
      const draft = await aRecipeDraft(t);
      await admin.review('recipes', draft.id, 'approve', 'en').expect(201);

      const edited = await asReviewer
        .edit(draft.id, { title: 'Owsianka bananowa', steps: ['Podgrzej.', 'Wymieszaj.'] })
        .expect(200);

      expect(edited.body).toMatchObject({
        title: 'Owsianka bananowa',
        titleSource: 'Oat bowl',
        status: 'PENDING',
        alreadyReviewed: false,
      });
      const row = await recipeRow(draft.id);
      expect(row.titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka bananowa' });
      expect(row.steps).toEqual({
        en: ['Warm the drink.', 'Stir in the oats and the banana.'],
        pl: ['Podgrzej.', 'Wymieszaj.'],
      });
      expect((await reviewsOf(draft.id)).map((review) => review.supersededAt !== null)).toEqual([
        true,
      ]);
    });

    it('is held to the same rules as any other text', async () => {
      const draft = await aRecipeDraft(t);

      const markup = await asReviewer.edit(draft.id, {
        title: 'Owsianka <script>alert(1)</script>',
      });
      expect(markup.status).toBe(400);
      expect(markup.body.error).toBe('DRAFT_INVALID');
      expect(markup.body.details.problems).toEqual([
        expect.objectContaining({ path: 'titles.pl', rule: 'markup' }),
      ]);

      const long = await asReviewer.edit(draft.id, {
        title: 'o'.repeat(RECIPE_LIMITS.title + 1),
        steps: ['k'.repeat(RECIPE_LIMITS.step + 1)],
      });
      expect(
        long.body.details.problems.map(
          (problem: { path: string; rule: string }) => `${problem.path}: ${problem.rule}`,
        ),
      ).toEqual(['titles.pl: text-too-long', 'steps.pl[0]: text-too-long']);
      expect((await recipeRow(draft.id)).titles).toEqual({ en: 'Oat bowl', pl: 'Owsianka' });
    });

    it('of the name of an ingredient is held to them too', async () => {
      const draft = await anIngredientNameDraft(t);

      const edited = await asReviewer
        .editName(draft.id, { name: ' Filet  z kurczaka ', storageHint: 'W lodówce.' })
        .expect(200);
      expect(edited.body).toMatchObject({
        name: 'Filet z kurczaka',
        storageHint: 'W lodówce.',
        status: 'PENDING',
      });

      const refused = await asReviewer.editName(draft.id, { name: 'Filet <i>z kurczaka</i>' });
      expect(refused.status).toBe(400);
      expect(refused.body.details.problems).toEqual([
        expect.objectContaining({ path: 'name.pl', rule: 'markup' }),
      ]);
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

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(
        Array(5).fill([409, 'DRAFT_SHIPPED']),
      );
      expect(await recipeRow(draft.id)).toMatchObject({
        status: 'SHIPPED',
        shippedAt,
        titles: { en: 'Oat bowl', pl: 'Owsianka' },
      });
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

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(
        Array(5).fill([409, 'DRAFT_SHIPPED']),
      );
      const row = await t.prisma.ingredientNameDraft.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row).toMatchObject({
        status: 'SHIPPED',
        shippedAt,
        suggestions: { name: { pl: 'Pierś z kurczaka' } },
      });
    });
  });

  describe('a draft the administrator rejected', () => {
    it("is out of a reviewer's reach: not read, edited or reviewed, and the rejection stands with its reason", async () => {
      const draft = await aRecipeDraft(t);
      await admin
        .review('recipes', draft.id, 'reject', 'en', 'Serves undercooked chicken.')
        .expect(201);

      const attempts = [
        await asReviewer.recipe(draft.id),
        await asReviewer.edit(draft.id, { title: 'x' }),
        await asReviewer.review('recipes', draft.id, 'approve'),
        await asReviewer.review('recipes', draft.id, 'reject'),
      ];

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(
        Array(4).fill([409, 'DRAFT_REJECTED']),
      );
      expect((await admin.recipe(draft.id)).body).toMatchObject({
        status: 'REJECTED',
        titles: { en: 'Oat bowl', pl: 'Owsianka' },
        localeReviews: [
          {
            locale: 'en',
            action: 'REJECT',
            reason: 'Serves undercooked chicken.',
            byRole: 'ADMIN',
          },
        ],
      });
    });

    it('is out of their reach when it is the name of an ingredient too', async () => {
      const draft = await anIngredientNameDraft(t);
      await admin
        .review('ingredient-names', draft.id, 'reject', 'pl', 'Not what it is called.')
        .expect(201);

      const attempts = [
        await asReviewer.name(draft.id),
        await asReviewer.editName(draft.id, { name: 'Inna' }),
        await asReviewer.review('ingredient-names', draft.id, 'approve'),
      ];

      expect(attempts.map((res) => [res.status, res.body.error])).toEqual(
        Array(3).fill([409, 'DRAFT_REJECTED']),
      );
    });

    it("can be reopened by the administrator's own edit, and what was decided stays on record", async () => {
      const draft = await aRecipeDraft(t);
      await admin
        .review('recipes', draft.id, 'reject', 'en', 'Serves undercooked chicken.')
        .expect(201);

      const reopened = await admin
        .edit(draft.id, { steps: { en: ['Cook it through.'] } })
        .expect(200);

      expect(reopened.body).toMatchObject({ status: 'PENDING', localeReviews: [] });
      expect(reopened.body.pastReviews).toEqual([
        expect.objectContaining({
          action: 'REJECT',
          reason: 'Serves undercooked chicken.',
          byRole: 'ADMIN',
        }),
      ]);
      await asReviewer.recipe(draft.id).expect(200);
    });
  });

  describe('rejecting several recipe drafts at once', () => {
    const reject = (body: Record<string, unknown>) =>
      t.http().post('/api/admin/drafts/recipes/reject').set(asAdmin).send(body);

    it('rejects each as a single rejection would, with the one reason, and names what it left out', async () => {
      const first = await aRecipeDraft(t, { source: 'AI_USER' });
      const second = await aRecipeDraft(t, { source: 'AI_USER', status: 'APPROVED' });
      const shipped = await aRecipeDraft(t, { status: 'SHIPPED' });
      const gone = '00000000-0000-4000-8000-000000000000';

      const res = await reject({
        ids: [first.id, second.id, shipped.id, gone, first.id],
        reviewedByLabel: 'Pavlo',
        reason: 'Not for the shared library.',
      }).expect(200);

      expect(res.body).toEqual({
        rejected: [first.id, second.id],
        skipped: [
          { id: shipped.id, error: 'DRAFT_SHIPPED' },
          { id: gone, error: 'DRAFT_NOT_FOUND' },
        ],
      });
      expect((await recipeRow(first.id)).status).toBe('REJECTED');
      expect((await recipeRow(second.id)).status).toBe('REJECTED');
      expect((await recipeRow(shipped.id)).status).toBe('SHIPPED');
      expect(await reviewsOf(first.id)).toEqual([
        expect.objectContaining({
          locale: 'en',
          action: 'REJECT',
          byRole: 'ADMIN',
          reviewedByLabel: 'Pavlo',
          reason: 'Not for the shared library.',
          supersededAt: null,
        }),
      ]);
    });

    it('wants between one and a hundred drafts, and a name for who rejects', async () => {
      const draft = await aRecipeDraft(t);
      const tooMany = Array.from(
        { length: 101 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );

      for (const body of [
        { ids: [], reviewedByLabel: 'Pavlo' },
        { ids: tooMany, reviewedByLabel: 'Pavlo' },
        { ids: [draft.id] },
        { ids: ['not-an-id'], reviewedByLabel: 'Pavlo' },
      ]) {
        const res = await reject(body);
        expect([res.status, res.body.error]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect((await recipeRow(draft.id)).status).toBe('PENDING');
    });

    it("is the administrator's: a reviewer has no such route", async () => {
      const draft = await aRecipeDraft(t);

      const res = await t
        .http()
        .post('/api/review/drafts/recipes/reject')
        .set(reviewer)
        .send({ ids: [draft.id], reviewedByLabel: 'Anna' });

      expect(res.status).toBe(404);
      expect((await recipeRow(draft.id)).status).toBe('PENDING');
    });
  });

  describe('rejecting several drafts of names at once', () => {
    const reject = (body: Record<string, unknown>) =>
      t.http().post('/api/admin/drafts/ingredient-names/reject').set(asAdmin).send(body);
    const nameRow = (id: string) =>
      t.prisma.ingredientNameDraft.findUniqueOrThrow({
        where: { id },
        include: { localeReviews: true },
      });

    it('rejects each in its first language, with the one reason, and names what it left out', async () => {
      const polish = await anIngredientNameDraft(t);
      const both = await anIngredientNameDraft(t, {
        ingredientSlug: 'salmon',
        suggestions: { name: { en: 'Salmon', pl: 'Łosoś' } },
        locales: ['en', 'pl'],
        status: 'APPROVED',
      });
      const shipped = await anIngredientNameDraft(t, {
        ingredientSlug: 'firm-tofu',
        status: 'SHIPPED',
      });
      const gone = '00000000-0000-4000-8000-000000000000';

      const res = await reject({
        ids: [polish.id, both.id, shipped.id, gone],
        reviewedByLabel: 'Pavlo',
        reason: 'Write them again.',
      }).expect(200);

      expect(res.body).toEqual({
        rejected: [polish.id, both.id],
        skipped: [
          { id: shipped.id, error: 'DRAFT_SHIPPED' },
          { id: gone, error: 'DRAFT_NOT_FOUND' },
        ],
      });
      for (const [draft, locale] of [
        [polish, 'pl'],
        [both, 'en'],
      ] as const) {
        const row = await nameRow(draft.id);
        expect(row.status).toBe('REJECTED');
        expect(row.localeReviews).toEqual([
          expect.objectContaining({
            locale,
            action: 'REJECT',
            byRole: 'ADMIN',
            reviewedByLabel: 'Pavlo',
            reason: 'Write them again.',
          }),
        ]);
      }
      expect((await nameRow(shipped.id)).status).toBe('SHIPPED');
    });

    it("is the administrator's: a reviewer has no such route", async () => {
      const draft = await anIngredientNameDraft(t);

      const res = await t
        .http()
        .post('/api/review/drafts/ingredient-names/reject')
        .set(reviewer)
        .send({ ids: [draft.id], reviewedByLabel: 'Anna' });

      expect(res.status).toBe(404);
      expect((await nameRow(draft.id)).status).toBe('PENDING');
    });
  });

  describe('the lists', () => {
    it('take a status, a batch and a complexity, each checked', async () => {
      await aRecipeDraft(t);
      await aRecipeDraft(t, { status: 'APPROVED', batchId: 'another-batch', complexity: 'medium' });

      const list = (query: string) =>
        t.http().get(`/api/admin/drafts/recipes${query}`).set(asAdmin);

      expect((await list('').expect(200)).body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect((await list('?status=APPROVED').expect(200)).body.total).toBe(1);
      expect((await list('?batchId=another-batch&complexity=medium').expect(200)).body.total).toBe(
        1,
      );
      expect((await list('?page=2&pageSize=1').expect(200)).body).toMatchObject({
        total: 2,
        page: 2,
        pageSize: 1,
        items: [expect.anything()],
      });
    });

    it('of recipes take where a draft came from: those users sent can be seen apart', async () => {
      await aRecipeDraft(t);
      const fromUsers = await aRecipeDraft(t, { source: 'AI_USER' });

      const list = (query: string) =>
        t.http().get(`/api/admin/drafts/recipes${query}`).set(asAdmin);

      expect(
        (await list('?source=AI_USER').expect(200)).body.items.map(
          (draft: { id: string }) => draft.id,
        ),
      ).toEqual([fromUsers.id]);
      expect((await list('?source=AI').expect(200)).body.total).toBe(1);
      expect((await list('').expect(200)).body.total).toBe(2);
    });

    it.each([
      '?status=pending',
      '?status=FOO',
      '?batchId=a&batchId=b',
      '?complexity=hardest',
      '?source=users',
      '?page=0',
      '?pageSize=1000',
      '?page=one',
    ])('answer %s with what is wrong, not with a failure of the server', async (query) => {
      const recipes = await t.http().get(`/api/admin/drafts/recipes${query}`).set(asAdmin);
      expect([recipes.status, recipes.body.error]).toEqual([400, 'VALIDATION_FAILED']);

      if (!query.includes('complexity') && !query.includes('source')) {
        const names = await t.http().get(`/api/admin/drafts/ingredient-names${query}`).set(asAdmin);
        expect([names.status, names.body.error]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });

    it('show a reviewer what waits for their language, and want to know which language that is', async () => {
      const waiting = await aRecipeDraft(t);
      await aRecipeDraft(t, { status: 'REJECTED' });
      await aRecipeDraft(t, { status: 'SHIPPED' });
      const done = await aRecipeDraft(t);
      await asReviewer.review('recipes', done.id, 'approve').expect(201);

      const list = (query: string) =>
        t.http().get(`/api/review/drafts/recipes${query}`).set(reviewer);

      expect(
        (await list('?locale=pl').expect(200)).body.items.map((item: { id: string }) => item.id),
      ).toEqual([waiting.id]);
      expect((await list('?locale=pl&includeReviewed=true').expect(200)).body.total).toBe(2);
      for (const query of [
        '',
        '?locale=en',
        '?locale=xx',
        '?locale=pl&page=0',
        '?locale=pl&pageSize=500',
      ]) {
        expect((await list(query)).status).toBe(400);
      }
    });
  });

  describe('a run that writes names for ingredients', () => {
    it('is not started for English: nobody could approve what it wrote', async () => {
      const refused = await t
        .http()
        .post('/api/admin/drafts/ingredient-names/generate')
        .set(asAdmin)
        .send({ scope: 'all-usda-missing', targetLocales: ['en', 'pl'] });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('VALIDATION_FAILED');
    });

    const start = (spec: Record<string, unknown>) =>
      t
        .http()
        .post('/api/admin/drafts/ingredient-names/generate')
        .set(asAdmin)
        .send({ targetLocales: ['pl'], ...spec })
        .expect(202);
    /** The state of the run once it has ended. */
    const ended = async () => {
      for (let waited = 0; waited < 200; waited += 1) {
        const state = (
          await t
            .http()
            .get('/api/admin/drafts/ingredient-names/generate/status')
            .set(asAdmin)
            .expect(200)
        ).body;
        if (state.status !== 'running') return state;
        await new Promise((tick) => setTimeout(tick, 25));
      }
      throw new Error('the run did not end');
    };
    const imported = (slug: string, tags: string[]) =>
      t.prisma.ingredient.update({ where: { slug }, data: { tags } });

    describe('that asks a model', () => {
      /** Started on the runner itself: the route lets five runs a minute be asked for, and its own tests need them. */
      const run = async () => {
        expect(
          await t.app
            .get(IngredientNamerRunner)
            .start({ scope: 'all-usda-missing', targetLocales: ['pl'] }),
        ).toBe(true);
        return ended();
      };

      beforeEach(async () => {
        t.model.reset();
        await imported('banana', ['usda-imported']);
        await imported('salmon', ['usda-imported']);
      });

      afterEach(async () => {
        await imported('banana', []);
        await imported('salmon', []);
      });

      it('judges each name by itself: what passes is written, and only what was refused is asked for again, with the reason', async () => {
        // The first answer names the banana, and gives the salmon a figure its description does not hold.
        t.model.reply({
          text: JSON.stringify({
            banana: { name: { pl: 'Banan' } },
            salmon: { name: { pl: 'Łosoś 300 kcal' } },
          }),
        });
        t.model.reply({ text: JSON.stringify({ salmon: { name: { pl: 'Łosoś' } } }) });

        const state = await run();

        expect(state).toMatchObject({
          status: 'done',
          error: null,
          total: 2,
          written: 2,
          failed: 0,
        });
        const written = await t.prisma.ingredientNameDraft.findMany({
          orderBy: { ingredientSlug: 'asc' },
          select: { ingredientSlug: true, suggestions: true },
        });
        expect(written).toEqual([
          { ingredientSlug: 'banana', suggestions: { name: { pl: 'Banan' } } },
          { ingredientSlug: 'salmon', suggestions: { name: { pl: 'Łosoś' } } },
        ]);
        expect(t.model.requests).toHaveLength(2);
        const again = t.model.requests[1]!.prompt;
        expect(again).toContain('invented-digits at "salmon.name.pl"');
        expect(again.slice(again.indexOf('Rewrite this object:'))).not.toContain('banana');
      });

      it('writes the names that passed when one is refused every time, and counts that one as failed', async () => {
        t.model.reply({
          text: JSON.stringify({
            banana: { name: { pl: 'Banan' } },
            salmon: { name: { pl: 'Łosoś 300 kcal' } },
          }),
        });
        t.model.reply({
          text: JSON.stringify({ salmon: { name: { pl: 'Łosoś 300 kcal' } } }),
          times: 2,
        });

        const state = await run();

        expect(state).toMatchObject({ status: 'done', total: 2, written: 1, failed: 1 });
        expect(
          (await t.prisma.ingredientNameDraft.findMany({ select: { ingredientSlug: true } })).map(
            (draft) => draft.ingredientSlug,
          ),
        ).toEqual(['banana']);
        expect(t.model.requests).toHaveLength(3);
      });
    });

    describe('that writes names again', () => {
      const regenerate = (body: Record<string, unknown>) =>
        t
          .http()
          .post('/api/admin/drafts/ingredient-names/regenerate')
          .set(asAdmin)
          .send({ reviewedByLabel: 'Pavlo', ...body });
      /** Started on the runner itself: the routes let five runs a minute be asked for. */
      const begin = async (spec: IngredientNamerStartSpec) => {
        expect(
          await t.app.get(IngredientNamerRunner).start({ targetLocales: ['pl'], ...spec }),
        ).toBe(true);
      };
      const replacing = (spec: { ids?: string[]; reason?: string } = {}) =>
        begin({ scope: 'replacing', by: { role: 'ADMIN', label: 'Pavlo' }, ...spec });
      const overview = async () =>
        (await t.http().get('/api/admin/drafts/overview').set(asAdmin).expect(200)).body;
      /** A draft that stands as written: created now, by the run that named it. */
      const named = (slug: string, name: string, overrides: Record<string, unknown> = {}) =>
        anIngredientNameDraft(t, {
          ingredientSlug: slug,
          suggestions: { name: { pl: name } },
          generatorPrompt: 'ingredient-namer.v1',
          ...overrides,
        });
      const draftsOf = (slug: string) =>
        t.prisma.ingredientNameDraft.findMany({
          where: { ingredientSlug: slug },
          orderBy: { createdAt: 'asc' },
          include: { localeReviews: true },
        });
      const lastPrompt = () => t.model.requests.at(-1)!.prompt;

      beforeEach(async () => {
        t.model.reset();
        await imported('banana', ['usda-imported']);
        await imported('salmon', ['usda-imported']);
      });

      afterEach(async () => {
        await imported('banana', []);
        await imported('salmon', []);
      });

      it('counts what each way of writing takes on, and each ingredient under one of them', async () => {
        await anIngredientNameDraft(t, { ingredientSlug: 'kale', status: 'PENDING' });

        expect((await overview()).names).toEqual({
          missing: 2,
          rejected: 0,
          pending: 1,
          // A draft of an ingredient that is no imported one: no run can name it.
          unapproved: 0,
          approved: 0,
        });

        const rejected = await named('banana', 'Owoc');
        await admin.review('ingredient-names', rejected.id, 'reject', 'pl').expect(201);
        await named('salmon', 'Łosoś');

        expect((await overview()).names).toEqual({
          missing: 0,
          rejected: 1,
          pending: 2,
          unapproved: 1,
          approved: 0,
        });
      });

      it('leaves a rejected name to its own way of writing: the missing ones do not take it', async () => {
        const old = await named('banana', 'Owoc');
        await admin.review('ingredient-names', old.id, 'reject', 'pl').expect(201);
        t.model.reply({ text: JSON.stringify({ salmon: { name: { pl: 'Łosoś' } } }) });

        await begin({ scope: 'all-usda-missing' });

        expect(await ended()).toMatchObject({ status: 'done', total: 1, written: 1, skipped: 1 });
        expect(await draftsOf('banana')).toHaveLength(1);
      });

      it('tells the model the name refused and why, refuses it given again, and keeps the old one as history', async () => {
        const old = await named('banana', 'Owoc');
        await admin.review('ingredient-names', old.id, 'reject', 'pl', 'Zbyt ogólna').expect(201);
        // The first answer gives the refused name once more, in other letters.
        t.model.reply({ text: JSON.stringify({ banana: { name: { pl: 'OWOC ' } } }) });
        t.model.reply({ text: JSON.stringify({ banana: { name: { pl: 'Banan' } } }) });

        await begin({ scope: 'rejected' });

        expect(await ended()).toMatchObject({ status: 'done', total: 1, written: 1, failed: 0 });
        expect(t.model.requests).toHaveLength(2);
        expect(t.model.requests[0]!.prompt).toContain(
          '{"banana":[{"name":{"pl":"Owoc"},"reason":"Zbyt ogólna"}]}',
        );
        expect(lastPrompt()).toContain('repeats-refused at "banana.name.pl"');
        const [first, second] = await draftsOf('banana');
        expect(first!.status).toBe('REJECTED');
        expect(second).toMatchObject({ status: 'PENDING', suggestions: { name: { pl: 'Banan' } } });
      });

      it('shows a rejected draft with a newer proposal as replaced, and does not let it be taken up again', async () => {
        const old = await named('banana', 'Owoc');
        await admin.review('ingredient-names', old.id, 'reject', 'pl').expect(201);
        const open = await admin.name(old.id).expect(200);
        expect(open.body.replaced).toBe(false);

        t.model.reply({ text: JSON.stringify({ banana: { name: { pl: 'Banan' } } }) });
        await begin({ scope: 'rejected' });
        await ended();

        const list = await t
          .http()
          .get('/api/admin/drafts/ingredient-names?status=REJECTED')
          .set(asAdmin)
          .expect(200);
        expect(list.body.items).toMatchObject([{ id: old.id, replaced: true }]);
        expect((await admin.name(old.id).expect(200)).body.replaced).toBe(true);
        expect(
          (await admin.review('ingredient-names', old.id, 'approve', 'pl').expect(409)).body.error,
        ).toBe('DRAFT_REPLACED');
        expect(
          (await admin.editName(old.id, { name: { pl: 'Bananowiec' } }).expect(409)).body.error,
        ).toBe('DRAFT_REPLACED');
        expect((await overview()).names).toMatchObject({ rejected: 0, pending: 1 });
      });

      it('lets a rejected draft nothing replaced be taken up again, as before', async () => {
        const old = await named('banana', 'Owoc');
        await admin.review('ingredient-names', old.id, 'reject', 'pl').expect(201);

        await admin.review('ingredient-names', old.id, 'approve', 'pl').expect(201);

        expect((await admin.name(old.id).expect(200)).body.status).toBe('APPROVED');
      });

      it('writes every unapproved name anew, under the name given, and leaves what a person touched', async () => {
        const plain = await named('banana', 'Owoc');
        const edited = await named('salmon', 'Ryba');
        await admin.editName(edited.id, { name: { pl: 'Łosoś atlantycki' } }).expect(200);
        t.model.reply({ text: JSON.stringify({ banana: { name: { pl: 'Banan' } } }) });

        const started = await regenerate({ scope: 'unapproved', reason: 'Lepiej po polsku' });

        expect(started.status).toBe(202);
        expect(await ended()).toMatchObject({ status: 'done', total: 1, written: 1, note: null });
        expect(t.model.requests[0]!.prompt).toContain(
          '{"banana":[{"name":{"pl":"Owoc"},"reason":"Lepiej po polsku"}]}',
        );
        const [old, fresh] = await draftsOf('banana');
        expect(old).toMatchObject({ id: plain.id, status: 'REJECTED' });
        expect(old!.localeReviews).toMatchObject([
          {
            locale: 'pl',
            action: 'REJECT',
            byRole: 'ADMIN',
            reviewedByLabel: 'Pavlo',
            reason: 'Lepiej po polsku',
          },
        ]);
        expect(fresh).toMatchObject({
          status: 'PENDING',
          editedAt: null,
          suggestions: { name: { pl: 'Banan' } },
        });
        const salmon = await draftsOf('salmon');
        expect(salmon).toHaveLength(1);
        expect(salmon[0]).toMatchObject({
          status: 'PENDING',
          suggestions: { name: { pl: 'Łosoś atlantycki' } },
        });
      });

      it('counts an edit by the administrator and by a reviewer as a change by hand', async () => {
        const byAdmin = await named('banana', 'Owoc');
        const byReviewer = await named('salmon', 'Ryba');
        await admin.editName(byAdmin.id, { name: { pl: 'Banan' } }).expect(200);
        await asReviewer.editName(byReviewer.id, { name: 'Łosoś' }).expect(200);

        expect((await admin.name(byAdmin.id).expect(200)).body.edited).toBe(true);
        expect((await admin.name(byReviewer.id).expect(200)).body.edited).toBe(true);
        expect((await overview()).names).toMatchObject({ pending: 2, unapproved: 0 });
      });

      it('writes a draft changed by hand anew when it is named, and says of one that no longer waits', async () => {
        const edited = await named('banana', 'Owoc');
        await admin.editName(edited.id, { name: { pl: 'Owoc żółty' } }).expect(200);
        const approved = await named('salmon', 'Łosoś');
        await admin.review('ingredient-names', approved.id, 'approve', 'pl').expect(201);
        t.model.reply({ text: JSON.stringify({ banana: { name: { pl: 'Banan' } } }) });

        await replacing({ ids: [edited.id, approved.id] });

        expect(await ended()).toMatchObject({
          total: 1,
          written: 1,
          skipped: 1,
          note: 'left-as-they-are',
        });
        expect(t.model.requests[0]!.prompt).not.toContain('salmon');
        expect((await draftsOf('banana')).map((draft) => draft.status)).toEqual([
          'REJECTED',
          'PENDING',
        ]);
        expect((await draftsOf('salmon')).map((draft) => draft.status)).toEqual(['APPROVED']);
      });

      it('leaves the old proposal waiting when the model cannot give a new name', async () => {
        const old = await named('banana', 'Owoc');
        t.model.reply({ text: JSON.stringify({ banana: { name: { pl: 'Owoc' } } }), times: 3 });

        await replacing();

        expect(await ended()).toMatchObject({ status: 'done', written: 0, failed: 1 });
        const drafts = await draftsOf('banana');
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ id: old.id, status: 'PENDING' });
        expect(drafts[0]!.localeReviews).toEqual([]);
      });

      it('leaves a draft a person changed after the run took it on', async () => {
        const old = await named('banana', 'Owoc');
        const service = t.app.get(DraftService);
        await admin.editName(old.id, { name: { pl: 'Banan' } }).expect(200);

        const written = await service.replaceIngredientName(
          old.id,
          // As it stood when the run read it, before the edit.
          old.updatedAt,
          {
            ingredientSlug: 'banana',
            rawDescription: 'Bananas, raw',
            suggestions: { name: { pl: 'Inny' } },
            locales: ['pl'],
            batchId: 'run',
          },
          undefined,
          { role: 'ADMIN', label: 'Pavlo' },
        );

        expect(written).toBeNull();
        expect(await draftsOf('banana')).toMatchObject([
          { id: old.id, status: 'PENDING', suggestions: { name: { pl: 'Banan' } } },
        ]);
      });

      it('gets no second proposal beside one that waits, also when it is named', async () => {
        await named('banana', 'Banan');

        await begin({ scope: 'specific-slugs', slugs: ['banana'] });

        expect(await ended()).toMatchObject({
          status: 'done',
          total: 0,
          skipped: 1,
          note: 'all-have-drafts',
        });
        expect(t.model.requests).toEqual([]);
      });

      it('takes a shipped name when it is named: that is how one gets a better one', async () => {
        await named('banana', 'Owoc', { status: 'SHIPPED' });
        t.model.reply({ text: JSON.stringify({ banana: { name: { pl: 'Banan' } } }) });

        await begin({ scope: 'specific-slugs', slugs: ['banana'] });

        expect(await ended()).toMatchObject({ status: 'done', written: 1 });
      });

      it('says there is nothing to write again', async () => {
        await replacing();
        expect(await ended()).toMatchObject({ total: 0, note: 'nothing-to-write-again' });

        await begin({ scope: 'rejected' });
        expect(await ended()).toMatchObject({ total: 0, note: 'nothing-to-write-again' });
        expect(t.model.requests).toEqual([]);
      });

      it('is not started beside a run that is going, and changes nothing', async () => {
        const old = await named('banana', 'Owoc');
        t.model.reply({
          text: JSON.stringify({ banana: { name: { pl: 'Banan' } } }),
          delayMs: 200,
        });
        await regenerate({ scope: 'unapproved' }).expect(202);

        const second = await regenerate({ scope: 'named', ids: [old.id] }).expect(409);

        expect(second.body.error).toBe('NAMER_IN_PROGRESS');
        await ended();
      });

      it('wants the drafts named when it is asked for named ones', async () => {
        expect((await regenerate({ scope: 'named' }).expect(400)).body.error).toBe(
          'VALIDATION_FAILED',
        );
      });

      it("is the administrator's alone: a reviewer starts no run", async () => {
        await t
          .http()
          .post('/api/admin/drafts/ingredient-names/regenerate')
          .set(reviewer)
          .send({ reviewedByLabel: 'Anna', scope: 'unapproved' })
          .expect(401);
        await t
          .http()
          .post('/api/admin/drafts/ingredient-names/generate')
          .set(reviewer)
          .send({ scope: 'rejected' })
          .expect(401);
        expect(t.model.requests).toEqual([]);
      });
    });

    describe('that has nothing to do', () => {
      it('says so when the catalogue has no imported ingredient to name', async () => {
        await start({ scope: 'all-usda-missing' });

        expect(await ended()).toMatchObject({
          status: 'done',
          error: null,
          total: 0,
          written: 0,
          skipped: 0,
          note: 'nothing-imported',
        });
      });

      it('says that the ingredients it was given are not imported ones, and how many it left out', async () => {
        await start({ scope: 'specific-slugs', slugs: ['banana', 'salmon', 'no-such-ingredient'] });

        expect(await ended()).toMatchObject({
          status: 'done',
          error: null,
          total: 0,
          skipped: 3,
          note: 'not-imported',
        });
      });

      it('says that every imported ingredient has a draft already', async () => {
        await imported('salmon', ['usda-imported']);
        await anIngredientNameDraft(t, {
          ingredientSlug: 'salmon',
          generatorPrompt: 'ingredient-namer.v1',
        });

        await start({ scope: 'all-usda-missing' });
        const state = await ended();
        await imported('salmon', []);

        expect(state).toMatchObject({
          status: 'done',
          error: null,
          total: 0,
          skipped: 1,
          note: 'all-have-drafts',
        });
      });
    });
  });
});
