// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { RecipeSearchPage } from '@diet-app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase } from '../testing/database.js';
import { aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the recipe library, as a client pages through it', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    user = await aUser(t);
    // Polish titles that are nowhere near their English ones in the alphabet, some with letters of Polish alone.
    const titles = [
      'Żurek',
      'Ananas pieczony',
      'Łosoś z pieca',
      'Ćwikła',
      'Zupa jarzynowa',
      'Lody',
      'Ąkacz',
    ];
    const recipes = await t.prisma.recipe.findMany({
      where: { createdByUserId: null },
      orderBy: { title: 'asc' },
      take: titles.length,
    });
    await Promise.all(
      recipes.map((recipe, index) =>
        t.prisma.recipeTranslation.update({
          where: { recipeId_locale: { recipeId: recipe.id, locale: 'pl' } },
          data: { title: titles[index]! },
        }),
      ),
    );
    // One recipe with no Polish title at all: it is shown, and sorted, by its English one.
    await t.prisma.recipeTranslation.deleteMany({
      where: { locale: 'pl', recipe: { title: { startsWith: 'T' } } },
    });
  });

  afterAll(async () => {
    await t.close();
  });

  const page = async (
    query: Record<string, string | number> = {},
    locale = 'en',
  ): Promise<RecipeSearchPage> =>
    (
      await t
        .http()
        .get('/api/recipes')
        .query(query)
        .set(as(user))
        .set('Accept-Language', locale)
        .expect(200)
    ).body;
  const titles = async (
    query: Record<string, string | number>,
    locale: string,
  ): Promise<string[]> => (await page(query, locale)).items.map((recipe) => recipe.title);

  it.each(['en', 'pl'])(
    'is sorted by the titles it shows, in the alphabet of the language (%s)',
    async (locale) => {
      const shown = await titles({ pageSize: 100 }, locale);

      expect(shown.length).toBeGreaterThan(15);
      expect(shown).toEqual([...shown].sort(new Intl.Collator(locale).compare));
    },
  );

  it('puts the letters of Polish where Polish has them, and a recipe without a Polish title by its English one', async () => {
    const shown = await titles({ pageSize: 100 }, 'pl');
    const at = (title: string): number => shown.indexOf(title);

    expect(at('Ananas pieczony')).toBeLessThan(at('Ąkacz'));
    expect(at('Ąkacz')).toBeLessThan(at('Ćwikła'));
    expect(at('Lody')).toBeLessThan(at('Łosoś z pieca'));
    expect(at('Zupa jarzynowa')).toBeLessThan(at('Żurek'));
    expect(shown.at(-1)).toBe('Żurek');
    expect(
      shown.filter((title) => title.startsWith('T') && !title.endsWith('(pl)')).length,
    ).toBeGreaterThan(0);
  });

  it('cuts its pages from that order: no recipe twice, none left out', async () => {
    const whole = await titles({ pageSize: 100 }, 'pl');
    const first = await page({ pageSize: 8, page: 1 }, 'pl');
    const second = await page({ pageSize: 8, page: 2 }, 'pl');
    const third = await page({ pageSize: 8, page: 3 }, 'pl');

    expect([...first.items, ...second.items, ...third.items].map((recipe) => recipe.title)).toEqual(
      whole.slice(0, 24),
    );
    expect(first).toMatchObject({
      page: 1,
      pageSize: 8,
      total: whole.length,
      totalPages: Math.ceil(whole.length / 8),
    });
    expect((await page({ pageSize: 8, page: 99 }, 'pl')).items).toEqual([]);
  });

  it('is narrowed by what the question names, and the page is cut from what is left', async () => {
    const lunches = await page({ mealType: 'lunch', pageSize: 100 });
    const quick = await page({ maxPrepMinutes: 5, pageSize: 100 });

    expect(lunches.total).toBeGreaterThan(0);
    expect(lunches.items.every((recipe) => recipe.mealTypes.includes('lunch'))).toBe(true);
    expect(quick.items.every((recipe) => recipe.prepMinutes <= 5)).toBe(true);
    expect((await page({ search: 'żurek' }, 'pl')).items.map((recipe) => recipe.title)).toEqual([
      'Żurek',
    ]);
    expect((await page({ search: 'no recipe is called this' })).total).toBe(0);
  });

  it.each([
    ['a difficulty there is not', { difficulty: 'extreme' }, 'difficulty'],
    ['a meal there is not', { mealType: 'brunch' }, 'mealType'],
    ['a diet there is not', { dietType: 'carnivore' }, 'dietType'],
    ['half a page', { page: '1.3' }, 'page'],
    ['a page that is no number', { page: 'abc' }, 'page'],
    ['a page of two and a half', { pageSize: '2.5' }, 'pageSize'],
    ['a page of a thousand', { pageSize: '1000' }, 'pageSize'],
    ['calories that are no number', { maxCalories: 'abc' }, 'maxCalories'],
    ['a search of more than two hundred characters', { search: 'x'.repeat(201) }, 'search'],
  ])('refuses %s, and says which part of the question it is', async (_name, query, part) => {
    const refused = await t.http().get('/api/recipes').query(query).set(as(user)).expect(400);

    expect(refused.body.error).toBe('VALIDATION_FAILED');
    expect(refused.body.issues[0].path).toBe(part);
  });

  it("refuses a part of the question that is given twice, and the same on the list of one's own recipes", async () => {
    expect(
      (await t.http().get('/api/recipes?search=a&search=b').set(as(user)).expect(400)).body.error,
    ).toBe('VALIDATION_FAILED');
    expect(
      (await t.http().get('/api/recipes?mealType=lunch&mealType=dinner').set(as(user)).expect(400))
        .body.error,
    ).toBe('VALIDATION_FAILED');
    expect(
      (await t.http().get('/api/recipes/mine?page=abc').set(as(user)).expect(400)).body.issues[0]
        .path,
    ).toBe('page');
    expect(
      (await t.http().get('/api/recipes/mine?pageSize=1.5').set(as(user)).expect(400)).body
        .issues[0].path,
    ).toBe('pageSize');
  });
});
