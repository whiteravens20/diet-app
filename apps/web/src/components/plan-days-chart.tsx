// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PlanOverview } from '@diet-app/shared';
import { useFormat } from '@/lib/use-format';

/** As high as the chart, so that the card does not jump when the chart arrives. */
export const PLAN_DAYS_CHART_HEIGHT = 200;

/**
 * The days of a plan side by side: what each holds as a bar, and what each
 * aims at as a line across them. A file of its own, so that the charting
 * library is fetched when the chart is shown (see `plan-overview-card.tsx`).
 * The same numbers stand beside it as a table for whoever does not see it.
 */
export function PlanDaysChart({ days }: { days: PlanOverview['days'] }) {
  const t = useTranslations('planOverview');
  const fmt = useFormat();
  // A day that is skipped holds nothing and aims at nothing: it shows as a gap.
  const points = days.map((day) => ({
    date: day.date,
    planned: day.skipped ? null : day.calories,
    target: day.skipped ? null : day.target,
  }));
  return (
    <ResponsiveContainer width="100%" height={PLAN_DAYS_CHART_HEIGHT}>
      {/* The chart takes no focus: it is hidden from whoever does not see it, who has the table beside it. */}
      <ComposedChart
        data={points}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        accessibilityLayer={false}
      >
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          tickFormatter={(day: string) => fmt.dayShort(day)}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          tickFormatter={(kcal: number) => fmt.number(kcal)}
          width={44}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--color-background)',
            border: '1px solid var(--color-border)',
            fontSize: 12,
          }}
          labelFormatter={(day) => (typeof day === 'string' ? fmt.day(day) : '')}
          formatter={(value, name) => [
            typeof value === 'number' ? `${fmt.number(value)} kcal` : '—',
            name === 'planned' ? t('seriesPlanned') : t('seriesTarget'),
          ]}
        />
        <Bar dataKey="planned" fill="var(--color-primary)" radius={[3, 3, 0, 0]} maxBarSize={36} />
        <Line
          type="stepAfter"
          dataKey="target"
          stroke="var(--color-muted-foreground)"
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={false}
          connectNulls={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
