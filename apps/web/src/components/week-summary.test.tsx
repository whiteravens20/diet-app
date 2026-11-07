// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayAfter, type Profile, type WeekSummary } from '@diet-app/shared';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { plain } from '@/testing/spaces';
import messages from '../../messages/en.json';
import { WeekSummaryCard } from './week-summary';

const texts = messages.weekSummary;
const PROFILE = { id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f', name: 'Me' } as Profile;
const yesterday = dayAfter(localDate(), -1);

const aWeek = (over: Partial<WeekSummary> = {}): WeekSummary => ({
  from: dayAfter(yesterday, -6),
  to: yesterday,
  counted: 5,
  empty: 2,
  eaten: { calories: 2174, protein: 120, fat: 80, carbs: 270 },
  target: { calories: 2135, protein: 134, fat: 71, carbs: 240 },
  withinTarget: 4,
  weight: { kgPerWeek: -0.5, targetKg: 85, reachesTargetOn: '2027-02-01' },
  ...over,
});

function shown(week: WeekSummary, weeks = false) {
  // An account that weighs in kilograms, and the week asked for.
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation((path: string) =>
      Promise.resolve((path === '/users/me' ? { weightUnit: 'kg' } : week) as never),
    );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages}>
        <WeekSummaryCard profile={PROFILE} weeks={weeks} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { get };
}

describe("a profile's week in sum", () => {
  afterEach(() => vi.restoreAllMocks());

  it('says what the days that count ate against their targets, and names the empty ones', async () => {
    const { get } = shown(aWeek());

    expect(await screen.findByText('On average 2174 of 2135 kcal a day')).toBeInTheDocument();
    expect(screen.getByText('On target (±10%): 4 of 5 days')).toBeInTheDocument();
    expect(screen.getByText('2 days without entries')).toBeInTheDocument();
    expect(plain(screen.getByText(/^Protein/).textContent)).toBe(
      'Protein 120 of 134 g · fat 80 of 71 g · carbs 270 of 240 g',
    );
    expect(get).toHaveBeenCalledWith(`/diary/week?profileId=${PROFILE.id}&to=${yesterday}`);
  });

  it('says where the weight leads, and when it reaches the target at this pace', async () => {
    shown(aWeek());

    // The account's unit comes a moment after the page: the line says the weight in it then.
    await waitFor(() =>
      expect(plain(screen.getByText(/^Weight:/).textContent)).toBe(
        'Weight: −0.5 kg a week. At this pace the weight reaches 85 kg around Feb 1, 2027.',
      ),
    );
  });

  it('says what a trend needs where there are too few weights, and that nothing was written', async () => {
    shown(
      aWeek({
        counted: 0,
        empty: 7,
        eaten: null,
        target: null,
        withinTarget: 0,
        weight: { kgPerWeek: null, targetKg: null, reachesTargetOn: null },
      }),
    );

    expect(await screen.findByText(texts.nothing)).toBeInTheDocument();
    expect(screen.getByText(texts.trendNone)).toBeInTheDocument();
  });

  it('goes back a week at a time in the diary, and no further forward than yesterday', async () => {
    const { get } = shown(aWeek(), true);
    const next = await screen.findByRole('button', { name: texts.next });
    expect(next).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: texts.previous }));
    expect(get).toHaveBeenCalledWith(
      `/diary/week?profileId=${PROFILE.id}&to=${dayAfter(yesterday, -7)}`,
    );
    expect(screen.getByRole('button', { name: texts.next })).toBeEnabled();
  });
});
