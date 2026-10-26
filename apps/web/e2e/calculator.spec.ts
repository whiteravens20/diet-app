// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

test.describe('the calculator', () => {
  test("begins with the figures of the account's profile, follows what is typed over them, and keeps none of it", async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const texts = messages.calculator as Texts;
    const profile = messages.profile as Texts;
    const preview = messages.caloriePreview as Texts;
    // Whatever is sent for keeping while the calculator is used. The session's own requests keep nothing of what is typed.
    const sent: string[] = [];
    const watch = (request: { method(): string; url(): string }): void => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() !== 'GET' &&
        path !== '/api/profiles/calories' &&
        !path.startsWith('/api/auth/')
      )
        sent.push(`${request.method()} ${path}`);
    };
    page.on('request', watch);

    await page.goto('/calculator');
    await settled(page);
    await expect(page.getByRole('heading', { name: texts.title!, level: 1 })).toBeVisible();
    // The account's one profile: a man of 30.
    await expect(page.getByLabel(profile.age!, { exact: true })).toHaveValue('30');
    const target = page
      .locator('section', { has: page.getByRole('heading', { name: preview.title!, exact: true }) })
      .locator('dd')
      .first();
    await expect(target).toHaveText(/\d.*kcal/);
    const before = await target.textContent();

    // Somebody who moves much more uses more: the target follows.
    await page.getByLabel(new RegExp(`^${profile.activityLevel!}`)).selectOption('very_active');
    await expect(target).not.toHaveText(before!);

    // The empty form asks for the figures again.
    await page
      .getByRole('group', { name: texts.startFrom!, exact: true })
      .getByRole('button', { name: texts.empty!, exact: true })
      .click();
    await expect(page.getByLabel(profile.age!, { exact: true })).toHaveValue('');
    await expect(page.getByText(preview.pending!, { exact: true })).toBeVisible();

    page.off('request', watch);
    expect(sent).toEqual([]);
    // The profile is as it was: the calculator reads it again when the page is opened.
    await page.reload();
    await settled(page);
    await expect(page.getByLabel(new RegExp(`^${profile.activityLevel!}`))).toHaveValue('moderate');
  });
});
