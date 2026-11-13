// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdList, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { plain } from '@/testing/spaces';
import messages from '../../../../messages/en.json';
import { HouseholdLists } from './household-lists';

const texts = messages.householdLists;
const ADAM = '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f';
const EWA = '7a2d3c4b-8e1f-4a5b-9c0d-1e2f3a4b5c6d';
const PLAN_ADAM = '11111111-1111-4111-8111-111111111111';
const LATER_ADAM = '33333333-3333-4333-8333-333333333333';
const PLAN_EWA = '22222222-2222-4222-8222-222222222222';
const HOUSEHOLD = '44444444-4444-4444-8444-444444444444';
const CHICKEN = '55555555-5555-4555-8555-555555555555';

const profiles = [
  { id: ADAM, name: 'Adam' },
  { id: EWA, name: 'Ewa' },
] as Profile[];

const aHousehold = (over: Partial<HouseholdList> = {}): HouseholdList => ({
  id: HOUSEHOLD,
  fromDate: '2026-01-06',
  toDate: '2026-01-07',
  parts: [
    {
      listId: '66666666-6666-4666-8666-666666666666',
      planId: PLAN_ADAM,
      profileId: ADAM,
      profile: 'Adam',
      fromDate: '2026-01-06',
      toDate: '2026-01-07',
      stale: false,
    },
    {
      listId: '77777777-7777-4777-8777-777777777777',
      planId: PLAN_EWA,
      profileId: EWA,
      profile: 'Ewa',
      fromDate: '2026-01-06',
      toDate: '2026-01-07',
      stale: false,
    },
  ],
  groups: [
    {
      category: 'meat',
      estimatedCalories: 360,
      items: [
        {
          id: CHICKEN,
          ingredientId: '88888888-8888-4888-8888-888888888888',
          name: 'Chicken breast',
          category: 'meat',
          totalQuantity: 300,
          unit: 'g',
          displayUnit: 'g',
          gramsPerPiece: null,
          alreadyHaveQuantity: 0,
          toBuyQuantity: 300,
          purchasedQuantity: null,
          pantryBestBefore: null,
          estimatedCalories: 360,
          packs: null,
          buyLater: [],
          checked: false,
          shares: [
            { profileId: ADAM, profile: 'Adam', totalQuantity: 150 },
            { profileId: EWA, profile: 'Ewa', totalQuantity: 150 },
          ],
        },
      ],
    },
  ],
  totalEstimatedCalories: 360,
  stale: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const aPlan = (id: string, startDate: string) => ({
  id,
  startDate,
  durationDays: 7,
  dietType: 'balanced',
});

function show(households: HouseholdList[] = [aHousehold()]) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/household-lists'
        ? households
        : path.startsWith(`/meal-plans?profileId=${ADAM}`)
          ? // The one that begins last first, as the API gives them.
            { items: [aPlan(LATER_ADAM, '2026-01-12'), aPlan(PLAN_ADAM, '2026-01-05')] }
          : path.startsWith(`/meal-plans?profileId=${EWA}`)
            ? { items: [aPlan(PLAN_EWA, '2026-01-06')] }
            : []) as never,
    ),
  );
  function Host() {
    const [opened, setOpened] = useState<string | null>(null);
    return <HouseholdLists profiles={profiles} opened={opened} onOpen={setOpened} />;
  }
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Host />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const open = async () =>
  userEvent.click(await screen.findByRole('button', { name: /Adam and Ewa/ }));

describe('the household lists of an account', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows one with whom it is for and what each profile needs of a row, and no proposals', async () => {
    show();
    await open();

    expect(screen.getByText('For: Adam and Ewa')).toBeInTheDocument();
    const row = screen.getByRole('checkbox', { name: 'Chicken breast' }).closest('li')!;
    expect(plain(within(row).getByText(/^Adam/).textContent)).toBe('Adam 150 g · Ewa 150 g');
    expect(
      screen.queryByRole('button', { name: messages.shoppingLists.proposals.ask }),
    ).not.toBeInTheDocument();
  });

  it('is made of a plan of each profile for the days, the newest that has one of them chosen', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aHousehold() as never);
    show([]);
    await userEvent.click(screen.getByRole('button', { name: texts.open }));
    fireEvent.change(screen.getByLabelText(messages.shoppingLists.fromDate), {
      target: { value: '2026-01-06' },
    });
    fireEvent.change(screen.getByLabelText(messages.shoppingLists.toDate), {
      target: { value: '2026-01-07' },
    });

    // Adam's later plan begins after the days: the one that has them is chosen.
    const adams = await screen.findByRole('combobox', { name: "Adam's plan" });
    expect(adams).toHaveValue(PLAN_ADAM);
    expect(within(adams).getAllByRole('option')).toHaveLength(1);

    // What making it does to the plans' own lists of these days is said before.
    expect(screen.getByText(texts.replaces)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.make }));
    expect(post).toHaveBeenCalledWith('/household-lists', {
      planIds: [PLAN_ADAM, PLAN_EWA],
      fromDate: '2026-01-06',
      toDate: '2026-01-07',
    });
  });

  it('asks for the plans of two profiles at least', async () => {
    show([]);
    await userEvent.click(screen.getByRole('button', { name: texts.open }));
    fireEvent.change(screen.getByLabelText(messages.shoppingLists.fromDate), {
      target: { value: '2026-01-06' },
    });
    fireEvent.change(screen.getByLabelText(messages.shoppingLists.toDate), {
      target: { value: '2026-01-07' },
    });
    await screen.findByRole('combobox', { name: "Ewa's plan" });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Ewa' }));
    expect(screen.getByRole('button', { name: texts.make })).toBeDisabled();
    expect(screen.getByText(texts.atLeastTwo)).toBeInTheDocument();
  });

  it('ticks a row at once, and sends the tick to the household list', async () => {
    const patch = vi.spyOn(api, 'patch').mockReturnValue(new Promise(() => {}));
    show();
    await open();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Chicken breast' }));
    // The row is drawn anew as ticked, before the server answers.
    expect(screen.getByRole('checkbox', { name: 'Chicken breast' })).toBeChecked();
    expect(patch).toHaveBeenCalledWith(`/household-lists/${HOUSEHOLD}/items/${CHICKEN}`, {
      checked: true,
    });
  });

  it('is deleted as a whole, once that is confirmed', async () => {
    const remove = vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    show();
    await open();

    await userEvent.click(screen.getByRole('button', { name: messages.common.delete }));
    expect(confirm).toHaveBeenCalledWith(texts.deleteConfirm);
    expect(remove).toHaveBeenCalledWith(`/household-lists/${HOUSEHOLD}`);
  });
});
