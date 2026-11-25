// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealPlanDay, RebalanceResult } from '@diet-app/shared';
import messages from '../../../../messages/en.json';
import { RebalanceToast, type PlanWord } from './rebalance-toast';

const texts = messages.mealPlans;
type Rebalance = NonNullable<RebalanceResult['rebalance']>;

const aRebalance = (over: Partial<Rebalance> = {}): Rebalance => ({
  scope: 'day',
  feasibility: 'in-window',
  changes: [{ mealId: '11111111-1111-4111-8111-111111111111', before: 1, after: 0.8 }],
  unabsorbedKcal: 0,
  macrosBefore: { calories: 2400, protein: 120, fat: 80, carbs: 280 },
  macrosAfter: { calories: 2100, protein: 105, fat: 70, carbs: 245 },
  ...over,
});

const aDay = (over: Partial<MealPlanDay> = {}) =>
  ({
    date: '2026-01-05',
    calorieTarget: 2100,
    offTarget: null,
    dayNutrition: { calories: 2120, protein: 95, fat: 70, carbs: 245 },
    targetMacros: { protein: 130, fat: 70, carbs: 236 },
    ...over,
  }) as MealPlanDay;

const LIST = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';
const PROFILE = '44444444-4444-4444-8444-444444444444';

function shown(over: Partial<PlanWord> = {}) {
  const spy = {
    rest: vi.fn(),
    undo: vi.fn(),
    undoSwap: vi.fn(),
    reword: vi.fn(),
    history: vi.fn(),
    showDay: vi.fn(),
    dismiss: vi.fn(),
  };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RebalanceToast
        word={{
          planId: 'plan',
          revision: 3,
          swap: false,
          day: aDay(),
          rebalance: aRebalance(),
          effects: null,
          ...over,
        }}
        busy={false}
        onUndo={spy.undo}
        onUndoSwap={spy.undoSwap}
        onRebalanceRest={spy.rest}
        onReword={spy.reword}
        onHistory={spy.history}
        showDay={spy.showDay}
        onDismiss={spy.dismiss}
      />
    </NextIntlClientProvider>,
  );
  return spy;
}

describe('the card that says what a change of a plan came to', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('says which shopping list the change made stop matching its plan, and leads to it', () => {
    shown({
      effects: {
        lists: [
          {
            id: LIST,
            planId: PLAN,
            profileId: PROFILE,
            fromDate: '2026-11-24',
            toDate: '2026-11-30',
            householdId: null,
          },
        ],
        thaw: [],
        freeze: [],
      },
    });

    expect(
      screen.getByText(/The shopping list of Nov 24 – 30, 2026 no longer matches the plan\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.effectOpenList })).toHaveAttribute(
      'href',
      `/shopping-lists?profile=${PROFILE}&plan=${PLAN}&list=${LIST}`,
    );
  });

  it('says on which days what to take out of the freezer and what to freeze changed, each a way to its day', async () => {
    const { showDay } = shown({
      effects: { lists: [], thaw: ['2026-11-26'], freeze: ['2026-11-25'] },
    });

    expect(screen.getByText(texts.effectThaw, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(texts.effectFreeze, { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show the day Thu, Nov 26' }));
    expect(showDay).toHaveBeenCalledWith('2026-11-26');
  });

  it('stays until it is closed where it speaks of a list or the freezer, and goes by itself otherwise', () => {
    vi.useFakeTimers();
    const lasting = shown({ effects: { lists: [], thaw: ['2026-11-26'], freeze: [] } });
    vi.advanceTimersByTime(60_000);
    expect(lasting.dismiss).not.toHaveBeenCalled();
  });

  it('goes by itself after a while where it says nothing of a list or the freezer', () => {
    vi.useFakeTimers();
    const passing = shown();
    vi.advanceTimersByTime(15_000);
    expect(passing.dismiss).toHaveBeenCalled();
  });

  it("opens the day's history", async () => {
    const { history } = shown();

    await userEvent.click(screen.getByRole('button', { name: texts.toastHistory }));
    expect(history).toHaveBeenCalled();
  });

  it('offers to spread a day off its target over the rest of the plan, and says what that does before it is pressed', async () => {
    const { rest } = shown({
      day: aDay({ offTarget: 'over' }),
      rebalance: aRebalance({ feasibility: 'best-effort' }),
    });

    expect(screen.getByText(texts.rebalanceTitle)).toBeInTheDocument();
    expect(screen.getByText(texts.rebalanceBestEffort)).toBeInTheDocument();
    const spread = screen.getByRole('button', { name: texts.rebalanceRest });
    expect(spread).toHaveAccessibleDescription(texts.rebalanceRestNote);

    await userEvent.click(spread);
    expect(rest).toHaveBeenCalled();
  });

  it('has nothing to spread on a day at its target', () => {
    shown();

    expect(screen.queryByRole('button', { name: texts.rebalanceRest })).toBeNull();
    expect(screen.queryByText(texts.rebalanceRestNote)).toBeNull();
  });

  it('says what the day holds after a swap even where no portion changed, and takes the swap back', async () => {
    const { undoSwap } = shown({ swap: true, rebalance: aRebalance({ changes: [] }) });

    expect(screen.getByText(texts.swapDoneTitle)).toBeInTheDocument();
    expect(screen.queryByText(texts.rebalanceTitle)).toBeNull();
    expect(
      screen.getByText('The day: 2120 of 2100 kcal · protein 95 of 130 g'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.rebalanceUndo })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: texts.undoSwap }));
    expect(undoSwap).toHaveBeenCalled();
  });

  it('offers to correct the words of a recipe a swap of an ingredient made where no model worded them, saying why', async () => {
    const { reword } = shown({ swap: true, reword: 'recipe-1' });

    const button = screen.getByRole('button', { name: texts.rewordButton });
    expect(button).toHaveAccessibleDescription(texts.rewordNote);
    await userEvent.click(button);
    expect(reword).toHaveBeenCalledWith('recipe-1');
  });

  it('offers no correction of words after any other swap', () => {
    shown({ swap: true, reword: null });

    expect(screen.queryByRole('button', { name: texts.rewordButton })).toBeNull();
    expect(screen.queryByText(texts.rewordNote)).toBeNull();
  });

  it('says of a swap that portions changed with it', () => {
    shown({ swap: true });

    expect(screen.getByText(texts.rebalanceTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: texts.undoSwap })).toBeInTheDocument();
  });

  it('says how many meals a sizing of the day rescaled, one meal or more', () => {
    shown();
    shown({
      rebalance: aRebalance({
        changes: Array.from({ length: 3 }, (_, i) => ({
          mealId: `meal-${i}`,
          before: 1,
          after: 0.9,
        })),
      }),
    });

    expect(screen.getByText('2400 → 2100 kcal · 1 meal rescaled.')).toBeInTheDocument();
    expect(screen.getByText('2400 → 2100 kcal · 3 meals rescaled.')).toBeInTheDocument();
  });

  it('gives any other change its portions back', async () => {
    const { undo } = shown();

    expect(screen.queryByRole('button', { name: texts.undoSwap })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: texts.rebalanceUndo }));
    expect(undo).toHaveBeenCalled();
  });

  it('speaks of the rest of the plan once it was spread over, and of what it could not take', () => {
    shown({
      rebalance: aRebalance({
        scope: 'plan',
        feasibility: 'best-effort',
        unabsorbedKcal: 168,
        changes: Array.from({ length: 11 }, (_, i) => ({
          mealId: `meal-${i}`,
          before: 1,
          after: 0.9,
        })),
      }),
      day: aDay({ offTarget: 'over' }),
    });

    expect(screen.getByText(texts.rebalanceTitlePlan)).toBeInTheDocument();
    expect(
      screen.getByText("Meals rescaled on the plan's remaining days: 11."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'The rest of the plan is still 168 kcal over: the other days have no more room inside their own targets.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(texts.rebalanceTitle)).toBeNull();
    expect(screen.queryByText(texts.rebalanceBestEffort)).toBeNull();
    expect(screen.queryByRole('button', { name: texts.rebalanceRest })).toBeNull();
  });
});
