// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

type Texts = Record<string, string>;

/**
 * An account of its own with a code for it, as an application on a phone asks for one: with the
 * refresh token of its session. A new account rather than a sign-in to the project's: the
 * project's accounts are signed in to as often as the limit of an account allows.
 */
async function aCode(request: APIRequestContext): Promise<{ email: string; code: string }> {
  const email = `browser-from-the-app-${Date.now().toString(36)}@example.test`;
  const registered = await request.post('/api/auth/register', { data: { email, password: 'Browser-Test-Passw0rd', displayName: 'From the app' } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const { refreshToken } = ((await registered.json()) as { tokens: { refreshToken: string } }).tokens;
  const asked = await request.post('/api/auth/browser-code', { data: { refreshToken } });
  expect(asked.ok(), await asked.text()).toBe(true);
  return { email, code: ((await asked.json()) as { code: string }).code };
}

test.describe('a browser opened from the application', () => {
  test('is signed in to the account the code is for once its reader says so, and goes on to the page asked for', async ({ anonymous: page, request, messages }) => {
    const texts = messages.fromTheApp as Texts;
    const { email, code } = await aCode(request);

    await page.goto(`/from-the-app#code=${code}&next=${encodeURIComponent('/settings')}`);

    await expect(page.getByText(email)).toBeVisible();
    // The code has left the address before anybody did anything.
    expect(page.url()).not.toContain(code);
    await page.getByRole('button', { name: texts.signIn!, exact: true }).click();
    await page.waitForURL('**/settings');
    await expect(page.getByRole('heading', { level: 1, name: (messages.settings as Texts).title! })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
  });

  test('signs nobody in with a code that was used, and leads to the sign-in page', async ({ anonymous: page, request, messages, baseURL }) => {
    const { code } = await aCode(request);
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
