// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import ProfilePage from './page';

const aProfile = (name: string): Profile => ({
  id: `6f1c2b1e-7a52-4a3a-9d0e-${name.padEnd(12, '0').slice(0, 12)}`,
  userId: '0b9e8d7c-6f5e-4d3c-8b2a-1f0e9d8c7b6a',
  name,
  age: 30,
  sex: null,
  heightCm: 180,
  weightKg: 80,
  activityLevel: 'moderate',
  dietType: 'balanced',
  weeklyLossTarget: '0.5',
  manualCalorieTarget: null,
  riskAcknowledgedAt: null,
  mealCount: 3,
  weightReminderCadence: 'weekly',
  preferences: {
    favoriteIngredientIds: [],
    excludedIngredientIds: [],
    allergens: [],
    dislikedFoods: [],
    preferredCuisines: [],
    maxConsecutiveDaysSameMeal: 2,
    maxTimesPerWeekSameMeal: 3,
    maxWeeklyAmountPerIngredient: 3000,
    inventoryBiasResetEvery: 5,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** The page of an account with `profiles`, on an instance that allows an account `maxProfiles`. */
async function renderPage(profiles: Profile[], maxProfiles: number) {
  vi.spyOn(api, 'get').mockImplementation((path: string) => Promise.resolve((path === '/profiles' ? profiles : path.endsWith('/calories') ? { dailyTarget: 2209, warnings: [], macros: { protein: 0, fat: 0, carbs: 0 } } : []) as never));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig({ accounts: { maxProfiles } }));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <ProfilePage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  // A profile is named on its row and over its figures.
  await screen.findAllByText(profiles[0]!.name);
}

describe('the profile page, on how many profiles an account may hold', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says the number of the instance, and offers another profile under it', async () => {
    await renderPage([aProfile('First'), aProfile('Second')], 4);

    expect(screen.getByText(/An account on this instance can have up to 4 profiles/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.profile.addProfile })).toBeInTheDocument();
  });

  it('offers no other profile at the number, and says which number that is', async () => {
    await renderPage([aProfile('First'), aProfile('Second')], 2);

    expect(screen.queryByRole('button', { name: messages.profile.addProfile })).toBeNull();
    expect(screen.getByText(/You have reached the limit of 2 profiles that this instance allows an account/)).toBeInTheDocument();
  });

  it('words an instance that allows one profile as one', async () => {
    await renderPage([aProfile('Only')], 1);

    expect(screen.getByText(/An account on this instance can have one profile\./)).toBeInTheDocument();
    expect(screen.getByText(/You have reached the limit of one profile that this instance allows an account/)).toBeInTheDocument();
  });
});
