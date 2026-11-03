// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page } from '@playwright/test';
import { expect, settled, signInHere, test } from './fixtures';

const PASSWORD = 'Browser-Test-Passw0rd';

/** A word of `length` signs, as nobody stops a person from writing one. */
const aWord = (first: string, length: number): string => first.padEnd(length, 'x');

/** What text stands beyond the box it is in, or beyond the screen. */
const stickingOut = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const screen = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const element of document.querySelectorAll('body *')) {
      const holdsText = [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      if (!holdsText || element.closest('select')) continue;
      const range = document.createRange();
      range.selectNodeContents(element);
      const { right, width } = range.getBoundingClientRect();
      if (!width) continue;
      const box = element.closest('dialog, [class*="rounded-"]');
      const limit = Math.min(box ? box.getBoundingClientRect().right : screen, screen);
      if (right > limit + 1) out.push(`${element.tagName} ${element.textContent?.slice(0, 30)}`);
    }
    return out;
  });

test('a word as long as a name can be sticks out of nothing', async ({
  browser,
  request,
  baseURL,
  appLocale,
  messages,
}, testInfo) => {
  test.skip(
    !['desktop-en', 'phone-pl'].includes(testInfo.project.name),
    'a wide screen and a narrow one say it',
  );
  // An account of its own: its names would stand in the way of the other tests.
  const email = `browser-long-${Date.now().toString(36)}@example.test`;
  const registered = await request.post('/api/auth/register', {
    data: { email, password: PASSWORD, displayName: aWord('Name', 80) },
  });
  expect(registered.ok()).toBe(true);
  const token = ((await registered.json()) as { tokens: { accessToken: string } }).tokens
    .accessToken;
  const headers = { authorization: `Bearer ${token}` };
  const made = async <T>(path: string, data: object): Promise<T> => {
    const answer = await request.post(`/api${path}`, { data, headers });
    expect(answer.ok(), `${path}: ${await answer.text()}`).toBe(true);
    return (await answer.json()) as T;
  };

  const profile = await made<{ id: string }>('/profiles', {
    name: aWord('Profile', 80),
    age: 34,
    sex: 'non_binary',
    heightCm: 170,
    weightKg: 65,
  });
  const [rice] = (await (
    await request.get('/api/ingredients?search=rice', { headers })
  ).json()) as { id: string }[];
  const recipe = await made<{ id: string }>('/recipes', {
    title: aWord('Recipe', 120),
    description: aWord('About', 600),
    steps: [aWord('Step', 300)],
    servings: 2,
    ingredients: [{ ingredientId: rice!.id, quantity: 150, unit: 'g', note: aWord('Note', 120) }],
    mealTypes: ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
    prepMinutes: 5,
    cookMinutes: 10,
    difficulty: 'easy',
  });
  await made('/favorites', { profileId: profile.id, recipeId: recipe.id });
  await made('/favorite-sets', {
    profileId: profile.id,
    label: aWord('Set', 80),
    slots: { lunch: recipe.id },
  });
  const date = new Date().toISOString().slice(0, 10);
  await made('/diary/entries', {
    profileId: profile.id,
    date,
    mealType: 'dinner',
    kind: 'meal',
    name: aWord('Entry', 120),
    servings: 1,
    nutrition: { calories: 200 },
  });
  const plan = await made<{ id: string }>('/meal-plans/generate', {
    profileId: profile.id,
    startDate: date,
    durationDays: 1,
  });
  await made(`/meal-plans/${plan.id}/days/${date}/custom-meal`, {
    name: aWord('Meal', 120),
    mealType: 'snack',
    nutrition: { calories: 300 },
    servings: 1,
  });
  await made('/products/own', {
    name: aWord('Product', 160),
    brand: aWord('Brand', 80),
    pack: aWord('Pack', 40),
    unit: 'g',
    per100: { calories: 100 },
  });

  const elsewhere = await browser.newContext({ ...testInfo.project.use, baseURL });
  await elsewhere.addCookies([{ name: 'NEXT_LOCALE', value: appLocale, url: baseURL! }]);
  const page = await elsewhere.newPage();
  await page.goto('/login');
  await signInHere(page, { email, password: PASSWORD }, messages);
  await page.waitForURL('**/dashboard');
  for (const path of [
    '/dashboard',
    '/diary',
    '/profile',
    `/recipes/${recipe.id}`,
    '/favorites',
    '/meal-plans',
    '/products',
    '/settings?tab=account',
  ]) {
    await page.goto(path);
    await settled(page);
    await expect.poll(() => stickingOut(page), path).toEqual([]);
  }
  await elsewhere.close();
});
