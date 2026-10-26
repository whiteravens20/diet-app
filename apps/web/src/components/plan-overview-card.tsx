// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { PlanOverview, PlanOverviewAnswer, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { planDates } from '@/lib/plan-dates';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Fetched when the chart is first shown: the charting library is the heaviest thing the dashboard has. */
const PlanDaysChart = dynamic(
  () => import('@/components/plan-days-chart').then((chart) => chart.PlanDaysChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[200px]" />,
  },
);

const MACROS = ['protein', 'fat', 'carbs'] as const;

/**
 * What the plan a profile is living by comes to: what a day of it holds
 * against what it aims at, how much of what was due is eaten, how much of it
 * fits the diet and is made of favourites, how far the shopping is, and its
 * days side by side. Read-only: every figure is the API's.
 */
export function PlanOverviewCard({ profile }: { profile: Profile }) {
  const t = useTranslations('planOverview');
  const tDiet = useTranslations('enums.dietType');
  const tMacro = useTranslations('macrosLine');
  const errorText = useErrorText();
  const fmt = useFormat();
  const answer = useQuery({
    queryKey: ['plan-overview', profile.id],
    queryFn: () => api.get<PlanOverviewAnswer>(`/meal-plans/overview?profileId=${profile.id}`),
  });
  const plans = `/meal-plans?profile=${profile.id}`;

  if (answer.isLoading) return <Skeleton className="h-48" />;
  if (answer.isError) {
    return (
      <Card>
        <CardContent className="py-6">
          <p role="alert" className="text-sm text-destructive">
            {errorText(answer.error, t('failed'))}
          </p>
        </CardContent>
      </Card>
    );
  }
  const overview = answer.data?.overview ?? null;
  if (!overview) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('none')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('noneBody')}</p>
          <Link href={plans} className={buttonVariants({ size: 'sm' })}>
            {t('noneCta')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { plan, energy, eaten, onDiet, favourites, shopping } = overview;
  const days = planDates(plan.startDate, plan.durationDays);
  const share = (part: PlanOverview['eaten']): string =>
    fmt.percent(part.of === 0 ? 0 : part.meals / part.of);
  const figures: { label: string; value: string; hint: string }[] = [
    {
      label: t('energy'),
      value: t('energyValue', { planned: energy.planned }),
      hint: t('energyHint', { target: energy.target }),
    },
    // Nothing was due before the first day of a plan: there is no share to name yet.
    {
      label: t('eaten'),
      value: eaten.of === 0 ? t('eatenNotYet') : share(eaten),
      hint: eaten.of === 0 ? t('eatenNotYetHint') : t('eatenHint', eaten),
    },
    {
      label: t('onDiet'),
      value: share(onDiet),
      hint: t('onDietHint', { ...onDiet, diet: tDiet(plan.dietType) }),
    },
    { label: t('favourites'), value: share(favourites), hint: t('favouritesHint', favourites) },
    { label: t('reuse'), value: fmt.percent(overview.ingredientReuse), hint: t('reuseHint') },
    {
      label: t('shopping'),
      value:
        shopping.lists === 0
          ? t('shoppingNone')
          : fmt.percent(shopping.entries === 0 ? 0 : shopping.ticked / shopping.entries),
      hint:
        shopping.lists === 0
          ? t('shoppingNoneHint')
          : t('shoppingHint', { ticked: shopping.ticked, entries: shopping.entries }),
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <CardTitle>{t(`title.${plan.status}`)}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('span', {
              dates: fmt.dates(days[0] ?? plan.startDate, days.at(-1) ?? plan.startDate),
              diet: tDiet(plan.dietType),
            })}
          </p>
        </div>
        <Link href={plans} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {t('open')}
        </Link>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {figures.map((figure) => (
            <div key={figure.label} className="rounded-lg border border-border p-4">
              <dt className="text-sm text-muted-foreground">{figure.label}</dt>
              <dd>
                <span className="mt-1 block text-2xl font-semibold tracking-tight">
                  {figure.value}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{figure.hint}</span>
              </dd>
            </div>
          ))}
        </dl>

        <div className="space-y-2">
          <h4 className="text-sm font-medium">{t('macros')}</h4>
          <ul className="space-y-2">
            {MACROS.map((macro) => {
              const planned = overview.macros.planned[macro];
              const target = overview.macros.target[macro];
              return (
                <li key={macro} className="text-sm">
                  <div className="flex flex-wrap justify-between gap-x-3">
                    <span>{tMacro(macro)}</span>
                    <span className="text-muted-foreground">
                      {t('macroValue', { planned, target })}
                    </span>
                  </div>
                  {/* The bar is full at the target; what the plan holds beyond it does not make it longer. */}
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${target === 0 ? 0 : Math.min(100, Math.round((planned / target) * 100))}%`,
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-medium">{t('days')}</h4>
          <div aria-hidden>
            <PlanDaysChart days={overview.days} />
          </div>
          {/* The same days in words and numbers, for whoever does not see the chart. */}
          <table className="sr-only">
            <caption>{t('days')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('day')}</th>
                <th scope="col">{t('seriesPlanned')}</th>
                <th scope="col">{t('seriesTarget')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.days.map((day) => (
                <tr key={day.date}>
                  <th scope="row">{fmt.day(day.date)}</th>
                  <td>{day.skipped ? t('daySkipped') : t('kcal', { kcal: day.calories })}</td>
                  <td>{day.skipped ? '' : t('kcal', { kcal: day.target })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
