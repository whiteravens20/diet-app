import { z } from 'zod';
import { MealType } from './enums.js';

/**
 * Slot map for a favorite set — one recipe id per meal slot. Sparse on purpose
 * (a "lunch + dinner" set is valid; the apply action only rewrites the slots
 * that are present, leaving other meal types on the target day untouched).
 */
export const FavoriteSetSlots = z.partialRecord(MealType, z.string().uuid());
export type FavoriteSetSlots = z.infer<typeof FavoriteSetSlots>;

export const FavoriteSet = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  label: z.string().min(1).max(80),
  slots: FavoriteSetSlots,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FavoriteSet = z.infer<typeof FavoriteSet>;

export const CreateFavoriteSetRequest = z.object({
  profileId: z.string().uuid(),
  label: z.string().min(1).max(80),
  slots: FavoriteSetSlots.refine((s) => Object.keys(s).length > 0, {
    message: 'at least one slot is required',
  }),
});
export type CreateFavoriteSetRequest = z.infer<typeof CreateFavoriteSetRequest>;

export const UpdateFavoriteSetRequest = z.object({
  label: z.string().min(1).max(80).optional(),
  slots: FavoriteSetSlots.refine((s) => Object.keys(s).length > 0, {
    message: 'at least one slot is required',
  }).optional(),
});
export type UpdateFavoriteSetRequest = z.infer<typeof UpdateFavoriteSetRequest>;

/**
 * Apply a favorite set to one or more days of a plan. For each `dayDate`, every
 * meal slot present in `set.slots` is replaced with the set's recipe id; slots
 * the set doesn't define are left as-is. Servings are rescaled per slot to the
 * day's calorie budget (same `fitServings` logic the generator and swap path
 * use) so an applied set respects the plan's targets rather than dumping a flat
 * serving; the caller can still edit servings via the meal-plan endpoints.
 */
export const ApplyFavoriteSetRequest = z.object({
  planId: z.string().uuid(),
  dayDates: z.array(z.string().date()).min(1),
});
export type ApplyFavoriteSetRequest = z.infer<typeof ApplyFavoriteSetRequest>;
