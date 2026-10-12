// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page } from '@playwright/test';
import { accountOf } from './accounts';
import { expect, settled, signInHere, test, type Messages } from './fixtures';

const ACCOUNT_PAGES = ['/dashboard', '/profile', '/calculator', '/recipes', '/favorites', '/meal-plans', '/shopping-lists', '/inventory', '/settings'];

const texts = (messages: Messages, group: string): Record<string, string> => messages[group] as Record<string, string>;

/** True on a screen too narrow for the navigation to stand beside the page. */
const narrow = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768;

/** The navigation as this screen has it: beside the page, or in the drawer, which is opened first. */
async function navigation(page: Page, messages: Messages) {
  const menu = texts(messages, 'nav').menu!;
  if (!narrow(page)) return page.getByRole('complementary');
  await page.getByRole('button', { name: menu }).click();
  const drawer = page.getByRole('dialog', { name: menu });
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('a page of an account, for a browser without a session', () => {
  test('is answered with the way to the sign-in page, whichever page it is', async ({ request, baseURL }) => {
    for (const path of ACCOUNT_PAGES) {
      const answer = await request.get(path, { maxRedirects: 0 });
      const to = new URL(answer.headers().location ?? '', baseURL);

      expect(answer.status(), path).toBe(307);
      // On the address the visitor used, not on a name the server has for itself.
      expect(to.origin, path).toBe(new URL(baseURL!).origin);
      expect(`${to.pathname}${to.search}`, path).toBe(path === '/dashboard' ? '/login' : `/login?next=${encodeURIComponent(path)}`);
    }
  });

  test('is the sign-in page before anything of the account is shown or asked for', async ({ anonymous: page, messages }) => {
    const refused: string[] = [];
    page.on('response', (answer) => {
      if (answer.status() === 401) refused.push(new URL(answer.url()).pathname);
    });

    const shown = await page.goto('/meal-plans?profile=none');

    // The server sent the browser on; no page of the account was rendered to do it.
    expect((await shown!.request().redirectedFrom()?.response())?.status()).toBe(307);
    await expect(page).toHaveURL(/\/login\?next=%2Fmeal-plans%3Fprofile%3Dnone$/);
    await expect(page.getByRole('button', { name: texts(messages, 'auth').signInButton! })).toBeVisible();
    await expect(page.getByRole('navigation', { name: texts(messages, 'nav').menu! })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(refused).toEqual([]);
  });
});

test.describe('entering and leaving an account', () => {
  test('lead back to the page that was asked for, and leave nothing of one account in the page for the next', async ({ anonymous: page, account, messages }, testInfo) => {
    const other = accountOf(testInfo.project.name === 'desktop-en' ? 'desktop-pl' : 'desktop-en');
    const address = page.locator('p.font-mono');

    // Asked for without a session, the settings come up after the sign-in.
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await page.evaluate(() => Object.assign(window, { keptFromBefore: true }));
    await signInHere(page, account, messages);
    await page.waitForURL('**/settings');
    await expect(address.first()).toHaveText(account.email);
    // The account was entered as a page loaded anew.
    expect(await page.evaluate(() => 'keptFromBefore' in window)).toBe(false);

    // Signing out loads the sign-in page anew: what the page held in memory is gone with it.
    await page.evaluate(() => Object.assign(window, { keptFromBefore: true }));
    await (await navigation(page, messages)).getByRole('button', { name: texts(messages, 'nav').signOut!, exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/login' && url.search === '');
    expect(await page.evaluate(() => 'keptFromBefore' in window)).toBe(false);

    // Somebody else signs in, in the same tab, and opens the same page: it is theirs.
    await signInHere(page, other, messages);
    await page.waitForURL('**/dashboard');
    await (await navigation(page, messages)).getByRole('link', { name: texts(messages, 'nav').settings! }).click();
    await page.waitForURL('**/settings');
    await expect(address.first()).toHaveText(other.email);
    await expect(page.getByText(account.email)).toHaveCount(0);
  });

  test('a link from another site to a page of the account brings somebody who is signed in to that page', async ({ session, baseURL }) => {
    const page = session.page;
    // The browser does not send the session's marker with a request another
    // site caused: the server takes the visitor for nobody, and the sign-in page knows better.
    await page.route('http://elsewhere.example/', (route) =>
      route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Elsewhere</title><a href="${baseURL}/inventory">the pantry</a>` }),
    );
    await page.goto('http://elsewhere.example/');

    await page.getByRole('link', { name: 'the pantry' }).click();

    await page.waitForURL('**/inventory');
    await settled(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.unroute('http://elsewhere.example/');
  });
});

test.describe('the navigation', () => {
  test('stands beside the page on a wide screen, and is a drawer behind a bar on a narrow one', async ({ session, messages }) => {
    const page = session.page;
    const nav = texts(messages, 'nav');
    await page.goto('/dashboard');
    await settled(page);
    const menuButton = page.getByRole('button', { name: nav.menu! });

    if (!narrow(page)) {
      await expect(page.getByRole('complementary').getByRole('link', { name: nav.mealPlans! })).toBeVisible();
      await expect(menuButton).toBeHidden();
      return;
    }

    await expect(page.getByRole('complementary')).toBeHidden();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    await menuButton.click();
    const drawer = page.getByRole('dialog', { name: nav.menu! });
    await expect(drawer).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    // The drawer holds the focus, and the page behind it is shut.
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
    expect(await page.evaluate(() => document.querySelector('dialog[open]')?.matches(':modal'))).toBe(true);
    await expect(drawer.getByRole('link', { name: nav.dashboard! })).toHaveAttribute('aria-current', 'page');

    // Esc shuts it, and the focus is back on the button that opened it.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(menuButton).toBeFocused();

    // A link in it leads to its page, and the drawer is out of the way.
    await menuButton.click();
    await drawer.getByRole('link', { name: nav.inventory! }).click();
    await page.waitForURL('**/inventory');
    await expect(drawer).toBeHidden();
    await settled(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('shuts its drawer when the screen grows wide enough to have it beside the page', async ({ session, messages }) => {
    const page = session.page;
    test.skip(!narrow(page), 'a wide screen has no drawer');
    const size = page.viewportSize()!;
    await page.goto('/dashboard');
    await settled(page);
    await page.getByRole('button', { name: texts(messages, 'nav').menu! }).click();
    const drawer = page.getByRole('dialog', { name: texts(messages, 'nav').menu! });
    await expect(drawer).toBeVisible();

    try {
      // A tablet turned on its side.
      await page.setViewportSize({ width: 1024, height: 768 });

      await expect(drawer).toBeHidden();
      await expect(page.getByRole('complementary')).toBeVisible();
      expect(await page.evaluate(() => document.querySelector(':modal'))).toBeNull();
    } finally {
      await page.setViewportSize(size);
    }
  });
});

test.describe('on the narrowest screens the application is used on', () => {
  /**
   * How far the page can be moved sideways: nothing, when everything fits the
   * screen. The page is the document and, under the shell of an account, the
   * part of it that scrolls. A table that says of itself that it scrolls
   * sideways is not the page.
   */
  const sideways = (page: Page): Promise<number> =>
    page.evaluate(() => Math.max(...[document.documentElement, ...document.querySelectorAll('main')].map((part) => part.scrollWidth - part.clientWidth)));

  /** What sticks out of the screen to the right, by tag and text: what a failing page is told by. */
  const stickingOut = (page: Page): Promise<string[]> =>
    page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const scrollsByItself = (element: Element | null): boolean => {
        for (let at = element; at && at.tagName !== 'MAIN' && at !== document.body; at = at.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(at).overflowX)) return true;
        }
        return false;
      };
      return [...document.querySelectorAll('body *')]
        .filter((element) => element.getBoundingClientRect().right > width + 1 && !scrollsByItself(element.parentElement))
        .slice(0, 8)
        .map((element) => `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') ?? '').split(' ').slice(0, 4).join('.')} "${(element.textContent ?? '').trim().slice(0, 40)}"`);
    });

  for (const width of [360, 375]) {
    test(`every page fits a screen ${width} px wide`, async ({ session, account, anonymous }) => {
      test.skip(!narrow(session.page), 'checked by the projects of a narrow screen');
      const size = session.page.viewportSize()!;
      const wide: Record<string, string[]> = {};
      try {
        for (const [page, paths] of [
          [anonymous, ['/', '/login', '/register', '/forgot-password', '/terms']],
          [session.page, [...ACCOUNT_PAGES, `/recipes/${account.recipeId}`]],
        ] as const) {
          await page.setViewportSize({ width, height: size.height });
          for (const path of paths) {
            await page.goto(path);
            await settled(page);
            if ((await sideways(page)) > 0) wide[path] = await stickingOut(page);
          }
        }
      } finally {
        await session.page.setViewportSize(size);
      }

      expect(wide).toEqual({});
    });
  }

  test('the administrator\'s panel fits the screen once signed in', async ({ anonymous, messages }) => {
    const user = process.env.E2E_ADMIN_USER;
    const password = process.env.E2E_ADMIN_PASSWORD;
    test.skip(!narrow(anonymous) || !user || !password, 'checked by the projects of a narrow screen, in a run that was given the administrator');
    const admin = texts(messages, 'admin');
    const size = anonymous.viewportSize()!;
    const wide: Record<string, string[]> = {};
    try {
      await anonymous.goto('/admin');
      await anonymous.getByLabel(admin.adminUser!).fill(user!);
      await anonymous.getByLabel(admin.adminPassword!).fill(password!);
      await anonymous.getByRole('button', { name: admin.signIn!, exact: true }).click();
      // Its tables are in by the time the statistics are.
      await expect(anonymous.getByRole('table').first()).toBeVisible();
      await settled(anonymous);
      for (const width of [360, 375]) {
        await anonymous.setViewportSize({ width, height: size.height });
        if ((await sideways(anonymous)) > 0) wide[`the panel at ${width}`] = await stickingOut(anonymous);
      }
    } finally {
      await anonymous.setViewportSize(size);
    }

    expect(wide).toEqual({});
  });

  test('a plan with its days open, a shopping list and what opens over them fit the screen', async ({ session, messages }) => {
    const page = session.page;
    test.skip(!narrow(page), 'checked by the projects of a narrow screen');
    const plans = texts(messages, 'mealPlans');
    const wide: Record<string, string[]> = {};
    const size = page.viewportSize()!;
    try {
      for (const width of [360, 375]) {
        await page.setViewportSize({ width, height: size.height });
        await page.goto('/meal-plans');
        await settled(page);
        await page.getByRole('button', { name: plans.showPlan! }).first().click();
        await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();
        if ((await sideways(page)) > 0) wide[`the open plan at ${width}`] = await stickingOut(page);

        await page.locator('li button.text-primary').first().click();
        const recipe = page.getByRole('dialog', { name: texts(messages, 'recipeModal').title! });
        await expect(recipe.getByRole('heading').first()).toBeVisible();
        const box = (await recipe.boundingBox())!;
        if (box.x < 0 || box.x + box.width > width) wide[`the recipe window at ${width}`] = [`from ${box.x} to ${box.x + box.width}`];
        if ((await recipe.evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth)) > 0) wide[`inside the recipe window at ${width}`] = ['its content is wider than the window'];
        await page.keyboard.press('Escape');

        await page.getByRole('button', { name: plans.recalculate!, exact: true }).first().click();
        const again = page.getByRole('dialog', { name: (messages.mealPlans as unknown as { reroll: Record<string, string> }).reroll.title! });
        await expect(again.getByRole('radio').first()).toBeVisible();
        const asked = (await again.boundingBox())!;
        if (asked.x < 0 || asked.x + asked.width > width) wide[`the window a plan is made again in at ${width}`] = [`from ${asked.x} to ${asked.x + asked.width}`];
        if ((await again.evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth)) > 0) wide[`inside the window a plan is made again in at ${width}`] = ['its content is wider than the window'];
        await page.keyboard.press('Escape');
      }
    } finally {
      await page.setViewportSize(size);
    }

    expect(wide).toEqual({});
  });
});
