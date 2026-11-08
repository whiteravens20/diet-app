// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../../messages/en.json';
import RecipeDetailPage from './page';

const ID = '5d0e6f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a';
let address = '';
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ID }),
  useSearchParams: () => new URLSearchParams(address),
  useRouter: () => ({ push }),
}));

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
  labelPerServing: { fiber: null, sugars: null, salt: null, saturatedFat: null },
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
  push.mockReset();
});

describe('the page of one recipe', () => {
  it('says how far the amounts are from the meal of a plan it was opened from', async () => {
    address = 'portion=1.3';
    opened('seed');

    expect(
      await screen.findByText(
        'The original gives amounts for 2 servings, your meal is 1.3 servings.',
      ),
    ).toBeVisible();
    address = '';
  });

  it('says it of a whole cooking', async () => {
    address = 'portion=3.5&whole=1';
    opened('seed');

    expect(
      await screen.findByText(
        'The original gives amounts for 2 servings, this cooking comes to 3.5 servings.',
      ),
    ).toBeVisible();
    address = '';
  });

  it('believes no address that names what no meal holds', async () => {
    address = 'portion=1000';
    opened('seed');

    await screen.findByRole('link', { name: new RegExp(messages.recipeDetail.back) });
    expect(screen.queryByText(/The original gives/)).toBeNull();
    address = '';
  });

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

describe('deleting a recipe from its page', () => {
  it("is offered for a recipe of one's own, says what becomes of its plans and of a suggestion, and leads to one's own recipes", async () => {
    const deleted = vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(true);
    opened('manual');

    await userEvent.click(await screen.findByRole('button', { name: messages.recipes.delete }));

    expect(asked).toHaveBeenCalledWith(messages.recipes.deleteConfirm);
    expect(deleted).toHaveBeenCalledWith(`/recipes/${ID}`);
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/recipes?tab=mine'));
  });

  it('deletes nothing when the question is answered no', async () => {
    const deleted = vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    opened('ai');

    await userEvent.click(await screen.findByRole('button', { name: messages.recipes.delete }));

    expect(deleted).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('says so when the deletion fails, and stays', async () => {
    vi.spyOn(api, 'delete').mockRejectedValue(new Error('down'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    opened('swap');

    await userEvent.click(await screen.findByRole('button', { name: messages.recipes.delete }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.recipes.deleteFailed);
    expect(push).not.toHaveBeenCalled();
  });

  it('is not offered for a recipe of the library', async () => {
    opened('seed');

    expect(await screen.findByText('Lentil soup')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.recipes.delete })).toBeNull();
  });
});
