// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { gzipSync } from 'node:zlib';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * The most JavaScript a first visit to a page may need, in kB as a server
 * sends it compressed: the scripts the page's HTML names. What a page fetches
 * later, when somebody opens something (a chart, the printed list), is not
 * part of it, and that is the point of fetching it later.
 *
 * A budget is what the page weighed when it was last looked at, and a little
 * more. A page that goes over one has grown: either the growth is taken back
 * (what is new is fetched when it is needed, or leaves a library out), or the
 * budget is raised with the reason beside it.
 */
const BUDGETS: Record<string, number> = {
  // What anybody can open: the framework, the texts and the shell.
  '/': 190,
  '/login': 190,
  '/register': 190,
  '/forgot-password': 190,
  '/from-the-app': 190,
  '/terms': 190,
  '/offline': 190,
  // The pages of an account that load none of the contract's schemas.
  '/dashboard': 205,
  '/shopping-lists': 205,
  '/inventory': 205,
  '/settings': 210,
  '/recipes': 210,
  '/favorites': 210,
  '/admin': 215,
  '/review': 195,
  // The pages that also check what is typed or answered against the contract, which brings its schemas.
  '/profile': 240,
  '/calculator': 235,
  '/meal-plans': 260,
};

/** What every page needs: the framework and what the shell is made of. */
const SHARED_BUDGET = 185;

interface Weight {
  scripts: string[];
  kB: number;
}

/** The scripts a page's HTML names, and what they weigh together. A script for browsers without modules is one no current browser fetches. */
async function weightOf(request: APIRequestContext, path: string, sizes: Map<string, number>): Promise<Weight> {
  // The marker of a session, so that the server hands out a page of an account; the page itself is the same for everybody.
  const html = await (await request.get(path, { headers: { cookie: 'diet_session=1' } })).text();
  const scripts = [...new Set([...html.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"[^>]*>/g)].filter(([tag]) => !/nomodule/i.test(tag)).map(([, src]) => src!))];
  let bytes = 0;
  for (const script of scripts) {
    if (!sizes.has(script)) sizes.set(script, gzipSync(await (await request.get(script)).body()).length);
    bytes += sizes.get(script)!;
  }
  return { scripts, kB: Math.round(bytes / 100) / 10 };
}

test.describe('the JavaScript a first visit needs', () => {
  test('stays within the budget of every page, and of what all pages share', async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-en', 'a page weighs the same whoever reads it');
    const sizes = new Map<string, number>();
    const weights = new Map<string, Weight>();
    for (const path of Object.keys(BUDGETS)) weights.set(path, await weightOf(request, path, sizes));

    const everywhere = [...weights.values()].map((weight) => weight.scripts).reduce((shared, scripts) => shared.filter((script) => scripts.includes(script)));
    const shared = Math.round(everywhere.reduce((bytes, script) => bytes + sizes.get(script)!, 0) / 100) / 10;
    const table = [...weights].map(([path, weight]) => `${path.padEnd(18)} ${String(weight.kB).padStart(6)} kB of ${BUDGETS[path]}`).concat(`${'shared by all'.padEnd(18)} ${String(shared).padStart(6)} kB of ${SHARED_BUDGET}`);
    console.log(table.join('\n'));
    await testInfo.attach('weights', { body: table.join('\n'), contentType: 'text/plain' });

    // The measurement measures: a page whose scripts were not found would weigh nothing, and pass.
    for (const [path, weight] of weights) expect(weight.scripts.length, `${path} names its scripts`).toBeGreaterThan(5);
    expect(shared).toBeGreaterThan(100);

    const over = [...weights].filter(([path, weight]) => weight.kB > BUDGETS[path]!).map(([path, weight]) => `${path}: ${weight.kB} kB, budget ${BUDGETS[path]}`);
    if (shared > SHARED_BUDGET) over.push(`shared by all pages: ${shared} kB, budget ${SHARED_BUDGET}`);
    expect(over).toEqual([]);
  });
});
