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
import { FavoriteSetsCard } from '@/components/favorite-sets-card';
import { PlanOverviewCard } from '@/components/plan-overview-card';
import { WeightCard } from '@/components/weight-card';
import { useFormat } from '@/lib/use-format';

/** Fetched when a ring is first shown: the charting library is the heaviest thing the dashboard has. */
const MacroChart = dynamic(() => import('@/components/macro-chart').then((chart) => chart.MacroChart), {
  ssr: false,
  loading: () => <Skeleton className="h-64" />,
});

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
  const macroData = c
    ? [
        { name: t('protein'), value: c.targetMacros.protein },
        { name: t('fat'), value: c.targetMacros.fat },
        { name: t('carbs'), value: c.targetMacros.carbs },
      ]
    : [];

  const kcal = t('kcal');

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{profile.name}</h2>
        <Link
          href={`/meal-plans?profile=${profile.id}`}
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

      <Card>
        <CardHeader>
          <CardTitle>{t('macroSplit')}</CardTitle>
        </CardHeader>
        <CardContent>
          {macroData.length > 0 ? (
            <div className="h-64">
              <MacroChart data={macroData} />
            </div>
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>

      <WeightCard profile={profile} />

      <FavoriteSetsCard profileId={profile.id} />
    </section>
  );
}

/**
 * What stands behind a calorie target that is not simply maintenance less the
 * chosen pace: a goal that is held, a pace that was slowed, a floor, and the
 * warnings for somebody under 18 or underweight.
 */
export function TargetNotices({ calories: c }: { calories: CalorieCalculation }) {
  const t = useTranslations('profileSummary.notices');
  const notices: { key: string; text: string; strong: boolean }[] = [];
  const say = (key: string, strong = false) =>
    notices.push({ key, strong, text: t(key, { floor: c.safetyFloor, requested: c.requestedDeficit, deficit: c.dailyDeficit, bmr: c.bmr, maintenance: c.maintenance }) });

  if (c.goalHeld) say('goalHeld', true);
  for (const warning of c.warnings) if (warning === 'minor' || warning === 'underweight') say(warning, true);
  if (c.maintenanceUnderFloor) say('maintenanceUnderFloor');
  if (c.safetyFloorApplied) say('safetyFloorApplied');
  // Under the floor the pace is not what set the target: the floor did.
  if (c.deficitCapped && !c.safetyFloorApplied && !c.maintenanceUnderFloor && !c.goalHeld) say('deficitCapped');
  if (c.warnings.includes('below_floor')) say('below_floor', true);
  if (c.warnings.includes('below_bmr') && c.source === 'manual_override') say('below_bmr');
  if (notices.length === 0) return null;
  return (
    <ul className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
      {notices.map((notice) => (
        <li key={notice.key} className={notice.strong ? 'font-medium' : 'text-muted-foreground'}>
          {notice.text}
        </li>
      ))}
    </ul>
  );
}
