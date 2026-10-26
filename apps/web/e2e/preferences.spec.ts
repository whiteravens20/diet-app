// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, signInHere, test } from './fixtures';

const PASSWORD = 'Browser-Test-Passw0rd';

test("the account's language, theme and palette are there on a browser it signs in on for the first time", async ({
  browser,
  request,
  baseURL,
  appLocale,
  messages,
}) => {
  const other = appLocale === 'en' ? 'pl' : 'en';
  // An account of its own: the shared ones sit near the sign-in limit.
  const email = `browser-looks-${Date.now().toString(36)}@example.test`;
  const registered = await request.post('/api/auth/register', {
    data: { email, password: PASSWORD, displayName: 'Browser test' },
  });
  expect(registered.ok()).toBe(true);
  const token = ((await registered.json()) as { tokens: { accessToken: string } }).tokens
    .accessToken;
  const saved = await request.patch('/api/users/me', {
    data: { locale: other, theme: 'dark', palette: 'forest' },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(saved.ok()).toBe(true);

  // Another browser, which keeps nothing of the account yet: only the language of its reader.
  const elsewhere = await browser.newContext({ baseURL });
  await elsewhere.addCookies([{ name: 'NEXT_LOCALE', value: appLocale, url: baseURL! }]);
  const page = await elsewhere.newPage();
  await page.goto('/login');
  await signInHere(page, { email, password: PASSWORD }, messages);
  await page.waitForURL('**/dashboard');

  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', other);
  await expect(html).toHaveAttribute('data-palette', 'forest');
  await expect(html).toHaveClass(/\bdark\b/);
  await elsewhere.close();
});
