-- F19 Phase 1 — weight log + notifications backbone.
--
-- WeightEntry is the raw per-profile weight log surfaced on the dashboard.
-- Nothing is precomputed: the chart, the 7-day moving average and progress
-- against `Profile.weightKg` (the target) are all derived client-side from
-- these rows, so a corrected or deleted entry instantly reflects in the UI.
--
-- Notification is the device-agnostic notification surface: the web client
-- polls /notifications/unread; the future Android app reads the same rows
-- after an FCM-triggered fetch. `type` is the discriminator, `payload`
-- carries type-specific context (e.g. `{ daysSinceLastEntry: 9 }` for a
-- weight reminder) so the client can render a localised string without a
-- second round-trip.
--
-- Profile gains a per-profile cadence + a last-fired timestamp so the
-- worker can scan in one query and skip already-notified rows without a
-- second join.

CREATE TABLE "WeightEntry" (
  "id"          TEXT NOT NULL,
  "profileId"   TEXT NOT NULL,
  "kg"          DOUBLE PRECISION NOT NULL,
  "recordedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WeightEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WeightEntry_profileId_recordedAt_idx"
  ON "WeightEntry" ("profileId", "recordedAt" DESC);

ALTER TABLE "WeightEntry"
  ADD CONSTRAINT "WeightEntry_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "Profile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Notification" (
  "id"         TEXT NOT NULL,
  "profileId"  TEXT NOT NULL,
  "type"       TEXT NOT NULL,
  "payload"    JSONB,
  "readAt"     TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Notification_profileId_readAt_idx"
  ON "Notification" ("profileId", "readAt");

CREATE INDEX "Notification_profileId_createdAt_idx"
  ON "Notification" ("profileId", "createdAt" DESC);

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "Profile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 'off' | 'daily' | 'weekly' — constrained at the API layer via the
-- WeightReminderCadence enum in packages/shared/src/profile.ts. Default
-- weekly so a fresh profile already gets gentle nudges.
ALTER TABLE "Profile"
  ADD COLUMN "weightReminderCadence" TEXT NOT NULL DEFAULT 'weekly',
  ADD COLUMN "lastWeightReminderAt"  TIMESTAMP(3);
