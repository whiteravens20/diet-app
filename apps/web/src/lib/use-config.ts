// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import type { PublicConfig } from '@diet-app/shared';
import { api } from './api';

/**
 * Public runtime config: Turnstile site key and enabled flags, email
 * availability, and which diets the catalogue has recipes for. The operator's
 * choices do not change mid-session, the catalogue does when it is updated, so
 * the answer is asked for again once it is five minutes old. Shared by the auth
 * forms, the settings email card and the profile and plan forms.
 */
export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<PublicConfig>('/config'),
    staleTime: 5 * 60_000,
  });
}
