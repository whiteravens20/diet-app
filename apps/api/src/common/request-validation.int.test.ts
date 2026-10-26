// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a request says wrongly is refused as it comes in, with 400 and the
 * part that is wrong: it is neither passed on to fail somewhere inside (a
 * 500) nor left out as if it had not been said.
 */
import type { Profile } from '@diet-app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase } from '../testing/database.js';
import {
  aProfile,
  aRecipeDraft,
  aReviewer,
  aUser,
  as,
  asAdmin,
  type TestUser,
} from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('a request that says something wrongly', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let recipe: string;
  let reviewer: { Cookie: string; Origin: string };
  let draft: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
    recipe = (await t.prisma.recipe.findFirstOrThrow({ where: { createdByUserId: null } })).id;
    reviewer = await aReviewer(t);
    draft = (await aRecipeDraft(t)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  const refusedAt = (res: {
    status: number;
    body: { error?: string; issues?: { path: string }[] };
  }): string => {
    expect([res.status, res.body.error]).toEqual([400, 'VALIDATION_FAILED']);
    return res.body.issues![0]!.path;
  };

  describe('about weights', () => {
    const list = (query: Record<string, string>) =>
      t
        .http()
        .get('/api/weights')
        .query({ profileId: profile.id, ...query })
        .set(as(user));
    const log = (body: Record<string, unknown>) =>
      t
        .http()
        .post('/api/weights')
        .set(as(user))
        .send({ profileId: profile.id, kg: 80, ...body });

    it('is refused: a moment that is none, to list from', async () => {
      expect(refusedAt(await list({ since: 'last week' }))).toBe('since');
      expect(refusedAt(await list({ since: '2026-01-01' }))).toBe('since');
      await list({ since: '2026-01-01T00:00:00.000Z' }).expect(200);
    });

    it('is refused: a weight taken at a moment still to come, or before the years there are', async () => {
      const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

      expect(refusedAt(await log({ recordedAt: nextWeek }))).toBe('recordedAt');
      expect(refusedAt(await log({ recordedAt: '1900-01-01T00:00:00.000Z' }))).toBe('recordedAt');
      expect(await t.prisma.weightEntry.count()).toBe(0);
    });

    it('is taken: a weight taken an hour ago, or by a clock that runs a few hours ahead', async () => {
      await log({ recordedAt: new Date(Date.now() - 3_600_000).toISOString() }).expect(201);
      await log({ recordedAt: new Date(Date.now() + 5 * 3_600_000).toISOString() }).expect(201);
      await log({}).expect(201);
    });
  });

  describe('about favourites', () => {
    it('is refused: a meal there is not, a search given twice, a mark with tags without end', async () => {
      const list = (query: string) =>
        t.http().get(`/api/favorites?profileId=${profile.id}&${query}`).set(as(user));

      expect(refusedAt(await list('mealType=brunch'))).toBe('mealType');
      expect(refusedAt(await list('search=a&search=b'))).toBe('search');
      const mark = (body: Record<string, unknown>) =>
        t
          .http()
          .post('/api/favorites')
          .set(as(user))
          .send({ profileId: profile.id, recipeId: recipe, ...body });
      expect(
        refusedAt(await mark({ tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`) })),
      ).toBe('tags');
      expect(refusedAt(await mark({ tags: ['x'.repeat(41)] }))).toBe('tags.0');
      expect(refusedAt(await mark({ sentiment: 'adore' }))).toBe('sentiment');
    });

    it('says that a mark is not there when one is taken off that never was, and takes one off once', async () => {
      const off = () => t.http().delete(`/api/favorites/${profile.id}/${recipe}`).set(as(user));

      expect((await off().expect(404)).body.error).toBe('FAVORITE_NOT_FOUND');
      await t
        .http()
        .post('/api/favorites')
        .set(as(user))
        .send({ profileId: profile.id, recipeId: recipe })
        .expect(201);
      await off().expect(204);
      expect((await off().expect(404)).body.error).toBe('FAVORITE_NOT_FOUND');
    });
  });

  describe('about notifications', () => {
    it('answers a notification that was read with no content, however often it is read', async () => {
      const notification = await t.prisma.notification.create({
        data: { profileId: profile.id, type: 'weight_reminder', payload: {} },
      });
      const read = () => t.http().post(`/api/notifications/${notification.id}/read`).set(as(user));

      const first = await read().expect(204);
      expect(first.text).toBe('');
      const readAt = (
        await t.prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })
      ).readAt;
      expect(readAt).not.toBeNull();
      await read().expect(204);
      expect(
        (await t.prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt,
      ).toEqual(readAt);
    });
  });

  describe('about the pantry', () => {
    it('is refused: a best-before day outside the years there are', async () => {
      const rice = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } });
      const put = (bestBefore: string) =>
        t.http().post('/api/inventory').set(as(user)).send({
          profileId: profile.id,
          ingredientId: rice.id,
          quantity: 100,
          unit: 'g',
          bestBefore,
        });

      expect(refusedAt(await put('0000-01-01'))).toBe('bestBefore');
      expect(refusedAt(await put('9999-12-31'))).toBe('bestBefore');
      await put('2027-01-31').expect(201);
    });
  });

  describe("to the administrator's queue and the reviewers'", () => {
    it.each([
      [
        'a review in a language there is not',
        'post',
        (): string => `/api/admin/drafts/recipes/${draft}/approve?locale=xx`,
        { reviewedByLabel: 'Pavlo' },
        'locale',
      ],
      [
        'a review without a language',
        'post',
        (): string => `/api/admin/drafts/recipes/${draft}/approve`,
        { reviewedByLabel: 'Pavlo' },
        'locale',
      ],
      [
        'a review by nobody',
        'post',
        (): string => `/api/admin/drafts/recipes/${draft}/approve?locale=en`,
        {},
        'reviewedByLabel',
      ],
      [
        'a reason of a thousand characters',
        'post',
        (): string => `/api/admin/drafts/recipes/${draft}/reject?locale=en`,
        { reviewedByLabel: 'Pavlo', reason: 'x'.repeat(1000) },
        'reason',
      ],
      [
        'an edit with servings by the million',
        'patch',
        (): string => `/api/admin/drafts/recipes/${draft}`,
        { servings: 1_000_000 },
        'servings',
      ],
      [
        'a dry run that is neither yes nor no',
        'patch',
        (): string => `/api/admin/drafts/recipes/${draft}?dryRun=maybe`,
        { servings: 2 },
        'dryRun',
      ],
      [
        'a shipment of a kind there is not',
        'post',
        (): string => '/api/admin/drafts/ship',
        { kind: 'allergen', mode: 'local' },
        'kind',
      ],
      [
        'a shipment in a way there is not',
        'post',
        (): string => '/api/admin/drafts/ship',
        { kind: 'recipe', mode: 'by-post' },
        'mode',
      ],
      [
        'drafts marked as shipped that are no ids',
        'post',
        (): string => '/api/admin/drafts/ship/mark-shipped',
        { kind: 'recipe', draftIds: ['first'] },
        'draftIds.0',
      ],
      [
        'a run of names for no ingredient',
        'post',
        (): string => '/api/admin/drafts/ingredient-names/generate',
        { scope: 'specific-slugs', slugs: [] },
        'slugs',
      ],
      [
        'a run of a thousand recipes',
        'post',
        (): string => '/api/admin/drafts/recipes/generate',
        { count: 1000 },
        'count',
      ],
      [
        'a draft that is named by no id',
        'get',
        (): string => '/api/admin/drafts/recipes/first',
        undefined,
        'id',
      ],
      [
        'an import of a data set there is not',
        'post',
        (): string => '/api/admin/db/import-usda?dataTypes=Branded',
        undefined,
        'dataTypes.0',
      ],
    ] as const)('refuses the administrator %s', async (_name, method, path, body, part) => {
      const request = t.http()[method](path()).set(asAdmin);

      expect(refusedAt(await (body ? request.send(body) : request))).toBe(part);
    });

    it.each([
      [
        'a draft in English, which is not theirs to review',
        'get',
        (): string => `/api/review/drafts/recipes/${draft}?locale=en`,
        undefined,
        'locale',
      ],
      [
        'a draft without a language',
        'get',
        (): string => `/api/review/drafts/recipes/${draft}`,
        undefined,
        'locale',
      ],
      [
        'an edit with a part there is not',
        'patch',
        (): string => `/api/review/drafts/recipes/${draft}?locale=pl`,
        { servings: 2 },
        '',
      ],
      [
        'a rejection with a reason of a thousand characters',
        'post',
        (): string => `/api/review/drafts/recipes/${draft}/reject?locale=pl`,
        { reason: 'x'.repeat(1000) },
        'reason',
      ],
      [
        'a draft that is named by no id',
        'get',
        (): string => '/api/review/drafts/recipes/first?locale=pl',
        undefined,
        'id',
      ],
    ] as const)('refuses a reviewer %s', async (_name, method, path, body, part) => {
      const request = t.http()[method](path()).set(reviewer);

      expect(refusedAt(await (body ? request.send(body) : request))).toBe(part);
    });

    it("refuses a reviewer's sign-in that names nobody", async () => {
      const res = await t
        .http()
        .post('/api/review/auth')
        .set('Origin', 'http://localhost:3000')
        .send({ password: 'Reviewers-Passw0rd' });

      expect(refusedAt(res)).toBe('label');
    });
  });
});
