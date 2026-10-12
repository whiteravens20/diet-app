// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, settled, test } from './fixtures';

/** The rules a page is held to: WCAG 2.1 and 2.2, levels A and AA. */
const RULES = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** What stands in the way of somebody using the page: the two graver of the four degrees. */
async function barriers(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(RULES).analyze();
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap((violation) => violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')} — ${node.failureSummary?.split('\n').slice(1).join(' ').trim().slice(0, 200)}`));
}

test.describe('a page anybody can open has nothing that keeps somebody from using it', () => {
  for (const path of ['/', '/login', '/register', '/forgot-password', '/terms', '/review', '/admin']) {
    test(path, async ({ anonymous }) => {
      await anonymous.goto(path);
      await settled(anonymous);

      expect(await barriers(anonymous)).toEqual([]);
    });
  }
});

test.describe('a page of a signed-in account has nothing that keeps somebody from using it', () => {
  for (const path of ['/dashboard', '/profile', '/recipes', '/favorites', '/meal-plans', '/shopping-lists', '/inventory', '/settings']) {
    test(path, async ({ session }) => {
      await session.page.goto(path);
      await settled(session.page);

      expect(await barriers(session.page)).toEqual([]);
    });
  }

  test('a recipe on a page of its own', async ({ session, account }) => {
    await session.page.goto(`/recipes/${account.recipeId}`);
    await settled(session.page);

    expect(await barriers(session.page)).toEqual([]);
  });

  test('a plan with its days open, and what opens from a meal', async ({ session, messages }) => {
    const page = session.page;
    const plans = messages.mealPlans as Record<string, string>;
    await page.goto('/meal-plans');
    await settled(page);
    await page.getByRole('button', { name: plans.showPlan! }).first().click();
    await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();

    expect(await barriers(page), 'the open plan').toEqual([]);

    await page.getByRole('button', { name: plans.addCustomMeal! }).first().click();
    await expect(page.getByRole('dialog', { name: plans.customModalTitle! })).toBeVisible();
    expect(await barriers(page), 'the window for a meal of one\'s own').toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: plans.recalculate!, exact: true }).first().click();
    const again = page.getByRole('dialog', { name: (messages.mealPlans as unknown as { reroll: Record<string, string> }).reroll.title! });
    await expect(again.getByRole('radio').first()).toBeVisible();
    expect(await barriers(page), 'the window a plan is made again in').toEqual([]);
    await page.keyboard.press('Escape');

    await page.locator('li button.text-primary').first().click();
    const recipe = page.getByRole('dialog', { name: (messages.recipeModal as Record<string, string>).title! });
    await expect(recipe.getByRole('heading').first()).toBeVisible();
    expect(await barriers(page), 'the recipe window').toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('the form of a profile', async ({ session, messages }) => {
    const page = session.page;
    await page.goto('/profile');
    await settled(page);
    await page.getByRole('button', { name: (messages.common as Record<string, string>).edit!, exact: true }).first().click();
    await expect(page.getByLabel((messages.profile as Record<string, string>).name!, { exact: true })).toBeVisible();

    expect(await barriers(page)).toEqual([]);
  });
});

test.describe('the administrator\'s panel has nothing that keeps somebody from using it', () => {
  const user = process.env.E2E_ADMIN_USER;
  const password = process.env.E2E_ADMIN_PASSWORD;
  test.skip(!user || !password, 'needs E2E_ADMIN_USER and E2E_ADMIN_PASSWORD');

  test('once signed in', async ({ anonymous }) => {
    await anonymous.goto('/admin');
    await anonymous.locator('input[name="user"]').fill(user!);
    await anonymous.locator('input[name="password"]').fill(password!);
    await anonymous.locator('form button[type="submit"]').click();
    await expect(anonymous.locator('input[name="password"]')).toHaveCount(0);
    await settled(anonymous);

    expect(await barriers(anonymous)).toEqual([]);
  });
});
