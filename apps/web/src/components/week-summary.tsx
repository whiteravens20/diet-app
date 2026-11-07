// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Profile, WeekSummary } from '@diet-app/shared';
import { WEEK_DAYS } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import { useFormat } from '@/lib/use-format';
import { shownWeight, useWeightUnit } from '@/lib/weight-unit';

/**
 * A profile's week in sum: the seven full days before today, or before a day
 * the diary went back to. What the days with an entry or an eaten meal ate on
 * average against their targets, how many came within a tenth of them, and
 * where the weights lead. In the diary it goes back and forth a week at a time.
 */
export function WeekSummaryCard({ profile, weeks = false }: { profile: Profile; weeks?: boolean }) {
  const t = useTranslations('weekSummary');
  const fmt = useFormat();
  const yesterday = dayAfter(localDate(), -1);
  const [to, setTo] = useState(yesterday);
  const week = useQuery({
    queryKey: ['week-summary', profile.id, to],
    queryFn: () => api.get<WeekSummary>(`/diary/week?profileId=${profile.id}&to=${to}`),
  });
  const shown = week.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{to === yesterday ? t('title') : t('titleOf')}</CardTitle>
        {shown && (
          <p className="text-sm text-muted-foreground">{fmt.dates(shown.from, shown.to)}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!shown ? (
          <Skeleton className="h-20" />
        ) : (
          <>
            {shown.eaten && shown.target ? (
              <>
                <p className="text-base font-semibold">
                  {t('eaten', { eaten: shown.eaten.calories, target: shown.target.calories })}
                </p>
                <p>{t('within', { within: shown.withinTarget, counted: shown.counted })}</p>
                <p className="text-muted-foreground">
                  {t('macros', {
                    protein: shown.eaten.protein,
                    proteinTarget: shown.target.protein,
                    fat: shown.eaten.fat,
                    fatTarget: shown.target.fat,
                    carbs: shown.eaten.carbs,
                    carbsTarget: shown.target.carbs,
                  })}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">{t('nothing')}</p>
            )}
            {shown.empty > 0 && shown.counted > 0 && (
              <p className="text-muted-foreground">{t('empty', { empty: shown.empty })}</p>
            )}
            <WaterLine water={shown.water} />
            <WeightLine summary={shown} />
          </>
        )}
        {weeks && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setTo(dayAfter(to, -WEEK_DAYS))}
            >
              {t('previous')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={to >= yesterday}
              onClick={() => setTo(dayAfter(to, WEEK_DAYS))}
            >
              {t('next')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** What the week drank: the average of the days that hold water and, with a target, how many reached it. */
function WaterLine({ water }: { water: WeekSummary['water'] }) {
  const t = useTranslations('weekSummary');
  const fmt = useFormat();
  if (water.averageMl === null) return null;
  const liters = (ml: number) => fmt.unit(ml / 1000, 'liter', 2);
  return (
    <p>
      {water.target === null
        ? t('waterNoTarget', { average: liters(water.averageMl) })
        : t('water', {
            average: liters(water.averageMl),
            target: liters(water.target),
            reached: water.reached,
            counted: water.counted,
          })}
    </p>
  );
}

/** Where the weights lead: their pace a week and, with a target weight, when it is reached at that pace. */
function WeightLine({ summary }: { summary: WeekSummary }) {
  const t = useTranslations('weekSummary');
  const fmt = useFormat();
  const unit = useWeightUnit();
  const { kgPerWeek, targetKg, reachesTargetOn } = summary.weight;
  if (kgPerWeek === null) return <p className="text-muted-foreground">{t('trendNone')}</p>;
  // In the account's unit, as the weight card shows weights.
  const kg = (value: number) =>
    fmt.unit(shownWeight(value, unit), unit === 'lb' ? 'pound' : 'kilogram', 1);
  return (
    <p>
      {t('trend', {
        pace: `${kgPerWeek > 0 ? '+' : kgPerWeek < 0 ? '−' : ''}${kg(Math.abs(kgPerWeek))}`,
      })}
      {targetKg !== null && (
        <>
          {' '}
          {reachesTargetOn
            ? t('reaches', { target: kg(targetKg), date: fmt.date(reachesTargetOn) })
            : t('leadsAway', { target: kg(targetKg) })}
        </>
      )}
    </p>
  );
}
