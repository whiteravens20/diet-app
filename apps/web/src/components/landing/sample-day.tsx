// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { DOT } from '@/lib/figure-line';

/**
 * A day as the planner made it from the base catalogue: a balanced diet of 2000 kcal in four meals, each meal sized
 * as the application sizes it, the figures as the engine worked them out (2026-11-22). The page says it is an
 * example; the recipes' names are in the messages, in every language.
 */
const DAY = {
  target: 2000,
  meals: [
    { slot: 'breakfast', key: 'milletBowl', kcal: 537 },
    { slot: 'lunch', key: 'salmonQuinoa', kcal: 753 },
    { slot: 'dinner', key: 'lentilSoup', kcal: 555 },
    { slot: 'snack', key: 'edamameCakes', kcal: 152 },
  ],
  protein: 114,
  fat: 70,
  carbs: 235,
} as const;

/** The product itself on the landing page: an example day of a plan with its figures, drawn on the server. */
export function SampleDay() {
  const t = useTranslations('landing.sample');
  const tMeal = useTranslations('enums.mealType');
  const eaten = DAY.meals.reduce((sum, meal) => sum + meal.kcal, 0);
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium">{t('label')}</p>
        <p className="text-sm text-muted-foreground">{t('diet')}</p>
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">
        {t('sum', { eaten, target: DAY.target })}
      </p>
      <div className="mt-2 h-2 rounded-full bg-muted">
        <div
          className="h-2 rounded-full bg-primary"
          style={{ width: `${Math.min(100, (eaten / DAY.target) * 100)}%` }}
        />
      </div>
      <ul className="mt-4 divide-y divide-border">
        {DAY.meals.map((meal) => (
          <li key={meal.slot} className="flex items-baseline justify-between gap-4 py-2.5">
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground">{tMeal(meal.slot)}</span>
              <span className="block text-sm font-medium">{t(`meals.${meal.key}`)}</span>
            </span>
            <span className="shrink-0 text-sm tabular-nums">{t('kcal', { kcal: meal.kcal })}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted-foreground">
        {[
          t('protein', { grams: DAY.protein }),
          t('fat', { grams: DAY.fat }),
          t('carbs', { grams: DAY.carbs }),
        ].join(DOT)}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">{t('note')}</p>
    </Card>
  );
}
