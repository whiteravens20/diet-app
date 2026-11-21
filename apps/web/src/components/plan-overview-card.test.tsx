// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanOverview, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { PlanOverviewCard } from './plan-overview-card';
import { plain } from '@/testing/spaces';
import { failReadsAgain } from '@/testing/read-again';

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
    target: { protein: 119, fat: 63, carbs: 214, carbsFloor: null },
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

/** The client of the card shown last. */
let shownWith: QueryClient;

function shown(answer: PlanOverview | null | Error) {
  vi.spyOn(api, 'get').mockImplementation(() =>
    answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve({ overview: answer } as never),
  );
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={(shownWith = new QueryClient({ defaultOptions: { queries: { retry: false } } }))}
      >
        <PlanOverviewCard profile={profile} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** What a figure of the card says: its number and the sentence under it. */
const figure = (label: string): string =>
  plain(screen.getByText(label).closest('div')?.querySelector('dd')?.textContent).trim();

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

  it('says the figures that change while the plan runs, each with what it is a share of, and no other', async () => {
    shown(anOverview());
    await screen.findByRole('heading', { name: texts.title.active });

    expect(figure(texts.energy)).toBe('1880 kcalOn average, against a target of 1900 kcal.');
    expect(figure(texts.eaten)).toBe('50%3 of the 6 meals that were due by today.');
    expect(figure(texts.shopping)).toBe('25%5 of 20 entries ticked on the plan’s lists.');
    expect(document.querySelectorAll('dt')).toHaveLength(3);
  });

  it('draws the days where they differ: a day skipped, a target of their own, or apart by a twentieth', async () => {
    const days = (calories: number[], targets = calories.map(() => 1900)) =>
      calories.map((kcal, i) => ({
        date: `2026-01-0${5 + i}`,
        calories: kcal,
        target: targets[i]!,
        skipped: false,
      }));
    const drawn = async (overview: PlanOverview): Promise<boolean> => {
      shown(overview);
      await screen.findByRole('heading', { name: texts.title.active });
      const chart = document.querySelector('[data-days-chart]') !== null;
      // The heading goes with the chart; the days in words stay for whoever does not see it.
      expect(screen.queryByRole('heading', { name: texts.days }) !== null).toBe(chart);
      expect(screen.getByRole('table', { name: texts.days })).toBeInTheDocument();
      cleanup();
      return chart;
    };

    expect(await drawn(anOverview())).toBe(true);
    expect(await drawn(anOverview({ days: days([1890, 1905, 1898]) }))).toBe(false);
    expect(await drawn(anOverview({ days: days([1860, 1955, 1900]) }))).toBe(true);
    expect(await drawn(anOverview({ days: days([1900, 1900], [1900, 1700]) }))).toBe(true);
  });

  it('says what a day holds of each macro against what it aims at', async () => {
    shown(anOverview());
    await screen.findByRole('heading', { name: texts.title.active });

    expect(screen.getByText('104 of 119 g')).toBeInTheDocument();
    expect(screen.getByText('70 of 63 g')).toBeInTheDocument();
    expect(screen.getByText('190 of 214 g')).toBeInTheDocument();
  });

  it("on low-carb says carbohydrate within the diet's band and draws the band under its bar, fat against what is left", async () => {
    // His day of 2170 kcal: 30 % from protein, carbohydrate from 54 g up to 108 g, fat what protein and 59 g leave.
    shown(
      anOverview({
        plan: { ...anOverview().plan, dietType: 'low_carb' },
        macros: {
          planned: { protein: 156, fat: 152, carbs: 59 },
          target: { protein: 163, fat: 142, carbs: 108, carbsFloor: 54 },
        },
      }),
    );
    await screen.findByRole('heading', { name: texts.title.active });

    const carbs = screen.getByText('59 g, in range 54–\u2060108 g');
    expect(screen.getByText('152 of 142 g')).toBeInTheDocument();
    // The band begins at the floor, half way along a bar that ends at the ceiling.
    const band = carbs.closest('li')!.querySelector<HTMLElement>('[data-band]');
    expect(band?.style.left).toBe('50%');
    // Protein and fat have no band.
    expect(document.querySelectorAll('[data-band]')).toHaveLength(1);
  });

  it('on keto says carbohydrate as a ceiling alone, its band the whole bar', async () => {
    shown(
      anOverview({
        plan: { ...anOverview().plan, dietType: 'keto' },
        macros: {
          planned: { protein: 140, fat: 160, carbs: 20 },
          target: { protein: 140, fat: 164, carbs: 27, carbsFloor: 0 },
        },
      }),
    );
    await screen.findByRole('heading', { name: texts.title.active });

    const carbs = screen.getByText('20 g, at most 27 g');
    expect(carbs.closest('li')!.querySelector<HTMLElement>('[data-band]')?.style.left).toBe('0%');
  });

  it('gives the days as a table to whoever does not see the chart, a skipped day as skipped', async () => {
    shown(anOverview());

    const rows = within(await screen.findByRole('table', { name: texts.days })).getAllByRole('row');
    expect(
      rows.map((row) => [...row.querySelectorAll('th, td')].map((cell) => plain(cell.textContent))),
    ).toEqual([
      ['Day', "Day's total", 'Target'],
      ['Mon, Jan 5', '1868 kcal', '1900 kcal'],
      ['Tue, Jan 6', 'Skipped', ''],
      ['Wed, Jan 7', '1911 kcal', '1900 kcal'],
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

describe('what the plan of the moment comes to, read again', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps its figures when a read fails again: the dashboard above it says why', async () => {
    shown(anOverview());
    expect(await screen.findByRole('heading', { name: texts.title.active })).toBeInTheDocument();

    await failReadsAgain(shownWith);
    await vi.waitFor(() => expect(vi.mocked(api.get)).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('heading', { name: texts.title.active })).toBeInTheDocument();
    expect(figure(texts.energy)).toMatch(/^1880/);
    expect(screen.queryByText(texts.failed)).toBeNull();
  });
});
