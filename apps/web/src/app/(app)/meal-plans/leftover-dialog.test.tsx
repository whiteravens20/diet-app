// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeftoverOffer, MealPlan, PlannedMeal } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { spaced } from '@/testing/spaces';
import messages from '../../../../messages/en.json';
import pl from '../../../../messages/pl.json';
import { LeftoverDialog, LeftoverUndoDialog } from './leftover-dialog';

const texts = messages.mealPlans.leftover;
const PLAN = '11111111-1111-4111-8111-111111111111';
const NEXT_PLAN = '11111111-1111-4111-8111-111111111112';
const MEAL = '33333333-3333-4333-8333-333333333331';
const PATH = `/meal-plans/${PLAN}/meals/${MEAL}/leftover`;

/** Tuesday's dinner, not marked eaten unless `over` says otherwise. */
const aMeal = (over: Partial<PlannedMeal> = {}): PlannedMeal =>
  ({
    id: MEAL,
    mealType: 'dinner',
    recipe: { id: '44444444-4444-4444-8444-444444444444', title: 'Lentil stew' },
    customName: null,
    servings: 1,
    quantityScale: 1,
    eatenAt: null,
    shared: null,
    leftover: null,
    carriedTo: null,
    leftoverOffer: 'ok',
    ...over,
  }) as PlannedMeal;

/** A plan of Tuesday and Wednesday, Wednesday on no shopping list. */
const PLAN_OF_TWO = {
  id: PLAN,
  days: [
    { date: '2026-01-06', meals: [], listed: false },
    { date: '2026-01-07', meals: [], listed: false },
  ],
} as unknown as MealPlan;

const anOffer = (over: Partial<LeftoverOffer> = {}): LeftoverOffer => ({
  planId: PLAN,
  date: '2026-01-07',
  portion: { servings: 1, calories: 520 },
  places: [
    {
      mealType: 'breakfast',
      name: 'Porridge',
      calories: 400,
      sharedWith: null,
      cookAhead: null,
      cookedWith: [],
    },
    {
      mealType: 'lunch',
      name: 'Bean soup',
      calories: 600,
      sharedWith: null,
      cookAhead: null,
      cookedWith: [],
    },
  ],
  other: null,
  ...over,
});

/** The window open on `meal`, the API answering where it can go with `offer`, and taking it. */
async function opened(meal: PlannedMeal, offer: LeftoverOffer | Error) {
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(() =>
      offer instanceof Error ? Promise.reject(offer) : Promise.resolve(offer as never),
    );
  const post = vi.spyOn(api, 'post').mockResolvedValue({ plan: PLAN_OF_TWO, rebalance: null });
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <LeftoverDialog
          plan={PLAN_OF_TWO}
          meal={meal}
          date="2026-01-06"
          onClose={onClose}
          onDone={onDone}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  const dialog = within(await screen.findByRole('dialog', { name: texts.title }));
  // Once the API has said where it can go.
  if (!(offer instanceof Error)) await dialog.findByRole('group', { name: texts.eatenLegend });
  return { dialog, get, post, onDone, onClose };
}
type Opened = Awaited<ReturnType<typeof opened>>['dialog'];
const submit = (dialog: Opened) => dialog.getByRole('button', { name: texts.submit });
const place = (dialog: Opened, text: string) => dialog.getByRole('radio', { name: spaced(text) });

describe('the window that carries what is left of a meal to the next day', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-06T12:00:00') });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('carries the whole portion of a meal nothing was eaten of, to the meal chosen, and says where it went', async () => {
    const { dialog, get, post, onDone, onClose } = await opened(aMeal(), anOffer());

    expect(get).toHaveBeenCalledWith(PATH);
    expect(dialog.getByRole('radio', { name: texts.nothing })).toBeChecked();
    // Nothing is chosen for it: the time of day is always the user's choice.
    expect(submit(dialog)).toBeDisabled();
    await userEvent.click(place(dialog, 'Lunch: instead of “Bean soup”, 600 kcal'));

    expect(dialog.getByText(texts.summaryGone)).toBeInTheDocument();
    expect(
      dialog.getByText(
        spaced(
          'The leftover: 1 serving, 520 kcal. The other meals of that day not eaten fit its target.',
        ),
      ),
    ).toBeInTheDocument();
    await userEvent.click(submit(dialog));

    expect(post).toHaveBeenCalledWith(PATH, { mealType: 'lunch', left: 1 });
    expect(onDone).toHaveBeenCalledWith(
      { plan: PLAN_OF_TWO, rebalance: null },
      'The leftover is on Wednesday for lunch.',
      { planId: PLAN, date: '2026-01-07' },
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('carries the part left of a meal eaten in part, chosen or weighed, and says what stays eaten', async () => {
    const { dialog, post } = await opened(
      aMeal({ eatenAt: '2026-01-06T19:00:00.000Z' }),
      anOffer(),
    );

    // A meal marked eaten was eaten at least in part.
    expect(dialog.getByRole('radio', { name: texts.part })).toBeChecked();
    await userEvent.click(place(dialog, 'Breakfast: instead of “Porridge”, 400 kcal'));
    expect(submit(dialog)).toBeDisabled();
    await userEvent.click(dialog.getByRole('radio', { name: texts.half }));
    expect(
      dialog.getByText(
        spaced('This meal stays on its day as eaten, with the part eaten: 0.5 servings, 260 kcal.'),
      ),
    ).toBeInTheDocument();

    await userEvent.click(dialog.getByRole('radio', { name: texts.byWeight }));
    await userEvent.type(dialog.getByRole('textbox', { name: texts.wholeWeight }), '400');
    await userEvent.type(dialog.getByRole('textbox', { name: /^Left \(g\)/ }), '500');
    expect(dialog.getByText(texts.weightWrong)).toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
    await userEvent.clear(dialog.getByRole('textbox', { name: /^Left \(g\)/ }));
    await userEvent.type(dialog.getByRole('textbox', { name: /^Left \(g\)/ }), '100');
    expect(dialog.getByText(spaced('That is 25% of this portion, 130 kcal.'))).toBeInTheDocument();
    await userEvent.click(submit(dialog));

    expect(post).toHaveBeenCalledWith(PATH, { mealType: 'breakfast', left: 0.25 });
  });

  it("carries the other person's portion too, with their own part left, to a meal both have", async () => {
    const shared = aMeal({
      shared: { with: { profileName: 'Ewa', eaten: false } } as PlannedMeal['shared'],
    });
    const { dialog, post } = await opened(
      shared,
      anOffer({
        places: [
          ...anOffer().places,
          {
            mealType: 'dinner',
            name: 'Curry',
            calories: 650,
            sharedWith: 'Ewa',
            cookAhead: null,
            cookedWith: [],
          },
        ],
        other: {
          profileName: 'Ewa',
          eaten: false,
          portion: { servings: 0.8, calories: 416 },
          places: ['breakfast', 'dinner'],
        },
      }),
    );

    const forAll = dialog.getByRole('checkbox', { name: 'For both: you and Ewa' });
    expect(forAll).toBeChecked();
    // Only the meals both have the next day, and the shared one stays shared.
    expect(dialog.queryByRole('radio', { name: /^Lunch:/ })).toBeNull();
    expect(dialog.queryByText(/for the other person \(Ewa\)/)).toBeNull();
    await userEvent.click(place(dialog, 'Dinner: instead of “Curry”, 650 kcal'));
    const theirs = within(
      dialog.getByRole('group', { name: 'Ewa: was any of this portion eaten?' }),
    );
    await userEvent.click(theirs.getByRole('radio', { name: texts.part }));
    await userEvent.click(theirs.getByRole('radio', { name: texts.quarter }));
    await userEvent.click(submit(dialog));

    expect(post).toHaveBeenCalledWith(PATH, {
      mealType: 'dinner',
      left: 1,
      forAll: true,
      theirLeft: 0.25,
    });

    // For one alone, every meal of the next day, and the shared one says it stays the other's.
    await userEvent.click(forAll);
    expect(place(dialog, 'Lunch: instead of “Bean soup”, 600 kcal')).toBeInTheDocument();
    expect(
      dialog.getByText('This meal is shared: for the other person (Ewa) it stays as it is.'),
    ).toBeInTheDocument();
  });

  it('says how many servings in the form each language gives the number', () => {
    const say = (locale: 'en' | 'pl', servings: number) =>
      createTranslator({
        locale,
        messages: locale === 'en' ? messages : pl,
        namespace: 'mealPlans.leftover',
      })('summaryDay', { servings, kcal: 520 });
    expect(say('en', 1)).toMatch(spaced('The leftover: 1 serving, 520 kcal.', { start: true }));
    expect(say('en', 2)).toMatch(spaced('The leftover: 2 servings,', { start: true }));
    expect(say('en', 0.5)).toMatch(spaced('The leftover: 0.5 servings,', { start: true }));
    expect(say('pl', 1)).toMatch(spaced('Resztka: 1 porcja, 520 kcal.', { start: true }));
    expect(say('pl', 2)).toMatch(spaced('Resztka: 2 porcje,', { start: true }));
    expect(say('pl', 5)).toMatch(spaced('Resztka: 5 porcji,', { start: true }));
    expect(say('pl', 1.5)).toMatch(spaced('Resztka: 1,5 porcji,', { start: true }));
  });

  it('says that the leftover went to the next plan', async () => {
    const { dialog, onDone } = await opened(aMeal(), anOffer({ planId: NEXT_PLAN }));

    await userEvent.click(place(dialog, 'Lunch: instead of “Bean soup”, 600 kcal'));
    await userEvent.click(submit(dialog));

    expect(onDone).toHaveBeenCalledWith(
      expect.anything(),
      'The leftover is on Wednesday for lunch, in the next plan.',
      { planId: NEXT_PLAN, date: '2026-01-07' },
    );
  });

  it('says why the next day cannot take it, where the API refuses', async () => {
    const { dialog } = await opened(
      aMeal(),
      new ApiClientError(409, 'LEFTOVER_NO_DAY', 'No plan of the profile holds the next day.'),
    );

    expect(await dialog.findByRole('alert')).toHaveTextContent(messages.errors.LEFTOVER_NO_DAY);
    expect(submit(dialog)).toBeDisabled();
  });
});

describe('the window that carries a leftover back', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const undone = (meal: PlannedMeal) => {
    const remove = vi
      .spyOn(api, 'delete')
      .mockResolvedValue({ plan: PLAN_OF_TWO, rebalance: null });
    const onDone = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={new QueryClient()}>
          <LeftoverUndoDialog planId={PLAN} meal={meal} onClose={vi.fn()} onDone={onDone} />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    return {
      dialog: within(screen.getByRole('dialog', { name: texts.undoTitle })),
      remove,
      onDone,
    };
  };

  it('undoes it for this person', async () => {
    const { dialog, remove, onDone } = undone(
      aMeal({ leftover: { date: '2026-01-06', mealType: 'dinner', undoable: true } }),
    );

    expect(dialog.getByText(texts.undoNote)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.undo }));

    expect(remove).toHaveBeenCalledWith(PATH);
    expect(onDone).toHaveBeenCalled();
  });

  it('undoes one made for both for both, or for this person alone', async () => {
    const { dialog, remove } = undone(
      aMeal({
        leftover: { date: '2026-01-06', mealType: 'dinner', undoable: true },
        shared: { with: { profileName: 'Ewa', eaten: false } } as PlannedMeal['shared'],
      }),
    );

    expect(dialog.getByRole('button', { name: texts.undoForMe })).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.undoForAll }));

    expect(remove).toHaveBeenCalledWith(`${PATH}?forAll=true`);
  });
});
