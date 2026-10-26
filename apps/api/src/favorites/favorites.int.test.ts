// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MarkedRecipe, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the recipes a profile marked', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  const idOf = async (slug: string): Promise<string> =>
    (await t.prisma.recipe.findUniqueOrThrow({ where: { slug } })).id;
  const mark = async (slug: string, body: { sentiment?: string; tags?: string[] } = {}) =>
    t
      .http()
      .post('/api/favorites')
      .set(as(user))
      .send({ profileId: profile.id, recipeId: await idOf(slug), ...body })
      .expect(201);
  const list = async (query: Record<string, string> = {}): Promise<MarkedRecipe[]> =>
    (
      await t
        .http()
        .get('/api/favorites')
        .query({ profileId: profile.id, ...query })
        .set(as(user))
        .expect(200)
    ).body as MarkedRecipe[];
  const titles = (marks: MarkedRecipe[]): string[] => marks.map((marked) => marked.recipe.title);

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
    // One after another, so that the order they were marked in is theirs to keep.
    await mark('tofu-rice-bowl', { sentiment: 'often', tags: ['quick', 'work'] });
    await mark('milk-porridge', { tags: ['quick'] });
    await mark('egg-sandwich', { sentiment: 'avoid' });
    await mark('chickpea-tomato-stew', { tags: ['work'] });
  });

  it('are listed with how each was marked, the mark made last first', async () => {
    const marks = await list();

    expect(titles(marks)).toEqual([
      'Chickpea tomato stew',
      'Egg sandwich',
      'Milk porridge',
      'Tofu rice bowl',
    ]);
    expect(marks[3]).toMatchObject({ sentiment: 'often', tags: ['quick', 'work'] });
    expect(marks[1]).toMatchObject({ sentiment: 'avoid', tags: [] });
    expect(Date.parse(marks[0]!.markedAt)).toBeGreaterThanOrEqual(Date.parse(marks[3]!.markedAt));
  });

  it('are narrowed by how they are marked, by a tag, by a meal and by words, each alone and together', async () => {
    expect(titles(await list({ sentiment: 'often' }))).toEqual(['Tofu rice bowl']);
    expect(titles(await list({ sentiment: 'avoid' }))).toEqual(['Egg sandwich']);
    expect(titles(await list({ sentiment: 'favorite' }))).toEqual([
      'Chickpea tomato stew',
      'Milk porridge',
    ]);
    expect(titles(await list({ tag: 'quick' }))).toEqual(['Milk porridge', 'Tofu rice bowl']);
    expect(titles(await list({ tag: 'work', mealType: 'dinner' }))).toEqual([
      'Chickpea tomato stew',
      'Tofu rice bowl',
    ]);
    expect(titles(await list({ tag: 'work', search: 'stew' }))).toEqual(['Chickpea tomato stew']);
    expect(await list({ tag: 'holiday' })).toEqual([]);
  });

  it('are put in the order asked for: by title, or the lightest serving first', async () => {
    expect(titles(await list({ sort: 'title' }))).toEqual([
      'Chickpea tomato stew',
      'Egg sandwich',
      'Milk porridge',
      'Tofu rice bowl',
    ]);

    const byCalories = await list({ sort: 'calories' });
    const calories = byCalories.map((marked) => marked.recipe.nutritionPerServing.calories);
    expect(calories).toEqual([...calories].sort((a, b) => a - b));
    expect(new Set(titles(byCalories))).toEqual(
      new Set(['Chickpea tomato stew', 'Egg sandwich', 'Milk porridge', 'Tofu rice bowl']),
    );
  });

  it('are marked anew by marking again: what was said before gives place', async () => {
    await mark('milk-porridge', { sentiment: 'often', tags: ['weekend'] });

    const porridge = (await list()).find((marked) => marked.recipe.title === 'Milk porridge')!;
    expect(porridge).toMatchObject({ sentiment: 'often', tags: ['weekend'] });
    expect(await t.prisma.favorite.count({ where: { profileId: profile.id } })).toBe(4);
  });

  it.each([
    ['a way of marking there is not', { sentiment: 'loved' }, 'sentiment'],
    ['an order there is not', { sort: 'random' }, 'sort'],
    ['a tag of nothing', { tag: ' ' }, 'tag'],
  ])('are not listed by %s', async (_what, query, part) => {
    const refused = await t
      .http()
      .get('/api/favorites')
      .query({ profileId: profile.id, ...query })
      .set(as(user))
      .expect(400);

    expect(refused.body.error).toBe('VALIDATION_FAILED');
    expect(refused.body.issues[0].path).toBe(part);
  });
});
