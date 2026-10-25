// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RebalanceResult } from '@diet-app/shared';
import messages from '../../../../messages/en.json';
import { RebalanceToast } from './rebalance-toast';

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

function shown(rebalance: Rebalance) {
  const onRebalanceRest = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RebalanceToast rebalance={rebalance} busy={false} onUndo={() => {}} onRebalanceRest={onRebalanceRest} onDismiss={() => {}} />
    </NextIntlClientProvider>,
  );
  return onRebalanceRest;
}

describe('the card that says what a rebalance did', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers to spread a day over the rest of the plan, and says what that does before it is pressed', async () => {
    const onRebalanceRest = shown(aRebalance({ feasibility: 'best-effort' }));

    expect(screen.getByText(texts.rebalanceTitle)).toBeInTheDocument();
    expect(screen.getByText(texts.rebalanceBestEffort)).toBeInTheDocument();
    const spread = screen.getByRole('button', { name: texts.rebalanceRest });
    expect(spread).toHaveAccessibleDescription(texts.rebalanceRestNote);

    await userEvent.click(spread);
    expect(onRebalanceRest).toHaveBeenCalled();
  });

  it('speaks of the rest of the plan once it was spread over, and of what it could not take', () => {
    shown(aRebalance({ scope: 'plan', feasibility: 'best-effort', unabsorbedKcal: 168, changes: Array.from({ length: 11 }, (_, i) => ({ mealId: `meal-${i}`, before: 1, after: 0.9 })) }));

    expect(screen.getByText(texts.rebalanceTitlePlan)).toBeInTheDocument();
    expect(screen.getByText("Meals rescaled on the plan's remaining days: 11.")).toBeInTheDocument();
    expect(screen.getByText('The rest of the plan is still 168 kcal over: the other days have no more room inside their own targets.')).toBeInTheDocument();
    expect(screen.queryByText(texts.rebalanceTitle)).toBeNull();
    expect(screen.queryByText(texts.rebalanceBestEffort)).toBeNull();
    expect(screen.queryByRole('button', { name: texts.rebalanceRest })).toBeNull();
  });
});
