// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { RecipeModal } from './recipe-modal';
import { spaced } from '@/testing/spaces';

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

/** The window of the recipe, opened; `answer` is what the API says of it, `meal` what a meal of a plan gives it. */
function renderWindow(
  answer: () => Promise<unknown>,
  meal: Pick<
    Parameters<typeof RecipeModal>[0],
    'amounts' | 'portion' | 'pot' | 'scale' | 'shared'
  > = {},
) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    path === `/recipes/${RECIPE}` ? (answer() as never) : Promise.resolve([] as never),
  );
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RecipeModal recipeId={RECIPE} onClose={() => undefined} {...meal} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return within(screen.getByRole('dialog', { name: messages.recipeModal.title, hidden: true }));
}

describe('the window of a recipe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The masks the drawing over a recipe's text is painted through. */
  const drawn = () =>
    [
      ...document.querySelectorAll<HTMLElement>('[data-recipe-photo] [aria-hidden="true"] > div'),
    ].map((layer) => layer.style.maskImage);

  it.each([
    ['porridge_dessert', 'dish-porridge'],
    ['soup', 'dish-soup'],
    ['salad', 'dish-salad'],
    ['sandwich', 'dish-sandwich'],
    ['plate', 'dish-plate'],
  ] as const)(
    'has over its text a drawing of its kind of dish (%s), which says nothing to a reader',
    async (form, drawing) => {
      const dialog = renderWindow(() =>
        Promise.resolve({
          ...oats,
          traits: { taste: 'sweet', form, starchBase: 'groats' },
        }),
      );

      expect(
        await dialog.findByRole('heading', { name: 'Oat bowl', hidden: true }),
      ).toBeInTheDocument();
      expect(drawn()).toEqual([
        `url("/drawings/${drawing}-fill.webp")`,
        `url("/drawings/${drawing}-line.webp")`,
      ]);
      expect(document.querySelector('[data-recipe-photo] img')).toBeNull();
    },
  );

  it('draws a plate over a recipe whose kind of dish is not given', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats));

    await dialog.findByRole('heading', { name: 'Oat bowl', hidden: true });
    expect(drawn()).toEqual([
      'url("/drawings/dish-plate-fill.webp")',
      'url("/drawings/dish-plate-line.webp")',
    ]);
  });

  it('says nothing of where a recipe written here is from', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats));

    await dialog.findByRole('heading', { name: 'Oat bowl', hidden: true });
    expect(dialog.queryByText(/^Licence:/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/^From /)).not.toBeInTheDocument();
  });

  it('says where a recipe that was taken in is from and under which licence, each as a link that tells the other site nothing', async () => {
    const dialog = renderWindow(() =>
      Promise.resolve({
        ...oats,
        source: {
          url: 'https://recipes.example/oat-bowl?ref=1',
          license: 'https://creativecommons.org/licenses/by/4.0/',
        },
      }),
    );

    const from = await dialog.findByRole('link', { name: 'recipes.example', hidden: true });
    expect(from).toHaveAttribute('href', 'https://recipes.example/oat-bowl?ref=1');
    expect(from).toHaveAttribute('rel', 'noopener noreferrer');
    expect(from).toHaveAttribute('target', '_blank');
    expect(from.closest('p')).toHaveTextContent(
      'From recipes.example · Licence: creativecommons.org',
    );
    expect(dialog.getByRole('link', { name: 'creativecommons.org', hidden: true })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/4.0/',
    );
  });

  it('writes a licence that is a name as a name, and makes no link of an address that is none of the web', async () => {
    const dialog = renderWindow(() =>
      Promise.resolve({ ...oats, source: { url: 'javascript:alert(1)', license: 'CC BY-SA 4.0' } }),
    );

    expect((await dialog.findByText('CC BY-SA 4.0')).closest('p')).toHaveTextContent(
      /^Licence: CC BY-SA 4\.0$/,
    );
    expect(
      dialog.queryAllByRole('link', { hidden: true }).map((link) => link.getAttribute('href')),
    ).not.toContain('javascript:alert(1)');
    expect(dialog.queryByText(/^From /)).not.toBeInTheDocument();
  });

  // What is below comes first, the recipe's own servings after it; where the two are the same, one sentence says
  // so, not the same number twice.
  it.each([
    [
      'a meal of more servings than the recipe makes',
      { servings: 2, whole: false },
      'Below are the amounts for your meal: 2 servings. The original recipe makes 1 serving.',
    ],
    [
      'a meal of as many servings as the recipe makes',
      { servings: 1, whole: false },
      'Below are the amounts for your meal: 1 serving, as in the original recipe.',
    ],
    [
      'a whole cooking of more servings',
      { servings: 2.5, whole: true },
      'Below are the amounts for the whole cooking: 2.5 servings. The original recipe makes 1 serving.',
    ],
    [
      'a whole cooking of as many servings',
      { servings: 1, whole: true },
      'Below are the amounts for the whole cooking: 1 serving, as in the original recipe.',
    ],
  ])('says what the amounts below are for, of %s', async (_, portion, said) => {
    const dialog = renderWindow(() => Promise.resolve(oats), { portion });

    expect(await dialog.findByText(spaced(said))).toBeInTheDocument();
  });

  it("gives beside the portion the factor the planner sized the meal by, from a twentieth off its plan's portion", async () => {
    const dialog = renderWindow(() => Promise.resolve(oats), {
      portion: { servings: 1.2, whole: false },
      scale: 1.22,
    });

    expect(await dialog.findByText('auto-balanced ×1.22')).toBeInTheDocument();
  });

  it('gives no factor of a meal the planner sized by less', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats), {
      portion: { servings: 1, whole: false },
      scale: 1.04,
    });

    expect(
      await dialog.findByText(
        spaced('Below are the amounts for your meal: 1 serving, as in the original recipe.'),
      ),
    ).toBeInTheDocument();
    expect(dialog.queryByText(/auto-balanced/)).toBeNull();
  });

  it("says the other person's portion of a meal each cooks apart, and what their plates hold otherwise", async () => {
    const dialog = renderWindow(() => Promise.resolve(oats), {
      portion: { servings: 1, whole: false },
      shared: {
        name: 'Ewa',
        servings: 1.2,
        kcal: 439,
        eaten: true,
        plates: [
          {
            ingredientId: '55555555-5555-4555-8555-555555555555',
            name: 'Rolled oats',
            mine: { quantity: 60, unit: 'g' },
            theirs: { quantity: 80, unit: 'g' },
          },
        ],
      },
    });

    expect(
      await dialog.findByText(spaced('Ewa: 1.2 servings · 439 kcal · eaten'), { exact: false }),
    ).toBeInTheDocument();
    const plates = dialog.getByRole('table');
    expect(within(plates).getByRole('columnheader', { name: 'Ewa' })).toBeInTheDocument();
    expect(within(plates).getByRole('row', { name: /Rolled oats/ })).toHaveTextContent(
      /60\s?g.*80\s?g/,
    );
  });

  it('leaves the portions of a pot to the line of the pot', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats), {
      portion: { servings: 2, whole: false },
      pot: { mine: 1, name: 'Ewa', theirs: 1, plates: [] },
      shared: { name: 'Ewa', servings: 1, kcal: 300, eaten: false, plates: [] },
    });

    expect(await dialog.findByText(/of which you 1, Ewa 1/)).toBeInTheDocument();
    expect(dialog.queryByText(/^Ewa: /)).toBeNull();
  });

  it('says of a pot as big as the recipe that the original makes as many too', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats), {
      portion: { servings: 1, whole: false },
      pot: { mine: 0.5, name: 'Ewa', theirs: 0.5, plates: [] },
    });

    expect(
      await dialog.findByText(
        spaced(
          'Below are the amounts for the whole pot: 1 serving, of which you 0.5, Ewa 0.5. The original recipe makes 1 serving too.',
        ),
      ),
    ).toBeInTheDocument();
  });

  it('sends the recipe with the amounts and servings of the meal it was opened from', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const dialog = renderWindow(() => Promise.resolve(oats), {
      amounts: [
        {
          ingredientId: '22222222-2222-4222-8222-222222222222',
          name: 'Oats',
          quantity: 180,
          unit: 'g',
          display: { quantity: 180, unit: 'g' },
          note: null,
        },
      ],
      portion: { servings: 3, whole: true },
    });

    await userEvent.click(
      await dialog.findByRole('button', { name: messages.recipeShare.text, hidden: true }),
    );

    expect((writeText.mock.calls[0]![0] as string).split('\n').slice(0, 4)).toEqual([
      'Oat bowl',
      '',
      'Ingredients for 3 servings:',
      '- Oats: 180 g',
    ]);
    vi.unstubAllGlobals();
  });

  it('says under an ingredient of the meal how much of its amount is the rest of a pack the meal finishes', async () => {
    const dialog = renderWindow(() => Promise.resolve(oats), {
      amounts: [
        {
          ingredientId: '22222222-2222-4222-8222-222222222222',
          name: 'Oats',
          quantity: 180,
          unit: 'g',
          display: { quantity: 180, unit: 'g' },
          note: null,
          rest: { quantity: 30, display: { quantity: 30, unit: 'g' } },
        },
      ],
      portion: { servings: 3, whole: true },
    });

    expect(
      await dialog.findByText('including 30 g, so that nothing is left in the pack'),
    ).toBeInTheDocument();
    expect(dialog.getByText('180 g')).toBeInTheDocument();
  });

  it('shows no photo over a recipe that is not there', async () => {
    const dialog = renderWindow(() =>
      Promise.reject(new ApiClientError(404, 'NOT_FOUND', 'No such recipe.')),
    );

    expect(await dialog.findByText(messages.recipeDetail.notFound)).toBeInTheDocument();
    expect(document.querySelector('[data-recipe-photo]')).toBeNull();
  });
});
