// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMode, AiQuotaStatus, SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../messages/en.json';
import { AiAssistantCard } from './ai-cards';

const s = messages.settings;

const me = (aiMode: AiMode): SessionUser => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'reader@example.test',
  displayName: 'Reader',
  role: 'user',
  emailVerified: true,
  locale: 'en',
  localeChosen: true,
  theme: 'system',
  palette: 'default',
  aiMode,
  weightUnit: null,
});

const status = (over: Partial<AiQuotaStatus> = {}): AiQuotaStatus => ({
  mode: 'none',
  limit: 40,
  used: 0,
  remaining: null,
  resetAt: null,
  instanceLimitReached: false,
  adminProviderConfigured: true,
  adminAccess: 'granted',
  newUntil: null,
  newAccountsLimitReached: false,
  ...over,
});

/** The card for an account with `quota`, on an instance whose operator published `contact`. */
function shown(
  aiMode: AiMode,
  quota: AiQuotaStatus,
  contact: string | null = 'operator@example.test',
) {
  vi.spyOn(api, 'get').mockImplementation(((path: string) =>
    Promise.resolve(
      path === '/ai/quota'
        ? quota
        : path === '/ai/providers'
          ? []
          : { instance: { operatorContact: contact } },
    )) as never);
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AiAssistantCard me={me(aiMode)} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const operatorsOption = () => screen.findByRole('radio', { name: new RegExp(s.aiModeAdmin) });

describe("the choice of the operator's AI in Settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is open to an account the operator lets use it', async () => {
    shown('none', status());

    expect(await operatorsOption()).toBeEnabled();
    expect(screen.queryByText(s.aiModeAdminNotApproved)).not.toBeInTheDocument();
  });

  it('is there and off for an account the operator has not approved, which is told whom to ask', async () => {
    shown('none', status({ adminAccess: 'not_approved' }));

    expect(await operatorsOption()).toBeDisabled();
    expect(screen.getByText(s.aiModeAdminNotApproved)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'operator@example.test' })).toHaveAttribute(
      'href',
      'mailto:operator@example.test',
    );
  });

  it('says so where the instance published no contact', async () => {
    shown('none', status({ adminAccess: 'not_approved' }), null);

    expect(await screen.findByText(s.aiModeAdminNoContact)).toBeInTheDocument();
  });

  it('is off for an account whose address is not confirmed, which is asked to confirm it', async () => {
    shown('none', status({ adminAccess: 'email_unconfirmed' }));

    expect(await operatorsOption()).toBeDisabled();
    expect(screen.getByText(s.aiModeAdminConfirmEmail)).toBeInTheDocument();
  });

  it("tells an account in the operator's mode that has lost its access so, in the place of when a request frees up", async () => {
    shown('admin', status({ mode: 'admin', adminAccess: 'not_approved', remaining: 0 }));

    expect(await screen.findByText(s.aiQuotaNoAccess)).toBeInTheDocument();
    expect(screen.queryByText(s.aiQuotaUnused)).not.toBeInTheDocument();
  });

  it("tells a new account until when it shares the new accounts' part, and when its own limit comes once that part is used up", async () => {
    shown('admin', status({ mode: 'admin', remaining: 40, newUntil: '2026-10-31T09:00:00.000Z' }));
    expect(await screen.findByText(/^Until .* this account is new/)).toBeInTheDocument();
    vi.restoreAllMocks();
    document.body.innerHTML = '';

    shown(
      'admin',
      status({
        mode: 'admin',
        remaining: 0,
        newUntil: '2026-10-31T09:00:00.000Z',
        newAccountsLimitReached: true,
        resetAt: '2026-10-31T09:00:00.000Z',
      }),
    );
    expect(
      await screen.findByText(
        /^New accounts have used their part of the instance's requests for now\. From .* this account has its full limit\.$/,
      ),
    ).toBeInTheDocument();
  });
});
