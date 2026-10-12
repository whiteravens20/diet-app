// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import type { Profile, WeightEntry } from '@diet-app/shared';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/use-format';
import { weightSeries } from '@/lib/weight-series';
import { boundsIn, shownToOne, shownWeight, toKilograms, useWeightUnit } from '@/lib/weight-unit';

/** Fetched when a chart is first shown: the charting library is the heaviest thing the dashboard has. */
const WeightChart = dynamic(() => import('@/components/weight-chart').then((chart) => chart.WeightChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px]" />,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The weights a profile logged: ninety days of them as a chart, with the mean
 * of each seven days and a line at the weight the profile is working towards
 * (at the weight it registered with while it has named none). Everything is
 * shown and typed in the unit of the account, kilograms or pounds; the API
 * keeps kilograms. The chart is drawn once there is something to draw.
 */
export function WeightCard({ profile }: { profile: Profile }) {
  const t = useTranslations('weightCard');
  const fmt = useFormat();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const unit = useWeightUnit();
  const bounds = boundsIn(unit);
  const inUnit = (value: number): string => fmt.unit(value, unit === 'lb' ? 'pound' : 'kilogram', 1);
  // What is typed, in the unit of the account.
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  const entries = useQuery({
    queryKey: ['weights', profile.id],
    queryFn: () => {
      const since = new Date(Date.now() - 90 * DAY_MS).toISOString();
      return api.get<WeightEntry[]>(
        `/weights?profileId=${profile.id}&since=${encodeURIComponent(since)}`,
      );
    },
  });

  const log = useMutation({
    mutationFn: (v: number) =>
      api.post<WeightEntry>('/weights', { profileId: profile.id, kg: v }),
    onSuccess: () => {
      setTyped('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['weights', profile.id] });
    },
    onError: (e) => setError(errorText(e, t('logFailed'))),
  });

  // Delete the latest logged entry. Repeated clicks peel back successive
  // entries — the list refetches after each delete, so the button targets
  // whatever the newest remaining row is.
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/weights/${id}`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['weights', profile.id] });
    },
    onError: (e) => setError(errorText(e, t('removeFailed'))),
  });

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const v = Number(typed.replace(',', '.'));
    if (!Number.isFinite(v) || v < bounds.min || v > bounds.max) {
      setError(t('rangeError', { min: inUnit(bounds.min), max: inUnit(bounds.max) }));
      return;
    }
    log.mutate(toKilograms(v, unit));
  }

  const points = weightSeries(entries.data ?? []).map((point) => ({ ...point, kg: shownWeight(point.kg, unit), ma7: shownWeight(point.ma7, unit) }));
  const hasData = points.length > 0;
  // The line across the chart: where the profile wants to be, or where it began.
  const reference =
    profile.targetWeightKg !== null
      ? { value: shownWeight(profile.targetWeightKg, unit), label: t('targetLabel') }
      : { value: shownWeight(profile.weightKg, unit), label: t('referenceLabel') };
  // Entries arrive newest-first (`recordedAt: desc`), so [0] is the last one
  // logged — what we want to peel back on click.
  const latest = entries.data?.[0] ?? null;
  const latestDate = latest ? fmt.dayOf(latest.recordedAt) : '';
  const latestWeight = latest ? inUnit(shownWeight(latest.kg, unit)) : '';

  function onRemoveLatest(): void {
    if (!latest) return;
    if (!window.confirm(t('removeLatestConfirm', { weight: latestWeight, date: latestDate }))) return;
    remove.mutate(latest.id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <form onSubmit={submit} className="space-y-3">
            <Field label={t('formLabel', { unit })}>
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={bounds.min}
                max={bounds.max}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={String(shownToOne(profile.weightKg, unit))}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              {profile.targetWeightKg !== null
                ? t('targetHint', { registered: inUnit(shownWeight(profile.weightKg, unit)), target: inUnit(shownWeight(profile.targetWeightKg, unit)) })
                : t('referenceHint', { registered: inUnit(shownWeight(profile.weightKg, unit)) })}
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={log.isPending || typed.trim() === ''}>
                {log.isPending ? t('logging') : t('log')}
              </Button>
              {latest && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRemoveLatest}
                  disabled={remove.isPending}
                  title={t('removeLatestLabel', { weight: latestWeight, date: latestDate })}
                  className="text-muted-foreground"
                >
                  <Undo2 size={14} aria-hidden />
                  <span className="ml-1">{t('removeLatest')}</span>
                  <span className="ml-1 text-xs">
                    ({t('removeLatestLabel', { weight: latestWeight, date: latestDate })})
                  </span>
                </Button>
              )}
            </div>
          </form>

          <div className="min-h-[200px]">
            {hasData ? (
              <WeightChart points={points} reference={reference} unit={unit} />
            ) : (
              <div className="flex h-full min-h-[200px] items-center justify-center rounded-md border border-dashed border-border text-center text-sm text-muted-foreground">
                {t('emptyState')}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
