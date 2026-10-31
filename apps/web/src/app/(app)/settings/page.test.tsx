// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import SettingsPage from './page';

/** What the address of the page says after its question mark. */
const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(address.search) }));

const s = messages.settings;

const ME: SessionUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'reader@example.test',
  displayName: 'Reader',
  role: 'user',
  emailVerified: true,
  locale: 'en',
  localeChosen: true,
  theme: 'system',
  palette: 'default',
  aiMode: 'none',
  weightUnit: null,
};

function shown(search = '') {
  address.search = search;
  vi.spyOn(api, 'get').mockImplementation(((path: string) => {
    if (path === '/users/me') return Promise.resolve(ME);
    if (path === '/config') return Promise.resolve(aPublicConfig());
    return Promise.reject(new Error(`not looked at here: ${path}`));
  }) as typeof api.get);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const selected = async () =>
  (await screen.findAllByRole('tab')).filter((tab) => tab.getAttribute('aria-selected') === 'true');

describe('the settings of an account, in parts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('opens on the general part, with nothing of the others rendered', async () => {
    shown();

    expect((await selected()).map((tab) => tab.textContent)).toEqual([s.tabs.general]);
    expect(screen.getByRole('heading', { name: s.language })).toBeVisible();
    expect(screen.queryByText(s.dataExport)).toBeNull();
  });

  it.each([
    ['?tab=ai', s.tabs.ai],
    ['?tab=security', s.tabs.security],
    ['?tab=account', s.tabs.account],
  ])('opens the part the address names: %s', async (search, title) => {
    shown(search);

    expect((await selected()).map((tab) => tab.textContent)).toEqual([title]);
  });

  it('holds the export and the deletion of an account in the part for them', async () => {
    shown('?tab=account');

    expect(await screen.findByText(s.dataExport)).toBeVisible();
    expect(screen.queryByRole('heading', { name: s.language })).toBeNull();
  });

  it.each(['?tab=nonsense', '?tab=', '?other=ai'])(
    'opens the general part for an address that names none: %s',
    async (search) => {
      shown(search);

      expect((await selected()).map((tab) => tab.textContent)).toEqual([s.tabs.general]);
    },
  );

  it('writes the part chosen into the address, and the first part as no part at all', async () => {
    window.history.replaceState(null, '', '/settings?other=1');
    shown();
    const write = vi.spyOn(window.history, 'replaceState');

    await userEvent.click(await screen.findByRole('tab', { name: s.tabs.security }));

    expect(String(write.mock.lastCall?.[2])).toMatch(/\/settings\?other=1&tab=security$/);

    await userEvent.click(await screen.findByRole('tab', { name: s.tabs.general }));

    expect(String(write.mock.lastCall?.[2])).toMatch(/\/settings\?other=1$/);
  });
});
