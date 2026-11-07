// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, WaterDay } from '@diet-app/shared';
import { api } from '@/lib/api';
import { plain, spaced } from '@/testing/spaces';
import messages from '../../messages/en.json';
import { WaterCard } from './water-card';

// The chart is fetched on demand and draws nothing in a DOM without a size: a stand-in says what it was given.
vi.mock('next/dynamic', async () => {
  const { createElement } = await import('react');
  return {
    default: () => (props: { days: { day: string }[]; target: number | null; shown: string }) =>
      createElement(
        'p',
        { 'data-testid': 'water-chart' },
        `${props.days.length} days to ${props.shown}, a line at ${props.target ?? 'none'}`,
      ),
  };
});

const texts = messages.water;
const PROFILE = { id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f', name: 'Me' } as Profile;
const DAY = '2026-11-07';
const LAST = {
  id: '2b9c7f0e-1d4a-4c2b-8f6e-5a4b3c2d1e0f',
  ml: 330,
  at: '2026-11-07T13:05:00.000Z',
};

const aDay = (over: Partial<WaterDay> = {}): WaterDay => ({
  day: DAY,
  ml: 500,
  target: 2000,
  entries: 2,
  last: LAST,
  days: [2100, 0, 1800, 2000, 900, 2400, 500].map((ml, at) => ({
    day: `2026-11-0${at + 1}`,
    ml,
  })),
  ...over,
});

function shown(day: WaterDay) {
  vi.spyOn(api, 'get').mockResolvedValue(day);
  const post = vi.spyOn(api, 'post');
  const remove = vi.spyOn(api, 'delete');
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages}>
        <WaterCard profile={PROFILE} day={DAY} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { post, remove };
}

describe("the water of a profile's day", () => {
  beforeEach(() => {
    process.env.TZ = 'Europe/Warsaw';
  });
  afterEach(() => vi.restoreAllMocks());

  it('says what was drunk against the target, and how far that goes', async () => {
    shown(aDay());

    expect(plain((await screen.findByText(/of 2 L$/)).textContent)).toBe('0.5 L of 2 L');
    expect(screen.getByRole('progressbar', { name: texts.title })).toHaveAttribute(
      'aria-valuenow',
      '500',
    );
    expect(api.get).toHaveBeenCalledWith(`/water?profileId=${PROFILE.id}&day=${DAY}`);
  });

  it('adds 200, 250 or 330 ml at a press, and says the day as the API answers it', async () => {
    const { post } = shown(aDay());
    post.mockResolvedValue(aDay({ ml: 830, entries: 3 }));

    for (const ml of [200, 250, 330]) {
      await userEvent.click(await screen.findByRole('button', { name: spaced(`+${ml} ml`) }));
      expect(post).toHaveBeenLastCalledWith('/water', { profileId: PROFILE.id, day: DAY, ml });
    }
    expect(plain((await screen.findByText(/^0\.83 L/)).textContent)).toBe('0.83 L of 2 L');
  });

  it('comes to its card once the day is shown, where a page was opened at the card', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    shown(aDay());
    await screen.findByText(/of 2 L$/);
    expect(scroll).not.toHaveBeenCalled();
    cleanup();

    // A reminder of water links to the card of its profile.
    window.history.replaceState(null, '', `/dashboard#water-${PROFILE.id}`);
    try {
      shown(aDay());
      await screen.findByText(/of 2 L$/);
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      expect(scroll.mock.contexts[0]).toHaveAttribute('id', `water-${PROFILE.id}`);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('adds an amount of its own, and nothing that is no amount', async () => {
    const { post } = shown(aDay());
    post.mockResolvedValueOnce(aDay({ ml: 620, entries: 3 }));
    const add = await screen.findByRole('button', { name: texts.add });
    const field = screen.getByRole('spinbutton', { name: (name) => name.startsWith(texts.own) });

    expect(add).toBeDisabled();
    await userEvent.type(field, '120');
    await userEvent.click(add);
    expect(post).toHaveBeenLastCalledWith('/water', { profileId: PROFILE.id, day: DAY, ml: 120 });
  });

  it('removes the last entry at a press, naming its amount and time, with no window to confirm', async () => {
    const { remove } = shown(aDay());
    remove.mockResolvedValueOnce(aDay({ ml: 170, entries: 1, last: null }));

    const button = await screen.findByRole('button', { name: /^Remove the last entry/ });
    expect(plain(button.textContent)).toBe('Remove the last entry(330 mL · 2:05 PM)');
    await userEvent.click(button);
    expect(remove).toHaveBeenCalledWith(`/water/${LAST.id}`);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull());
  });

  it('offers no entry to remove on a day that holds none', async () => {
    shown(aDay({ ml: 0, entries: 0, last: null }));

    await screen.findByText(/of 2 L$/);
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('says the seven days in words, each that reached the target as reached, and how many did', async () => {
    shown(aDay());

    expect(await screen.findByText('On target: 3 of 7 days')).toBeInTheDocument();
    expect(screen.getByTestId('water-chart')).toHaveTextContent(`7 days to ${DAY}, a line at 2000`);
    const days = within(screen.getByRole('list', { name: /^Water of the 7\sdays/ }));
    expect(days.getAllByRole('listitem').map((day) => plain(day.textContent))).toEqual([
      'Sun, Nov 1: 2.1 L, target reached',
      'Mon, Nov 2: 0 L',
      'Tue, Nov 3: 1.8 L',
      'Wed, Nov 4: 2 L, target reached',
      'Thu, Nov 5: 0.9 L',
      'Fri, Nov 6: 2.4 L, target reached',
      'Sat, Nov 7: 0.5 L',
    ]);
  });

  it('says only what was drunk where the profile names no target', async () => {
    shown(aDay({ target: null, ml: 1250 }));

    expect(plain((await screen.findByText(/drunk$/)).textContent)).toBe('1.25 L drunk');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/^On target/)).toBeNull();
  });
});
