// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { ThemeToggle } from './theme-toggle';

const looks = vi.hoisted(() => ({ resolvedTheme: 'light', setTheme: vi.fn() }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: looks.resolvedTheme, setTheme: looks.setTheme }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  looks.setTheme.mockClear();
});

describe('the light and dark toggle of the navigation', () => {
  it("turns the pages dark and saves it as the account's theme", async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(undefined as never);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    client.setQueryData(['session'], {
      id: 'b3c1e2d4-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      theme: 'light',
    });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={client}>
          <ThemeToggle />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    await userEvent.click(
      await screen.findByRole('button', { name: messages.themeToggle.ariaLabel }),
    );

    expect(looks.setTheme).toHaveBeenCalledWith('dark');
    expect(patch).toHaveBeenCalledWith('/users/me', { theme: 'dark' });
    expect(client.getQueryData<SessionUser>(['session'])?.theme).toBe('dark');
  });
});
