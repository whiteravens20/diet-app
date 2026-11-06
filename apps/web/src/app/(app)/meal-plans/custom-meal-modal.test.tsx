// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { CustomMealModal } from './custom-meal-modal';
import { spaced } from '@/testing/spaces';

const texts = messages.mealPlans;

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
    <NextIntlClientProvider locale="en" messages={messages}>
      <CustomMealModal date="2026-01-05" meals={MEALS} onClose={() => {}} onSubmit={onSubmit} />
    </NextIntlClientProvider>,
  );
  return onSubmit;
}

describe('the shopping list of the day', () => {
  it('is said to go out of date where one covers the day, and nothing is said where none does', () => {
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CustomMealModal
          date="2026-01-05"
          meals={MEALS}
          listed
          onClose={() => {}}
          onSubmit={vi.fn()}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(messages.mealPlans.listOutOfDateDay)).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CustomMealModal date="2026-01-05" meals={MEALS} onClose={() => {}} onSubmit={vi.fn()} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(messages.mealPlans.listOutOfDateDay)).not.toBeInTheDocument();
  });
});

describe('the note on the meal it replaces', () => {
  it('says what follows for the other meal of a cooking when one is chosen', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
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
      </NextIntlClientProvider>,
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
