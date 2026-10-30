// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { FIRST_DAY } from './constants.js';

/**
 * Per-profile weight log + reminder cadence.
 *
 * The entries are listed as they were logged, and by day as a chart draws
 * them (`WeightDay`): each day's weight and the mean of the seven days that
 * end with it, worked out by the API for the client's time zone. The delta
 * against `Profile.weightKg` is the client's to show. `Profile.weightKg` is the weight the profile registered:
 * the calorie calculation takes it as the current body weight, and it is not
 * a target. Nothing is precomputed server-side, so an edit / delete is
 * visible immediately.
 */

/**
 * How often the worker should nudge the user to log a weight. `off` skips
 * the profile entirely; `daily` and `weekly` are measured from the most
 * recent entry's `recordedAt` (not from the last reminder), so a user who
 * caught up by logging twice in a day doesn't get pestered.
 */
export const WeightReminderCadence = z.enum(['off', 'daily', 'weekly']);
export type WeightReminderCadence = z.infer<typeof WeightReminderCadence>;

/** Bounds match `ProfileInput.weightKg` so a log entry can be the same value. */
export const WeightEntryInput = z.object({
  kg: z.number().min(30).max(400),
  /**
   * When the weight was taken; the moment it is logged when left out. Not a
   * moment still to come: the newest entry is what reminders count from, and
   * one dated ahead would keep them quiet until then. A day's grace is given
   * for a clock that runs ahead.
   */
  recordedAt: z
    .string()
    .datetime()
    .refine((moment) => Date.parse(moment) >= Date.parse(`${FIRST_DAY}T00:00:00Z`), {
      message: `Must not be before ${FIRST_DAY}.`,
    })
    .refine((moment) => Date.parse(moment) <= Date.now() + 86_400_000, {
      message: 'Must not be a moment still to come.',
    })
    .optional(),
});
export type WeightEntryInput = z.infer<typeof WeightEntryInput>;

/** A weight logged for a profile. */
export const CreateWeightEntryRequest = WeightEntryInput.extend({ profileId: z.string().uuid() });
export type CreateWeightEntryRequest = z.infer<typeof CreateWeightEntryRequest>;

/** The most weights one answer holds: the newest. Logged once a day, that is close to three years. */
export const MAX_WEIGHTS_LISTED = 1000;

/** The weights of a profile, the newest first: the newest of all, or of the ones recorded since a moment. */
export const WeightListQuery = z.object({
  profileId: z.string().uuid(),
  since: z.string().datetime().optional(),
});
export type WeightListQuery = z.infer<typeof WeightListQuery>;

/** Whether this runtime knows `zone` as a time zone, as IANA names one. */
function isTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The weights of a profile by day, each day as it is where the client is:
 * `timeZone` names the zone as IANA does (`Europe/Warsaw`). `since` leaves out
 * the days before the one it falls on there; the means of the first days
 * count the six days before them all the same.
 */
export const WeightDaysQuery = z.object({
  profileId: z.string().uuid(),
  since: z.string().datetime().optional(),
  timeZone: z.string().max(64).refine(isTimeZone, {
    message: 'Must be a time zone as IANA names it, such as Europe/Warsaw.',
  }),
});
export type WeightDaysQuery = z.infer<typeof WeightDaysQuery>;

/** A day of a profile's weights, as a chart draws it. */
export const WeightDay = z.object({
  /** The day, where the client is: `2026-03-01`. */
  date: z.string().date(),
  /** What was logged that day, its last entry where there are several: kilograms, to the hundredth. */
  kg: z.number(),
  /**
   * The mean of the seven days of the calendar that end with this one, each
   * day that has a weight by its last entry: kilograms, to the hundredth. Not
   * of the last seven entries: somebody who steps on the scales once a week
   * has a mean of one entry, not of seven weeks.
   */
  mean: z.number(),
});
export type WeightDay = z.infer<typeof WeightDay>;

export const WeightEntry = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  kg: z.number(),
  recordedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type WeightEntry = z.infer<typeof WeightEntry>;
