// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../messages/en.json';
import { PaletteCard, ThemeCard } from './appearance-cards';

const looks = vi.hoisted(() => ({
  theme: 'system',
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

const texts = messages.settings;

/** A card on the settings page of an account whose saved choices are `saved`. */
function shown(card: ReactNode, saved: Pick<SessionUser, 'theme' | 'palette'>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  client.setQueryData(['session'], { id: 'b3c1e2d4-5f6a-4b7c-8d9e-0f1a2b3c4d5e', ...saved });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>{card}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.spyOn(api, 'patch').mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  looks.setTheme.mockClear();
  looks.setPalette.mockClear();
});

describe('the cards of how the pages look', () => {
  it('mark the theme and the palette the pages have now, not the ones the account saved', async () => {
    // A browser that has none of its own yet, before the account's are put on it.
    looks.theme = 'system';
    looks.palette = 'default';
    shown(<ThemeCard />, { theme: 'dark', palette: 'ocean' });
    shown(<PaletteCard />, { theme: 'dark', palette: 'ocean' });

    expect(await screen.findByRole('button', { name: texts.themeSystem })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: texts.themeDark })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: texts.paletteOption.default })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: texts.paletteOption.ocean })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('put a choice on the pages at once and save it for the account', async () => {
    const client = shown(<PaletteCard />, { theme: 'system', palette: 'default' });

    await userEvent.click(screen.getByRole('button', { name: texts.paletteOption.forest }));

    expect(looks.setPalette).toHaveBeenCalledWith('forest');
    expect(api.patch).toHaveBeenCalledWith('/users/me', { palette: 'forest' });
    expect(client.getQueryData<SessionUser>(['session'])?.palette).toBe('forest');
  });
});
