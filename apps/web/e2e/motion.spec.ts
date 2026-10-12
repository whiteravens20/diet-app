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

  test('is the only one for whom a page takes the place of another at once: without the wish it fades in', async ({ session }) => {
    const page = session.page;
    /** How the page that is shown comes in: the name of its animation and how long it runs, in milliseconds. */
    const comesIn = () =>
      page.locator('main .page-in').evaluate((element) => {
        const style = getComputedStyle(element);
        return { name: style.animationName, ms: Number.parseFloat(style.animationDuration) * (style.animationDuration.trim().endsWith('ms') ? 1 : 1000) };
      });

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/settings');
    await settled(page);
    expect(await comesIn()).toEqual({ name: 'page-in', ms: 160 });
    // A fade of opacity alone: the page is not moved, so what it holds in a fixed place stays where it is.
    expect(await page.locator('main .page-in').evaluate((element) => getComputedStyle(element).transform)).toBe('none');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await comesIn()).ms).toBeLessThan(1);
  });
});
