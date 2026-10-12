// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { expect, settled, test } from './fixtures';

/** How long the animations and transitions of the page run, in milliseconds, the longest first. */
const durations = (): number[] => {
  const all: number[] = [];
  for (const element of document.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    for (const value of [...style.animationDuration.split(','), ...style.transitionDuration.split(',')]) {
      const seconds = value.trim().endsWith('ms') ? Number.parseFloat(value) / 1000 : Number.parseFloat(value);
      const named = style.animationName !== 'none' || style.transitionProperty !== 'none';
      if (named && Number.isFinite(seconds)) all.push(seconds * 1000);
    }
  }
  return all.sort((a, b) => b - a);
};

test.describe('somebody who asked their system for less motion', () => {
  test('gets a page on which nothing moves for longer than the blink of an eye', async ({ session }) => {
    const page = session.page;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dashboard');
    await settled(page);

    const [longest] = await page.evaluate(durations);

    expect(longest ?? 0).toBeLessThan(1);
  });

  test('is the only one who gets that: without the wish the tiles of the dashboard come in', async ({ session }) => {
    const page = session.page;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/dashboard');
    await settled(page);

    const tile = page.locator('.rise-in').first();
    await expect(tile).toBeVisible();
    expect(await tile.evaluate((element) => getComputedStyle(element).animationName)).toBe('rise-in');

    await page.emulateMedia({ reducedMotion: 'reduce' });
  });
});
