// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import type { Download, Page } from '@playwright/test';
import { expect, settled, test, type Messages } from './fixtures';

type Texts = Record<string, string>;

/** What a file the page handed to the browser holds, as text. */
const textOf = async (download: Download): Promise<string> => readFileSync(await download.path(), 'utf8');

/** The plan page with the first plan of the list open. */
async function anOpenPlan(page: Page, messages: Messages): Promise<void> {
  const plans = messages.mealPlans as Texts;
  await page.goto('/meal-plans');
  await settled(page);
  await page.getByRole('button', { name: plans.showPlan! }).first().click();
  await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();
}

test.describe('a shopping list, taken out of the application', () => {
  test('is copied as a text of what is still to buy, or shown to be copied by hand where the browser gives no clipboard', async ({ session, messages }) => {
    const page = session.page;
    const lists = messages.shoppingLists as Texts;
    await page.goto('/shopping-lists');
    await settled(page);

    await page.getByRole('button', { name: lists.copy!, exact: true }).click();

    // Over plain http a browser gives a page no clipboard: the text is then shown in a window, ready to be selected.
    const byHand = page.getByRole('dialog', { name: lists.copyByHand! });
    const copied = page.getByRole('status').filter({ hasText: /\d/ });
    await expect(byHand.or(copied).first()).toBeVisible();
    if (await byHand.isVisible()) {
      await expect(byHand.getByRole('textbox')).toHaveValue(new RegExp(`^${lists.copyTitle!.split(',')[0]}`));
      await page.keyboard.press('Escape');
      await expect(byHand).toBeHidden();
    }
  });

  test('is saved as a table a spreadsheet opens, with a row for every entry', async ({ session, messages }) => {
    const page = session.page;
    const lists = messages.shoppingLists as Texts;
    await page.goto('/shopping-lists');
    await settled(page);
    // The list is read after its plan is: its rows are counted once they are there.
    await expect(page.getByRole('main').getByRole('checkbox').first()).toBeVisible();
    const entries = await page.getByRole('main').getByRole('checkbox').count();

    const saved = page.waitForEvent('download');
    await page.getByRole('button', { name: lists.csv!, exact: true }).click();
    const file = await saved;

    expect(file.suggestedFilename()).toMatch(/^shopping-list-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await textOf(file);
    // It begins with the mark of UTF-8, then the heads; a row for each entry follows.
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = text.slice(1).trimEnd().split('\r\n');
    expect(rows[0]).toContain(lists.csvEntry!);
    expect(rows).toHaveLength(entries + 1);
  });

  test('says what each aisle comes to, and takes what the user says is at home', async ({ session, messages }) => {
    const page = session.page;
    const lists = messages.shoppingLists as Texts;
    await page.goto('/shopping-lists');
    await settled(page);

    await expect(page.getByText(new RegExp(lists.aisleEnergy!.split('{')[0]!)).first()).toBeVisible();

    // The first row that is not done with: somebody has a little of it at home after all. A row is known by the name it is ticked by.
    const entry = await page.getByRole('main').getByRole('checkbox', { checked: false }).first().getAttribute('aria-label');
    const atHome = page.getByRole('main').locator('li', { has: page.getByRole('checkbox', { name: entry!, exact: true }) }).getByRole('spinbutton', { name: new RegExp(`^${lists.atHome!}`) });
    const changed = () => page.waitForResponse((res) => res.request().method() === 'PATCH' && /\/api\/shopping-lists\/[^/]+\/items\/[^/]+$/.test(new URL(res.url()).pathname));
    const before = await atHome.inputValue();
    const said = changed();
    await atHome.fill('1');
    await atHome.blur();
    expect((await said).request().postDataJSON()).toEqual({ alreadyHaveQuantity: 1 });
    await expect(atHome).toHaveValue('1');

    // Back to what it was, so that the tests after this one find the list they expect.
    const restored = changed();
    await atHome.fill(before);
    await atHome.blur();
    expect((await restored).request().postDataJSON()).toEqual({ alreadyHaveQuantity: before === '' ? 0 : Number(before) });
    await expect(atHome).toHaveValue(before);
  });
});

test.describe('a plan, taken out of the application', () => {
  test('is saved as a table of its meals', async ({ session, messages }) => {
    const page = session.page;
    const words = (messages.mealPlans as unknown as { export: Texts }).export;
    await anOpenPlan(page, messages);

    const saved = page.waitForEvent('download');
    await page.getByRole('button', { name: words.csv!, exact: true }).first().click();
    const file = await saved;

    expect(file.suggestedFilename()).toMatch(/^meal-plan-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = (await textOf(file)).slice(1).trimEnd().split('\r\n');
    expect(rows[0]).toContain(words.dish!);
    // Three days of meals: more rows than days.
    expect(rows.length).toBeGreaterThan(4);
  });

  test('is handed to the printer as a sheet of the plan alone', async ({ session, messages }) => {
    const page = session.page;
    const words = (messages.mealPlans as unknown as { export: Texts }).export;
    await anOpenPlan(page, messages);
    // The browser's own window for printing cannot be driven: the page is told that it was asked for, and when it is done with.
    await page.evaluate(() => {
      const asked = window as unknown as { printAsked: number };
      asked.printAsked = 0;
      window.print = () => {
        asked.printAsked += 1;
      };
    });

    await page.getByRole('button', { name: words.print!, exact: true }).first().click();
    const sheet = page.locator('.print-sheet');
    await expect(sheet).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { printAsked: number }).printAsked)).toBe(1);
    // On a screen the sheet is not shown; to the printer it is all there is of the page.
    await expect(sheet).toBeHidden();
    await page.emulateMedia({ media: 'print' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await sheet.getByRole('row').count()).toBeGreaterThan(4);
    await expect(page.getByRole('navigation').first()).toBeHidden();
    await expect(page.getByRole('button', { name: words.print!, exact: true }).first()).toBeHidden();

    await page.emulateMedia({ media: null });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(sheet).toHaveCount(0);
  });
});

test.describe('everything an account holds', () => {
  test('is handed over as one file, whole, with the account and its profile in it and no secret', async ({ session, messages, account }) => {
    const page = session.page;
    const settings = messages.settings as Texts;
    await page.goto('/settings');
    await settled(page);

    const saved = page.waitForEvent('download');
    await page.getByRole('button', { name: settings.dataExportButton!, exact: true }).click();
    const file = await saved;

    expect(file.suggestedFilename()).toMatch(/^diet-app-account-\d{4}-\d{2}-\d{2}\.json$/);
    const text = await textOf(file);
    const held = JSON.parse(text) as { complete: boolean; account: { email: string }; profiles: { id: string }[]; plans: { id: string }[] };
    expect(held.complete).toBe(true);
    expect(held.account.email).toBe(account.email);
    expect(held.profiles.map((profile) => profile.id)).toContain(account.profileId);
    expect(held.plans.map((plan) => plan.id)).toContain(account.planId);
    expect(text.includes(account.password)).toBe(false);
    await expect(page.getByText(settings.dataExportSaved!, { exact: true })).toBeVisible();
  });
});
