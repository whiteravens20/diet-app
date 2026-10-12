// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingList } from '@diet-app/shared';
import { api } from '@/lib/api';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import ShoppingListsPage from './page';

const texts = messages.shoppingLists;
const PLAN = '11111111-1111-4111-8111-111111111111';

const anEntry = (name: string, category: string) => ({
  id: `entry-${name}`,
  ingredientId: `ingredient-${name}`,
  name,
  category,
  totalQuantity: 200,
  unit: 'g',
  displayUnit: 'g',
  alreadyHaveQuantity: 0,
  toBuyQuantity: 200,
  purchasedQuantity: null,
  pantryBestBefore: null,
  checked: false,
});

const aList = {
  id: '22222222-2222-4222-8222-222222222222',
  planId: PLAN,
  fromDate: '2026-01-05',
  toDate: '2026-01-07',
  groups: [
    { category: 'grains', items: [anEntry('White rice', 'grains'), anEntry('Rolled oats', 'grains')] },
    { category: 'vegetables', items: [anEntry('Broccoli', 'vegetables')] },
  ],
  totalEstimatedCalories: 1200,
  stale: false,
  createdAt: '2026-01-01T00:00:00.000Z',
} as unknown as ShoppingList;

async function renderPage() {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles'
        ? [{ id: 'profile', name: 'Me' }]
        : path.startsWith('/meal-plans?')
          ? { items: [{ id: PLAN, startDate: '2026-01-05', durationDays: 3, dietType: 'balanced' }], page: 1, pageSize: 50, total: 1, totalPages: 1 }
          : path.startsWith('/shopping-lists?')
            ? [aList]
            : []) as never,
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig());
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <ShoppingListsPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return screen.findByLabelText(texts.findEntry);
}

/** The entries on screen, by the name each is ticked by. */
const entries = (): string[] => screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label') ?? '');

describe('a shopping list, looked through for an entry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows every entry under its aisle until something is looked for', async () => {
    await renderPage();

    expect(entries()).toEqual(['White rice', 'Rolled oats', 'Broccoli']);
    expect(screen.getAllByRole('heading', { level: 3 }).map((aisle) => aisle.textContent)).toEqual(expect.arrayContaining(['Grains', 'Vegetables']));
  });

  it('keeps the entries whose name holds the words, whatever their case, and the aisles that still have one', async () => {
    const find = await renderPage();

    await userEvent.type(find, 'RIC');

    expect(entries()).toEqual(['White rice']);
    expect(screen.queryByText('Vegetables')).toBeNull();

    await userEvent.clear(find);
    expect(entries()).toHaveLength(3);
  });

  it('says so when no entry has the words in its name', async () => {
    const find = await renderPage();

    await userEvent.type(find, 'salmon');

    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.getByText('No entry of this list has “salmon” in its name.')).toBeInTheDocument();
  });
});
