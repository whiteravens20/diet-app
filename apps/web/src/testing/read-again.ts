// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';

/**
 * From now on every read fails as it does when the network drops, and what a page shows is read
 * again. `api.get` has to be a spy already. What it returns puts the earlier answers back, so that
 * a try again can succeed.
 */
export async function failReadsAgain(client: QueryClient): Promise<() => void> {
  const get = vi.mocked(api.get);
  const answers = get.getMockImplementation();
  get.mockImplementation(() => Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch')));
  await client.invalidateQueries();
  return () => {
    if (answers) get.mockImplementation(answers);
  };
}
