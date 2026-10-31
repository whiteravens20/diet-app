// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaySettingsPreview, MealPlanDay } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { DaySettingsDialog } from './day-settings-dialog';

const texts = messages.mealPlans.daySettings;
const PLAN = '11111111-1111-4111-8111-111111111111';
const PATH = `/meal-plans/${PLAN}/days/22222222-2222-4222-8222-222222222222/settings`;
const MEAL_IDS = [
  '33333333-3333-4333-8333-333333333331',
  '33333333-3333-4333-8333-333333333332',
  '33333333-3333-4333-8333-333333333333',
];

/** A day of three meals with no settings of its own. */
const DAY: MealPlanDay = {
  id: '22222222-2222-4222-8222-222222222222',
  date: '2026-01-06',
  meals: [],
  dayNutrition: { calories: 2000, protein: 120, fat: 60, carbs: 240 },
  diary: null,
  calorieTarget: 2000,
  targetMacros: { protein: 125, fat: 67, carbs: 225 },
  calorieDelta: 0,
  offTarget: null,
  skipped: false,
  belowSafetyFloor: false,
  overrides: null,
  mealCount: 3,
};
/** The settings the day has, as the window sends them. */
const AS_IT_IS = {
  dayType: 'normal',
  skip: false,
  mealCount: 3,
  calorieTarget: null,
  cookTimeBudgetMinutes: null,
  useUpBy: false,
};

const aPreview = (over: Partial<DaySettingsPreview> = {}): DaySettingsPreview => ({
  revision: 7,
  date: DAY.date,
  calorieTarget: { now: 2000, then: 2300 },
  targetMacros: {
    now: { protein: 125, fat: 67, carbs: 225 },
    then: { protein: 144, fat: 77, carbs: 259 },
  },
  belowSafetyFloor: false,
  meals: [
    { mealId: MEAL_IDS[0]!, mealType: 'breakfast', fate: 'resized', because: null },
    { mealId: MEAL_IDS[1]!, mealType: 'lunch', fate: 'resized', because: null },
    { mealId: MEAL_IDS[2]!, mealType: 'dinner', fate: 'resized', because: null },
  ],
  added: [],
  dayCalories: 2310,
  fits: true,
  listOutOfDate: false,
  unchanged: false,
  ...over,
});

/** The window, open on the day, with the API answering every preview with `preview`. */
async function opened(preview: (asked: Record<string, unknown>) => DaySettingsPreview) {
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation((_path: string, body?: unknown) =>
      Promise.resolve(preview(body as Record<string, unknown>) as never),
    );
  const put = vi.spyOn(api, 'put').mockResolvedValue({} as never);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DaySettingsDialog
          planId={PLAN}
          day={DAY}
          mealName={(type) => type}
          limitNames={(kinds) => kinds.join(', ')}
          onClose={onClose}
          onSaved={onSaved}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  const dialog = within(await screen.findByRole('dialog', { name: texts.title }));
  return { dialog, post, put, onClose, onSaved };
}
const save = (dialog: Awaited<ReturnType<typeof opened>>['dialog']) =>
  dialog.getByRole('button', { name: texts.save });
/** A field is named by its label and the hint under it: it is found by the label it begins with. */
const kindField = (dialog: Awaited<ReturnType<typeof opened>>['dialog']) =>
  dialog.getByRole('combobox', { name: new RegExp(`^${texts.kind}`) });

describe('the window in which the settings of a day are changed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks what the settings on the screen would do, and says it before anything is saved', async () => {
    const { dialog, post } = await opened((asked) =>
      asked.dayType === 'training'
        ? aPreview({ listOutOfDate: true })
        : aPreview({ unchanged: true, calorieTarget: { now: 2000, then: 2000 } }),
    );

    await userEvent.selectOptions(kindField(dialog), texts.kinds.training);

    await vi.waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(`${PATH}/preview`, {
        ...AS_IT_IS,
        dayType: 'training',
      }),
    );
    expect(await dialog.findByText("The day's target: 2000 → 2300 kcal.")).toBeInTheDocument();
    expect(
      dialog.getByText('It aims at protein 144 g, fat 77 g, carbohydrate 259 g.'),
    ).toBeInTheDocument();
    expect(dialog.getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      'breakfast: the same dish in a new portion',
      'lunch: the same dish in a new portion',
      'dinner: the same dish in a new portion',
    ]);
    expect(dialog.getByText('The day will hold about 2310 kcal.')).toBeInTheDocument();
    expect(dialog.getByText(texts.listOutOfDate)).toBeInTheDocument();
    expect(dialog.getByText(texts.otherDays)).toBeInTheDocument();
    expect(save(dialog)).toBeEnabled();
  });

  it('keeps saving off while nothing would change', async () => {
    const { dialog } = await opened(() =>
      aPreview({ unchanged: true, calorieTarget: { now: 2000, then: 2000 } }),
    );

    expect(await dialog.findByText(texts.unchanged)).toBeInTheDocument();
    expect(save(dialog)).toBeDisabled();
  });

  it('says which meals go, which get another recipe and which the day gains', async () => {
    const { dialog } = await opened(() =>
      aPreview({
        calorieTarget: { now: 2000, then: 2000 },
        meals: [
          { mealId: MEAL_IDS[0]!, mealType: 'breakfast', fate: 'stays', because: 'eaten' },
          { mealId: MEAL_IDS[1]!, mealType: 'lunch', fate: 'redrawn', because: 'over_cook_time' },
          { mealId: MEAL_IDS[2]!, mealType: 'dinner', fate: 'resized', because: null },
        ],
        added: ['snack'],
        dayCalories: null,
        fits: null,
      }),
    );

    expect(await dialog.findByText("The day's target stays at 2000 kcal.")).toBeInTheDocument();
    expect(dialog.getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      'breakfast: stays: it was eaten',
      'lunch: a new recipe: this one takes longer than the limit',
      'dinner: the same dish in a new portion',
      'Added: snack.',
    ]);
    expect(dialog.getByText(texts.drawnNote)).toBeInTheDocument();
  });

  it('saves the settings on the plan as the preview had it, and tells the page', async () => {
    const { dialog, put, onSaved, onClose } = await opened(() => aPreview());
    await userEvent.selectOptions(kindField(dialog), texts.kinds.training);
    await vi.waitFor(() => expect(save(dialog)).toBeEnabled());

    await userEvent.click(save(dialog));

    await vi.waitFor(() =>
      expect(put).toHaveBeenCalledWith(PATH, { ...AS_IT_IS, dayType: 'training', revision: 7 }),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('lets the limits that stand in the way give way when the reader says so', async () => {
    const { dialog, put } = await opened(() => aPreview());
    put.mockRejectedValueOnce(
      new ApiClientError(
        422,
        'PLAN_NEEDS_RELAXATION',
        'The plan cannot be filled inside its limits.',
        undefined,
        undefined,
        {
          needs: ['cook_time'],
          meals: [{ date: DAY.date, slot: 'lunch', gaveWay: ['cook_time'] }],
        },
      ),
    );
    await userEvent.selectOptions(kindField(dialog), texts.kinds.training);
    await vi.waitFor(() => expect(save(dialog)).toBeEnabled());

    await userEvent.click(save(dialog));
    expect(
      await dialog.findByText(
        'This plan cannot be filled inside its limits. One meal would go outside: cook_time.',
      ),
    ).toBeInTheDocument();
    expect(dialog.getByText('lunch: cook_time')).toBeInTheDocument();
    await userEvent.click(
      dialog.getByRole('button', { name: 'Make the plan and let this limit give way' }),
    );

    await vi.waitFor(() =>
      expect(put).toHaveBeenLastCalledWith(PATH, {
        ...AS_IT_IS,
        dayType: 'training',
        revision: 7,
        allowRelaxations: ['cook_time'],
      }),
    );
  });

  it('leaves out what a skipped day has no use for, and says what it keeps', async () => {
    const { dialog, post } = await opened((asked) =>
      asked.skip
        ? aPreview({
            calorieTarget: { now: 2000, then: 2000 },
            meals: [
              { mealId: MEAL_IDS[0]!, mealType: 'breakfast', fate: 'stays', because: 'eaten' },
              { mealId: MEAL_IDS[1]!, mealType: 'lunch', fate: 'removed', because: 'skipped' },
              { mealId: MEAL_IDS[2]!, mealType: 'dinner', fate: 'removed', because: 'skipped' },
            ],
            dayCalories: 450,
            fits: null,
          })
        : aPreview({ unchanged: true }),
    );
    const cookTime = { name: (name: string) => name.startsWith(texts.cookTime) };
    expect(dialog.getByRole('spinbutton', cookTime)).toBeInTheDocument();

    await userEvent.selectOptions(kindField(dialog), texts.kinds.skip);

    await vi.waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(`${PATH}/preview`, { ...AS_IT_IS, skip: true }),
    );
    expect(await dialog.findByText(texts.skipNote)).toBeInTheDocument();
    expect(dialog.queryByRole('combobox', { name: new RegExp(`^${texts.mealCount}`) })).toBeNull();
    expect(dialog.queryByRole('spinbutton', cookTime)).toBeNull();
    expect(dialog.getAllByRole('combobox')).toHaveLength(1);
    expect(dialog.getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      'breakfast: stays: it was eaten',
      'lunch: goes: the day is skipped',
      'dinner: goes: the day is skipped',
    ]);
  });
});
