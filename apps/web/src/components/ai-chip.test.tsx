// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiQuotaStatus } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { AiChip } from './ai-chip';

const c = messages.aiChip;

const admin = (over: Partial<AiQuotaStatus>): AiQuotaStatus => ({
  mode: 'admin',
  limit: 40,
  used: 0,
  remaining: 40,
  resetAt: null,
  instanceLimitReached: false,
  adminProviderConfigured: true,
  adminAccess: 'granted',
  newUntil: null,
  newAccountsLimitReached: false,
  ...over,
});

async function chip(quota: AiQuotaStatus): Promise<HTMLElement> {
  vi.spyOn(api, 'get').mockImplementation(((path: string) => Promise.resolve(path === '/ai/quota' ? quota : { aiMode: 'admin' })) as never);
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AiChip />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return screen.findByRole('link');
}

describe("the chip of the operator's AI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows what is left, and says where to manage it', async () => {
    const link = await chip(admin({ used: 3, remaining: 37 }));

    expect(link).toHaveTextContent('37/40 this month');
    expect(link).toHaveAttribute('title', c.adminTooltip);
  });

  it('shows nothing left for an account that may not use it, and points to Settings for why', async () => {
    const link = await chip(admin({ adminAccess: 'not_approved', remaining: 0 }));

    expect(link).toHaveTextContent('0/40');
    expect(link).toHaveAttribute('title', c.noAccessTooltip);
  });

  it('says that the new accounts used their part, and when a request frees up', async () => {
    const link = await chip(admin({ remaining: 0, newUntil: '2026-10-31T09:00:00.000Z', newAccountsLimitReached: true, resetAt: '2026-10-31T09:00:00.000Z' }));

    expect(link.getAttribute('title')).toMatch(/^New accounts have used their part of the instance's AI requests\. Next slot frees up .+\.$/);
  });
});
