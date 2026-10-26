// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Check, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { dayAfter, type PlanCalendar as Calendar, type PlanCalendarDay } from '@diet-app/shared';
import { api } from '@/lib/api';
import { monthAfter, monthOf, weeksOf } from '@/lib/plan-dates';
import { useFormat } from '@/lib/use-format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { LoadFailed } from '@/components/load-failed';

/** How far each key moves among the days, in days. */
const STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/**
 * The plans of a profile as a calendar: a month at a time, Monday first.
 * A day that a plan holds says what it holds, and choosing it opens its
 * plan; a day that none holds is where a new plan can begin. The month is one
 * request, whatever it holds.
 *
 * The days are a grid: one of them is in the order of the Tab key, and the
 * arrow keys move among them, into the next month and the one before.
 */
export function PlanCalendar({
  profileId,
  today,
  onOpen,
  onStart,
}: {
  profileId: string;
  /** The day it is for the reader. */
  today: string;
  /** A day that a plan holds was chosen. */
  onOpen: (planId: string, date: string) => void;
  /** A day that no plan holds was chosen. */
  onStart: (date: string) => void;
}) {
  const t = useTranslations('mealPlans.calendar');
  const fmt = useFormat();
  const title = useId();
  const [month, setMonth] = useState(() => monthOf(today));
  const weeks = useMemo(() => weeksOf(month), [month]);
  const from = weeks[0]![0]!;
  const to = weeks.at(-1)![6]!;

  const calendar = useQuery({
    // Among the plans of the profile, so that whatever changes a plan has the calendar read again.
    queryKey: ['meal-plans', profileId, 'calendar', from, to],
    queryFn: () =>
      api.get<Calendar>(`/meal-plans/calendar?${new URLSearchParams({ profileId, from, to })}`),
    // The month before stays while the next is on its way: its days are other days, drawn where these will be.
    placeholderData: keepPreviousData,
  });
  const held = new Map((calendar.data?.days ?? []).map((day) => [day.date, day]));

  // The day the arrow keys are at. It is the one day of the grid in the order of the Tab key.
  const [at, setAt] = useState(today);
  const shown = from <= at && at <= to;
  const tabStop = shown ? at : monthOf(today) === month ? today : month;
  const cells = useRef(new Map<string, HTMLButtonElement>());
  // Set when a key moved the day: the focus follows it, into another month when it left this one.
  const follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    cells.current.get(at)?.focus();
  }, [at, month]);

  const leaf = (months: number): void => setMonth(monthAfter(month, months));
  const moveTo = (date: string): void => {
    follow.current = true;
    setAt(date);
    if (date < from || date > to) setMonth(monthOf(date));
  };
  const onKey = (date: string, weekday: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      STEPS[event.key] ??
      (event.key === 'Home'
        ? -weekday
        : event.key === 'End'
          ? 6 - weekday
          : event.key === 'PageUp'
            ? 'before'
            : event.key === 'PageDown'
              ? 'after'
              : null);
    if (step === null) return;
    event.preventDefault();
    if (typeof step === 'number') return moveTo(dayAfter(date, step));
    // A month back or on, to the same day of it, or to its last day where it is shorter.
    const first = monthAfter(date, step === 'before' ? -1 : 1);
    const last = dayAfter(monthAfter(first, 1), -1);
    const same = `${first.slice(0, 8)}${date.slice(8)}`;
    moveTo(same > last ? last : same);
  };

  /** What a day says to somebody who does not see its cell. */
  const spoken = (date: string, day: PlanCalendarDay | undefined): string => {
    const name = fmt.day(date);
    if (!day) return t('dayFree', { day: name });
    if (day.skipped) return t('daySkipped', { day: name, more: day.plans - 1 });
    return t('dayPlanned', {
      day: name,
      calories: day.calories,
      target: day.target,
      standing: day.offTarget ?? 'on',
      eaten: day.eaten.meals,
      of: day.eaten.of,
      more: day.plans - 1,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={title} aria-live="polite" className="text-base font-semibold tracking-tight">
          {fmt.month(month)}
        </h4>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('previous')}
            onClick={() => leaf(-1)}
          >
            <ChevronLeft size={16} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={monthOf(today) === month}
            onClick={() => setMonth(monthOf(today))}
          >
            {t('thisMonth')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('next')}
            onClick={() => leaf(1)}
          >
            <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
      </div>

      {calendar.isError ? (
        <LoadFailed error={calendar.error} onRetry={() => void calendar.refetch()} />
      ) : (
        <table
          role="grid"
          aria-labelledby={title}
          aria-busy={calendar.isFetching}
          className="w-full table-fixed border-separate border-spacing-1"
        >
          <thead>
            <tr>
              {weeks[0]!.map((date) => (
                <th
                  key={date}
                  scope="col"
                  className="pb-1 text-center text-xs font-medium text-muted-foreground"
                >
                  <abbr title={fmt.weekday(date, 'long')} className="no-underline">
                    {fmt.weekday(date)}
                  </abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]}>
                {week.map((date, weekday) => {
                  const day = held.get(date);
                  return (
                    <td key={date} className="p-0">
                      <button
                        type="button"
                        ref={(cell) => {
                          if (cell) cells.current.set(date, cell);
                          else cells.current.delete(date);
                        }}
                        tabIndex={date === tabStop ? 0 : -1}
                        aria-label={spoken(date, day)}
                        aria-current={date === today ? 'date' : undefined}
                        onClick={() => {
                          setAt(date);
                          if (day) onOpen(day.planId, date);
                          else onStart(date);
                        }}
                        onKeyDown={onKey(date, weekday)}
                        className={cn(
                          'flex h-16 w-full flex-col items-start gap-0.5 rounded-md border p-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          day
                            ? 'border-primary/40 bg-primary/5 hover:bg-primary/10'
                            : 'border-border/60 hover:bg-muted',
                          // A day of the month before or after is told apart by its frame and a quieter colour that can still be read: a faded day could not.
                          monthOf(date) !== month && 'border-dashed text-muted-foreground',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-medium tabular-nums',
                            date === today && 'bg-primary text-primary-foreground',
                          )}
                        >
                          {Number(date.slice(8))}
                        </span>
                        {day?.skipped && (
                          <span className="text-muted-foreground">{t('skipped')}</span>
                        )}
                        {day && !day.skipped && (
                          <span
                            className={cn(
                              'flex items-center gap-0.5 tabular-nums',
                              day.offTarget && 'font-medium text-warning',
                            )}
                          >
                            {day.offTarget && <TriangleAlert size={10} aria-hidden />}
                            {fmt.number(day.calories)}
                          </span>
                        )}
                        {day && (day.eaten.meals > 0 || day.plans > 1) && (
                          <span className="flex items-center gap-1 text-muted-foreground tabular-nums">
                            {day.eaten.meals > 0 && (
                              <span className="flex items-center gap-0.5">
                                <Check size={10} aria-hidden />
                                {day.eaten.meals}/{day.eaten.of}
                              </span>
                            )}
                            {day.plans > 1 && <span>+{day.plans - 1}</span>}
                          </span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* What the marks in a day mean is said in words: a mark alone says it to nobody who does not already know. */}
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        <li>{t('legendDay')}</li>
        <li className="flex items-center gap-1">
          <TriangleAlert size={10} aria-hidden className="shrink-0 text-warning" />
          {t('legendOff')}
        </li>
        <li className="flex items-center gap-1">
          <Check size={10} aria-hidden className="shrink-0" />
          {t('legendEaten')}
        </li>
        <li>{t('legendMore')}</li>
        <li>{t('legendKeys')}</li>
      </ul>
    </div>
  );
}
