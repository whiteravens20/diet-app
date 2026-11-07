// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { CalendarDay } from './enums.js';

/** What the water card's buttons add, in millilitres: a glass, a can and a bottle. */
export const WATER_AMOUNTS_ML = [250, 330, 500] as const;

/** The water a day that a profile aims at unless it names its own, in millilitres. */
export const DEFAULT_WATER_TARGET_ML = 2000;

/** The bounds of a profile's own target of water a day, in millilitres. */
export const MIN_WATER_TARGET_ML = 250;
export const MAX_WATER_TARGET_ML = 10_000;

/** The most water one entry adds, in millilitres. */
export const MAX_WATER_ENTRY_ML = 5000;

/** The most entries a day of a profile holds. */
export const MAX_WATER_ENTRIES_A_DAY = 50;

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

/** The water of a profile's day: what was drunk in all against the profile's target, and its last entry. */
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
});
export type WaterDay = z.infer<typeof WaterDay>;
