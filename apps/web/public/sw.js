// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/*
 * The service worker of the web application. It keeps the shell: the pages a
 * browser has opened and the files they are built from, so that a page opens
 * again when the server cannot be reached. A page that was never opened is
 * answered with one that says so.
 *
 * It never answers for the API, and keeps nothing of an account: what an
 * account read last is kept by the pages themselves (src/lib/offline.ts), for
 * one account at a time. A page as the server sends it is the same for
 * everybody, whoever is signed in.
 */

const VERSION = 'v1';
const PAGES = `diet-app.pages.${VERSION}`;
const FILES = `diet-app.files.${VERSION}`;
/** The page shown in the place of one that cannot be: it is read when the worker is installed. */
const OFFLINE_PAGE = '/offline';
/** The most pages and files that are kept; the ones kept longest go first. */
const MOST_PAGES = 60;
const MOST_FILES = 400;
/** What a page is built from, and never changes under its address: the files of the build, the pictures, the fonts, the icons. */
const FILE = /^\/(_next\/static\/|_next\/image|imagery\/|fonts\/|icon[.-]|apple-touch-icon\.png$)/;
/** A page that may be kept ahead of its first use: a plain path of the application, and nothing of the API. */
const A_PAGE = /^\/[a-z][a-z-]*$/;

/** Keep no more than `most` of what a store holds. */
async function trimmed(store, most) {
  const keys = await store.keys();
  for (const oldest of keys.slice(0, Math.max(0, keys.length - most))) await store.delete(oldest);
}

/** A file of the build: the one that was kept, or the server's, which is kept from then on. */
async function fileFirst(request) {
  const files = await caches.open(FILES);
  const kept = await files.match(request, { ignoreVary: true });
  if (kept) return kept;
  const answer = await fetch(request);
  if (answer.ok) {
    await files.put(request, answer.clone()).catch(() => undefined);
    await trimmed(files, MOST_FILES);
  }
  return answer;
}

/**
 * A page: the server's, which is kept for later; without the server, the one
 * that was kept, or the page that says there is none. A page the server sent
 * elsewhere (to sign in) is not kept.
 */
async function pageFromServer(request, path) {
  const pages = await caches.open(PAGES);
  try {
    const answer = await fetch(request);
    if (answer.ok && answer.type === 'basic' && !answer.redirected) {
      await pages.put(path, answer.clone()).catch(() => undefined);
      await trimmed(pages, MOST_PAGES);
    }
    return answer;
  } catch {
    return (
      (await pages.match(path, { ignoreVary: true })) ||
      (await pages.match(OFFLINE_PAGE, { ignoreVary: true })) ||
      Response.error()
    );
  }
}

/**
 * Read a page from the server and keep it with the files it names, so that it
 * opens without the server although no browser window has opened it yet.
 */
async function keepPage(path) {
  const answer = await fetch(path, { credentials: 'same-origin', redirect: 'manual' });
  if (!answer.ok) return;
  const pages = await caches.open(PAGES);
  await pages.put(path, answer.clone());
  const files = await caches.open(FILES);
  const named = new Set(
    Array.from(
      (await answer.text()).matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g),
      (found) => found[1],
    ),
  );
  await Promise.all(
    Array.from(named, async (file) => {
      if (await files.match(file, { ignoreVary: true })) return;
      const got = await fetch(file);
      if (got.ok) await files.put(file, got);
    }),
  );
}

self.addEventListener('install', (event) => {
  // The page that stands in for the others is worth having from the start; a worker that could not read it is installed all the same.
  event.waitUntil(
    keepPage(OFFLINE_PAGE)
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // What an earlier version of this worker kept is of no use to this one.
      for (const name of await caches.keys()) {
        if (
          (name.startsWith('diet-app.pages.') || name.startsWith('diet-app.files.')) &&
          name !== PAGES &&
          name !== FILES
        )
          await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Another site's requests, and the API's, are not this worker's to answer.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (FILE.test(url.pathname)) event.respondWith(fileFirst(request));
  else if (request.mode === 'navigate') event.respondWith(pageFromServer(request, url.pathname));
});

self.addEventListener('message', (event) => {
  // Only a page of the application tells this worker anything.
  if (event.origin !== self.location.origin) return;
  const said = event.data;
  if (!said || said.type !== 'keep-pages' || !Array.isArray(said.pages)) return;
  // The pages somebody will want without the server, kept before they are wanted there. One that is kept already is left as it is.
  event.waitUntil(
    (async () => {
      const pages = await caches.open(PAGES);
      for (const path of said.pages) {
        if (
          typeof path !== 'string' ||
          !A_PAGE.test(path) ||
          (await pages.match(path, { ignoreVary: true }))
        )
          continue;
        await keepPage(path).catch(() => undefined);
      }
    })(),
  );
});
