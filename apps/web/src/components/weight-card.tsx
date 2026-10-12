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
import { localDate } from '@/lib/http';
import type { WeightPoint } from '@/components/weight-chart';

/** Fetched when a chart is first shown: the charting library is the heaviest thing the dashboard has. */
const WeightChart = dynamic(() => import('@/components/weight-chart').then((chart) => chart.WeightChart), {
  ssr: false,
  loading: () => <Skeleton className="h-[220px]" />,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-profile weight log with a 90-day trend, a 7-day moving average,
 * and the registered Profile.weightKg as a horizontal reference. Empty state
 * stays out of the operator's way; the chart only renders once the user
 * starts logging.
 */
export function WeightCard({ profile }: { profile: Profile }) {
  const t = useTranslations('weightCard');
  const fmt = useFormat();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [kg, setKg] = useState('');
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
      setKg('');
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
    const v = Number(kg.replace(',', '.'));
    if (!Number.isFinite(v) || v < 30 || v > 400) {
      setError(t('rangeError'));
      return;
    }
    log.mutate(v);
  }

  const points = buildSeries(entries.data ?? []);
  const hasData = points.length > 0;
  // Entries arrive newest-first (`recordedAt: desc`), so [0] is the last one
  // logged — what we want to peel back on click.
  const latest = entries.data?.[0] ?? null;
  const latestDate = latest ? fmt.dayOf(latest.recordedAt) : '';
  const latestKg = latest ? fmt.number(latest.kg, 1) : '';

  function onRemoveLatest(): void {
    if (!latest) return;
    if (!window.confirm(t('removeLatestConfirm', { kg: latestKg, date: latestDate }))) return;
    remove.mutate(latest.id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-2">
          <form onSubmit={submit} className="space-y-3">
            <Field label={t('formLabel')}>
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={30}
                max={400}
                value={kg}
                onChange={(e) => setKg(e.target.value)}
                placeholder={String(profile.weightKg)}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              {t('referenceHint', { kg: fmt.number(profile.weightKg, 1) })}
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={log.isPending || kg.trim() === ''}>
                {log.isPending ? t('logging') : t('log')}
              </Button>
              {latest && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRemoveLatest}
                  disabled={remove.isPending}
                  title={t('removeLatestLabel', { kg: latestKg, date: latestDate })}
                  className="text-muted-foreground"
                >
                  <Undo2 size={14} aria-hidden />
                  <span className="ml-1">{t('removeLatest')}</span>
                  <span className="ml-1 text-xs">
                    ({t('removeLatestLabel', { kg: latestKg, date: latestDate })})
                  </span>
                </Button>
              )}
            </div>
          </form>

          <div className="min-h-[200px]">
            {hasData ? (
              <WeightChart points={points} referenceKg={profile.weightKg} />
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

/**
 * Collapse entries to one row per day (keep the most recent log of the day)
 * and attach a 7-day trailing moving average. A day is the reader's own: an
 * entry made late in the evening belongs to that evening, not to the day it
 * already is in UTC. Returned series is sorted ascending by date so Recharts
 * draws left → right.
 */
const hundredths = (kg: number): number => Math.round(kg * 100) / 100;

function buildSeries(entries: WeightEntry[]): WeightPoint[] {
  if (entries.length === 0) return [];
  const byDate = new Map<string, WeightEntry>();
  for (const e of entries) {
    const d = localDate(new Date(e.recordedAt));
    const prev = byDate.get(d);
    if (!prev || prev.recordedAt < e.recordedAt) byDate.set(d, e);
  }
  const sorted = Array.from(byDate.values()).sort((a, b) =>
    a.recordedAt < b.recordedAt ? -1 : 1,
  );
  const out: WeightPoint[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const window = sorted.slice(Math.max(0, i - 6), i + 1);
    const ma7 = window.length >= 1 ? hundredths(window.reduce((s, w) => s + w.kg, 0) / window.length) : null;
    out.push({ date: localDate(new Date(sorted[i].recordedAt)), kg: hundredths(sorted[i].kg), ma7 });
  }
  return out;
}
