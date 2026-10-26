// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../../messages/en.json';
import RecipeDetailPage from './page';

const ID = '5d0e6f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a';
vi.mock('next/navigation', () => ({ useParams: () => ({ id: ID }) }));

const recipe = (origin: Recipe['origin']): Recipe => ({
  id: ID,
  title: 'Lentil soup',
  description: 'A soup.',
  servings: 2,
  mealTypes: ['lunch'],
  dietTags: [],
  ingredients: [],
  steps: ['Cook the lentils.'],
  prepMinutes: 10,
  cookMinutes: 30,
  difficulty: 'easy',
  cuisine: null,
  allergens: [],
  nutritionPerServing: { calories: 350, protein: 20, fat: 5, carbs: 50 },
  origin,
  byModel: null,
  source: null,
});

function opened(origin: Recipe['origin']) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve((path === `/recipes/${ID}` ? recipe(origin) : []) as never),
  );
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RecipeDetailPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the page of one recipe', () => {
  it.each(['manual', 'ai', 'swap'] as const)(
    'offers to edit a recipe of one’s own (%s)',
    async (origin) => {
      opened(origin);

      expect(await screen.findByRole('link', { name: messages.recipeDetail.edit })).toHaveAttribute(
        'href',
        `/recipes/${ID}/edit`,
      );
    },
  );

  it.each(['seed', 'curated'] as const)(
    'offers no edit of a recipe of the library (%s)',
    async (origin) => {
      opened(origin);

      await screen.findByRole('heading', { name: 'Lentil soup' });
      expect(screen.queryByRole('link', { name: messages.recipeDetail.edit })).toBeNull();
    },
  );
});
