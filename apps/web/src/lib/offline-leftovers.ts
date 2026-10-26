// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Earlier versions of the application could be read without a network. A
 * service worker kept the pages a browser had opened and the files they are
 * built from, and the pages kept what an account read last, with the ticks
 * of a shopping list that waited for the server. The application works
 * online only now, and what they left in a browser is removed when a page of
 * it opens there: the worker, what was kept in the cache storage, and the
 * account and the ticks written into the local storage.
 */

/** The address the worker of those versions was registered from. */
const WORKER = '/sw.js';
/** What their names in the cache storage began with: the pages, the files, an account's answers. */
const KEPT = 'diet-app.';
/** What they wrote into the local storage: whose answers were kept, and the ticks that waited. */
const WRITTEN = ['diet-app.offline.account', 'diet-app.offline.waiting'];

const scriptOf = (registration: ServiceWorkerRegistration): string | undefined =>
  (registration.active ?? registration.waiting ?? registration.installing)?.scriptURL;

/** Remove what the versions that could be read without a network left in this browser. */
export async function removeOfflineLeftovers(): Promise<void> {
  try {
    for (const key of WRITTEN) localStorage.removeItem(key);
  } catch {
    // A browser that gives the page no local storage has nothing in it.
  }
  try {
    if ('serviceWorker' in navigator)
      for (const registration of await navigator.serviceWorker.getRegistrations()) {
        const script = scriptOf(registration);
        // A worker of another application at this address, under a path of its own, is not ours to take away.
        if (script !== undefined && new URL(script).pathname === WORKER)
          await registration.unregister();
      }
  } catch {
    // A browser that gives the page no worker (plain http, a private window) had none of it.
  }
  try {
    if (typeof caches !== 'undefined')
      for (const name of await caches.keys()) if (name.startsWith(KEPT)) await caches.delete(name);
  } catch {
    // The same for the cache storage.
  }
}
