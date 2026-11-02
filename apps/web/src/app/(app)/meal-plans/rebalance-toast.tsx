// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { MealPlanDay, RebalanceResult } from '@diet-app/shared';
import { Button } from '@/components/ui/button';

/** How long the card stays by itself, in milliseconds: long enough to read it and take a swap back. */
const SHOWN_FOR = 15_000;

/** What a change of a plan came to, and whether it was a swap, which can be taken back whole. */
export interface PlanWord {
  planId: string;
  revision: number;
  swap: boolean;
  /** The day it changed, as it stands now. */
  day: MealPlanDay | null;
  rebalance: RebalanceResult['rebalance'];
}

/**
 * A card at the bottom right that says what a change came to: what the day
 * holds now, what was sized again, and what can be done about it. A swap can
 * be taken back with its portions; any other change, its portions alone.
 * Spreading is offered with what it does said beside it where the day is off
 * its target, as the day itself offers it. Goes by itself after some seconds,
 * and with the next change.
 */
export function RebalanceToast({
  word,
  busy,
  onUndo,
  onUndoSwap,
  onRebalanceRest,
  onDismiss,
}: {
  word: PlanWord;
  busy: boolean;
  onUndo: () => void;
  /** Where the card can speak of a swap at all. */
  onUndoSwap?: () => void;
  onRebalanceRest: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('mealPlans');
  const { rebalance, swap, day } = word;
  // Keep the auto-dismiss timer stable across parent re-renders: the latest
  // onDismiss lives in a ref (updated in an effect, never during render) so the
  // timer is armed exactly once.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const id = setTimeout(() => dismiss.current(), SHOWN_FOR);
    return () => clearTimeout(id);
  }, []);
  const sized = (rebalance?.changes.length ?? 0) > 0;
  const ofTheDay = rebalance === null || rebalance.scope === 'day';
  const spreadable = ofTheDay && day !== null && day.offTarget !== null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg print:hidden">
      {ofTheDay ? (
        <>
          <p className="text-sm font-medium">
            {t(swap && !sized ? 'swapDoneTitle' : 'rebalanceTitle')}
          </p>
          {day && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('wordDay', {
                kcal: day.dayNutrition.calories,
                target: day.calorieTarget,
                protein: day.dayNutrition.protein,
                proteinTarget: day.targetMacros.protein,
              })}
            </p>
          )}
          {rebalance && sized && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('rebalanceSummary', {
                before: Math.round(rebalance.macrosBefore.calories),
                after: Math.round(rebalance.macrosAfter.calories),
                count: rebalance.changes.length,
              })}
            </p>
          )}
          {rebalance?.feasibility === 'best-effort' && (
            <p className="mt-1 text-xs text-warning">{t('rebalanceBestEffort')}</p>
          )}
        </>
      ) : (
        // Spread over the rest of the plan: what is left over, if anything, is said below.
        <>
          <p className="text-sm font-medium">{t('rebalanceTitlePlan')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('rebalanceSummaryPlan', { count: rebalance.changes.length })}
          </p>
        </>
      )}
      {spreadable && (
        <p id="rebalance-rest-note" className="mt-1 text-xs text-muted-foreground">
          {t('rebalanceRestNote')}
        </p>
      )}
      {rebalance !== null && rebalance.unabsorbedKcal !== 0 && (
        <p className="mt-1 text-xs text-warning">
          {t(rebalance.unabsorbedKcal > 0 ? 'rebalanceLeftOver' : 'rebalanceLeftUnder', {
            kcal: Math.abs(rebalance.unabsorbedKcal),
          })}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {swap ? (
          <Button type="button" variant="outline" size="sm" onClick={onUndoSwap} disabled={busy}>
            {t('undoSwap')}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onUndo} disabled={busy}>
            {t('rebalanceUndo')}
          </Button>
        )}
        {spreadable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRebalanceRest}
            disabled={busy}
            aria-describedby="rebalance-rest-note"
          >
            {t('rebalanceRest')}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('rebalanceDismiss')}
        </Button>
      </div>
    </div>
  );
}
