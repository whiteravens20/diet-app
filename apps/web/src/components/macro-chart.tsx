// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, type PieLabelRenderProps } from 'recharts';
import type { Macros } from '@diet-app/shared';
import { energySplit, type EnergyPart } from '@/lib/energy-split';
import { useFormat } from '@/lib/use-format';

const MACRO_COLORS: Record<EnergyPart['key'], string> = {
  protein: 'var(--color-primary)',
  fat: 'var(--color-accent)',
  carbs: 'oklch(0.75 0.13 80)',
};

/** The narrowest ring that has room for a label beside it on either side; a narrower one leaves it to the legend. */
const LABELS_FROM_WIDTH = 400;

const RADIAN = Math.PI / 180;

/**
 * The split of a day's energy between protein, fat and carbohydrate, as a
 * ring with the day's calories in its middle. Once the ring is drawn a label
 * floats out beside each part, where there is room for it, and a legend under
 * the ring gives each part's grams and share. A file of its own, so that the
 * charting library is fetched when a ring is shown and is no part of the
 * pages that show none (see `profile-summary.tsx`).
 */
export function MacroChart({ grams, kcal }: { grams: Macros; kcal: number }) {
  const t = useTranslations('profileSummary');
  const fmt = useFormat();
  const [wide, setWide] = useState(false);
  const parts = (energySplit(grams) ?? []).map((part) => ({ ...part, name: t(part.key), share: fmt.percent(part.percent / 100), color: MACRO_COLORS[part.key] }));

  return (
    <div className="space-y-3">
      {/* The ring says nothing the legend does not: the legend is what is read out, and the ring takes no focus either. */}
      <div className="relative h-64" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%" onResize={(width) => setWide(width >= LABELS_FROM_WIDTH)}>
          <PieChart accessibilityLayer={false}>
            <Pie
              data={parts}
              dataKey="kcal"
              nameKey="name"
              innerRadius={58}
              outerRadius={84}
              paddingAngle={parts.length > 1 ? 2 : 0}
              stroke="none"
              rootTabIndex={-1}
              animationDuration={700}
              label={wide ? FloatingLabel : false}
              labelLine={false}
            >
              {parts.map((part) => (
                <Cell key={part.key} fill={part.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums">{fmt.number(kcal)}</span>
          <span className="text-xs text-muted-foreground">{t('kcal')}</span>
        </div>
      </div>
      <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
        {parts.map((part) => (
          <li key={part.key} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: part.color }} aria-hidden="true" />
            <span className="font-medium tabular-nums">{fmt.unit(part.grams, 'gram')}</span>
            <span className="text-muted-foreground">
              {part.name} · {part.share}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The label of a part, beside the ring: a short line out of the part, its
 * share of the energy and its name. It floats in after the ring is drawn, one
 * part after another.
 */
function FloatingLabel(props: PieLabelRenderProps) {
  const { cx, cy, midAngle, outerRadius, x, y, textAnchor, index, payload } = props as PieLabelRenderProps & {
    cx: number;
    cy: number;
    midAngle: number;
    outerRadius: number;
    payload: { share: string; name: string; color: string };
  };
  const cos = Math.cos(-midAngle * RADIAN);
  const sin = Math.sin(-midAngle * RADIAN);
  const from = { x: cx + (outerRadius + 3) * cos, y: cy + (outerRadius + 3) * sin };
  // The text keeps a little away from where the line ends.
  const textX = x + (textAnchor === 'start' ? 4 : textAnchor === 'end' ? -4 : 0);
  return (
    <g className="float-in" style={{ animationDelay: `${index * 90}ms` }}>
      <path d={`M${from.x},${from.y}L${x},${y}`} stroke={payload.color} strokeWidth={1.5} fill="none" />
      <circle cx={x} cy={y} r={2} fill={payload.color} />
      <text x={textX} y={y} textAnchor={textAnchor} className="fill-foreground text-sm font-semibold tabular-nums">
        {payload.share}
        <tspan x={textX} dy="1.15em" className="fill-muted-foreground text-xs font-normal">
          {payload.name}
        </tspan>
      </text>
    </g>
  );
}
