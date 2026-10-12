// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

test.describe('the dashboard', () => {
  test('says what the plan under way comes to, draws its days, and leads to the plan', async ({ session, messages, account }) => {
    const page = session.page;
    const texts = messages.planOverview as Texts;
    const titles = (messages.planOverview as unknown as { title: Texts }).title;
    await page.goto('/dashboard');
    await settled(page);

    // The account's plan began the day the account was made: it is under way.
    await expect(page.getByRole('heading', { name: titles.active!, exact: true })).toBeVisible();
    for (const figure of [texts.energy!, texts.eaten!, texts.onDiet!, texts.favourites!, texts.reuse!, texts.shopping!]) {
      // In the page itself: the navigation has a link of the same name as one of the figures.
      await expect(page.getByRole('main').getByText(figure, { exact: true })).toBeVisible();
    }
    // The chart is fetched when the card is shown, and the same days stand beside it as a table for whoever does not see it.
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible();
    expect(await page.getByRole('table', { name: texts.days!, exact: true }).getByRole('row').count()).toBeGreaterThan(1);

    await page.getByRole('link', { name: texts.open!, exact: true }).click();
    await page.waitForURL(`**/meal-plans?profile=${account.profileId}`);
  });
});
