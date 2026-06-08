import { z } from 'zod';

/**
 * F19 — device-agnostic notification surface.
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

/** Discriminator for `Notification.type`. Extend additively. */
export const NotificationType = z.enum(['weight_reminder']);
export type NotificationType = z.infer<typeof NotificationType>;

/** Payload for `type='weight_reminder'`. */
export const WeightReminderPayload = z.object({
  /** Days since the most recent `WeightEntry.recordedAt` (whole days). */
  daysSinceLastEntry: z.number().int().nonnegative(),
  /** Cadence the reminder fired against — useful for analytics + future UX. */
  cadence: z.enum(['daily', 'weekly']),
});
export type WeightReminderPayload = z.infer<typeof WeightReminderPayload>;

export const Notification = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  type: NotificationType,
  payload: z.unknown().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof Notification>;
