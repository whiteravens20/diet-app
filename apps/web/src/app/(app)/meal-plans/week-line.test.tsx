// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanWeek } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { WeekLine } from './week-line';

const PLAN = '11111111-1111-4111-8111-111111111111';
const texts = messages.mealPlans;
/** A week whose days aim off the plan's target since one of them was changed alone. */
const UNEVEN: PlanWeek = {
  from: '2026-01-05',
  to: '2026-01-11',
  target: 2135,
  average: 2181,
  uneven: true,
  listOutOfDate: false,
};

function shown(week: PlanWeek | undefined) {
  const onEvened = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient()}>
        <WeekLine planId={PLAN} revision={4} week={week} onEvened={onEvened} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onEvened };
}

describe('the line of a week of a plan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says nothing of a week that is even, or that nothing of can change any more', () => {
    shown({ ...UNEVEN, uneven: false });
    shown(undefined);

    expect(screen.queryByRole('button', { name: texts.evenWeek })).not.toBeInTheDocument();
  });

  it("says the average of a week off the plan's target, and what evening it out does before it is pressed", () => {
    shown(UNEVEN);

    expect(
      screen.getByText(
        "This week's average daily target: 2181 kcal, the plan's target: 2135 kcal.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(texts.evenWeekNote)).toBeInTheDocument();
  });

  it('says that the shopping list of its days goes out of date, where one covers them', async () => {
    shown({ ...UNEVEN, listOutOfDate: true });

    expect(screen.getByText(texts.listOutOfDateDays)).toBeInTheDocument();
  });

  it('says nothing of a list where none covers its days', () => {
    shown(UNEVEN);

    expect(screen.queryByText(texts.listOutOfDateDays)).not.toBeInTheDocument();
  });

  it('evens the week out on the plan as the page read it, and tells the page', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    const { onEvened } = shown(UNEVEN);

    await userEvent.click(screen.getByRole('button', { name: texts.evenWeek }));

    expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/weeks/even`, {
      date: UNEVEN.from,
      revision: 4,
    });
    await vi.waitFor(() => expect(onEvened).toHaveBeenCalled());
  });

  it('reads the plan again, and says so, where the plan changed since the page read it', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiClientError(409, 'PLAN_CHANGED', 'The plan changed.'),
    );
    const { onEvened } = shown(UNEVEN);

    await userEvent.click(screen.getByRole('button', { name: texts.evenWeek }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onEvened).toHaveBeenCalled();
  });
});
