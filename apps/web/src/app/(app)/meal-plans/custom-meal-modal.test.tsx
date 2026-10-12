// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { CustomMealModal } from './custom-meal-modal';

const texts = messages.mealPlans;

function open() {
  const onSubmit = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CustomMealModal date="2026-01-05" onClose={() => {}} onSubmit={onSubmit} />
    </NextIntlClientProvider>,
  );
  return onSubmit;
}

/** Type the numbers of one serving, a field with nothing to type being left empty, and how many servings the meal is. */
async function fill(serving: { calories: string; protein: string; fat: string; carbs: string }, servings?: string) {
  const fields = [
    [texts.customCalories, serving.calories],
    [texts.customProtein, serving.protein],
    [texts.customFat, serving.fat],
    [texts.customCarbs, serving.carbs],
  ] as const;
  for (const [label, typed] of fields) if (typed) await userEvent.type(screen.getByLabelText(label), typed);
  if (servings !== undefined) {
    const field = screen.getByRole('spinbutton', { name: new RegExp(`^${texts.customServings}`) });
    await userEvent.clear(field);
    await userEvent.type(field, servings);
  }
}

const add = () => userEvent.click(screen.getByRole('button', { name: texts.customSubmit }));

describe('the window a meal of the user\'s own is added in', () => {
  it('says that the numbers are those of one serving, and what the meal adds to the day for the servings typed', async () => {
    open();

    expect(screen.getByRole('group', { name: texts.customPerServing })).toBeInTheDocument();
    expect(screen.getByText(texts.customTotalPending)).toBeInTheDocument();

    await fill({ calories: '900', protein: '30', fat: '20.4', carbs: '110' }, '2');

    // Two servings of 900 kcal are 1,800 on the day, rounded as the API rounds them.
    expect(screen.getByText('The meal adds to the day: 1,800 kcal · protein 60 g · fat 41 g · carbs 220 g.')).toBeInTheDocument();
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

  it('sends nothing without a name, nor with a name of nothing but spaces', async () => {
    const onSubmit = open();
    await fill({ calories: '900', protein: '30', fat: '20', carbs: '110' });

    await add();
    await userEvent.type(screen.getByLabelText(texts.customName), '   ');
    await add();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends nothing while a number is missing or is more than a serving can hold, and shows no sum for it', async () => {
    const onSubmit = open();
    await userEvent.type(screen.getByLabelText(texts.customName), 'Soup');

    await fill({ calories: '900', protein: '30', fat: '20', carbs: '' });
    await add();
    expect(screen.getByText(texts.customTotalPending)).toBeInTheDocument();

    // A slip of the keyboard: nine thousand in one serving.
    await userEvent.type(screen.getByLabelText(texts.customCarbs), '110');
    await userEvent.clear(screen.getByLabelText(texts.customCalories));
    await userEvent.type(screen.getByLabelText(texts.customCalories), '9000');
    await add();

    expect(screen.getByLabelText(texts.customCalories)).toBeInvalid();
    expect(screen.getByText(texts.customTotalPending)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
