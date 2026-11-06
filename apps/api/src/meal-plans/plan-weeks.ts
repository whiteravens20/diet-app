// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The weeks of a plan: its days in sevens from its first. The kinds of day
 * move calories between the days of a week and leave their average on the
 * plan's target (`weekScale` in the engine); here is what a week of a plan as
 * it stands comes to, and what evening it out would give its days.
 */
import type { PlanWeek } from '@diet-app/shared';
import { DAY_KIND_FACTOR, sharesTheWeek, weekOfDay, type WeekDay } from '../engine/nutrition.js';
import { parseDayOverrides } from './plan-days.js';

/** A day of a plan as its week reads it. */
export interface WeekPlanDay {
  id: string;
  /** The day, `2026-11-06`. */
  date: string;
  calorieTarget: number;
  overrides: unknown;
  /** Every meal planned for it is eaten: its portions can no longer follow another target. */
  eaten: boolean;
}

/** How far a week's average may lie from the plan's target before it is said: a hundredth of it, and never less than 10 kcal, the step a day's target is rounded to. */
export const weekSlack = (target: number): number => Math.max(10, target / 100);

/** What a day is to its week's sharing: its kind, its own target, and whether it is skipped. */
export function asWeekDay(day: { overrides: unknown }): WeekDay {
  const overrides = parseDayOverrides(day.overrides);
  return {
    dayType: overrides?.dayType,
    ownTarget: overrides?.calorieTarget ?? null,
    skip: overrides?.skip === true,
  };
}

/** The days of a plan, its weeks: the days of each in order. */
export function weeksOfPlan<T>(days: readonly T[]): T[][] {
  const weeks: T[][] = [];
  days.forEach((day, index) => (weeks[weekOfDay(index)] ??= []).push(day));
  return weeks;
}

/** What the days of a week that share it aim at on average; null where none does. */
export function weekAverage(
  days: readonly { calorieTarget: number; overrides: unknown }[],
): number | null {
  const sharing = days.filter((day) => sharesTheWeek(asWeekDay(day)));
  if (sharing.length === 0) return null;
  return sharing.reduce((sum, day) => sum + day.calorieTarget, 0) / sharing.length;
}

/** A day of the week that evening it out can give another target: one from today on that shares the week and has a meal left to eat. */
export const canTakeAnother = (day: WeekPlanDay, today: string): boolean =>
  day.date >= today && !day.eaten && sharesTheWeek(asWeekDay(day));

/**
 * The scale that evens a week out (`weekScale`): what a usual day of the days
 * that can take another target is to be against the plan's target, so that
 * with the days that keep theirs the week's average comes to the target. It
 * moves a usual day by at most 15 % either way, as far as a kind of day moves
 * one; a week that needs more comes as near as that allows. Null where no day
 * can take another target.
 */
export function evenedScale(
  days: readonly WeekPlanDay[],
  target: number,
  today: string,
): number | null {
  const sharing = days.filter((day) => sharesTheWeek(asWeekDay(day)));
  const moving = sharing.filter((day) => canTakeAnother(day, today));
  if (moving.length === 0) return null;
  const kept = sharing
    .filter((day) => !canTakeAnother(day, today))
    .reduce((sum, day) => sum + day.calorieTarget, 0);
  const kinds = moving.reduce(
    (sum, day) => sum + DAY_KIND_FACTOR[asWeekDay(day).dayType ?? 'normal'],
    0,
  );
  const scale = (sharing.length * target - kept) / (target * kinds);
  return Math.min(1.15, Math.max(0.85, scale));
}

/**
 * The weeks of a plan as its view shows them: each one's first and last day,
 * what the days that share it aim at on average, and whether that lies off
 * the plan's target while days from today on could still bring it back.
 */
export function planWeeks(days: readonly WeekPlanDay[], target: number, today: string): PlanWeek[] {
  return weeksOfPlan(days).map((week) => {
    const average = weekAverage(week);
    return {
      from: week[0]!.date,
      to: week[week.length - 1]!.date,
      target,
      average: average === null ? null : Math.round(average),
      uneven:
        average !== null &&
        Math.abs(average - target) > weekSlack(target) &&
        week.some((day) => canTakeAnother(day, today)),
    };
  });
}
