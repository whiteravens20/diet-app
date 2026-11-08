// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { DietType } from '@diet-app/shared';
import { useConfig } from '@/lib/use-config';

/**
 * The choice of a plan that wastes less, with what it costs said beside it: in
 * figures for the plan's diet, as the instance measured them, and in words for
 * the custom diet, which has none, or while the figures are on their way.
 */
export function LessWasteSwitch({
  diet,
  checked,
  onChange,
}: {
  /** The diet the plan is made for. */
  diet: DietType;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations('mealPlans');
  const id = useId();
  const measured = useConfig().data?.plans.lessWaste;
  const effect = diet === 'custom' ? undefined : measured?.[diet];

  return (
    <div className="text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4"
          aria-describedby={id}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {t('lessWaste')}
      </label>
      <div id={id} className="mt-1 space-y-1 text-xs text-muted-foreground">
        <p>
          {effect
            ? t('lessWasteHint', {
                pantryNow: effect.pantry.now,
                pantryLess: effect.pantry.less,
                packsNow: effect.packs.now,
                packsLess: effect.packs.less,
                fewer: effect.fewerRecipes,
              })
            : t('lessWasteHintCustom')}
        </p>
        <p>{t('lessWasteLimits')}</p>
      </div>
    </div>
  );
}
