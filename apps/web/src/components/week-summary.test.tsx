// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayAfter, type Profile, type WeekSummary } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError, localDate } from '@/lib/http';
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
  target: { calories: 2135, protein: 134, fat: 71, carbs: 240, carbsFloor: null },
  withinTarget: 4,
  water: { counted: 7, averageMl: 1630, target: 2000, reached: 4 },
  weight: { kgPerWeek: -0.5, targetKg: 85, reachesTargetOn: '2027-02-01' },
  ...over,
});

function shown(week: WeekSummary, weeks = false, folded = false) {
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
        <WeekSummaryCard profile={PROFILE} weeks={weeks} folded={folded} />
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

  it('says what the week drank against the target, only the average without one, and nothing of a week without water', async () => {
    shown(aWeek());
    expect(plain((await screen.findByText(/^Water:/)).textContent)).toBe(
      'Water: 1.63 L of 2 L a day on average, on target 4 of 7 days.',
    );
    cleanup();
    vi.restoreAllMocks();

    shown(aWeek({ water: { counted: 3, averageMl: 1500, target: null, reached: 0 } }));
    expect(plain((await screen.findByText(/^Water:/)).textContent)).toBe(
      'Water: 1.5 L a day on average.',
    );
    cleanup();
    vi.restoreAllMocks();

    shown(aWeek({ water: { counted: 0, averageMl: null, target: 2000, reached: 0 } }));
    await screen.findByText('On average 2174 of 2135 kcal a day');
    expect(screen.queryByText(/^Water:/)).toBeNull();
    cleanup();
    vi.restoreAllMocks();

    // A profile that does not track water hears nothing of it.
    shown(aWeek({ water: null }));
    await screen.findByText('On average 2174 of 2135 kcal a day');
    expect(screen.queryByText(/^Water:/)).toBeNull();
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
    expect(screen.getByText(plain(texts.trendNone))).toBeInTheDocument();
  });

  it('goes back a week at a time in the diary, and no further forward than yesterday', async () => {
    const { get } = shown(aWeek(), true);
    const next = await screen.findByRole('button', { name: texts.next });
    expect(next).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(screen.getByRole('button', { name: texts.previous }));
    expect(get).toHaveBeenCalledWith(
      `/diary/week?profileId=${PROFILE.id}&to=${dayAfter(yesterday, -7)}`,
    );
    expect(next).not.toHaveAttribute('aria-disabled');

    // Back at the week that ends yesterday, the button that went there keeps the focus.
    await userEvent.click(next);
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(next).toHaveFocus();
  });

  it("is one line in the diary, the week's dates and what it ate against its target, until it is opened", async () => {
    shown(aWeek(), true, true);
    const toggle = await screen.findByRole('button', { name: /^The last 7\sdays/ });
    await within(toggle).findByText(/On average/);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(plain(toggle.textContent)).toContain('On average 2174 of 2135 kcal a day');
    expect(screen.queryByRole('button', { name: texts.previous })).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: texts.previous })).toBeInTheDocument();
    expect(screen.getByText('On target (±10%): 4 of 5 days')).toBeInTheDocument();
  });

  it('keeps the focus on the button pressed while a week not read yet comes', async () => {
    const earlier = dayAfter(yesterday, -7);
    let comes: (week: WeekSummary) => void = () => {};
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === '/users/me') return Promise.resolve({ weightUnit: 'kg' } as never);
      if (path.endsWith(`to=${earlier}`))
        return new Promise((resolve) => (comes = resolve as (week: WeekSummary) => void)) as never;
      return Promise.resolve(aWeek() as never);
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="en" messages={messages}>
          <WeekSummaryCard profile={PROFILE} weeks />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const previous = await screen.findByRole('button', { name: texts.previous });

    await userEvent.click(previous);
    // While the week before is on its way, the buttons stay where they are.
    expect(previous).toBeInTheDocument();
    expect(previous).toHaveFocus();
    comes(aWeek({ from: dayAfter(earlier, -6), to: earlier, eaten: null, counted: 0, empty: 7 }));
    expect(await screen.findByText(texts.nothing)).toBeInTheDocument();
    expect(previous).toBeInTheDocument();
    expect(previous).toHaveFocus();
  });
});

describe('the week in sum, when it cannot be read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says why and offers to read it again, instead of waiting for ever', async () => {
    vi.spyOn(api, 'get').mockImplementation((path: string) =>
      path === '/users/me'
        ? Promise.resolve({ weightUnit: 'kg' } as never)
        : Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch')),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="en" messages={messages}>
          <WeekSummaryCard profile={PROFILE} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByRole('button', { name: messages.common.retry })).toBeInTheDocument();
  });
});
