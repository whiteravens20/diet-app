// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  ActivityLevel,
  MAX_CALORIE_TARGET,
  MIN_CALORIE_TARGET,
  PACES_OF_LOSS,
  SPLIT_SHARE_LIMITS,
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
import { SupplyNote } from '@/components/supply-note';

/*
 * The fields a profile is made of, as every form that asks for them shows
 * them: the form of a profile, the steps a first profile is set up in, and
 * the calculator. Each keeps its value in the form it stands in, under the
 * name the form reads it by.
 */

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

type Body = Pick<Profile, 'age' | 'sex' | 'heightCm' | 'weightKg' | 'activityLevel'>;

/**
 * The body a calorie target is worked out from: age, sex, height, weight and
 * how much it moves. A form that begins with nobody's figures begins empty: a
 * target worked out from numbers that were only standing there would look
 * like somebody's own.
 */
export function BodyFields({ initial, unit }: { initial?: Body; unit: WeightUnit }) {
  const t = useTranslations('profile');
  const tActivity = useTranslations('enums.activityLevel');
  const tSex = useTranslations('enums.sex');
  const weightBounds = boundsIn(unit);
  // The field stays the form's own; this follows it for the line that says what the level means.
  const [activity, setActivity] = useState<ActivityLevel>(initial?.activityLevel ?? 'moderate');
  return (
    <>
      <Field label={t('age')}>
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
      <Field label={t('sex')} hint={t('sexHint')}>
        <select name="sex" className={selectClass} defaultValue={initial?.sex ?? ''}>
          <option value="">{t('preferNotToSay')}</option>
          <option value="male">{tSex('male')}</option>
          <option value="female">{tSex('female')}</option>
        </select>
      </Field>
      <Field label={t('heightCm')}>
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
      <Field label={t('weight', { unit })}>
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
      <Field label={t('activityLevel')} hint={t(`activityHint.${activity}`)}>
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
      </Field>
    </>
  );
}

/**
 * The pace of loss, chosen among all of them, each saying what it comes to
 * in a day for the body the form describes (`paces`, in the order of the
 * choices, once they are known). A pace that a limit slowed, or that is held
 * until a risk is acknowledged, says so on its row.
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
                    ? ` · ${t('paceHeld')}`
                    : pace !== null && slowed(at)
                      ? ` · ${t('paceSlowed')}`
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

/** A calorie target of one's own, in place of the one the pace comes to. */
export function OwnTargetField({ initial }: { initial: number | null }) {
  const t = useTranslations('profile');
  return (
    <Field label={t('manualKcalOverride')} hint={t('manualKcalHint')}>
      <Input
        name="manualCalorieTarget"
        type="number"
        inputMode="numeric"
        min={MIN_CALORIE_TARGET}
        max={MAX_CALORIE_TARGET}
        placeholder={t('auto')}
        defaultValue={initial ?? ''}
      />
    </Field>
  );
}

/**
 * Why losing weight is a risk for the body a form describes, and the box by
 * which somebody says they understand it. Until it is ticked the goal is
 * kept, and plans follow maintenance. A form that keeps nothing (`kept`
 * false) says what the box does to the figures it shows, and no more.
 */
export function RiskBox({
  reasons,
  acknowledged,
  kept = true,
  className,
}: {
  reasons: Risk[];
  acknowledged: boolean;
  kept?: boolean;
  className?: string;
}) {
  const t = useTranslations('profile.risk');
  if (reasons.length === 0) return null;
  return (
    <div
      className={`space-y-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm ${className ?? ''}`}
    >
      {reasons.map((reason) => (
        <p key={reason}>{t(reason)}</p>
      ))}
      <p className="text-muted-foreground">{t(kept ? 'held' : 'heldHere')}</p>
      <label className="flex items-start gap-2 font-medium">
        <input
          type="checkbox"
          name="acknowledgeRisk"
          className="mt-1"
          defaultChecked={acknowledged}
        />
        {t(kept ? 'acknowledge' : 'acknowledgeHere')}
      </label>
    </div>
  );
}

/** The split a profile that goes to the custom diet begins with: the balanced diet's. */
const A_FIRST_SPLIT: MacroSplit = { protein: 25, fat: 30, carbs: 45 };

/** Whether the three shares a form holds for the custom diet add up; true on every other diet. */
export function splitAddsUp(fields: FormData): boolean {
  return (
    fields.get('dietType') !== 'custom' ||
    Number(fields.get('splitProtein')) +
      Number(fields.get('splitFat')) +
      Number(fields.get('splitCarbs')) ===
      100
  );
}

/** The split a form holds for the custom diet; `kept` (the one a profile has for when it goes back) on every other. */
export function splitIn(fields: FormData, kept: MacroSplit | null): MacroSplit | null {
  return fields.get('dietType') === 'custom'
    ? {
        protein: Number(fields.get('splitProtein')),
        fat: Number(fields.get('splitFat')),
        carbs: Number(fields.get('splitCarbs')),
      }
    : kept;
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
  meals = true,
}: {
  diet: DietType;
  mealCount?: number;
  split: MacroSplit | null;
  meals?: boolean;
}) {
  const t = useTranslations('profile');
  const tCatalogue = useTranslations('catalogue');
  const tDiet = useTranslations('enums.dietType');
  const depth = useConfig().data?.catalogue.depth;
  // The fields stay the form's own; these follow them for the marks.
  const [diet, setDiet] = useState(firstDiet);
  const [mealCount, setMealCount] = useState(firstMealCount ?? 3);
  const diets: readonly DietType[] = [...NAMED_DIETS, 'custom'];
  // The three shares as they are typed, so that the form can say what they add up to before it is sent.
  const [split, setSplit] = useState<Record<keyof MacroSplit, string>>(() => {
    const first = firstSplit ?? A_FIRST_SPLIT;
    return { protein: String(first.protein), fat: String(first.fat), carbs: String(first.carbs) };
  });
  const sum = Number(split.protein) + Number(split.fat) + Number(split.carbs);
  return (
    <>
      <Field label={t('dietType')}>
        <select
          name="dietType"
          className={selectClass}
          defaultValue={firstDiet}
          onChange={(e) => setDiet(e.target.value as DietType)}
        >
          {diets.map((d) => {
            const supply = meals ? supplyOf(depth, d, mealCount)?.supply : undefined;
            return (
              <option key={d} value={d}>
                {supply === 'none'
                  ? tCatalogue('dietNone', { diet: tDiet(d) })
                  : supply === 'thin'
                    ? tCatalogue('dietThin', { diet: tDiet(d) })
                    : tDiet(d)}
              </option>
            );
          })}
        </select>
      </Field>
      {meals && (
        <>
          <Field label={t('mealsPerDay')}>
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
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">{t('customSplit')}</legend>
          <p className="text-xs text-muted-foreground">{t('customSplitHint')}</p>
          <div className="grid grid-cols-3 gap-3">
            {(['protein', 'fat', 'carbs'] as const).map((part) => (
              <Field key={part} label={t(`split.${part}`)}>
                <Input
                  name={`split${part[0]!.toUpperCase()}${part.slice(1)}`}
                  type="number"
                  inputMode="numeric"
                  required
                  min={SPLIT_SHARE_LIMITS[part].min}
                  max={SPLIT_SHARE_LIMITS[part].max}
                  step={1}
                  value={split[part]}
                  onChange={(e) => setSplit({ ...split, [part]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          {/* Said while it is typed: a form that is refused for its sum should have said the sum. */}
          <p
            aria-live="polite"
            className={sum === 100 ? 'text-xs text-muted-foreground' : 'text-xs text-warning'}
          >
            {t(sum === 100 ? 'splitSum' : 'splitSumOff', { sum })}
          </p>
        </fieldset>
      )}
    </>
  );
}
