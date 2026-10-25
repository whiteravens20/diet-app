// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  DaySettings,
  MAX_CALORIE_TARGET,
  MIN_CALORIE_TARGET,
  RelaxationNeeded,
  type DayMealFate,
  type DaySettingsPreview,
  type MealPlan,
  type MealPlanDay,
  type MealType,
  type PlanRelaxation,
} from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { useSettled } from '@/lib/use-settled';

type Kind = 'normal' | 'training' | 'rest' | 'skip';
const KINDS: readonly Kind[] = ['normal', 'training', 'rest', 'skip'];
const COUNTS = [2, 3, 4, 5] as const;

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/** What becomes of a meal, as the window says it: the fate, and why where there is more to it than the day's new target. */
const FATE_WORDS: Record<
  DayMealFate['fate'],
  Partial<Record<NonNullable<DayMealFate['because']> | 'plain', string>>
> = {
  stays: { plain: 'fateStays', eaten: 'fateStaysEaten', own: 'fateStaysOwn' },
  resized: { plain: 'fateResized' },
  redrawn: { over_cook_time: 'fateRedrawnCookTime', use_up: 'fateRedrawnUseUp' },
  removed: { fewer_meals: 'fateRemovedFewer', skipped: 'fateRemovedSkipped' },
};

/** The text of a whole number typed in a field: null for an empty field, NaN for what is no number. */
const typed = (value: string): number | null => (value.trim() === '' ? null : Number(value));

/**
 * The window in which the settings of a day of a running plan are changed:
 * its kind, how many meals it has, a target of its own, a limit on cooking
 * time, and whether it uses up what the pantry has to use up. What a change
 * would do is said before anything is saved, as the API works it out: the
 * day's new target, and of every meal whether it stays, takes another
 * portion, gets another recipe or goes. Nothing changes until it is saved.
 */
export function DaySettingsDialog({
  planId,
  day,
  mealName,
  limitNames,
  onClose,
  onSaved,
}: {
  planId: string;
  day: MealPlanDay;
  mealName: (mealType: string) => string;
  limitNames: (kinds: readonly PlanRelaxation[]) => string;
  onClose: () => void;
  /** Told when the plan is no longer what the page shows: the settings were saved, or the plan had changed under them. */
  onSaved: () => void;
}) {
  const t = useTranslations('mealPlans.daySettings');
  const tPlans = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const errorText = useErrorText();
  const [kind, setKind] = useState<Kind>(
    day.overrides?.skip ? 'skip' : (day.overrides?.dayType ?? 'normal'),
  );
  const [mealCount, setMealCount] = useState(day.mealCount);
  const [target, setTarget] = useState(day.overrides?.calorieTarget?.toString() ?? '');
  const [cookTime, setCookTime] = useState(day.overrides?.cookTimeBudgetMinutes?.toString() ?? '');
  const [useUp, setUseUp] = useState(day.overrides?.useUpBy ?? false);
  const [error, setError] = useState<string | null>(null);
  // The limits that stood in the way of a save, which the reader may let give way.
  const [inTheWay, setInTheWay] = useState<RelaxationNeeded | null>(null);

  // The settings as they are typed: none while a number is no number the API takes, which the field says itself.
  const asked = DaySettings.safeParse({
    dayType: kind === 'skip' ? (day.overrides?.dayType ?? 'normal') : kind,
    skip: kind === 'skip',
    mealCount,
    calorieTarget: typed(target),
    cookTimeBudgetMinutes: typed(cookTime),
    useUpBy: useUp,
  });
  // Asked of the API once the typing has paused: every change of a field is a question of its own.
  const settled = useSettled(asked.success ? JSON.stringify(asked.data) : null, 300);
  const path = `/meal-plans/${planId}/days/${day.id}/settings`;
  const preview = useQuery({
    queryKey: ['day-settings', planId, day.id, settled],
    queryFn: () =>
      api.post<DaySettingsPreview>(`${path}/preview`, JSON.parse(settled!) as DaySettings),
    enabled: settled !== null,
    placeholderData: keepPreviousData,
    gcTime: 0,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (allowRelaxations: PlanRelaxation[] | undefined) =>
      api.put<MealPlan>(path, {
        ...(JSON.parse(settled!) as DaySettings),
        revision: preview.data!.revision,
        ...(allowRelaxations ? { allowRelaxations } : {}),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: unknown) => {
      const needed =
        e instanceof ApiClientError && e.code === 'PLAN_NEEDS_RELAXATION'
          ? RelaxationNeeded.safeParse(e.details)
          : null;
      if (needed?.success) {
        setError(null);
        setInTheWay(needed.data);
        return;
      }
      // The preview was for the plan as it was: where the plan changed, both are read anew.
      if (e instanceof ApiClientError && e.code === 'PLAN_CHANGED') {
        onSaved();
        void preview.refetch();
      }
      setError(errorText(e, t('errSave')));
    },
  });

  // What is shown is for the settings on the screen only: while a newer question is on its way, the older answer is greyed.
  const shown = preview.data;
  const current =
    shown !== undefined &&
    !preview.isPlaceholderData &&
    settled === (asked.success ? JSON.stringify(asked.data) : null);
  const busy = save.isPending;

  return (
    <Dialog open onClose={onClose} label={t('title')} className="max-w-lg">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{fmt.day(day.date)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (current && shown?.unchanged === false) save.mutate(undefined);
        }}
      >
        <Field label={t('kind')} hint={t('kindHint')}>
          <select
            className={selectClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {KINDS.map((option) => (
              <option key={option} value={option}>
                {t(`kinds.${option}`)}
              </option>
            ))}
          </select>
        </Field>
        {kind !== 'skip' && (
          <>
            <Field label={t('mealCount')}>
              <select
                className={selectClass}
                value={mealCount}
                onChange={(e) => setMealCount(Number(e.target.value))}
              >
                {COUNTS.map((count) => (
                  <option key={count} value={count}>
                    {t('mealCountOption', { count })}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('ownTarget')} hint={t('ownTargetHint')}>
              <Input
                type="number"
                inputMode="numeric"
                min={MIN_CALORIE_TARGET}
                max={MAX_CALORIE_TARGET}
                step={1}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </Field>
            <Field label={t('cookTime')} hint={t('cookTimeHint')}>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={600}
                step={1}
                value={cookTime}
                onChange={(e) => setCookTime(e.target.value)}
              />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={useUp}
                onChange={(e) => setUseUp(e.target.checked)}
              />
              <span>
                {t('useUp')}
                <span className="block text-xs text-muted-foreground">{t('useUpHint')}</span>
              </span>
            </label>
          </>
        )}

        {/* What the change would do, said before it is made: the API works it out, this says it. */}
        <div
          aria-live="polite"
          className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs"
        >
          {shown === undefined ? (
            preview.isError ? (
              <p role="alert">{errorText(preview.error, t('errPreview'))}</p>
            ) : asked.success ? (
              <Skeleton className="h-16" />
            ) : (
              <p>{t('fixFields')}</p>
            )
          ) : (
            <div className={current ? undefined : 'opacity-60'}>
              <Outcome preview={shown} skip={kind === 'skip'} mealName={mealName} />
            </div>
          )}
        </div>

        {inTheWay && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs"
          >
            <p>
              {tPlans('limitsInTheWay', {
                count: inTheWay.meals.length,
                limits: limitNames(inTheWay.needs),
              })}
            </p>
            <ul className="list-disc pl-5">
              {inTheWay.meals.map((meal) => (
                <li key={meal.slot}>
                  {mealName(meal.slot)}: {limitNames(meal.gaveWay)}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !current}
              onClick={() => save.mutate(inTheWay.needs)}
            >
              {tPlans('letGiveWay', { count: inTheWay.needs.length })}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={busy || !current || shown?.unchanged !== false}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What a change of a day's settings would do, line by line. */
function Outcome({
  preview,
  skip,
  mealName,
}: {
  preview: DaySettingsPreview;
  skip: boolean;
  mealName: (mealType: string) => string;
}) {
  const t = useTranslations('mealPlans.daySettings');
  const fmt = useFormat();
  if (preview.unchanged) return <p>{t('unchanged')}</p>;
  const { now, then } = preview.calorieTarget;
  const drawn = preview.added.length > 0 || preview.meals.some((meal) => meal.fate === 'redrawn');
  return (
    <>
      {skip ? (
        <p>{t('skipNote')}</p>
      ) : (
        <>
          <p className="font-medium">
            {now === then
              ? t('targetSame', { kcal: fmt.number(now) })
              : t('targetChange', { from: fmt.number(now), to: fmt.number(then) })}
          </p>
          <p className="text-muted-foreground">
            {t('targetMacros', {
              protein: preview.targetMacros.then.protein,
              fat: preview.targetMacros.then.fat,
              carbs: preview.targetMacros.then.carbs,
            })}
          </p>
          {preview.belowSafetyFloor && <p className="text-warning">{t('belowFloor')}</p>}
        </>
      )}
      <ul className="space-y-0.5">
        {preview.meals.map((meal) => (
          <li key={meal.mealId}>
            <span className="text-muted-foreground">{mealName(meal.mealType)}:</span>{' '}
            {t(FATE_WORDS[meal.fate][meal.because ?? 'plain']!)}
          </li>
        ))}
        {preview.added.length > 0 && (
          <li>
            {t('added', { meals: fmt.list(preview.added.map((slot: MealType) => mealName(slot))) })}
          </li>
        )}
      </ul>
      {drawn && <p className="text-muted-foreground">{t('drawnNote')}</p>}
      {preview.dayCalories !== null && !skip && (
        <p className={preview.fits ? 'text-muted-foreground' : 'text-warning'}>
          {t(preview.fits ? 'dayCalories' : 'dayCaloriesOff', {
            kcal: fmt.number(preview.dayCalories),
          })}
        </p>
      )}
      {preview.listOutOfDate && <p className="text-muted-foreground">{t('listOutOfDate')}</p>}
      <p className="text-muted-foreground">{t('otherDays')}</p>
    </>
  );
}
