// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { Scale } from 'lucide-react';
import type {
  ChangedPlan,
  DayEventCause,
  MealPlanDay,
  PlanChangeEffects,
  RebalanceResult,
} from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/use-format';

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
  /** What it did to the shopping lists and the freezer; null where it did nothing to them. */
  effects: PlanChangeEffects | null;
  /** The recipe a swap of an ingredient made, where no model worded its text: its words can be corrected. */
  reword?: string | null;
  /**
   * A change of another kind than a sizing or a swap, as the day's history names it: its card says what the change
   * did to the lists and the freezer, and has nothing of its own to take back.
   */
  cause?: DayEventCause | null;
}

/** A change whose answer is the plan as it left it (`ChangedPlan`): what it was, and the day it was of, if one. */
export interface PlanChange {
  plan: ChangedPlan;
  cause: DayEventCause;
  date: string | null;
}

/** Whether a change said anything of the lists or the freezer: such a card stays until it is closed. */
export const toldEffects = (effects: PlanChangeEffects | null | undefined): boolean =>
  !!effects && effects.lists.length + effects.thaw.length + effects.freeze.length > 0;

/** Where a list a change made stop matching is read: the household's list for a part of one. */
const listHref = (list: PlanChangeEffects['lists'][number]): string =>
  `/shopping-lists?${new URLSearchParams({
    profile: list.profileId,
    plan: list.planId,
    list: list.id,
    ...(list.householdId ? { household: list.householdId } : {}),
  })}`;

/**
 * A card at the bottom right, the whole width on a phone, that says what a change came to: what the day holds now,
 * what was sized again, what the change did to the shopping lists and the freezer, and what can be done about it. A
 * swap can be taken back with its portions; a sizing, its portions alone; a change of another kind (a day's settings,
 * days made again, a set put on them) is named as the day's history names it and only says what it did to the lists
 * and the freezer. Spreading is offered with what it
 * does said beside it where the day is off its target, as the day itself offers it. After a swap of an ingredient
 * whose text no model worded, the recipe's words can be corrected. The day's history is a link away. Goes by itself
 * after some seconds, and with the next change; a card that speaks of a list or the freezer stays until it is closed.
 */
export function RebalanceToast({
  word,
  busy,
  onUndo,
  onUndoSwap,
  onRebalanceRest,
  onReword,
  onHistory,
  showDay,
  onDismiss,
}: {
  word: PlanWord;
  busy: boolean;
  onUndo: () => void;
  /** Where the card can speak of a swap at all. */
  onUndoSwap?: () => void;
  onRebalanceRest: () => void;
  onReword?: (recipeId: string) => void;
  /** Opens the history of the day the change was of. */
  onHistory?: () => void;
  /** Leads to a day of the plan whose notes of the freezer the change moved: on the plan's page itself, or by a link. */
  showDay: ((date: string) => void) | { href: (date: string) => string };
  onDismiss: () => void;
}) {
  const t = useTranslations('mealPlans');
  const tHistory = useTranslations('dayHistory');
  const fmt = useFormat();
  const { rebalance, swap, day, effects, cause } = word;
  const lasting = toldEffects(effects);
  // Keep the auto-dismiss timer stable across parent re-renders: the latest
  // onDismiss lives in a ref (updated in an effect, never during render) so the
  // timer is armed exactly once.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    if (lasting) return;
    const id = setTimeout(() => dismiss.current(), SHOWN_FOR);
    return () => clearTimeout(id);
  }, [lasting]);
  const sized = (rebalance?.changes.length ?? 0) > 0;
  const ofTheDay = rebalance === null || rebalance.scope === 'day';
  const spreadable = !cause && ofTheDay && day !== null && day.offTarget !== null;
  const linkLook =
    // In the colour of the text: the app's colour on its own light shade reads too faintly for a link.
    'inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-2';
  const days = (dates: readonly string[]) =>
    dates.map((date, at) => (
      <span key={date}>
        {at > 0 && ', '}
        {typeof showDay === 'function' ? (
          <button
            type="button"
            className={linkLook}
            aria-label={t('effectDay', { day: fmt.day(date) })}
            onClick={() => showDay(date)}
          >
            {fmt.dayShort(date)}
          </button>
        ) : (
          <Link
            href={showDay.href(date)}
            className={linkLook}
            aria-label={t('effectDay', { day: fmt.day(date) })}
          >
            {fmt.dayShort(date)}
          </Link>
        )}
      </span>
    ));

  return (
    // Over the bar of an address not confirmed, where one stands at the bottom of the screen.
    <div className="fixed inset-x-4 bottom-[calc(1rem+var(--bottom-bar,0px))] z-50 overflow-hidden rounded-lg border border-l-4 border-border border-l-primary bg-background shadow-lg sm:left-auto sm:right-4 sm:max-w-sm print:hidden">
      <div className="bg-primary/10 p-4">
        <p className="flex items-center gap-2 text-base font-semibold">
          <Scale aria-hidden className="size-5 shrink-0 text-primary" />
          {cause
            ? tHistory(`cause.${cause}`)
            : t(
                ofTheDay
                  ? swap && !sized
                    ? 'swapDoneTitle'
                    : 'rebalanceTitle'
                  : 'rebalanceTitlePlan',
              )}
        </p>
        {ofTheDay ? (
          <>
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
          <p className="mt-1 text-xs text-muted-foreground">
            {t('rebalanceSummaryPlan', { count: rebalance.changes.length })}
          </p>
        )}
        {effects?.lists.map((list) => (
          <p key={list.id} className="mt-2 text-sm">
            {t('effectList', { dates: fmt.dates(list.fromDate, list.toDate) })}{' '}
            <Link href={listHref(list)} className={linkLook}>
              {t('effectOpenList')}
            </Link>
          </p>
        ))}
        {effects && effects.thaw.length > 0 && (
          <p className="mt-2 text-sm">
            {t('effectThaw')} {days(effects.thaw)}
          </p>
        )}
        {effects && effects.freeze.length > 0 && (
          <p className="mt-2 text-sm">
            {t('effectFreeze')} {days(effects.freeze)}
          </p>
        )}
        {spreadable && (
          <p id="rebalance-rest-note" className="mt-1 text-xs text-muted-foreground">
            {t('rebalanceRestNote')}
          </p>
        )}
        {word.reword && onReword && (
          <p id="reword-note" className="mt-1 text-xs text-muted-foreground">
            {t('rewordNote')}
          </p>
        )}
        {rebalance !== null && rebalance.unabsorbedKcal !== 0 && (
          <p className="mt-1 text-xs text-warning">
            {t(rebalance.unabsorbedKcal > 0 ? 'rebalanceLeftOver' : 'rebalanceLeftUnder', {
              kcal: Math.abs(rebalance.unabsorbedKcal),
            })}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {cause ? null : swap ? (
            <Button type="button" variant="outline" size="sm" onClick={onUndoSwap} disabled={busy}>
              {t('undoSwap')}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={onUndo} disabled={busy}>
              {t('rebalanceUndo')}
            </Button>
          )}
          {word.reword && onReword && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onReword(word.reword!)}
              disabled={busy}
              aria-describedby="reword-note"
            >
              {t('rewordButton')}
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
          {onHistory && day && (
            <Button type="button" variant="ghost" size="sm" onClick={onHistory}>
              {t('toastHistory')}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            {t('rebalanceDismiss')}
          </Button>
        </div>
      </div>
    </div>
  );
}
