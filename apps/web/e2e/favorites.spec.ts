// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, Response } from '@playwright/test';
import { expect, settled, test, type Messages } from './fixtures';

type Texts = Record<string, string>;
const textsOf = (messages: Messages): Texts => messages.favorites as Texts;

/** The answer to the next mark that is written. */
const marked = (page: Page): Promise<Response> => page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/favorites');

test.describe('the recipes a profile marked', () => {
  test('are listed on a page of their own, which the navigation leads to', async ({ session, messages }) => {
    const page = session.page;
    const texts = textsOf(messages);
    await page.goto('/favorites');
    await settled(page);

    await expect(page.getByRole('heading', { name: texts.title!, exact: true })).toBeVisible();
    // The account marked one recipe when it was made.
    await expect(page.getByRole('listitem').filter({ has: page.getByRole('combobox') })).toHaveCount(1);
    await expect(page.getByText(texts.legend!)).toBeVisible();
  });

  test('are marked another way and tagged where they are shown, and found by the tag', async ({ session, messages }) => {
    const page = session.page;
    const texts = textsOf(messages);
    const sentiments = (messages.favorites as unknown as { sentiment: Texts }).sentiment;
    await page.goto('/favorites');
    await settled(page);
    const row = page.getByRole('listitem').filter({ has: page.getByRole('combobox') }).first();
    const how = row.getByRole('combobox');
    // The two lists that narrow the page. A label that holds a list of choices reads with them, and a recipe's own tags are a list named alike: these are found as what they are, by how their name begins.
    const byTag = page.getByRole('combobox', { name: new RegExp(`^${texts.tag!}`) });
    const byMark = page.getByRole('combobox', { name: new RegExp(`^${texts.marked!}`) });

    const often = marked(page);
    await how.selectOption('often');
    expect((await often).ok()).toBe(true);
    await expect(how).toHaveValue('often');

    const tagged = marked(page);
    await row.getByRole('textbox').fill('quick');
    await row.getByRole('button', { name: texts.addTag!, exact: true }).click();
    expect((await tagged).ok()).toBe(true);
    await expect(row.getByRole('button', { name: texts.removeTag!.replace('{tag}', 'quick'), exact: true })).toBeVisible();

    // The tag is one to narrow the list by, and so is the way the recipe is marked.
    await byTag.selectOption('quick');
    await byMark.selectOption({ label: sentiments.often! });
    await expect(page.getByRole('listitem').filter({ has: page.getByRole('combobox') })).toHaveCount(1);
    await byMark.selectOption({ label: sentiments.avoid! });
    await expect(page.getByText(texts.noneFiltered!)).toBeVisible();

    // Back to what the account had, for the tests after this one: a favourite without a tag.
    await byMark.selectOption('');
    await byTag.selectOption('');
    const untagged = marked(page);
    await row.getByRole('button', { name: texts.removeTag!.replace('{tag}', 'quick'), exact: true }).click();
    expect((await untagged).ok()).toBe(true);
    const back = marked(page);
    await how.selectOption('favorite');
    expect((await back).ok()).toBe(true);
  });
});
