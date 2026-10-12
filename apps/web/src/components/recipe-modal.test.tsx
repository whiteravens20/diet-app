// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { IMAGERY } from '@/lib/imagery';
import messages from '../../messages/en.json';
import { RecipeModal } from './recipe-modal';

const RECIPE = '11111111-1111-4111-8111-111111111111';
const oats = {
  id: RECIPE,
  slug: 'oat-bowl',
  title: 'Oat bowl',
  description: 'Oats with a banana.',
  servings: 1,
  mealTypes: ['breakfast'],
  dietTags: ['vegan'],
  prepMinutes: 5,
  cookMinutes: 5,
  difficulty: 'easy',
  cuisine: null,
  allergens: [],
  origin: 'curated',
  aiMeta: null,
  steps: ['Warm the drink.', 'Stir in the oats.'],
  ingredients: [],
  nutritionPerServing: { calories: 420, protein: 14, fat: 9, carbs: 68 },
  byModel: null,
  source: null as { url: string | null; license: string } | null,
};

/** The window of the recipe, opened; `answer` is what the API says of it. */
function renderWindow(answer: () => Promise<unknown>) {
  vi.spyOn(api, 'get').mockImplementation((path: string) => (path === `/recipes/${RECIPE}` ? (answer() as never) : Promise.resolve([] as never)));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RecipeModal recipeId={RECIPE} onClose={() => undefined} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return within(screen.getByRole('dialog', { name: messages.recipeModal.title, hidden: true }));
}

describe('the window of a recipe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has a place for the recipe\'s photo over its text, filled from the app\'s own photographs, and says nothing of it to a reader', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats));

    expect(await dialog.findByRole('heading', { name: 'Oat bowl', hidden: true })).toBeInTheDocument();
    const photo = document.querySelector('[data-recipe-photo] img')!;
    expect(decodeURIComponent(photo.getAttribute('src') ?? '')).toContain(IMAGERY.recipes);
    expect(photo).toHaveAttribute('alt', '');
  });

  it('says nothing of where a recipe written here is from', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats));

    await dialog.findByRole('heading', { name: 'Oat bowl', hidden: true });
    expect(dialog.queryByText(/^Licence:/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it('says where a recipe that was taken in is from and under which licence, each as a link that tells the other site nothing', async () => {
    const dialog = renderWindow(() => Promise.resolve({ ...oats, source: { url: 'https://recipes.example/oat-bowl?ref=1', license: 'https://creativecommons.org/licenses/by/4.0/' } }));

    const from = await dialog.findByRole('link', { name: 'recipes.example', hidden: true });
    expect(from).toHaveAttribute('href', 'https://recipes.example/oat-bowl?ref=1');
    expect(from).toHaveAttribute('rel', 'noopener noreferrer');
    expect(from).toHaveAttribute('target', '_blank');
    expect(from.closest('p')).toHaveTextContent('From recipes.example · Licence: creativecommons.org');
    expect(dialog.getByRole('link', { name: 'creativecommons.org', hidden: true })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
  });

  it('writes a licence that is a name as a name, and makes no link of an address that is none of the web', async () => {
    const dialog = renderWindow(() => Promise.resolve({ ...oats, source: { url: 'javascript:alert(1)', license: 'CC BY-SA 4.0' } }));

    expect((await dialog.findByText('CC BY-SA 4.0')).closest('p')).toHaveTextContent(/^Licence: CC BY-SA 4\.0$/);
    expect(dialog.queryAllByRole('link', { hidden: true }).map((link) => link.getAttribute('href'))).not.toContain('javascript:alert(1)');
    expect(dialog.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it('shows no photo over a recipe that is not there', async () => {
    const dialog = renderWindow(() => Promise.reject(new ApiClientError(404, 'NOT_FOUND', 'No such recipe.')));

    expect(await dialog.findByText(messages.recipeDetail.notFound)).toBeInTheDocument();
    expect(document.querySelector('[data-recipe-photo]')).toBeNull();
  });
});
