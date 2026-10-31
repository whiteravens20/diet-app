// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { aPreview } from '@/testing/calories';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import { FirstProfile } from './first-profile';

const texts = messages.profile;
const steps = texts.wizard.steps;

/** The steps of a first profile, for an account that weighs in `unit`. `made` is what the API answers when the profile is made. */
function open(over: { unit?: 'kg' | 'lb'; made?: () => Promise<unknown> } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve((path === '/users/me' ? { weightUnit: over.unit ?? 'kg' } : []) as never),
  );
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation(
      (path: string, body?: unknown) =>
        (path === '/profiles/calories'
          ? Promise.resolve(aPreview())
          : (over.made?.() ?? Promise.resolve({ id: 'made', ...(body as object) }))) as never,
    );
  const onMade = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig());
  client.setQueryData(['session'], { weightUnit: over.unit ?? 'kg' });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <FirstProfile onMade={onMade} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return {
    onMade,
    /** What the profile was made with, once it was. */
    sent: () =>
      post.mock.calls.find(([path]) => path === '/profiles')?.[1] as
        Record<string, unknown> | undefined,
    /** The figures the last preview was asked with. */
    asked: () =>
      post.mock.calls.filter(([path]) => path === '/profiles/calories').at(-1)?.[1] as
        Record<string, unknown> | undefined,
  };
}

const heading = (step: 1 | 2 | 3, name: string) =>
  screen.getByRole('heading', { name: `Step ${step} of 3: ${name}` });
const next = () => userEvent.click(screen.getByRole('button', { name: messages.common.next }));
const back = () => userEvent.click(screen.getByRole('button', { name: messages.common.back }));

/** Type the body of the first step: a name, an age, a height and a weight in the unit of the account. */
async function aBody(
  of: { name?: string; age?: string; height?: string; weight?: string; unit?: 'kg' | 'lb' } = {},
) {
  await userEvent.type(screen.getByLabelText(new RegExp(`^${texts.name}`)), of.name ?? 'Anna');
  await userEvent.type(screen.getByLabelText(texts.age), of.age ?? '30');
  await userEvent.type(screen.getByLabelText(texts.heightCm), of.height ?? '180');
  await userEvent.type(screen.getByLabelText(`Weight (${of.unit ?? 'kg'})`), of.weight ?? '80');
}

describe('the steps a first profile is set up in', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('show one step at a time, and name all three with the one the reader is on', () => {
    open();

    expect(heading(1, steps.body)).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('listitem')
        .map((step) => [step.textContent, step.getAttribute('aria-current')]),
    ).toEqual([
      [`1${steps.body}`, 'step'],
      [`2${steps.goal}`, null],
      [`3${steps.food}`, null],
    ]);
    expect(screen.getByLabelText(texts.age)).toBeInTheDocument();
    // What the later steps ask is not there to be read or filled yet.
    expect(screen.queryByRole('group', { name: texts.pace })).toBeNull();
    expect(screen.queryByRole('combobox', { name: texts.dietType })).toBeNull();
    // A form that begins with nobody's figures begins empty.
    expect(screen.getByLabelText(texts.age)).toHaveValue(null);
    expect(screen.getByLabelText(texts.heightCm)).toHaveValue(null);
  });

  it('go on only from a step whose fields are filled, and put the reader at the head of the next', async () => {
    open();

    await next();
    expect(heading(1, steps.body)).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(`^${texts.name}`))).toBeInvalid();

    await aBody();
    await next();

    expect(heading(2, steps.goal)).toHaveFocus();
    expect(screen.getByRole('group', { name: texts.pace })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: texts.age })).toBeNull();
  });

  it('go on when Enter is pressed in a field', async () => {
    open();
    await aBody();

    await userEvent.type(screen.getByLabelText('Weight (kg)'), '{Enter}');

    expect(heading(2, steps.goal)).toBeInTheDocument();
  });

  it('go back to a step with everything as it was left', async () => {
    open();
    await aBody({ name: 'Anna', age: '41' });
    await userEvent.selectOptions(
      screen.getByLabelText(new RegExp(`^${texts.activityLevel}`)),
      'active',
    );
    await next();
    await userEvent.click(screen.getByRole('radio', { name: /Lose 0.25 kg a week/ }));
    await next();
    expect(heading(3, steps.food)).toBeInTheDocument();

    await back();
    expect(screen.getByRole('radio', { name: /Lose 0.25 kg a week/ })).toBeChecked();
    await back();

    expect(heading(1, steps.body)).toHaveFocus();
    expect(screen.getByLabelText(texts.age)).toHaveValue(41);
    expect(screen.getByLabelText(new RegExp(`^${texts.activityLevel}`))).toHaveValue('active');
  });

  it('say what a level of activity means under the list it is chosen from', async () => {
    open();
    expect(screen.getByText(texts.activityHint.moderate)).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByLabelText(new RegExp(`^${texts.activityLevel}`)),
      'sedentary',
    );

    expect(screen.getByText(texts.activityHint.sedentary)).toBeInTheDocument();
    expect(screen.queryByText(texts.activityHint.moderate)).toBeNull();
  });
});

describe('the figures beside the steps of a first profile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('say what to type until there is a body to work them out from, and then what it comes to', async () => {
    const { asked } = open();
    expect(screen.getByText(messages.caloriePreview.pending)).toBeInTheDocument();

    await aBody();

    expect(await screen.findByText('2209 kcal')).toBeInTheDocument();
    expect(asked()).toEqual({
      age: 30,
      sex: null,
      heightCm: 180,
      weightKg: 80,
      activityLevel: 'moderate',
      dietType: 'balanced',
      customMacroSplit: null,
      weeklyLossTarget: '0.5',
      manualCalorieTarget: null,
      acknowledgeRisk: false,
    });
  });

  it('stand beside every pace on the step that asks for one, with a word for a pace that a limit slowed', async () => {
    open();
    await aBody();
    await next();
    await screen.findByText('2209 kcal');

    const paces = within(screen.getByRole('group', { name: texts.pace })).getAllByRole('radio');

    expect(paces.map((pace) => pace.closest('label')!.textContent)).toEqual([
      'Keep my weight2759 kcal a day',
      'Lose 0.25 kg a week2484 kcal a day',
      'Lose 0.5 kg a week2209 kcal a day',
      'Lose 0.75 kg a week2069 kcal a day · slowed',
      'Lose 1 kg a week2069 kcal a day · slowed',
    ]);
    // Half a kilogram a week is where a new profile begins.
    expect(paces.map((pace) => (pace as HTMLInputElement).checked)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(screen.getByText(texts.paceSlowedNote)).toBeInTheDocument();
  });

  it('name the paces in pounds for an account that weighs in them, and are asked for in kilograms', async () => {
    const { asked } = open({ unit: 'lb' });
    await aBody({ weight: '176.4', unit: 'lb' });
    await next();
    await screen.findByText('2209 kcal');

    expect(screen.getByRole('radio', { name: /Lose 1.1 lb a week/ })).toBeInTheDocument();
    expect(asked()).toMatchObject({ weightKg: 80.01 });
  });

  it('follow the diet to the custom one with the split it begins with, the moment it is chosen', async () => {
    const { asked } = open();
    await aBody();
    await next();
    await next();

    await userEvent.selectOptions(screen.getByLabelText(texts.dietType), 'custom');

    // The fields of the split are drawn by the same change that the figures are read on: nothing more has to be typed.
    await vi.waitFor(() =>
      expect(asked()).toMatchObject({
        dietType: 'custom',
        customMacroSplit: { protein: 25, fat: 30, carbs: 45 },
      }),
    );
    expect(await screen.findByText('2209 kcal')).toBeInTheDocument();
  });

  it('follow the pace that is chosen', async () => {
    const { asked } = open();
    await aBody();
    await next();
    await screen.findByText('2209 kcal');

    await userEvent.click(screen.getByRole('radio', { name: /Keep my weight/ }));

    await vi.waitFor(() => expect(asked()).toMatchObject({ weeklyLossTarget: null }));
  });
});

describe('the profile the steps make', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds everything the three steps asked for, and is handed on once the API has it', async () => {
    const { sent, onMade } = open();
    await aBody({ name: ' Anna ', age: '41', height: '168', weight: '70.5' });
    await userEvent.selectOptions(screen.getByLabelText(new RegExp(`^${texts.sex}`)), 'female');
    await userEvent.selectOptions(
      screen.getByLabelText(new RegExp(`^${texts.activityLevel}`)),
      'light',
    );
    await next();
    await userEvent.click(screen.getByRole('radio', { name: /Lose 0.25 kg a week/ }));
    await userEvent.type(
      screen.getByRole('spinbutton', { name: /^Weight to work towards \(kg\)/ }),
      '64',
    );
    await next();
    await userEvent.selectOptions(screen.getByLabelText(texts.dietType), 'vegetarian');
    await userEvent.clear(screen.getByLabelText(texts.mealsPerDay));
    await userEvent.type(screen.getByLabelText(texts.mealsPerDay), '4');
    await userEvent.click(
      screen.getByRole('button', { name: messages.pickers.allergensPlaceholder }),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: messages.enums.allergen.peanuts }));

    await userEvent.click(screen.getByRole('button', { name: texts.createProfile }));

    expect(sent()).toEqual({
      name: 'Anna',
      age: 41,
      sex: 'female',
      heightCm: 168,
      weightKg: 70.5,
      targetWeightKg: 64,
      activityLevel: 'light',
      dietType: 'vegetarian',
      customMacroSplit: null,
      weeklyLossTarget: '0.25',
      manualCalorieTarget: null,
      mealCount: 4,
      weightReminderCadence: 'weekly',
      preferences: { allergens: ['peanuts'] },
    });
    await vi.waitFor(() =>
      expect(onMade).toHaveBeenCalledWith(expect.objectContaining({ id: 'made', name: 'Anna' })),
    );
  });

  it('is not made by the second half of a double click that brought the reader to the last step', async () => {
    const { sent } = open();
    await aBody();
    await next();

    await userEvent.dblClick(screen.getByRole('button', { name: messages.common.next }));

    expect(heading(3, steps.food)).toBeInTheDocument();
    expect(sent()).toBeUndefined();
  });

  it('is not made with a split of the custom diet that does not add up', async () => {
    const { sent } = open();
    await aBody();
    await next();
    await next();
    await userEvent.selectOptions(screen.getByLabelText(texts.dietType), 'custom');
    await userEvent.clear(screen.getByLabelText(texts.split.protein));
    await userEvent.type(screen.getByLabelText(texts.split.protein), '30');

    await userEvent.click(screen.getByRole('button', { name: texts.createProfile }));

    expect(sent()).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent(texts.splitSumRefused);
  });

  it('says what the API refused, and stays where it was', async () => {
    open({ made: () => Promise.reject(new ApiClientError(409, 'PROFILE_LIMIT_REACHED', 'limit')) });
    await aBody();
    await next();
    await next();

    await userEvent.click(screen.getByRole('button', { name: texts.createProfile }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.errors.PROFILE_LIMIT_REACHED,
    );
    expect(heading(3, steps.food)).toBeInTheDocument();
  });
});

describe('somebody for whom losing weight is a risk, on the steps of a first profile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is told so where the pace is chosen, and the goal is sent as not acknowledged until the box is ticked', async () => {
    const { sent } = open();
    await aBody({ age: '16' });
    await next();

    expect(screen.getByText(texts.risk.minor)).toBeInTheDocument();
    expect(screen.getByText(texts.risk.held)).toBeInTheDocument();
    await next();
    await userEvent.click(screen.getByRole('button', { name: texts.createProfile }));

    expect(sent()).toMatchObject({ age: 16, weeklyLossTarget: '0.5', acknowledgeRisk: false });
  });

  it('sends the goal as acknowledged once the box is ticked, and sees what that comes to before the profile is made', async () => {
    const { sent, asked } = open();
    await aBody({ age: '16' });
    await next();

    await userEvent.click(screen.getByRole('checkbox', { name: texts.risk.acknowledge }));
    await vi.waitFor(() => expect(asked()).toMatchObject({ age: 16, acknowledgeRisk: true }));
    await next();
    await userEvent.click(screen.getByRole('button', { name: texts.createProfile }));

    expect(sent()).toMatchObject({ acknowledgeRisk: true });
  });

  it('is told nothing, and sends no word about a risk, when the goal is to keep the weight', async () => {
    const { sent } = open();
    await aBody({ age: '16' });
    await next();

    await userEvent.click(screen.getByRole('radio', { name: /Keep my weight/ }));
    expect(screen.queryByText(texts.risk.minor)).toBeNull();
    await next();
    await userEvent.click(screen.getByRole('button', { name: texts.createProfile }));

    expect(sent()).not.toHaveProperty('acknowledgeRisk');
    expect(sent()).toMatchObject({ weeklyLossTarget: null });
  });
});
