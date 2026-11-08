// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { signUp } from './accounts';
import { expect, settled, signInHere, test } from './fixtures';

const PASSWORD = 'Browser-Test-Passw0rd';

test("a recipe of one's own is deleted from its page, and its card's buttons stand on a touch screen", async ({
  browser,
  request,
  baseURL,
  appLocale,
  messages,
}, testInfo) => {
  test.skip(
    !['desktop-en', 'phone-pl', 'iphone-pl'].includes(testInfo.project.name),
    'a mouse, and a touch screen in both engines, say it',
  );
  // An account of its own, with a recipe written by hand.
  const email = `browser-own-recipe-${Date.now().toString(36)}@example.test`;
  const registered = await signUp(
    request,
    { email, password: PASSWORD, displayName: 'Browser test' },
    appLocale,
  );
  expect(registered.ok()).toBe(true);
  const token = ((await registered.json()) as { tokens: { accessToken: string } }).tokens
    .accessToken;
  const headers = { authorization: `Bearer ${token}` };
  const [rice] = (await (
    await request.get('/api/ingredients?search=rice', { headers })
  ).json()) as { id: string }[];
  const made = await request.post('/api/recipes', {
    headers,
    data: {
      title: 'Rice of my own',
      description: 'Plain rice.',
      steps: ['Cook the rice.'],
      servings: 1,
      ingredients: [{ ingredientId: rice!.id, quantity: 100, unit: 'g' }],
      mealTypes: ['lunch'],
      prepMinutes: 5,
      cookMinutes: 15,
      difficulty: 'easy',
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const recipe = (await made.json()) as { id: string };

  const use = testInfo.project.use;
  const context = await browser.newContext({
    baseURL,
    viewport: use.viewport,
    hasTouch: use.hasTouch,
    isMobile: use.isMobile,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
  });
  await context.addCookies([{ name: 'NEXT_LOCALE', value: appLocale, url: baseURL! }]);
  const page = await context.newPage();
  await page.goto('/login');
  await signInHere(page, { email, password: PASSWORD }, messages);
  await page.waitForURL('**/dashboard');
  const texts = messages.recipes as Record<string, string>;

  // One's own recipes, where the address opens them: a screen of touch has no pointer to put over
  // a card, so its buttons stand there; a mouse finds them over the card.
  await page.goto('/recipes?tab=mine');
  await settled(page);
  await expect(page.getByText('Rice of my own')).toBeVisible();
  const onTheCard = page.getByRole('button', { name: texts.delete, exact: true });
  await expect(onTheCard).toHaveCSS('opacity', use.hasTouch ? '1' : '0');
  if (!use.hasTouch) {
    await page.getByText('Rice of my own').hover();
    await expect(onTheCard).toHaveCSS('opacity', '1');
  }

  // Deleted from its own page: the question says what becomes of its plans and of a suggestion of
  // it, and one's own recipes come back without it.
  await page.goto(`/recipes/${recipe.id}`);
  await settled(page);
  const asked = new Promise<string>((resolve) => {
    page.once('dialog', (dialog) => {
      resolve(dialog.message().replaceAll('\u00a0', ' '));
      void dialog.accept();
    });
  });
  await page.getByRole('button', { name: texts.delete, exact: true }).click();
  expect(await asked).toBe(texts.deleteConfirm);
  await page.waitForURL('**/recipes?tab=mine');
  await settled(page);
  await expect(page.getByText(texts.mineEmptyTitle!)).toBeVisible();
  await expect(page.getByText('Rice of my own')).toHaveCount(0);
  await context.close();
});
