// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { aPreview } from '@/testing/calories';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import CalculatorPage from './page';

const texts = messages.calculator;
const fields = messages.profile;

const aProfile = (name: string, over: Partial<Profile> = {}): Profile => ({
  id: `6f1c2b1e-7a52-4a3a-9d0e-${name.padEnd(12, '0').slice(0, 12)}`,
  userId: '0b9e8d7c-6f5e-4d3c-8b2a-1f0e9d8c7b6a',
  name,
  age: 30,
  sex: 'male',
  heightCm: 180,
  weightKg: 80,
  targetWeightKg: null,
  activityLevel: 'moderate',
  dietType: 'balanced',
  weeklyLossTarget: '0.5',
  manualCalorieTarget: null,
  riskAcknowledgedAt: null,
  mealCount: 3,
  weightReminderCadence: 'weekly',
  customMacroSplit: null,
  preferences: {
    favoriteIngredientIds: [],
    excludedIngredientIds: [],
    allergens: [],
    dislikedIngredientIds: [],
    preferredCuisines: [],
    maxConsecutiveDaysSameMeal: 2,
    maxTimesPerWeekSameMeal: 3,
    maxMealsPerDaySameKind: null,
    maxMealsPerWeekSameKind: null,
    kindLimits: [],
    inventoryBiasResetEvery: 5,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** The calculator of an account with `profiles`, which weighs in kilograms. */
async function open(profiles: Profile[]) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles' ? profiles : path === '/users/me' ? { weightUnit: 'kg' } : []) as never,
    ),
  );
  const post = vi.spyOn(api, 'post').mockResolvedValue(aPreview() as never);
  const put = vi.spyOn(api, 'put');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig());
  client.setQueryData(['session'], { weightUnit: 'kg' });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <CalculatorPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await screen.findByRole('form', { name: texts.title });
  return {
    put,
    /** Every request that was not for what figures come to. */
    kept: () => post.mock.calls.filter(([path]) => path !== '/profiles/calories'),
    /** The figures the last answer was asked with. */
    asked: () =>
      post.mock.calls.filter(([path]) => path === '/profiles/calories').at(-1)?.[1] as
        Record<string, unknown> | undefined,
  };
}

const startFrom = () => within(screen.getByRole('group', { name: texts.startFrom }));

describe('the calculator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("begins with the figures of the account's first profile, and says what they come to", async () => {
    const { asked } = await open([
      aProfile('Anna', {
        age: 41,
        activityLevel: 'light',
        dietType: 'vegan',
        weeklyLossTarget: '0.25',
      }),
      aProfile('Adam'),
    ]);

    expect(startFrom().getByRole('button', { name: 'Anna' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText(fields.age)).toHaveValue(41);
    expect(screen.getByLabelText('Weight (kg)')).toHaveValue(80);
    expect(screen.getByLabelText(new RegExp(`^${fields.activityLevel}`))).toHaveValue('light');
    expect(screen.getByLabelText(fields.dietType)).toHaveValue('vegan');
    expect(screen.getByRole('radio', { name: /Lose 0.25 kg a week/ })).toBeChecked();
    expect(await screen.findByText('2209 kcal')).toBeInTheDocument();
    expect(asked()).toMatchObject({
      age: 41,
      activityLevel: 'light',
      dietType: 'vegan',
      weeklyLossTarget: '0.25',
    });
    // The number of meals a day changes no figure, and is not asked for here.
    expect(screen.queryByLabelText(fields.mealsPerDay)).toBeNull();
  });

  it('takes the figures of another profile when that one is picked', async () => {
    const { asked } = await open([aProfile('Anna'), aProfile('Adam', { age: 52, weightKg: 95 })]);

    await userEvent.click(startFrom().getByRole('button', { name: 'Adam' }));

    expect(startFrom().getByRole('button', { name: 'Adam' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText(fields.age)).toHaveValue(52);
    await vi.waitFor(() => expect(asked()).toMatchObject({ age: 52, weightKg: 95 }));
  });

  it('begins empty when the empty form is picked, and says what to type', async () => {
    await open([aProfile('Anna')]);
    await screen.findByText('2209 kcal');

    await userEvent.click(startFrom().getByRole('button', { name: texts.empty }));

    expect(screen.getByLabelText(fields.age)).toHaveValue(null);
    expect(screen.getByLabelText('Weight (kg)')).toHaveValue(null);
    expect(screen.getByText(messages.caloriePreview.pending)).toBeInTheDocument();
  });

  it('is an empty form for an account without a profile, with nothing to start from', async () => {
    await open([]);

    expect(screen.queryByRole('group', { name: texts.startFrom })).toBeNull();
    expect(screen.getByLabelText(fields.age)).toHaveValue(null);
    expect(screen.getByText(messages.caloriePreview.pending)).toBeInTheDocument();
  });

  it("works out what is typed over a profile's figures, and keeps none of it", async () => {
    const { asked, kept, put } = await open([aProfile('Anna')]);
    await screen.findByText('2209 kcal');

    await userEvent.clear(screen.getByLabelText('Weight (kg)'));
    await userEvent.type(screen.getByLabelText('Weight (kg)'), '72.5');
    await userEvent.selectOptions(
      screen.getByLabelText(new RegExp(`^${fields.activityLevel}`)),
      'very_active',
    );
    await userEvent.click(screen.getByRole('radio', { name: /Keep my weight/ }));
    // The field is named by its label and the line under it: it is found by how its name begins.
    await userEvent.type(
      screen.getByRole('spinbutton', {
        name: (name) => name.startsWith(fields.manualKcalOverride),
      }),
      '{Enter}',
    );

    await vi.waitFor(() =>
      expect(asked()).toMatchObject({
        weightKg: 72.5,
        activityLevel: 'very_active',
        weeklyLossTarget: null,
      }),
    );
    expect(kept()).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'profile' })).toHaveAttribute('href', '/profile');
  });

  it('asks for the split of the custom diet, and works nothing out until it adds up', async () => {
    const { asked } = await open([aProfile('Anna')]);
    await screen.findByText('2209 kcal');

    await userEvent.selectOptions(screen.getByLabelText(fields.dietType), 'custom');
    await vi.waitFor(() =>
      expect(asked()).toMatchObject({
        dietType: 'custom',
        customMacroSplit: { protein: 25, fat: 30, carbs: 45 },
      }),
    );
    await userEvent.clear(screen.getByLabelText(fields.split.protein));
    await userEvent.type(screen.getByLabelText(fields.split.protein), '30');

    expect(screen.getByText(messages.caloriePreview.pending)).toBeInTheDocument();
  });

  it('tells somebody for whom losing weight is a risk what the figures show until they say they understand it', async () => {
    const { asked } = await open([aProfile('Anna', { age: 16 })]);

    expect(screen.getByText(fields.risk.minor)).toBeInTheDocument();
    expect(screen.getByText(fields.risk.heldHere)).toBeInTheDocument();
    await screen.findByText('2209 kcal');
    expect(asked()).toMatchObject({ acknowledgeRisk: false });

    await userEvent.click(screen.getByRole('checkbox', { name: fields.risk.acknowledgeHere }));

    await vi.waitFor(() => expect(asked()).toMatchObject({ age: 16, acknowledgeRisk: true }));
  });
});
