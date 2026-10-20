// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

type Texts = Record<string, string>;

/** A code for the account, as an application on a phone asks for one: with the refresh token of a session of its own. */
async function aCode(request: APIRequestContext, account: { email: string; password: string }): Promise<string> {
  const signedIn = await request.post('/api/auth/login', { data: { email: account.email, password: account.password } });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  const { refreshToken } = ((await signedIn.json()) as { tokens: { refreshToken: string } }).tokens;
  const asked = await request.post('/api/auth/browser-code', { data: { refreshToken } });
  expect(asked.ok(), await asked.text()).toBe(true);
  return ((await asked.json()) as { code: string }).code;
}

test.describe('a browser opened from the application', () => {
  test('is signed in to the account the code is for once its reader says so, and goes on to the page asked for', async ({ anonymous: page, request, account, messages }) => {
    const texts = messages.fromTheApp as Texts;
    const code = await aCode(request, account);

    await page.goto(`/from-the-app#code=${code}&next=${encodeURIComponent('/settings')}`);

    await expect(page.getByText(account.email)).toBeVisible();
    // The code has left the address before anybody did anything.
    expect(page.url()).not.toContain(code);
    await page.getByRole('button', { name: texts.signIn!, exact: true }).click();
    await page.waitForURL('**/settings');
    await expect(page.getByRole('heading', { level: 1, name: (messages.settings as Texts).title! })).toBeVisible();
    await expect(page.getByText(account.email)).toBeVisible();
  });

  test('signs nobody in with a code that was used, and leads to the sign-in page', async ({ anonymous: page, request, account, messages, baseURL }) => {
    const code = await aCode(request, account);
    // Used by another page of the application first.
    const used = await request.post('/api/auth/browser-sign-in', { data: { code }, headers: { origin: new URL(baseURL!).origin } });
    expect(used.ok(), await used.text()).toBe(true);

    await page.goto(`/from-the-app#code=${code}&next=${encodeURIComponent('/settings')}`);

    // The framework's announcer of page changes is an alert as well, an empty one.
    await expect(page.getByRole('alert').filter({ hasText: (messages.errors as Texts).INVALID_BROWSER_CODE! })).toBeVisible();
    await page.getByRole('link', { name: (messages.fromTheApp as Texts).signInHere!, exact: true }).click();
    await page.waitForURL('**/login?next=%2Fsettings');
  });
});
