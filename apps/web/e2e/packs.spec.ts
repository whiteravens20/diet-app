// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page } from '@playwright/test';
import { barriers, expect, loose, settled, test, theFormForAPlan, type Messages } from './fixtures';

type Texts = Record<string, string>;

/** What is said of a dish cooked for two days. */
interface CookingTexts {
  cookDays: string;
  cookHint: string;
  fromHint: string;
  dayFrom: Record<string, string>;
}

/** What a text says before the first thing that is put into it. */
const start = (text: string): string => text.split('{')[0]!;

/** The plan page with the first plan of the list open. */
async function anOpenPlan(page: Page, messages: Messages): Promise<void> {
  const plans = messages.mealPlans as Texts;
  await page.goto('/meal-plans');
  await settled(page);
  await page.getByRole('button', { name: plans.showPlan! }).first().click();
  await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();
}

test.describe('a plan and the packs it opens', () => {
  test('says how much it uses of the packs that do not keep, and unfolds into what it leaves of them', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const packs = (messages.mealPlans as unknown as { packs: Texts }).packs;
    await anOpenPlan(page, messages);

    const line = page
      .locator('summary')
      .filter({ hasText: start(packs.line!) })
      .first();
    await expect(line).toBeVisible();
    await expect(line).toHaveText(/\d+\s?%/);

    await line.click();
    const unfolded = line.locator('xpath=..');
    await expect(unfolded.getByText(packs.explain!)).toBeVisible();
    // The packs that are not finished, each with what is left of it; or the line that says every pack is used up.
    await expect(
      unfolded.getByRole('listitem').first().or(unfolded.getByText(packs.allFinished!)),
    ).toBeVisible();
    expect(await barriers(page), 'the plan with its packs unfolded').toEqual([]);
  });
});

test.describe('a plan made for cooking ahead', () => {
  test('is asked for in the form, and marks the dish that is cooked once and the meal that is eaten from it', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const plans = messages.mealPlans as Texts;
    await page.goto('/meal-plans');
    await settled(page);
    await theFormForAPlan(page, messages);

    await page.getByLabel(plans.mealPrepFriendly!, { exact: true }).check();
    const answered = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/meal-plans/generate',
    );
    await page.getByRole('button', { name: plans.generateButton!, exact: true }).click();

    const answer = await answered;
    expect(answer.request().postDataJSON()).toMatchObject({ mealPrepFriendly: true });
    const made = (await answer.json()) as {
      id: string;
      days: { meals: { cookAhead: 'cook' | 'cooked' | null }[] }[];
    };
    const marks = made.days.flatMap((day) => day.meals.map((meal) => meal.cookAhead));
    // What is cooked once is eaten at least once more.
    expect(marks.filter((mark) => mark === 'cook').length).toBeGreaterThan(0);
    expect(marks.filter((mark) => mark === 'cooked').length).toBeGreaterThanOrEqual(
      marks.filter((mark) => mark === 'cook').length,
    );

    // The new plan opens by itself, and with its days unfolded says it of the meals.
    const folded = page.locator(`[id^="plan-${made.id}-"] > button[aria-expanded="false"]`);
    await expect(folded).not.toHaveCount(0);
    while ((await folded.count()) > 0) await folded.first().click();
    const cooking = (messages.mealPlans as unknown as { cooking: CookingTexts }).cooking;
    const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
    const fromADay = new RegExp(
      `^(${Object.values(cooking.dayFrom)
        .map((day) => loose(capitalised(day)))
        .join('|')})$`,
    );
    await expect(page.getByText(cooking.cookDays, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(fromADay).first()).toBeVisible();
    await expect(
      page.getByText(new RegExp(`^${loose(start(cooking.cookHint))}`)).first(),
    ).toBeVisible();
    await expect(
      page.getByText(new RegExp(`^${loose(start(cooking.fromHint))}`)).first(),
    ).toBeVisible();

    // The dish cooked once is split, from the meal it is cooked at, into the meals it is eaten at: whole grams
    // that add up to what was weighed, and the risk said beside them.
    const split = messages.split as unknown as Texts;
    await page.getByRole('button', { name: split.open!, exact: true }).first().click();
    const splitting = page.getByRole('dialog', { name: split.title! });
    await expect(splitting.getByText(split.risk!)).toBeVisible();
    await splitting.getByLabel(split.onScale!).fill('1001');
    const rows = await splitting.getByRole('listitem').allTextContents();
    const grams = rows.map((row) => Number(/(\d+)[\s\u00a0]g$/.exec(row)?.[1]));
    expect(grams.length).toBeGreaterThanOrEqual(2);
    expect(grams.reduce((sum, one) => sum + one, 0)).toBe(1001);
    expect(await barriers(page)).toEqual([]);
    await splitting
      .getByRole('button', { name: (messages.common as Texts).close!, exact: true })
      .click();
    await expect(splitting).toHaveCount(0);

    // The plan was made for this test. It goes again, so that the tests after this one find what the account had.
    page.once('dialog', (confirm) => void confirm.accept());
    const gone = page.waitForResponse(
      (res) =>
        res.request().method() === 'DELETE' &&
        new URL(res.url()).pathname === `/api/meal-plans/${made.id}`,
    );
    const head = page.getByRole('button', { name: plans.hidePlan! });
    await head
      .locator('xpath=..')
      .getByRole('button', { name: (messages.common as Texts).delete!, exact: true })
      .click();
    expect((await gone).status()).toBe(204);
    await expect(head).toHaveCount(0);
  });
});

test.describe('a shopping list and the packs things are sold in', () => {
  test('says how many packs a row takes, takes the row for bought when that is pressed, and gives it back when the tick is taken off', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const lists = messages.shoppingLists as Texts;
    const main = page.getByRole('main');
    await page.goto('/shopping-lists');
    await settled(page);
    await expect(main.getByRole('checkbox').first()).toBeVisible();

    await expect(main.getByText(lists.packsHint!)).toBeVisible();
    // The first row that says its packs: "2 × 250 g". A row is known by the name it is ticked by.
    const offered = main
      .locator('li', { has: page.getByRole('button', { name: start(lists.buyPacks!) }) })
      .first();
    const entry = await offered.getByRole('checkbox').getAttribute('aria-label');
    const row = main.locator('li', {
      has: page.getByRole('checkbox', { name: entry!, exact: true }),
    });
    const packs = row.getByRole('button', { name: start(lists.buyPacks!) });
    await expect(packs).toHaveText(/^\d+ × \d+/);

    const changed = () =>
      page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          /\/api\/shopping-lists\/[^/]+\/items\/[^/]+$/.test(new URL(res.url()).pathname),
      );
    const pressed = changed();
    await packs.click();
    const sent = (await pressed).request().postDataJSON() as {
      purchasedQuantity: number;
      checked: boolean;
    };
    expect(sent.checked).toBe(true);
    expect(sent.purchasedQuantity).toBeGreaterThan(0);
    // The row is done, has what the packs hold as bought, and offers them no more.
    await expect(row.getByRole('checkbox')).toBeChecked();
    await expect(
      row.getByRole('spinbutton', { name: new RegExp(`^${loose(lists.bought!)}`) }),
    ).not.toHaveValue('');
    await expect(packs).toHaveCount(0);

    // The tick is taken off, so that the tests after this one find the row as it was: nothing bought, and the packs offered.
    const takenBack = changed();
    await row.getByRole('checkbox').click();
    await takenBack;
    await expect(row.getByRole('checkbox')).not.toBeChecked();
    await expect(packs).toBeVisible();
  });
});
