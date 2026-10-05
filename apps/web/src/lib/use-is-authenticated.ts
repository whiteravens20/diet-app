// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useEffect, useRef, useState } from 'react';
import { tokenStore } from './api';

/**
 * Cheap "do we have an access token?" check. Avoids a network probe; the
 * Settings page already gates on real auth via a server-side mechanism.
 * Reactive via a `storage` event listener so logout in another tab flips
 * the caller back to anonymous behaviour.
 */
export function useIsAuthenticated(): boolean {
  const [authed, setAuthed] = useState(false);
  const mounted = useRef(false);
  // Mount gate: tokenStore only works on the client, so the first client
  // render has to match the SSR'd output (assumed-anonymous) before this
  // resolves the real value. Same shape as ThemeToggle's hydration gate.
  useEffect(() => {
    mounted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount gate; reads the client-only token store after the SSR'd render
    setAuthed(Boolean(tokenStore.access));
    const onStorage = () => mounted.current && setAuthed(Boolean(tokenStore.access));
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return authed;
}
