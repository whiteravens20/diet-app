// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { MealPlan, PlanWeek } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';

/**
 * A week of a plan whose days aim off the plan's target on average, as a
 * change of one day left it: what the average is, and a button that evens the
 * week out (`POST /meal-plans/:id/weeks/even`), which says beforehand what it
 * does. Nothing for a week that is even, or that no day of from today on can
 * change any more.
 */
export function WeekLine({
  planId,
  revision,
  week,
  onEvened,
}: {
  planId: string;
  revision: number;
  week: PlanWeek | undefined;
  /** Told when the plan is no longer what the page shows: the week was evened out, or the plan had changed. */
  onEvened: () => void;
}) {
  const t = useTranslations('mealPlans');
  const fmt = useFormat();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const even = useMutation({
    mutationFn: (asked: PlanWeek) =>
      api.post<MealPlan>(`/meal-plans/${planId}/weeks/even`, { date: asked.from, revision }),
    onSuccess: () => {
      setError(null);
      onEvened();
    },
    onError: (e: unknown) => {
      if (e instanceof ApiClientError && e.code === 'PLAN_CHANGED') onEvened();
      setError(errorText(e, t('errEvenWeek')));
    },
  });
  if (!week?.uneven || week.average === null) return null;
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
      <p>
        {t('weekUneven', { average: fmt.number(week.average), target: fmt.number(week.target) })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={even.isPending}
          onClick={() => even.mutate(week)}
        >
          {t('evenWeek')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('evenWeekNote')}</span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
