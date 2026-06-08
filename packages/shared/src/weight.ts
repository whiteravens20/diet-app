import { z } from 'zod';

/**
 * F19 — per-profile weight log + reminder cadence.
 *
 * Raw entries land on the client; the dashboard derives the 90-day trend
 * line, the 7-day moving average and the delta against `Profile.weightKg`
 * (the target weight) from these rows. Nothing is precomputed server-side,
 * so an edit / delete is visible immediately.
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
  /** Optional override; defaults to server-side `now()` when omitted. */
  recordedAt: z.string().datetime().optional(),
});
export type WeightEntryInput = z.infer<typeof WeightEntryInput>;

export const WeightEntry = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  kg: z.number(),
  recordedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type WeightEntry = z.infer<typeof WeightEntry>;
