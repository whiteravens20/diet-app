// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { CustomMealModal } from './custom-meal-modal';
import { aPublicConfig } from '@/testing/public-config';
import { spaced } from '@/testing/spaces';

const texts = messages.mealPlans;

/** The window as the page gives it: in the user's language, the instance's configuration already read. */
function Wrapped({ children, products = false }: { children: ReactNode; products?: boolean }) {
  const [client] = useState(() => {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const config = aPublicConfig();
    queries.setQueryData(['config'], {
      ...config,
      products: { ...config.products, offered: products },
    });
    return queries;
  });
  return (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

/** The meals of the day the window is opened for. */
const MEALS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    mealType: 'lunch',
    title: 'Chicken with rice',
    apart: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    mealType: 'dinner',
    title: 'Lentil soup',
    apart: null,
  },
];

function open() {
  const onSubmit = vi.fn();
  render(
    <Wrapped>
      <CustomMealModal date="2026-01-05" meals={MEALS} onClose={() => {}} onSubmit={onSubmit} />
    </Wrapped>,
  );
  return onSubmit;
}

describe('the shopping list of the day', () => {
  it('is said to go out of date where one covers the day, and nothing is said where none does', () => {
    const { rerender } = render(
      <Wrapped>
        <CustomMealModal
          date="2026-01-05"
          meals={MEALS}
          listed
          onClose={() => {}}
          onSubmit={vi.fn()}
        />
      </Wrapped>,
    );
    expect(screen.getByText(messages.mealPlans.listOutOfDateDay)).toBeInTheDocument();

    rerender(
      <Wrapped>
        <CustomMealModal date="2026-01-05" meals={MEALS} onClose={() => {}} onSubmit={vi.fn()} />
      </Wrapped>,
    );
    expect(screen.queryByText(messages.mealPlans.listOutOfDateDay)).not.toBeInTheDocument();
  });
});

describe('the note on the meal it replaces', () => {
  it('says what follows for the other meal of a cooking when one is chosen', async () => {
    render(
      <Wrapped>
        <CustomMealModal
          date="2026-01-05"
          meals={[
            {
              id: '33333333-3333-4333-8333-333333333333',
              mealType: 'lunch',
              title: 'Stew',
              apart: 'On Tuesday you cook this dish separately.',
            },
          ]}
          onClose={() => {}}
          onSubmit={() => {}}
        />
      </Wrapped>,
    );
    expect(screen.queryByText('On Tuesday you cook this dish separately.')).toBeNull();

    await userEvent.selectOptions(
      screen.getByLabelText(texts.customPlace),
      '33333333-3333-4333-8333-333333333333',
    );

    expect(screen.getByText('On Tuesday you cook this dish separately.')).toBeVisible();
  });
});

/** Type the numbers of one serving, a field with nothing to type being left empty, and how many servings the meal is. */
async function fill(
  serving: { calories: string; protein: string; fat: string; carbs: string },
  servings?: string,
) {
  const fields = [
    [texts.customCalories, serving.calories],
    [texts.customProtein, serving.protein],
    [texts.customFat, serving.fat],
    [texts.customCarbs, serving.carbs],
  ] as const;
  for (const [label, typed] of fields)
    if (typed) await userEvent.type(screen.getByLabelText(label), typed);
  if (servings !== undefined) {
    const field = screen.getByRole('spinbutton', { name: new RegExp(`^${texts.customServings}`) });
    await userEvent.clear(field);
    await userEvent.type(field, servings);
  }
}

const add = () => userEvent.click(screen.getByRole('button', { name: texts.customSubmit }));

describe("the window a meal of the user's own is added in", () => {
  it('says that the numbers are those of one serving, and what the meal adds to the day for the servings typed', async () => {
    open();

    expect(screen.getByRole('group', { name: texts.customPerServing })).toBeInTheDocument();
    expect(screen.getByText(texts.customTotalPending)).toBeInTheDocument();

    await fill({ calories: '900', protein: '30', fat: '20.4', carbs: '110' }, '2');

    // Two servings of 900 kcal are 1800 on the day, rounded as the API rounds them.
    expect(
      screen.getByText(
        'The meal adds to the day: 1800 kcal · protein 60 g · fat 41 g · carbs 220 g.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(texts.customTotalPending)).toBeNull();
  });

  it('sends the numbers of one serving and the servings as they were typed', async () => {
    const onSubmit = open();

    await userEvent.type(screen.getByLabelText(texts.customName), '  Soup from the canteen ');
    await fill({ calories: '900', protein: '30', fat: '20.4', carbs: '110' }, '2');
    await add();

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Soup from the canteen',
      mealType: 'lunch',
      nutrition: { calories: 900, protein: 30, fat: 20.4, carbs: 110 },
      servings: 2,
    });
  });

  it("comes beside the day's meals unless one is chosen to take its place, and says what either does to the day", async () => {
    const onSubmit = open();
    expect(screen.getByText(texts.customBesideNote)).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByLabelText(texts.customPlace),
      screen.getByRole('option', { name: spaced('Instead of: Dinner · Lentil soup') }),
    );
    expect(screen.getByText(texts.customInsteadNote)).toBeInTheDocument();
    expect(screen.queryByText(texts.customBesideNote)).toBeNull();

    await userEvent.type(screen.getByLabelText(texts.customName), 'Pizza out');
    await fill({ calories: '900', protein: '35', fat: '35', carbs: '110' });
    await add();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pizza out', replaces: MEALS[1]!.id }),
    );
  });

  it('sends nothing without a name, nor with a name of nothing but spaces', async () => {
    const onSubmit = open();
    await fill({ calories: '900', protein: '30', fat: '20', carbs: '110' });

    await add();
    await userEvent.type(screen.getByLabelText(texts.customName), '   ');
    await add();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('takes a meal by its calories alone, says that the rest is estimated, and sends only what was typed', async () => {
    const onSubmit = open();
    await userEvent.type(screen.getByLabelText(texts.customName), 'Soup');

    await fill({ calories: '450', protein: '30', fat: '', carbs: '' }, '2');
    expect(
      screen.getByText(
        "The meal adds to the day: 900 kcal. The macronutrients left out are estimated from the day's target.",
      ),
    ).toBeInTheDocument();
    await add();

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Soup',
      mealType: 'lunch',
      nutrition: { calories: 450, protein: 30 },
      servings: 2,
    });
  });

  it('sends nothing without its calories or with more than a serving can hold, and shows no sum for it', async () => {
    const onSubmit = open();
    await userEvent.type(screen.getByLabelText(texts.customName), 'Soup');

    await fill({ calories: '', protein: '30', fat: '20', carbs: '110' });
    await add();
    expect(screen.getByText(texts.customTotalPending)).toBeInTheDocument();

    // A slip of the keyboard: nine thousand in one serving.
    await userEvent.type(screen.getByLabelText(texts.customCalories), '9000');
    await add();

    expect(screen.getByLabelText(texts.customCalories)).toBeInvalid();
    expect(screen.getByText(texts.customTotalPending)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('a meal of the window chosen as the diary chooses an entry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The API answers a search of recipes with one: 300 kcal a serving. */
  const recipeFound = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/recipes?search='))
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: '33333333-3333-4333-8333-333333333333',
                  title: 'Omelette',
                  nutritionPerServing: { calories: 300, protein: 20, fat: 22, carbs: 4 },
                },
              ],
              page: 1,
              pageSize: 8,
              total: 1,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        return new Response('{}', { status: 404 });
      }),
    );

  it('offers a product only where the instance has products, figures typed first', () => {
    render(
      <Wrapped products>
        <CustomMealModal date="2026-01-05" meals={MEALS} onClose={() => {}} onSubmit={vi.fn()} />
      </Wrapped>,
    );
    expect(
      screen.getAllByRole('radio').map((radio) => radio.closest('label')!.textContent),
    ).toEqual([
      texts.customKindTyped,
      messages.diary.kindProduct,
      messages.diary.kindRecipe,
      messages.diary.kindIngredient,
    ]);
    expect(screen.getByRole('radio', { name: texts.customKindTyped })).toBeChecked();
  });

  it('sends a recipe found and picked, in its servings, in the place of a meal of the day', async () => {
    recipeFound();
    const onSubmit = open();

    await userEvent.click(screen.getByRole('radio', { name: messages.diary.kindRecipe }));
    await userEvent.type(
      screen.getByRole('searchbox', { name: new RegExp(`^${messages.diary.searchRecipe}`) }),
      'ome',
    );
    await userEvent.click(await screen.findByRole('button', { name: /Omelette/ }));
    const servings = screen.getByRole('spinbutton', { name: texts.customServings });
    await userEvent.clear(servings);
    await userEvent.type(servings, '2');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: texts.customPlace }),
      MEALS[0]!.id,
    );
    expect(
      screen.getByText(
        spaced('The meal adds to the day: 600 kcal · protein 40 g · fat 44 g · carbs 8 g.'),
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.customSubmit }));

    expect(onSubmit).toHaveBeenCalledWith({
      mealType: 'lunch',
      of: { kind: 'recipe', recipeId: '33333333-3333-4333-8333-333333333333', servings: 2 },
      replaces: MEALS[0]!.id,
      servings: 1,
    });
  });

  it('sums an ingredient given in pieces as the API converts it, and says what the sum waits for until then', async () => {
    const egg = {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Egg',
      canonicalUnit: 'g',
      caloriesPer100: 143,
      proteinPer100: 12.6,
      fatPer100: 9.9,
      carbsPer100: 0.7,
      gramsPerPiece: 50,
      density: null,
      displayUnit: 'piece',
      recipeUnits: ['g', 'piece'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/ingredients?search=')
          ? new Response(JSON.stringify([egg]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: 404 }),
      ),
    );
    const onSubmit = open();

    await userEvent.click(screen.getByRole('radio', { name: messages.diary.kindIngredient }));
    expect(screen.getByText(texts.customTotalPendingChosen)).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('searchbox', { name: new RegExp(`^${messages.diary.searchIngredient}`) }),
      'egg',
    );
    await userEvent.click(await screen.findByRole('button', { name: /Egg/ }));
    expect(screen.getByText(texts.customTotalPendingChosen)).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: messages.diary.unit }),
      'piece',
    );
    await userEvent.type(screen.getByRole('spinbutton', { name: messages.diary.quantity }), '2');

    // Two eggs of 50 g: 100 g of what the figures are given per 100 g of.
    expect(
      screen.getByText(
        spaced('The meal adds to the day: 143 kcal · protein 13 g · fat 10 g · carbs 1 g.'),
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.customSubmit }));
    expect(onSubmit).toHaveBeenCalledWith({
      mealType: 'lunch',
      of: { kind: 'ingredient', ingredientId: egg.id, amount: { quantity: 2, unit: 'piece' } },
      servings: 1,
    });
  });

  it('sends nothing before a recipe is picked, and says so', async () => {
    const onSubmit = open();

    await userEvent.click(screen.getByRole('radio', { name: messages.diary.kindRecipe }));

    expect(screen.getByText(messages.diary.pickRecipeFirst)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: texts.customSubmit })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
