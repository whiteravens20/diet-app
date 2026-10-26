// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient, OwnRecipePreview } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { EMPTY_RECIPE, measurableIn, OwnRecipeForm, type OwnRecipeDraft } from './own-recipe-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const text = messages.ownRecipe;

const rice = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'White rice',
  canonicalUnit: 'g',
  gramsPerPiece: null,
  density: null,
} as Ingredient;
const egg = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Egg',
  canonicalUnit: 'g',
  gramsPerPiece: 50,
  density: null,
} as Ingredient;
const milk = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Milk',
  canonicalUnit: 'ml',
  gramsPerPiece: null,
  density: 1.03,
} as Ingredient;
const serving: OwnRecipePreview = {
  nutritionPerServing: { calories: 412, protein: 20, fat: 11, carbs: 58 },
  allergens: ['eggs'],
  dietTags: ['vegetarian'],
};

/** The form, the catalogue answering a search with rice and an egg, and the API answering `answer` to a save. */
function opened(
  initial: OwnRecipeDraft = EMPTY_RECIPE,
  editing?: string,
  answer?: () => Promise<unknown>,
) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve((path.startsWith('/ingredients?search=') ? [rice, egg] : []) as never),
  );
  const saved = answer ?? (() => Promise.resolve({ id: '99999999-9999-4999-8999-999999999999' }));
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation(
      (path: string) => (path === '/recipes/preview' ? Promise.resolve(serving) : saved()) as never,
    );
  const put = vi.spyOn(api, 'put').mockImplementation((() => saved()) as never);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OwnRecipeForm initial={initial} editing={editing} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { post, put };
}

/** The recipe of the tests as it stands in a form: one line of rice, one step. */
const written: OwnRecipeDraft = {
  ...EMPTY_RECIPE,
  title: 'Rice bowl',
  description: 'Rice for lunch.',
  steps: ['Cook the rice.'],
  mealTypes: ['lunch'],
  ingredients: [{ ingredient: rice, quantity: 80, unit: 'g', note: null }],
};

afterEach(() => {
  vi.restoreAllMocks();
  push.mockReset();
});

describe('the units an ingredient of a recipe is offered in', () => {
  it('are the ones the engine can work an amount out of', () => {
    const units = (ingredient: Ingredient) =>
      (['g', 'ml', 'piece'] as const).filter((unit) => measurableIn(unit, ingredient));

    expect(units(rice)).toEqual(['g']);
    expect(units(egg)).toEqual(['g', 'piece']);
    expect(units(milk)).toEqual(['g', 'ml']);
    expect(units({ ...milk, gramsPerPiece: 250 })).toEqual(['g', 'ml', 'piece']);
    expect(units({ ...milk, density: null, gramsPerPiece: 250 })).toEqual(['ml']);
  });
});

describe('the form a recipe of one’s own is written in', () => {
  it('writes the recipe from what was typed and chosen, the ingredients from the catalogue, and opens it', async () => {
    const { post } = opened();

    await userEvent.type(screen.getByRole('textbox', { name: text.fieldTitle }), 'Egg fried rice');
    await userEvent.type(
      screen.getByRole('textbox', { name: text.fieldDescription }),
      'A quick lunch.',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: messages.enums.mealType.lunch }));
    await userEvent.type(
      screen.getByRole('searchbox', { name: new RegExp(`^${text.addIngredient}`) }),
      'ri',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'White rice' }));
    await userEvent.type(
      screen.getByRole('searchbox', { name: new RegExp(`^${text.addIngredient}`) }),
      'eg',
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Egg' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount of White rice' }), '80');
    await userEvent.type(screen.getByRole('textbox', { name: 'Amount of Egg' }), '2');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Unit of Egg' }), 'piece');
    await userEvent.type(screen.getByRole('textbox', { name: 'Note on Egg' }), 'beaten');
    await userEvent.type(screen.getByRole('textbox', { name: 'Step 1' }), 'Fry it all together.');

    // What a serving holds, as the engine works it out, before anything is saved.
    expect(
      await screen.findByText('412 kcal · protein 20 g · fat 11 g · carbohydrate 58 g'),
    ).toBeInTheDocument();
    expect(screen.getByText('Allergens: Eggs')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: text.save }));

    const saves = post.mock.calls.filter(([path]) => path === '/recipes');
    expect(saves).toEqual([
      [
        '/recipes',
        {
          title: 'Egg fried rice',
          description: 'A quick lunch.',
          steps: ['Fry it all together.'],
          servings: 1,
          mealTypes: ['lunch'],
          prepMinutes: 10,
          cookMinutes: 0,
          difficulty: 'easy',
          cuisine: null,
          ingredients: [
            { ingredientId: rice.id, quantity: 80, unit: 'g', note: null },
            { ingredientId: egg.id, quantity: 2, unit: 'piece', note: 'beaten' },
          ],
        },
      ],
    ]);
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith('/recipes/99999999-9999-4999-8999-999999999999'),
    );
  });

  it('cannot be saved before the recipe has a name, a meal, an ingredient with its amount and a step', async () => {
    opened();

    expect(screen.getByRole('button', { name: text.save })).toBeDisabled();
    expect(screen.getByText(text.previewWaiting)).toBeInTheDocument();
  });

  it('saves an edit to the recipe it edits, in the order the steps were put in', async () => {
    const { post, put } = opened({ ...written, steps: ['Rinse the rice.', 'Cook it.'] }, 'abc');

    await userEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }));
    await screen.findByText('412 kcal · protein 20 g · fat 11 g · carbohydrate 58 g');
    await userEvent.click(screen.getByRole('button', { name: text.save }));

    expect(put).toHaveBeenCalledExactlyOnceWith(
      '/recipes/abc',
      expect.objectContaining({ steps: ['Cook it.', 'Rinse the rice.'] }),
    );
    expect(post.mock.calls.filter(([path]) => path === '/recipes')).toEqual([]);
  });

  it('names each problem the API found by its place in the form', async () => {
    opened(written, undefined, () =>
      Promise.reject(
        new ApiClientError(
          400,
          'RECIPE_INVALID',
          'The recipe would break 2 rules.',
          undefined,
          undefined,
          {
            problems: [
              { path: 'titles.en', rule: 'markup', message: '' },
              { path: 'ingredients[0].quantity', rule: 'quantity-too-large', message: '' },
            ],
          },
        ),
      ),
    );

    await screen.findByText('412 kcal · protein 20 g · fat 11 g · carbohydrate 58 g');
    await userEvent.click(screen.getByRole('button', { name: text.save }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(messages.errors.RECIPE_INVALID);
    expect(alert).toHaveTextContent(`${text.fieldTitle}: ${text.problemMarkup}`);
    expect(alert).toHaveTextContent(`White rice: ${text.problemTooMuch}`);
    expect(push).not.toHaveBeenCalled();
  });

  it('opens the way to the recipe its writer has, where it is the same one', async () => {
    opened(written, undefined, () =>
      Promise.reject(
        new ApiClientError(409, 'RECIPE_ALREADY_YOURS', 'You have it.', undefined, undefined, {
          recipeId: '77777777-7777-4777-8777-777777777777',
        }),
      ),
    );

    await screen.findByText('412 kcal · protein 20 g · fat 11 g · carbohydrate 58 g');
    await userEvent.click(screen.getByRole('button', { name: text.save }));

    expect(await screen.findByRole('link', { name: text.openYours })).toHaveAttribute(
      'href',
      '/recipes/77777777-7777-4777-8777-777777777777',
    );
  });
});
