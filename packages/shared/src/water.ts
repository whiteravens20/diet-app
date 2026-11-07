// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { MAX_WATER_ENTRY_ML } from './constants.js';
import { CalendarDay } from './enums.js';

/** How many days the water of a day brings with it, that day the last of them. */
export const WATER_DAYS_SHOWN = 7;

/**
 * Water drunk on a day of the profile's calendar (`POST /water`). An entry
 * only adds: one written by mistake is removed (`DELETE /water/:id`).
 */
export const AddWaterRequest = z.object({
  profileId: z.string().uuid(),
  day: CalendarDay,
  ml: z.number().int().min(1).max(MAX_WATER_ENTRY_ML),
});
export type AddWaterRequest = z.infer<typeof AddWaterRequest>;

/** The day whose water is asked for (`GET /water`). */
export const WaterDayQuery = z.object({ profileId: z.string().uuid(), day: CalendarDay });
export type WaterDayQuery = z.infer<typeof WaterDayQuery>;

/** One entry of water: what "Usuń ostatni wpis" names and removes. */
export const WaterEntry = z.object({
  id: z.string().uuid(),
  ml: z.number().int().min(1),
  /** When it was written. */
  at: z.string().datetime(),
});
export type WaterEntry = z.infer<typeof WaterEntry>;

/**
 * The water of a profile's day: what was drunk in all against the profile's
 * target, the day's last entry, and what each of the days up to it holds.
 */
export const WaterDay = z.object({
  day: CalendarDay,
  /** What the day's entries come to, in millilitres. */
  ml: z.number().int().min(0),
  /** The profile's target a day, in millilitres; null where it names none. */
  target: z.number().int().nullable(),
  /** How many entries the day holds: at most `MAX_WATER_ENTRIES_A_DAY`. */
  entries: z.number().int().min(0),
  /** The entry written last for the day; null for a day that holds none. */
  last: WaterEntry.nullable(),
  /** The `WATER_DAYS_SHOWN` days that end with this one, oldest first, each with what it holds. */
  days: z
    .array(z.object({ day: CalendarDay, ml: z.number().int().min(0) }))
    .length(WATER_DAYS_SHOWN),
});
export type WaterDay = z.infer<typeof WaterDay>;
