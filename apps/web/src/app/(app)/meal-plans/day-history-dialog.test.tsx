// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DayEvent, DayHistory } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../messages/en.json';
import { DayHistoryDialog, type HistoryOf } from './day-history-dialog';

const texts = messages.dayHistory;
const PLAN = '11111111-1111-4111-8111-111111111111';
const DAY = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const OATS = '44444444-4444-4444-8444-444444444444';
const SOUP = '55555555-5555-4555-8555-555555555555';

const NO_EFFECTS = { lists: [], thaw: [], freeze: [] };

const anEvent = (over: Partial<DayEvent> = {}): DayEvent => ({
  id: '66666666-6666-4666-8666-666666666666',
  at: '2026-11-25T09:12:00.000Z',
  cause: 'resize',
  own: true,
  from: [],
  meals: [
    {
      mealId: OATS,
      mealType: 'breakfast',
      before: { name: 'Oat porridge', servings: 1, calories: 400, eaten: false, leftover: false },
      after: { name: 'Oat porridge', servings: 1.2, calories: 480, eaten: false, leftover: false },
    },
  ],
  target: null,
  choice: null,
  effects: NO_EFFECTS,
  ...over,
});

const aHistory = (over: Partial<DayHistory> = {}): DayHistory => ({
  planId: PLAN,
  dayId: DAY,
  date: '2026-11-25',
  revision: 7,
  kept: null,
  holds: { ownMeals: [], eatenMeals: [], leftovers: [], rests: [], diaryEntries: 0 },
  events: [anEvent()],
  undo: {
    kind: 'restore',
    eventId: '66666666-6666-4666-8666-666666666666',
    restore: [{ mealId: OATS, scale: 1 }],
    alsoDays: [],
  },
  ...over,
});

const OF: HistoryOf = {
  planId: PLAN,
  dayId: DAY,
  date: '2026-11-25',
  profileId: PROFILE,
  resizes: false,
  from: 'plan',
};

function shown(history: DayHistory, of: Partial<HistoryOf> = {}) {
  vi.spyOn(api, 'get').mockResolvedValue(history as never);
  const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
  const changed = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DayHistoryDialog
          of={{ ...OF, ...of }}
          today="2026-11-25"
          onChanged={changed}
          onClose={() => {}}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { post, changed };
}

describe("a day's history", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what holds the day, each change with its cause and the portions it moved, and takes the last one back', async () => {
    const { post, changed } = shown(
      aHistory({
        holds: {
          ownMeals: ['Soup from the canteen'],
          eatenMeals: ['Oat porridge'],
          leftovers: [],
          rests: ['Chicken breast'],
          diaryEntries: 2,
        },
      }),
    );

    expect(await screen.findByText(texts.adjusts)).toBeInTheDocument();
    expect(screen.getByText('Meals of your own: Soup from the canteen.')).toBeInTheDocument();
    expect(screen.getByText('Eaten: Oat porridge.')).toBeInTheDocument();
    expect(screen.getByText('Rests of packs: Chicken breast.')).toBeInTheDocument();
    expect(screen.getByText('2 diary entries.')).toBeInTheDocument();
    expect(screen.getByText(texts.cause.resize)).toBeInTheDocument();
    expect(screen.getByText('Breakfast: Oat porridge, 400 → 480 kcal')).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: texts.undo });
    expect(undo).toHaveAccessibleDescription(texts.undoPortions);
    await userEvent.click(undo);
    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/rebalance`, {
      scope: 'day',
      restore: [{ mealId: OATS, scale: 1 }],
    });
    expect(changed).toHaveBeenCalledWith(PLAN);
  });

  it('says of a change of other days which day it was of, and that its undo takes theirs back too', async () => {
    shown(
      aHistory({
        events: [anEvent({ own: false, from: ['2026-11-24'] })],
        undo: {
          kind: 'restore',
          eventId: '66666666-6666-4666-8666-666666666666',
          restore: [{ mealId: OATS, scale: 1 }],
          alsoDays: ['2026-11-24'],
        },
      }),
    );

    expect(
      await screen.findByText('After a change of Nov 24 the rest of a pack this day shares moved.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: texts.undo })).toHaveAccessibleDescription(
      `${texts.undoPortions} It also undoes the change of Nov 24.`,
    );
  });

  it('tells a swap, an eaten mark, a meal added and one taken off by what happened to the meal', async () => {
    shown(
      aHistory({
        events: [
          anEvent({
            cause: 'swap',
            meals: [
              {
                mealId: OATS,
                mealType: 'breakfast',
                before: {
                  name: 'Oat porridge',
                  servings: 1,
                  calories: 400,
                  eaten: false,
                  leftover: false,
                },
                after: {
                  name: 'Shakshuka',
                  servings: 1,
                  calories: 450,
                  eaten: false,
                  leftover: false,
                },
              },
              {
                mealId: SOUP,
                mealType: 'dinner',
                before: {
                  name: 'Lentil soup',
                  servings: 1,
                  calories: 500,
                  eaten: false,
                  leftover: false,
                },
                after: {
                  name: 'Lentil soup',
                  servings: 1,
                  calories: 500,
                  eaten: true,
                  leftover: false,
                },
              },
            ],
          }),
          anEvent({
            id: '77777777-7777-4777-8777-777777777777',
            cause: 'own-meal',
            meals: [
              {
                mealId: SOUP,
                mealType: 'snack',
                before: null,
                after: { name: 'Apple', servings: 1, calories: 80, eaten: false, leftover: false },
              },
              {
                mealId: OATS,
                mealType: 'lunch',
                before: {
                  name: 'Salad',
                  servings: 1,
                  calories: 300,
                  eaten: false,
                  leftover: false,
                },
                after: null,
              },
            ],
          }),
        ],
        undo: null,
      }),
    );

    expect(
      await screen.findByText('Breakfast: Oat porridge → Shakshuka, 450 kcal'),
    ).toBeInTheDocument();
    expect(screen.getByText('Dinner: Lentil soup, eaten')).toBeInTheDocument();
    expect(screen.getByText('Snack: Apple added, 80 kcal')).toBeInTheDocument();
    expect(screen.getByText('Lunch: Salad removed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.undo })).toBeNull();
  });

  it("keeps the day's portions as they are, from the plan as it was read", async () => {
    const { post } = shown(aHistory({ undo: null }));

    const keep = await screen.findByRole('button', { name: texts.keep });
    expect(keep).toHaveAccessibleDescription(texts.keepNote);
    await userEvent.click(keep);
    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/days/${DAY}/keep`, { revision: 7 });
  });

  it("says the user's choice that holds the day, and offers no keeping of portions kept already", async () => {
    shown(aHistory({ kept: { choice: 'kept', at: '2026-11-25T08:00:00.000Z' }, undo: null }));

    expect(
      await screen.findByText(/^Your choice of portions: “Keep the portions as they are”/),
    ).toBeInTheDocument();
    expect(screen.getByText(texts.keptNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.keep })).toBeNull();
  });

  it('offers to size the day again only where that would move a meal', async () => {
    shown(aHistory(), { resizes: true });

    expect(
      await screen.findByRole('button', { name: messages.mealPlans.resizeDay }),
    ).toHaveAccessibleDescription(messages.mealPlans.resizeDayNotePlain);
  });

  it("says that sizing the day again counts its diary's entries as eaten, where it has some", async () => {
    const day = aHistory();
    shown({ ...day, holds: { ...day.holds, diaryEntries: 2 } }, { resizes: true });

    expect(
      await screen.findByRole('button', { name: messages.mealPlans.resizeDay }),
    ).toHaveAccessibleDescription(messages.mealPlans.resizeDayNote);
  });

  it("leads from the plan's day to its diary, and from the diary to the plan's day", async () => {
    shown(aHistory());
    expect(await screen.findByRole('link', { name: messages.mealPlans.openDiary })).toHaveAttribute(
      'href',
      `/diary?profile=${PROFILE}&date=2026-11-25`,
    );
  });

  it("leads from the diary to the plan's day", async () => {
    shown(aHistory(), { from: 'diary' });
    expect(await screen.findByRole('link', { name: texts.openInPlan })).toHaveAttribute(
      'href',
      `/meal-plans?profile=${PROFILE}&plan=${PLAN}&day=2026-11-25`,
    );
  });

  it('says so where a day keeps no change yet', async () => {
    shown(aHistory({ events: [], undo: null }));
    expect(await screen.findByText(texts.noChanges)).toBeInTheDocument();
  });
});
