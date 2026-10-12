// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import ProfilePage from './page';

const aProfile = (name: string, over: Partial<Profile> = {}): Profile => ({
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
  customMacroSplit: null,
  preferences: {
    favoriteIngredientIds: [],
    excludedIngredientIds: [],
    allergens: [],
    dislikedIngredientIds: [],
    preferredCuisines: [],
    maxConsecutiveDaysSameMeal: 2,
    maxTimesPerWeekSameMeal: 3,
    maxWeeklyAmountPerIngredient: 3000,
    inventoryBiasResetEvery: 5,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
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

describe('the profile form, on the custom diet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const texts = messages.profile;
  /** The form of the account's one profile, open. */
  const editing = async (profile: Profile) => {
    await renderPage([profile], 2);
    await userEvent.click(screen.getByRole('button', { name: messages.common.edit }));
    const put = vi.spyOn(api, 'put').mockResolvedValue(profile as never);
    return { put, save: () => userEvent.click(screen.getByRole('button', { name: texts.saveChanges })) };
  };
  const share = (part: 'protein' | 'fat' | 'carbs') => screen.getByLabelText(texts.split[part]);
  const type = async (part: 'protein' | 'fat' | 'carbs', value: string) => {
    await userEvent.clear(share(part));
    await userEvent.type(share(part), value);
  };

  it('asks for the split only on that diet, and begins with the balanced diet\'s', async () => {
    await editing(aProfile('Me'));
    expect(screen.queryByRole('group', { name: texts.customSplit })).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText(texts.dietType), 'custom');

    expect(screen.getByRole('group', { name: texts.customSplit })).toBeInTheDocument();
    expect([share('protein'), share('fat'), share('carbs')].map((field) => (field as HTMLInputElement).value)).toEqual(['25', '30', '45']);
    expect(screen.getByText('Adds up to 100 %.')).toBeInTheDocument();
  });

  it('says what the three add up to while they are typed, and sends nothing that does not add up to a hundred', async () => {
    const { put, save } = await editing(aProfile('Me'));
    await userEvent.selectOptions(screen.getByLabelText(texts.dietType), 'custom');

    await type('protein', '30');
    expect(screen.getByText('The three add up to 105 %. They have to add up to 100.')).toBeInTheDocument();
    await save();

    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(texts.splitSumRefused)).toBeInTheDocument();
  });

  it('sends the split with the custom diet', async () => {
    const { put, save } = await editing(aProfile('Me'));
    await userEvent.selectOptions(screen.getByLabelText(texts.dietType), 'custom');
    await type('protein', '30');
    await type('fat', '40');
    await type('carbs', '30');

    await save();

    expect(put.mock.calls[0]![1]).toMatchObject({ dietType: 'custom', customMacroSplit: { protein: 30, fat: 40, carbs: 30 } });
  });

  it('shows a profile on the custom diet the split it has, and keeps it for a profile that goes to another diet', async () => {
    const { put, save } = await editing(aProfile('Me', { dietType: 'custom', customMacroSplit: { protein: 30, fat: 40, carbs: 30 } }));
    expect([share('protein'), share('fat'), share('carbs')].map((field) => (field as HTMLInputElement).value)).toEqual(['30', '40', '30']);

    await userEvent.selectOptions(screen.getByLabelText(texts.dietType), 'vegan');
    await save();

    expect(put.mock.calls[0]![1]).toMatchObject({ dietType: 'vegan', customMacroSplit: { protein: 30, fat: 40, carbs: 30 } });
  });
});

describe('the profile page, on the cuisines a profile likes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cuisine = (name: string) => screen.getByRole('checkbox', { name });

  it('shows the ones the profile has, among all the application knows', async () => {
    await renderPage([aProfile('Me', { preferences: { ...aProfile('Me').preferences, preferredCuisines: ['asian'] } })], 2);

    expect(screen.getByRole('group', { name: messages.profile.cuisinesLabel })).toBeInTheDocument();
    expect(cuisine('Asian')).toBeChecked();
    expect(cuisine('Polish')).not.toBeChecked();
    expect(screen.getAllByRole('checkbox', { name: /^(Polish|Italian|Asian|Mediterranean|Middle Eastern|Mexican|American|Indian)$/ })).toHaveLength(8);
  });

  it('shows a tick at once and keeps it with the profile, in the order the application lists cuisines', async () => {
    // An API that keeps what it is sent, as the real one does: the page reads the profile again after every change.
    let kept = aProfile('Me', { preferences: { ...aProfile('Me').preferences, preferredCuisines: ['asian'] } });
    vi.spyOn(api, 'get').mockImplementation((path: string) => Promise.resolve((path === '/profiles' ? [kept] : path.endsWith('/calories') ? { dailyTarget: 2209, warnings: [], macros: { protein: 0, fat: 0, carbs: 0 } } : []) as never));
    const patch = vi.spyOn(api, 'patch').mockImplementation((_path: string, body: unknown) => {
      kept = { ...kept, preferences: { ...kept.preferences, ...(body as Partial<Profile['preferences']>) } };
      return Promise.resolve(kept as never);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['config'], aPublicConfig());
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={client}>
          <ProfilePage />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    await screen.findByRole('checkbox', { name: 'Asian', checked: true });

    await userEvent.click(cuisine('Polish'));
    expect(cuisine('Polish')).toBeChecked();
    await vi.waitFor(() => expect(cuisine('Asian')).toBeEnabled());
    await userEvent.click(cuisine('Asian'));

    expect(patch.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [`/profiles/${kept.id}/preferences`, { preferredCuisines: ['polish', 'asian'] }],
      [`/profiles/${kept.id}/preferences`, { preferredCuisines: ['polish'] }],
    ]);
    await vi.waitFor(() => expect(cuisine('Asian')).not.toBeChecked());
    expect(cuisine('Polish')).toBeChecked();
  });

  it('takes a tick back, and says so, when the API refuses the change', async () => {
    const profile = aProfile('Me');
    await renderPage([profile], 2);
    vi.spyOn(api, 'patch').mockRejectedValue(new ApiClientError(409, 'WRITE_CONFLICT', 'the text of the API'));

    await userEvent.click(cuisine('Polish'));

    await vi.waitFor(() => expect(cuisine('Polish')).not.toBeChecked());
    // Said on the page itself: the form, which is where a refusal used to be shown, is closed.
    expect(screen.getByRole('alert')).toHaveTextContent(messages.errors.WRITE_CONFLICT);
  });
});


describe('the profile page, on the foods a profile has an opinion of', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has a list for each opinion, each named for somebody who does not see its heading, with a search field of its own', async () => {
    await renderPage([aProfile('Me')], 2);

    for (const label of [messages.profile.favouritesLabel, messages.profile.dislikedLabel, messages.profile.avoidLabel]) {
      const list = within(screen.getByRole('group', { name: label }));
      expect(list.getByRole('textbox', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('textbox', { name: messages.profile.dislikedLabel })).toHaveAccessibleDescription(messages.profile.dislikedHint);
  });

  it('keeps a food the profile would rather not eat with the profile, as an ingredient of the catalogue', async () => {
    const profile = aProfile('Me');
    vi.spyOn(api, 'get').mockImplementation((path: string) =>
      Promise.resolve((path === '/profiles' ? [profile] : path.startsWith('/ingredients?search=') ? [{ id: '7b0e6a52-0d0a-4d6f-9d3e-3f5f0a1b2c3d', name: 'Firm tofu' }] : path.endsWith('/calories') ? { dailyTarget: 2209, warnings: [], macros: { protein: 0, fat: 0, carbs: 0 } } : []) as never),
    );
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(profile as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['config'], aPublicConfig());
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={client}>
          <ProfilePage />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    const list = within(await screen.findByRole('group', { name: messages.profile.dislikedLabel }));

    await userEvent.type(list.getByRole('textbox'), 'tofu');
    await userEvent.click(await list.findByRole('button', { name: 'Firm tofu' }));

    expect(patch).toHaveBeenCalledWith(`/profiles/${profile.id}/preferences`, { dislikedIngredientIds: ['7b0e6a52-0d0a-4d6f-9d3e-3f5f0a1b2c3d'] });
  });
});
