// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { CalendarDay, MealType } from './enums.js';

/**
 * Device-agnostic notification surface.
 *
 * The web client polls `GET /notifications/unread` and renders a toast +
 * bell-icon counter. The future Android app (separate repo) reads the same
 * rows on an FCM-triggered fetch. The *contract* is the row shape, not a
 * web-specific push surface.
 *
 * `payload` is type-discriminated and intentionally loose at the schema
 * boundary: the client picks the right i18n key based on `type` and feeds
 * `payload` in as ICU args (e.g. `{ daysSinceLastEntry: 9 }`). Adding a
 * new notification type is one enum entry + one messages key per locale —
 * no DB migration.
 */

/** The most unread notifications one answer holds: the newest. */
export const MAX_UNREAD_LISTED = 50;

/** Discriminator for `Notification.type`. Extend additively. */
export const NotificationType = z.enum([
  'weight_reminder',
  'preferences_review',
  'product_accepted',
  'product_rejected',
  'product_replaced',
  'product_withdrawn',
  'cooking_reminder',
]);
export type NotificationType = z.infer<typeof NotificationType>;

/**
 * Payload for `type='preferences_review'`: an update of the catalogue found
 * that the profile's preferences or favourite sets referred to ingredients or
 * recipes that no longer exist, and removed those references.
 */
export const PreferencesReviewPayload = z.object({
  ingredients: z.number().int().min(0),
  recipes: z.number().int().min(0),
});
export type PreferencesReviewPayload = z.infer<typeof PreferencesReviewPayload>;

/**
 * Payload of what an author is told of a product: its name, and the reason where
 * a person gave one. Replaced means that the base has its code from elsewhere:
 * `replaced` names where, Open Food Facts or an accepted product.
 */
export const ProductNoticePayload = z.object({
  name: z.string(),
  reason: z.string().nullable(),
  replacedBy: z.enum(['open_food_facts', 'instance']).nullable(),
});
export type ProductNoticePayload = z.infer<typeof ProductNoticePayload>;

/** Payload for `type='weight_reminder'`. */
export const WeightReminderPayload = z.object({
  /** Days since the most recent `WeightEntry.recordedAt` (whole days). */
  daysSinceLastEntry: z.number().int().nonnegative(),
  /** Cadence the reminder fired against — useful for analytics + future UX. */
  cadence: z.enum(['daily', 'weekly']),
});
export type WeightReminderPayload = z.infer<typeof WeightReminderPayload>;

/** A dish cooked once tomorrow for later as well: its meal, its title, and what else it covers. */
export const CookedAhead = z.object({
  planId: z.string().uuid(),
  plannedMealId: z.string().uuid(),
  /** The recipe's title in the account's language when the reminder was made. */
  dish: z.string(),
  /** What else it covers: the day after, or another meal of the same day. */
  alsoDate: CalendarDay,
  alsoMealType: MealType,
});
export type CookedAhead = z.infer<typeof CookedAhead>;

/** Payload for `type='cooking_reminder'`: the dishes cooked ahead on `date`, one reminder a day. */
export const CookingReminderPayload = z.object({
  date: CalendarDay,
  dishes: z.array(CookedAhead).min(1),
});
export type CookingReminderPayload = z.infer<typeof CookingReminderPayload>;

export const Notification = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  type: NotificationType,
  payload: z.unknown().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof Notification>;
