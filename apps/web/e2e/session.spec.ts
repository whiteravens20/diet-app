// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page, TestInfo } from '@playwright/test';
import { expect, settled, test } from './fixtures';

/** A word the configuration never holds, put into it by the first test on its way to the page. */
const CHANGED = 'changed-by-the-test-before';

/** The session is given back alike in both engines: two projects say it. */
const elsewhere = (testInfo: TestInfo): boolean =>
  !['desktop-en', 'iphone-pl'].includes(testInfo.project.name);

/** What the page is answered when it asks for the configuration itself. */
const configuration = (page: Page): Promise<string> =>
  page.evaluate(() => fetch('/api/config').then((res) => res.text()));

// The second test reads the session the first one left: one after the other, on one worker.
test.describe.configure({ mode: 'serial' });

test.describe('the session the tests of a project share', () => {
  test('is changed by a test as the test needs it: an answer, the media and the size', async ({
    session,
  }, testInfo) => {
    test.skip(elsewhere(testInfo), 'two projects say it');
    const page = session.page;
    await page.route('**/api/config', async (route) => {
      const answer = await route.fetch();
      await route.fulfill({
        response: answer,
        json: { ...((await answer.json()) as object), marked: CHANGED },
      });
    });
    await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto('/dashboard');
    await settled(page);

    expect(await configuration(page)).toContain(CHANGED);
    expect(await page.evaluate(() => matchMedia('print').matches)).toBe(true);
  });

  test('is given back to the next test as the project has it', async ({ session }, testInfo) => {
    test.skip(elsewhere(testInfo), 'two projects say it');
    const page = session.page;
    await page.goto('/dashboard');
    await settled(page);

    expect(await configuration(page)).not.toContain(CHANGED);
    expect(await page.evaluate(() => matchMedia('print').matches)).toBe(false);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      testInfo.project.use.reducedMotion === 'reduce',
    );
    expect(page.viewportSize()).toEqual(testInfo.project.use.viewport);
  });
});
