// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

type Texts = Record<string, string>;

test.describe('the notice of an address that is not confirmed', () => {
  test('stands at the bottom of the screen, and the page stays where it is when it goes', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const texts = messages.confirmEmail as Texts;
    await page.goto('/dashboard');
    await settled(page);
    const later = page.getByRole('button', { name: texts.later!, exact: true });
    // The account of the tests has an address nobody confirmed, on an instance that sends mail; a run that
    // put the notice aside already has nothing to say of it.
    test.skip(!(await later.isVisible()), 'The notice was put aside on this browser before.');
    const notice = page.getByRole('status').filter({ has: later });

    const screenSize = page.viewportSize()!;
    const box = (await notice.boundingBox())!;
    expect(Math.abs(box.y + box.height - screenSize.height)).toBeLessThan(2);
    // A narrow screen says one sentence, and the whole at "More": the bar takes less than a fifth of it.
    const more = notice.getByRole('button', { name: texts.more!, exact: true });
    // The sentence of the instance's kind: one where confirming unlocks its AI says so.
    const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sentence = notice.getByText(
      new RegExp(`^(${escaped(texts.shortPlain!)}|${escaped(texts.shortAi!)})`),
    );
    if (screenSize.width < 640) {
      expect(box.height).toBeLessThan(screenSize.height / 5);
      await expect(sentence).toBeVisible();
      await more.click();
      await expect(sentence).toBeHidden();
      // The whole names the address.
      await expect(notice.getByText(/@/)).toBeVisible();
    } else {
      await expect(more).toBeHidden();
    }
    // What a person reads stays put as the notice goes: it took no room above it.
    const heading = page.getByRole('heading', { level: 1 }).first();
    const before = (await heading.boundingBox())!.y;
    await later.click();
    await expect(notice).toBeHidden();
    expect((await heading.boundingBox())!.y).toBe(before);
  });
});
