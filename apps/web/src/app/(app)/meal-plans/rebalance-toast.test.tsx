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

function shown(over: Partial<PlanWord> = {}) {
  const spy = { rest: vi.fn(), undo: vi.fn(), undoSwap: vi.fn(), reword: vi.fn() };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RebalanceToast
        word={{
          planId: 'plan',
          revision: 3,
          swap: false,
          day: aDay(),
          rebalance: aRebalance(),
          ...over,
        }}
        busy={false}
        onUndo={spy.undo}
        onUndoSwap={spy.undoSwap}
        onRebalanceRest={spy.rest}
        onReword={spy.reword}
        onDismiss={() => {}}
      />
    </NextIntlClientProvider>,
  );
  return spy;
}

describe('the card that says what a change of a plan came to', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
