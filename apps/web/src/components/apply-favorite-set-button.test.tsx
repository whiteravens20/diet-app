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
import messages from '../../messages/en.json';
import { ApplyFavoriteSetButton } from './apply-favorite-set-button';

const plan = {
  id: '55555555-5555-4555-8555-555555555555',
  startDate: localDate(),
  durationDays: 3,
  options: { mealPrepFriendly: false },
} as Pick<MealPlan, 'id' | 'startDate' | 'durationDays' | 'options'>;

describe('the sets offered for the days of a plan, when they cannot be read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says why above the choice', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(0, 'NETWORK', 'Failed to fetch'));
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ApplyFavoriteSetButton plan={plan} profileId="6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f" />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: messages.favoriteSets.apply }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
  });
});

describe('a set put on days of a plan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the page what it came to, and the days it was put on', async () => {
    const set = { id: '66666666-6666-4666-8666-666666666666', label: 'Weekday' };
    vi.spyOn(api, 'get').mockResolvedValue([set] as never);
    const answer = { id: plan.id, effects: null };
    const post = vi.spyOn(api, 'post').mockResolvedValue(answer as never);
    const onApplied = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ApplyFavoriteSetButton
            plan={plan}
            profileId="6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f"
            onApplied={onApplied}
          />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: messages.favoriteSets.apply }));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: messages.favoriteSets.applyPickSet }),
      await screen.findByRole('option', { name: 'Weekday' }),
    );
    await userEvent.click(screen.getByRole('button', { name: messages.favoriteSets.applyConfirm }));

    const days = [0, 1, 2].map((ahead) => dayAfter(localDate(), ahead));
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/favorite-sets/${set.id}/apply`, {
        planId: plan.id,
        dayDates: expect.arrayContaining(days),
      }),
    );
    expect(onApplied).toHaveBeenCalledWith(answer, days);
  });
});
