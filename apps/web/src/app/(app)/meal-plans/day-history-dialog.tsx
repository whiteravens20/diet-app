// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type {
  DayEvent,
  DayEventMeal,
  DayEventMealState,
  DayHistory,
  PlanChangeEffects,
} from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/use-format';

/** The day a history window is of, and where it was opened. */
export interface HistoryOf {
  planId: string;
  dayId: string;
  date: string;
  profileId: string;
  /** Whether sizing the day again would give a meal another portion (`MealPlanDay.resizes`). */
  resizes: boolean;
  /** The plan's day or the diary's: the other is a link away. */
  from: 'plan' | 'diary';
}

/**
 * The history of a day of a plan ("Historia dnia"), opened from the plan's day, from the diary of its date and from the
 * card after a change: what holds the day (the user's own choice of its portions, and what no sizing moves), the
 * changes of the day, the latest first, each with its time, its cause and the meals it moved, and what can be done:
 * the last change taken back where the plan has not changed since, the day sized again where that would move a meal,
 * and its portions kept as they are.
 */
export function DayHistoryDialog({
  of,
  today,
  onChanged,
  onClose,
}: {
  of: HistoryOf;
  today: string;
  /** A change made here: the plan is read again. */
  onChanged: (planId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('dayHistory');
  const tPlans = useTranslations('mealPlans');
  const tMeal = useTranslations('enums.mealType');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const qc = useQueryClient();
  const [failed, setFailed] = useState(false);
  const key = ['day-history', of.planId, of.dayId];
  const history = useQuery({
    queryKey: key,
    queryFn: () => api.get<DayHistory>(`/meal-plans/${of.planId}/days/${of.dayId}/history`),
  });
  const act = useMutation({
    mutationFn: (what: 'undo' | 'resize' | 'keep') => {
      const day = history.data!;
      if (what === 'keep')
        return api.post(`/meal-plans/${of.planId}/days/${of.dayId}/keep`, {
          revision: day.revision,
        });
      if (what === 'resize')
        return api.post(`/meal-plans/${of.planId}/rebalance`, { scope: 'day', date: of.date });
      return day.undo!.kind === 'swap'
        ? api.post('/meal-plans/swap-meal/undo', { planId: of.planId, revision: day.revision })
        : api.post(`/meal-plans/${of.planId}/rebalance`, {
            scope: 'day',
            restore: day.undo!.restore,
          });
    },
    onSuccess: () => {
      setFailed(false);
      onChanged(of.planId);
    },
    onError: () => setFailed(true),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  const mealType = (type: string): string =>
    tMeal.has(type) ? tMeal(type) : type.replace('_', ' ');
  const name = (state: DayEventMealState | null): string =>
    state?.name !== null && state?.name !== undefined ? fmt.text(state.name) : t('unnamed');
  const mealLine = ({ mealType: type, before, after }: DayEventMeal): string => {
    const meal = mealType(type);
    if (before && after) {
      if (before.eaten !== after.eaten)
        return t(after.eaten ? 'mealEaten' : 'mealNotEaten', { meal, name: name(after) });
      if (before.name !== after.name)
        return t('mealReplaced', {
          meal,
          before: name(before),
          after: name(after),
          kcal: after.calories,
        });
      return t('mealChanged', {
        meal,
        name: name(after),
        before: before.calories,
        after: after.calories,
      });
    }
    if (after) return t('mealAdded', { meal, name: name(after), kcal: after.calories });
    return t('mealRemoved', { meal, name: name(before) });
  };
  const effectLines = (effects: PlanChangeEffects) => [
    ...effects.lists.map((list) =>
      tPlans('effectList', { dates: fmt.dates(list.fromDate, list.toDate) }),
    ),
    ...(effects.thaw.length > 0
      ? [`${tPlans('effectThaw')} ${fmt.list(effects.thaw.map((date) => fmt.dayShort(date)))}`]
      : []),
    ...(effects.freeze.length > 0
      ? [`${tPlans('effectFreeze')} ${fmt.list(effects.freeze.map((date) => fmt.dayShort(date)))}`]
      : []),
  ];
  const days = (dates: readonly string[]) => fmt.list(dates.map((date) => fmt.dayShort(date)));
  const event = (one: DayEvent) => (
    <li key={one.id} className="space-y-1 py-3">
      <p className="text-xs text-muted-foreground">{fmt.moment(one.at)}</p>
      <p className="font-medium">{t(`cause.${one.cause}`)}</p>
      {!one.own && (
        <p className="text-xs text-muted-foreground">
          {one.from.length > 0
            ? t('fromDays', { count: one.from.length, days: days(one.from) })
            : t('fromList')}
        </p>
      )}
      {one.meals.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {one.meals.map((meal) => (
            <li key={meal.mealId}>{mealLine(meal)}</li>
          ))}
        </ul>
      )}
      {one.target && <p className="text-xs">{t('target', one.target)}</p>}
      {one.choice && one.choice.before !== null && one.choice.after === null && (
        <p className="text-xs">{t('choiceEnded')}</p>
      )}
      {effectLines(one.effects).map((line) => (
        <p key={line} className="text-xs text-warning">
          {line}
        </p>
      ))}
    </li>
  );

  const day = history.data;
  const holds = day?.holds;
  const kept = day?.kept;
  const keptLine = kept
    ? t(
        kept.choice === 'undo' ? 'keptUndo' : kept.choice === 'spread' ? 'keptSpread' : 'keptKept',
        { at: fmt.moment(kept.at) },
      )
    : null;
  const held =
    holds &&
    [
      holds.ownMeals.length > 0 && t('ownMeals', { names: fmt.list(holds.ownMeals.map(fmt.text)) }),
      holds.eatenMeals.length > 0 &&
        t('eatenMeals', { names: fmt.list(holds.eatenMeals.map(fmt.text)) }),
      holds.leftovers.length > 0 &&
        t('leftovers', { names: fmt.list(holds.leftovers.map(fmt.text)) }),
      holds.rests.length > 0 && t('rests', { names: fmt.list(holds.rests.map(fmt.text)) }),
      holds.diaryEntries > 0 && t('diaryEntries', { count: holds.diaryEntries }),
    ].filter((line): line is string => typeof line === 'string');
  const keepable = of.date >= today && kept?.choice !== 'kept';

  return (
    <Dialog open onClose={onClose} label={t('title')} className="max-w-lg">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{fmt.day(of.date)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4 text-sm">
        {history.isPending ? (
          <div className="space-y-2" aria-label={t('loading')}>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !day ? (
          <p role="alert" className="text-destructive">
            {t('failed')}
          </p>
        ) : (
          <>
            <section className="space-y-1">
              <h3 className="font-medium">{t('holdsTitle')}</h3>
              <p>{keptLine ?? t('adjusts')}</p>
              {kept && <p className="text-xs text-muted-foreground">{t('keptNote')}</p>}
              {held && held.length > 0 && (
                <>
                  {held.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <p className="text-xs text-muted-foreground">{t('holdsNote')}</p>
                </>
              )}
            </section>
            {(day.undo || of.resizes || keepable) && (
              <section className="space-y-2">
                {day.undo && (
                  <div className="space-y-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={act.isPending}
                      aria-describedby={`${of.dayId}-undo`}
                      onClick={() => act.mutate('undo')}
                    >
                      {t('undo')}
                    </Button>
                    <p id={`${of.dayId}-undo`} className="text-xs text-muted-foreground">
                      {[
                        ...(day.undo.kind === 'restore' ? [t('undoPortions')] : []),
                        ...(day.undo.alsoDays.length > 0
                          ? [
                              t('undoAlso', {
                                count: day.undo.alsoDays.length,
                                days: days(day.undo.alsoDays),
                              }),
                            ]
                          : []),
                      ].join(' ')}
                    </p>
                  </div>
                )}
                {of.resizes && (
                  <div className="space-y-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={act.isPending}
                      aria-describedby={`${of.dayId}-resize`}
                      onClick={() => act.mutate('resize')}
                    >
                      {tPlans('resizeDay')}
                    </Button>
                    <p id={`${of.dayId}-resize`} className="text-xs text-muted-foreground">
                      {tPlans(
                        holds && holds.diaryEntries > 0 ? 'resizeDayNote' : 'resizeDayNotePlain',
                      )}
                    </p>
                  </div>
                )}
                {keepable && (
                  <div className="space-y-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={act.isPending}
                      aria-describedby={`${of.dayId}-keep`}
                      onClick={() => act.mutate('keep')}
                    >
                      {t('keep')}
                    </Button>
                    <p id={`${of.dayId}-keep`} className="text-xs text-muted-foreground">
                      {t('keepNote')}
                    </p>
                  </div>
                )}
                {failed && (
                  <p role="alert" className="text-xs text-destructive">
                    {t('actionFailed')}
                  </p>
                )}
              </section>
            )}
            <section>
              <h3 className="font-medium">{t('changesTitle')}</h3>
              {day.events.length === 0 ? (
                <p className="mt-1 text-muted-foreground">{t('noChanges')}</p>
              ) : (
                <ol className="divide-y divide-border">{day.events.map(event)}</ol>
              )}
            </section>
          </>
        )}
        {of.from === 'plan' ? (
          of.date <= today && (
            <Link
              href={`/diary?profile=${of.profileId}&date=${of.date}`}
              className="inline-flex min-h-6 items-center text-xs underline underline-offset-2"
            >
              {tPlans('openDiary')}
            </Link>
          )
        ) : (
          <Link
            href={`/meal-plans?profile=${of.profileId}&plan=${of.planId}&day=${of.date}`}
            className="inline-flex min-h-6 items-center text-xs underline underline-offset-2"
          >
            {t('openInPlan')}
          </Link>
        )}
      </div>
    </Dialog>
  );
}
