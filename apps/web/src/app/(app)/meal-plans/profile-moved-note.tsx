// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ChangedPlan, DayEventCause, MealPlan } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { ApiClientError, localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { ListNote } from './list-note';

/**
 * One note for a running plan whose profile moved away from it since it was made: its target (`targetMoved`), its
 * split on the custom diet (`splitMoved`), its diet (`dietMoved`) or its number of meals a day (`mealCountMoved`). It
 * names each, and offers what takes them from today. Where the diet moved, the whole plan made again from today ("Ułóż
 * dni od dziś od nowa", in the window that makes a plan again), which takes the diet, the number of meals and the
 * target together; otherwise "Przyjmij od dziś" for the target and the split (`POST /meal-plans/:id/retarget`) and
 * "Uzupełnij lub odejmij" for the number of meals (`POST /meal-plans/:id/meal-count`), both where both moved. Each says
 * beforehand what it does, and what it does to a shopping list. Nothing for a plan nothing of which moved.
 */
export function ProfileMovedNote({
  plan,
  onTaken,
  onReroll,
}: {
  plan: MealPlan;
  /** Told when the plan is no longer what the page shows: a change was taken (`changed`, by `cause`), or the plan had changed. */
  onTaken: (changed?: ChangedPlan, cause?: DayEventCause) => void;
  /** Opens the window that makes the whole plan again. */
  onReroll: () => void;
}) {
  const t = useTranslations('mealPlans');
  const tDiet = useTranslations('enums.dietType');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const take = useMutation({
    mutationFn: (what: 'retarget' | 'meal-count') =>
      api.post<ChangedPlan>(`/meal-plans/${plan.id}/${what}`, { revision: plan.revision }),
    onSuccess: (changed, what) => {
      setError(null);
      onTaken(changed, what);
    },
    onError: (e: unknown, what) => {
      if (e instanceof ApiClientError && e.code === 'PLAN_CHANGED') onTaken();
      setError(errorText(e, t(what === 'retarget' ? 'errRetarget' : 'errTakeCount')));
    },
  });
  const { targetMoved, splitMoved, dietMoved, mealCountMoved } = plan;
  if (!targetMoved && !splitMoved && !dietMoved && !mealCountMoved) return null;
  const today = localDate();
  const listed = plan.days.some((day) => day.date >= today && !day.skipped && day.listed);
  const action = (label: string, note: string, onClick: () => void) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={take.isPending} onClick={onClick}>
        {label}
      </Button>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
      {dietMoved && (
        <p>
          {t('movedDiet', {
            profile: tDiet(dietMoved.profileDiet),
            plan: tDiet(dietMoved.planDiet),
          })}
        </p>
      )}
      {mealCountMoved && (
        <p>
          {t('movedMeals', {
            profile: mealCountMoved.profileCount,
            plan: mealCountMoved.planCount,
          })}
        </p>
      )}
      {targetMoved && (
        <p>
          {t('targetMoved', { profile: targetMoved.profileTarget, plan: targetMoved.planTarget })}
        </p>
      )}
      {splitMoved && !targetMoved && <p>{t('movedSplit')}</p>}
      {dietMoved ? (
        action(t('rerollFromToday'), t('rerollFromTodayNote'), onReroll)
      ) : (
        <>
          {(targetMoved || splitMoved) &&
            action(t('retarget'), t('retargetNote'), () => take.mutate('retarget'))}
          {mealCountMoved &&
            action(t('takeCount'), t('takeCountNote'), () => take.mutate('meal-count'))}
        </>
      )}
      <ListNote days="several" listed={listed} />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
