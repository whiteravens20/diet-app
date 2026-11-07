// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';
import { CalendarDay } from './enums.js';

/** A glass of water: what "+1 szklanka" adds and "−1" takes back, in millilitres. */
export const GLASS_ML = 250;

/** The water a day that a profile aims at unless it names its own, in millilitres. */
export const DEFAULT_WATER_TARGET_ML = 2000;

/** The bounds of a profile's own target of water a day, in millilitres. */
export const MIN_WATER_TARGET_ML = 250;
export const MAX_WATER_TARGET_ML = 10_000;

/** The most water one entry adds or takes back, in millilitres. */
export const MAX_WATER_ENTRY_ML = 5000;

/** The most entries a day of a profile holds, glasses taken back included. */
export const MAX_WATER_ENTRIES_A_DAY = 50;

/**
 * Water drunk on a day of the profile's calendar (`POST /water`), or a glass
 * taken back: a negative amount, which may not take the day under nothing.
 */
export const AddWaterRequest = z.object({
  profileId: z.string().uuid(),
  day: CalendarDay,
  ml: z
    .number()
    .int()
    .min(-MAX_WATER_ENTRY_ML)
    .max(MAX_WATER_ENTRY_ML)
    .refine((ml) => ml !== 0, 'An entry adds or takes back some water.'),
});
export type AddWaterRequest = z.infer<typeof AddWaterRequest>;

/** The day whose water is asked for (`GET /water`). */
export const WaterDayQuery = z.object({ profileId: z.string().uuid(), day: CalendarDay });
export type WaterDayQuery = z.infer<typeof WaterDayQuery>;

/** The water of a profile's day: what was drunk in all, against the profile's target. */
export const WaterDay = z.object({
  day: CalendarDay,
  /** What the day's entries come to, in millilitres. */
  ml: z.number().int().min(0),
  /** The profile's target a day, in millilitres; null where it names none. */
  target: z.number().int().nullable(),
  /** How many entries the day holds: at most `MAX_WATER_ENTRIES_A_DAY`. */
  entries: z.number().int().min(0),
});
export type WaterDay = z.infer<typeof WaterDay>;
