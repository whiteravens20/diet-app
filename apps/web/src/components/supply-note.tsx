// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { DietType } from '@diet-app/shared';
import { supplyOf } from '@/lib/catalogue';
import { useConfig } from '@/lib/use-config';
import { cn } from '@/lib/utils';

/**
 * A warning when the catalogue has no recipe, or too few, for one of the meals
 * of a diet at a number of meals a day. Nothing when it has enough or has not
 * answered yet. It speaks of the catalogue only: a recipe the user made for
 * themselves can fill a gap, and the planner counts it.
 */
export function SupplyNote({
  diet,
  mealCount,
  className,
}: {
  diet: DietType;
  mealCount: number;
  className?: string;
}) {
  const t = useTranslations('catalogue');
  const tDiet = useTranslations('enums.dietType');
  const found = supplyOf(useConfig().data?.catalogue.supply, diet, mealCount);
  if (!found || found.level === 'enough') return null;
  return (
    <p role="status" className={cn('text-xs text-warning', className)}>
      {found.level === 'none'
        ? t('none', {
            diet: tDiet(diet),
            count: mealCount,
            advice: found.fewerMeals ? 'fewer' : 'diet',
            fewer: found.fewerMeals ?? 0,
          })
        : t('thin', { diet: tDiet(diet), count: mealCount, recipes: found.recipes })}
    </p>
  );
}
