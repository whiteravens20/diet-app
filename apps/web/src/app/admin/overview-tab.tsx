// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminHealth, AdminOverview, AdminStats } from '@/lib/admin-api';
import { useFormat } from '@/lib/use-format';
import type { Kind } from './curation/shared';
import { mirrorNeedsAttention } from './instance-files-card';
import { InstanceHealthCard } from './instance-health-card';

/** Where a line of what waits leads: a part of the panel, and in the queue a kind of draft. */
export type OverviewTarget = { tab: 'queue'; kind: Kind } | { tab: 'catalogue' };

/** What the instance holds, what waits for the administrator, each line leading to where it is done, and how the instance stands. */
export function OverviewTab({
  stats,
  overview,
  retired,
  health,
  healthFailed,
  onRefresh,
  onGo,
}: {
  stats: AdminStats;
  overview: AdminOverview | null;
  retired: number;
  /** Null until it is read. */
  health: AdminHealth | null;
  healthFailed: boolean;
  onRefresh: () => void;
  onGo: (target: OverviewTarget) => void;
}) {
  const t = useTranslations('admin');
  const tOverview = useTranslations('admin.overview');
  const names: OverviewTarget = { tab: 'queue', kind: 'ingredient-names' };
  const recipes: OverviewTarget = { tab: 'queue', kind: 'recipes' };
  const catalogue: OverviewTarget = { tab: 'catalogue' };

  const lines: { key: string; text: string; target: OverviewTarget }[] = [];
  const add = (key: string, count: number, target: OverviewTarget): void => {
    if (count > 0) lines.push({ key, text: tOverview(key, { count }), target });
  };
  if (overview) {
    add('namesPending', overview.names.pending, names);
    add('namesRejected', overview.names.rejected, names);
    add('namesMissing', overview.names.missing, names);
    add('namesApproved', overview.names.approved, names);
    add('recipesPending', overview.recipes.pending, recipes);
    add('recipesApproved', overview.recipes.approved, recipes);
  }
  if (stats.seed.updateAvailable) {
    lines.push({
      key: 'updateAvailable',
      text: tOverview('updateAvailable'),
      target: catalogue,
    });
  }
  add('retired', retired, catalogue);
  if (mirrorNeedsAttention(overview?.mirror)) {
    lines.push({ key: 'mirrorProblem', text: tOverview('mirrorProblem'), target: catalogue });
  }

  return (
    <>
      <section className="grid grid-cols-3 gap-2 sm:gap-4">
        <StatCard label={t('ingredients')} value={stats.counts.ingredients} />
        <StatCard label={t('recipes')} value={stats.counts.recipes} />
        <StatCard label={t('substitutions')} value={stats.counts.substitutions} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>{tOverview('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {overview === null ? (
            <Skeleton className="h-16" aria-label={t('loading')} role="status" />
          ) : lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tOverview('nothing')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((line) => (
                <li key={line.key}>
                  <button
                    type="button"
                    onClick={() => onGo(line.target)}
                    className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left text-sm hover:underline"
                  >
                    <span>{line.text}</span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      {t(`tabs.${line.target.tab}`)}
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <InstanceHealthCard
        health={health}
        failed={healthFailed}
        mirror={overview?.mirror ?? null}
        onRefresh={onRefresh}
        onToCatalogue={() => onGo(catalogue)}
      />
    </>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  const fmt = useFormat();
  return (
    <Card>
      <CardContent className="p-3 sm:p-5">
        <p className="text-2xs uppercase tracking-wide text-muted-foreground sm:text-xs">{label}</p>
        <p className="mt-1 text-xl font-semibold tabular-nums sm:text-3xl">{fmt.number(value)}</p>
      </CardContent>
    </Card>
  );
}
