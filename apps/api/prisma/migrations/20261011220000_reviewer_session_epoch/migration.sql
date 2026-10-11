-- A reviewer's session belongs to an epoch of the reviewer settings, so that
-- a changed password and a closed panel end the sessions there are.
ALTER TABLE "InstanceSettings" ADD COLUMN "reviewerSessionEpoch" INTEGER NOT NULL DEFAULT 0;

-- The reviewer password is hashed with the application's key from here on,
-- as the passwords of accounts are, and has to be twelve characters long. A
-- hash from before was made without the key and would match nothing: it is
-- cleared, which closes the reviewers' door until the operator sets a
-- password again, and the sessions of before end with it.
UPDATE "InstanceSettings"
SET "reviewerPasswordHash" = NULL, "reviewerSessionEpoch" = 1
WHERE "reviewerPasswordHash" IS NOT NULL;
