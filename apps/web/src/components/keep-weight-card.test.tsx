// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import { plain } from '@/testing/spaces';
import messages from '../../messages/en.json';
import { KeepWeightCard } from './keep-weight-card';

const texts = messages.keepWeight;
const aProfile = (over: Partial<Profile> = {}): Profile =>
  ({
    id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f',
    name: 'Me',
    weightKg: 84.6,
    targetWeightKg: 85,
    weeklyLossTarget: '0.5',
    targetWeightReached: true,
    targetReachedLaterUntil: null,
    ...over,
  }) as Profile;

function shown(profile: Profile) {
  // An account that weighs in kilograms.
  vi.spyOn(api, 'get').mockResolvedValue({ weightUnit: 'kg' } as never);
  const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <KeepWeightCard profile={profile} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { post };
}

describe('the target weight reached, on the dashboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers to keep the weight from now on, or to be asked again later', async () => {
    const { post } = shown(aProfile());

    // The account's unit comes with its settings.
    await waitFor(() =>
      expect(plain(screen.getByText(/^The target weight of/).textContent)).toBe(
        'The target weight of 85 kg is reached. Move to keeping the weight?',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: texts.keep }));
    expect(post).toHaveBeenLastCalledWith(
      '/profiles/6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f/keep-weight',
    );
    await userEvent.click(screen.getByRole('button', { name: texts.later }));
    expect(post).toHaveBeenLastCalledWith(
      '/profiles/6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f/keep-weight/later',
    );
  });

  it('is nothing while the offer is put off, and back on the day it ends', () => {
    shown(aProfile({ targetReachedLaterUntil: dayAfter(localDate(), 3) }));
    expect(screen.queryByRole('button', { name: texts.keep })).toBeNull();
    shown(aProfile({ targetReachedLaterUntil: localDate() }));
    expect(screen.getByRole('button', { name: texts.keep })).toBeInTheDocument();
  });

  it('is nothing before the target weight is reached', () => {
    shown(aProfile({ targetWeightReached: false, weightKg: 88 }));
    expect(screen.queryByText(texts.title)).toBeNull();
  });
});
