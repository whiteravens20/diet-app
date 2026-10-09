// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { catalogueDirectory, seedCatalogue } from '../../testing/catalogue.js';
import { resetDatabase } from '../../testing/database.js';
import { aPlan, aProfile, aUser } from '../../testing/factories.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';
import { CatalogueError } from './catalogue.js';
import { updateDatabase } from './seeder.js';

const quiet = () => undefined;

/** A copy of the fixture data that a test can edit before updating from it. */
function editableData(): {
  dir: string;
  edit<T>(file: string, change: (rows: T[]) => T[]): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'diet-app-update-'));
  cpSync(catalogueDirectory(), dir, { recursive: true });
  return {
    dir,
    edit(file, change) {
      const path = join(dir, file);
      writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, 'utf8')))));
    },
  };
}

interface Row {
  slug: string;
  [key: string]: unknown;
}

describe('updating the curated database', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  const idOf = async (slug: string) => (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

  it('keeps every id and every user row over two updates of unchanged data', async () => {
    const user = await aUser(t);
    const salmon = await idOf('salmon');
    const tofu = await idOf('firm-tofu');
    const profile = await aProfile(t, user, {
      preferences: {
        favoriteIngredientIds: [tofu],
        excludedIngredientIds: [salmon],
        allergens: [],
        dislikedFoods: [],
        preferredCuisines: [],
        maxConsecutiveDaysSameMeal: 2,
        maxTimesPerWeekSameMeal: 3,
        inventoryBiasResetEvery: 5,
      },
    });
    const plan = await aPlan(t, user, profile);
    const plannedRecipe = plan.days[0]!.meals[0]!.recipe!.id;
    await t.prisma.inventoryItem.create({ data: { profileId: profile.id, ingredientId: salmon, quantity: 400, unit: 'g' } });
    await t.prisma.favorite.create({ data: { profileId: profile.id, recipeId: plannedRecipe } });
    await t.prisma.favoriteSet.create({ data: { profileId: profile.id, label: 'Usual', slots: { breakfast: plannedRecipe } } });
    await t.prisma.ingredientTranslation.update({
      where: { ingredientId_locale: { ingredientId: salmon, locale: 'pl' } },
      data: { name: 'Łosoś atlantycki', source: 'MANUAL' },
    });
    const ingredientsBefore = await t.prisma.ingredient.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } });
    const recipesBefore = await t.prisma.recipe.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } });

    const first = await updateDatabase(t.prisma, catalogueDirectory(), quiet);
    const second = await updateDatabase(t.prisma, catalogueDirectory(), quiet);

    for (const result of [first, second]) {
      expect(result).toMatchObject({
        deletedRecipes: 0,
        deletedIngredients: 0,
        retiredRecipes: 0,
        retiredIngredients: 0,
        repairedProfiles: 0,
      });
    }
    expect(await t.prisma.ingredient.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } })).toEqual(ingredientsBefore);
    expect(await t.prisma.recipe.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } })).toEqual(recipesBefore);
    expect(await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } })).toMatchObject([
      { ingredientId: salmon, quantity: 400, unit: 'g' },
    ]);
    const preferences = await t.prisma.profilePreference.findUniqueOrThrow({ where: { profileId: profile.id } });
    expect(preferences.excludedIngredientIds).toEqual([salmon]);
    expect(preferences.favoriteIngredientIds).toEqual([tofu]);
    expect(await t.prisma.favorite.count({ where: { profileId: profile.id } })).toBe(1);
    expect(await t.prisma.plannedMeal.count({ where: { day: { planId: plan.id } } })).toBe(21);
    // A name an operator approved outranks the curated file.
    expect(
      await t.prisma.ingredientTranslation.findUniqueOrThrow({ where: { ingredientId_locale: { ingredientId: salmon, locale: 'pl' } } }),
    ).toMatchObject({ name: 'Łosoś atlantycki', source: 'MANUAL' });
  });

  it('retires an ingredient the data dropped while a pantry still holds it, and deletes one nobody uses', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user);
    const data = editableData();
    // Two ingredients no recipe uses: one in a pantry, one referenced by nothing.
    data.edit<Row>('ingredients.json', (rows) => [
      ...rows,
      { ...rows.find((r) => r.slug === 'tomato')!, slug: 'heirloom-tomato', name: { en: 'Heirloom tomato' } },
      { ...rows.find((r) => r.slug === 'tomato')!, slug: 'cherry-tomato', name: { en: 'Cherry tomato' } },
    ]);
    await updateDatabase(t.prisma, data.dir, quiet);
    const heirloom = await idOf('heirloom-tomato');
    await t.prisma.inventoryItem.create({ data: { profileId: profile.id, ingredientId: heirloom, quantity: 3, unit: 'piece' } });

    data.edit<Row>('ingredients.json', (rows) => rows.filter((r) => !['heirloom-tomato', 'cherry-tomato'].includes(r.slug)));
    const result = await updateDatabase(t.prisma, data.dir, quiet);

    expect(result).toMatchObject({ retiredIngredients: 1, deletedIngredients: 1 });
    expect(await t.prisma.ingredient.findUnique({ where: { slug: 'cherry-tomato' } })).toBeNull();
    const retired = await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'heirloom-tomato' } });
    expect(retired.id).toBe(heirloom);
    expect(retired.retiredAt).not.toBeNull();
    expect(await t.prisma.inventoryItem.count({ where: { profileId: profile.id, ingredientId: heirloom } })).toBe(1);

    // Hidden from search, and back in it when the data carries it again.
    const search = () =>
      t.http().get('/api/ingredients?search=heirloom').set({ Authorization: `Bearer ${user.accessToken}` });
    expect((await search()).body).toEqual([]);
    data.edit<Row>('ingredients.json', (rows) => [
      ...rows,
      { ...rows.find((r) => r.slug === 'tomato')!, slug: 'heirloom-tomato', name: { en: 'Heirloom tomato' } },
    ]);
    await updateDatabase(t.prisma, data.dir, quiet);
    expect((await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'heirloom-tomato' } })).retiredAt).toBeNull();
    expect((await search()).body).toMatchObject([{ id: heirloom }]);
  });

  it('retires a recipe the data dropped while a plan still uses it, and deletes the others', async () => {
    const user = await aUser(t);
    const plan = await aPlan(t, user, await aProfile(t, user));
    const planned = await t.prisma.recipe.findMany({
      where: { plannedMeals: { some: { day: { planId: plan.id } } } },
      select: { slug: true },
    });
    const data = editableData();
    const before = await t.prisma.recipe.count();

    data.edit<Row>('recipes.json', (rows) => rows.filter((r) => r.slug === 'tomato-toast'));
    const result = await updateDatabase(t.prisma, data.dir, quiet);

    const plannedAndDropped = planned.filter((recipe) => recipe.slug !== 'tomato-toast').length;
    expect(plannedAndDropped).toBeGreaterThan(0);
    expect(result.retiredRecipes).toBe(plannedAndDropped);
    expect(result.deletedRecipes).toBe(before - 1 - plannedAndDropped);
    expect(await t.prisma.plannedMeal.count({ where: { day: { planId: plan.id } } })).toBe(21);
    expect(await t.prisma.recipe.count({ where: { retiredAt: null, origin: 'seed' } })).toBe(1);
  });

  it('writes every corrected field of an ingredient, and the allergen reaches the recipes that contain it', async () => {
    const data = editableData();
    data.edit<Row>('ingredients.json', (rows) =>
      rows.map((r) =>
        r.slug === 'broccoli'
          ? { ...r, allergens: ['sesame'], dietCompatibility: ['balanced'], gramsPerPiece: 300, density: 0.6, category: 'other' }
          : r,
      ),
    );

    await updateDatabase(t.prisma, data.dir, quiet);

    expect(await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'broccoli' } })).toMatchObject({
      allergens: ['sesame'],
      dietCompatibility: ['balanced'],
      gramsPerPiece: 300,
      density: 0.6,
      category: 'other',
    });
    const withBroccoli = await t.prisma.recipe.findMany({
      where: { ingredients: { some: { ingredient: { slug: 'broccoli' } } } },
      select: { allergens: true },
    });
    expect(withBroccoli.length).toBeGreaterThan(0);
    expect(withBroccoli.every((r) => r.allergens.includes('sesame'))).toBe(true);
  });

  it('changes nothing when a data file is malformed, and names the file', async () => {
    const data = editableData();
    data.edit<Row>('recipes.json', (rows) => rows.slice(0, 3));
    writeFileSync(join(data.dir, 'substitutions.json'), '[{"from": "whole-milk", ');
    const snapshot = async () => ({
      recipes: await t.prisma.recipe.findMany({ orderBy: { id: 'asc' } }),
      ingredients: await t.prisma.ingredient.findMany({ orderBy: { id: 'asc' } }),
      meta: await t.prisma.seedMeta.findMany(),
    });
    const before = await snapshot();

    const failure = await updateDatabase(t.prisma, data.dir, quiet).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CatalogueError);
    expect((failure as CatalogueError).problems).toMatchObject([{ file: 'substitutions.json', path: '<root>' }]);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a recipe that names an ingredient the data does not have', async () => {
    const data = editableData();
    data.edit<Row>('ingredients.json', (rows) => rows.filter((r) => r.slug !== 'salmon'));

    const failure = await updateDatabase(t.prisma, data.dir, quiet).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CatalogueError);
    expect((failure as CatalogueError).message).toContain('unknown ingredient "salmon"');
    expect(await t.prisma.ingredient.count({ where: { slug: 'salmon' } })).toBe(1);
  });

  it('removes references to rows that no longer exist and tells the profile', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user);
    const tofu = await idOf('firm-tofu');
    const gone = '00000000-0000-4000-8000-000000000000';
    await t.prisma.profilePreference.update({
      where: { profileId: profile.id },
      data: { excludedIngredientIds: [gone, tofu], favoriteIngredientIds: [gone] },
    });
    await t.prisma.favoriteSet.create({ data: { profileId: profile.id, label: 'Lost', slots: { lunch: gone } } });

    const result = await updateDatabase(t.prisma, catalogueDirectory(), quiet);

    expect(result.repairedProfiles).toBe(1);
    const preferences = await t.prisma.profilePreference.findUniqueOrThrow({ where: { profileId: profile.id } });
    expect(preferences.excludedIngredientIds).toEqual([tofu]);
    expect(preferences.favoriteIngredientIds).toEqual([]);
    expect(await t.prisma.favoriteSet.count({ where: { profileId: profile.id } })).toBe(0);
    expect(await t.prisma.notification.findMany({ where: { profileId: profile.id } })).toMatchObject([
      { type: 'preferences_review', payload: { ingredients: 2, recipes: 1 } },
    ]);
  });

  it('cannot delete an ingredient a pantry holds, whatever asks', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user);
    const data = editableData();
    data.edit<Row>('ingredients.json', (rows) => [
      ...rows,
      { ...rows.find((r) => r.slug === 'tomato')!, slug: 'heirloom-tomato', name: { en: 'Heirloom tomato' } },
    ]);
    await updateDatabase(t.prisma, data.dir, quiet);
    const heirloom = await idOf('heirloom-tomato');
    await t.prisma.inventoryItem.create({ data: { profileId: profile.id, ingredientId: heirloom, quantity: 2, unit: 'piece' } });

    await expect(t.prisma.ingredient.delete({ where: { id: heirloom } })).rejects.toMatchObject({ code: 'P2003' });
  });
});

describe('the admin "Update database" action', () => {
  let t: TestApp;
  const admin = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Start the update over HTTP and poll its status until it ends. */
  async function runUpdate(): Promise<{ status: string; result: Record<string, unknown> | null; error: string | null }> {
    await t.http().post('/api/admin/db/update').set(admin).expect(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { body } = await t.http().get('/api/admin/db/update/status').set(admin).expect(200);
      if (body.status !== 'running') return body;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('the update did not finish');
  }

  it('is closed to a caller without the admin credentials', async () => {
    await t.http().post('/api/admin/db/update').expect(401);
  });

  it('runs to the end and leaves a pantry and its ingredient ids as they were', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user);
    const salmon = await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'salmon' } });
    await t.prisma.inventoryItem.create({ data: { profileId: profile.id, ingredientId: salmon.id, quantity: 250, unit: 'g' } });

    const state = await runUpdate();

    expect(state).toMatchObject({
      status: 'done',
      error: null,
      result: { deletedIngredients: 0, retiredIngredients: 0, deletedRecipes: 0, retiredRecipes: 0, repairedProfiles: 0 },
    });
    expect(await t.prisma.inventoryItem.findMany({ where: { profileId: profile.id } })).toMatchObject([
      { ingredientId: salmon.id, quantity: 250 },
    ]);
    expect((await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'salmon' } })).id).toBe(salmon.id);
  });
});
