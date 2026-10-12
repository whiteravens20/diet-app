// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page } from '@playwright/test';
import { expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

/**
 * A browser gives a page a service worker, and the storage that goes with
 * it, over https or on the machine itself. The instance under test may be
 * reached over plain http: this browser is told to take its address for a
 * safe one, so that what an https instance does can be seen here. The whole
 * browser is asked for by name: the pared-down one the other tests run in
 * does not know the switch.
 */
const address = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3000').origin;
test.use({ channel: 'chromium', launchOptions: { args: [`--unsafely-treat-insecure-origin-as-secure=${address}`] } });

/** The shopping page, with its list read and the application's worker in charge of the page. */
async function theListUnderTheWorker(page: Page): Promise<void> {
  await page.goto('/shopping-lists');
  await settled(page);
  await expect(page.getByRole('main').getByRole('checkbox').first()).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker.ready.then((registration) => registration.active !== null));
  // Loaded once more, now through the worker: it keeps the page and the files it is built from.
  await page.reload();
  await settled(page);
  await expect(page.getByRole('main').getByRole('checkbox').first()).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

const aTick = (page: Page) => page.waitForResponse((res) => res.request().method() === 'PATCH' && /\/api\/shopping-lists\/[^/]+\/items\/[^/]+$/.test(new URL(res.url()).pathname));

test.describe('an account on a device that has lost its network', () => {
  test.afterEach(async ({ session }) => {
    await session.context.setOffline(false);
  });

  test('reads its shopping list from what the browser kept, ticks a row, and the tick is sent when the network is back', async ({ session, messages }) => {
    const { page, context } = session;
    const words = messages.offline as Texts;
    await theListUnderTheWorker(page);
    const entry = await page.getByRole('main').getByRole('checkbox', { checked: false }).first().getAttribute('aria-label');
    const row = page.getByRole('main').getByRole('checkbox', { name: entry!, exact: true });

    await context.setOffline(true);
    await page.reload();

    // The page opens without the server, with the list as it was read last, and says what the reader is looking at.
    await expect(page.getByText(words.notice!, { exact: true })).toBeVisible();
    await expect(row).toBeVisible();
    await expect(row).not.toBeChecked();

    await row.click();
    await expect(row).toBeChecked();
    await expect(page.getByRole('status').filter({ hasText: words.notice! })).toContainText(/\b1\b/);
    // The tick is on the page that is loaded next, too.
    await page.reload();
    await expect(row).toBeChecked();

    const sent = aTick(page);
    await context.setOffline(false);

    expect((await sent).request().postDataJSON()).toEqual({ checked: true });
    await expect(page.getByText(words.notice!, { exact: true })).toHaveCount(0);
    await expect(row).toBeChecked();

    // Back to what it was, so that the tests after this one find the list they expect.
    const restored = aTick(page);
    await row.click();
    expect((await restored).ok()).toBe(true);
    await expect(row).not.toBeChecked();
  });

  test('is told so in the place of a page it never opened on this device', async ({ session, messages }) => {
    const { page, context } = session;
    const words = messages.offline as Texts;
    await theListUnderTheWorker(page);
    // The pages somebody needs in a shop were kept ahead, on the word of the page that somebody is signed in: the plan page was not opened here.
    await expect
      .poll(() => page.evaluate(async () => (await (await caches.open('diet-app.pages.v1')).keys()).map((kept) => new URL(kept.url).pathname)))
      .toEqual(expect.arrayContaining(['/offline', '/meal-plans', '/shopping-lists']));

    await context.setOffline(true);
    await page.goto('/inventory');

    await expect(page.getByRole('heading', { name: words.pageTitle!, exact: true })).toBeVisible();
    await expect(page.getByText(words.pageBody!, { exact: true })).toBeVisible();
    // The way from there leads to what was kept.
    await page.getByRole('link', { name: (messages.nav as Texts).shoppingLists!, exact: true }).click();
    await expect(page.getByText(words.notice!, { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('checkbox').first()).toBeVisible();
  });

  test('leaves nothing of itself in the browser when it signs out', async ({ session, messages }) => {
    const { page } = session;
    await theListUnderTheWorker(page);
    const kept = (): Promise<{ stores: string[]; whose: string | null }> =>
      page.evaluate(async () => ({ stores: (await caches.keys()).filter((name) => name.startsWith('diet-app.offline.')), whose: localStorage.getItem('diet-app.offline.account') }));
    const before = await kept();
    expect(before.whose).toMatch(/^[0-9a-f-]{36}$/);
    expect(before.stores).toEqual([`diet-app.offline.${before.whose}`]);

    const nav = messages.nav as Texts;
    if ((page.viewportSize()?.width ?? 0) < 768) await page.getByRole('button', { name: nav.menu!, exact: true }).click();
    await page.getByRole('button', { name: nav.signOut!, exact: true }).first().click();
    await page.waitForURL('**/login');

    expect(await kept()).toEqual({ stores: [], whose: null });
  });
});
