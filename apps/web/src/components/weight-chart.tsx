// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
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
import type { WeightUnit } from '@diet-app/shared';
import { useFormat } from '@/lib/use-format';
import type { WeightDay } from '@diet-app/shared';

/** As high as the chart, so that the card does not jump when the chart arrives. */
export const WEIGHT_CHART_HEIGHT = 220;

/**
 * The range of the weight axis for `values`, the weights and the target: room
 * above and below them, whole units at both ends, as the phone's chart has it,
 * so that a steady weight is not drawn along an edge and the target always
 * lies inside.
 */
export function weightAxis(values: readonly number[]): [number, number] {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const room = Math.max((high - low) * 0.1, 0.5);
  return [Math.floor(low - room), Math.ceil(high + room)];
}

/**
 * The weights of a profile over time, in the unit its account reads them in:
 * each entry, the mean of the seven days that end with it, and a line across
 * at the weight the profile is working towards, where it names one. A file of
 * its own, so that the charting library is fetched when a chart is shown and
 * is no part of the pages that show none (see `weight-card.tsx`).
 */
export function WeightChart({
  points,
  target,
  unit,
}: {
  points: WeightDay[];
  target: { value: number; label: string } | null;
  unit: WeightUnit;
}) {
  const t = useTranslations('weightCard');
  const fmt = useFormat();
  const domain = weightAxis([
    ...points.flatMap((point) => [point.kg, point.mean]),
    ...(target ? [target.value] : []),
  ]);
  return (
    <ResponsiveContainer width="100%" height={WEIGHT_CHART_HEIGHT}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          tickFormatter={(day: string) => fmt.dayShort(day)}
        />
        <YAxis
          domain={domain}
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          tickFormatter={(kg: number) => fmt.number(kg, 1)}
          width={32}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--color-background)',
            border: '1px solid var(--color-border)',
            fontSize: 12,
          }}
          labelFormatter={(day) => (typeof day === 'string' ? fmt.date(day) : '')}
          formatter={(v, name) => [
            typeof v === 'number' ? fmt.unit(v, unit === 'lb' ? 'pound' : 'kilogram', 1) : '—',
            name === 'kg' ? t('seriesEntry') : t('seriesMa7'),
          ]}
        />
        {target && (
          <ReferenceLine
            y={target.value}
            stroke="var(--color-accent)"
            strokeDasharray="4 4"
            label={{
              value: target.label,
              position: 'insideTopRight',
              fontSize: 10,
              fill: 'var(--color-muted-foreground)',
            }}
          />
        )}
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
          dataKey="mean"
          stroke="var(--color-primary)"
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
