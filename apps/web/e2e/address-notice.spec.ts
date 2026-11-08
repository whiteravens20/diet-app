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
    // An instance that sends mail, and an account whose address nobody confirmed: the answers are changed on
    // their way to the page, nothing on the server, so that an instance without mail shows the notice too.
    await page.route('**/api/config', async (route) => {
      const answer = await route.fetch();
      const config = (await answer.json()) as { email: Record<string, unknown> };
      await route.fulfill({
        response: answer,
        json: { ...config, email: { ...config.email, enabled: true } },
      });
    });
    // Every answer about the account: the page saves its time zone as it opens, and takes the account it gets back.
    await page.route('**/api/users/me', async (route) => {
      const answer = await route.fetch();
      await route.fulfill({
        response: answer,
        json: { ...((await answer.json()) as object), emailVerified: false },
      });
    });
    // Whatever an earlier test of this browser put aside.
    await page.addInitScript(() => localStorage.removeItem('diet-app.confirm-email.later'));
    await page.goto('/dashboard');
    await settled(page);
    const later = page.getByRole('button', { name: texts.later!, exact: true });
    const notice = page.getByRole('status').filter({ has: later });
    await expect(notice).toBeVisible();

    const screenSize = page.viewportSize()!;
    const box = (await notice.boundingBox())!;
    expect(Math.abs(box.y + box.height - screenSize.height)).toBeLessThan(2);
    // A narrow screen says one sentence, and the whole at "Details": the bar takes less than a fifth of it.
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
