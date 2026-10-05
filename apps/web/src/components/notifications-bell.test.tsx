// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { api, tokenStore } from '@/lib/api';
import { NotificationsBell } from './notifications-bell';

function tree() {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient()}>
        <NotificationsBell />
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

describe('NotificationsBell', () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
    tokenStore.clear();
    vi.restoreAllMocks();
  });

  it('hydrates without a mismatch when a session is stored', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([]);
    // The server has no token store to read, so it renders the signed-out markup.
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree());
    document.body.append(container);
    tokenStore.set({ accessToken: 'access', refreshToken: 'refresh' });

    const onRecoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('renders nothing and does not poll when signed out', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue([]);
    await act(async () => {
      render(tree());
    });

    expect(screen.queryByRole('button', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
