// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient } from '@diet-app/shared';
import { api } from '@/lib/api';
import { plain } from '@/testing/spaces';
import { ApiClientError } from '@/lib/http';
import pl from '../../messages/pl.json';
import { IngredientPicker } from './ingredient-picker';

const MUSHROOMS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Grzyby enoki' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Grzyby shiitake' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Grzyby maitake' },
] as Ingredient[];

afterEach(() => vi.restoreAllMocks());

function picking(ids: string[] = []) {
  const onChange = vi.fn();
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      path.includes('search=') ? MUSHROOMS : MUSHROOMS.filter((i) => ids.includes(i.id)),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="pl" messages={pl}>
        <IngredientPicker label="Unikane składniki" ids={ids} onChange={onChange} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return onChange;
}

describe('a list of ingredients of a profile', () => {
  it('adds every result ticked at once, and clears the search', async () => {
    const onChange = picking();
    const search = screen.getByPlaceholderText(pl.pickers.ingredientSearch);
    await userEvent.type(search, 'grzyby');
    const add = await screen.findByRole('button', { name: 'Dodaj zaznaczone (0)' });
    expect(add).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Grzyby enoki' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Grzyby maitake' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dodaj zaznaczone (2)' }));

    expect(onChange).toHaveBeenCalledWith([MUSHROOMS[0]!.id, MUSHROOMS[2]!.id]);
    expect(search).toHaveValue('');
  });

  it('offers no result the list holds already', async () => {
    picking([MUSHROOMS[1]!.id]);
    await userEvent.type(screen.getByPlaceholderText(pl.pickers.ingredientSearch), 'grzyby');
    await screen.findByRole('checkbox', { name: 'Grzyby enoki' });
    expect(screen.queryByRole('checkbox', { name: 'Grzyby shiitake' })).toBeNull();
  });
});

describe('a list of foods to avoid', () => {
  // An onion, and its kin: a red onion and shallots. Leeks are no kin of it.
  const ONION = { id: '44444444-4444-4444-8444-444444444444', name: 'Cebula' };
  const RED = { id: '55555555-5555-4555-8555-555555555555', name: 'Cebula czerwona' };
  const SHALLOT = { id: '66666666-6666-4666-8666-666666666666', name: 'Szalotka' };
  const FOODS = [
    { ...ONION, kin: [RED.id, SHALLOT.id] },
    { ...RED, kin: [ONION.id, SHALLOT.id] },
    { ...SHALLOT, kin: [ONION.id, RED.id] },
  ] as Ingredient[];

  /** The list, its ids kept as the page keeps them, the API answering from `FOODS`. */
  function avoiding(offerKin?: string) {
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      const ids = new URLSearchParams(path.split('?')[1]).get('ids');
      return Promise.resolve(
        ids === null
          ? FOODS.filter((food) => food.name.toLowerCase().startsWith('cebula'))
          : FOODS.filter((food) => ids.split(',').includes(food.id)),
      );
    });
    const changes: string[][] = [];
    function Host() {
      const [ids, setIds] = useState<string[]>([]);
      return (
        <IngredientPicker
          label="Unikane składniki"
          ids={ids}
          onChange={(next) => {
            changes.push(next);
            setIds(next);
          }}
          offerKin={offerKin}
        />
      );
    }
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="pl" messages={pl}>
          <Host />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    return changes;
  }
  const addOnion = async () => {
    await userEvent.type(screen.getByPlaceholderText(pl.pickers.ingredientSearch), 'cebula');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Cebula' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dodaj zaznaczone (1)' }));
  };

  it('offers the kin of a food added, and adds only the one taken', async () => {
    const changes = avoiding(pl.profile.avoidKin);
    await addOnion();

    const offer = await screen.findByRole('group', { name: pl.profile.avoidKin });
    expect(offer).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '+ Szalotka' }));

    expect(changes).toEqual([[ONION.id], [ONION.id, SHALLOT.id]]);
    // Still offered: the kin not taken yet, until it is declined.
    expect(screen.getByRole('button', { name: '+ Cebula czerwona' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: pl.pickers.kinNo }));
    expect(screen.queryByRole('group', { name: pl.profile.avoidKin })).toBeNull();
    expect(changes).toHaveLength(2);
  });

  it('offers no kin on a list that does not ask for them', async () => {
    avoiding();
    await addOnion();

    await screen.findByText('Cebula', { selector: 'li' });
    expect(screen.queryByRole('button', { name: '+ Szalotka' })).toBeNull();
  });
});

describe('a search for ingredients that cannot be read', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says why, and not that nothing was found', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(0, 'NETWORK', 'Failed to fetch'));
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="pl" messages={pl}>
          <IngredientPicker label="Unikane składniki" ids={[]} onChange={vi.fn()} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    await userEvent.type(screen.getByPlaceholderText(pl.pickers.ingredientSearch), 'grzyby');

    // The Polish text holds its one-letter words with no-break spaces, which the reader sees as plain ones.
    expect(await screen.findByRole('alert')).toHaveTextContent(plain(pl.errors.NETWORK));
    expect(screen.queryByText(pl.pickers.noMatches)).toBeNull();
  });
});
