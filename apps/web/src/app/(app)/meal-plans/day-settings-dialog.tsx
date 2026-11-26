// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import {
  DaySettings,
  MAX_CALORIE_TARGET,
  MAX_COOK_TIME_BUDGET,
  MIN_CALORIE_TARGET,
  RelaxationNeeded,
  type CalorieCalculation,
  type DayMealFate,
  type ChangedPlan,
  type DaySettingsPreview,
  type MealPlanDay,
  type MealType,
  type PlanRelaxation,
  type PlanWeek,
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
import { cn } from '@/lib/utils';
import { shownWeight, useWeightUnit } from '@/lib/weight-unit';
import { bandValues } from '@/lib/carbs-band';
import { CookingNote } from './cooking';
import { ListNote } from './list-note';

type Kind = 'normal' | 'training' | 'rest' | 'skip';
const KINDS: readonly Kind[] = ['normal', 'training', 'rest', 'skip'];
const COUNTS = [2, 3, 4, 5] as const;

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/** What becomes of a meal, as the window says it: the fate, and why where there is more to it than the day's new target. */
const FATE_WORDS: Record<
  DayMealFate['fate'],
  Partial<Record<NonNullable<DayMealFate['because']> | 'plain', string>>
> = {
  stays: {
    plain: 'fateStays',
    eaten: 'fateStaysEaten',
    own: 'fateStaysOwn',
    leftover: 'fateStaysLeftover',
  },
  resized: { plain: 'fateResized' },
  redrawn: { over_cook_time: 'fateRedrawnCookTime', use_up: 'fateRedrawnUseUp' },
  removed: { fewer_meals: 'fateRemovedFewer', skipped: 'fateRemovedSkipped' },
};

/** The text of a whole number typed in a field: null for an empty field, NaN for what is no number. */
const typed = (value: string): number | null => (value.trim() === '' ? null : Number(value));

/** Whether what is typed in a field of whole numbers from `min` to `max` is one of them, or nothing. */
const fits = (value: string, min: number, max: number): boolean => {
  const number = typed(value);
  return number === null || (Number.isInteger(number) && number >= min && number <= max);
};

/** Why no day takes what the day falls short of, in words. */
const NONE_WORDS = {
  last_day: 'shortLastDay',
  skipped: 'shortSkippedAfter',
  full: 'shortFull',
} as const;

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
  profileId,
  day,
  week,
  mealName,
  limitNames,
  onClose,
  onSaved,
}: {
  planId: string;
  /** The profile of the plan: the least a target of the day's own may be is the one its body may type. */
  profileId: string;
  day: MealPlanDay;
  /** The week of the plan the day is in, as the plan says it stands. */
  week: PlanWeek | undefined;
  mealName: (mealType: string) => string;
  limitNames: (kinds: readonly PlanRelaxation[]) => string;
  onClose: () => void;
  /**
   * Told when the plan is no longer what the page shows: the settings were saved or the week evened out (`changed`,
   * with which of the two it was), or the plan had changed under them (nothing).
   */
  onSaved: (changed?: ChangedPlan, cause?: 'day-settings' | 'week-evened') => void;
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
  const [only, setOnly] = useState(false);

  // The least the profile's body may type, as the plan's page asks for it: the same answer serves both.
  const calories = useQuery({
    queryKey: ['calories', profileId],
    queryFn: () => api.get<CalorieCalculation>(`/profiles/${profileId}/calories`),
  });
  const leastTarget = calories.data?.leastTypedTarget ?? MIN_CALORIE_TARGET;
  const targetFits = fits(target, leastTarget, MAX_CALORIE_TARGET);
  const cookTimeFits = fits(cookTime, 0, MAX_COOK_TIME_BUDGET);
  // The settings as they are typed: none while a number is no number the API takes, which the field says itself.
  const asked = DaySettings.safeParse({
    dayType: kind === 'skip' ? (day.overrides?.dayType ?? 'normal') : kind,
    skip: kind === 'skip',
    mealCount,
    calorieTarget: typed(target),
    cookTimeBudgetMinutes: typed(cookTime),
    useUpBy: useUp,
  });
  // Settings the API would take for this body: a target under its least is none, which the field says itself.
  const fit = asked.success && targetFits ? asked.data : null;
  // Asked of the API once the typing has paused: every change of a field is a question of its own.
  const settled = useSettled(fit ? JSON.stringify(fit) : null, 300);
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
  // Whether the save asked for evens the week out too: a retry with the limits let go asks the same.
  const [evenWeek, setEvenWeek] = useState(false);
  // Whether what the day falls short of goes to the next days of the plan, where the preview says it does.
  const [spread, setSpread] = useState(true);
  const save = useMutation({
    mutationFn: ({
      allowRelaxations,
      even,
    }: {
      allowRelaxations?: PlanRelaxation[];
      even: boolean;
    }) =>
      api.put<ChangedPlan>(path, {
        ...(JSON.parse(settled!) as DaySettings),
        revision: preview.data!.revision,
        ...(!only && preview.data!.cooking?.changes.length ? { together: true } : {}),
        ...(allowRelaxations ? { allowRelaxations } : {}),
        ...(even ? { evenWeek: true } : {}),
        ...(spread && (preview.data!.short?.spread.days ?? 0) > 0 ? { spreadShort: true } : {}),
      }),
    onSuccess: (changed) => {
      onSaved(changed, 'day-settings');
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

  // The week evened out on its own, with nothing of the day changed.
  const even = useMutation({
    mutationFn: () =>
      api.post<ChangedPlan>(`/meal-plans/${planId}/weeks/even`, {
        date: day.date,
        revision: preview.data!.revision,
      }),
    onSuccess: (changed) => {
      onSaved(changed, 'week-evened');
      onClose();
    },
    onError: (e: unknown) => {
      if (e instanceof ApiClientError && e.code === 'PLAN_CHANGED') {
        onSaved();
        void preview.refetch();
      }
      setError(errorText(e, t('errEven')));
    },
  });

  // What is shown is for the settings on the screen only: while a newer question is on its way, the older answer is greyed.
  const shown = preview.data;
  const current =
    shown !== undefined &&
    !preview.isPlaceholderData &&
    fit !== null &&
    settled === JSON.stringify(fit);
  const busy = save.isPending || even.isPending;
  // The change alone leaves the week off the plan's target: the week can be evened out with it.
  const twoWays = current && shown?.unchanged === false && shown.week?.unevenAlone === true;
  // Nothing of the day changes, and the week stands off its target: it can be evened out as it is.
  const evenAlone = current && shown?.unchanged === true && week?.uneven === true;

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
          if (current && shown?.unchanged === false) {
            setEvenWeek(false);
            save.mutate({ even: false });
          }
        }}
      >
        <div className="space-y-1">
          <Field label={t('kind')}>
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
          {/* What each kind does to the day's target: under the choice, for whoever asks. */}
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer py-1">{tCommon('howItWorks')}</summary>
            <p className="mt-1">{t('kindHint')}</p>
          </details>
        </div>
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
            <Field
              label={t('ownTarget')}
              hint={t('ownTargetHint')}
              optional
              error={
                targetFits ? undefined : t('between', { min: leastTarget, max: MAX_CALORIE_TARGET })
              }
            >
              <Input
                type="number"
                inputMode="numeric"
                min={leastTarget}
                max={MAX_CALORIE_TARGET}
                step={1}
                value={target}
                aria-invalid={!targetFits}
                onChange={(e) => setTarget(e.target.value)}
              />
            </Field>
            <Field
              label={t('cookTime')}
              hint={t('cookTimeHint')}
              optional
              error={cookTimeFits ? undefined : t('between', { min: 0, max: MAX_COOK_TIME_BUDGET })}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_COOK_TIME_BUDGET}
                step={1}
                value={cookTime}
                aria-invalid={!cookTimeFits}
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
          {!fit ? (
            <p>{t('fixFields')}</p>
          ) : shown === undefined ? (
            preview.isError ? (
              <p role="alert">{errorText(preview.error, t('errPreview'))}</p>
            ) : (
              <Skeleton className="h-16" />
            )
          ) : (
            <div className={current ? undefined : 'opacity-60'}>
              <Outcome
                preview={shown}
                skip={kind === 'skip'}
                mealName={mealName}
                weekOff={week?.uneven === true ? week : null}
                spreading={spread && (shown.short?.spread.days ?? 0) > 0}
              />
              {!shown.unchanged && (
                <CookingNote
                  change={shown.cooking}
                  only={only}
                  onOnly={setOnly}
                  label="only"
                  mealName={mealName}
                />
              )}
            </div>
          )}
        </div>
        {fit && shown?.short && shown.short.spread.days > 0 && (
          <div className="space-y-1">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={spread}
                onChange={(e) => setSpread(e.target.checked)}
              />
              <span>
                {t('spreadShort', { kcal: fmt.number(shown.short.kcal) })}
                <span className="block text-xs text-muted-foreground">
                  {t('spreadShortTakes', {
                    days: shown.short.spread.days,
                    kcal: fmt.number(shown.short.spread.takes),
                  })}
                  {shown.short.spread.left > 0 &&
                    ` ${t('spreadShortLeft', { kcal: fmt.number(shown.short.spread.left) })}`}
                </span>
              </span>
            </label>
            <ListNote
              days="several"
              listed={spread && shown.short.spread.listOutOfDate}
              className="pl-6"
            />
          </div>
        )}

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
              onClick={() => save.mutate({ allowRelaxations: inTheWay.needs, even: evenWeek })}
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

        {/* Three buttons do not fit a phone's width in a row: there they stand one under another, saving on top. */}
        <div
          className={cn(
            'flex gap-2',
            evenAlone || twoWays ? 'flex-col-reverse sm:flex-row sm:justify-end' : 'justify-end',
          )}
        >
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          {evenAlone && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => even.mutate()}
            >
              {t('evenWeek')}
            </Button>
          )}
          {twoWays && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                setEvenWeek(true);
                save.mutate({ even: true });
              }}
            >
              {t('saveAndEven')}
            </Button>
          )}
          <Button type="submit" size="sm" disabled={busy || !current || shown?.unchanged !== false}>
            {t(twoWays ? 'saveDay' : 'save')}
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
  weekOff,
  spreading,
}: {
  preview: DaySettingsPreview;
  skip: boolean;
  mealName: (mealType: string) => string;
  /** The week of the day, where it stands off the plan's target as the plan is. */
  weekOff: PlanWeek | null;
  /** The next days take what the day falls short of: the line that they stay as they are is left out. */
  spreading: boolean;
}) {
  const t = useTranslations('mealPlans.daySettings');
  const fmt = useFormat();
  /** A figure before and after, held on one line. */
  const change = (now: number, then: number, digits = 0) =>
    `${fmt.number(now, digits)}\u00a0→\u00a0${fmt.number(then, digits)}`;
  if (preview.unchanged)
    return (
      <>
        <p>{t('unchanged')}</p>
        {weekOff && weekOff.average !== null && (
          <>
            <p className="text-muted-foreground">
              {t('weekAverage', {
                kcal: fmt.number(weekOff.average),
                target: fmt.number(weekOff.target),
              })}
            </p>
            <WeekMore>
              <p>{t('evenWeekNote')}</p>
            </WeekMore>
          </>
        )}
        <ListNote days="several" listed={weekOff?.listOutOfDate === true} />
      </>
    );
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
              ...bandValues(preview.targetMacros.then),
            })}
          </p>
          {preview.belowSafetyFloor && <p className="text-warning">{t('belowFloor')}</p>}
        </>
      )}
      {/* Each meal of the day: its portion and kcal before and after where it takes another portion, what becomes of it otherwise. */}
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('tableMeal')}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              {t('tablePortion')}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t('tableKcal')}
            </th>
          </tr>
        </thead>
        <tbody>
          {preview.meals.map((meal) => (
            <tr key={meal.mealId} className="border-b border-border last:border-0">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">
                {mealName(meal.mealType)}
              </th>
              {meal.portion ? (
                <>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {change(meal.portion.servings.now, meal.portion.servings.then, 2)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {change(meal.portion.calories.now, meal.portion.calories.then)}
                  </td>
                </>
              ) : (
                <td colSpan={2} className="py-1">
                  {t(FATE_WORDS[meal.fate][meal.because ?? 'plain']!)}
                </td>
              )}
            </tr>
          ))}
          {preview.added.map((slot: MealType) => (
            <tr key={slot} className="border-b border-border last:border-0">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">
                {mealName(slot)}
              </th>
              <td colSpan={2} className="py-1">
                {t('fateAdded')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {drawn && <p className="text-muted-foreground">{t('drawnNote')}</p>}
      {preview.dayCalories !== null && !skip && (
        <p className={preview.fits ? 'text-muted-foreground' : 'text-warning'}>
          {preview.short
            ? t('dayShort', {
                kcal: fmt.number(preview.dayCalories),
                short: fmt.number(preview.short.kcal),
              })
            : t(preview.fits ? 'dayCalories' : 'dayCaloriesOff', {
                kcal: fmt.number(preview.dayCalories),
              })}
        </p>
      )}
      {preview.short?.spread.none && (
        <p className="text-muted-foreground">
          {t(NONE_WORDS[preview.short.spread.none], { kcal: fmt.number(preview.short.kcal) })}
        </p>
      )}
      {preview.listOutOfDate && <p className="text-muted-foreground">{t('listOutOfDate')}</p>}
      {preview.week && <WeekOutcome week={preview.week} />}
      {!preview.week?.unevenAlone && !spreading && (
        <p className="text-muted-foreground">{t('otherDays')}</p>
      )}
    </>
  );
}

/**
 * What the change does to the week of the day: its average against the plan's
 * target and the pace that comes to, and what evening the week out would do.
 */
function WeekOutcome({ week }: { week: NonNullable<DaySettingsPreview['week']> }) {
  const t = useTranslations('mealPlans.daySettings');
  const fmt = useFormat();
  const unit = useWeightUnit();
  const { now, alone, evened } = week.average;
  const pace = week.pace.alone;
  const weight = fmt.unit(
    Math.abs(shownWeight(pace, unit)),
    unit === 'lb' ? 'pound' : 'kilogram',
    2,
  );
  return (
    <>
      <p>
        {now === alone
          ? t('weekAverage', { kcal: fmt.number(now), target: fmt.number(week.target) })
          : t('weekAverageChange', {
              from: fmt.number(now),
              to: fmt.number(alone),
              target: fmt.number(week.target),
            })}
      </p>
      <WeekMore>
        <p>
          {Math.abs(pace) < 0.05
            ? t('weekPaceKeep')
            : t(pace > 0 ? 'weekPaceLoss' : 'weekPaceGain', { weight })}
        </p>
        {week.unevenAlone && (
          <p>
            {t('weekEvenNote', {
              dayTarget: fmt.number(week.evenedTarget),
              days: week.otherDays,
              evened: fmt.number(evened),
            })}
          </p>
        )}
      </WeekMore>
      <ListNote days="several" listed={week.unevenAlone && week.listOutOfDate} />
    </>
  );
}

/** The rest of what a change does to its week, under its one line: the pace it comes to and what evening it out does. */
function WeekMore({ children }: { children: ReactNode }) {
  const t = useTranslations('mealPlans.daySettings');
  return (
    <details className="text-muted-foreground">
      <summary className="w-fit cursor-pointer py-1">{t('weekMore')}</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}
