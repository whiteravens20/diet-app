// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { MealPlan } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { ApiClientError, localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { ListNote } from './list-note';

/**
 * A running plan whose profile's target moved since it was made (a change of
 * activity, the newest weight, a correction of the real expenditure): what
 * both targets are, and a button that takes the profile's from today
 * (`POST /meal-plans/:id/retarget`), which says beforehand what it does and
 * what it does to a shopping list. Nothing for a plan whose target did not
 * move, or was typed for it.
 */
export function TargetMovedLine({ plan, onTaken }: { plan: MealPlan; onTaken: () => void }) {
  const t = useTranslations('mealPlans');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const take = useMutation({
    mutationFn: () =>
      api.post<MealPlan>(`/meal-plans/${plan.id}/retarget`, { revision: plan.revision }),
    onSuccess: () => {
      setError(null);
      onTaken();
    },
    onError: (e: unknown) => {
      if (e instanceof ApiClientError && e.code === 'PLAN_CHANGED') onTaken();
      setError(errorText(e, t('errRetarget')));
    },
  });
  const moved = plan.targetMoved;
  if (!moved) return null;
  const today = localDate();
  const listed = plan.days.some((day) => day.date >= today && !day.skipped && day.listed);
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
      <p>{t('targetMoved', { profile: moved.profileTarget, plan: moved.planTarget })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={take.isPending}
          onClick={() => take.mutate()}
        >
          {t('retarget')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('retargetNote')}</span>
      </div>
      <ListNote days="several" listed={listed} />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
