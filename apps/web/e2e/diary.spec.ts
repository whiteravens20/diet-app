// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Response } from '@playwright/test';
import { barriers, expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

/** The answer to the next request of `method` to `path` of the API. */
const answered = (page: Page, method: string, path: string): Promise<Response> =>
  page.waitForResponse(
    (res) => res.request().method() === method && new URL(res.url()).pathname.startsWith(path),
  );

test.describe('the diary of a day', () => {
  test("takes a meal of one's own beside the plan, shows it under its meal, and lets it go again", async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const diary = messages.diary as Texts;
    const meals = (messages.enums as unknown as { mealType: Texts }).mealType;
    const name = `Snack ${Date.now().toString(36)}`;

    await page.goto('/diary');
    await settled(page);
    // The account's plan begins today: its breakfast stands under the day's breakfast.
    await expect(page.getByRole('region', { name: meals.breakfast! })).toBeVisible();

    await page.getByRole('button', { name: diary.addTitle!, exact: true }).click();
    const window = page.getByRole('dialog', { name: diary.addTitle! });
    await window.getByRole('radio', { name: diary.kindMeal! }).check();
    await expect(window.getByLabel(diary.mealName!, { exact: true })).toBeVisible();
    expect(await barriers(page), 'the window an entry is added in').toEqual([]);

    await window.getByRole('combobox', { name: diary.mealLabel! }).selectOption('snack');
    await window.getByLabel(diary.mealName!, { exact: true }).fill(name);
    await window.getByLabel(diary.calories!, { exact: true }).fill('150');
    const written = answered(page, 'POST', '/api/diary/entries');
    await window.getByRole('button', { name: diary.submit!, exact: true }).click();
    expect((await written).status()).toBe(201);

    // Written by its energy alone: its macronutrients are an estimate, and it says so in words.
    const snack = page.getByRole('region', { name: meals.snack! });
    await expect(snack.getByText(name)).toBeVisible();
    await expect(snack.getByText(`≈ ${diary.estimated}`)).toBeVisible();
    expect(await barriers(page), 'the day with the entry').toEqual([]);

    // Taken away again, so that the plan's day is as the other tests find it.
    const removed = answered(page, 'DELETE', '/api/diary/entries/');
    await snack.getByRole('button', { name: diary.removeLabel!.replace('{name}', name) }).click();
    expect((await removed).status()).toBe(204);
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test('takes no new entry for a day more than a year back, and says so', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const diary = messages.diary as Texts;
    const long = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);

    await page.goto(`/diary?date=${long}`);
    await settled(page);

    await expect(page.getByText(diary.tooOldNote!)).toBeVisible();
    await expect(page.getByText(diary.emptyText!)).toHaveCount(0);
    await expect(page.getByRole('button', { name: diary.addTitle!, exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: diary.copyTitle! })).toHaveCount(0);
    expect(await barriers(page), 'a day too far back').toEqual([]);
  });
});
