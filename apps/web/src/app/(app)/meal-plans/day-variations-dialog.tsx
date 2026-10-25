// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { DayVariations, MealPlan } from '@diet-app/shared';
import { ModelSays, WeighButton, WeighedLine } from '@/components/weigh';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';

/**
 * The window that offers other ways to fill a day of a plan. The API makes
 * the ways and counts everything that is said of them; this shows them, asks
 * a model to weigh them when the reader wants that, and takes the one the
 * reader chooses. Nothing changes until one is taken.
 */
export function DayVariationsDialog({
  planId,
  day,
  aiEnabled,
  aiOffNote,
  mealName,
  onClose,
  onChanged,
}: {
  planId: string;
  day: { id: string; date: string };
  aiEnabled: boolean;
  /** The line that says why what asks a model is off, for the button that is. */
  aiOffNote?: string;
  mealName: (mealType: string) => string;
  onClose: () => void;
  /** Told when the plan is no longer what the page shows: a way was taken, or the plan had changed under the offer. */
  onChanged: () => void;
}) {
  const t = useTranslations('mealPlans.variations');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // The ways as a model weighed them, once one was asked: they stand in the place of the ways as they came first.
  const [weighed, setWeighed] = useState<DayVariations | null>(null);

  const path = `/meal-plans/${planId}/days/${day.id}/variations`;
  // Drawn anew for every opening: an offer is good for the plan as it stands, and for a sitting.
  const first = useQuery({
    queryKey: ['day-variations', planId, day.id],
    queryFn: () => api.post<DayVariations>(path, { weigh: false }),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const weigh = useMutation({
    mutationFn: () => api.post<DayVariations>(path, { weigh: true }),
    onSuccess: (answer) => {
      setError(null);
      setWeighed(answer);
      // A model was asked: that counts against the allowance, whoever put the order in the end.
      void qc.invalidateQueries({ queryKey: ['ai-quota'] });
    },
    onError: (e: unknown) => setError(errorText(e, t('errLoad'))),
  });
  const take = useMutation({
    mutationFn: (offer: string) => api.post<MealPlan>(`${path}/take`, { offer }),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: (e: unknown) => {
      // The offer was for the plan as it was: where the plan changed, the page reads it anew.
      onChanged();
      setError(errorText(e, t('errTake')));
    },
  });

  const shown = weighed ?? first.data;
  const busy = take.isPending || weigh.isPending;
  const title = t('title', { date: fmt.day(day.date) });

  return (
    <Dialog open onClose={onClose} label={title} className="max-w-2xl">
      <div className="space-y-4 p-4">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
        {first.isLoading && (
          <div role="status" aria-label={t('loading')}>
            <Skeleton className="h-32" />
          </div>
        )}
        {first.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(first.error, t('errLoad'))}
          </p>
        )}
        {shown && (
          <>
            <p className="text-xs text-muted-foreground">
              {t('now', {
                kcal: shown.current.dayNutrition.calories,
                target: Math.round(shown.calorieTarget),
                wasted: shown.current.packs.wasted,
              })}
            </p>
            {shown.variations.length === 0 ? (
              <p className="text-sm">{t('none')}</p>
            ) : (
              <ol className="space-y-3">
                {shown.variations.map((way, index) => (
                  <li key={way.offer} className="space-y-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium">{t('way', { n: index + 1 })}</h3>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => take.mutate(way.offer)}
                      >
                        {t('take')}
                      </Button>
                    </div>
                    <ModelSays reason={way.reason} />
                    <ul className="space-y-0.5 text-sm">
                      {way.meals.map((meal) => (
                        <li key={`${meal.mealType}-${meal.recipeId ?? meal.title}`}>
                          <span className="text-muted-foreground">{mealName(meal.mealType)}</span> ·{' '}
                          {meal.title}
                          <span className="text-muted-foreground">
                            {' '}
                            · {t('mealEnergy', { kcal: meal.nutrition.calories })}
                          </span>
                          {meal.stays && (
                            <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                              {t('stays')}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      {t('dayLine', {
                        kcal: way.dayNutrition.calories,
                        target: Math.round(shown.calorieTarget),
                        protein: way.dayNutrition.protein,
                        fat: way.dayNutrition.fat,
                        carbs: way.dayNutrition.carbs,
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('packsLine', { wasted: way.packs.wasted })}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <WeighedLine aiMeta={weighed?.aiMeta ?? null} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {shown && shown.variations.length > 0 ? (
            <WeighButton
              enabled={aiEnabled}
              offNote={aiOffNote}
              asking={weigh.isPending}
              onAsk={() => weigh.mutate()}
            />
          ) : (
            <span />
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
