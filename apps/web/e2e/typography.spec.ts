// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page } from '@playwright/test';
import { signUp } from './accounts';
import { expect, settled, signInHere, test } from './fixtures';

const PASSWORD = 'Browser-Test-Passw0rd';

type Texts = Record<string, string>;

/** A Polish word of one letter with a plain space after it: a narrow screen may leave it alone at a line's end. */
const LOOSE_LETTER = /(?:^|[\s(„"»])[wziaouWZIAOU] (?=\S)/u;

/**
 * Every line of what the page shows in Polish in which a word of one letter stands loose: the
 * application's own texts, the names that come from the data and the lists it joins alike, as the
 * browser lays them out (hidden parts left out, a word split between two elements read as one
 * line). A part marked as written in another language, or in one nobody has said (`lang=""`), as
 * the operator's terms may be, is left out while it is read.
 */
async function looseLetters(page: Page): Promise<string[]> {
  const lines = await page.evaluate(() => {
    const foreign = [...document.querySelectorAll<HTMLElement>('body [lang]')].filter(
      (element) => !element.lang.startsWith('pl'),
    );
    const shown = foreign.map((element) => element.style.display);
    for (const element of foreign) element.style.display = 'none';
    const text = document.body.innerText;
    foreign.forEach((element, index) => {
      element.style.display = shown[index]!;
    });
    return text.split('\n');
  });
  return lines.filter((line) => LOOSE_LETTER.test(line)).map((line) => line.trim().slice(0, 200));
}

/** The plan open on its page, every day of it unfolded. */
async function anOpenPlan(page: Page, plans: Texts, path: string): Promise<void> {
  await page.goto(path);
  await settled(page);
  await page.getByRole('button', { name: plans.showPlan! }).first().click();
  await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();
  const folded = page.locator('[id^="plan-"] > button[aria-expanded="false"]');
  while ((await folded.count()) > 0) await folded.first().click();
}

test.describe('a page shown in Polish leaves no word of one letter loose', () => {
  test.skip(({ appLocale }) => appLocale !== 'pl', 'a rule of Polish');

  for (const path of [
    '/',
    '/login',
    '/register',
    '/forgot-password',
    '/from-the-app',
    '/terms',
    '/review',
  ]) {
    test(path, async ({ anonymous }) => {
      await anonymous.goto(path);
      await settled(anonymous);

      expect(await looseLetters(anonymous)).toEqual([]);
    });
  }

  for (const path of [
    '/dashboard',
    '/diary',
    '/profile',
    '/calculator',
    '/split',
    '/recipes',
    '/favorites',
    '/meal-plans',
    '/shopping-lists',
    '/inventory',
    '/products',
    '/settings',
    '/settings?tab=ai',
    '/settings?tab=security',
    '/settings?tab=account',
  ]) {
    test(path, async ({ session }) => {
      await session.page.goto(path);
      await settled(session.page);

      expect(await looseLetters(session.page)).toEqual([]);
    });
  }

  test('a recipe on a page of its own', async ({ session, account }) => {
    await session.page.goto(`/recipes/${account.recipeId}`);
    await settled(session.page);

    expect(await looseLetters(session.page)).toEqual([]);
  });

  test('a plan with its days open, and the recipe window of a meal', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    await anOpenPlan(page, messages.mealPlans as Texts, '/meal-plans');

    expect(await looseLetters(page), 'the open plan').toEqual([]);

    await page.locator('li button.text-primary').first().click();
    const recipe = page.getByRole('dialog', { name: (messages.recipeModal as Texts).title! });
    await expect(recipe.getByRole('heading').first()).toBeVisible();
    await expect(recipe.getByRole('list').first()).toBeVisible();
    expect(await looseLetters(page), 'the recipe window').toEqual([]);
  });

  test('a plan made together: its plates, its toppings and the split of a pot by one part', async ({
    browser,
    request,
    baseURL,
    appLocale,
    messages,
  }, testInfo) => {
    const plans = messages.mealPlans as Texts;
    const split = messages.split as unknown as Texts & { way: Texts };
    // Adam eats high in protein, Ewa vegan: the dishes both eat get a plate of each person's own, and his days toppings.
    const email = `browser-letters-${Date.now().toString(36)}@example.test`;
    const registered = await signUp(
      request,
      { email, password: PASSWORD, displayName: 'Letters' },
      appLocale,
    );
    expect(registered.ok()).toBe(true);
    const token = ((await registered.json()) as { tokens: { accessToken: string } }).tokens
      .accessToken;
    const headers = { authorization: `Bearer ${token}`, 'accept-language': appLocale };
    const aProfile = async (data: object): Promise<string> => {
      const answer = await request.post('/api/profiles', { data, headers });
      expect(answer.ok(), await answer.text()).toBe(true);
      return ((await answer.json()) as { id: string }).id;
    };
    const adam = await aProfile({
      name: 'Adam',
      age: 38,
      sex: 'male',
      heightCm: 188,
      weightKg: 95,
      activityLevel: 'active',
      mealCount: 4,
      dietType: 'high_protein',
    });
    const ewa = await aProfile({
      name: 'Ewa',
      age: 34,
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
      mealCount: 4,
      dietType: 'vegan',
    });
    const generated = await request.post('/api/meal-plans/generate', {
      data: {
        profileId: ewa,
        withProfileId: adam,
        startDate: new Date().toLocaleDateString('sv'),
        durationDays: 2,
      },
      headers,
    });
    expect(generated.ok(), await generated.text()).toBe(true);
    const { joint } = (await generated.json()) as { joint: { planId: string } };
    const adams = (await (
      await request.get(`/api/meal-plans/${joint.planId}`, { headers })
    ).json()) as {
      days: {
        meals: {
          id: string;
          recipe: { title: string } | null;
          ingredients: { share?: number }[];
        }[];
      }[];
    };
    const plated = adams.days
      .flatMap((day) => day.meals)
      .find((meal) => meal.ingredients.some((line) => line.share !== undefined));

    const elsewhere = await browser.newContext({ ...testInfo.project.use, baseURL });
    await elsewhere.addCookies([{ name: 'NEXT_LOCALE', value: appLocale, url: baseURL! }]);
    const page = await elsewhere.newPage();
    await page.goto('/login');
    await signInHere(page, { email, password: PASSWORD }, messages);
    await page.waitForURL('**/dashboard');
    await anOpenPlan(page, plans, `/meal-plans?profile=${adam}`);

    expect(await looseLetters(page), "Adam's plan, made together with Ewa").toEqual([]);

    // A dish both eat from one pot, on a plate of each person's own: its window, then the split of one part by the plates.
    expect(plated, 'a meal on a plate of its own').toBeDefined();
    const row = page.locator(`[id="meal-${plated!.id}"]`);
    await row.getByRole('button', { name: plated!.recipe!.title, exact: true }).click();
    const recipe = page.getByRole('dialog', { name: (messages.recipeModal as Texts).title! });
    await expect(recipe.getByRole('table')).toBeVisible();
    expect(await looseLetters(page), 'the plates in the recipe window').toEqual([]);
    await page.keyboard.press('Escape');

    await row.getByRole('button', { name: split.open! }).click();
    const splitting = page.getByRole('dialog', { name: split.title! });
    await splitting.getByRole('radio', { name: split.way!.part! }).check();
    await expect(splitting.getByRole('combobox', { name: split.partWhich! })).toBeVisible();
    expect(await looseLetters(page), 'the split of one part by the plates').toEqual([]);
    await elsewhere.close();
  });
});
