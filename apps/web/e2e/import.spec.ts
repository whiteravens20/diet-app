// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { barriers, expect, test, type Messages } from './fixtures';

const texts = (messages: Messages, ...path: string[]): Record<string, string> => path.reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], messages) as Record<string, string>;

/** Two recipes as a page writes them: one made of what the curated catalogue has, one that names what it does not. */
const DOCUMENT = JSON.stringify([
  {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Salmon with rice and broccoli, looked at only',
    description: 'Salmon over rice with broccoli.',
    recipeIngredient: ['150 g salmon fillet', '80 g white rice', '120 g broccoli, cut into florets', '1 tbsp olive oil'],
    recipeInstructions: ['Cook the rice.', 'Fry the salmon and steam the broccoli.'],
    recipeYield: '1 serving',
    prepTime: 'PT10M',
    cookTime: 'PT15M',
    recipeCategory: 'Dinner',
    url: 'https://recipes.example/salmon',
    license: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    '@type': 'Recipe',
    name: 'Rice with something unknown',
    recipeIngredient: ['80 g white rice', '2 cloves garlic', '100 g dragon fruit', 'salt to taste'],
    recipeInstructions: 'Cook it.',
    recipeYield: 2,
    cookTime: 'PT20M',
    recipeCategory: 'Lunch',
  },
]);

test.describe('taking recipes in from elsewhere, in the administrator\'s panel', () => {
  test('a look at a document says what would become a draft and why the rest would not, and writes nothing', async ({ anonymous: page, messages }) => {
    const user = process.env.E2E_ADMIN_USER;
    const password = process.env.E2E_ADMIN_PASSWORD;
    test.skip(!user || !password, 'needs a run that was given the administrator');
    const admin = texts(messages, 'admin');
    const curation = texts(messages, 'admin', 'curation');
    const text = texts(messages, 'admin', 'curation', 'import');
    const reasons = texts(messages, 'admin', 'curation', 'import', 'reasons');
    const filled = (template: string, values: Record<string, string | number>) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), template);

    await page.goto('/admin');
    await page.getByLabel(admin.adminUser!).fill(user!);
    await page.getByLabel(admin.adminPassword!).fill(password!);
    await page.getByRole('button', { name: admin.signIn!, exact: true }).click();
    const recipes = page.getByRole('button', { name: curation.kindRecipes!, exact: true });
    await recipes.scrollIntoViewIfNeeded();
    await recipes.click();
    const section = page.getByRole('region', { name: text.title!, exact: true });
    await expect(section).toBeVisible();
    const drafts = async (): Promise<number> => (await (await page.request.get('/api/admin/drafts/recipes?pageSize=1')).json()).total as number;
    const before = await drafts();

    await section.getByLabel(text.document!, { exact: true }).fill(DOCUMENT);
    await section.getByRole('button', { name: text.look!, exact: true }).click();

    const said = section.getByRole('status');
    await expect(said).toContainText(filled(text.wouldCome!, { found: 2, drafted: 1, rejected: 1 }));
    await expect(said).toContainText('Salmon with rice and broccoli, looked at only');
    await expect(said).toContainText('Rice with something unknown');
    await expect(said).toContainText(reasons['no-licence']!);
    await expect(said).toContainText(filled(reasons['line-with-unknown-unit']!, { detail: '2 cloves garlic' }));
    await expect(said).toContainText(filled(reasons['unknown-ingredient']!, { detail: 'dragon fruit' }));
    await expect(said).toContainText(filled(reasons['line-without-amount']!, { detail: 'salt to taste' }));
    expect(await drafts()).toBe(before);
    expect(await barriers(page)).toEqual([]);
  });
});
