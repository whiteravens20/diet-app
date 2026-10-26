// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { NotificationToast } from './notification-toast';

const text = messages.notifications;
const weigh = (id: string, days: number): Notification => ({
  id,
  profileId: '99999999-9999-4999-8999-999999999999',
  type: 'weight_reminder',
  payload: { daysSinceLastEntry: days },
  createdAt: '2026-10-12T06:00:00.000Z',
  readAt: null,
});
const ONE = '11111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';

/** The toast of a signed-in account with these notifications unread. */
async function renderToast(unread: Notification[]) {
  const get = vi.spyOn(api, 'get').mockImplementation(() => Promise.resolve(unread as never));
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <NotificationToast />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
  });
  return get;
}

describe('a notification that comes in', () => {
  beforeEach(() => {
    document.cookie = 'diet_session=1; Path=/';
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    document.cookie = 'diet_session=; Max-Age=0; Path=/';
  });

  it('is said once on the page, with what it is, to those who see it and those who do not', async () => {
    await renderToast([weigh(ONE, 9)]);

    const said = await screen.findByRole('status');
    expect(said).toHaveTextContent('New notification');
    expect(said).toHaveTextContent("Time to log your weight — it's been 9 days.");
  });

  it('is counted when more than one came in, and they are not read out one by one', async () => {
    await renderToast([weigh(ONE, 9), weigh(TWO, 10)]);

    const said = await screen.findByRole('status');
    expect(said).toHaveTextContent('2 new notifications');
    expect(said).not.toHaveTextContent('Time to log your weight');
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeInTheDocument();
  });

  it('is put aside by its button, and not said again on the next page while it stays unread', async () => {
    await renderToast([weigh(ONE, 9)]);
    await screen.findByRole('status');

    await userEvent.click(screen.getByRole('button', { name: text.dismiss }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    cleanup();

    await renderToast([weigh(ONE, 9)]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says the one that came in since, and not the one it said before', async () => {
    localStorage.setItem('diet-app.notifications.said', JSON.stringify([ONE]));
    await renderToast([weigh(ONE, 9), weigh(TWO, 10)]);

    const said = await screen.findByRole('status');
    expect(said).toHaveTextContent('New notification');
    expect(said).toHaveTextContent("it's been 10 days");
  });

  it('is marked read from where it is said: that one alone while others are unread', async () => {
    localStorage.setItem('diet-app.notifications.said', JSON.stringify([ONE]));
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never);
    await renderToast([weigh(ONE, 9), weigh(TWO, 10)]);
    await screen.findByRole('status');

    await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));

    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledExactlyOnceWith(`/notifications/${TWO}/read`),
    );
    await vi.waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('goes by itself after ten seconds, and is then said too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderToast([weigh(ONE, 9)]);
    await screen.findByRole('status');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('diet-app.notifications.said')!)).toEqual([ONE]);
  });

  it('says nothing to a visitor who is not signed in, and asks nothing', async () => {
    document.cookie = 'diet_session=; Max-Age=0; Path=/';
    const get = await renderToast([weigh(ONE, 9)]);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
