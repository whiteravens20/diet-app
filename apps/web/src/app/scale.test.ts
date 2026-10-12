// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The sizes text is set in and the room between the parts of a page, stated
 * here and held to by reading the sources:
 *
 *   text      2xs 10px (the chips of a row, the label over a figure), xs 12,
 *             sm 14, base 16, lg 18, xl 20, 2xl 24, 3xl 30; larger only for
 *             the one large line of the first page a visitor sees (5xl) and
 *             of the page for an address there is nothing at (6xl)
 *   a title   the one `h1` of a page of the app is 2xl, semibold and tight;
 *             in a banner it grows to 3xl where the screen is wide enough
 *   a page    the sections of a page of the app stand 2rem apart
 *
 * A size that is not on the scale is a size nobody decided on.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const SCALE = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'];
/** The pages that are one large line, and the size of it. */
const LARGE_LINE: Record<string, string> = { 'app/page.tsx': '5xl', 'app/not-found.tsx': '6xl' };
const TITLE = 'text-2xl font-semibold tracking-tight';

/** Every component and page, by its path under `src`. Tests set no text. */
function sources(dir: string = SRC): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) return [];
    return [{ path: relative(SRC, full), text: readFileSync(full, 'utf8') }];
  });
}

const all = sources();
/** The pages of a signed-in account, one for each entry of its navigation. */
const PAGES = ['dashboard', 'profile', 'calculator', 'recipes', 'favorites', 'meal-plans', 'shopping-lists', 'inventory', 'settings'];
const page = (name: string): string => all.find((source) => source.path === `app/(app)/${name}/page.tsx`)!.text;

describe('the sizes text is set in', () => {
  it('are all on the scale: none is written out in pixels or rems', () => {
    const written = all.flatMap(({ path, text }) => (text.match(/\btext-\[[\d.]+(?:px|rem|em)\]/g) ?? []).map((size) => `${path}: ${size}`));

    expect(written).toEqual([]);
  });

  it('are the eight of the scale, and larger only for the large line of the two pages that have one', () => {
    const off = all.flatMap(({ path, text }) =>
      [...text.matchAll(/(?<![\w-])text-(\d?x[sl]|sm|base|lg)(?![\w-])/g)]
        .map((found) => found[1]!)
        .filter((size) => !SCALE.includes(size) && LARGE_LINE[path] !== size)
        .map((size) => `${path}: text-${size}`),
    );

    expect(off).toEqual([]);
    // The scale is in use from end to end: a step nothing is set in would be a step too many.
    const used = new Set(all.flatMap(({ text }) => [...text.matchAll(/(?<![\w-])text-(\d?x[sl]|sm|base|lg)(?![\w-])/g)].map((found) => found[1]!)));
    expect([...used].filter((size) => SCALE.includes(size)).sort()).toEqual([...SCALE].sort());
  });

  it('have their smallest step named in the theme, at ten pixels', () => {
    const theme = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');

    expect(theme).toMatch(/^\s*--text-2xs: 0\.625rem;$/m);
  });
});

describe('a page of the app', () => {
  it.each(PAGES)('%s has one title, of the size of every title', (name) => {
    const text = page(name);
    const own = text.match(/<h1 className="([^"]+)"/g) ?? [];
    const banners = text.match(/<PageBanner\b/g) ?? [];

    expect(own.length + banners.length, 'titles').toBe(1);
    for (const title of own) expect(title).toBe(`<h1 className="${TITLE}"`);
  });

  it('has a banner whose title is that size, and a step larger where the screen is wide enough', () => {
    const banner = all.find((source) => source.path === 'components/page-banner.tsx')!.text;

    expect(banner).toContain(`<h1 className="${TITLE} sm:text-3xl">`);
  });

  it.each(PAGES)('%s keeps its sections 2rem apart', (name) => {
    // What the page returns stands four spaces in: the element that holds its sections.
    const holders = page(name).match(/^ {4}<div className="[^"]*">$/gm) ?? [];

    expect(holders.some((holder) => /[" ](?:space-y-8|gap-8)[" ]/.test(holder)), holders.join(' | ')).toBe(true);
  });
});
