// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useSyncExternalStore } from 'react';
import { session } from './session';

/**
 * Whether the browser holds a session, without asking the server: by the
 * marker cookie the API sets beside the refresh token. It follows a sign-in
 * and a sign-out, in this tab and in the others. The server's render knows of
 * no session, and the first client render agrees with it.
 */
export function useIsAuthenticated(): boolean {
  return useSyncExternalStore(session.subscribe, session.exists, () => false);
}
