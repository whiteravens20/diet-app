// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import type { WaterDay } from '@diet-app/shared';
import { useFormat } from '@/lib/use-format';

/** What a bar's label is handed: where the bar stands, and what it holds. */
interface BarTop {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  value?: number | string | boolean | null;
}

/**
 * The seven days up to the shown one: a bar of what each held, the shown day
 * darker, a dashed line across at the target and a green tick over each day
 * that reached it. A file of its own, so that the charting library is fetched
 * only when a chart is shown; the card says the same in words beside it.
 */
export function WaterDaysChart({
  days,
  target,
  shown,
  height,
}: {
  days: WaterDay['days'];
  target: number | null;
  shown: string;
  height: number;
}) {
  const fmt = useFormat();
  // Room over the highest bar and the target for a tick.
  const top = Math.max(target ?? 0, ...days.map((day) => day.ml), 500);
  return (
    <div aria-hidden>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={days}
          margin={{ top: 18, right: 4, bottom: 0, left: 4 }}
          accessibilityLayer={false}
        >
          <XAxis
            dataKey="day"
            interval={0}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickFormatter={(day: string) => fmt.dayShort(day)}
          />
          <YAxis hide domain={[0, top]} />
          {target !== null && (
            <ReferenceLine
              y={target}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 4"
              ifOverflow="extendDomain"
            />
          )}
          <Bar dataKey="ml" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {days.map((day) => (
              <Cell
                key={day.day}
                fill="var(--color-primary)"
                fillOpacity={day.day === shown ? 1 : 0.5}
              />
            ))}
            {target !== null && (
              <LabelList
                dataKey="ml"
                content={(bar: BarTop) => <Reached {...bar} target={target} />}
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A tick over a bar that reached the target, drawn as a path: a font need not have the sign. */
export function Reached({ x, y, width, value, target }: BarTop & { target: number }) {
  if (Number(value) < target) return null;
  const middle = Number(x) + Number(width) / 2;
  const over = Number(y) - 7;
  return (
    <path
      data-reached=""
      d={`M ${middle - 5} ${over - 4} l 3.5 3.5 l 6.5 -7`}
      fill="none"
      stroke="var(--color-success)"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}
