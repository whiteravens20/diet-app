-- The administrator signs in once and holds a session; the sessions there
-- are belong to an epoch, which ends them all when it moves on.
ALTER TABLE "InstanceSettings" ADD COLUMN "adminSessionEpoch" INTEGER NOT NULL DEFAULT 0;
