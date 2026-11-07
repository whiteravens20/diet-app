// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile, WaterDay } from '@diet-app/shared';
import { api } from '@/lib/api';
import { plain } from '@/testing/spaces';
import messages from '../../messages/en.json';
import { WaterCard } from './water-card';

const texts = messages.water;
const PROFILE = { id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f', name: 'Me' } as Profile;
const DAY = '2026-11-07';

const aDay = (over: Partial<WaterDay> = {}): WaterDay => ({
  day: DAY,
  ml: 500,
  target: 2000,
  entries: 2,
  ...over,
});

function shown(day: WaterDay) {
  vi.spyOn(api, 'get').mockResolvedValue(day);
  const post = vi.spyOn(api, 'post');
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages}>
        <WaterCard profile={PROFILE} day={DAY} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { post };
}

describe("the water of a profile's day", () => {
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

  it('adds a glass and takes one back at a press, and says the day as the API answers it', async () => {
    const { post } = shown(aDay());
    post.mockResolvedValueOnce(aDay({ ml: 750, entries: 3 }));

    await userEvent.click(await screen.findByRole('button', { name: texts.addGlass }));
    expect(post).toHaveBeenLastCalledWith('/water', { profileId: PROFILE.id, day: DAY, ml: 250 });
    expect(plain((await screen.findByText(/^0\.75 L/)).textContent)).toBe('0.75 L of 2 L');

    post.mockResolvedValueOnce(aDay({ ml: 500, entries: 4 }));
    await userEvent.click(screen.getByRole('button', { name: texts.takeBackLabel }));
    expect(post).toHaveBeenLastCalledWith('/water', { profileId: PROFILE.id, day: DAY, ml: -250 });
  });

  it('takes no glass back from a day that holds less than one', async () => {
    shown(aDay({ ml: 100 }));

    expect(await screen.findByRole('button', { name: texts.takeBackLabel })).toBeDisabled();
  });

  it('adds an amount of its own, and nothing that is no amount', async () => {
    const { post } = shown(aDay());
    post.mockResolvedValueOnce(aDay({ ml: 830, entries: 3 }));
    const add = await screen.findByRole('button', { name: texts.add });
    const field = screen.getByRole('spinbutton', { name: (name) => name.startsWith(texts.own) });

    expect(add).toBeDisabled();
    await userEvent.type(field, '330');
    await userEvent.click(add);
    expect(post).toHaveBeenLastCalledWith('/water', { profileId: PROFILE.id, day: DAY, ml: 330 });
  });

  it('says only what was drunk where the profile names no target', async () => {
    shown(aDay({ target: null, ml: 1250 }));

    expect(plain((await screen.findByText(/drunk$/)).textContent)).toBe('1.25 L drunk');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
