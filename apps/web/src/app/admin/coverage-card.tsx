// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { DietType, MEAL_SLOTS_BY_COUNT, VARIETY_DEPTH } from '@diet-app/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AdminStats, MacroShares } from '@/lib/admin-api';
import { cn } from '@/lib/utils';

/** The meals in the order of a day. */
const MEALS = MEAL_SLOTS_BY_COUNT[5]!;

/** Protein, fat and carbohydrate as whole percentages of a day's energy. */
const shares = (of: MacroShares) => [of.protein, of.fat, of.carbs].map((share) => Math.round(share * 100)).join(' / ');

/**
 * How many recipes each diet has for each meal, where the empty cells and the
 * thin ones stand out; and what the plans of each diet hold of protein, fat
 * and carbohydrate against what the diet aims at.
 */
export function CoverageCard({ coverage, target, macros }: { coverage: AdminStats['coverage']; target: number; macros: AdminStats['macros'] }) {
  const t = useTranslations('admin.coverage');
  // A diet that takes any recipe has no pair of its own to fill.
  const pairs = DietType.options.filter((diet) => diet !== 'custom').flatMap((diet) => MEALS.map((meal) => coverage[diet][meal]));
  const below = pairs.filter((recipes) => recipes < target).length;
  const tDiet = useTranslations('enums.dietType');
  const tMeal = useTranslations('enums.mealType');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('explain', { enough: VARIETY_DEPTH })}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t('title')}>
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                  {t('diet')}
                </th>
                {MEALS.map((meal) => (
                  <th key={meal} scope="col" className="px-2 py-1.5 text-right font-medium">
                    {tMeal(meal)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DietType.options.map((diet) => (
                <tr key={diet} className="border-t border-border">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    {tDiet(diet)}
                  </th>
                  {MEALS.map((meal) => {
                    const recipes = coverage[diet][meal];
                    return (
                      <td
                        key={meal}
                        className={cn(
                          'px-2 py-1.5 text-right tabular-nums',
                          recipes === 0 && 'font-semibold text-destructive',
                          recipes > 0 && recipes < VARIETY_DEPTH && 'text-warning',
                        )}
                      >
                        {recipes}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground">{t('gap', { below, pairs: pairs.length, target })}</p>

        <h3 className="pt-2 text-sm font-medium">{t('macrosTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('macrosExplain', { points: Math.round(macros.outOfReach * 100) })}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t('macrosTitle')}>
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                  {t('diet')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  {t('macrosTarget')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  {t('macrosReached')}
                </th>
              </tr>
            </thead>
            <tbody>
              {DietType.options
                .filter((diet) => diet !== 'custom')
                .map((diet) => {
                  const { target: aim, reached } = macros.diets[diet];
                  const far = reached !== null && reached.distance > macros.outOfReach;
                  return (
                    <tr key={diet} className="border-t border-border">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {tDiet(diet)}
                      </th>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{shares(aim)}</td>
                      <td className={cn('px-2 py-1.5 text-right tabular-nums', far && 'font-semibold text-warning', reached === null && 'text-destructive')}>
                        {reached ? shares(reached) : t('macrosNoPlan')}
                        {far && <span className="ml-2 font-normal">{t('macrosOff', { points: Math.round(reached.distance * 100) })}</span>}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
