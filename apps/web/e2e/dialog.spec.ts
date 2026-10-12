// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

test.describe('a window over the page', () => {
  test('takes the focus and keeps it, shuts the page behind it, closes on Esc and gives the focus back', async ({ session, messages }) => {
    const page = session.page;
    const plans = messages.mealPlans as Record<string, string>;
    await page.goto('/meal-plans');
    await settled(page);
    await page.getByRole('button', { name: plans.showPlan! }).first().click();
    const opener = page.locator('li button.text-primary').first();
    await expect(opener).toBeVisible();

    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: (messages.recipeModal as Record<string, string>).title! });
    await expect(dialog).toBeVisible();

    // The focus is inside the window. However often Tab is pressed, it goes
    // round the window and the browser's own bar, and never to the page behind.
    const where = (): Promise<'window' | 'browser' | 'page'> =>
      page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'browser';
        return active.closest('dialog') ? 'window' : 'page';
      });
    expect(await where()).toBe('window');
    const visited = new Set<string>();
    for (let presses = 0; presses < 25; presses += 1) {
      await page.keyboard.press('Tab');
      visited.add(await where());
    }
    expect([...visited].sort()).not.toContain('page');
    expect(visited).toContain('window');
    // The page behind does not scroll, and takes no click.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
    expect(await page.evaluate(() => document.querySelector('dialog')?.matches(':modal'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
  });

  test('closes when somebody clicks beside it', async ({ session, messages }) => {
    const page = session.page;
    const plans = messages.mealPlans as Record<string, string>;
    await page.goto('/meal-plans');
    await settled(page);
    await page.getByRole('button', { name: plans.showPlan! }).first().click();
    await page.getByRole('button', { name: plans.addCustomMeal! }).first().click();
    const dialog = page.getByRole('dialog', { name: plans.customModalTitle! });
    await expect(dialog).toBeVisible();

    // A corner of the page, which the window does not reach.
    await page.mouse.click(3, 3);

    await expect(dialog).toBeHidden();
  });
});
