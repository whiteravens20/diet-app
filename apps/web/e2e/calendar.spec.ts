// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Locator, Page } from '@playwright/test';
import { expect, settled, test, type Messages } from './fixtures';

type Texts = Record<string, string>;
const plansOf = (messages: Messages): Texts => messages.mealPlans as Texts;

/** The plan page, with the calendar of the month drawn and read. */
async function theCalendar(page: Page) {
  await page.goto('/meal-plans');
  await settled(page);
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAttribute('aria-busy', 'false');
  return grid;
}

/** What the cells of the calendar draw outside themselves: a line of a day that runs into the next. */
async function outsideTheirCells(grid: Locator): Promise<string[]> {
  return grid.locator('tbody td').evaluateAll((days) =>
    days.flatMap((day) => {
      const { left, right } = day.getBoundingClientRect();
      return [...day.querySelectorAll('span, svg')]
        .filter((part) => {
          const box = part.getBoundingClientRect();
          return box.width > 0 && (box.left < left - 0.5 || box.right > right + 0.5);
        })
        .map(
          (part) =>
            `${day.querySelector('button')?.getAttribute('aria-label')}: ${part.textContent}`,
        );
    }),
  );
}

test.describe('the calendar of plans', () => {
  test('shows the plan of the account on the days it holds, and fits the screen it is on', async ({
    session,
  }) => {
    const page = session.page;
    const grid = await theCalendar(page);

    await expect(grid.getByRole('columnheader')).toHaveCount(7);
    // The account's plan began the day the account was made: the day it is holds a number of kilocalories.
    // It is drawn in the day's cell over the button, which shows the date alone and says the rest in its name.
    const today = grid.locator('button[aria-current="date"]');
    await expect(today).toHaveCount(1);
    await expect(today.locator('xpath=..')).toContainText(/\d{3}/);
    await expect(today).toHaveAccessibleName(/\d{3}/);
    // Seven days stand side by side on the narrowest screen, with nothing to scroll sideways for.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    const cells = await grid
      .locator('tbody tr')
      .first()
      .locator('button')
      .evaluateAll((week) => week.map((cell) => cell.getBoundingClientRect().width));
    expect(Math.min(...cells)).toBeGreaterThanOrEqual(36);
    // What a day's cell draws stays inside it: the date, the kilocalories and the marks beside them.
    expect(await outsideTheirCells(grid)).toEqual([]);
  });

  test('keeps the most a day can say inside its cell, on the narrowest screen too', async ({
    session,
  }) => {
    const page = session.page;
    // Every day of the account's plan as full as a day gets: four figures off its target, the meals
    // eaten and two more plans. The answer is changed on its way to the page, nothing on the server.
    await page.route('**/api/meal-plans/calendar?*', async (route) => {
      const answer = await route.fetch();
      const { days } = (await answer.json()) as { days: Record<string, unknown>[] };
      await route.fulfill({
        response: answer,
        json: {
          days: days.map((day) => ({
            ...day,
            calories: 3542,
            offTarget: 'over',
            plans: 3,
            eaten: { meals: 4, of: 5 },
            skipped: false,
          })),
        },
      });
    });
    const grid = await theCalendar(page);

    const today = grid.locator('button[aria-current="date"]').locator('xpath=..');
    await expect(today).toContainText('3542');
    expect(await outsideTheirCells(grid)).toEqual([]);
  });

  test('opens the plan of a day that is chosen, at that day', async ({
    session,
    messages,
    account,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    const grid = await theCalendar(page);

    const narrowed = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/meal-plans' &&
        new URL(res.url()).searchParams.has('from'),
    );
    await grid.locator('button[aria-current="date"]').click();

    const asked = new URL((await narrowed).url()).searchParams;
    expect(asked.get('from')).toBe(asked.get('to'));
    // The plan is open, and the reader is at the day: the day of the plan has the focus.
    const day = page.locator(`[id="plan-${account.planId}-${asked.get('from')}"]`);
    await expect(day).toBeFocused();
    await expect(page.getByRole('button', { name: plans.addCustomMeal! }).first()).toBeVisible();
    await expect(page.getByLabel(plans.from!, { exact: true })).toHaveValue(asked.get('from')!);
  });

  test('takes a day without a plan as the day the next plan begins on', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const plans = plansOf(messages);
    await theCalendar(page);
    const leaf = (messages.mealPlans as unknown as { calendar: Texts }).calendar;

    // The month after holds no plan of the account: every day of it is free.
    await page.getByRole('button', { name: leaf.next!, exact: true }).click();
    const grid = page.getByRole('grid');
    await expect(grid).toHaveAttribute('aria-busy', 'false');
    const free = grid.locator('tbody tr').nth(2).locator('button').nth(3);
    await free.click();

    const startDate = page.getByLabel(plans.startDate!, { exact: true });
    await expect(startDate).toBeFocused();
    expect(await startDate.inputValue()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await startDate.inputValue()).not.toBe(
      await page.evaluate(() => new Date().toLocaleDateString('sv-SE')),
    );
  });

  test('is moved through with the arrow keys, into the month after', async ({ session }) => {
    const page = session.page;
    const grid = await theCalendar(page);
    // The grid is named by the month it shows.
    const title = page.locator(`[id="${await grid.getAttribute('aria-labelledby')}"]`);
    const month = await title.textContent();

    // One day of the grid is a stop of the Tab key.
    expect(await grid.locator('button[tabindex="0"]').count()).toBe(1);
    await grid.locator('button[aria-current="date"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(grid.locator('button[tabindex="0"]')).toBeFocused();
    await expect(grid.locator('button[aria-current="date"]')).not.toBeFocused();

    await page.keyboard.press('PageDown');
    await expect(title).not.toHaveText(month!);
    await expect(grid.locator('button[tabindex="0"]')).toBeFocused();
  });
});
