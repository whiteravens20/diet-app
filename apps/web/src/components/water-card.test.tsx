// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile, WaterDay } from '@diet-app/shared';
import { api } from '@/lib/api';
import { plain, spaced } from '@/testing/spaces';
import messages from '../../messages/en.json';
import { WaterCard } from './water-card';

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

  it('adds 250, 330 or 500 ml at a press, and says the day as the API answers it', async () => {
    const { post } = shown(aDay());
    post.mockResolvedValue(aDay({ ml: 830, entries: 3 }));

    for (const ml of [250, 330, 500]) {
      await userEvent.click(await screen.findByRole('button', { name: spaced(`+${ml} ml`) }));
      expect(post).toHaveBeenLastCalledWith('/water', { profileId: PROFILE.id, day: DAY, ml });
    }
    expect(plain((await screen.findByText(/^0\.83 L/)).textContent)).toBe('0.83 L of 2 L');
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

  it('says only what was drunk where the profile names no target', async () => {
    shown(aDay({ target: null, ml: 1250 }));

    expect(plain((await screen.findByText(/drunk$/)).textContent)).toBe('1.25 L drunk');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
