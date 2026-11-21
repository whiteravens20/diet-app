// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

test.describe('the dashboard', () => {
  test('says what the plan under way comes to while it runs, its days, and leads to the plan', async ({
    session,
    messages,
    account,
  }) => {
    const page = session.page;
    const texts = messages.planOverview as Texts;
    const titles = (messages.planOverview as unknown as { title: Texts }).title;
    await page.goto('/dashboard');
    await settled(page);

    // The account's plan began the day the account was made: it is under way.
    await expect(page.getByRole('heading', { name: titles.active!, exact: true })).toBeVisible();
    // The figures that change while the plan runs, and no other.
    for (const figure of [texts.energy!, texts.eaten!, texts.shopping!]) {
      // In the page itself: the navigation has a link of the same name as one of the figures.
      await expect(page.getByRole('main').getByText(figure, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('main').locator('dt')).toHaveCount(3);
    // The days stand as a table for whoever does not see a chart; the chart, where they differ, is fetched when shown.
    expect(
      await page.getByRole('table', { name: texts.days!, exact: true }).getByRole('row').count(),
    ).toBeGreaterThan(1);
    if ((await page.locator('[data-days-chart]').count()) > 0)
      await expect(page.locator('.recharts-wrapper').first()).toBeVisible();

    await page.getByRole('link', { name: texts.open!, exact: true }).click();
    await page.waitForURL(`**/meal-plans?profile=${account.profileId}`);
  });
});
