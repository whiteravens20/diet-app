// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aCacheStorage } from '@/testing/cache-storage';

const ORIGIN = 'https://diet.example.test';
const SOURCE = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');

type Listener = (event: Record<string, unknown>) => void;

/** A page as the web server answers it, naming the files it is built from. */
const aPage = (name: string): string =>
  `<html><head><link rel="stylesheet" href="/_next/static/css/${name}.css"></head><body>${name}<script src="/_next/static/chunks/${name}.js" nonce="n"></script></body></html>`;

/**
 * The worker, run as a browser runs it: with a scope of its own to listen
 * in, a cache storage, and a network that `server` answers for. A path the
 * server has no answer for is one that cannot be reached.
 */
function aWorker(server: Record<string, () => Response>) {
  const listeners = new Map<string, Listener>();
  const stores = aCacheStorage();
  const asked: string[] = [];
  let reachable = true;
  const fetchFrom = vi.fn(async (request: string | Request) => {
    const path =
      typeof request === 'string'
        ? request
        : new URL(request.url).pathname + new URL(request.url).search;
    asked.push(path);
    // The server answers a page whatever it was asked with.
    const answer = reachable ? (server[path] ?? server[path.split('?')[0]!]) : undefined;
    if (!answer) throw new TypeError('Failed to fetch');
    return answer();
  });
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  new Function('self', 'caches', 'fetch', SOURCE)(scope, stores, fetchFrom);

  /** Tell the worker of something, and wait for what it does about it. */
  const told = async (type: string, event: Record<string, unknown> = {}): Promise<void> => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ ...event, waitUntil: (work: Promise<unknown>) => waits.push(work) });
    await Promise.all(waits);
  };
  /** What the worker answers a request with, or nothing when it leaves the request to the browser. */
  const answerTo = async (
    path: string,
    init: { method?: string; mode?: string; origin?: string } = {},
  ): Promise<Response | undefined> => {
    let answer: Promise<Response> | undefined;
    const request = Object.assign(
      new Request(`${init.origin ?? ORIGIN}${path}`, { method: init.method ?? 'GET' }),
      {},
    );
    Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' });
    listeners.get('fetch')!({ request, respondWith: (work: Promise<Response>) => (answer = work) });
    return answer;
  };
  return {
    stores,
    asked,
    scope,
    told,
    answerTo,
    offline: () => (reachable = false),
    online: () => (reachable = true),
  };
}

const html =
  (body: string, init: ResponseInit = {}) =>
  () => {
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html' },
      ...init,
    });
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  };
const file = (body: string) => () => new Response(body, { status: 200 });

describe('the service worker of the web application', () => {
  let worker: ReturnType<typeof aWorker>;

  beforeEach(() => {
    worker = aWorker({
      '/offline': html(aPage('offline')),
      '/shopping-lists': html(aPage('lists')),
      '/meal-plans': html(aPage('plans')),
      '/_next/static/css/offline.css': file('offline css'),
      '/_next/static/chunks/offline.js': file('offline js'),
      '/_next/static/css/lists.css': file('lists css'),
      '/_next/static/chunks/lists.js': file('lists js'),
      '/_next/static/css/plans.css': file('plans css'),
      '/_next/static/chunks/plans.js': file('plans js'),
      '/imagery/shopping.webp': file('a picture'),
    });
  });

  it('keeps the page that stands in for the others, with its files, when it is installed, and takes over at once', async () => {
    await worker.told('install');

    expect(await worker.stores.held('diet-app.pages.v1')).toEqual(['/offline']);
    expect((await worker.stores.held('diet-app.files.v1')).sort()).toEqual([
      '/_next/static/chunks/offline.js',
      '/_next/static/css/offline.css',
    ]);
    expect(worker.scope.skipWaiting).toHaveBeenCalled();
  });

  it('is installed all the same when that page cannot be read', async () => {
    worker.offline();

    await worker.told('install');

    expect(worker.scope.skipWaiting).toHaveBeenCalled();
  });

  it("removes what an earlier version of it kept, and nothing else of the browser's", async () => {
    await (await worker.stores.open('diet-app.pages.v0')).put('/old', new Response('old'));
    await (await worker.stores.open('diet-app.files.v0')).put('/old.js', new Response('old'));
    await (
      await worker.stores.open('diet-app.offline.an-account')
    ).put('/kept', new Response('kept'));

    await worker.told('activate');

    expect(worker.stores.names()).toEqual(['diet-app.offline.an-account']);
    expect(worker.scope.clients.claim).toHaveBeenCalled();
  });

  it("answers a page with the server's, and keeps it for when the server cannot be reached", async () => {
    const first = await worker.answerTo('/shopping-lists?plan=1', { mode: 'navigate' });
    expect(await first!.text()).toContain('lists');

    worker.offline();
    const later = await worker.answerTo('/shopping-lists', { mode: 'navigate' });

    expect(await later!.text()).toContain('lists');
  });

  it('answers a page that was never opened with the one that says so', async () => {
    await worker.told('install');
    worker.offline();

    const answer = await worker.answerTo('/recipes', { mode: 'navigate' });

    expect(await answer!.text()).toContain('offline');
  });

  it('keeps no page the server sent elsewhere or refused', async () => {
    const away = aWorker({
      '/dashboard': () => {
        const response = new Response('the sign-in page', { status: 200 });
        Object.defineProperty(response, 'type', { value: 'basic' });
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      },
      '/broken': html('an error', { status: 500 }),
    });

    await away.answerTo('/dashboard', { mode: 'navigate' });
    await away.answerTo('/broken', { mode: 'navigate' });

    expect(await away.stores.held('diet-app.pages.v1')).toEqual([]);
  });

  it('answers a file of the build from what it kept, without asking the server twice', async () => {
    const first = await worker.answerTo('/_next/static/chunks/lists.js');
    const again = await worker.answerTo('/_next/static/chunks/lists.js');
    await worker.answerTo('/imagery/shopping.webp');
    worker.offline();
    const without = await worker.answerTo('/_next/static/chunks/lists.js');

    expect([await first!.text(), await again!.text(), await without!.text()]).toEqual([
      'lists js',
      'lists js',
      'lists js',
    ]);
    expect(worker.asked.filter((path) => path === '/_next/static/chunks/lists.js')).toHaveLength(1);
    // A picture is such a file too.
    expect(await (await worker.answerTo('/imagery/shopping.webp'))!.text()).toBe('a picture');
  });

  it.each([
    ['a request to the API', '/api/shopping-lists?planId=1', {}],
    ['a request that changes something', '/shopping-lists', { method: 'POST', mode: 'navigate' }],
    ['a request of the page that is neither a page nor a file', '/meal-plans?_rsc=abc', {}],
    [
      'a request to another site',
      '/shopping-lists',
      { mode: 'navigate', origin: 'https://elsewhere.example.test' },
    ],
  ])('leaves %s to the browser', async (_what, path, init) => {
    expect(await worker.answerTo(path, init)).toBeUndefined();
    expect(worker.asked).toEqual([]);
  });

  it('keeps the pages it is told to keep ahead, with their files, and leaves alone one it has', async () => {
    await worker.answerTo('/meal-plans', { mode: 'navigate' });
    worker.asked.length = 0;

    await worker.told('message', {
      origin: ORIGIN,
      data: { type: 'keep-pages', pages: ['/shopping-lists', '/meal-plans'] },
    });

    expect((await worker.stores.held('diet-app.pages.v1')).sort()).toEqual([
      '/meal-plans',
      '/shopping-lists',
    ]);
    expect((await worker.stores.held('diet-app.files.v1')).sort()).toEqual([
      '/_next/static/chunks/lists.js',
      '/_next/static/css/lists.css',
    ]);
    expect(worker.asked).not.toContain('/meal-plans');
  });

  it.each([
    [
      'is not a plain path of the application',
      ['/api/users/me', 'https://elsewhere.example.test/x', '/meal-plans/../api', '//elsewhere', 7],
    ],
    ['is no list', '/shopping-lists'],
  ])('keeps nothing ahead that %s', async (_why, pages) => {
    await worker.told('message', { origin: ORIGIN, data: { type: 'keep-pages', pages } });
    await worker.told('message', {
      origin: ORIGIN,
      data: { type: 'something-else', pages: ['/shopping-lists'] },
    });
    await worker.told('message', { origin: ORIGIN, data: null });

    expect(worker.asked).toEqual([]);
  });

  it('takes no word from anything but a page of the application', async () => {
    await worker.told('message', {
      origin: 'https://elsewhere.example.test',
      data: { type: 'keep-pages', pages: ['/shopping-lists'] },
    });
    await worker.told('message', { data: { type: 'keep-pages', pages: ['/shopping-lists'] } });

    expect(worker.asked).toEqual([]);
  });

  it('holds no more pages than it has room for: the ones kept longest go first', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`/recipes/${index}`, html(`recipe ${index}`)]),
    );
    const full = aWorker(many);

    for (const path of Object.keys(many)) await full.answerTo(path, { mode: 'navigate' });

    const kept = await full.stores.held('diet-app.pages.v1');
    expect(kept).toHaveLength(60);
    expect(kept).not.toContain('/recipes/0');
    expect(kept).toContain('/recipes/64');
  });
});
