// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useEffect } from 'react';
import { useIsAuthenticated } from '@/lib/use-is-authenticated';

/** The worker, as the web server answers it (`public/sw.js`). */
const WORKER = '/sw.js';

/** The pages somebody needs where there may be no signal, kept before they are needed there. */
export const KEPT_AHEAD = ['/dashboard', '/meal-plans', '/shopping-lists'] as const;

/**
 * Hands the browser the application's service worker, which keeps the shell
 * of the pages for when the server cannot be reached, and tells it which
 * pages of an account to keep ahead once somebody is signed in.
 *
 * A browser takes a worker only over https, or on the machine itself: an
 * instance reached over plain http has none, and works as it did. While the
 * application is being developed there is none either: a worker would answer
 * with files of the build before the last.
 */
export function ServiceWorker() {
  const signedIn = useIsAuthenticated();

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register(WORKER).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !signedIn || !('serviceWorker' in navigator))
      return;
    void navigator.serviceWorker.ready
      .then((registration) =>
        registration.active?.postMessage({ type: 'keep-pages', pages: KEPT_AHEAD }),
      )
      .catch(() => undefined);
  }, [signedIn]);

  return null;
}
