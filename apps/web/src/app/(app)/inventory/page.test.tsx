// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ingredient, InventoryItem, type Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../messages/en.json';
import InventoryPage from './page';

const texts = messages.inventory;

const profile = { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000001', name: 'Anna' } as Profile;

/** A drink measured in millilitres whose bottle has a weight, but which has no density. */
const bottled = Ingredient.parse({
  id: '2dad81f3-0d9d-44e1-9ef3-000000000001',
  name: 'Bottled kefir',
  category: 'dairy',
  canonicalUnit: 'ml',
  caloriesPer100: 50,
  proteinPer100: 3,
  fatPer100: 2,
  carbsPer100: 4,
  gramsPerPiece: 400,
  displayUnit: 'piece',
});

/** Something counted in pieces, each of a known weight, with no density. */
const dumplings = Ingredient.parse({
  id: '2dad81f3-0d9d-44e1-9ef3-000000000002',
  name: 'Frozen dumplings',
  category: 'other',
  canonicalUnit: 'piece',
  caloriesPer100: 4000,
  proteinPer100: 150,
  fatPer100: 100,
  carbsPer100: 600,
  gramsPerPiece: 25,
});

/** A row of the pantry: `quantity` pieces of `ingredient`, best before `bestBefore`. */
const aRow = (ingredient: Ingredient, quantity: number, bestBefore: string | null): InventoryItem =>
  InventoryItem.parse({
    id: ingredient.id.replace('2dad81f3', '7c0ffee0'),
    ingredient,
    quantity,
    unit: 'piece',
    display: { quantity, unit: ingredient.displayUnit ?? 'piece' },
    bestBefore,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  });

/** The pantry page of an account with one profile whose pantry holds `rows`; a search finds `found`. */
async function open(found: Ingredient[], rows: InventoryItem[] = []) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles' ? [profile] : path.startsWith('/ingredients?') ? found : path.startsWith('/inventory?') ? rows : []) as never,
    ),
  );
  const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <InventoryPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await screen.findByText(rows.length > 0 ? rows[0]!.ingredient.name : texts.emptyTitle);
  return { post };
}

/** Find an ingredient by a part of its name and pick it. */
async function pick(ingredient: Ingredient) {
  await userEvent.type(screen.getByLabelText(texts.ingredientLabel), ingredient.name.slice(0, 4));
  await userEvent.click(await screen.findByRole('button', { name: ingredient.name }));
}

const unitsOffered = () =>
  within(screen.getByLabelText(texts.unitLabel))
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value);

describe('the form that puts an ingredient into the pantry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers only the units the ingredient can be kept in, and starts at one of them', async () => {
    const { post } = await open([bottled]);

    await pick(bottled);

    // Its bottles cannot be turned into millilitres without a density.
    expect(unitsOffered()).toEqual(['ml']);
    expect(screen.getByLabelText(texts.unitLabel)).toHaveValue('ml');
    await userEvent.type(screen.getByLabelText(texts.quantityLabel), '500');
    await userEvent.click(screen.getByRole('button', { name: texts.addButton }));
    expect(post).toHaveBeenCalledWith('/inventory', expect.objectContaining({ ingredientId: bottled.id, quantity: 500, unit: 'ml' }));
  });

  it('offers grams of what is kept in pieces of a known weight', async () => {
    await open([dumplings]);

    await pick(dumplings);

    expect(unitsOffered()).toEqual(['g', 'piece']);
    expect(screen.getByLabelText(texts.unitLabel)).toHaveValue('piece');
  });

  it('offers nothing but pieces for what is counted', async () => {
    const egg = Ingredient.parse({ ...dumplings, id: '2dad81f3-0d9d-44e1-9ef3-000000000004', name: 'Large egg', canonicalUnit: 'g', gramsPerPiece: 55, displayUnit: 'piece' });
    await open([egg]);

    await pick(egg);

    expect(unitsOffered()).toEqual(['piece']);
    expect(screen.getByLabelText(texts.unitLabel)).toHaveValue('piece');
  });
});

describe('a row of the pantry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names its amount and its day after its ingredient, so that one row is told from another', async () => {
    const garlic = Ingredient.parse({ ...dumplings, id: '2dad81f3-0d9d-44e1-9ef3-000000000003', name: 'Garlic', canonicalUnit: 'g', gramsPerPiece: 5, displayUnit: 'clove' });
    await open([], [aRow(dumplings, 12, '2026-11-05'), aRow(garlic, 3, null)]);

    expect(screen.getByLabelText(texts.quantityOf.replace('{name}', dumplings.name))).toHaveValue(12);
    expect(screen.getByLabelText(texts.bestBeforeOf.replace('{name}', dumplings.name))).toHaveValue('2026-11-05');
    expect(screen.getByLabelText(texts.quantityOf.replace('{name}', 'Garlic'))).toHaveValue(3);
    expect(screen.getByLabelText(texts.bestBeforeOf.replace('{name}', 'Garlic'))).toHaveValue('');
  });
});
