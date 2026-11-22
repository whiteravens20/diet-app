// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { MacroName, MacrosOffCause, MacrosOffWhy as Why, MealType } from '@diet-app/shared';

/**
 * Why a day's macros are off, as the server worked it out: what the day holds too much and too little of, and each
 * cause with what helps.
 */
export function MacrosOffWhy({
  why,
  mealName,
}: {
  why: Why;
  /** The name of a time of day, as the plan's meals are named. */
  mealName: (slot: MealType) => string;
}) {
  const t = useTranslations('mealPlans.macrosOffWhy');
  const macro = (name: MacroName) => t(`macroOf.${name}`);
  const lean =
    why.over && why.under
      ? t('leanBoth', { over: macro(why.over), under: macro(why.under) })
      : why.over
        ? t('leanOver', { over: macro(why.over) })
        : why.under
          ? t('leanUnder', { under: macro(why.under) })
          : null;
  const said = (cause: MacrosOffCause): string => {
    switch (cause.kind) {
      case 'fixed':
        return t('fixed', { share: cause.share });
      case 'cookTime':
        return t('cookTime', { minutes: cause.minutes });
      case 'fewerMeals':
        return t('fewerMeals', { count: cause.count });
      case 'useUp':
        return t('useUp');
      case 'byHand':
        return t('byHand', { count: cause.count });
      case 'singleDish':
        return t('singleDish', {
          slots: cause.slots.map((slot) => mealName(slot).toLocaleLowerCase()).join(', '),
        });
      case 'diet':
        return t('diet');
    }
  };
  return (
    <div className="space-y-0.5 text-xs">
      {lean && <p className="text-warning">{lean}</p>}
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {why.causes.map((cause) => (
          <li key={cause.kind}>{said(cause)}</li>
        ))}
      </ul>
    </div>
  );
}
