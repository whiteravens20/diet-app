// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@diet-app/shared';
import { api } from '@/lib/api';
import { plain, spaced } from '@/testing/spaces';
import messages from '../../messages/en.json';
import { NotificationsBell } from './notifications-bell';
import { NotificationToast } from './notification-toast';

// A link goes nowhere in the DOM of the tests: it says only that it was followed.
vi.mock('next/link', () => ({
  default: ({ onClick, ...rest }: ComponentProps<'a'>) => (
    <a
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    />
  ),
}));

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
const PROFILE = '99999999-9999-4999-8999-999999999999';
const drink = (id: string): Notification => ({
  id,
  profileId: PROFILE,
  type: 'water_reminder',
  payload: { day: '2026-11-09', ml: 600, target: 2000 },
  createdAt: '2026-11-09T12:00:00.000Z',
  readAt: null,
});

/** The toast of a signed-in account with these notifications unread, and the bell beside it if asked. */
async function renderToast(unread: Notification[], { bell = false } = {}) {
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation((path: string) =>
      Promise.resolve((path === '/profiles' ? [{ id: PROFILE, name: 'Me' }] : unread) as never),
    );
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          {bell && <NotificationsBell />}
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

  it('is put aside as the bell opens, which lists the same, and reads nothing', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never);
    await renderToast([weigh(ONE, 9)], { bell: true });
    await screen.findByRole('status');

    await userEvent.click(screen.getByRole('button', { name: text.label }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: text.label })).toHaveTextContent("it's been 9 days");
    expect(JSON.parse(localStorage.getItem('diet-app.notifications.said')!)).toEqual([ONE]);
    expect(post).not.toHaveBeenCalled();
  });

  it('carries the amounts of a reminder of water that came in alone, and says what a press added', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    await renderToast([drink(ONE)]);
    const said = await screen.findByRole('status');
    expect(said).toHaveTextContent('Water today: 0.6 L of 2 L.');

    // Pressed late, the toast still says what the press added: the ten seconds count again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: spaced('+330 ml') }));
    });
    expect(post).toHaveBeenCalledWith('/water', { profileId: PROFILE, day: '2026-11-09', ml: 330 });
    expect(plain((await screen.findByText(/^Added/)).textContent)).toBe('Added 330 mL · Me');
    expect(screen.queryByRole('button', { name: spaced('+250 ml') })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Added');

    // Then the reminder is read, as a press in the bell reads it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(post).toHaveBeenCalledWith(`/notifications/${ONE}/read`);
  });

  it("leads from a reminder of water to the profile's water card, reads it and goes", async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    await renderToast([drink(ONE)]);
    await screen.findByRole('status');

    const go = screen.getByRole('link', { name: text.waterGo });
    expect(go).toHaveAttribute('href', `/dashboard#water-${PROFILE}`);
    await userEvent.click(go);
    expect(post).toHaveBeenCalledExactlyOnceWith(`/notifications/${ONE}/read`);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('carries no amounts for anything else, nor for a reminder of water among others', async () => {
    await renderToast([weigh(ONE, 9)]);
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: spaced('+330 ml') })).not.toBeInTheDocument();
    cleanup();
    localStorage.clear();

    await renderToast([drink(ONE), weigh(TWO, 10)]);
    expect(await screen.findByRole('status')).toHaveTextContent('2 new notifications');
    expect(screen.queryByRole('button', { name: spaced('+330 ml') })).not.toBeInTheDocument();
  });

  it('says nothing to a visitor who is not signed in, and asks nothing', async () => {
    document.cookie = 'diet_session=; Max-Age=0; Path=/';
    const get = await renderToast([weigh(ONE, 9)]);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
