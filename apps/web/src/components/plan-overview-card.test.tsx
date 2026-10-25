// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanOverview, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { PlanOverviewCard } from './plan-overview-card';

// The chart is fetched on demand and draws nothing in a DOM without a size: the figures beside it are what is tested.
vi.mock('next/dynamic', () => ({ default: () => () => null }));

const texts = messages.planOverview;
const profile = { id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f', name: 'Me' } as Profile;

const anOverview = (over: Partial<PlanOverview> = {}): PlanOverview => ({
  plan: {
    id: '11111111-1111-4111-8111-111111111111',
    startDate: '2026-01-05',
    durationDays: 3,
    dietType: 'vegan',
    status: 'active',
  },
  energy: { planned: 1880, target: 1900 },
  macros: {
    planned: { protein: 104, fat: 70, carbs: 190 },
    target: { protein: 119, fat: 63, carbs: 214 },
  },
  eaten: { meals: 3, of: 6 },
  onDiet: { meals: 8, of: 9 },
  favourites: { meals: 2, of: 9 },
  ingredientReuse: 0.58,
  shopping: { lists: 1, entries: 20, ticked: 5 },
  days: [
    { date: '2026-01-05', calories: 1868, target: 1900, skipped: false },
    { date: '2026-01-06', calories: 0, target: 1900, skipped: true },
    { date: '2026-01-07', calories: 1911, target: 1900, skipped: false },
  ],
  ...over,
});

function shown(answer: PlanOverview | null | Error) {
  vi.spyOn(api, 'get').mockImplementation(() =>
    answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve({ overview: answer } as never),
  );
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PlanOverviewCard profile={profile} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** What a figure of the card says: its number and the sentence under it. */
const figure = (label: string): string =>
  (screen.getByText(label).closest('div')?.querySelector('dd')?.textContent ?? '').trim();

describe('what the plan of the moment comes to, on the dashboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says which plan it is of, and leads to it', async () => {
    shown(anOverview());

    expect(await screen.findByRole('heading', { name: texts.title.active })).toBeInTheDocument();
    expect(screen.getByText('Jan 5 – 7, 2026 · Vegan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.open })).toHaveAttribute(
      'href',
      `/meal-plans?profile=${profile.id}`,
    );
  });

  it('says each figure with what it is a share of', async () => {
    shown(anOverview());
    await screen.findByRole('heading', { name: texts.title.active });

    expect(figure(texts.energy)).toBe('1,880 kcalOn average, against a target of 1,900 kcal.');
    expect(figure(texts.eaten)).toBe('50%3 of the 6 meals that were due by today.');
    expect(figure(texts.onDiet)).toBe('89%8 of 9 meals fit the diet of the plan (Vegan).');
    expect(figure(texts.favourites)).toBe(
      '22%2 of 9 meals are of a recipe marked as a favourite or as eaten often.',
    );
    expect(figure(texts.reuse)).toBe(`58%${texts.reuseHint}`);
    expect(figure(texts.shopping)).toBe('25%5 of 20 entries ticked on the plan’s lists.');
  });

  it('says what a day holds of each macro against what it aims at', async () => {
    shown(anOverview());
    await screen.findByRole('heading', { name: texts.title.active });

    expect(screen.getByText('104 of 119 g')).toBeInTheDocument();
    expect(screen.getByText('70 of 63 g')).toBeInTheDocument();
    expect(screen.getByText('190 of 214 g')).toBeInTheDocument();
  });

  it('gives the days as a table to whoever does not see the chart, a skipped day as skipped', async () => {
    shown(anOverview());

    const rows = within(await screen.findByRole('table', { name: texts.days })).getAllByRole('row');
    expect(
      rows.map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent)),
    ).toEqual([
      ['Day', 'Planned', 'Target'],
      ['Mon, Jan 5', '1,868 kcal', '1,900 kcal'],
      ['Tue, Jan 6', 'Skipped', ''],
      ['Wed, Jan 7', '1,911 kcal', '1,900 kcal'],
    ]);
  });

  it('names no share of what was eaten before a day of the plan has come, and none of a shopping the plan has no list for', async () => {
    shown(
      anOverview({
        plan: { ...anOverview().plan, status: 'upcoming' },
        eaten: { meals: 0, of: 0 },
        shopping: { lists: 0, entries: 0, ticked: 0 },
      }),
    );

    expect(await screen.findByRole('heading', { name: texts.title.upcoming })).toBeInTheDocument();
    expect(figure(texts.eaten)).toBe(`—${texts.eatenNotYetHint}`);
    expect(figure(texts.shopping)).toBe(`—${texts.shoppingNoneHint}`);
  });

  it('says so for a profile without a plan, and leads to where one is made', async () => {
    shown(null);

    expect(await screen.findByRole('heading', { name: texts.none })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.noneCta })).toHaveAttribute(
      'href',
      `/meal-plans?profile=${profile.id}`,
    );
  });

  it("says that it could not be read, in the place of figures that would be nobody's", async () => {
    shown(new ApiClientError(500, 'INTERNAL', 'the text of the API'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(texts.energy)).toBeNull();
  });
});
