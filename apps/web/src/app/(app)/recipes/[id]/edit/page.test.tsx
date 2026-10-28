// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient, Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../../../messages/en.json';
import EditOwnRecipePage from './page';

const ID = '5d0e6f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a';
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ID }),
  useRouter: () => ({ push: vi.fn() }),
}));

const egg = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Egg',
  canonicalUnit: 'g',
  recipeUnits: ['g', 'piece'],
} as Ingredient;

const recipe = (origin: Recipe['origin']): Recipe => ({
  id: ID,
  title: 'Scrambled eggs',
  description: 'Eggs for breakfast.',
  servings: 1,
  mealTypes: ['breakfast'],
  dietTags: [],
  ingredients: [
    {
      ingredientId: egg.id,
      name: 'Egg',
      quantity: 2,
      unit: 'piece',
      display: { quantity: 2, unit: 'piece' },
      note: 'beaten',
    },
  ],
  steps: ['Beat the eggs.', 'Scramble them.'],
  prepMinutes: 5,
  cookMinutes: 5,
  difficulty: 'easy',
  cuisine: 'polish',
  allergens: ['eggs'],
  nutritionPerServing: { calories: 150, protein: 12, fat: 10, carbs: 1 },
  origin,
  byModel: null,
  source: null,
});

function opened(origin: Recipe['origin']) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === `/recipes/${ID}`
        ? recipe(origin)
        : path.startsWith('/ingredients?ids=')
          ? [egg]
          : []) as never,
    ),
  );
  vi.spyOn(api, 'post').mockResolvedValue({
    nutritionPerServing: { calories: 150, protein: 12, fat: 10, carbs: 1 },
    allergens: ['eggs'],
    dietTags: [],
  } as never);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <EditOwnRecipePage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the page that edits a recipe of one’s own', () => {
  it('starts from what the recipe holds, its ingredients measured as the catalogue allows', async () => {
    opened('manual');

    expect(
      await screen.findByRole('heading', { name: messages.ownRecipe.editTitle }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: messages.ownRecipe.fieldTitle })).toHaveValue(
      'Scrambled eggs',
    );
    expect(screen.getByRole('textbox', { name: 'Amount of Egg' })).toHaveValue('2');
    const unit = screen.getByRole('combobox', { name: 'Unit of Egg' });
    expect(unit).toHaveValue('piece');
    expect([...unit.querySelectorAll('option')].map((option) => option.value)).toEqual([
      'g',
      'piece',
    ]);
    expect(screen.getByRole('textbox', { name: 'Note on Egg' })).toHaveValue('beaten');
    expect(screen.getByRole('textbox', { name: 'Step 2' })).toHaveValue('Scramble them.');
    expect(screen.getByRole('checkbox', { name: messages.enums.mealType.breakfast })).toBeChecked();
  });

  it('says a recipe of the library is not there to edit', async () => {
    opened('curated');

    expect(await screen.findByText(messages.recipeDetail.notFound)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: messages.ownRecipe.fieldTitle })).toBeNull();
  });
});
