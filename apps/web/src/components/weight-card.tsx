'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Profile, WeightEntry } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

interface ChartPoint {
  /** ISO yyyy-mm-dd at midnight of the recordedAt day. */
  date: string;
  /** Raw entry (latest of the day, if duplicates). */
  kg: number;
  /** 7-day trailing moving average over the same series, anchored at this row. */
  ma7: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * F19 — per-profile weight log with a 90-day trend, a 7-day moving average,
 * and the registered Profile.weightKg as a horizontal reference. Empty state
 * stays out of the operator's way; the chart only renders once the user
 * starts logging.
 */
export function WeightCard({ profile }: { profile: Profile }) {
  const t = useTranslations('weightCard');
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
    onError: (e) => setError(e instanceof ApiClientError ? e.message : t('logFailed')),
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
              {t('referenceHint', { kg: profile.weightKg })}
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" size="sm" disabled={log.isPending || kg.trim() === ''}>
              {log.isPending ? t('logging') : t('log')}
            </Button>
          </form>

          <div className="min-h-[200px]">
            {hasData ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                    tickFormatter={(d) => d.slice(5)}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                    width={32}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--color-background)',
                      border: '1px solid var(--color-border)',
                      fontSize: 12,
                    }}
                    formatter={(v, name) => [
                      typeof v === 'number' ? `${v.toFixed(1)} kg` : '—',
                      name === 'kg' ? t('seriesEntry') : t('seriesMa7'),
                    ]}
                  />
                  <ReferenceLine
                    y={profile.weightKg}
                    stroke="var(--color-accent)"
                    strokeDasharray="4 4"
                    label={{
                      value: t('referenceLabel'),
                      position: 'insideTopRight',
                      fontSize: 10,
                      fill: 'var(--color-muted-foreground)',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="kg"
                    stroke="var(--color-muted-foreground)"
                    strokeWidth={1}
                    dot={{ r: 2 }}
                    activeDot={{ r: 4 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="ma7"
                    stroke="var(--color-primary)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
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
 * Collapse entries to one row per ISO date (keep the most recent log of the
 * day) and attach a 7-day trailing moving average. Returned series is sorted
 * ascending by date so Recharts draws left → right.
 */
function buildSeries(entries: WeightEntry[]): ChartPoint[] {
  if (entries.length === 0) return [];
  const byDate = new Map<string, WeightEntry>();
  for (const e of entries) {
    const d = e.recordedAt.slice(0, 10);
    const prev = byDate.get(d);
    if (!prev || prev.recordedAt < e.recordedAt) byDate.set(d, e);
  }
  const sorted = Array.from(byDate.values()).sort((a, b) =>
    a.recordedAt < b.recordedAt ? -1 : 1,
  );
  const out: ChartPoint[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const window = sorted.slice(Math.max(0, i - 6), i + 1);
    const ma7 =
      window.length >= 1
        ? Number(
            (window.reduce((s, w) => s + w.kg, 0) / window.length).toFixed(2),
          )
        : null;
    out.push({
      date: sorted[i].recordedAt.slice(0, 10),
      kg: Number(sorted[i].kg.toFixed(2)),
      ma7,
    });
  }
  return out;
}
