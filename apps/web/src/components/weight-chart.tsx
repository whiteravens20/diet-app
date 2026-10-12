// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useFormat } from '@/lib/use-format';

export interface WeightPoint {
  /** ISO yyyy-mm-dd at midnight of the recordedAt day. */
  date: string;
  /** Raw entry (latest of the day, if duplicates). */
  kg: number;
  /** 7-day trailing moving average over the same series, anchored at this row. */
  ma7: number | null;
}

/** As high as the chart, so that the card does not jump when the chart arrives. */
export const WEIGHT_CHART_HEIGHT = 220;

/**
 * The weights of a profile over time: each entry, a moving average over
 * seven days, and the weight the profile was registered with as a line across.
 * A file of its own, so that the charting library is fetched when a chart is
 * shown and is no part of the pages that show none (see `weight-card.tsx`).
 */
export function WeightChart({ points, referenceKg }: { points: WeightPoint[]; referenceKg: number }) {
  const t = useTranslations('weightCard');
  const fmt = useFormat();
  return (
    <ResponsiveContainer width="100%" height={WEIGHT_CHART_HEIGHT}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} tickFormatter={(day: string) => fmt.dayShort(day)} />
        <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }} tickFormatter={(kg: number) => fmt.number(kg, 1)} width={32} />
        <Tooltip
          contentStyle={{
            background: 'var(--color-background)',
            border: '1px solid var(--color-border)',
            fontSize: 12,
          }}
          labelFormatter={(day) => (typeof day === 'string' ? fmt.date(day) : '')}
          formatter={(v, name) => [typeof v === 'number' ? fmt.unit(v, 'kilogram', 1) : '—', name === 'kg' ? t('seriesEntry') : t('seriesMa7')]}
        />
        <ReferenceLine
          y={referenceKg}
          stroke="var(--color-accent)"
          strokeDasharray="4 4"
          label={{
            value: t('referenceLabel'),
            position: 'insideTopRight',
            fontSize: 10,
            fill: 'var(--color-muted-foreground)',
          }}
        />
        <Line type="monotone" dataKey="kg" stroke="var(--color-muted-foreground)" strokeWidth={1} dot={{ r: 2 }} activeDot={{ r: 4 }} />
        <Line type="monotone" dataKey="ma7" stroke="var(--color-primary)" strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}
