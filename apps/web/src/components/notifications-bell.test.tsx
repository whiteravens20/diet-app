// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@diet-app/shared';
import messages from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { api } from '@/lib/api';
import { NotificationsBell, useNotificationText } from './notifications-bell';

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
    document.cookie = 'diet_session=; Max-Age=0; Path=/';
    vi.restoreAllMocks();
  });

  it('hydrates without a mismatch when a session is stored', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([]);
    // The server knows of no session, so it renders the signed-out markup.
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree());
    document.body.append(container);
    document.cookie = 'diet_session=1; Path=/';

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

  describe('what it says of a product of the account', () => {
    const said = (
      type: string,
      payload: { name: string; reason: string | null; replacedBy: string | null },
      texts: typeof messages = messages,
      locale = 'en',
    ): string => {
      const { result } = renderHook(() => useNotificationText(), {
        wrapper: ({ children }) => (
          <NextIntlClientProvider locale={locale} messages={texts}>
            {children}
          </NextIntlClientProvider>
        ),
      });
      return result.current({ id: 'n', type, payload } as unknown as Notification);
    };
    const notice = { name: 'Chleb', reason: null, replacedBy: null };

    it('names it when it was accepted', () => {
      expect(said('product_accepted', notice)).toContain('“Chleb”');
    });

    it('gives the reason when it was turned down or withdrawn', () => {
      for (const type of ['product_rejected', 'product_withdrawn']) {
        const text = said(type, { ...notice, reason: 'Wrong figures.' });
        expect(text).toContain('“Chleb”');
        expect(text).toContain('Wrong figures.');
      }
    });

    it('says what took its place when it gave way, in both languages', () => {
      const instead = { ...notice, replacedBy: 'open_food_facts' };
      expect(said('product_replaced', instead)).toContain('Open Food Facts');
      expect(said('product_replaced', { ...notice, replacedBy: 'instance' })).toContain(
        'The base of this instance',
      );
      expect(said('product_replaced', instead, pl as typeof messages, 'pl')).toContain(
        'Open Food Facts',
      );
    });
  });
});
