// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealPlan } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError, localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import { plain } from '@/testing/spaces';
import messages from '../../../../messages/en.json';
import pl from '../../../../messages/pl.json';
import { ProfileMovedNote } from './profile-moved-note';

const texts = messages.mealPlans;
const today = localDate();
const PLAN = '11111111-1111-4111-8111-111111111111';

const aDay = (date: string, listed = false) =>
  ({ date, skipped: false, listed }) as MealPlan['days'][number];
const aPlan = (over: Partial<MealPlan> = {}): MealPlan =>
  ({
    id: PLAN,
    revision: 4,
    targetMoved: null,
    splitMoved: false,
    dietMoved: null,
    mealCountMoved: null,
    days: [aDay(dayAfter(today, -1), true), aDay(today), aDay(dayAfter(today, 1))],
    ...over,
  }) as MealPlan;
const moved = { profileTarget: 2440, planTarget: 2135 };

function shown(plan: MealPlan, language: 'en' | 'pl' = 'en') {
  const onTaken = vi.fn();
  const onReroll = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale={language} messages={language === 'en' ? messages : pl}>
        <ProfileMovedNote plan={plan} onTaken={onTaken} onReroll={onReroll} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onTaken, onReroll };
}

describe('a running plan its profile moved away from', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says both targets, and takes the profile’s from today at the revision it was shown at', async () => {
    const answer = { id: 'the-plan-as-it-left-it', effects: null };
    const post = vi.spyOn(api, 'post').mockResolvedValue(answer as never);
    const { onTaken } = shown(aPlan({ targetMoved: moved }));

    expect(plain(screen.getByText(/^The profile's target is now/).textContent)).toBe(
      "The profile's target is now 2440 kcal, this plan counts 2135 kcal.",
    );
    expect(screen.getByText(texts.retargetNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.takeCount })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: texts.retarget }));
    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/retarget`, { revision: 4 });
    expect(onTaken).toHaveBeenCalledWith(answer, 'retarget');
  });

  it('says that only the split moved where the target did not, and takes it the same way', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    shown(aPlan({ splitMoved: true }));

    expect(screen.getByText(texts.movedSplit)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.retarget }));
    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/retarget`, { revision: 4 });
  });

  it('says both numbers of meals, and adds or takes away the times of day from today, beside the target', async () => {
    const answer = { id: 'the-plan-as-it-left-it', effects: null };
    const post = vi.spyOn(api, 'post').mockResolvedValue(answer as never);
    const { onTaken } = shown(
      aPlan({ targetMoved: moved, mealCountMoved: { profileCount: 4, planCount: 3 } }),
    );

    expect(plain(screen.getByText(/^The profile eats/).textContent)).toBe(
      'The profile eats 4 meals a day now, and this plan 3.',
    );
    expect(screen.getByText(texts.takeCountNote)).toBeInTheDocument();
    // Both moved: both are offered.
    expect(screen.getByRole('button', { name: texts.retarget })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.takeCount }));
    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/meal-count`, { revision: 4 });
    expect(onTaken).toHaveBeenCalledWith(answer, 'meal-count');
  });

  it('offers only to make the days from today again where the diet moved, which takes all of it', async () => {
    const post = vi.spyOn(api, 'post');
    const { onReroll } = shown(
      aPlan({
        targetMoved: moved,
        dietMoved: { profileDiet: 'vegetarian', planDiet: 'balanced' },
        mealCountMoved: { profileCount: 4, planCount: 3 },
      }),
    );

    expect(
      screen.getByText(
        'The profile is on the Vegetarian diet now, and this plan was made for the Balanced diet.',
      ),
    ).toBeInTheDocument();
    // What moved is said, and one way takes it all.
    expect(screen.getByText(/^The profile eats/)).toBeInTheDocument();
    expect(screen.getByText(/^The profile's target is now/)).toBeInTheDocument();
    expect(screen.getByText(texts.rerollFromTodayNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.retarget })).toBeNull();
    expect(screen.queryByRole('button', { name: texts.takeCount })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: texts.rerollFromToday }));
    expect(onReroll).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it('says what it does to a shopping list only where a day it changes is on one', () => {
    shown(aPlan({ targetMoved: moved }));
    // Only yesterday is on a list, and the days before today stay as they were.
    expect(screen.queryByText(texts.listOutOfDateDays)).toBeNull();
    shown(aPlan({ targetMoved: moved, days: [aDay(today, true)] }));
    expect(screen.getByText(texts.listOutOfDateDays)).toBeInTheDocument();
  });

  it('says why where taking the number of meals fails', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiClientError(500, 'ERROR', 'down'));
    shown(aPlan({ mealCountMoved: { profileCount: 2, planCount: 3 } }));

    await userEvent.click(screen.getByRole('button', { name: texts.takeCount }));
    expect(await screen.findByRole('alert')).toHaveTextContent(texts.errTakeCount);
  });

  it('is nothing for a plan nothing of which moved', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages}>
          <ProfileMovedNote plan={aPlan()} onTaken={vi.fn()} onReroll={vi.fn()} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    [4, 'Profil ma teraz 4 posiłki dziennie, a ten plan 3.'],
    [5, 'Profil ma teraz 5 posiłków dziennie, a ten plan 3.'],
  ])('says it in Polish of %i meals a day', (count, said) => {
    shown(aPlan({ mealCountMoved: { profileCount: count, planCount: 3 } }), 'pl');
    expect(plain(screen.getByText(/^Profil ma teraz/).textContent)).toBe(said);
  });
});
