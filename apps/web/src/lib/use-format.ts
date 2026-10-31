// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { useFormatter } from 'next-intl';
import { useMemo } from 'react';

/** The units a number is shown with, as `Intl` names them. */
type Unit = 'gram' | 'kilogram' | 'pound' | 'milliliter' | 'minute' | 'kilobyte' | 'megabyte';

export interface Format {
  /** A calendar day with its weekday and without its year: "Mon, Jan 5", "pon., 5 sty". */
  day(day: string): string;
  /** A calendar day in full: "Jan 5, 2026", "5 sty 2026". */
  date(day: string): string;
  /** A calendar day at its shortest, for an axis: "Jan 5", "5 sty". */
  dayShort(day: string): string;
  /** The month a calendar day lies in, with its year: "January 2026", "styczeń 2026". */
  month(day: string): string;
  /** The weekday of a calendar day: at its shortest ("Mon", "pon.") or in full ("Monday", "poniedziałek"). */
  weekday(day: string, form?: 'short' | 'long'): string;
  /** From one calendar day to another: "Jan 5 – 11, 2026", "5–11 sty 2026". */
  dates(from: string, to: string): string;
  /** A moment, by the reader's clock: "Jan 5, 2026, 2:03 PM", "5 sty 2026, 14:03". */
  moment(iso: string): string;
  /** The day a moment fell on, by the reader's clock: "Jan 5, 2026". */
  dayOf(iso: string): string;
  /** A number with at most `digits` decimals, its thousands not set apart: "2150", "79.5"; "79,5". */
  number(value: number, digits?: number): string;
  /** A number with exactly `digits` decimals: "1.20", "1,20". */
  fixed(value: number, digits: number): string;
  /** A whole number that always says which way it goes: "+120", "-80", "+0", "+2150". */
  signed(value: number): string;
  /** A number with its unit: "79.5 kg", "15 min"; "79,5 kg". */
  unit(value: number, unit: Unit, digits?: number): string;
  /** A share as a percentage: 0.42 is "42%", "42%". */
  percent(share: number): string;
  /** Several things named one after another: "rice, oats and tofu", "ryż, owies i tofu". */
  list(items: readonly string[]): string;
}

/**
 * A calendar day (`2026-03-01`) is the same day wherever it is read: it is
 * made into a moment in UTC and formatted in UTC, so that no time zone moves
 * it to the day before.
 */
const utcDay = (day: string): Date => new Date(`${day.slice(0, 10)}T00:00:00Z`);

/** The time zone the reader lives in: the browser's. The application knows no other. */
export const readersZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Dates, numbers and units as the language of the application writes them.
 * Everything a screen shows of these goes through here: not through the
 * browser's own language, which may be another one, and not as the API
 * spelt it.
 *
 * A moment is shown by the reader's clock. The provider above would give
 * the server's time zone, which is right for nobody who reads this at home.
 * That clock is the browser's: `moment` and `dayOf` are for what is rendered
 * there. A page the server renders can use everything else.
 */
export function useFormat(): Format {
  const format = useFormatter();
  return useMemo(
    () => ({
      day: (day) =>
        format.dateTime(utcDay(day), {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        }),
      date: (day) => format.dateTime(utcDay(day), { dateStyle: 'medium', timeZone: 'UTC' }),
      dayShort: (day) =>
        format.dateTime(utcDay(day), { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      month: (day) =>
        format.dateTime(utcDay(day), { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      weekday: (day, form = 'short') =>
        format.dateTime(utcDay(day), { weekday: form, timeZone: 'UTC' }),
      dates: (from, to) =>
        format.dateTimeRange(utcDay(from), utcDay(to), { dateStyle: 'medium', timeZone: 'UTC' }),
      moment: (iso) =>
        format.dateTime(new Date(iso), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: readersZone(),
        }),
      dayOf: (iso) =>
        format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: readersZone() }),
      number: (value, digits = 0) =>
        format.number(value, { useGrouping: false, maximumFractionDigits: digits }),
      fixed: (value, digits) =>
        format.number(value, {
          useGrouping: false,
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }),
      signed: (value) =>
        format.number(value, {
          useGrouping: false,
          signDisplay: 'always',
          maximumFractionDigits: 0,
        }),
      unit: (value, unit, digits = 0) =>
        format.number(value, {
          useGrouping: false,
          style: 'unit',
          unit,
          unitDisplay: 'short',
          maximumFractionDigits: digits,
        }),
      percent: (share) =>
        format.number(share, { useGrouping: false, style: 'percent', maximumFractionDigits: 0 }),
      list: (items) => format.list([...items], { type: 'conjunction' }),
    }),
    [format],
  );
}
