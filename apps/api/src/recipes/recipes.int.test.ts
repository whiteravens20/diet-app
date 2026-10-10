// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Recipe, RecipeSearchPage } from '@diet-app/shared';
import { RECIPES, seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPrivateRecipe, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('who can see a recipe', () => {
  let t: TestApp;
  let owner: TestUser;
  let other: TestUser;
  let mine: { id: string; title: string };

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
    await t.prisma.recipe.updateMany({ data: { retiredAt: null } });
    owner = await aUser(t);
    other = await aUser(t);
    mine = await aPrivateRecipe(t, owner, { title: 'Owner only risotto' });
  });

  const search = async (user: TestUser, query: Record<string, string> = {}): Promise<RecipeSearchPage> =>
    (await t.http().get('/api/recipes').query({ pageSize: '100', ...query }).set(as(user)).expect(200)).body as RecipeSearchPage;

  const listMine = async (user: TestUser): Promise<RecipeSearchPage> =>
    (await t.http().get('/api/recipes/mine').set(as(user)).expect(200)).body as RecipeSearchPage;

  it('needs a signed-in user', async () => {
    await t.http().get('/api/recipes').expect(401);
    await t.http().get(`/api/recipes/${mine.id}`).expect(401);
  });

  describe('in the library', () => {
    it('shows everyone the shared recipes and each user their own on top', async () => {
      const forOwner = await search(owner);
      const forOther = await search(other);

      expect(forOther.total).toBe(RECIPES.length);
      expect(forOwner.total).toBe(RECIPES.length + 1);
      expect(forOwner.items.map((r) => r.id)).toContain(mine.id);
      expect(forOther.items.map((r) => r.id)).not.toContain(mine.id);
    });

    it("does not find another user's recipe by its title", async () => {
      expect((await search(owner, { search: 'Owner only' })).items.map((r) => r.id)).toEqual([mine.id]);
      expect((await search(other, { search: 'Owner only' })).total).toBe(0);
    });

    it('leaves out a recipe that was retired from the shared data', async () => {
      const retired = await t.prisma.recipe.findFirstOrThrow({ where: { slug: RECIPES[0]!.slug } });
      await t.prisma.recipe.update({ where: { id: retired.id }, data: { retiredAt: new Date() } });

      const page = await search(other);

      expect(page.total).toBe(RECIPES.length - 1);
      expect(page.items.map((r) => r.id)).not.toContain(retired.id);
    });

    it('narrows by meal, diet and calories, and pages the result', async () => {
      const breakfasts = await search(other, { mealType: 'breakfast' });
      expect(breakfasts.total).toBeGreaterThan(0);
      expect(breakfasts.items.every((r) => r.mealTypes.includes('breakfast'))).toBe(true);

      const vegan = await search(other, { dietType: 'vegan' });
      expect(vegan.total).toBeGreaterThan(0);
      expect(vegan.total).toBeLessThan(RECIPES.length);
      expect(vegan.items.every((r) => r.dietTags.includes('vegan'))).toBe(true);

      const light = await search(other, { maxCalories: '300' });
      expect(light.items.every((r) => r.nutritionPerServing.calories <= 300)).toBe(true);

      const firstPage = await search(other, { pageSize: '5' });
      expect(firstPage).toMatchObject({ page: 1, pageSize: 5, total: RECIPES.length, totalPages: Math.ceil(RECIPES.length / 5) });
      expect(firstPage.items).toHaveLength(5);
      const secondPage = await search(other, { pageSize: '5', page: '2' });
      expect(secondPage.items.map((r) => r.id)).not.toEqual(firstPage.items.map((r) => r.id));
    });
  });

  describe('by its id', () => {
    it('opens for its owner and looks like nothing at all to anyone else', async () => {
      const opened = (await t.http().get(`/api/recipes/${mine.id}`).set(as(owner)).expect(200)).body as Recipe;
      expect(opened.title).toBe('Owner only risotto');
      expect(opened.ingredients).toHaveLength(1);

      const hidden = await t.http().get(`/api/recipes/${mine.id}`).set(as(other)).expect(404);
      const unknown = await t.http().get('/api/recipes/00000000-0000-4000-8000-000000000000').set(as(other)).expect(404);
      // The same answer as for an id that does not exist: no way to tell them apart.
      expect(hidden.body).toEqual(unknown.body);
    });

    it('opens a shared recipe for everyone', async () => {
      const shared = await t.prisma.recipe.findFirstOrThrow({ where: { slug: RECIPES[0]!.slug } });
      await t.http().get(`/api/recipes/${shared.id}`).set(as(other)).expect(200);
    });
  });

  describe('among my recipes', () => {
    it("lists a user's own recipes and nobody else's", async () => {
      expect((await listMine(owner)).items.map((r) => r.id)).toEqual([mine.id]);
      expect((await listMine(other)).total).toBe(0);
    });
  });

  describe('deleting', () => {
    it("is refused for another user's recipe, which stays where it was", async () => {
      const refused = await t.http().delete(`/api/recipes/${mine.id}`).set(as(other));

      expect([403, 404]).toContain(refused.status);
      expect((await listMine(owner)).total).toBe(1);
    });

    it('is refused for a shared recipe', async () => {
      const shared = await t.prisma.recipe.findFirstOrThrow({ where: { slug: RECIPES[0]!.slug } });

      const refused = await t.http().delete(`/api/recipes/${shared.id}`).set(as(owner));

      expect([403, 404]).toContain(refused.status);
      expect((await search(other)).total).toBe(RECIPES.length);
    });

    it('hides the recipe from its owner everywhere, and can be repeated', async () => {
      await t.http().delete(`/api/recipes/${mine.id}`).set(as(owner)).expect(204);

      await t.http().get(`/api/recipes/${mine.id}`).set(as(owner)).expect(404);
      expect((await listMine(owner)).total).toBe(0);
      expect((await search(owner)).total).toBe(RECIPES.length);
      // The row is kept, because a plan may still show the meal.
      expect(await t.prisma.recipe.count({ where: { id: mine.id } })).toBe(1);

      await t.http().delete(`/api/recipes/${mine.id}`).set(as(owner)).expect(204);
    });
  });
});
