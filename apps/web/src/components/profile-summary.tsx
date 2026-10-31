// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Flame, Target, UtensilsCrossed, Wheat } from 'lucide-react';
import type { CalorieCalculation, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/stat-card';
import { TargetNotices } from '@/components/target-notices';
import { FavoriteSetsCard } from '@/components/favorite-sets-card';
import { PlanOverviewCard } from '@/components/plan-overview-card';
import { WeightCard } from '@/components/weight-card';
import { useFormat } from '@/lib/use-format';

/** Fetched when a ring is first shown: the charting library is the heaviest thing the dashboard has. */
const MacroChart = dynamic(
  () => import('@/components/macro-chart').then((chart) => chart.MacroChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-80" />,
  },
);

/**
 * Calorie target, deficit and macro split for a single profile. The dashboard
 * renders one of these per profile, so each owns its own calorie query.
 */
export function ProfileSummary({ profile }: { profile: Profile }) {
  const t = useTranslations('profileSummary');
  const fmt = useFormat();
  const calories = useQuery({
    queryKey: ['calories', profile.id],
    queryFn: () => api.get<CalorieCalculation>(`/profiles/${profile.id}/calories`),
  });

  const c = calories.data;

  const kcal = t('kcal');

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{profile.name}</h2>
        <Link
          href={`/meal-plans?profile=${profile.id}&new=1`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('generatePlan')}
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          index={0}
          icon={Target}
          label={t('dailyTarget')}
          value={c ? `${fmt.number(c.dailyTarget)} ${kcal}` : '—'}
          hint={c?.source === 'manual_override' ? t('manualHint') : t('calculatedHint')}
        />
        <StatCard
          index={1}
          icon={Flame}
          label={t('maintenance')}
          value={c ? `${fmt.number(c.maintenance)} ${kcal}` : '—'}
        />
        <StatCard
          index={2}
          icon={Wheat}
          label={c && c.dailyDeficit < 0 ? t('dailySurplus') : t('dailyDeficit')}
          value={c ? `${fmt.number(Math.abs(c.dailyDeficit))} ${kcal}` : '—'}
        />
        <StatCard
          index={3}
          icon={UtensilsCrossed}
          label={t('mealsPerDay')}
          value={String(profile.mealCount)}
        />
      </div>

      {c && <TargetNotices calories={c} />}

      <PlanOverviewCard profile={profile} />

      {/* The split a day aims at and the weights that were logged, beside each other where there is room for both. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('macroSplit')}</CardTitle>
          </CardHeader>
          <CardContent>
            {c ? (
              <MacroChart grams={c.targetMacros} kcal={c.dailyTarget} />
            ) : (
              <Skeleton className="h-80" />
            )}
          </CardContent>
        </Card>

        <WeightCard profile={profile} />
      </div>

      <FavoriteSetsCard profileId={profile.id} />
    </section>
  );
}
