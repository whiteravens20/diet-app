// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import type { CalorieCalculation, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TargetNotices } from '@/components/target-notices';
import { FavoriteSetsCard } from '@/components/favorite-sets-card';
import { PlanOverviewCard } from '@/components/plan-overview-card';
import { ExpenditureCard } from '@/components/expenditure-card';
import { KeepWeightCard } from '@/components/keep-weight-card';
import { WaterCard } from '@/components/water-card';
import { TodayCard } from '@/components/today-card';
import { WeekSummaryCard } from '@/components/week-summary';
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
 * A profile's dashboard, in the order of what is done daily: the day with what its target comes from in a line under
 * what was eaten, the offers that stand on the target, the plan, water and weight; the seven days, the macro split
 * and favourite sets folded under one line, drawn only once it is opened (the chart's library is the heaviest thing
 * here).
 */
export function ProfileSummary({ profile }: { profile: Profile }) {
  const t = useTranslations('profileSummary');
  const calories = useQuery({
    queryKey: ['calories', profile.id],
    queryFn: () => api.get<CalorieCalculation>(`/profiles/${profile.id}/calories`),
  });

  const c = calories.data;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-lg font-semibold tracking-tight">{profile.name}</h2>
        <Link
          href={`/meal-plans?profile=${profile.id}&new=1`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('generatePlan')}
        </Link>
      </div>

      {/* What the day holds so far, first: the dashboard is where a day is opened, as on the phone. */}
      <TodayCard profile={profile}>
        {c ? <TargetLine calories={c} meals={profile.mealCount} /> : <Skeleton className="h-5" />}
      </TodayCard>

      {c && <TargetNotices calories={c} />}

      <KeepWeightCard profile={profile} />

      <ExpenditureCard profile={profile} />

      <PlanOverviewCard profile={profile} />

      {profile.waterTracking && <WaterCard profile={profile} />}

      <WeightCard profile={profile} />

      <More>
        <WeekSummaryCard profile={profile} />
        <Card>
          <CardHeader>
            <CardTitle>{t('macroSplit')}</CardTitle>
          </CardHeader>
          <CardContent>
            {c ? (
              <>
                <MacroChart grams={c.targetMacros} kcal={c.dailyTarget} />
                {c.customSplitHeld && (
                  <p className="mt-3 text-sm text-warning">{t('customSplitHeld')}</p>
                )}
              </>
            ) : (
              <Skeleton className="h-80" />
            )}
          </CardContent>
        </Card>
        <FavoriteSetsCard profileId={profile.id} />
      </More>
    </section>
  );
}

/**
 * What the profile's target comes from, in one line under the day's figure: the expenditure, the deficit or surplus
 * taken from it and the meals a day. The target itself stands once, as the day's figure (a plan's day rounds it to
 * tens, so the two would differ beside each other); a target set by hand says so first.
 */
export function TargetLine({ calories, meals }: { calories: CalorieCalculation; meals: number }) {
  const t = useTranslations('profileSummary');
  const fmt = useFormat();
  return (
    <p className="text-sm text-muted-foreground">
      {t('figures', {
        source: calories.source === 'manual_override' ? 'manual' : 'calculated',
        maintenance: fmt.number(calories.maintenance),
        kind: calories.dailyDeficit < 0 ? 'surplus' : 'deficit',
        amount: fmt.number(Math.abs(calories.dailyDeficit)),
        meals,
      })}
    </p>
  );
}

/** What is looked at now and then, folded: drawn only once it is opened, so that it loads nothing before. */
function More({ children }: { children: ReactNode }) {
  const t = useTranslations('profileSummary');
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-2 text-sm font-medium">{t('more')}</summary>
      {open && <div className="mt-2 space-y-4">{children}</div>}
    </details>
  );
}
