// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  ActivityLevel,
  MAX_CALORIE_TARGET,
  MIN_CALORIE_TARGET,
  PACES_OF_LOSS,
  type CalorieCalculation,
  type DietType,
  type MacroSplit,
  type Profile,
  type WeightUnit,
} from '@diet-app/shared';
import { NAMED_DIETS, supplyOf } from '@/lib/catalogue';
import type { Risk } from '@/lib/typed-figures';
import { useConfig } from '@/lib/use-config';
import { useFormat } from '@/lib/use-format';
import { boundsIn, shownToOne, shownWeight } from '@/lib/weight-unit';
import { Field, Input } from '@/components/ui/input';
import { OwnTargetsFields } from '@/components/own-targets-fields';
import { SupplyNote } from '@/components/supply-note';
import { DOT } from '@/lib/figure-line';

/*
 * The fields a profile is made of, as every form that asks for them shows
 * them: the form of a profile, the steps a first profile is set up in, and
 * the calculator. Each keeps its value in the form it stands in, under the
 * name the form reads it by.
 */

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

type Body = Pick<Profile, 'age' | 'sex' | 'heightCm' | 'weightKg' | 'activityLevel'>;

/** Why a field's change was not kept, by the field's name, for a form that keeps each change as it is made. */
type ErrorOf = (field: string) => string | undefined;

/**
 * The body a calorie target is worked out from: age, sex, height, weight and
 * how much it moves. A form that begins with nobody's figures begins empty: a
 * target worked out from numbers that were only standing there would look
 * like somebody's own.
 */
export function BodyFields({
  initial,
  unit,
  errorOf,
}: {
  initial?: Body;
  unit: WeightUnit;
  errorOf?: ErrorOf;
}) {
  const t = useTranslations('profile');
  const tActivity = useTranslations('enums.activityLevel');
  const tSex = useTranslations('enums.sex');
  const weightBounds = boundsIn(unit);
  // The field stays the form's own; this follows it for the line that says what the level means.
  const [activity, setActivity] = useState<ActivityLevel>(initial?.activityLevel ?? 'moderate');
  return (
    <>
      <Field label={t('age')} error={errorOf?.('age')}>
        <Input
          name="age"
          type="number"
          inputMode="numeric"
          required
          min={13}
          max={120}
          defaultValue={initial?.age ?? ''}
        />
      </Field>
      <Field label={t('sex')} hint={t('sexHint')} error={errorOf?.('sex')}>
        <select name="sex" className={selectClass} defaultValue={initial?.sex ?? ''}>
          <option value="">{t('preferNotToSay')}</option>
          <option value="male">{tSex('male')}</option>
          <option value="female">{tSex('female')}</option>
          <option value="non_binary">{tSex('non_binary')}</option>
        </select>
      </Field>
      <Field label={t('heightCm')} error={errorOf?.('heightCm')}>
        <Input
          name="heightCm"
          type="number"
          inputMode="decimal"
          required
          min={100}
          max={250}
          step="any"
          defaultValue={initial?.heightCm ?? ''}
        />
      </Field>
      {/* Typed in the unit of the account. The field is made anew when the unit is known or changes: a number under another unit's name would be another weight. */}
      <Field label={t('weight', { unit })} error={errorOf?.('weight')}>
        <Input
          key={unit}
          name="weight"
          type="number"
          inputMode="decimal"
          required
          min={weightBounds.min}
          max={weightBounds.max}
          step="0.1"
          defaultValue={initial ? shownToOne(initial.weightKg, unit) : ''}
        />
      </Field>
      <Field label={t('activityLevel')} hint={t('activityWeek')} error={errorOf?.('activityLevel')}>
        <select
          name="activityLevel"
          className={selectClass}
          defaultValue={initial?.activityLevel ?? 'moderate'}
          onChange={(e) => setActivity(e.target.value as ActivityLevel)}
        >
          {ActivityLevel.options.map((level) => (
            <option key={level} value={level}>
              {tActivity(level)}
            </option>
          ))}
        </select>
        <span
          aria-live="polite"
          className="block rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
        >
          {t(`activityHint.${activity}`)}
        </span>
      </Field>
    </>
  );
}

/**
 * The pace of loss, chosen among all of them, each saying what it comes to
 * in a day for the body the form describes (`paces`, in the order of the
 * choices, once they are known). A pace that a limit slowed, or that is held
 * for a body planned no loss, says so on its row.
 */
export function PaceChoice({
  initial,
  paces,
  unit,
  className,
}: {
  initial: Profile['weeklyLossTarget'];
  paces: CalorieCalculation[] | undefined;
  unit: WeightUnit;
  className?: string;
}) {
  const t = useTranslations('profile');
  const fmt = useFormat();
  const slowed = (at: CalorieCalculation): boolean =>
    at.deficitCapped || at.safetyFloorApplied || at.maintenanceUnderFloor;
  return (
    <fieldset className={className}>
      <legend className="text-sm font-medium">{t('pace')}</legend>
      <div className="mt-1.5 grid gap-1.5">
        {PACES_OF_LOSS.map((pace, index) => {
          const at = paces?.[index];
          return (
            // On a narrow screen what a pace comes to stands under its name: side by side, each would be broken into a column of words.
            <label
              key={pace ?? 'none'}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded-md border border-input px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
            >
              <input
                type="radio"
                name="weeklyLossTarget"
                value={pace ?? ''}
                defaultChecked={pace === initial}
                className="h-4 w-4"
              />
              {/* A quarter of a kilogram is said to the hundredth; in pounds, where no pace is a round number, to the tenth. */}
              <span>
                {pace === null
                  ? t('paceNone')
                  : t('paceLose', {
                      amount:
                        unit === 'lb'
                          ? fmt.unit(shownWeight(Number(pace), unit), 'pound', 1)
                          : fmt.unit(Number(pace), 'kilogram', 2),
                    })}
              </span>
              {at && (
                <span className="col-start-2 text-muted-foreground tabular-nums sm:col-start-3 sm:text-right">
                  {t('paceComesTo', { kcal: at.dailyTarget })}
                  {pace !== null && at.goalHeld
                    ? `${DOT}${t('paceHeld')}`
                    : pace !== null && slowed(at)
                      ? `${DOT}${t('paceSlowed')}`
                      : ''}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {paces?.some((at, index) => PACES_OF_LOSS[index] !== null && !at.goalHeld && slowed(at)) && (
        <p className="mt-1.5 text-xs text-muted-foreground">{t('paceSlowedNote')}</p>
      )}
    </fieldset>
  );
}

/**
 * A calorie target of one's own, in place of the one the pace comes to: at
 * least `least`, what the calculation of the body says it may be typed at.
 */
export function OwnTargetField({
  initial,
  least = MIN_CALORIE_TARGET,
  errorOf,
}: {
  initial: number | null;
  least?: number;
  errorOf?: ErrorOf;
}) {
  const t = useTranslations('profile');
  return (
    <Field
      label={t('manualKcalOverride')}
      hint={t('manualKcalHint', { least })}
      error={errorOf?.('manualCalorieTarget')}
      optional
    >
      <Input
        name="manualCalorieTarget"
        type="number"
        inputMode="numeric"
        min={least}
        max={MAX_CALORIE_TARGET}
        placeholder={t('auto')}
        defaultValue={initial ?? ''}
      />
    </Field>
  );
}

/**
 * Why losing weight is a risk for the body a form describes, when a loss is
 * asked for: no loss is planned for it, and plans follow maintenance. For an
 * underweight body it says where to turn.
 */
export function RiskNote({ reasons, className }: { reasons: Risk[]; className?: string }) {
  const t = useTranslations('profile.risk');
  if (reasons.length === 0) return null;
  return (
    <div
      className={`space-y-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm ${className ?? ''}`}
    >
      {reasons.map((reason) => (
        <p key={reason}>{t(reason)}</p>
      ))}
      <p className="text-muted-foreground">{t('held')}</p>
      {reasons.includes('underweight') && <p className="text-muted-foreground">{t('help')}</p>}
    </div>
  );
}

/**
 * The diet, and with `meals` the number of meals a day. With the meals, each
 * diet is marked when the catalogue has no recipe, or few, for one of that
 * many meals, and the chosen pair gets a line saying what that means for a
 * plan. The custom diet asks for its split: how much of a day's energy comes
 * from protein, fat and carbohydrate.
 */
export function DietFields({
  diet: firstDiet,
  mealCount: firstMealCount,
  split: firstSplit,
  perKg: firstPerKg = null,
  target = null,
  weightKg = null,
  meals = true,
  errorOf,
}: {
  diet: DietType;
  mealCount?: number;
  split: MacroSplit | null;
  /** The protein per kilogram the profile keeps; null for the way of the split. */
  perKg?: number | null;
  /** The day's calorie target the form's figures come to, and the weight they hold: what grams are worked out at. */
  target?: number | null;
  weightKg?: number | null;
  meals?: boolean;
  errorOf?: ErrorOf;
}) {
  const t = useTranslations('profile');
  const tCatalogue = useTranslations('catalogue');
  const tDiet = useTranslations('enums.dietType');
  const supply = useConfig().data?.catalogue.supply;
  // The fields stay the form's own; these follow them for the marks.
  const [diet, setDiet] = useState(firstDiet);
  const [mealCount, setMealCount] = useState(firstMealCount ?? 3);
  const diets: readonly DietType[] = [...NAMED_DIETS, 'custom'];
  return (
    <>
      <Field label={t('dietType')} error={errorOf?.('dietType')}>
        <select
          name="dietType"
          className={selectClass}
          defaultValue={firstDiet}
          onChange={(e) => setDiet(e.target.value as DietType)}
        >
          {diets.map((d) => {
            const level = meals ? supplyOf(supply, d, mealCount)?.level : undefined;
            return (
              <option key={d} value={d}>
                {level === 'none'
                  ? tCatalogue('dietNone', { diet: tDiet(d) })
                  : level === 'thin'
                    ? tCatalogue('dietThin', { diet: tDiet(d) })
                    : tDiet(d)}
              </option>
            );
          })}
        </select>
      </Field>
      {meals && (
        <>
          <Field label={t('mealsPerDay')} error={errorOf?.('mealCount')}>
            <Input
              name="mealCount"
              type="number"
              inputMode="numeric"
              required
              min={2}
              max={5}
              defaultValue={firstMealCount ?? 3}
              onChange={(e) => setMealCount(e.target.valueAsNumber)}
            />
          </Field>
          <SupplyNote diet={diet} mealCount={mealCount} className="sm:col-span-2" />
        </>
      )}
      {diet === 'custom' && (
        <OwnTargetsFields
          split={firstSplit}
          perKg={firstPerKg}
          target={target}
          weightKg={weightKg}
          errorOf={errorOf}
        />
      )}
    </>
  );
}
