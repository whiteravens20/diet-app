'use client';

import { useQuery } from '@tanstack/react-query';
import type { PublicConfig } from '@diet-app/shared';
import { api } from './api';

/**
 * Public runtime config (Turnstile site key + enabled flags, email availability).
 * Cached for the session — operator config doesn't change mid-session. Shared by
 * the auth forms and the settings email card.
 */
export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<PublicConfig>('/config'),
    staleTime: Infinity,
  });
}
