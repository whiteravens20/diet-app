// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import type { DietType, PlanOptions, Profile } from '@diet-app/shared';
import { useConfig } from '@/lib/use-config';

/** How much a plan does to waste less of what it buys: as usual, less ("Mniej marnowania"), or nothing ("Bez marnowania"). */
export type WasteLevel = 'usual' | 'less' | 'none';

/** The level a plan was made at. */
export const levelOf = (options: Pick<PlanOptions, 'lessWaste' | 'noWaste'>): WasteLevel =>
  options.noWaste ? 'none' : options.lessWaste ? 'less' : 'usual';

/** What a request asks for a level: a plan that wastes nothing wastes less as well. */
export const askedOf = (level: WasteLevel): { lessWaste: boolean; noWaste: boolean } => ({
  lessWaste: level !== 'usual',
  noWaste: level === 'none',
});

/** A profile's own limits on repeats, or those of a new profile while none is there. */
export const repeatsOf = (
  profile: Pick<Profile, 'preferences'> | null | undefined,
): { daysInARow: number; timesAWeek: number } => ({
  daysInARow: profile?.preferences?.maxConsecutiveDaysSameMeal ?? 2,
  timesAWeek: profile?.preferences?.maxTimesPerWeekSameMeal ?? 3,
});

/**
 * The choice of how much a plan does to waste less, each level with what it
 * gives and costs said beside it: in figures for the plan's diet, as the
 * instance measured them, and in words for the custom diet, which has none, or
 * while the figures are on their way. Of a plan that wastes nothing it says
 * which limits of the profile it loosens, and to what.
 */
export function WasteLevelChoice({
  diet,
  level,
  onChange,
  repeats,
}: {
  /** The diet the plan is made for. */
  diet: DietType;
  level: WasteLevel;
  onChange: (level: WasteLevel) => void;
  /** The profile's own limits on repeats: the most days running and times in seven days of one recipe. */
  repeats: { daysInARow: number; timesAWeek: number };
}) {
  const t = useTranslations('mealPlans');
  const name = useId();
  const plans = useConfig().data?.plans;
  const less = diet === 'custom' ? undefined : plans?.lessWaste[diet];
  const none = diet === 'custom' ? undefined : plans?.noWaste[diet];
  const rules = plans?.waste;

  const option = (value: WasteLevel, label: string, said: ReactNode[]) => (
    <div>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          className="h-4 w-4"
          name={name}
          value={value}
          aria-describedby={`${name}-${value}`}
          checked={level === value}
          onChange={() => onChange(value)}
        />
        {label}
      </label>
      <div id={`${name}-${value}`} className="ml-6 mt-1 space-y-1 text-xs text-muted-foreground">
        {said.map((one, index) => (
          <p key={index}>{one}</p>
        ))}
      </div>
    </div>
  );

  return (
    <fieldset className="text-sm">
      <legend className="font-medium">{t('wasteLevel')}</legend>
      <div className="mt-2 space-y-3">
        {option('usual', t('wasteUsual'), [t('wasteUsualHint')])}
        {option('less', t('lessWaste'), [
          less
            ? t('lessWasteHint', {
                pantryNow: less.pantry.now,
                pantryLess: less.pantry.less,
                packsNow: less.packs.now,
                packsLess: less.packs.less,
                fewer: less.fewerRecipes,
              })
            : t('lessWasteHintCustom'),
          ...(rules ? [t('lessWasteRests', { rests: rules.less.restsOfDay })] : []),
          t('lessWasteLimits'),
        ])}
        {option(
          'none',
          t('noWaste'),
          rules
            ? [
                none
                  ? t('noWasteHint', {
                      meatDays: rules.none.meatAndFishDays,
                      otherDays: rules.none.otherDays,
                      packsNow: none.packs.now,
                      packs: none.packs.less,
                      pantryNow: none.pantry.now,
                      pantry: none.pantry.less,
                      fewer: none.fewerRecipes,
                    })
                  : t('noWasteHintCustom', {
                      meatDays: rules.none.meatAndFishDays,
                      otherDays: rules.none.otherDays,
                    }),
                // The planner takes the looser of the two limits: the level's or the profile's own.
                t('noWasteRepeats', {
                  days: Math.max(repeats.daysInARow, rules.none.daysInARow),
                  ownDays: repeats.daysInARow,
                  daysLoosened: repeats.daysInARow < rules.none.daysInARow ? 'yes' : 'no',
                  times: Math.max(repeats.timesAWeek, rules.none.timesAWeek),
                  ownTimes: repeats.timesAWeek,
                  timesLoosened: repeats.timesAWeek < rules.none.timesAWeek ? 'yes' : 'no',
                }),
                t('noWasteKept', { rests: rules.none.restsOfDay }),
              ]
            : [],
        )}
      </div>
    </fieldset>
  );
}
