// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Response } from '@playwright/test';
import { expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

interface Listed {
  total: number;
  items: { title: string; mealTypes: string[]; nutritionPerServing: { calories: number } }[];
}

/** The next answer of the library to a question that `asked` holds for. */
const listed = (page: Page, asked: (query: URLSearchParams) => boolean): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/recipes' &&
      res.ok() &&
      asked(new URL(res.url()).searchParams),
  );

test.describe('the recipe library', () => {
  test('is narrowed by a meal, by energy and by a word of a title, each asked of the API, and widened again', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const recipes = messages.recipes as Texts;
    // The cards of the recipes: the way to write one of one's own is a link of the page as well.
    const cards = page.getByRole('main').locator('a[href^="/recipes/"]:not([href="/recipes/new"])');
    // A label that holds a list of choices reads with them: the list is found by its role and its name.
    const meal = page.getByRole('combobox', { name: recipes.mealType!, exact: true });

    const whole = listed(page, (query) => !query.has('mealType'));
    await page.goto('/recipes');
    const all = (await (await whole).json()) as Listed;
    await settled(page);
    expect(all.total).toBeGreaterThan(1);

    // By the meal a recipe is for: what the API answers is what the page shows.
    const byMeal = listed(
      page,
      (query) => query.get('mealType') === 'breakfast' && !query.has('maxCalories'),
    );
    await meal.selectOption('breakfast');
    const breakfasts = (await (await byMeal).json()) as Listed;
    expect(breakfasts.total).toBeGreaterThan(0);
    expect(breakfasts.total).toBeLessThan(all.total);
    expect(breakfasts.items.every((recipe) => recipe.mealTypes.includes('breakfast'))).toBe(true);
    await expect(cards).toHaveCount(breakfasts.items.length);
    await expect(cards.first()).toContainText(breakfasts.items[0]!.title);

    // By the energy of a serving as well: the lightest breakfast stays, whatever is heavier than it goes.
    const lightest = Math.min(
      ...breakfasts.items.map((recipe) => recipe.nutritionPerServing.calories),
    );
    const most = String(Math.ceil(lightest));
    const byEnergy = listed(
      page,
      (query) => query.get('mealType') === 'breakfast' && query.get('maxCalories') === most,
    );
    await page.getByLabel(recipes.maxCalories!, { exact: true }).fill(most);
    const light = (await (await byEnergy).json()) as Listed;
    expect(light.total).toBeGreaterThan(0);
    expect(light.items.every((recipe) => recipe.nutritionPerServing.calories <= Number(most))).toBe(
      true,
    );
    await expect(cards).toHaveCount(light.items.length);

    // With nothing left to choose from, the page says so.
    const none = listed(page, (query) => query.get('maxCalories') === '1');
    await page.getByLabel(recipes.maxCalories!, { exact: true }).fill('1');
    expect(((await (await none).json()) as Listed).total).toBe(0);
    await expect(page.getByText(recipes.noneFiltered!, { exact: true })).toBeVisible();

    // Cleared, the whole library is there again: the page has its first answer still, and asks for nothing.
    await page.getByRole('button', { name: recipes.clearFilters!, exact: true }).click();
    await expect(meal).toHaveValue('');
    await expect(page.getByLabel(recipes.maxCalories!, { exact: true })).toHaveValue('');
    await expect(cards).toHaveCount(all.items.length);

    // By a word of a title, in the language the titles are read in: the recipe the word is from is among what is found.
    const from = all.items[0]!.title;
    const word = from
      .split(/\s+/)
      .reduce((longest, part) => (part.length > longest.length ? part : longest), '');
    const byWord = listed(page, (query) => query.get('search') === word);
    await page.getByLabel(recipes.search!, { exact: true }).fill(word);
    const found = (await (await byWord).json()) as Listed;
    expect(found.total).toBeLessThanOrEqual(all.total);
    expect(found.items.map((recipe) => recipe.title)).toContain(from);
    await expect(cards).toHaveCount(found.items.length);

    await page.getByLabel(recipes.search!, { exact: true }).fill('');
    await expect(cards).toHaveCount(all.items.length);
  });
});
