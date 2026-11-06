// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaySettingsPreview, MealPlanDay, PlanWeek } from '@diet-app/shared';
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
  dayLabel: { fiber: null, sugars: null, salt: null, saturatedFat: null },
  labelNotes: [],
  diary: null,
  calorieTarget: 2000,
  targetMacros: { protein: 125, fat: 67, carbs: 225 },
  calorieDelta: 0,
  offTarget: null,
  macrosOff: false,
  skipped: false,
  belowSafetyFloor: false,
  overrides: null,
  mealCount: 3,
  listed: false,
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
  cooking: null,
  unchanged: false,
  week: null,
  ...over,
});

/** The week of the day, as a training day changed alone leaves it: off the plan's target, which evening it out brings back. */
const UNEVEN: NonNullable<DaySettingsPreview['week']> = {
  target: 2000,
  average: { now: 2000, alone: 2043, evened: 2001 },
  pace: { now: 0.5, alone: 0.46, evened: 0.5 },
  unevenAlone: true,
  evenedTarget: 2240,
  otherDays: 4,
  listOutOfDate: false,
};

/** The window, open on the day of a week as the plan says it stands, with the API answering every preview with `preview`. */
async function opened(
  preview: (asked: Record<string, unknown>) => DaySettingsPreview,
  week?: PlanWeek,
) {
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation((_path: string, body?: unknown) =>
      Promise.resolve(preview(body as Record<string, unknown>) as never),
    );
  const put = vi.spyOn(api, 'put').mockResolvedValue({} as never);
  // An account that weighs in kilograms: the pace of a week is said in them.
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve((path === '/users/me' ? { weightUnit: 'kg' } : {}) as never),
  );
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
          week={week}
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

  it("says how the change moves the week's average and its pace, and offers to even the week out with it", async () => {
    const { dialog, put } = await opened(() => aPreview({ week: UNEVEN }));
    await userEvent.selectOptions(kindField(dialog), texts.kinds.training);

    expect(
      await dialog.findByText(
        /^The week's average daily target: 2000 → 2043 kcal, at a plan target of 2000 kcal\. At this average target, weight falls by about 0\.46 kg a week\.$/,
      ),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(/gives this day 2240 kcal and changes the targets of 4 other days/),
    ).toBeInTheDocument();
    expect(dialog.queryByText(texts.otherDays)).not.toBeInTheDocument();
    const alone = await dialog.findByRole('button', { name: texts.saveDay });
    await vi.waitFor(() => expect(alone).toBeEnabled());

    await userEvent.click(dialog.getByRole('button', { name: texts.saveAndEven }));

    await vi.waitFor(() =>
      expect(put).toHaveBeenCalledWith(PATH, {
        ...AS_IT_IS,
        dayType: 'training',
        revision: 7,
        evenWeek: true,
      }),
    );
  });

  it('says before the week is evened out that the shopping list of its days goes out of date', async () => {
    const { dialog } = await opened(() => aPreview({ week: { ...UNEVEN, listOutOfDate: true } }));
    await userEvent.selectOptions(kindField(dialog), texts.kinds.training);

    expect(await dialog.findByText(messages.mealPlans.listOutOfDateDays)).toBeInTheDocument();
  });

  it('saves the day alone with the other button, and has one button where the week stays even', async () => {
    const first = await opened(() => aPreview({ week: UNEVEN }));
    await userEvent.selectOptions(kindField(first.dialog), texts.kinds.training);
    const alone = await first.dialog.findByRole('button', { name: texts.saveDay });
    await vi.waitFor(() => expect(alone).toBeEnabled());

    await userEvent.click(alone);

    await vi.waitFor(() =>
      expect(first.put).toHaveBeenCalledWith(PATH, {
        ...AS_IT_IS,
        dayType: 'training',
        revision: 7,
      }),
    );
  });

  it('evens out a week that stands off its target while nothing of the day changes', async () => {
    const week: PlanWeek = {
      from: '2026-01-05',
      to: '2026-01-11',
      target: 2000,
      average: 2043,
      uneven: true,
      listOutOfDate: false,
    };
    const { dialog, post, onSaved } = await opened(() => aPreview({ unchanged: true }), week);

    expect(
      await dialog.findByText(
        /^This week's average daily target is 2043 kcal, at a plan target of 2000 kcal\./,
      ),
    ).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.evenWeek }));

    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/meal-plans/${PLAN}/weeks/even`, {
        date: DAY.date,
        revision: 7,
      }),
    );
    expect(onSaved).toHaveBeenCalled();
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
