// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealPlan } from '@diet-app/shared';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import { plain } from '@/testing/spaces';
import messages from '../../../../messages/en.json';
import { TargetMovedLine } from './target-moved-line';

const texts = messages.mealPlans;
const today = localDate();

const aDay = (date: string, listed = false) =>
  ({ date, skipped: false, listed }) as MealPlan['days'][number];
const aPlan = (over: Partial<MealPlan> = {}): MealPlan =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    revision: 4,
    targetMoved: { profileTarget: 2440, planTarget: 2135 },
    days: [aDay(dayAfter(today, -1), true), aDay(today), aDay(dayAfter(today, 1))],
    ...over,
  }) as MealPlan;

function shown(plan: MealPlan) {
  const onTaken = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <TargetMovedLine plan={plan} onTaken={onTaken} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onTaken };
}

describe("a running plan whose profile's target moved", () => {
  afterEach(() => vi.restoreAllMocks());

  it('says both targets, and takes the profile’s from today at the revision it was shown at', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    const { onTaken } = shown(aPlan());

    expect(plain(screen.getByText(/^The profile's target is now/).textContent)).toBe(
      "The profile's target is now 2440 kcal, this plan counts 2135 kcal.",
    );
    expect(screen.getByText(texts.retargetNote)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.retarget }));
    expect(post).toHaveBeenCalledWith('/meal-plans/11111111-1111-4111-8111-111111111111/retarget', {
      revision: 4,
    });
    expect(onTaken).toHaveBeenCalled();
  });

  it('says what it does to a shopping list only where a day it changes is on one', () => {
    shown(aPlan());
    // Only yesterday is on a list, and the days before today stay as they were.
    expect(screen.queryByText(texts.listOutOfDateDays)).toBeNull();
    shown(aPlan({ days: [aDay(today, true)] }));
    expect(screen.getByText(texts.listOutOfDateDays)).toBeInTheDocument();
  });

  it('is nothing for a plan whose target did not move', () => {
    shown(aPlan({ targetMoved: null }));
    expect(screen.queryByRole('button', { name: texts.retarget })).toBeNull();
  });
});
