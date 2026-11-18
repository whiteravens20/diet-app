// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiMode,
  AiProviderConfig,
  AiQuotaStatus,
  OperatorAiTerms,
  SessionUser,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { AiAssistantCard, AiProvidersCard } from './ai-cards';

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
  timeZone: null,
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

/** The card for an account with `quota`, on an instance whose operator published `contact` and the terms of its AI. */
function shown(
  aiMode: AiMode,
  quota: AiQuotaStatus,
  contact: string | null = 'operator@example.test',
  terms: OperatorAiTerms | null = null,
) {
  vi.spyOn(api, 'get').mockImplementation(((path: string) =>
    Promise.resolve(
      path === '/ai/quota'
        ? quota
        : path === '/ai/providers'
          ? []
          : {
              instance: { operatorContact: contact },
              ai: { ollamaUserPolicy: 'off', operator: terms },
            },
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

describe("the terms of the instance's AI in Settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const TERMS: OperatorAiTerms = {
    dataPolicy: 'no_training',
    access: 'approved',
    monthlyLimit: 40,
    instanceMonthlyLimit: 1000,
  };

  it('say whom it is for, how much it may be asked and where its requests go', async () => {
    shown('none', status(), 'operator@example.test', TERMS);

    expect(await screen.findByText(s.aiInstanceTerms)).toBeInTheDocument();
    expect(screen.getByText(s.aiInstanceAccess.approved)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Limit: up to 40 requests an account and 1000 for the whole instance a month.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(s.aiInstancePolicy.no_training)).toBeInTheDocument();
  });

  it.each(['everyone', 'confirmed'] as const)(
    'say it is for %s as the instance says',
    async (access) => {
      shown('none', status(), 'operator@example.test', { ...TERMS, access });

      expect(await screen.findByText(s.aiInstanceAccess[access])).toBeInTheDocument();
    },
  );

  it('count one request as one', async () => {
    shown('none', status(), 'operator@example.test', { ...TERMS, monthlyLimit: 1 });

    expect(
      await screen.findByText(
        'Limit: up to 1 request an account and 1000 for the whole instance a month.',
      ),
    ).toBeInTheDocument();
  });

  it('say nothing of where the requests go for a provider that has no such choice', async () => {
    shown('none', status(), 'operator@example.test', { ...TERMS, dataPolicy: null });

    expect(await screen.findByText(s.aiInstanceTerms)).toBeInTheDocument();
    for (const said of Object.values(s.aiInstancePolicy))
      expect(screen.queryByText(said)).not.toBeInTheDocument();
  });

  it('are not there where the instance offers no AI of its own', async () => {
    shown('none', status({ adminProviderConfigured: false }));

    expect(await screen.findByText(s.aiModeAdminUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(s.aiInstanceTerms)).not.toBeInTheDocument();
  });
});

describe("the choice of the endpoints OpenRouter may send an account's requests to", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const openRouter: AiProviderConfig = {
    id: '22222222-2222-4222-8222-222222222222',
    provider: 'openrouter',
    model: 'some/model',
    priority: 0,
    enabled: true,
    hasKey: true,
    keyUnreadable: false,
    baseUrl: null,
    dataPolicy: 'any',
  };

  /** The providers card of an account with `saved`; what it saves is caught. */
  async function opened(saved: AiProviderConfig[]) {
    vi.spyOn(api, 'get').mockImplementation(((path: string) =>
      Promise.resolve(path === '/ai/providers' ? saved : [])) as never);
    const put = vi
      .spyOn(api, 'put')
      .mockImplementation(((_path: string, body: unknown) =>
        Promise.resolve({ ...openRouter, ...(body as object) })) as never);
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AiProvidersCard />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    if (saved.length) await screen.findByText(`· ${saved[0]!.model}`);
    await userEvent.click(screen.getByRole('button', { name: s.aiAddProvider }));
    return put;
  }
  const choices = () => screen.queryByRole('group', { name: s.aiDataPolicy });
  const choice = (label: string) =>
    within(choices()!).getByRole('radio', { name: new RegExp(`^${label}`) });

  it('is offered for OpenRouter alone, starts at no training on the data, and is saved as chosen', async () => {
    const put = await opened([]);
    expect(choices()).toBeNull();

    await userEvent.selectOptions(screen.getByRole('combobox'), 'openrouter');
    expect(choice(s.aiDataPolicyNoTraining)).toBeChecked();
    expect(within(choices()!).getByText(s.aiDataPolicyRefused)).toBeInTheDocument();
    await userEvent.click(choice(s.aiDataPolicyNoRetention));
    await userEvent.type(screen.getByRole('textbox', { name: s.aiModel }), 'some/model');
    await userEvent.type(screen.getByLabelText(s.aiApiKey), 'sk-or-test');
    await userEvent.click(screen.getByRole('button', { name: s.aiSave }));

    expect(put).toHaveBeenCalledWith(
      '/ai/providers',
      expect.objectContaining({ provider: 'openrouter', dataPolicy: 'no_retention' }),
    );
  });

  it("starts from the saved configuration's choice, which its row names", async () => {
    await opened([openRouter]);

    expect(screen.getByText(s.aiDataPolicyAny)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox'), 'openrouter');
    expect(choice(s.aiDataPolicyAny)).toBeChecked();
  });

  it('is not sent for another provider', async () => {
    const put = await opened([]);

    await userEvent.type(screen.getByRole('textbox', { name: s.aiModel }), 'gpt-4o-mini');
    await userEvent.type(screen.getByLabelText(s.aiApiKey), 'sk-test');
    await userEvent.click(screen.getByRole('button', { name: s.aiSave }));

    expect(put).toHaveBeenCalledWith(
      '/ai/providers',
      expect.objectContaining({ provider: 'openai' }),
    );
    expect(put.mock.calls[0]![1]).not.toHaveProperty('dataPolicy', expect.anything());
  });
});

describe('the AI providers of an account, when they cannot be read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says why, and not that no provider is set up', async () => {
    vi.spyOn(api, 'get').mockImplementation(((path: string) =>
      path === '/ai/providers'
        ? Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch'))
        : Promise.resolve([])) as never);
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AiProvidersCard />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.queryByText(messages.settings.aiNoProviders)).toBeNull();
  });
});
