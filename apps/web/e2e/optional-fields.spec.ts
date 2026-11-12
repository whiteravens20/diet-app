// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page } from '@playwright/test';
import { expect, settled, test, theFormForAPlan, type Messages } from './fixtures';

type Texts = Record<string, string>;
const textsOf = (messages: Messages, group: string): Texts => messages[group] as Texts;

/**
 * Every text of the page that the word saying a field may stay empty is drawn over. The word is the
 * `::after` of the field's frame, at the right of its top edge and half above it, so its box is worked
 * out from the frame's and from the letters it is drawn in.
 */
const underTheWord = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const pen = document.createElement('canvas').getContext('2d')!;
    const lines: { rect: DOMRect; text: string; node: Node }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text || node.parentElement?.closest('select, script, style')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width && rect.height) lines.push({ rect, text, node });
      }
    }
    const under: string[] = [];
    for (const frame of document.querySelectorAll<HTMLElement>('[data-optional]')) {
      if (!frame.checkVisibility()) continue;
      const mark = getComputedStyle(frame, '::after');
      const word = frame.dataset.optional ?? '';
      pen.font = `${mark.fontWeight} ${mark.fontSize} ${mark.fontFamily}`;
      const width =
        pen.measureText(word).width + parseFloat(mark.paddingLeft) + parseFloat(mark.paddingRight);
      const height = parseFloat(mark.lineHeight) || parseFloat(mark.fontSize);
      const edge = frame.getBoundingClientRect();
      const right = edge.right - parseFloat(mark.right);
      const top = edge.top - height / 2;
      for (const { rect, text, node } of lines) {
        if (frame.contains(node)) continue;
        if (
          rect.left < right &&
          rect.right > right - width &&
          rect.top < top + height &&
          rect.bottom > top
        ) {
          under.push(`"${word}" over "${text.slice(0, 40)}"`);
        }
      }
    }
    return under;
  });

// On every project: whether a label reaches under the word depends on its language as much as on the screen.
test.describe('the word that says a field may stay empty is drawn over no text', () => {
  test('of what is added to the pantry', async ({ session }) => {
    const page = session.page;
    await page.goto('/inventory');
    await settled(page);
    await expect(page.locator('[data-optional]')).not.toHaveCount(0);

    expect(await underTheWord(page)).toEqual([]);
  });

  test('of the form for a plan, its advanced options open', async ({ session, messages }) => {
    const page = session.page;
    const advanced = (messages.mealPlans as unknown as { advanced: Texts }).advanced;
    await page.goto('/meal-plans');
    await settled(page);
    await theFormForAPlan(page, messages);
    await page.locator('summary', { hasText: advanced.toggle! }).click();
    await expect(page.locator('#adv-maxRepeats')).toBeVisible();

    expect(await underTheWord(page)).toEqual([]);
  });

  test('of the limits on one kind of protein, an exception among them', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    await page.goto('/profile');
    await settled(page);
    await page
      .getByRole('button', { name: textsOf(messages, 'common').edit!, exact: true })
      .first()
      .click();
    await page
      .getByRole('button', { name: textsOf(messages, 'profile').addKindLimit!, exact: true })
      .click();
    await expect(page.locator('input[name="kindLimitPerDay"]')).toBeVisible();

    expect(await underTheWord(page)).toEqual([]);
  });

  test('of the days a shopping list is made for', async ({ session }) => {
    const page = session.page;
    await page.goto('/shopping-lists');
    await settled(page);
    await expect(page.locator('[data-optional]')).not.toHaveCount(0);

    expect(await underTheWord(page)).toEqual([]);
  });
});
