// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { MealPlan, PlanRelaxation, RerollPreview } from '@diet-app/shared';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { useSettled } from '@/lib/use-settled';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { type Reroll, type RerollScope } from './reroll';

/** What the window opens on: how much of the plan, which day for one day, and whether every limit is to hold. */
export interface RerollStart {
  scope: RerollScope;
  day?: string;
  holdLimits?: boolean;
}

/** What the window asks for once the user has chosen: a re-roll of this plan. */
export type RerollAsked = Omit<Reroll, 'planId'>;

const selectClass = 'rounded-md border border-input bg-background px-2 py-1 text-sm';

/** The parts of a plan a re-roll leaves as they are, in the order they are named, with the text that names each. */
const KEPT = [
  ['outside', 'keptOutside'],
  ['past', 'keptPast'],
  ['skipped', 'keptSkipped'],
  ['eaten', 'keptEaten'],
  ['custom', 'keptCustom'],
  ['locked', 'keptLocked'],
] as const;

/**
 * The window in which a plan is made again: how much of it, what of it may be
 * replaced that is otherwise left alone, and, before the plan is made again,
 * what would be replaced and what kept, as the API reads the plan.
 */
export function RerollDialog({
  planId,
  title,
  start,
  limitNames,
  onClose,
  onSubmit,
}: {
  planId: string;
  /** The plan as its row in the list names it. */
  title: string;
  start: RerollStart;
  limitNames: (kinds: readonly PlanRelaxation[]) => string;
  onClose: () => void;
  onSubmit: (asked: RerollAsked) => void;
}) {
  const t = useTranslations('mealPlans.reroll');
  const tCommon = useTranslations('common');
  const errorText = useErrorText();
  // The plan as it is now: the window says what a re-roll would do to it, also when the card it was opened from is closed.
  const plan = useQuery({
    queryKey: ['meal-plan', planId],
    queryFn: () => api.get<MealPlan>(`/meal-plans/${planId}`),
  });

  return (
    <Dialog open onClose={onClose} label={t('title')} className="max-w-lg">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{title}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      {plan.data ? (
        <RerollForm
          plan={plan.data}
          start={start}
          limitNames={limitNames}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      ) : plan.isError ? (
        <div className="space-y-3 p-4">
          <p role="alert" className="text-sm">
            {errorText(plan.error, tCommon('error'))}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void plan.refetch()}>
            {tCommon('retry')}
          </Button>
        </div>
      ) : (
        <div className="p-4">
          <Skeleton className="h-40" />
        </div>
      )}
    </Dialog>
  );
}

function RerollForm({
  plan,
  start,
  limitNames,
  onClose,
  onSubmit,
}: {
  plan: MealPlan;
  start: RerollStart;
  limitNames: (kinds: readonly PlanRelaxation[]) => string;
  onClose: () => void;
  onSubmit: (asked: RerollAsked) => void;
}) {
  const t = useTranslations('mealPlans.reroll');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const errorText = useErrorText();
  const id = useId();
  // The user's own day, as the API is told it with the request.
  const today = localDate();
  const days = plan.days;
  const first = days[0]!.date;
  const last = days.at(-1)!.date;

  const [scope, setScope] = useState<RerollScope>(start.scope);
  // Dates in this form sort as text.
  const [from, setFrom] = useState(today > first && today <= last ? today : first);
  const [to, setTo] = useState(last);
  const [day, setDay] = useState(
    start.day ??
      (days.find((d) => !d.skipped && d.date >= today) ?? days.find((d) => !d.skipped) ?? days[0]!)
        .date,
  );
  const [includePast, setIncludePast] = useState(false);
  const [replaceEaten, setReplaceEaten] = useState(false);
  const [replaceCustom, setReplaceCustom] = useState(false);
  const [holdLimits, setHoldLimits] = useState(start.holdLimits ?? false);

  // What the API is asked what a re-roll would do: the days chosen, and what of them may go as well.
  const dayId = days.find((d) => d.date === day)?.id;
  const asked = JSON.stringify({
    path:
      scope === 'day'
        ? `/meal-plans/${plan.id}/days/${dayId}/regenerate/preview`
        : `/meal-plans/${plan.id}/regenerate/preview`,
    body: {
      ...(scope === 'range' ? { from, to } : {}),
      ...(scope === 'from_today' ? { from: today } : {}),
      ...(includePast ? { includePast: true } : {}),
      ...(replaceEaten ? { replaceEaten: true } : {}),
      ...(replaceCustom ? { replaceCustom: true } : {}),
    },
  });
  // Asked once the choice has paused: every tick is a question of its own.
  const settled = useSettled(asked, 300);
  const preview = useQuery({
    queryKey: ['reroll-preview', plan.id, plan.revision, settled],
    queryFn: () => {
      const { path, body } = JSON.parse(settled) as { path: string; body: object };
      return api.post<RerollPreview>(path, body);
    },
    placeholderData: keepPreviousData,
    gcTime: 0,
    retry: false,
  });
  // What is shown is for the choice on the screen only: while a newer question is on its way, the older answer is greyed.
  const shown = preview.data;
  const current = shown !== undefined && !preview.isPlaceholderData && settled === asked;
  const notFromToday = shown?.fromToday;
  // What the days chosen hold that may go as well: a tick is offered, and sent, only where it lets something go.
  const couldGo = shown?.couldGo ?? { past: false, eaten: false, custom: false };
  const mayGiveWay = plan.options.allowRelaxations;
  // What the diary holds for a day that would be filled again is eaten, and the day says so before it is filled.
  const diaryCounts = days.some(
    (d) =>
      d.diary !== null &&
      (d.date >= today || includePast) &&
      (scope === 'day'
        ? d.date === day
        : scope === 'range'
          ? d.date >= from && d.date <= to
          : scope === 'from_today'
            ? d.date >= today
            : true),
  );

  const scopes: { scope: RerollScope; label: string; hint: string; off?: boolean }[] = [
    { scope: 'whole', label: t('whole'), hint: t('wholeHint') },
    {
      scope: 'from_today',
      label: t('fromToday'),
      hint:
        notFromToday === 'not_begun'
          ? t('fromTodayNotBegun')
          : notFromToday === 'over'
            ? t('fromTodayOver')
            : t('partHint'),
      // Not on offer until the API has said whether it is one.
      off: notFromToday !== null,
    },
    ...(days.length > 1
      ? [{ scope: 'range' as const, label: t('range'), hint: t('partHint') }]
      : []),
    { scope: 'day', label: t('day'), hint: t('partHint') },
  ];

  return (
    <form
      className="space-y-4 p-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!current || shown.days === 0) return;
        onSubmit({
          ...(scope === 'day' ? { dayId } : {}),
          ...(scope === 'range' ? { from, to } : {}),
          ...(scope === 'from_today' ? { from: today } : {}),
          ...(couldGo.past && includePast ? { includePast: true } : {}),
          ...(couldGo.eaten && replaceEaten ? { replaceEaten: true } : {}),
          ...(couldGo.custom && replaceCustom ? { replaceCustom: true } : {}),
          ...(holdLimits && mayGiveWay.length > 0 ? { allowRelaxations: [] } : {}),
        });
        onClose();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="font-medium">{t('scope')}</legend>
        {scopes.map((option) => (
          <div key={option.scope} className="space-y-1">
            <label
              className={`flex items-center gap-2 ${option.off ? 'text-muted-foreground' : ''}`}
            >
              <input
                type="radio"
                name={`${id}-scope`}
                className="h-4 w-4"
                checked={scope === option.scope}
                disabled={option.off}
                aria-describedby={`${id}-${option.scope}`}
                onChange={() => setScope(option.scope)}
              />
              {option.label}
            </label>
            <p id={`${id}-${option.scope}`} className="ml-6 text-xs text-muted-foreground">
              {option.hint}
            </p>
            {option.scope === 'range' && scope === 'range' && (
              <p className="ml-6 flex flex-wrap items-center gap-2">
                <select
                  aria-label={t('rangeFrom')}
                  className={selectClass}
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    // The last day is never before the first.
                    if (e.target.value > to) setTo(e.target.value);
                  }}
                >
                  {days.map((d) => (
                    <option key={d.id} value={d.date}>
                      {fmt.day(d.date)}
                    </option>
                  ))}
                </select>
                {t('rangeUntil')}
                <select
                  aria-label={t('rangeTo')}
                  className={selectClass}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                >
                  {days
                    .filter((d) => d.date >= from)
                    .map((d) => (
                      <option key={d.id} value={d.date}>
                        {fmt.day(d.date)}
                      </option>
                    ))}
                </select>
              </p>
            )}
            {option.scope === 'day' && scope === 'day' && (
              <p className="ml-6">
                <select
                  aria-label={t('dayWhich')}
                  className={selectClass}
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                >
                  {days.map((d) => (
                    <option key={d.id} value={d.date} disabled={d.skipped}>
                      {d.skipped ? t('daySkipped', { day: fmt.day(d.date) }) : fmt.day(d.date)}
                    </option>
                  ))}
                </select>
              </p>
            )}
          </div>
        ))}
      </fieldset>

      {(couldGo.past || couldGo.eaten || couldGo.custom) && (
        <fieldset className="space-y-1">
          <legend className="font-medium">{t('also')}</legend>
          {couldGo.past && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={includePast}
                onChange={(e) => setIncludePast(e.target.checked)}
              />
              {t('includePast')}
            </label>
          )}
          {couldGo.eaten && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={replaceEaten}
                onChange={(e) => setReplaceEaten(e.target.checked)}
              />
              {t('replaceEaten')}
            </label>
          )}
          {couldGo.custom && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={replaceCustom}
                onChange={(e) => setReplaceCustom(e.target.checked)}
              />
              {t('replaceCustom')}
            </label>
          )}
        </fieldset>
      )}
      {mayGiveWay.length > 0 && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0"
            checked={holdLimits}
            onChange={(e) => setHoldLimits(e.target.checked)}
          />
          <span>{t('holdLimits', { limits: limitNames(mayGiveWay) })}</span>
        </label>
      )}

      {/* Said before the plan is made again, and again whenever the choice changes: the API works it out, this says it. */}
      <div
        aria-live="polite"
        className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs"
      >
        {preview.isError && (
          <div className="space-y-2">
            <p role="alert">{errorText(preview.error, t('errPreview'))}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void preview.refetch()}
            >
              {tCommon('retry')}
            </Button>
          </div>
        )}
        {shown === undefined ? (
          !preview.isError && <Skeleton className="h-16" />
        ) : (
          <div className={current ? 'space-y-1' : 'space-y-1 opacity-60'}>
            {shown.days === 0 ? (
              <p className="text-warning">
                {t(shown.kept.past > 0 ? 'nothingPast' : 'nothingKept')}
              </p>
            ) : (
              <p className="font-medium">
                {t('replaced', { meals: shown.replaced, days: shown.days })}
              </p>
            )}
            {KEPT.some(([part]) => shown.kept[part] > 0) ? (
              <>
                <p>{t('kept')}</p>
                <ul className="list-disc pl-5">
                  {KEPT.filter(([part]) => shown.kept[part] > 0).map(([part, text]) => (
                    <li key={part}>{t(text, { count: shown.kept[part] })}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t('keptNothing')}</p>
            )}
            {diaryCounts && <p>{t('diaryCounts')}</p>}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!current || shown.days === 0}>
          {t('confirm')}
        </Button>
      </div>
    </form>
  );
}
