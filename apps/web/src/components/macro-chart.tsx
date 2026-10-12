// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const MACRO_COLORS = ['var(--color-primary)', 'var(--color-accent)', 'oklch(0.75 0.13 80)'];

/**
 * The split of a day's energy between protein, fat and carbohydrate, as a
 * ring. A file of its own, so that the charting library is fetched when a
 * ring is shown and is no part of the pages that show none (see
 * `profile-summary.tsx`).
 */
export function MacroChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95}>
          {data.map((_, i) => (
            <Cell key={i} fill={MACRO_COLORS[i]} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}
