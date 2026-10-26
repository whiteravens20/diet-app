// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { AccountPreferences } from './account-preferences';

const looks = vi.hoisted(() => ({
  theme: 'system' as string | undefined,
  palette: 'default',
  setTheme: vi.fn(),
  setPalette: vi.fn(),
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: looks.theme, setTheme: looks.setTheme }),
}));
vi.mock('@/app/providers', () => ({
  usePalette: () => ({ palette: looks.palette, setPalette: looks.setPalette }),
}));

/** The account as its session holds it, with the language, theme and palette given; its language its owner's unless said otherwise. */
function anAccount(
  chosen: Pick<SessionUser, 'locale' | 'theme' | 'palette'> &
    Partial<Pick<SessionUser, 'localeChosen'>>,
): SessionUser {
  return {
    id: 'b3c1e2d4-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
    localeChosen: true,
    ...chosen,
  } as SessionUser;
}

/** The component on a page in `pageLocale`, with the account already known. */
function onAPage(me: SessionUser, pageLocale: 'en' | 'pl' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  client.setQueryData(['session'], me);
  render(
    <NextIntlClientProvider locale={pageLocale} messages={messages}>
      <QueryClientProvider client={client}>
        <AccountPreferences />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return client;
}

const reload = vi.fn();

beforeEach(() => {
  looks.theme = 'system';
  looks.palette = 'default';
  vi.stubGlobal('location', { ...window.location, reload });
  document.cookie = 'NEXT_LOCALE=en; Path=/';
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the account's own look on a browser it signs in on", () => {
  it('puts on the theme and the palette of the account where the browser has others', () => {
    onAPage(anAccount({ locale: 'en', theme: 'dark', palette: 'ocean' }));

    expect(looks.setTheme).toHaveBeenCalledExactlyOnceWith('dark');
    expect(looks.setPalette).toHaveBeenCalledExactlyOnceWith('ocean');
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves the browser as it is where it has the account's already", () => {
    looks.theme = 'dark';
    looks.palette = 'forest';

    onAPage(anAccount({ locale: 'en', theme: 'dark', palette: 'forest' }));

    expect(looks.setTheme).not.toHaveBeenCalled();
    expect(looks.setPalette).not.toHaveBeenCalled();
  });

  it('does it once a page, so a later answer about the account takes back nothing picked since', async () => {
    const client = onAPage(anAccount({ locale: 'en', theme: 'dark', palette: 'ocean' }));

    // The cache tells those who read it on the next turn: wait for it.
    await act(async () => {
      client.setQueryData(
        ['session'],
        anAccount({ locale: 'en', theme: 'light', palette: 'rose' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(looks.setPalette).toHaveBeenCalledExactlyOnceWith('ocean');
    expect(looks.setTheme).toHaveBeenCalledExactlyOnceWith('dark');
  });

  it("loads the page again in the account's language when it is another", () => {
    onAPage(anAccount({ locale: 'pl', theme: 'system', palette: 'default' }), 'en');

    expect(document.cookie).toContain('NEXT_LOCALE=pl');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the page's language for an account whose language was never chosen, and saves it as the account's", async () => {
    const saved = anAccount({ locale: 'pl', theme: 'system', palette: 'default' });
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(saved);

    const client = onAPage(
      anAccount({ locale: 'en', localeChosen: false, theme: 'system', palette: 'default' }),
      'pl',
    );

    expect(patch).toHaveBeenCalledExactlyOnceWith('/users/me', { locale: 'pl' });
    await vi.waitFor(() => expect(client.getQueryData(['session'])).toEqual(saved));
    expect(document.cookie).not.toContain('NEXT_LOCALE=pl');
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not load the page again where the browser keeps no cookie, which would load it for ever', () => {
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: () => undefined,
    });
    try {
      onAPage(anAccount({ locale: 'pl', theme: 'system', palette: 'default' }), 'en');

      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, 'cookie', cookie);
      delete (document as { cookie?: string }).cookie;
    }
  });
});
