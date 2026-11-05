// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient } from '@diet-app/shared';
import { api } from '@/lib/api';
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
