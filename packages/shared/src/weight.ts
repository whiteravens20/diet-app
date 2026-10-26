// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { FIRST_DAY } from './enums.js';

/**
 * Per-profile weight log + reminder cadence.
 *
 * Raw entries land on the client; the dashboard derives the 90-day trend
 * line, the 7-day moving average and the delta against `Profile.weightKg`
 * from these rows. `Profile.weightKg` is the weight the profile registered:
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

export const WeightEntry = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  kg: z.number(),
  recordedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type WeightEntry = z.infer<typeof WeightEntry>;
